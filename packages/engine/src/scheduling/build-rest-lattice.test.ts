// The lattice has to be able to hold the board greedy just produced.
//
// `gridStepMinutes` is `max(REPAIR_GRID_MINUTES, gcd(match, gap))` and never
// reads a rest — while `slotFixtures` chains a participant's next start on
// `lastEnd + rest`. On any config whose rest is not a multiple of that gcd the
// seed therefore sits BETWEEN the lattice's slots, and the effect is not "the
// solver does a bit worse": z3 cannot express the incumbent at all, so the first
// tier bound it is handed (`atMost(<the incumbent's own makespan>)`) makes the
// whole model unsat, every later walk comes back unsat on the first ask, all
// four tiers "complete" with nothing found, and the run reports
// `already_optimal` about a board it never searched.
//
// Measured before the fix, on the first end-to-end case below: `engine:
// "greedy"`, `status: "already_optimal"`, `tiersCompleted: 4`, `budgetExpired:
// false`.
//
// THERE ARE TWO WAYS TO FIX THAT, AND THE CHEAP-LOOKING ONE IS THE EXPENSIVE
// ONE. Folding every rest amount into the step makes the seed land on the grid
// by construction — and collapses the step to the five-minute floor on every
// config whose rest is incommensurate with its pitch, which is an ~8x lattice
// for every board in the system. Measured at the 8 s wall, the same bench at
// `--hard-rest=80` (step 40) against `--hard-rest=45` (step 5): slots at
// n=10/80/140 24/168/288 -> 136/1260/2192, last improving size 80 -> 20,
// `canSolveWithin` admitting n<=80 -> n<=20, and three runs of eighteen killed
// outright by an `ast_manager::register_node_core` OOM inside the WASM — which
// in the bench is a row and in production is the request's whole process.
//
// So the seed is made representable by PINNING it (`seedPinsOf` in `build.ts`,
// `seedPins` in `build-grid.ts`): the incumbent's own `(court, startAt)` pairs
// go into the lattice, which costs O(n) extra slots and only on the boards that
// are off-grid at all. The invariant it buys is the one the tier ladder needs —
// THE SOLVER IS NEVER UNABLE TO EXPRESS ITS OWN INCUMBENT.
//
// The last third of this file is the residue. A pin is refused when the slot is
// inadmissible (a blackout, a session edge, an existing booking) and dropped
// when its court is not configured, and a lattice over `MAX_SLOTS` or a universe
// that ends before the run starts holds nothing at all. Those still leave the
// solver unable to search, and the fix there is to say so
// (`status: "not_searched"`) rather than to claim a proof.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSchedule, seedPinsOf, solveBuildForTests, TIER_COUNT, TIER_NAMES } from "./build.ts";
import { buildGrid } from "./build-grid.ts";
// `gridStepMinutes` moved out of `build-grid.ts` into its own module on main
// while this branch was in flight; the rebase conflict here was that move
// crossing Task 06's added `placement-client` import, not a disagreement about
// the step itself.
import { gridStepMinutes } from "./grid-step.ts";
import { boardMetrics } from "./build-objectives.ts";
import { slotFixtures } from "./calendar.ts";
import type { Assignment, SchedulableFixture, SlotConfig } from "./calendar.ts";
import type { SchedulingConstraints } from "./constraints.ts";
// THE shared rest resolver. Imported so the wire assertions below derive their
// expectation from it rather than restating its arithmetic — the second
// implementation is the recurring defect in this subsystem.
import { restFloor } from "./rest-floor.ts";
import type { SolveBuildInput, SolveBuildOutcome } from "./placement-client.ts";

/** The six `(name, value)` rows a FULLY PROVED placement reply carries, in the
 *  ladder's order. Values are placeholders — nothing here reads them — but the
 *  NAMES are load-bearing: `solveBuild` will only call a board
 *  `already_optimal` when the reply's tier names are this exact ladder, so a
 *  stub that claims `tiersCompleted: TIER_COUNT` with no names is claiming a
 *  proof it did not describe. See `TIER_NAMES` for why the count alone is not
 *  enough across two separately deployed apps. */
const provedTiers = (): { name: string; value: number }[] =>
  TIER_NAMES.map((name, i) => ({ name, value: i }));

