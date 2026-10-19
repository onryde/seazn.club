import "server-only";
// The match a player's camera is judged over, and OUR safeguard's stamps
// inside it — ONE definition for the two readers (T15 fix round 1, I1): the
// sweep's job 5, which decides camera_lost and camera_connection_problems,
// and the arbiter panel, which shows the organiser the stamped time. The
// panel never re-derives either: what it shows is what job 5 judged.
import type postgres from "postgres";
import { guardFaultSpans } from "./guard-faults";
import { stampedInMatch, type StampedInMatch } from "./match-camera-off";

type AnySql = postgres.TransactionSql | postgres.Sql;

/** A board's timing facts, as fixture_external_play and
 *  fixture_video_meetings hold them. */
export type MatchTimes = {
  /** The first move (T10). */
  startedAt: Date | null;
  /** The bridge's close (T11). */
  finishedAt: Date | null;
  /** The first read that saw the game over (T11). */
  gameOverAt: Date | null;
  lastMoveAt: Date | null;
  moveCount: number | null;
  whiteMs: number | null;
  blackMs: number | null;
  /** The room's teardown (T7's endMeeting): a closed room has no cameras. */
  meetingEndedAt: Date | null;
  /** D11: an organiser let the board play without video from here on. */
  overrideAt: Date | null;
};

/** The GAME's end (ruling I1), in the order of the evidence: the bridge's
 *  close, the first read that saw the game over, the latest the clock let it
 *  run — the last move plus the side to move's remaining time (T10's ledger:
 *  an even count is White to move). Null when none is on file. */
export function gameEndOf(t: MatchTimes): Date | null {
  if (t.finishedAt !== null) return t.finishedAt;
  if (t.gameOverAt !== null) return t.gameOverAt;
  if (t.lastMoveAt === null || t.moveCount === null) return null;
  const toMoveMs = t.moveCount % 2 === 0 ? t.whiteMs : t.blackMs;
  return toMoveMs === null ? null : new Date(t.lastMoveAt.getTime() + toMoveMs);
}

/** The window a camera is judged over:
 *  - from the first move (before it the room is open, the match is not);
 *  - to the EARLIEST of the game's end, the room's end, and an organiser's
 *    video override (M1, an owner call: the override ends the video that was
 *    expected — it never erases the evidence from before the press).
 *  `no_match`: nothing to judge — no first move, or a window with no length
 *  (the override pressed before the first move; a room closed before it).
 *  `no_end`: a match, but no end on file and no override — nothing can be
 *  judged yet; the room's own end is NOT the game's (it outlives it). */
export type MatchWindow = { kind: "window"; from: Date; to: Date } | { kind: "no_match" } | { kind: "no_end" };

export function cameraMatchWindow(t: MatchTimes): MatchWindow {
  if (t.startedAt === null) return { kind: "no_match" };
  const gameEnd = gameEndOf(t);
  if (gameEnd === null && t.overrideAt === null) return { kind: "no_end" };
  const ends = [gameEnd, t.meetingEndedAt, t.overrideAt].filter((d): d is Date => d !== null).map((d) => d.getTime());
  const to = Math.min(...ends);
  if (to <= t.startedAt.getTime()) return { kind: "no_match" };
  return { kind: "window", from: t.startedAt, to: new Date(to) };
}

/** OUR safeguard's stamps for one player, as covered spans: a stamp still
 *  open runs to the window's end — the re-join never landed, and that is
 *  ours too; one opened after the window covers nothing. `stamped` is their
 *  told-or-not total inside the window (stampedInMatch). */
export async function matchGuardFaults(
  db: AnySql,
  a: { fixtureId: string; side: "home" | "away"; personId: string; window: { from: Date; to: Date } },
): Promise<{ faults: { from: Date; to: Date }[]; stamped: StampedInMatch }> {
  const faults = (await guardFaultSpans(db, { fixtureId: a.fixtureId, side: a.side, personId: a.personId })).map((f) => ({
    from: f.from,
    to: f.to ?? new Date(Math.max(f.from.getTime(), a.window.to.getTime())),
  }));
  return { faults, stamped: stampedInMatch(a.window, faults) };
}
