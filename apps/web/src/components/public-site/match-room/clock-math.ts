import { plyOfFen } from "./ply";
import type { Colour, RoomGame } from "./room-snapshot";

/**
 * Milliseconds left on one side's clock, rendered locally.
 *
 * `baseMs` is the last value we were TOLD (an accepted move's broadcast, or
 * a reconcile's authoritative export clocks — M11), `asOfMs` is when that
 * value was true, and `nowMs` is the viewer's tick. A correction that moves
 * time backwards therefore wins by construction: a fresh `baseMs`/`asOfMs`
 * pair replaces the derivation rather than being blended with it.
 *
 * Floored at zero and never interpreted. Reaching zero is one of
 * reconcile's four triggers (design §3.5); it is never, on its own, a flag.
 */
export function remainingMs(a: { baseMs: number; asOfMs: number; nowMs: number; running: boolean }): number {
  if (!a.running) return Math.max(0, a.baseMs);
  return Math.max(0, a.baseMs - Math.max(0, a.nowMs - a.asOfMs));
}

/**
 * T17B fix 2, D13: the instant, on the SERVER's clock, at which the side to
 * move's clock reaches zero — the same reading the clock face counts down
 * (each clock is as at `clockAsOf`, V454) — or null when no clock runs toward
 * one: the clocks not started (ply < 2), the game over, no stamp yet. Never a
 * flag on its own: Lichess decides that (reconcile.ts, D11).
 */
export function moverFlagAt(g: {
  clockRunning: boolean;
  over: boolean;
  clockAsOf: string | null;
  turn: "white" | "black";
  whiteMs: number;
  blackMs: number;
}): number | null {
  if (!g.clockRunning || g.over || g.clockAsOf === null) return null;
  return Date.parse(g.clockAsOf) + Math.max(0, g.turn === "white" ? g.whiteMs : g.blackMs);
}

/** Below this the face shows tenths (time trouble). T17B fix 2, D24 (owner): twenty seconds, not ten. */
export const TENTHS_BELOW_MS = 20_000;

/**
 * The clock face. `m:ss` with the seconds rounded UP (a clock reading 0:00
 * must mean no time at all); below TENTHS_BELOW_MS `0:ss.t` (two-digit
 * seconds: 0:19.7), floored to the tenth but never showing 0.0 while any time
 * remains.
 */