const okOutcome = (assignments: SolveBuildOutcome["assignments"]): SolveBuildOutcome => ({
  assignments,
  status: "OPTIMAL",
  tiersCompleted: TIER_COUNT,
  objectiveValues: provedTiers(),
  elapsedMs: 5,
  wallExhausted: false,
});

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);

type Cfg = SlotConfig & { courts: string[] };

const cons = (over: Partial<SchedulingConstraints>): SchedulingConstraints => ({
  noBackToBack: false,
  startWindows: [],
  fieldFairness: "off",
  parallelism: "mixed",
  crossPersonClash: "warn",
  ...over,
});

/** Two courts, and a rest that lands OFF the ten-minute lattice.
 *
 *  Measured greedy behaviour: `a` takes C1 at +0; `b` shares E1, so its ready
 *  time is `30 + 35 = +65`, and `slotFixtures` walks courts IN ORDER, so it
 *  stacks both matches on C1. Court imbalance 60, which is exactly what T3
 *  exists to remove, and it can be removed at no cost on any other tier.
 *
 *  +65 is on no 5/10/15-minute lattice anchored at local midnight, so without a
 *  pin the incumbent is inexpressible and every tier bound is unsat on its first
 *  ask. */
const restConfig: Cfg = {
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 10,
  courts: ["C1", "C2"],
  perEntrantMinRest: 35,
  tz: "Europe/London",
  window: { from: T0, to: T0 + 180 * MIN },
};

const restFixtures: SchedulableFixture[] = [
  { id: "a", home: "E1", away: "E2", roundNo: 1 },
  { id: "b", home: "E1", away: "E3", roundNo: 1 },
];

/** The configuration that started all of this, in its purest form: one court,
 *  `match 30 / gap 10 / rest 35`, three cards chained onto one entrant at
 *  +0 / +65 / +130. Two of those three starts are off a ten-minute lattice. */
const chainConfig: Cfg = { ...restConfig, courts: ["C1"] };
const chainFixtures: SchedulableFixture[] = [
  { id: "a", home: "E1", away: "E2", roundNo: 1 },
  { id: "b", home: "E1", away: "E3", roundNo: 1 },
  { id: "c", home: "E1", away: "E4", roundNo: 1 },
];

describe("the step is match and gap only", () => {
  it("does not read a rest, so a rest-chained seed lands between slots", () => {
    // `gcd(30, 10) = 10`, and greedy's second start is at +65. The step is not
    // refined to divide it — the pins below are what make it representable.
    expect(gridStepMinutes(restConfig.matchMinutes, restConfig.gapMinutes)).toBe(10);
    expect(65 % gridStepMinutes(restConfig.matchMinutes, restConfig.gapMinutes)).not.toBe(0);
  });

  it("keeps the coarse step a back-to-back court is entitled to", () => {
    expect(gridStepMinutes(40, 0)).toBe(40);
    expect(gridStepMinutes(60, 15)).toBe(15);
  });
});

describe("seedPinsOf", () => {
  const at = (court: string, min: number): Assignment => ({
    fixtureId: `f${min}`,
    court,
    startAt: T0 + min * MIN,
    endAt: T0 + (min + 30) * MIN,
    entrants: ["E1"],
    people: [],
  });

  it("offers the incumbent's own (court, startAt) pairs, de-duplicated", () => {
    // The third row shares C1+65 with the second — impossible on a legal board,
    // and the count is what the O(n) claim is stated in, so it may not double.
    expect(seedPinsOf([at("C1", 0), at("C1", 65), at("C1", 65), at("C2", 65)], ["C1", "C2"])).toEqual([
      { court: "C1", startAt: T0 },
      { court: "C1", startAt: T0 + 65 * MIN },
      { court: "C2", startAt: T0 + 65 * MIN },
    ]);
  });

  it("drops a row on a court the organiser did not configure", () => {
    // `restrictToConfiguredCourts` would drop the slot again a line later, and
    // buying an unconfigured court a lattice slot is the ghost-pin defect (R20):
    // the slot outlives the card that justified it and takes a real fixture.
    //
    // UNREACHABLE THROUGH `buildSchedule` TODAY, and deliberately still here:
    // `slotFixtures` iterates `config.courts` alone (`calendar.ts:734`), so the
    // seed cannot name another court, while `buildGrid` takes its court list
    // from `repairCourts`, which folds in every court an `existing` row uses.
    // The day those two converge, this is the guard that keeps the pins honest.
    expect(seedPinsOf([at("C1", 0), at("C9", 65)], ["C1"])).toEqual([{ court: "C1", startAt: T0 }]);
  });
});

