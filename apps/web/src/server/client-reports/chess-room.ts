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
// UNAUTHENTICATED HINTS, NOT EVIDENCE. The route is public and a fixture's id is public, so anyone can send a well-formed report for any
// live board: nothing in it is signed, and nothing in it proves a player's connection dropped. It is an operator's lead for the server
// log and Sentry, never a record an organiser or an arbiter may rely on in a dispute. Nothing reads these reports back: the server's own
// camera flags and guard-fault stamps (`fixture_play_flags`, `fixture_video_guard_faults`) are written by the server, never from here.
//
// A report counts only for the camera room it NAMES, and only while that room is LIVE: the `fixture_video_meetings` row of THAT side
// (D16, §5.6.1: a board has a meeting per player, so the statement names the side; the source guard in
// external-play/__tests__/video-per-player-source-guard.test.ts holds every reference to it) that has not ended, or ended within the last 15
// minutes (a drop at the result, or the room's own teardown racing the client's last event, is still that board's). The side a report
// names is the arbiter's own meeting side (`home` / `away`), or a player's COLOUR, which is read through the board's bridge (the
// `white_side` the game fixed: White's meeting is that side's, Black's the other). A colour the bridge has not fixed yet (no game
// has been made) names no meeting, and that report is dropped like any other that names none. A report that names no side at all is
// refused by the schema (400): both production callers always send one (the room shell passes `you.colour`, the arbiter its meeting side),
// and the any-side reading a board-wide statement would need is a listed exemption of the guard, not this report's to take.
// Any other id is dropped without a word, so the route's answer never says whether a fixture exists, and a board whose room is long over
// can neither be forged against nor have a dedupe slot taken on it.
//
// Limits (the shared pipeline's, receive.ts): per IP, fixture and kind, 30 a minute (a connection that flaps does not become 30 log
// lines); one Sentry event per window for each of
//     fixture + surface + side + leave state
// (a player's drop and the arbiter's of the same board are two events: they are two joins; a socket drop and the SDK giving up are two
// events, because they say different things; a flapping line repeats the same pair and is one). The kind's Sentry budget is the
// registry default, 60 first reports an hour, and it counts DEDUPE KEYS, not boards: a board that drops on both surfaces and in more
// than one state spends several (about three is usual), so an outage across a whole venue reaches Sentry with its first 60 keys, a
// score of boards, and the rest are server-log lines. One client IP's Sentry share is 5 an hour across every kind, so a venue behind one
// NAT is held to 5 events whatever its boards do: the log has the rest. A quiet hour spends nothing.
import { z } from "zod";
import { ROOM_DROP_STATES, ROOM_REPORT_SIDES, ROOM_REPORT_SURFACES } from "../../lib/chess-room-report-codes.ts";
import { defineClientReportKind } from "./define.ts";

export const ChessRoomClientReport = z.strictObject({
  kind: z.literal("chess-room"),
  /** The board. */
  fixtureId: z.uuid(),
  /** The player's own camera, or the arbiter's. */
  surface: z.enum(ROOM_REPORT_SURFACES),
  /** The meeting's side as the surface names it: a player's colour (white / black), an arbiter's meeting side (home / away). */
  side: z.enum(ROOM_REPORT_SIDES),
  /** RealtimeKit's leave state: a lost connection only (never a planned leave). */
  leaveState: z.enum(ROOM_DROP_STATES),
});
export type ChessRoomClientReport = z.infer<typeof ChessRoomClientReport>;

export const chessRoomClientReport = defineClientReportKind(ChessRoomClientReport, (r) => ({
  rateSubject: r.fixtureId,
  dedupeSubject: `${r.fixtureId}:${r.surface}:${r.side}:${r.leaveState}`,
  subjectExists: async (db) => {
    // The meeting's side: home / away as named, or a colour through the bridge's `white_side` (null until a game fixes it, so a
    // colour with no game names no meeting and nothing matches). `m.side` is NAMED in the predicate: the guard reads it there.
    const [row] = await db<{ room: boolean }[]>`
      select exists (
        select 1
        from fixture_video_meetings m
        left join fixture_external_play x on x.fixture_id = m.fixture_id
        where m.fixture_id = ${r.fixtureId}
          and m.side = case ${r.side}::text
            when 'home' then 'home'
            when 'away' then 'away'
            when 'white' then x.white_side
            when 'black' then case x.white_side when 'home' then 'away' when 'away' then 'home' end
          end
          and (m.ended_at is null or m.ended_at > now() - interval '15 minutes')
      ) as room`;
    return row?.room === true;
  },
  message: "realtimekit: room dropped",
  tags: {
    area: "realtimekit",
    event: "room_dropped",
    surface: r.surface,
    leave_state: r.leaveState,
    fixture_id: r.fixtureId,
    side: r.side,
  },
  fields: { fixtureId: r.fixtureId, surface: r.surface, side: r.side, leaveState: r.leaveState },
}));
