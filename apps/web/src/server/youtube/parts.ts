import "server-only";
// server/youtube/parts.ts - a fixture's replay PARTS (plan T16): its complete YouTube broadcasts, numbered 1, 2, ... in the order
// they STARTED. A restart after a Stop makes a NEW broadcast, so a long match can have several; one part is the common case. The
// number follows the start (the broadcast row's created_at), not the finish: a broadcast whose end was retried can finish after the
// one that started later, and it is still the earlier stretch of the match.
//
// Two reads, one ordering rule (start time, ties broken by id - V480 replaces the public view with exactly this). The numbers agree
// unless privacies are mixed: the public read numbers only the parts it shows, the organiser's every complete broadcast:
//   replayParts(fixtureId)               the PUBLIC read (the match page). It reads public_fixture_youtube_parts_v, whose WHERE is
//                                        public_fixtures_v's redaction: a competition that is not public or unlisted, and a division
//                                        still in setup, have no row. The view is NOT granted to app_user (plan R7), so this runs on the
//                                        privileged client - the stream pattern - and the caller is a server loader that has already
//                                        decided the fixture is publicly readable.
//   fixtureReplayParts(orgId, fixtureId) the ORGANISER's read (the fixture stream panel), org-scoped and straight off the table: an
//                                        organiser of a PRIVATE competition still sees their own replays, which the public view must
//                                        not show anyone. It also lists the broadcasts that are PRIVATE on YouTube, flagged
//                                        `private: true` (the public view hides them - owner ruling 2026-10-28, option A).
//
//   sessionVideoUrl(orgId, sessionId)   the ORGANISER's link to the video ONE session streams into (owner, 2026-10-30: the match page's
//                                        "On YouTube" card) - open or finished, any state but `failed`, as soon as YouTube gave it its id.
//
// A part is `{ partNo, url }` (the public read adds `madeForKids`, V482). The url is the video's watch URL: a broadcast id is also its video id. Only `complete` rows count - a
// failed, open or ending broadcast is not a replay yet (V479's check: a complete row always has a finish time and a video id).
import { sql } from "@/lib/db";
import { ACTIVE_STATES } from "@/server/relay/domain/session";
import { youtubeWatchUrl, type OrganiserReplayPart, type PublicReplayPart, type ReplayPart } from "@/lib/youtube";

export type { OrganiserReplayPart, PublicReplayPart, ReplayPart };

interface PartRow {
  part_no: number;
  video_id: string;
}

/** The parts the PUBLIC may see for this fixture, in order. An unpublished fixture (setup division, private competition) has none.
 *  Each carries the BROADCAST's own made-for-kids stamp (V482, read from the view): a made-for-kids replay is a link out on the page,
 *  never a player (DP III.E.4.j) - the page decides, this only says. The organiser's read below carries no such field. */
export async function replayParts(fixtureId: string): Promise<PublicReplayPart[]> {
  const rows = await sql<(PartRow & { made_for_kids: boolean })[]>`
    select part_no, video_id, made_for_kids
      from public_fixture_youtube_parts_v
     where fixture_id = ${fixtureId}
     order by part_no`;
  return rows.map((r) => ({ partNo: r.part_no, url: youtubeWatchUrl(r.video_id), madeForKids: r.made_for_kids }));
}

/** This ORGANISATION's parts for this fixture, in order - EVERY complete broadcast, the private ones too (owner ruling 2026-10-28:
 *  the public page hides a broadcast that is private on YouTube, the organiser keeps it and the panel says so). `private` is the
 *  broadcast row's own privacy, stored when Go live made it. Numbered over all of them, so when privacies are mixed these numbers
 *  can differ from the public page's. Another organisation's fixture id gets nothing. */
export async function fixtureReplayParts(orgId: string, fixtureId: string): Promise<OrganiserReplayPart[]> {
  const rows = await sql<(PartRow & { private: boolean })[]>`
    select (row_number() over (order by b.created_at, b.id))::int as part_no, b.yt_broadcast_id as video_id, (b.privacy = 'private') as private
      from youtube_broadcasts b
     where b.org_id = ${orgId} and b.fixture_id = ${fixtureId} and b.state = 'complete'
     order by part_no`;
  return rows.map((r) => ({ partNo: r.part_no, url: youtubeWatchUrl(r.video_id), private: r.private }));
}

/** The watch URL of the video THIS session streams into (owner, 2026-10-30: the organiser's match page links the match's video on
 *  YouTube), or null. The session's own broadcast (`youtube_broadcast_id`), once YouTube has given it its id, in ANY state but `failed`
 *  - live, ending, complete, or still waiting for the stream (a broadcast that failed never was a video). Null for a pasted key (it names
 *  no broadcast), and after a disconnect (the purge deletes the broadcast rows and V479's FK nulls the session's pointer). Org-scoped
 *  on both rows: a broadcast of another organisation is never this session's link, whatever the session row names. */
export async function sessionVideoUrl(orgId: string, sessionId: string): Promise<string | null> {
  const [row] = await sql<{ video_id: string }[]>`
    select b.yt_broadcast_id as video_id
      from fixture_stream_sessions s
      join youtube_broadcasts b on b.id = s.youtube_broadcast_id and b.org_id = s.org_id
     where s.id = ${sessionId} and s.org_id = ${orgId} and b.yt_broadcast_id is not null and b.state <> 'failed'`;
  return row ? youtubeWatchUrl(row.video_id) : null;
}

/** Match Day's stream preview (task A4, spec §6.2 "Playing, stream live" / §8 Phase 1): for each of these fixtures, the video its
 *  LATEST open session streams into, with that broadcast's own made-for-kids stamp - or nothing. "Latest open" is the very session
 *  `openStreamStates` reads (latest by creation among `ACTIVE_STATES`), so the preview and the court's Live badge speak about one
 *  session; its video is `sessionVideoUrl`'s rule (its own broadcast, once YouTube gave it an id, not failed). A pasted key names no
 *  broadcast, so its fixture is absent. Org-scoped on both rows. The caller decides whether a part may be embedded
 *  (`mayEmbedReplay`). */
export async function liveSessionVideos(orgId: string, fixtureIds: readonly string[]): Promise<Record<string, PublicReplayPart>> {
  if (fixtureIds.length === 0) return {};
  const rows = await sql<{ fixture_id: string; video_id: string; made_for_kids: boolean }[]>`
    select s.fixture_id, b.yt_broadcast_id as video_id, b.made_for_kids
      from (select distinct on (fixture_id) fixture_id, org_id, youtube_broadcast_id
              from fixture_stream_sessions
             where org_id = ${orgId} and fixture_id in ${sql([...fixtureIds])} and state in ${sql([...ACTIVE_STATES])}
             order by fixture_id, created_at desc) s
      join youtube_broadcasts b on b.id = s.youtube_broadcast_id and b.org_id = s.org_id
     where b.yt_broadcast_id is not null and b.state <> 'failed'`;
  const out: Record<string, PublicReplayPart> = {};
  for (const r of rows) out[r.fixture_id] = { partNo: 1, url: youtubeWatchUrl(r.video_id), madeForKids: r.made_for_kids };
  return out;
}
