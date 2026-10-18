// The overlay's toss, per sport (R2005 change 11). Pure / client-safe.
//
// Two sports declare a toss today (their engine modules' `<sport>.toss` events), and they record different facts:
// CRICKET's says who won it and what they elected (bat / bowl); CARROM's says only who BREAKS FIRST (Law 42 — there is
// no "won" and no election). So the overlay carries each in its own shape and the warming line reads a per-sport union
// — carrom's is never cast into cricket's `OverlayCricketToss`, whose copy ("won the toss and elected to …") could not
// say it.
import type { OverlayCricketToss } from "@/lib/overlay-cricket";

/** Carrom's toss on the wire: the side that breaks first in game 1. Null on the wire = no toss taken. */
export interface OverlayCarromToss {
  firstBreakSide: 0 | 1;
}

export type OverlayToss =
  | { sport: "cricket"; toss: OverlayCricketToss }
  | { sport: "carrom"; toss: OverlayCarromToss };

/**
 * Carrom's toss off its folded STATE, by shape — the way `project.ts` reads everything else off a module's state (no
 * sport-key branch): the engine's fold records `tossTaken: true` and `firstBreak: "home" | "away"`
 * (`packages/engine/src/sports/carrom/carrom.ts`, `applyToss`). `tossTaken` is the authority: `firstBreak` holds a
 * default before any toss, so reading it alone would announce a toss nobody took. A voided toss is folded away by the
 * engine, so `tossTaken` is false again and this answers null.
 */
export function carromTossOf(state: unknown): OverlayCarromToss | null {
  if (typeof state !== "object" || state === null) return null;
  const s = state as { tossTaken?: unknown; firstBreak?: unknown };
  if (s.tossTaken !== true) return null;
  if (s.firstBreak === "home") return { firstBreakSide: 0 };
  if (s.firstBreak === "away") return { firstBreakSide: 1 };
  return null;
}

/** The overlay payload's toss as the union the warming line and the toss card read. Each field is present only for its
 *  own sport (the loader projects cricket's off the scorecard, carrom's off the state), so presence picks the arm. */
export function overlayTossOf(data: {
  cricketToss?: OverlayCricketToss | null;
  carromToss?: OverlayCarromToss | null;
}): OverlayToss | null {
  if (data.cricketToss) return { sport: "cricket", toss: data.cricketToss };
  if (data.carromToss) return { sport: "carrom", toss: data.carromToss };
  return null;
}
