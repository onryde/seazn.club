import "server-only";
// The ONE reader of a player's own camera report (D16 §5.6.3, check-in capacity plan 2 Task 6). A LEAF: its only runtime import is the
// pill's staleness constant, so room.ts (the opponent's pill), preflight.ts (the seat's schedule) and, in plan 3, arbiter.ts can all call
// it with no import cycle. `camera-report.ts` is the writer and keeps its own `for update` lock read (it needs the RAW state and stamp
// under a lock to decide what to write; this function judges on `now`).
//
// What it may be used for, and what it may not: the report is a player's BROWSER's word about its own camera. It may SCHEDULE a vendor
// read (the seat's `camera_starting` wait, and the counted fallback after a first-live stamp) and it paints the opponent's pill. It
// NEVER decides a seat: the verdict is the vendor's peer report alone (spec §2, §6.3). The source guard pins who may name its columns.
import type postgres from "postgres";
import { CAMERA_REPORT_STALE_MS } from "@/components/public-site/match-room/room-snapshot";

type AnySql = postgres.Sql | postgres.TransactionSql;

export type ReportedCamera = {
  /** `live` / `off` only while the stored report is YOUNGER than CAMERA_REPORT_STALE_MS; everything else is `unknown`, never `off` and
   *  never hidden: none yet, a stale one, no participant on file, an ended meeting. */
  state: "live" | "off" | "unknown";
  /** The latest receipt (the server's clock) of the stored report: null when nothing is stored, or the meeting is over. A STALE report
   *  still names its instant (the seat's stale-live arm reads it); `state` is what says whether it is trusted. */
  at: Date | null;
  /** The first receipt of the CURRENT live run (`camera_live_first_at`); null unless the report is live and fresh. A live report from
   *  before V529 has no stamp: `state` is `live` and this is null, for the seat to treat as a run starting at `at`. */
  firstLiveAt: Date | null;
};

const UNKNOWN: ReportedCamera = { state: "unknown", at: null, firstLiveAt: null };

/**
 * One DB read of `(fixtureId, side, participantId)`'s report, judged on `now`. An ENDED meeting reads nothing: its room is over.
 * Side-keyed (D16: a meeting per player; the source guard's rule 1).
 */
export async function reportedCamera(
  db: AnySql,
  a: { fixtureId: string; side: "home" | "away"; participantId: string; now: Date },
): Promise<ReportedCamera> {
  const [row] = await db<{ state: string | null; at: Date | null; first: Date | null }[]>`
    select p.camera_reported as state, p.camera_reported_at as at, p.camera_live_first_at as first
      from fixture_video_participants p
      join fixture_video_meetings m on m.fixture_id = p.fixture_id and m.side = p.side
     where p.fixture_id = ${a.fixtureId} and p.side = ${a.side} and p.participant_id = ${a.participantId} and m.ended_at is null`;
  if (!row || row.state === null || row.at === null) return UNKNOWN;
  if (a.now.getTime() - row.at.getTime() >= CAMERA_REPORT_STALE_MS) return { state: "unknown", at: row.at, firstLiveAt: null };
  if (row.state === "live") return { state: "live", at: row.at, firstLiveAt: row.first };
  if (row.state === "off") return { state: "off", at: row.at, firstLiveAt: null };
  return { state: "unknown", at: row.at, firstLiveAt: null };
}