describe("the lattice holds the seed", () => {
  it("carries every chained start, at one extra slot per off-grid row", () => {
    const seed = slotFixtures({ fixtures: chainFixtures, config: chainConfig });
    // The premise: +0 / +65 / +130, two of them off a ten-minute lattice.
    expect(seed.assignments.map((a) => (a.startAt - T0) / MIN)).toEqual([0, 65, 130]);

    const bare = buildGrid({ config: chainConfig });
    const pins = seedPinsOf(seed.assignments, chainConfig.courts);
    const pinned = buildGrid({ config: chainConfig, seedPins: pins });

    // THE INVARIANT. Every seed row is expressible, which is the whole content
    // of the fix — the tier ladder's first bound is the incumbent's own metric,
    // and a lattice that cannot hold the incumbent refutes nothing.
    const keys = new Set(pinned.slots.map((s) => `${s.court}|${s.startAt}`));
    expect(seed.assignments.filter((a) => !keys.has(`${a.court}|${a.startAt}`))).toEqual([]);
    expect(bare.slots.some((s) => s.startAt === T0 + 65 * MIN)).toBe(false);

    // AND THE COST, stated as arithmetic rather than "O(n)". A 180-minute window
    // at a ten-minute step holds 16 starts (0…150, the last match ending at the
    // edge); +130 is already one of them and only +65 is new. The step-refining
    // alternative divides the step by 8 and multiplies EVERY board's lattice to
    // match, whether or not it is off-grid.
    expect({ bare: bare.slots.length, pinned: pinned.slots.length, pins: pins.length }).toEqual({
      bare: 16,
      pinned: 17,
      pins: 3,
    });
  });

  it("refuses a seed pin the lattice would refuse anyway", () => {
    // ALIGNMENT is what a seed pin bypasses; LEGALITY is not. Greedy never
    // produces such a row — it reads the same blackouts — but `buildGrid` is
    // handed the pins by a caller, and an admitted-unconditionally slot inside a
    // blackout is a slot ANY fixture may then be placed in.
    const config: Cfg = {
      ...chainConfig,
      blackouts: [{ from: T0 + 60 * MIN, to: T0 + 90 * MIN }],
    };
    const inside = { court: "C1", startAt: T0 + 65 * MIN };
    const outside = { court: "C1", startAt: T0 + 125 * MIN };
    const g = buildGrid({ config, seedPins: [inside, outside] });
    const has = (s: { court: string; startAt: number }): boolean =>
      g.slots.some((x) => x.court === s.court && x.startAt === s.startAt);
    expect({ inside: has(inside), outside: has(outside) }).toEqual({ inside: false, outside: true });
  });
});

// --- end to end -------------------------------------------------------------

