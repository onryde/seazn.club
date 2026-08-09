// The ONE step both the solver's lattice and the board's time axis are built
// from (#datetime-ux prompt 05).
//
// WHY THIS FILE EXISTS AT ALL. The frontend used to segment the board by
// `matchMinutes + gapMinutes` while `buildGrid` searched a `gcd(match, gap)`
// lattice. On a 30/10 board that is a 40-minute row against a 10-minute slot:
// the solver places a match at 09:10, the board draws it in the 09:00 row, and
// two fixtures 10 minutes apart render on top of each other. Placer-versus-
// display drift is this repo's signature scheduling defect, so the fix is one
// exported function and a test that compares THE TWO SIDES TO EACH OTHER —
// never each independently against a literal, which is exactly the shape that
// stays green when a call site quietly stops importing the helper.
import { describe, expect, it } from "vitest";
import { buildGrid } from "./build-grid.ts";
import type { SlotConfig } from "./calendar.ts";
import { GRID_FLOOR_MINUTES, gridStepMinutes } from "./grid-step.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 8, 0); // Sat 08 Aug 2026, 08:00Z

const cfg = (over: Partial<SlotConfig> = {}): SlotConfig & { courts: string[] } => ({
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 10,
  courts: ["C1"],
  perEntrantMinRest: 0,
  window: { from: T0, to: T0 + 4 * 60 * MIN },
  ...over,
});

