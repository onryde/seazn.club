// Curated time controls (design §3.7), validated at TOURNAMENT SETUP.
//
// Why a catalogue and not a formula: M12 (2026-10-09) — a 0+1 and a 1+0
// challenge were ACCEPTED at creation and then refused every move with
// 400 "This game cannot be played with the Board API.". Creation succeeding
// proves nothing, so the organiser picks from a list each of whose entries has
// been verified playable.
//
// Two INDEPENDENT measured rules, and the independence is the point:
//   M13 playability — estimated duration `limit + 40 × increment >= 180`.
//     120+1 (160s) → speed=bullet → moves refused; 180+0 (180s) → speed=blitz
//     → move 200. Two points tested, not the whole curve. (lila's own rule,
//     read from source 2026-10-09 and consistent with both points: a friend
//     or API game is Board-API compatible when its speed is Blitz or slower —
//     `isBoardCompatible`, modules/game/src/main/Game.scala, 7b53d2671.)
//   M14 creatability — `clock.limit` is an ENUMERATED set, not a free integer.
//     170+0 and 140+1 were refused at creation with
//     {"clock.limit":["Invalid value"]}.
// 140+1 clears M13 (140 + 40 = 180) and still fails M14; 120+1 clears M14
// (it was created) and still fails M13. Neither rule implies the other.
//
// WHERE THIS PLUGS IN — declared, not yet driven: nothing calls
// assertTimeControl yet. T9 calls it before creation and the division
// settings save calls it at setup. Until T9 lands this module is an inert
// seam (AGENTS.md failure class 1). Today the clock still reaches Lichess
// through clock.ts's `mapBoardgameClockToLichess` (divisions.config.clock
// {base, increment?, delay?} → {limit, increment}), read in guard.ts.
import { HttpError } from "@/lib/errors";

export type TimeControl = { key: string; limitSeconds: number; incrementSeconds: number };

/** M13's cutoff: blitz or slower. */
export const BOARD_API_MIN_ESTIMATED_SECONDS = 180;

/** Lichess's own estimate of a game's duration, which is what picks the speed
 *  bucket: the base clock plus 40 moves' worth of increment. */
export function estimatedSeconds(tc: TimeControl): number {
  return tc.limitSeconds + 40 * tc.incrementSeconds;
}

export function isBoardApiPlayable(tc: TimeControl): boolean {
  return estimatedSeconds(tc) >= BOARD_API_MIN_ESTIMATED_SECONDS;
}

/**
 * M14's rule, AS MEASURED and no wider. The two refusals were 170 and 140,
 * neither a multiple of 60; every limit the committed spike logs show being
 * accepted at creation — 0, 60, 120, 180 and 600 (spike-battery2.log §A-§F,
 * tc-boundary.log, flag-spike.log) — is one. This is therefore a SUFFICIENT
 * condition for our catalogue, not a transcription of Lichess's enumeration,
 * and a guessed enum would be a fabricated expected value.
 *
 * 0 is included because it WAS accepted (§A, 0+1); that it cannot then be
 * PLAYED is M13's verdict, not this rule's — which is exactly the
 * independence the two rules exist to keep. A negative limit is not a clock.
 *
 * NOT measured, so read `true` as "matches the measured pattern", nothing
 * more: 300 and 900 (5+0, 5+3, 15+10) have never been created live; they pass
 * on this pattern alone. Lichess's API docs (fetched 2026-10-09) state the
 * same rule plus a cap — `clock.limit` "0, 15, 30, 45, 60, 90, and any
 * multiple of 60 up to 10800" — but that is documentation, not a
 * measurement, and neither the cap nor the sub-minute values are encoded.
 *
 * If a future ship-1 list wants a sub-minute, odd-second or longer-than-600s
 * control, MEASURE it against lichess.org first and widen this with the log
 * line as evidence.
 */
export function isCreatableLimit(limitSeconds: number): boolean {
  return limitSeconds >= 0 && limitSeconds % 60 === 0;
}

/** Ship-1 (§3.7). Frozen: a caller must not be able to push an unverified
 *  entry into the shared catalogue, which would walk straight past the sweep
 *  that checks it. */
export const SHIP1_TIME_CONTROLS: readonly TimeControl[] = Object.freeze([
  Object.freeze({ key: "3+0", limitSeconds: 180, incrementSeconds: 0 }),
  Object.freeze({ key: "3+2", limitSeconds: 180, incrementSeconds: 2 }),
  Object.freeze({ key: "5+0", limitSeconds: 300, incrementSeconds: 0 }),
  Object.freeze({ key: "5+3", limitSeconds: 300, incrementSeconds: 3 }),
  Object.freeze({ key: "10+5", limitSeconds: 600, incrementSeconds: 5 }),
  Object.freeze({ key: "15+10", limitSeconds: 900, incrementSeconds: 10 }),
]);

/** The setup gate. The CATALOGUE is the gate, not the formula: an entry can
 *  satisfy both measured rules and still be refused, because §3.7 permits only
 *  controls that have been verified playable. `find` on the array, never a
 *  record lookup — a record would let `__proto__` or `constructor` resolve. */
export function assertTimeControl(key: string): TimeControl {
  const found = SHIP1_TIME_CONTROLS.find((tc) => tc.key === key);
  if (!found) {
    throw new HttpError(
      400,
      `Pick one of the supported time controls: ${SHIP1_TIME_CONTROLS.map((t) => t.key).join(", ")}.`,
      "INVALID_TIME_CONTROL",
    );
  }
  return found;
}