describe("a rest-configured board is actually searched", () => {
  // UN-SKIPPED (fix round 1), all three: each now mocks the file's own
  // documented board directly. `seedPinsOf`/`pinned` are NOT part of the
  // grid `solveBuild` sends to placement any more (see build.ts's comment on
  // that removal) — placement does not need the incumbent representable in its
  // own lattice the way z3's incremental bound-walk did, and `build.ts`
  // never validates that a returned position is "on grid" either, so a
  // mocked off-grid reply (chained rest positions like +65/+130 are on no
  // 10-minute lattice) is processed identically to an on-grid one. What
  // these cases verify — does `solveBuild` correctly turn a returned board
  // into the right `BuildResult` — does not depend on the mechanism that
  // used to make such a board SEARCHABLE for z3.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("greedy stacks both cards on one court, off the lattice", () => {
    // The premise, pinned so a change in `slotFixtures` cannot quietly make the
    // case below vacuous by handing z3 a board it has nothing to improve.
    const seed = slotFixtures({ fixtures: restFixtures, config: restConfig });
    expect(seed.assignments.map((a) => [a.fixtureId, a.court, a.startAt - T0])).toEqual([
      ["a", "C1", 0],
      ["b", "C1", 65 * MIN],
    ]);
    expect(boardMetrics(seed.assignments, restConfig.courts, 2).courtImbalanceMinutes).toBe(60);
  });

  it("z3 balances the courts instead of calling the seed optimal", async () => {
    // Note WHICH card moves in the mock: `a` to C2 at +0, `b` keeps the
    // seed's own +65 on C1 — the file's own documented board.
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue(
      okOutcome([
        { fixtureId: "a", court: "C2", startAtMs: T0 },
        { fixtureId: "b", court: "C1", startAtMs: T0 + 65 * MIN },
      ]),
    );
    const out = await buildSchedule({ fixtures: restFixtures, config: restConfig });
    // The board, not the provenance: a run that finds nothing better
    // legitimately reports `engine: "greedy"`. This is a strictly better
    // board on D3's third tier, at no cost on the two above it.
    expect(out.metrics.courtImbalanceMinutes).toBe(0);
    expect(out.metrics.placed).toBe(2);
    expect(out.metrics.makespanMinutes).toBe(95);
    expect(new Set(out.assignments.map((a) => a.court))).toEqual(new Set(["C1", "C2"]));
    // `rlimitSpent` is gone with z3 — `solveBuild` always reports 0 now (see
    // its final `return`), so this is no longer a meaningful witness that a
    // search happened; `engine: "optimized"` and `tiersCompleted` are.
    expect(out.engine).toBe("optimized");
    expect(out.status).toBe("ok");
    expect(out.tiersCompleted).toBe(TIER_COUNT);
  }, 120_000);

  it("proves the chained board optimal instead of never searching it", async () => {
    // ONE COURT, so there is nothing to rebalance — mocked here as EXACTLY
    // the chained board greedy already reaches (+0/+65/+130), which is what
    // makes the honest verdict `already_optimal` rather than `ok`: the
    // reply ties the seed, not beats it.
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue(
      okOutcome([
        { fixtureId: "a", court: "C1", startAtMs: T0 },
        { fixtureId: "b", court: "C1", startAtMs: T0 + 65 * MIN },
        { fixtureId: "c", court: "C1", startAtMs: T0 + 130 * MIN },
      ]),
    );
    const out = await buildSchedule({ fixtures: chainFixtures, config: chainConfig });
    expect({ status: out.status, tiers: out.tiersCompleted, placed: out.metrics.placed }).toEqual({
      status: "already_optimal",
      tiers: TIER_COUNT,
      placed: 3,
    });
    expect(out.assignments.map((a) => (a.startAt - T0) / MIN)).toEqual([0, 65, 130]);
  }, 120_000);

  it("searches a board held to an absolute anchor no step could divide", async () => {
    // The residue a gcd was never going to reach, and the clearest case for
    // pinning over refining: `startWindows.notBefore` at +7 is not a duration,
    // so no step over match/gap/rest divides it. Greedy starts the card at
    // exactly its anchor; the window then closes at +37, one match later, so the
    // LATEST start the ten-minute lattice offers is +0 and z3 has nowhere legal
    // to put the card at all.
    //
    // That is the vacuous ladder in its purest form — and the pin dissolves it:
    // +7 is in the lattice, `placed >= 1` is satisfiable, and the four tiers
    // that complete have refuted a region that contains the board.
    const config: Cfg = {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 10,
      courts: ["C1"],
      perEntrantMinRest: 35,
      tz: "Europe/London",
      window: { from: T0, to: T0 + 37 * MIN },
      constraints: cons({
        startWindows: [{ target: { kind: "entrant", id: "E1" }, notBefore: T0 + 7 * MIN }],
      }),
    };
    const fixtures: SchedulableFixture[] = [{ id: "a", home: "E1", away: "E2", roundNo: 1 }];
    const seed = slotFixtures({ fixtures, config });
    expect(seed.assignments[0]?.startAt).toBe(T0 + 7 * MIN);
    // The premise, pinned rather than assumed: the BARE lattice cannot reach the
    // anchor, so this case is about the pin and nothing else.
    const bare = buildGrid({ config }).slots;
    expect({ n: bare.length, reachable: bare.filter((s) => s.startAt >= T0 + 7 * MIN).length }).toEqual({
      n: 1,
      reachable: 0,
    });

    // Mocked as EXACTLY greedy's own +7 anchor — the tie is the point (see
    // the block comment above): placement neither validates nor needs the
    // returned position to be "on grid" the way z3's own lattice did.
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue(
      okOutcome([{ fixtureId: "a", court: "C1", startAtMs: T0 + 7 * MIN }]),
    );
    const out = await buildSchedule({ fixtures, config });
    expect({ status: out.status, tiers: out.tiersCompleted }).toEqual({
      status: "already_optimal",
      tiers: TIER_COUNT,
    });
    expect(out.assignments).toEqual(seed.assignments);
  }, 120_000);
});