describe("gridStepMinutes", () => {
  it("is the gcd of match and gap length", () => {
    // The coarsest step that can still express every back-to-back placement:
    // on one court a match starts at a multiple of `match + gap`, but AGAINST a
    // blackout or an existing booking it starts at that edge, which is a
    // multiple of neither alone.
    expect(gridStepMinutes(30, 10)).toBe(10);
    expect(gridStepMinutes(40, 10)).toBe(10);
    expect(gridStepMinutes(45, 15)).toBe(15);
    expect(gridStepMinutes(60, 15)).toBe(15);
    // Not the sum, and not either input: the pre-fix board drew 40-minute rows
    // for the first of these and 55-minute rows for the last.
    expect(gridStepMinutes(45, 10)).toBe(5);
  });

  it("degenerates to the match length when there is no gap", () => {
    // gcd(m, 0) === m, and that is RIGHT rather than a special case: a
    // back-to-back court's starts really are multiples of the match length.
    expect(gridStepMinutes(30, 0)).toBe(30);
    expect(gridStepMinutes(45, 0)).toBe(45);
    expect(gridStepMinutes(60, 0)).toBe(60);
  });

  // ---------------------------------------------------------------- edges
  // Every case below is reachable from real config: `matchMinutes` and
  // `gapMinutes` arrive from a stored JSONB blob that predates any schema
  // narrowing, and since prompt 05 this function is also called from the
  // browser with whatever that blob holds. The contract is that it ALWAYS
  // returns a finite, positive, whole number of minutes — a board that cannot
  // draw a time axis is worse than a board drawn on a coarse one.

  it("floors at the repair grid, which is what stops a coprime board exploding", () => {
    // gcd(7, 3) === 1. Unfloored, a one-minute step over an ordinary 08:00
    // -22:00 board is 840 rows; the floor makes the worst case 168. The floor
    // is ALSO why the two solvers agree about what "on-grid" means, so it
    // cannot be relaxed for the display alone.
    expect(GRID_FLOOR_MINUTES).toBe(5);
    expect(gridStepMinutes(7, 3)).toBe(GRID_FLOOR_MINUTES);
    expect(gridStepMinutes(23, 8)).toBe(GRID_FLOOR_MINUTES);
    expect(840 / gridStepMinutes(7, 3)).toBeLessThanOrEqual(168);
  });

  it("treats a non-positive match length as unschedulable, not as a division by zero", () => {
    // `gcd(0, g) === g` would hand back the GAP as a match pitch, and a
    // negative length would walk the recursion into nonsense. Both clamp to 1
    // and therefore land on the floor: no lattice, but a finite one.
    expect(gridStepMinutes(0, 30)).toBe(GRID_FLOOR_MINUTES);
    expect(gridStepMinutes(-30, 10)).toBe(GRID_FLOOR_MINUTES);
  });

  it("reads a negative gap as no gap", () => {
    // Clamped to 0, so it falls through to the back-to-back case above rather
    // than producing a step FINER than the board needs.
    expect(gridStepMinutes(30, -10)).toBe(30);
  });

  it("rounds a fractional input to whole minutes", () => {
    // The lattice is minute-indexed; a sub-minute start is not expressible on
    // either side. 22.5 -> 23 and 7.5 -> 8 are coprime, hence the floor.
    expect(gridStepMinutes(30.4, 10)).toBe(10);
    expect(gridStepMinutes(22.5, 7.5)).toBe(GRID_FLOOR_MINUTES);
    expect(Number.isInteger(gridStepMinutes(22.5, 7.5))).toBe(true);
  });

  it("survives a non-finite input instead of blowing the stack", () => {
    // THE ONE THAT WAS A LIVE CRASH. The pre-extraction body recursed
    // `gcd(NaN, NaN % NaN)` forever and threw `RangeError: Maximum call stack
    // size exceeded`. Engine-internal that was latent, because the config was
    // validated upstream; called from the board island it takes the whole
    // schedule page down on one malformed number.
    expect(gridStepMinutes(Number.NaN, 10)).toBe(GRID_FLOOR_MINUTES);
    expect(gridStepMinutes(30, Number.NaN)).toBe(GRID_FLOOR_MINUTES);
    expect(gridStepMinutes(Number.POSITIVE_INFINITY, 10)).toBe(GRID_FLOOR_MINUTES);
    expect(gridStepMinutes(30, Number.POSITIVE_INFINITY)).toBe(GRID_FLOOR_MINUTES);
  });

  // ------------------------------------------------------- both-sides check
  it("matches the lattice buildGrid ACTUALLY emits, not merely the number it reports", () => {
    // `grid.stepMinutes` is buildGrid's own claim about itself. Measuring the
    // spacing of the slots it emitted instead means a buildGrid that reported
    // one step and stepped by another cannot pass, and neither can one that
    // re-derived the step inline.
    const config = cfg({ matchMinutes: 30, gapMinutes: 10 });
    const grid = buildGrid({ config });
    const starts = grid.byCourt.get("C1")!.map((i) => grid.slots[i]!.startAt);

    expect(starts.length).toBeGreaterThan(2);
    const observed = (starts[1]! - starts[0]!) / MIN;
    expect(observed).toBe(gridStepMinutes(config.matchMinutes, config.gapMinutes));
    expect(grid.stepMinutes).toBe(gridStepMinutes(config.matchMinutes, config.gapMinutes));

    // And the sum the board used to draw is NOT that number, so this fixture
    // can actually tell the two rules apart.
    expect(config.matchMinutes + config.gapMinutes).not.toBe(observed);
  });

  it("keeps agreeing across every shape the two rules disagree on", () => {
    // A single fixture proves one point. `gapMinutes: 0` — the shape BOTH
    // existing board suites happen to use — is the one case where the sum and
    // the gcd coincide, so a sweep that only looked there would pass against
    // the old code.
    for (const [matchMinutes, gapMinutes] of [
      [30, 10],
      [45, 15],
      [60, 20],
      [20, 5],
      [30, 0],
    ] as const) {
      const config = cfg({ matchMinutes, gapMinutes });
      const grid = buildGrid({ config });
      const starts = grid.byCourt.get("C1")!.map((i) => grid.slots[i]!.startAt);
      expect({ matchMinutes, gapMinutes, step: (starts[1]! - starts[0]!) / MIN }).toEqual({
        matchMinutes,
        gapMinutes,
        step: gridStepMinutes(matchMinutes, gapMinutes),
      });
    }
  });
});
