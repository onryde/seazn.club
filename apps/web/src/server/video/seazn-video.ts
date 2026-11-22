import "server-only";
// server/video/seazn-video.ts — a fixture's Seazn-hosted video, as the player reads it (Seazn-hosted video, Phase 1 Task 14; spec G5,
// §5.1; recommendation 2026-11-21 G-B). One answer shape, `PublicFixtureVideo` (api-v1/schemas/public.ts), two reads:
//   seaznFixtureVideo(fixtureId, now)               the PUBLIC read (GET /api/v1/public/fixtures/{id}/video; the match page's
//                                                    island, Task 15). The fixture must be one the public may see: in
//                                                    public_fixtures_v, its division past setup — the redaction replayParts
//                                                    relies on (youtube/parts.ts, public_fixture_youtube_parts_v). Any other
//                                                    fixture answers the empty video, the same as one with no video at all,
//                                                    so a private fixture's id is not an oracle.
//   seaznFixtureVideoForOrg(orgId, fixtureId, now)  the ORGANISER's read (Match Day, the fixture panel: Task 17). Org-scoped on
//                                                    the fixture and every session, private competitions included (spec G5).
//
// `live`: the fixture's LATEST session (by creation), when it is a Seazn session in state `live` — its programme input's signed
// HLS (`signLivePlayback`). Warming, ending, ended, or an external destination: no live.
// `replay` (G-B, the interim until Task 25's Bunny embed): every recording in `seazn_locked_videos` under the programme input of
// one of the fixture's ENDED Seazn sessions, each its signed HLS (`signRecordingPlayback`).
//   ORDER and NUMBER: recording order. The session's (created_at, id), then, within one session, when the recording began
//     (recorded_at, V542: the lock pass stores the listing's creation; null, when that was not a date, sorts last), then the lock
//     (locked_at, cf_video_id). `partNo` is the recording's 1-based place
//     among ALL the fixture's locked recordings in that order, given before anything is left out, so a part keeps its number
//     from one poll to the next; a part that is left out leaves a gap. Task 25 must number its parts the same way.
//   LEFT OUT: a recording whose session began DELETE_RECORDING_AFTER_DAYS or more before `now` (Cloudflare deletes a recording
//     that long after it is ready, which is never before its session began, so this never lists a deleted one), and a part
//     whose token cannot be minted right now (logged by uid, never a token). One part never fails the answer or the live.
// A LIVE whose token cannot be minted (Phase 1 review I1) is settled the same way: `live: null`, the parts still answer, and one
// line names the session and the error's class. It used to fail the whole answer, so a Cloudflare outage was a 500 on every
// viewer's poll (and a Sentry event each, v1's unhandled-error path). A failed mint is remembered for a window (cf-playback.ts),
// and a refusal from inside that window (`PlaybackTokenRecentlyFailed`) is not logged again: one line per mint, not per viewer.
// Only a `seazn_locked_videos` uid is ever signed: Task 13 wrote that row after checking the recording names this input itself
// (C6) and making it need a token (C3), so an unsigned recording, a uid from a listing and a uid from the request never reach
// a viewer. A session still live has no part yet: its live plays.
//
// The flags are not read (controller ruling 2026-11-20): SEAZN_HOSTED_LIVE gates new Seazn streams, never playback of one that
// exists. The relay is asked only when there is something to sign, so a relay-disabled deployment answers a fixture with no
// Seazn video without touching it. With one, `relayDrivers()` hands back the disabled pair, whose every method rejects with
// `RelayDriversDisabled`: the live and each part are left out and logged under that name, and the answer is
// `{ live: null, replay: [] }`. A live deployment that cannot even BUILD its relay (its Cloudflare secrets missing) still throws.
//
// Secrets: a signed URL is the answer itself and goes nowhere else — never logged, never in an error. The privileged `sql`
// client: fixture_stream_* and seazn_locked_videos are FORCE RLS with no policy (V410, V541), the stream pattern (parts.ts).
import { sql } from "@/lib/db";
import type { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { log } from "@/server/logger";
import { DELETE_RECORDING_AFTER_DAYS } from "@/server/relay/config";
import { relayDrivers } from "@/server/relay/drivers";
import { TERMINAL_STATES } from "@/server/relay/domain/session";
import { type PlaybackDeps, PlaybackTokenRecentlyFailed, processPlaybackTokenCache, signLivePlayback, signRecordingPlayback } from "./cf-playback";

export type { PublicFixtureVideo };

const EMPTY = (): PublicFixtureVideo => ({ live: null, replay: [] });
/** A fixture id is a uuid; anything else names no fixture, and is answered before it reaches a query (22P02 would be a 500). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The PUBLIC read: the fixture's Seazn video, or the empty video when the public may not see the fixture. `playback` is a test
 *  seam; production signs through this process's relay and its one token cache (Task 13). */
export async function seaznFixtureVideo(fixtureId: string, now: Date, playback?: PlaybackDeps): Promise<PublicFixtureVideo> {
  if (!UUID.test(fixtureId)) return EMPTY();
  const [visible] = await sql<{ id: string }[]>`
    select v.id from public_fixtures_v v join divisions d on d.id = v.division_id
     where v.id = ${fixtureId} and d.status <> 'setup'`;
  return visible ? videoOf(fixtureId, null, now, playback) : EMPTY();
}

/** The ORGANISER's read: the same answer for this organisation's fixture, whatever its competition's visibility. Another
 *  organisation's fixture answers the empty video. */
export async function seaznFixtureVideoForOrg(orgId: string, fixtureId: string, now: Date, playback?: PlaybackDeps): Promise<PublicFixtureVideo> {
  if (!UUID.test(fixtureId) || !UUID.test(orgId)) return EMPTY();
  const [own] = await sql<{ id: string }[]>`select id from fixtures where id = ${fixtureId} and org_id = ${orgId}`;
  return own ? videoOf(fixtureId, orgId, now, playback) : EMPTY();
}

interface LatestSession { id: string; state: string; destination_kind: string; programme_uid: string | null }
interface LockedRecording { cf_video_id: string; session_id: string; session_created_at: Date | string }

const DAY_MS = 86_400_000;
/** What a rejected mint is logged as: its class alone. A message could quote a request, and a request can carry a token. */
const errorClass = (e: unknown): string => (e instanceof Error ? e.name : typeof e);
/** A failure worth a line: a mint that was asked and failed. A refusal inside a failed mint's window asked nothing (review I1). */
const freshFailure = (e: unknown): boolean => !(e instanceof PlaybackTokenRecentlyFailed);

async function videoOf(fixtureId: string, orgId: string | null, now: Date, playback: PlaybackDeps | undefined): Promise<PublicFixtureVideo> {
  const inOrg = orgId === null ? sql`` : sql`and s.org_id = ${orgId}`;
  // The programme input is the session's lowest programme slot (readFirstInput's row), read for its uid alone: nothing
  // sealed is opened on a viewer's request.
  const [latest] = await sql<LatestSession[]>`
    select s.id, s.state, s.destination_kind,
           (select i.ingest_input_id from fixture_stream_inputs i
             where i.session_id = s.id and i.role = 'programme' order by i.slot asc limit 1) as programme_uid
      from fixture_stream_sessions s
     where s.fixture_id = ${fixtureId} ${inOrg}
     order by s.created_at desc, s.id desc
     limit 1`;
  const recordings = await sql<LockedRecording[]>`
    select v.cf_video_id, s.id as session_id, s.created_at as session_created_at
      from seazn_locked_videos v
      join fixture_stream_inputs i on i.id = v.input_row_id
      join fixture_stream_sessions s on s.id = i.session_id
     where s.fixture_id = ${fixtureId} ${inOrg}
       and s.destination_kind = 'seazn' and i.role = 'programme' and s.state in ${sql([...TERMINAL_STATES])}
     order by s.created_at, s.id, v.recorded_at nulls last, v.locked_at, v.cf_video_id`;
  // Numbered over every locked recording, THEN bounded by Cloudflare's own delete: a part keeps its number as older ones go.
  const cutoff = now.getTime() - DELETE_RECORDING_AFTER_DAYS * DAY_MS;
  const playable = recordings
    .map((r, i) => ({ ...r, partNo: i + 1 }))
    .filter((r) => new Date(r.session_created_at).getTime() > cutoff);

  const onAir = latest !== undefined && latest.destination_kind === "seazn" && latest.state === "live";
  const liveUid = onAir ? latest.programme_uid : null;
  if (onAir && liveUid === null) {
    // A live Seazn session has a provisioned programme input; one without a uid has nothing to sign, so it shows no live.
    log.warn({ sessionId: latest.id }, "seazn video: a live Seazn session has no programme input uid; no live is shown");
  }
  if (liveUid === null && playable.length === 0) return EMPTY();

  const deps = playback ?? { ingest: relayDrivers().ingest, tokenCache: processPlaybackTokenCache() };
  // The live and each part are signed on their own: one that cannot be minted is left out of this answer, never the answer.
  const [liveSigned, signed] = await Promise.all([
    liveUid === null ? null : signLivePlayback(deps, liveUid, now).then((v) => ({ ok: v }), (err: unknown) => ({ err })),
    Promise.allSettled(playable.map((r) => signRecordingPlayback(deps, r.cf_video_id, now))),
  ]);
  let live: PublicFixtureVideo["live"] = null;
  if (liveSigned !== null && "ok" in liveSigned) live = liveSigned.ok;
  else if (liveSigned !== null && freshFailure(liveSigned.err)) {
    log.warn({ sessionId: latest!.id, err: errorClass(liveSigned.err) }, "seazn video: the live could not be signed; this answer has no live");
  }
  const replay: PublicFixtureVideo["replay"] = [];
  signed.forEach((s, i) => {
    const r = playable[i]!;
    if (s.status === "fulfilled") replay.push({ partNo: r.partNo, player: "hls", ...s.value });
    else if (freshFailure(s.reason)) {
      log.warn(
        { sessionId: r.session_id, cfVideoId: r.cf_video_id, err: errorClass(s.reason) },
        "seazn video: a replay part could not be signed; it is left out of this answer",
      );
    }
  });
  return { live, replay };
}