// --- what pinning does NOT rescue -------------------------------------------

describe("a board the lattice cannot hold is never called optimal", () => {
  /** Over `MAX_SLOTS` the lattice is returned EMPTY, so it holds nothing at
   *  all — and no pin can help, because there is nothing to pin them into. That
   *  exit used to return `ok`, which reads as a searched board. */
  it("reports not_searched when the lattice is over the size cap", async () => {
    const config: Cfg = {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 10,
      courts: ["C1"],
      perEntrantMinRest: 35,
      tz: "Europe/London",
      // 200 days at a ten-minute step is >20 000 starts on one court.
      window: { from: T0, to: T0 + 200 * 24 * 60 * MIN },
    };
    const fixtures: SchedulableFixture[] = [{ id: "a", home: "E1", away: "E2", roundNo: 1 }];
    expect(buildGrid({ config }).overCap).toBe(true);
    const out = await buildSchedule({ fixtures, config });
    expect(out.status).toBe("not_searched");
    expect(out.engine).toBe("greedy");
    expect(out.assignments).toHaveLength(1);
    // `too_big`, NOT `lattice_unusable` — measured, not assumed. `canSolveWithin`
    // (the R22 gate `buildSchedule` calls before `solveBuild` ever runs) opens
    // with this SAME `grid.overCap || grid.slots.length === 0` test on the SAME
    // (config, existing), so it already answers `false` here and reports
    // `too_big` before `solveBuild`'s own copy of the check is ever reached. See
    // the `solveBuildForTests` test below for that copy, proved directly.
    expect(out.notSearchedReason).toBe("too_big");
  }, 120_000);

  // THE SHADOWED EXIT, proved directly. `canSolveWithin` refuses every board
  // that would trip this check before `buildSchedule` ever calls `solveBuild`
  // (see the assertion above and `solveBuildForTests`'s doc comment) — so this
  // is the one `not_searched` reason with no input that reaches it through the
  // public `buildSchedule` entry point. Calling the un-gated alias directly is
  // what makes it observable at all.
  it("solveBuild's own lattice_unusable exit reports itself correctly, once reached", async () => {
    const config: Cfg = {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 10,
      courts: ["C1"],
      perEntrantMinRest: 35,
      tz: "Europe/London",
      window: { from: T0, to: T0 + 200 * 24 * 60 * MIN },
    };
    const fixtures: SchedulableFixture[] = [{ id: "a", home: "E1", away: "E2", roundNo: 1 }];
    expect(buildGrid({ config }).overCap).toBe(true);
    const out = await solveBuildForTests({ fixtures, config });
    expect(out.status).toBe("not_searched");
    expect(out.notSearchedReason).toBe("lattice_unusable");
    expect(out.engine).toBe("greedy");
    expect(out.assignments).toHaveLength(1);
  }, 120_000);

  /**
   * THE UNIVERSE, which is a separate exit and used to answer `ok`.
   *
   * A competition window edited to end before the run's own `startAt` — an
   * organiser dragging the end date back over a board they have already begun.
   * `repairUniverse` hands the window back verbatim, so `startAt >= universe.to`
   * and the run leaves before the lattice, before the WASM boot and before the
   * gate. `ok` documents itself as "a board was produced and the gate accepted
   * it" and NEITHER half of that happened; `budgetExpired: false` on the way out
   * says, correctly, that no budget was consumed, which leaves nothing at all in
   * the result telling the caller a solver was never consulted.
   */
  it("reports not_searched when the window ends before the run starts", async () => {
    const DAY = 24 * 60 * MIN;
    const config: Cfg = {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 10,
      courts: ["C1"],
      perEntrantMinRest: 0,
      tz: "Europe/London",
      window: { from: T0 - 3 * DAY, to: T0 - DAY },
    };
    const fixtures: SchedulableFixture[] = [{ id: "a", home: "E1", away: "E2", roundNo: 1 }];
    // Not the over-cap exit above: this config asks for a small, perfectly
    // buildable lattice. The run leaves before it is ever consulted.
    const grid = buildGrid({ config });
    expect({ overCap: grid.overCap, empty: grid.slots.length === 0 }).toEqual({
      overCap: false,
      empty: false,
    });

    const out = await buildSchedule({ fixtures, config });
    expect({
      status: out.status,
      reason: out.notSearchedReason,
      engine: out.engine,
      expired: out.budgetExpired,
      tiers: out.tiersCompleted,
      spent: out.rlimitSpent,
    }).toEqual({
      status: "not_searched",
      reason: "window_empty",
      engine: "greedy",
      expired: false,
      tiers: 0,
      spent: 0,
    });
  }, 120_000);
});