export function formatClock(ms: number): string {
  if (ms <= 0) return "0:00.0";
  if (ms < TENTHS_BELOW_MS) {
    const tenths = Math.max(1, Math.floor(ms / 100));
    return `0:${Math.floor(tenths / 10).toString().padStart(2, "0")}.${tenths % 10}`;
  }
  const total = Math.ceil(ms / 1_000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── T17B fix 2, D24: the player's own increment, shown at the drop ───────────────────────────────────────────
//
// Today the page waits for Lichess, so a 1.4 s clock sat there and then jumped to 4.4. At the drop of the player's own
// move the face is now what the SERVER will write: the clock as it stood at that instant, plus the division's
// increment (play.ts, scalachess Clock.step) — the first two plies cost and earn nothing (the clocks are not running),
// and the increment is earned only if time remained. The record is a guess and nothing more: the moment the move is on
// the ledger (the board's ply reaches the move's) the SERVER's number stands, so the increment is never added twice, and
// a refusal removes the record (room-state), so the clock is the server's again. Who reads it: the face, and with it the
// clock-zero report (use-clock-faces: a move dropped in time is not a clock at zero) and the flag lock, which stands
// down while the guess applies (room-shell: no "Time's up" over a live face). The low-time cue keeps reading the
// server's own clock (room-sounds), so a drop within one round trip of 10 s can fire it with the face above 10 s.

/** The longest a guess may stand with no confirmation: past any honest round trip, short of a minute pinned on a move
 *  Lichess never confirmed (the next read of the room would have replaced it long before). */
export const OPTIMISTIC_CLOCK_MAX_MS = 10_000;

/** The player's clock as the drop left it: `ms` is true from `at` (server clock) until the ply `ply` is on the ledger. */
export type OptimisticClock = { gameId: string; ply: number; ms: number; at: number };

/** The ply of a game, from its FEN — the room's one measure (a broadcast that jumped plies keeps the ledger short). */
const plyOfGame = (g: RoomGame): number => plyOfFen(g.fen);

/**
 * The guess a move dropped at `atMs` (the server's clock) leaves, or null when the server adds nothing: no game, the
 * game over or a result written, the clocks not yet running (the first two plies), not the player's turn, no
 * increment, an instant that is not a finite number, or no time left at the drop (a move made at zero earns nothing).
 *
 * `incrementSeconds` is the snapshot's `meta.incrementSeconds`: the LEDGER's number (the game's own clock — the one
 * play.ts adds on every move) once the game has one, the division's before it (room.ts, re-review M2) — so the guess and
 * the server's write read the same number even if the division's clock was edited after the game began.
 */
export function optimisticAfterDrop(a: {
  game: RoomGame | null;
  you: Colour;
  incrementSeconds: number;
  resultWritten: boolean;
  atMs: number;
}): OptimisticClock | null {
  const g = a.game;
  if (g === null || g.over || a.resultWritten || !g.clockRunning || g.clockAsOf === null || g.turn !== a.you) return null;
  if (!(a.incrementSeconds > 0)) return null;
  // The instant is the sender's clock plus the viewer's skew: an unreadable serverNow makes it NaN, which slides through
  // every comparison below into a guess of NaN milliseconds (re-review M3).
  if (!Number.isFinite(a.atMs)) return null;
  const left = remainingMs({
    baseMs: a.you === "white" ? g.whiteMs : g.blackMs,
    asOfMs: Date.parse(g.clockAsOf),
    nowMs: a.atMs,
    running: true,
  });
  if (left <= 0) return null;
  return { gameId: g.gameId, ply: plyOfGame(g) + 1, ms: left + a.incrementSeconds * 1_000, at: a.atMs };
}

/**
 * The guess, while it still applies: the same game, not over, no result, the move not yet on the ledger, and not past
 * OPTIMISTIC_CLOCK_MAX_MS (`nowMs` null — the clock has not ticked, a static render — never expires it).
 */
export function optimisticOwnMs(a: {
  optimistic: OptimisticClock | null;
  game: RoomGame;
  resultWritten: boolean;
  nowMs: number | null;
}): number | null {
  const o = a.optimistic;
  if (o === null || a.game.gameId !== o.gameId || a.game.over || a.resultWritten) return null;
  if (plyOfGame(a.game) >= o.ply) return null;
  if (a.nowMs !== null && a.nowMs - o.at > OPTIMISTIC_CLOCK_MAX_MS) return null;
  return o.ms;
}

/**
 * Both faces, in ms: each side counted down from the server's instant while its clock runs, the player's own face the
 * guess while it applies (frozen at what the drop left). `nowMs` null (before the first tick) reads every clock as
 * stopped at its told value.
 */
export function clockFaces(a: {
  game: RoomGame;
  you: Colour;
  optimistic: OptimisticClock | null;
  resultWritten: boolean;
  nowMs: number | null;
}): Record<Colour, number> {
  const g = a.game;
  const running = g.clockRunning && !g.over && a.nowMs !== null;
  const asOf = g.clockAsOf ? Date.parse(g.clockAsOf) : 0;
  const own = optimisticOwnMs({ optimistic: a.optimistic, game: g, resultWritten: a.resultWritten, nowMs: a.nowMs });
  const face = (c: Colour): number => {
    if (c === a.you && own !== null) return own;
    return remainingMs({
      baseMs: c === "white" ? g.whiteMs : g.blackMs,
      asOfMs: asOf,
      nowMs: a.nowMs ?? asOf,
      running: running && g.turn === c,
    });
  };
  return { white: face("white"), black: face("black") };
}
