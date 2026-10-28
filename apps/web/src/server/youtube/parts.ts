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
// A part is `{ partNo, url }`. The url is the video's watch URL: a broadcast id is also its video id. Only `complete` rows count - a
// failed, open or ending broadcast is not a replay yet (V479's check: a complete row always has a finish time and a video id).
import { sql } from "@/lib/db";
import { youtubeWatchUrl, type OrganiserReplayPart, type ReplayPart } from "@/lib/youtube";

export type { OrganiserReplayPart, ReplayPart };

interface PartRow {
  part_no: number;
  video_id: string;
}
const toParts = (rows: PartRow[]): ReplayPart[] => rows.map((r) => ({ partNo: r.part_no, url: youtubeWatchUrl(r.video_id) }));

/** The parts the PUBLIC may see for this fixture, in order. An unpublished fixture (setup division, private competition) has none. */
export async function replayParts(fixtureId: string): Promise<ReplayPart[]> {
  const rows = await sql<PartRow[]>`
    select part_no, video_id
      from public_fixture_youtube_parts_v
     where fixture_id = ${fixtureId}
     order by part_no`;
  return toParts(rows);
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