// --- per-court asymmetry (Obligation 5 closed by task C2) -------------------

describe("a board split across mismatched court grids now reaches the solver", () => {
  /**
   * `Blackout.court?` scoped to ONE of several configured courts is ordinary
   * org data (a single-court closure for maintenance, a court double-booked
   * outside this system), not a synthetic edge case — reachable from the
   * ordinary settings UI. It leaves that court's set of offered start times a
   * strict subset of its neighbours'.
   *
   * Until task C2 this used to be refused here (`everyCourtSharesGrid`,
   * routing to `not_searched`/`per_court_grid` before `solveBuild` was ever
   * called) because placement had no way to express a per-court grid.
   * `placement.model.build_model` now enforces each court's own tick set
   * directly (a per-fixture domain restriction, court by court — see that
   * module's docstring, "per-court grids"), so the request reaches the
   * solver like any other board. This test is the inverse of the one it
   * replaces: it proves the solver is CALLED, not that the request is
   * refused.
   */
  it("calls placement instead of refusing when one court is blacked out and its siblings are not", async () => {
    const config: Cfg = {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 10,
      courts: ["C1", "C2"],
      perEntrantMinRest: 0,
      tz: "Europe/London",
      window: { from: T0, to: T0 + 180 * MIN },
      // C1 alone loses its middle hour; C2's slots are untouched, so the two
      // courts' start-time sets differ in both size and membership.
      blackouts: [{ court: "C1", from: T0 + 60 * MIN, to: T0 + 120 * MIN }],
    };
    const fixtures: SchedulableFixture[] = [{ id: "a", home: "E1", away: "E2", roundNo: 1 }];

    // Pinned preconditions: neither court is starved, and the two sets really
    // do disagree — without this, a passing result below could just as easily
    // mean the blackout emptied C1 outright (a DIFFERENT exit) or matched C2 by
    // coincidence.
    const grid = buildGrid({ config });
    expect(grid.overCap).toBe(false);
    const c1Starts = new Set((grid.byCourt.get("C1") ?? []).map((i) => grid.slots[i]!.startAt));
    const c2Starts = new Set((grid.byCourt.get("C2") ?? []).map((i) => grid.slots[i]!.startAt));
    expect(c1Starts.size).toBeGreaterThan(0);
    expect(c2Starts.size).toBeGreaterThan(c1Starts.size);

    const solveBuildSpy = vi
      .spyOn(await import("./placement-client.ts"), "solveBuild")
      .mockResolvedValue(okOutcome([{ fixtureId: "a", court: "C1", startAtMs: T0 }]));

    const out = await buildSchedule({ fixtures, config });

    // THE REGRESSION THIS TEST GUARDS: the request reached the solver at
    // all. Before C2, `everyCourtSharesGrid` refused this exact grid before
    // ever calling `solveBuild` — the mock above would sit uncalled and
    // `out.status`/`out.notSearchedReason` would be `"not_searched"` /
    // `"per_court_grid"` instead of what is asserted below.
    expect(solveBuildSpy).toHaveBeenCalledOnce();
    expect(out.status).not.toBe("not_searched");
    expect(out.notSearchedReason).toBeUndefined();
    expect(out.assignments).toHaveLength(1);

    // And the grid `solveBuild` was actually asked to search reflects the
    // real asymmetry: C1's blacked-out hour is genuinely missing from what
    // was sent, not silently padded back to match C2.
    const sentInput = solveBuildSpy.mock.calls[0]![0];
    const sentC1 = sentInput.grid.slots.filter((s) => s.court === "C1").length;
    const sentC2 = sentInput.grid.slots.filter((s) => s.court === "C2").length;
    expect(sentC1).toBeLessThan(sentC2);
  }, 120_000);
});

