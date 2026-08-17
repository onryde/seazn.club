// The wall has to bound the RUN, and the caller has to be able to ask whether
// the run is worth starting (rulings R23 and R22).
//
// Both come out of the same Task 13 measurement. At 200 fixtures on a 216-slot
// lattice the solver returned at **15_368 ms against an 8_000 ms wall** — 92 %
// over — because the only wall tests were at the top of the search loops and
// everything expensive happens outside them: `encodeBuild` (3_706 ms) and the
// first `solver.push()` over the encoded model (9_837 ms). Neither reads the
// clock, so a run whose budget was already gone still paid both in full.
//
// R23 puts the tests where the cost is. R22 exports the gate so the web layer
// can decline the call rather than pay it — and so the threshold lives in one
// place, because a second copy of it is a placer/verifier fork wearing a
// different hat, which is the defect shape this subsystem has hit three times.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MAX_SOLVE_ENCODING, canSolveWithin } from "./build.ts";
import { buildGrid } from "./build-grid.ts";
import type { SchedulableFixture, SlotConfig } from "./calendar.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 7, 8, 0);
const COURTS = ["C1", "C2", "C3", "C4"];
const MATCH_MIN = 40;

/**
 * `gapMinutes: 0` makes the lattice step the match length (`gridStepMinutes` is
 * `gcd(match, gap)` floored at 5, and `gcd(m, 0) === m`), so `slotsPerCourtDay`
 * means exactly what it says and the fixture-slot product below is arithmetic
 * rather than a guess.
 *
 * THE 20-MINUTE REST DOES NOT ENTER THE STEP, and that is the point of the
 * board: greedy chains an entrant's next start on `lastEnd + rest`, so this
 * board's seed sits off the lattice and is carried by `seedPinsOf`'s pins
 * instead of by an 8x finer grid. `buildGrid` here is called WITHOUT them —
 * the gate prices the bare lattice, which is what `canSolveWithin` does too.
 */
function board(opts: { n: number; days: number; slotsPerCourtDay: number }): {
  fixtures: SchedulableFixture[];
  config: SlotConfig & { courts: string[] };
} {
  const sessionMs = opts.slotsPerCourtDay * MATCH_MIN * MIN;
  const config: SlotConfig & { courts: string[] } = {
    startAt: T0,
    matchMinutes: MATCH_MIN,
    gapMinutes: 0,
    courts: [...COURTS],
    perEntrantMinRest: 20,
    sessionWindows: Array.from({ length: opts.days }, (_, d) => ({
      from: T0 + d * DAY,
      to: T0 + d * DAY + sessionMs,
    })),
    window: { from: T0, to: T0 + (opts.days - 1) * DAY + sessionMs },
    tz: "UTC",
  };
  const pool = 2 * opts.n;
  const fixtures: SchedulableFixture[] = Array.from(
    { length: opts.n },
    (_, f) => {
      const home = `e${(2 * f) % pool}`;
      const away = `e${(2 * f + 1) % pool}`;
      return {
        id: `f${String(f).padStart(4, "0")}`,
        roundNo: 1,
        home,
        away,
        people: [`p-${home}`, `p-${away}`],
      };
    },
  );
  return { fixtures, config };
}

/**
 * R23's half of this file — "the wall bounds the encode path, not just the
 * search loops" — went with `build-encode.ts` in C8. Every case in it spied on
 * `encodeBuild` to prove a run refused before encoding, and there is no
 * encoder left to refuse to call. Its last case, which asserted `buildSchedule`
 * consults the gate rather than merely exposing it, went the same way for the
 * same reason: the only observable it had was the encode spy.
 *
 * What survives is the gate's own arithmetic, below. Restoring the wiring
 * assertion means spying on the placement client instead — worth doing, and
 * not doable by editing this file alone.
 */

describe("R22 — canSolveWithin is the one place the size gate lives", () => {
  // 90 x 144 = 12_960 fixture-slots, inside the measured knee.
  //
  // THE PINS ARE NOT PRICED HERE, because `canSolveWithin` cannot price them:
  // it runs before any seed exists. They add at most one slot per fixture, so
  // the gate under-prices a rest-chained board by up to `n` — deliberately, and
  // validated by Task 13's sweep at both an on-grid and an off-grid rest rather
  // than by padding every board that needs no padding.
  const inside = board({ n: 90, days: 2, slotsPerCourtDay: 18 });
  // 200 x 216 = 43_200, well outside it.
  const outside = board({ n: 200, days: 3, slotsPerCourtDay: 18 });

  it("admits a board inside the knee and refuses one outside it", () => {
    // Both products asserted, not assumed: the verdicts below mean nothing if
    // the two boards do not actually straddle MAX_SOLVE_ENCODING.
    const inProduct =
      inside.fixtures.length *
      buildGrid({ config: inside.config }).slots.length;
    const outProduct =
      outside.fixtures.length *
      buildGrid({ config: outside.config }).slots.length;
    expect({ inProduct, outProduct, gate: MAX_SOLVE_ENCODING }).toEqual({
      inProduct: 12_960,
      outProduct: 43_200,
      gate: 20_000,
    });

    expect(canSolveWithin(inside.fixtures, inside.config, 8_000)).toBe(true);
    expect(canSolveWithin(outside.fixtures, outside.config, 8_000)).toBe(false);
  });

  it("scales the gate with the wall the caller will actually pass", () => {
    // The 20_000 figure was measured against an 8_000 ms wall, so it is a
    // cost-to-budget RATIO and not a fixed board size. The same board that is
    // refused at 8 s is admitted at 32 s, because 43_200 <= 20_000 x 4.
    //
    // This is the assertion that kills a gate which ignores `wallMs` and
    // compares against the bare constant: that mutant answers `false` here.
    expect(canSolveWithin(outside.fixtures, outside.config, 8_000)).toBe(false);
    expect(canSolveWithin(outside.fixtures, outside.config, 32_000)).toBe(true);
  });

  it("refuses a board with nothing to place, and one whose lattice is over cap", () => {
    expect(canSolveWithin([], inside.config, 8_000)).toBe(false);

    // A 400-day horizon with no session windows: 4 courts x 36 slots a day x
    // 400 days is far past `MAX_SLOTS`, so `buildGrid` returns an EMPTY slot
    // list with `overCap: true`. Without the over-cap arm the product is
    // `n x 0 = 0`, which slips under any threshold and reports `true` for a
    // board `buildSchedule` refuses to solve at all — the gate would then send
    // every caller into a run that returns greedy without searching.
    const wide: SlotConfig & { courts: string[] } = {
      ...inside.config,
      sessionWindows: undefined,
      window: { from: T0, to: T0 + 400 * DAY },
    };
    const grid = buildGrid({ config: wide });
    expect(grid.overCap).toBe(true);
    expect(grid.slots.length).toBe(0);
    expect(canSolveWithin(inside.fixtures, wide, 8_000)).toBe(false);
  });

});
