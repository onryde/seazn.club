import "server-only";
// server/youtube/parts.ts - a fixture's replay PARTS (plan T16): its complete YouTube broadcasts, numbered 1, 2, ... in the order
// they finished. A restart after a Stop makes a NEW broadcast, so a long match can have several; one part is the common case.
//
// Two reads, one numbering rule (completion time, ties broken by id - the same as the public view):
//   replayParts(fixtureId)               the PUBLIC read (the match page). It reads public_fixture_youtube_parts_v, whose WHERE is
//                                        public_fixtures_v's redaction: a competition that is not public or unlisted, and a division
//                                        still in setup, have no row. The view is NOT granted to app_user (plan R7), so this runs on the
//                                        privileged client - the stream pattern - and the caller is a server loader that has already
//                                        decided the fixture is publicly readable.
//   fixtureReplayParts(orgId, fixtureId) the ORGANISER's read (the fixture stream panel), org-scoped and straight off the table: an
//                                        organiser of a PRIVATE competition still sees their own replays, which the public view must
//                                        not show anyone.
//
// A part is `{ partNo, url }`. The url is the video's watch URL: a broadcast id is also its video id. Only `complete` rows count - a
// failed, open or ending broadcast is not a replay yet (V479's check: a complete row always has a finish time and a video id).
import { sql } from "@/lib/db";
import { youtubeWatchUrl, type ReplayPart } from "@/lib/youtube";

export type { ReplayPart };

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

/** This ORGANISATION's parts for this fixture, in order. Another organisation's fixture id gets nothing. */
export async function fixtureReplayParts(orgId: string, fixtureId: string): Promise<ReplayPart[]> {
  const rows = await sql<PartRow[]>`
    select (row_number() over (order by b.completed_at, b.id))::int as part_no, b.yt_broadcast_id as video_id
      from youtube_broadcasts b
     where b.org_id = ${orgId} and b.fixture_id = ${fixtureId} and b.state = 'complete'
     order by part_no`;
  return toParts(rows);
}