// --- the wire carries the RESOLVED floor, not `perEntrantMinRest` ------------
//
// Task 7. The third side of the fork, found by driving the product: Settings
// "Minimum rest per entrant" 30 + Constraints "Minimum rest" 35 produced
// "Optimised … SCHEDULED 15/15" and 32 `rest` conflicts in the same breath.
// The greedy placer resolves rest through `effectiveRestMinutes` and the
// verifier through `pairRestMinutesWith` — both of which are `restFloor`, a MAX
// over the four configurable sources (#459, owner ruling 2026-08-04) — while
// `restByDivisionForWire` in `build.ts` read `config.perEntrantMinRest` RAW.
// The solver was told 30, produced 30, and the verifier measured against 35.
//
// `build.ts`'s own docstring on that block records this exact class of defect
// shipping once already (`already_optimal` on a rest-violating board) and being
// closed for `perEntrantMinRest` ALONE; `restMin`, `restByGroup` and
// `noBackToBack` were never added to the same fold. These cases close it for
// every source at once by deriving the expectation from `restFloor` itself, so
// a fifth source moves the tests with the resolver instead of leaving them
// asserting yesterday's arithmetic.
describe("the CP-SAT wire payload uses the shared rest resolver", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The reproduction config: the two organiser-facing controls disagree, and
   *  the WRONG answer (30) is a different number from the RIGHT one (35), so a
   *  test that accidentally reads `perEntrantMinRest` cannot pass by
   *  coincidence. `gapMinutes: 0` keeps the chained start arithmetic below to
   *  `match + rest` with nothing else in it. */
  const forkedCfg = (over: Partial<SchedulingConstraints> = {}): Cfg => ({
    startAt: T0,
    matchMinutes: 30,
    gapMinutes: 0,
    courts: ["C1"],
    perEntrantMinRest: 30,
    tz: "Europe/London",
    window: { from: T0, to: T0 + 600 * MIN },
    constraints: cons({ restMin: 35, ...over }),
  });

  /** Two cards on ONE entrant, so rest is the only thing separating them. */
  const chained = (divisionId?: string): SchedulableFixture[] => [
    { id: "a", home: "E1", away: "E2", roundNo: 1, ...(divisionId !== undefined ? { divisionId } : {}) },
    { id: "b", home: "E1", away: "E3", roundNo: 1, ...(divisionId !== undefined ? { divisionId } : {}) },
  ];

  const captureWire = async (): Promise<{ read: () => SolveBuildInput }> => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome([{ fixtureId: "a", court: "C1", startAtMs: T0 }]);
    });
    return {
      read: (): SolveBuildInput => {
        expect(captured).toBeDefined();
        return captured!;
      },
    };
  };

  /** The `minRestMinutes` the wire actually carries for a fixture — the MAX
   *  over every `ruleGroup` that names it, which is how a pinned row's own rest
   *  is resolved on the far side. */
  const wireRestFor = (input: SolveBuildInput, fixtureId: string): number =>
    Math.max(
      0,
      ...(input.ruleGroups ?? [])
        .filter((g) => g.fixtureIds.includes(fixtureId))
        .map((g) => g.minRestMinutes ?? 0),
    );

  it("sends MAX(perEntrantMinRest, restMin), not perEntrantMinRest", async () => {
    const config = forkedCfg();
    const fixtures = chained("D1");
    // Derived from the resolver, never typed in: a change to `rest-floor.ts`
    // moves this expectation with it.
    const expected = restFloor(config, { divisionId: "D1" }).minutes;
    // THE DIFFERENTIAL. Without this the case is satisfied by the bug's own
    // constant and witnesses nothing (failure class 19).
    expect(expected).not.toBe(config.perEntrantMinRest);
    expect({ expected, raw: config.perEntrantMinRest }).toEqual({ expected: 35, raw: 30 });

    const wire = await captureWire();
    await buildSchedule({ fixtures, config });
    expect(wireRestFor(wire.read(), "b")).toBe(expected);
  }, 120_000);

  it("keeps the Settings floor when it is the stricter of the two", async () => {
    // The other direction of the MAX. A fix that merely swapped one raw read
    // for the other would pass the case above and fail here.
    const config: Cfg = { ...forkedCfg({ restMin: 20 }), perEntrantMinRest: 45 };
    const expected = restFloor(config, { divisionId: "D1" }).minutes;
    expect(expected).toBe(45);

    const wire = await captureWire();
    await buildSchedule({ fixtures: chained("D1"), config });
    expect(wireRestFor(wire.read(), "b")).toBe(expected);
  }, 120_000);

  it("carries noBackToBack's derived floor, which no raw field holds at all", async () => {
    // `matchMinutes + gapMinutes` is not stored anywhere — it is computed by
    // the resolver — so this source can only reach the wire through it.
    const config: Cfg = { ...forkedCfg({ restMin: 0, noBackToBack: true }), gapMinutes: 10 };
    const expected = restFloor(config, { divisionId: "D1" }).minutes;
    expect(expected).toBe(config.matchMinutes + config.gapMinutes);
    expect(expected).toBeGreaterThan(config.perEntrantMinRest);

    const wire = await captureWire();
    await buildSchedule({ fixtures: chained("D1"), config });
    expect(wireRestFor(wire.read(), "b")).toBe(expected);
  }, 120_000);

  it("resolves a division-keyed restByGroup per division rather than collapsing the board to one number", async () => {
    // `restByDivisionForWire` is a per-division map, so a DIVISION-keyed
    // `restByGroup` entry is expressible exactly. Two divisions with different
    // answers is what proves it is not folded down to a single board-wide max:
    // a collapse would give D2 the same 50 as D1.
    const config = forkedCfg({ restByGroup: { D1: 50 } });
    const fixtures: SchedulableFixture[] = [
      { id: "a", home: "E1", away: "E2", roundNo: 1, divisionId: "D1" },
      { id: "b", home: "E1", away: "E3", roundNo: 1, divisionId: "D1" },
      { id: "c", home: "E4", away: "E5", roundNo: 1, divisionId: "D2" },
    ];
    const d1 = restFloor(config, { divisionId: "D1" }).minutes;
    const d2 = restFloor(config, { divisionId: "D2" }).minutes;
    expect({ d1, d2 }).toEqual({ d1: 50, d2: 35 });

    const wire = await captureWire();
    await buildSchedule({ fixtures, config });
    const sent = wire.read();
    expect({ b: wireRestFor(sent, "b"), c: wireRestFor(sent, "c") }).toEqual({ b: d1, c: d2 });
  }, 120_000);

  // THE ONE THAT ACTUALLY PROVES IT. Three sides have to agree — the lattice,
  // the greedy placer and the verifier — and unit tests on each side
  // individually were all green while this defect was live. So the stub solver
  // below reads NOTHING but the wire payload and chains the second card at
  // exactly the floor the payload claims; the REAL verifier inside
  // `buildSchedule` then judges the board it produced. A wire that says 30
  // where the verifier demands 35 reproduces the organiser's screen in-process:
  // a board the solver considers finished, carrying `rest` conflicts.
  it("produces a board with no rest conflict when restMin outranks perEntrantMinRest", async () => {
    const config = forkedCfg();
    const fixtures = chained("D1");
    const owed = restFloor(config, { divisionId: "D1" }).minutes;
    expect(owed).not.toBe(config.perEntrantMinRest);

    let wireRest: number | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      // A solver that honours precisely what it was told, and nothing else.
      // `Math.max(0, ...[])` is 0, so a payload carrying no rest group at all
      // stacks the two cards back to back — the loudest possible failure.
      wireRest = wireRestFor(input, "b");
      return okOutcome([
        { fixtureId: "a", court: "C1", startAtMs: T0 },
        { fixtureId: "b", court: "C1", startAtMs: T0 + (config.matchMinutes + wireRest) * MIN },
      ]);
    });

    const out = await buildSchedule({ fixtures, config });

    // THE ORGANISER-VISIBLE CLAIM, asserted FIRST so a regression reports the
    // defect the way the toolbar does rather than an internal precondition.
    expect(out.conflicts.filter((c) => c.reason === "rest")).toEqual([]);
    // And the VALUE, not merely the absence of a complaint (failure class 19):
    // the shipped board separates the two cards by exactly what is owed.
    const byId = new Map(out.assignments.map((a) => [a.fixtureId, a]));
    const gapMinutes = (byId.get("b")!.startAt - byId.get("a")!.endAt) / MIN;
    expect(gapMinutes).toBe(owed);
    // Non-vacuity: the stub really was reached, and really did read the wire.
    expect(wireRest).toBe(owed);
  }, 120_000);
});
