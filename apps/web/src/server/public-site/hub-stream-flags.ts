import "server-only";
// server/public-site/hub-stream-flags.ts - which matches of a competition's hub carry the camera icon (Seazn-hosted video, Phase 4 Task 47;
// owner 2026-11-24, option A): `live` (a stream is on air for the match now) or `replay` (there is a video to watch back), or nothing.
//
// TWO PARTS, so the rule can be swept without a database:
//   hubStreamOf(facts)          PURE. The rule, in terms of the same helpers the public MATCH PAGE decides with: `streamLinkLabelKey` (the
//                                void rule, "Watch live" vs "Replay"), `replayPlan` (which YouTube parts the player lists and whether the
//                                club's own link still shows) and the Seazn player's own arms (`seaznVideoPlan`: a fixture with a Seazn
//                                session or a replay row the organiser has not removed is the island's; `replayParts`: what the island lists).
//                                A camera must never show where the page shows no player and no button, so the replay half of this
//                                function IS the page's rule; `hub-stream-flags-db.test.ts` holds the two to each other, status by status.
//   readHubStreamFlags(...)     the facts for MANY matches, read once per hub rebuild (never per division, never per poll): two statements
//                                whatever the number of matches (one for the facts, a second only when some match has Seazn video).
//
// Precedence: LIVE BEATS REPLAY. LIVE is (a) the fixture's LATEST session in state `live` on the SEAZN destination (the match page's island
// plays it), or (b) the match in play with the club's own link on its page (the "Watch live" pill). Controller ruling 2026-11-24 (owner
// value: "camera means the viewer can watch"): a YouTube or pasted-key live with no club link has NO camera, because the page has no
// player and no button for it; with the club's link saved and the match in play, clause (b) gives it the camera.
//
// Privacy: `public_fixtures_v` is the gate (a private competition has no row) with the division past setup (the match page's own redaction, as
// `seaznFixtureVideo` applies it), so neither gets a camera; and
// `public_fixture_youtube_parts_v` and `public_fixture_seazn_replays_v` are the page's own redacting views. The answer is an enum: no address,
// uid or token ever leaves this module. The privileged `sql` client (fixture_stream_* are FORCE RLS with no policy, V410, and the views are
// not granted to app_user), the stream pattern.
import { sql } from "@/lib/db";
import { youtubeWatchUrl, type PublicReplayPart } from "@/lib/youtube";
import { log } from "@/server/logger";
import { replayParts } from "@/server/video/domain/replay-parts";
import { readPublicReplayEntriesMany } from "@/server/video/replay-entries";
import { replayPlan } from "@/app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/replay-plan";
import { streamLinkLabelKey } from "@/app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/stream-link";

export type HubStream = "live" | "replay";

/** What the rule reads of one match. */
export interface HubStreamFacts {
  /** The fixture's status (the page's own void / replayable vocabulary). */
  status: string;
  /** The club's own link (`fixtures.stream_url`), null when none; read only through `replayPlan`, never returned. */
  streamUrl: string | null;
  /** The fixture's LATEST session (by creation) is in state `live` AND its destination is Seazn (the island plays it). */
  seaznLive: boolean;
  /** The match page mounts the Seazn island (`seaznVideoPlan`'s first arm): a Seazn session, or a replay row not removed. */
  seaznPlayer: boolean;
  /** How many parts the island would list (`replayParts` over the public entries). */
  seaznParts: number;
  /** The fixture's public YouTube parts (the view's own rows). */
  youtubeParts: readonly PublicReplayPart[];
}

/** The rule. LIVE: the latest session is live, or the match is in play with the club's link showing. REPLAY: the page has something to
 *  watch back: the island's parts when the island is mounted (whatever the status: the island lists them), else the YouTube parts the
 *  plan lists; and, for a match that is over, the club's own link when it still shows. A match not yet started with a link saved
 *  has no camera: the page's "Watch live" button is there, but nothing is on. */
export function hubStreamOf(f: HubStreamFacts): HubStream | undefined {
  if (f.seaznLive) return "live";
  const plan = replayPlan({ status: f.status, streamUrl: f.streamUrl, parts: f.youtubeParts });
  const label = streamLinkLabelKey(f.status);
  if (f.status === "in_play" && label === "overlay.watchLive" && plan.showOwnLink) return "live";
  const hasParts = f.seaznPlayer ? f.seaznParts > 0 : plan.parts.length > 0;
  if (hasParts) return "replay";
  if (label === "overlay.replay" && plan.showOwnLink) return "replay";
  return undefined;
}

interface FactsRow {
  id: string;
  stream_url: string | null;
  seazn_live: boolean;
  has_seazn_session: boolean;
  has_seazn_replay: boolean;
  yt_videos: string[] | null;
}

/** The matches among `fixtures` that carry a camera, keyed by fixture id. Absent from the map: no camera. */
export async function readHubStreamFlags(
  fixtures: readonly { id: string; status: string }[],
  now: Date,
): Promise<Map<string, HubStream>> {
  const out = new Map<string, HubStream>();
  if (fixtures.length === 0) return out;
  const statusOf = new Map(fixtures.map((f) => [f.id, f.status] as const));
  const ids = [...statusOf.keys()];
  // The page's own redaction first: a fixture the public may not see (a private competition, a division in setup) has no row here, so it
  // can never get a camera, whatever its sessions or recordings say.
  const rows = await sql<FactsRow[]>`
    select v.id, v.stream_url,
           coalesce((select s.state = 'live' and s.destination_kind = 'seazn' from fixture_stream_sessions s where s.fixture_id = v.id order by s.created_at desc, s.id desc limit 1), false) as seazn_live,
           exists (select 1 from fixture_stream_sessions s where s.fixture_id = v.id and s.destination_kind = 'seazn') as has_seazn_session,
           exists (select 1 from fixture_video_replays r where r.fixture_id = v.id and r.state <> 'deleted' and r.deleted_at is null) as has_seazn_replay,
           array(select p.video_id from public_fixture_youtube_parts_v p where p.fixture_id = v.id order by p.part_no) as yt_videos
      from public_fixtures_v v
      join divisions d on d.id = v.division_id
     where v.id in ${sql(ids)} and d.status <> 'setup'`;
  const seazn = rows.filter((r) => r.has_seazn_session || r.has_seazn_replay).map((r) => r.id);
  const entries = await readPublicReplayEntriesMany(sql, seazn);
  for (const r of rows) {
    const status = statusOf.get(r.id);
    if (status === undefined) continue;
    const seaznPlayer = r.has_seazn_session || r.has_seazn_replay;
    let seaznParts = 0;
    if (seaznPlayer) {
      try {
        seaznParts = replayParts(entries.get(r.id) ?? [], now).length;
      } catch (err) {
        // A row state this build does not know, or a recording neither side holds: named in the log by the fixture, never guessed.
        log.warn({ fixtureId: r.id, err: err instanceof Error ? err.name : typeof err }, "hub stream flags: the replay parts could not be read; this match has no replay camera");
      }
    }
    const stream = hubStreamOf({
      status,
      streamUrl: r.stream_url,
      seaznLive: r.seazn_live,
      seaznPlayer,
      seaznParts,
      youtubeParts: (r.yt_videos ?? []).map((id, i) => ({ partNo: i + 1, url: youtubeWatchUrl(id), madeForKids: null })),
    });
    if (stream !== undefined) out.set(r.id, stream);
  }
  return out;
}
