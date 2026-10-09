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
// M14 is enforced by the CATALOGUE alone: every entry's limit is a multiple
// of 60, the pattern every measured creation fits. There is no production
// predicate for it (round 0's `isCreatableLimit` had no caller and was
// removed in fix round 1, T5-I1); the test pins the catalogue to Lichess's
// documented rule and that rule to every measured outcome.
//
// WHERE THIS PLUGS IN: usecases/divisions.ts calls assertTimeControl on BOTH
// division save paths (createDivision and patchDivision, T6) whenever the
// final config has onlinePlay 'lichess' — so an unplayable clock is refused at
// setup (division-time-control-setup.test.ts). Challenge creation (T9) calls
// it again. It takes the clock the division STORES — divisions.config.clock
// {base, increment?, delay?}, seconds — and maps it through clock.ts's
// `mapBoardgameClockToLichess`, the one authority for that conversion (it
// refuses a delay). The refusal carries `controls` (the catalogue keys) so the
// settings screen can localise the sentence and still list the choices.
import { HttpError } from "@/lib/errors";
import { mapBoardgameClockToLichess, type BoardgameClockInput } from "./clock";

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

/** Ship-1 (§3.7; 10+0 and 15+0 added by owner ruling 2026-10-09, both
 *  measured playable in b3-spike.log). Frozen: a caller must not be able to
 *  push an unverified entry into the shared catalogue, which would walk
 *  straight past the sweep that checks it. */
export const SHIP1_TIME_CONTROLS: readonly TimeControl[] = Object.freeze([
  Object.freeze({ key: "3+0", limitSeconds: 180, incrementSeconds: 0 }),
  Object.freeze({ key: "3+2", limitSeconds: 180, incrementSeconds: 2 }),
  Object.freeze({ key: "5+0", limitSeconds: 300, incrementSeconds: 0 }),
  Object.freeze({ key: "5+3", limitSeconds: 300, incrementSeconds: 3 }),
  Object.freeze({ key: "10+0", limitSeconds: 600, incrementSeconds: 0 }),
  Object.freeze({ key: "10+5", limitSeconds: 600, incrementSeconds: 5 }),
  Object.freeze({ key: "15+0", limitSeconds: 900, incrementSeconds: 0 }),
  Object.freeze({ key: "15+10", limitSeconds: 900, incrementSeconds: 10 }),
]);

/** The setup gate, on the clock as the division stores it. The CATALOGUE is
 *  the gate, not the formula: a clock can satisfy both measured rules and
 *  still be refused, because §3.7 permits only the curated list. Matched on
 *  the mapped numbers with `===`, so a missing clock, a delay clock, a NaN or
 *  a value that drifted to a string in stored JSON matches nothing. */
export function assertTimeControl(clock: BoardgameClockInput | undefined): TimeControl {
  const mapped = mapBoardgameClockToLichess(clock);
  const found = mapped.ok
    ? SHIP1_TIME_CONTROLS.find(
      (tc) => tc.limitSeconds === mapped.clock.limit && tc.incrementSeconds === mapped.clock.increment,
    )
    : undefined;
  if (!found) {
    const controls = SHIP1_TIME_CONTROLS.map((t) => t.key);
    throw new HttpError(
      400,
      `Pick one of the supported time controls: ${controls.join(", ")}.`,
      "INVALID_TIME_CONTROL",
      { controls },
    );
  }
  return found;
}
