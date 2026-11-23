// server/client-reports/chess-room.ts — the `chess-room` client report (Task 25b, chess follow-up; owner 2026-11-23): an online chess
// board's camera room dropped a player's or the arbiter's connection. Sent by components/public-site/match-room/camera-loader.ts
// (`watchRoomDrops`, the ONE watcher both the player's camera and the arbiter's join through) instead of the browser's own Sentry, which
// runs only for a visitor who accepted analytics and which an ad-blocker can stop. A player's drop is the very thing a consent-less
// browser never reports, and the thing an organiser asks about ("did their connection fall, or did they leave?").
//
// The body is closed and every field is an id or a code: the fixture's uuid, the surface that joined, the meeting's side as that surface
// names it, and RealtimeKit's own leave state (lib/chess-room-report-codes.ts). No name, no email, no token, no peer or participant id,
// no time: a report is "this room dropped, this way", and the server stamps the time itself.
//
// A report counts only for a fixture that has a camera room: one with a `fixture_video_meetings` row (V451/V459; any side, ended or not:
// the row is the board's room, and a late drop at the result is still that board's). Any other id is dropped without a word, so the
// route's answer never says whether a fixture exists.
//
// Limits (the shared pipeline's, receive.ts): per IP, fixture and kind, 30 a minute (a connection that flaps does not become 30 log
// lines); one Sentry event per window for each of
//     fixture + surface + side + leave state
// (a player's drop and the arbiter's of the same board are two events: they are two joins; a socket drop and the SDK giving up are two
// events, because they say different things; a flapping line repeats the same pair and is one). The kind's Sentry budget is the
// registry default, 60 first reports an hour: a venue-wide outage reaches Sentry in its first 60 boards and sends the rest to the
// server log, which is what an incident needs, and a quiet hour spends nothing.
import { z } from "zod";
import { ROOM_DROP_STATES, ROOM_REPORT_SIDES, ROOM_REPORT_SURFACES } from "../../lib/chess-room-report-codes.ts";
import { defineClientReportKind } from "./define.ts";

export const ChessRoomClientReport = z.strictObject({
  kind: z.literal("chess-room"),
  /** The board. */
  fixtureId: z.uuid(),
  /** The player's own camera, or the arbiter's. */
  surface: z.enum(ROOM_REPORT_SURFACES),
  /** The meeting's side as the surface names it (a player's colour, an arbiter's home / away); null when the caller did not say. */
  side: z.enum(ROOM_REPORT_SIDES).nullable(),
  /** RealtimeKit's leave state: a lost connection only (never a planned leave). */
  leaveState: z.enum(ROOM_DROP_STATES),
});
export type ChessRoomClientReport = z.infer<typeof ChessRoomClientReport>;

export const chessRoomClientReport = defineClientReportKind(ChessRoomClientReport, (r) => ({
  rateSubject: r.fixtureId,
  dedupeSubject: `${r.fixtureId}:${r.surface}:${r.side ?? "-"}:${r.leaveState}`,
  subjectExists: async (db) => {
    const [row] = await db<{ room: boolean }[]>`
      select exists (select 1 from fixture_video_meetings where fixture_id = ${r.fixtureId}) as room`;
    return row?.room === true;
  },
  message: "realtimekit: room dropped",
  tags: {
    area: "realtimekit",
    event: "room_dropped",
    surface: r.surface,
    leave_state: r.leaveState,
    fixture_id: r.fixtureId,
    ...(r.side === null ? {} : { side: r.side }),
  },
  fields: { fixtureId: r.fixtureId, surface: r.surface, side: r.side, leaveState: r.leaveState },
}));
