// The build solver's control loop.
//
// The tests here were written against MEASURED greedy behaviour, because
// several of the obvious premises turn out to be false:
//
//   * `slotFixtures` does NOT respect `config.window` — it scans forward for
//     `horizonMinutes` (default 365 days) and will happily place a card outside
//     the competition's own calendar window without a single conflict, while
//     `repairUniverse` bounds z3's lattice to that same window. So "greedy
//     cannot fit these in the window" is not a way to make greedy report
//     `no_slot`; only `sessionWindows`, `blackouts` and the typed rules bound
//     it. Every corner case below is built out of those.
//   * "the solver never returns a board worse than greedy" is NOT
//     `placed >= placed && makespan <= makespan`. D3 is LEXICOGRAPHIC with
//     `placed` on top, so a board that places one more card at a longer
//     makespan is strictly better and that conjunction would refuse it. The
//     contract is `isStrictlyBetter(floor, built) === false`, and that is what
//     is asserted.
//   * the floor is not greedy's board, it is greedy's LEGAL board. Counting a
//     card that carries a blocking conflict as "placed" is what let an illegal
//     greedy board outrank every legal one D3 could reach.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SOLVER_QUEUE,
  TIER_COUNT, TIER_NAMES,
  buildSchedule,
  rejectedBlockingConflicts,
  type BuildInput,
} from "./build.ts";
import { boardMetrics, isStrictlyBetter } from "./build-objectives.ts";
import { buildGrid } from "./build-grid.ts";
import {
  isBlockingConflict,
  scopeCoversFixture,
  slotFixtures,
  validateAssignments,
  type Assignment,
  type Conflict,
  type SchedulableFixture,
  type ScopeRow,
  type SlotConfig,
} from "./calendar.ts";
import { ConstraintScope } from "./constraints.ts";
import type { HardConstraint, SchedulingConstraints } from "./constraints.ts";
import { dayKeyInTz } from "./tz.ts";
import type { SolveBuildInput, SolveBuildOutcome } from "./placement-client.ts";
// Bound at file-load time, same as `buildSchedule` above — so it is the SAME
// `./logger.ts` instance `build.ts`'s own internal `import { log }` resolved
// to, for every test that calls the plain statically-imported `buildSchedule`.
// Tests that instead re-import `./build.ts` dynamically after
// `vi.resetModules()` (to see a `vi.doMock`'d dependency — see that test's own
// comment) must NOT use this binding: the reset gives their fresh `build.ts` a
// fresh `./logger.ts` too, and a spy on this stale object would watch
// something that run never touches. Those tests re-import `./logger.ts`
// dynamically, alongside their fresh `./build.ts`, instead.
import { log } from "./logger.ts";

/** The six `(name, value)` rows a FULLY PROVED placement reply carries, in the
 *  ladder's order. Values are placeholders — nothing here reads them — but the
 *  NAMES are load-bearing: `solveBuild` will only call a board
 *  `already_optimal` when the reply's tier names are this exact ladder, so a
 *  stub that claims `tiersCompleted: TIER_COUNT` with no names is claiming a
 *  proof it did not describe. See `TIER_NAMES` for why the count alone is not
 *  enough across two separately deployed apps. */
const provedTiers = (): { name: string; value: number }[] =>
  TIER_NAMES.map((name, i) => ({ name, value: i }));

/** Did `p` settle inside `ms`? Used to assert a promise is STILL PENDING, which
 *  no matcher expresses. The window is not a threshold and not a claim about
 *  this machine: the only case that uses it holds the placement client open, so
 *  a pending promise cannot settle at any size of window, and a settled one has
 *  already settled before the timer is even armed. The timer is `unref`'d so a
 *  pending case cannot hold the worker open past the test. */
const settledWithin = (p: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), ms).unref?.();
    }),
  ]);


const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);

type Cfg = SlotConfig & { courts: string[] };

const cfg = (over: Partial<SlotConfig> & { courts?: string[] } = {}): Cfg => ({
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["C1"],
  perEntrantMinRest: 0,
  tz: "Europe/London",
  // A window on EVERY case, deliberately. `buildGrid` takes its universe from
  // `repairUniverse`, which with no window, no session windows and no existing
  // board falls back to the first day of the unix epoch — a lattice 56 years
  // away from the fixtures. `buildSchedule` refuses to solve over one (see
  // "declines to solve a lattice that cannot reach the fixtures"), so a case
  // that forgot its window would silently test greedy and read as covered.
  window: { from: T0, to: T0 + 180 * MIN },
  ...over,
});

/** `SchedulingConstraints` defaults five fields and a zod default is REQUIRED in
 *  the inferred type, so the bare literal every reader wants to write does not
 *  typecheck. Same helper as the parity suite. */
const cons = (over: Partial<SchedulingConstraints>): SchedulingConstraints => ({
  noBackToBack: false,
  startWindows: [],
  fieldFairness: "off",
  parallelism: "mixed",
  crossPersonClash: "warn",
  ...over,
});

const fx = (
  id: string,
  home: string,
  away: string,
  over: Partial<SchedulableFixture> = {},
): SchedulableFixture => ({ id, home, away, roundNo: 1, ...over });

/**
 * THE corner case: two slots, two fixtures, and a start window that only one
 * fixture can use.
 *
 * `b`'s entrant E3 may not start after T0, so `b` fits the 09:00 slot and
 * nothing else. Greedy walks fixtures in (roundNo, id) order, takes 09:00 for
 * `a` because nothing stops it, and then has no legal slot left for `b` — it
 * reports `start_window` and hands back a one-card board. The assignment is a
 * two-slot bipartite matching whose only perfect matching is the one greedy's
 * ordering excludes, so a solver that looks at both cards at once places both.
 * Measured, not assumed: greedy gives `[a@C1+0]`, z3 gives `[b@C1+0, a@C1+30]`.
 */
const cornerConfig = cfg({
  sessionWindows: [{ from: T0, to: T0 + 60 * MIN }],
  constraints: cons({ startWindows: [{ target: { kind: "entrant", id: "E3" }, notAfter: T0 }] }),
});
const cornerFixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4")];

/** Two slots, three fixtures. Nobody can place all three; the point of the case
 *  is that z3 PROVES it where greedy only ran out of ideas. */
const overSubscribedConfig = cfg({ sessionWindows: [{ from: T0, to: T0 + 60 * MIN }] });
const overSubscribedFixtures = [fx("a", "E1", "E2"), fx("b", "E1", "E3"), fx("c", "E4", "E5")];

/** A competition that overruns its own window: three 30-minute matches, a
 *  60-minute window, one court. Greedy places all three because it never reads
 *  `config.window`; the third sits entirely outside it and the verifier calls
 *  that BLOCKING. z3's lattice stops at the window, so it can only ever place
 *  two — and under a naive `placed`-first comparison greedy's illegal board
 *  wins forever. */
const overrunConfig = cfg({ window: { from: T0, to: T0 + 60 * MIN } });
const overrunFixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4"), fx("c", "E5", "E6")];

const rawSeedOf = (input: BuildInput) =>
  slotFixtures({ fixtures: input.fixtures, config: input.config, existing: input.existing });

/** Greedy's LEGAL board — the floor the solver is actually held to. A row
 *  carrying a blocking conflict was never legally placed, so counting it would
 *  hold the solver to a board nobody may publish. */
const legalSeedOf = (input: BuildInput): Assignment[] => {
  const raw = rawSeedOf(input);
  const bad = new Set(
    validateAssignments(raw.assignments, input.config, input.existing)
      .filter(isBlockingConflict)
      .map((c) => c.fixtureId),
  );
  return raw.assignments.filter((a) => !bad.has(a.fixtureId));
};

describe("buildSchedule", () => {

  // `isolate: false` (vitest.config.ts) shares module state across the whole
  // file, and this repo has no global `restoreMocks`/`clearMocks` — a
  // `vi.spyOn` left standing from one `it` here is still active in the
  // next, and in every later describe block in this file. Every case below
  // that mocks `placement-client.ts` relies on this to not leak into its
  // neighbours.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never returns a board the greedy floor beats", async () => {
    // The floor property, and the SOLE reason design D6 ships with no escape
    // hatch back to greedy. Asserted with `isStrictlyBetter` rather than a
    // hand-written conjunction so the test and the solver's own accept
    // condition are the same function — a test that re-derived D3's ordering
    // could disagree with the code it is guarding.
    //
    // CURRENTLY VACUOUS ON THE PLACEMENT PATH, and worth saying so rather than
    // leaving a green name to imply otherwise: placement is unreachable from
    // this test environment, so every case here falls back to greedy and
    // compares the floor against itself — always false, regardless of
    // whether the D6 gate that makes this true in production actually
    // fires. The gate itself IS covered, deterministically, by
    // `describe("buildSchedule — Placement path", ...)`'s "falls back to the
    // greedy floor when placement's own board is not strictly better (D6)",
    // which mocks a worse placement reply and asserts the seed ships instead.
    const cases: BuildInput[] = [
      { fixtures: cornerFixtures, config: cornerConfig },
      { fixtures: overSubscribedFixtures, config: overSubscribedConfig },
      { fixtures: overrunFixtures, config: overrunConfig },
      {
        fixtures: [fx("a", "E1", "E2"), fx("b", "E3", "E4"), fx("c", "E5", "E6")],
        config: cfg({ courts: ["C1", "C2"] }),
      },
      {
        fixtures: [fx("a", "E1", "E2"), fx("b", "E1", "E3"), fx("c", "E2", "E3")],
        config: cfg({ courts: ["C1", "C2"], perEntrantMinRest: 45 }),
      },
    ];
    for (const input of cases) {
      const floor = boardMetrics(legalSeedOf(input), input.config.courts, input.fixtures.length);
      const built = await buildSchedule(input);
      expect(isStrictlyBetter(floor, built.metrics)).toBe(false);
      expect(built.metrics.placed).toBeGreaterThanOrEqual(floor.placed);
    }
  }, 180_000);

  // UN-SKIPPED (fix round 1): mocked at the grid's own ceiling — `window`
  // bounds the GRID itself (`buildGrid` reads `config.window`), so no
  // engine, real or mocked, can offer a 3rd slot here. placement is therefore
  // capped at the same 2-placed greedy already reaches, which is what makes
  // this `already_optimal` via the D6 floor rather than a `placement`
  // improvement — the mock exists to prove `tiersCompleted`/`status` reflect
  // a real (tied) proof, not "never asked".
  it("drops a card greedy placed OUTSIDE the window, and keeps the legal board", async () => {
    // R2. Greedy places all three; the third overruns the competition window,
    // which `isBlockingConflict` calls physically impossible. Counting it as
    // `placed` is what made the illegal board outrank every legal one, so the
    // seed is legalised before it is measured. The board handed back is then
    // one the verifier accepts outright, and the dropped card is reported with
    // the conflict that ACTUALLY disqualified it — not a fabricated `no_slot`.
    const raw = rawSeedOf({ fixtures: overrunFixtures, config: overrunConfig });
    expect(raw.assignments).toHaveLength(3);
    expect(raw.conflicts).toEqual([]);

    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [
        { fixtureId: "a", court: "C1", startAtMs: T0 },
        { fixtureId: "b", court: "C1", startAtMs: T0 + 30 * MIN },
      ],
      status: "OPTIMAL",
      tiersCompleted: TIER_COUNT,
      objectiveValues: provedTiers(),
      elapsedMs: 5,
      wallExhausted: false,
    });
    const built = await buildSchedule({ fixtures: overrunFixtures, config: overrunConfig });
    expect(validateAssignments(built.assignments, overrunConfig)).toEqual([]);
    expect(built.metrics.placed).toBe(2);
    expect(built.status).toBe("already_optimal");
    const dropped = built.conflicts.filter((c) => c.fixtureId === "c");
    expect(dropped.map((c) => c.reason)).toEqual(["window"]);
  }, 180_000);

  // UN-SKIPPED (fix round 1): the file's own MEASURED z3 shape
  // (`[b@C1+0, a@C1+30]`, see the file header) mocked directly — 2 placed
  // strictly beats greedy's 1, so D6 accepts it and `engine` becomes
  // `"optimized"`, not `"z3"`.
  it("places a card greedy declared unplaceable", async () => {
    const seed = rawSeedOf({ fixtures: cornerFixtures, config: cornerConfig });
    // The premise, asserted rather than assumed: without it the rest of this
    // test would pass against a solver that did nothing at all.
    expect(seed.assignments).toHaveLength(1);
    expect(seed.conflicts.map((c) => `${c.fixtureId}:${c.reason}`)).toEqual(["b:start_window"]);

    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [
        { fixtureId: "b", court: "C1", startAtMs: T0 },
        { fixtureId: "a", court: "C1", startAtMs: T0 + 30 * MIN },
      ],
      status: "OPTIMAL",
      tiersCompleted: TIER_COUNT,
      objectiveValues: provedTiers(),
      elapsedMs: 5,
      wallExhausted: false,
    });
    const built = await buildSchedule({ fixtures: cornerFixtures, config: cornerConfig });
    expect(built.metrics.placed).toBe(2);
    expect(built.engine).toBe("optimized");
    expect(built.status).toBe("ok");
    expect(built.tiersCompleted).toBe(TIER_COUNT);
    expect(built.budgetExpired).toBe(false);
    // Non-vacuous only because `buildSchedule` synthesises a row for every
    // fixture it did not place: `validateAssignments` alone never emits a
    // `no_slot`, so this assertion would hold on a board with zero cards on it.
    expect(built.conflicts.filter((c) => c.reason === "no_slot")).toHaveLength(0);
    expect(validateAssignments(built.assignments, cornerConfig)).toEqual([]);
  }, 180_000);

  // UN-SKIPPED (fix round 1): the pairwise rest (45 min) FORCES the three
  // starts 75 minutes apart regardless of court — T, T+75, T+150 (see the
  // comment below) — so only the COURT assignment of the middle card is
  // free, and mocked here on C2 (imbalance 30) against greedy's all-on-C1
  // (imbalance 90).
  it("returns a board the verifier accepts", async () => {
    const config = cfg({ courts: ["C1", "C2"], perEntrantMinRest: 45 });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E1", "E3"), fx("c", "E2", "E3")];
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [
        { fixtureId: "a", court: "C1", startAtMs: T0 },
        { fixtureId: "b", court: "C2", startAtMs: T0 + 75 * MIN },
        { fixtureId: "c", court: "C1", startAtMs: T0 + 150 * MIN },
      ],
      status: "OPTIMAL",
      tiersCompleted: TIER_COUNT,
      objectiveValues: provedTiers(),
      elapsedMs: 5,
      wallExhausted: false,
    });
    const built = await buildSchedule({ fixtures, config });
    expect(validateAssignments(built.assignments, config)).toEqual([]);
    // THIS CASE USED TO ASSERT `already_optimal`, and the comment explaining
    // why is worth keeping as a record of the defect it was describing:
    //
    //   "greedy's 45-minute rest pushes two of these three cards OFF the
    //    30-minute lattice (09:00 / 10:15 / 11:30), so no three-card board
    //    exists on the grid at all and every tier bound comes back unsat. That
    //    is a proof about the lattice."
    //
    // A proof about the lattice is not a proof about the BOARD, and this is
    // exactly the shape the organiser was being told was optimal: greedy stacks
    // all three cards on C1 (imbalance 90) and z3 could not express a single
    // legal alternative. The step still does not divide the rest — 10:15 and
    // 11:30 are on no 30-minute lattice — but both are now PINNED into it as
    // the incumbent's own slots (`seedPinsOf`), so the board is searchable and
    // T3 moves the middle card to C2. `build-rest-lattice.test.ts` is where
    // that mechanism is pinned, and why it is not a finer step.
    //
    // 180 and 120 are both FORCED and asserted as such: every pair of these
    // three fixtures shares an entrant, so the starts are 75 minutes apart
    // whatever the order, and the outer pair always waits 120.
    expect(built.status).toBe("ok");
    expect(built.metrics.placed).toBe(3);
    expect(built.metrics.makespanMinutes).toBe(180);
    expect(built.metrics.worstIdleGapMinutes).toBe(120);
    expect(built.metrics.courtImbalanceMinutes).toBe(30);
  }, 180_000);

  // UN-SKIPPED (fix round 1): the session window bounds the GRID to 2 slots
  // total, so no engine can place more than 2 of these 3 — mocked as
  // EXACTLY greedy's own pair (a, b) so the board ties on every metric and
  // "c" is unplaced via the SAME `conflictsForBoard` path either way.
  it("reports every unplaced card, and PROVES the count is the ceiling", async () => {
    const input = { fixtures: overSubscribedFixtures, config: overSubscribedConfig };
    const seed = rawSeedOf(input);
    expect(seed.assignments).toHaveLength(2);

    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue({
      assignments: seed.assignments.map((a) => ({
        fixtureId: a.fixtureId,
        court: a.court,
        startAtMs: a.startAt,
      })),
      status: "OPTIMAL",
      tiersCompleted: TIER_COUNT,
      objectiveValues: provedTiers(),
      elapsedMs: 5,
      wallExhausted: false,
    });
    const built = await buildSchedule(input);
    expect(built.metrics.placed).toBe(2);
    // Greedy GUESSED that a third card would not fit; T0 walked `placed >= 3`
    // and came back unsat, which is a proof. That difference is the whole
    // reason the tier exists, and `already_optimal` is where it surfaces.
    expect(built.status).toBe("already_optimal");
    expect(built.tiersCompleted).toBe(TIER_COUNT);
    const unplaced = built.conflicts.filter((c) => c.reason === "no_slot");
    expect(unplaced.map((c) => c.fixtureId)).toEqual(["c"]);
    expect(unplaced[0]?.rule).toBe("CAP");
  }, 180_000);

  it("falls back to greedy, and says so, when the lattice is over the cap", async () => {
    const config = cfg({
      window: { from: T0, to: T0 + 400 * 86_400_000 },
      courts: ["C1", "C2", "C3", "C4"],
    });
    const built = await buildSchedule({ fixtures: [fx("a", "E1", "E2")], config });
    expect(built.engine).toBe("greedy");
    expect(built.assignments).toHaveLength(1);
    expect(built.tiersCompleted).toBe(0);
  }, 180_000);

  it("declines to solve a lattice that cannot reach the fixtures", async () => {
    // `buildGrid` takes its universe from `repairUniverse`, which with no
    // window, no session windows and no existing board returns the FIRST DAY OF
    // THE UNIX EPOCH. Every slot in the lattice would then be 56 years before
    // the fixtures, and T0 would happily "improve" the board onto them.
    //
    // The corner case is reused WITHOUT its session windows on purpose: greedy
    // leaves a card unplaced, so T0 has a reason to run, and every 1970 slot
    // satisfies `b`'s "not after 09:00 on 8 Aug 2026" start window trivially.
    // Drop the guard and this returns a perfectly verifier-clean two-card board
    // dated 1 January 1970 — `validateAssignments` has no window to object to
    // either, so the gate cannot catch it. The date assertion is the only thing
    // between that board and an organiser.
    const config = cfg({
      constraints: cons({ startWindows: [{ target: { kind: "entrant", id: "E3" }, notAfter: T0 }] }),
    });
    delete config.window;
    const built = await buildSchedule({ fixtures: cornerFixtures, config });
    expect(built.assignments.every((a) => a.startAt >= T0)).toBe(true);
    expect(built.engine).toBe("greedy");
    expect(built.tiersCompleted).toBe(0);
    expect(built.metrics.placed).toBe(1);
  }, 180_000);

  // SKIPPED (Task 06, placement cutover): `rlimit` was z3's own deterministic
  // resource counter (`solver.set("rlimit", ...)`) and `solveBuild` no
  // longer reads `input.rlimit` at all — placement has no equivalent knob, so
  // `rlimit: 1` here has no effect and cannot reproduce a z3 `unknown`. The
  // placement analog (an outcome whose `status` is `"UNKNOWN"`) needs a real or
  // mocked service response, not a local budget knob.
  // SKIPPED (Task 06, placement cutover): same `rlimit` obsolescence as the WALK
  // case above — `solveBuild` no longer runs a z3 feasibility probe at all
  // (contradictory pins are now caught by a local `validateAssignments` check
  // before ever calling placement; see `solveBuild`'s comment on `pinConflicts`).
  it("does not report infeasible from a probe it never got to run", async () => {
    // The same contradictory pins as below, but no budget. `unsat` would be a
    // proof; not asking is not one. Without the wall-clock guard the probe runs
    // anyway and this comes back `infeasible` off a question nobody asked.
    const config = cfg({ courts: ["C1"], sessionWindows: [{ from: T0, to: T0 + 60 * MIN }] });
    const fixtures = [
      fx("a", "E1", "E2", { locked: { court: "C1", startAt: T0 } }),
      fx("b", "E3", "E4", { locked: { court: "C1", startAt: T0 } }),
    ];
    const built = await buildSchedule({ fixtures, config, wallMs: 0 });
    expect(built.status).not.toBe("infeasible");
    expect(built.budgetExpired).toBe(true);
  }, 180_000);

  it("stops on the outer wall cap without inventing a verdict", async () => {
    const built = await buildSchedule({
      fixtures: cornerFixtures,
      config: cornerConfig,
      wallMs: 0,
    });
    expect(built.budgetExpired).toBe(true);
    // `not_searched`, and this case is the clearest statement of what that
    // status means: at `wallMs: 0` the run bails before `encodeBuild`, so no
    // model ever exists and no `check()` runs. It used to answer `ok` — "a board
    // was produced and the gate accepted it" — which is exactly the invented
    // verdict the test's own name refuses. `budgetExpired` cannot carry it
    // alone: it is set on every partially-searched run too.
    expect(built.status).toBe("not_searched");
    expect(built.assignments).toHaveLength(1);
  }, 180_000);

  it("proves infeasible only when the pins really do contradict", async () => {
    // Two cards pinned onto ONE slot. `buildGrid` admits a pinned placement
    // unconditionally and `encodeBuild` asserts it as a unit clause, so this
    // makes the WHOLE model unsat rather than leaving one card unplaced — and
    // an unsat that arrives that way is a fact about the pins, not about the
    // board. `infeasible` here is a real proof: with no locked card the empty
    // board satisfies every clause the encoder writes, so the model can only
    // be globally unsat because of a pin.
    const config = cfg({ courts: ["C1"], sessionWindows: [{ from: T0, to: T0 + 60 * MIN }] });
    const fixtures = [
      fx("a", "E1", "E2", { locked: { court: "C1", startAt: T0 } }),
      fx("b", "E3", "E4", { locked: { court: "C1", startAt: T0 } }),
    ];
    const built = await buildSchedule({ fixtures, config });
    expect(built.status).toBe("infeasible");
    expect(built.engine).toBe("greedy");
    // Both cards are double-booked, so NEITHER is legally placed and the seed
    // legalisation drops both. The organiser is not left guessing: every card
    // is reported, with the court clash that actually disqualified it.
    expect(built.assignments).toHaveLength(0);
    expect(
      built.conflicts
        .filter((c) => c.reason === "court")
        .map((c) => c.fixtureId)
        .sort(),
    ).toEqual(["a", "b"]);
    // R4. The proof is about the PINS, and on a bigger board — 38 of 40 placed
    // and two locked cards fighting over one slot — "infeasible" on its own
    // reads to an organiser as "no schedule is possible", which is false. The
    // result names the cards the proof is about so the caller can say which.
    expect(built.contradictoryPins).toEqual(["a", "b"]);
  }, 180_000);

  // UN-SKIPPED (fix round 1): mocked as a fully-proved 0-placed reply — this
  // tests build.ts's OWN status derivation (an outcome with nothing placed
  // and every tier proved becomes `infeasible` with `contradictoryPins`
  // left `undefined`, since only the two EXPLICIT `INFEASIBLE`/pin-check
  // returns ever set that field), which is well-defined regardless of
  // whether placement could realistically reach this exact verdict for this
  // input — `constraints.startWindows` has no wire field (a real gap, noted
  // in the report), so a live service could not actually be excluded from
  // this slot the way z3 was. That gap is why the board is mocked rather
  // than solved for real, not a reason to leave build.ts's own status logic
  // uncovered.
  it("names no pins when the proof is about the BOARD, not the pins", async () => {
    // The other `infeasible` source, and the reason the field is optional
    // rather than always present: nothing is pinned here at all. One slot, one
    // fixture, and a start window that excludes it, so T0 walks `placed >= 1`
    // and comes back unsat — a proof about the lattice. Reporting a pin here
    // would name cards that had nothing to do with it.
    const config = cfg({
      courts: ["C1"],
      sessionWindows: [{ from: T0, to: T0 + 30 * MIN }],
      constraints: cons({
        startWindows: [{ target: { kind: "entrant", id: "E1" }, notAfter: T0 - MIN }],
      }),
    });
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [],
      status: "OPTIMAL",
      tiersCompleted: TIER_COUNT,
      objectiveValues: provedTiers(),
      elapsedMs: 5,
      wallExhausted: false,
    });
    const built = await buildSchedule({ fixtures: [fx("a", "E1", "E2")], config });
    expect(built.status).toBe("infeasible");
    expect(built.metrics.placed).toBe(0);
    expect(built.contradictoryPins).toBeUndefined();
    // Every tier ran to a verdict on the empty board — each is already at its
    // own floor — which is what makes the status a proof rather than a stop.
    expect(built.tiersCompleted).toBe(TIER_COUNT);
  }, 180_000);

  it("does not cry infeasible over a pin that is merely legal", async () => {
    // The other side of the probe above: a locked card that fits must not be
    // read as a contradiction, and its slot must survive into the answer.
    const config = cfg({ courts: ["C1"], sessionWindows: [{ from: T0, to: T0 + 90 * MIN }] });
    const fixtures = [
      fx("a", "E1", "E2", { locked: { court: "C1", startAt: T0 + 60 * MIN } }),
      fx("b", "E3", "E4"),
    ];
    const built = await buildSchedule({ fixtures, config });
    expect(built.status).not.toBe("infeasible");
    expect(built.metrics.placed).toBe(2);
    expect(built.assignments.find((a) => a.fixtureId === "a")?.startAt).toBe(T0 + 60 * MIN);
  }, 180_000);

  // UN-SKIPPED (fix round 1): the FROZEN run's mock deliberately returns
  // NOTHING for the one free fixture ("b"), rather than trying to represent
  // whether placement could legally place it — `constraints.startWindows`
  // (Jul3/04 §3, the mechanism this whole corner case is built from) has no
  // wire field, so nothing send-able to placement today could make it actually
  // respect b's exclusion the way z3's encoder did. What this case verifies
  // is narrower and still real: does the freeze correctly become a pin
  // (excluded from `fixtures`, folded into `existing`) and survive into the
  // final board regardless of what placement does with the rest — an empty
  // reply ties greedy's own floor either way, so the assertion holds via
  // WHICHEVER branch (D6 fallback or a genuine placement accept) fires.
  it("holds a frozen card to its slot even when moving it would place one more", async () => {
    // POLISH. Without the freeze the solver swaps `a` onto the later slot and
    // fits `b` — a strictly better board by D3. `frozen` is the caller saying
    // an entrant has already been told when they play, and a better board is
    // not worth breaking that promise. The unfrozen run is asserted first so
    // this cannot pass against a solver that never had the option.
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [
        { fixtureId: "b", court: "C1", startAtMs: T0 },
        { fixtureId: "a", court: "C1", startAtMs: T0 + 30 * MIN },
      ],
      status: "OPTIMAL",
      tiersCompleted: TIER_COUNT,
      objectiveValues: provedTiers(),
      elapsedMs: 5,
      wallExhausted: false,
    });
    const free = await buildSchedule({ fixtures: cornerFixtures, config: cornerConfig });
    expect(free.metrics.placed).toBe(2);
    expect(free.assignments.find((a) => a.fixtureId === "a")?.startAt).toBe(T0 + 30 * MIN);

    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [],
      status: "OPTIMAL",
      tiersCompleted: TIER_COUNT,
      objectiveValues: provedTiers(),
      elapsedMs: 5,
      wallExhausted: false,
    });
    const built = await buildSchedule({
      fixtures: cornerFixtures,
      config: cornerConfig,
      frozen: ["a"],
    });
    expect(built.assignments.find((a) => a.fixtureId === "a")?.startAt).toBe(T0);
    expect(built.metrics.placed).toBe(1);
  }, 180_000);

  // UN-SKIPPED (fix round 1): same "empty reply for the frozen run" shape as
  // its neighbour above, and the same reason (`constraints.startWindows`
  // has no wire field — this whole test is built from it).
  it("holds a frozen card whose published slot is OFF the lattice", async () => {
    // A card the organiser dragged, or one greedy parked against the edge of an
    // existing booking: its start is not a multiple of the grid step, so it is
    // not a slot `buildGrid` generates. Looking it up with `findIndex` gets -1,
    // and silently dropping the freeze there let POLISH move a card it had
    // promised not to while still reporting `ok`.
    //
    // Do NOT read the old "pinned into the lattice" mechanism here — it was
    // removed with the `seedPinsOf` grid injection, which was manufacturing
    // per-court asymmetric grids and routing real boards to greedy. The
    // mechanism that holds the freeze now lives at `build.test.ts:1473`.
    // `a`'s entrant may not start before 09:07, so greedy starts it at exactly
    // 09:07 — the lattice only generates 09:00 / 09:30 / 10:00. `b`'s entrant
    // may not start after 09:00, and `a` sitting at 09:07 covers 09:00's slot
    // on the only court, so greedy leaves `b` unplaced. Move `a` to 09:30 and
    // both fit, which gives the solver a real reason to move the card the
    // caller froze. Measured: greedy `[a@C1+7]`, `b:start_window`; slots are
    // `C1+0, C1+30, C1+60`.
    const config = cfg({
      sessionWindows: [{ from: T0, to: T0 + 90 * MIN }],
      constraints: cons({
        startWindows: [
          { target: { kind: "entrant", id: "E1" }, notBefore: T0 + 7 * MIN },
          { target: { kind: "entrant", id: "E3" }, notAfter: T0 },
        ],
      }),
    });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4")];
    const seed = rawSeedOf({ fixtures, config });
    expect(seed.assignments.find((a) => a.fixtureId === "a")?.startAt).toBe(T0 + 7 * MIN);
    expect(seed.conflicts.map((c) => c.reason)).toEqual(["start_window"]);

    // Unfrozen, the solver takes the better board and `a` moves onto the grid.
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [
        { fixtureId: "b", court: "C1", startAtMs: T0 },
        { fixtureId: "a", court: "C1", startAtMs: T0 + 30 * MIN },
      ],
      status: "OPTIMAL",
      tiersCompleted: TIER_COUNT,
      objectiveValues: provedTiers(),
      elapsedMs: 5,
      wallExhausted: false,
    });
    const free = await buildSchedule({ fixtures, config });
    expect(free.metrics.placed).toBe(2);
    expect(free.assignments.find((a) => a.fixtureId === "a")?.startAt).toBe(T0 + 30 * MIN);

    // Frozen, 09:07 has to survive — and 09:07 is not a slot the lattice
    // generates, so it survives only because the anchor was pinned into it.
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [],
      status: "OPTIMAL",
      tiersCompleted: TIER_COUNT,
      objectiveValues: provedTiers(),
      elapsedMs: 5,
      wallExhausted: false,
    });
    const built = await buildSchedule({ fixtures, config, frozen: ["a"] });
    expect(built.assignments.find((a) => a.fixtureId === "a")?.startAt).toBe(T0 + 7 * MIN);
    expect(built.metrics.placed).toBe(1);
  }, 180_000);

  // UN-SKIPPED (fix round 1): this is the reproduction for Critical B, and
  // it needed no live service to catch it — the false `infeasible` fired
  // from the LOCAL pin-only check (`isPairwiseBlockingConflict` in
  // `solveBuild`), before placement was ever called. `window` is a UNARY
  // blocking reason (one row's own placement against `config.window`, not a
  // contradiction between two pins), and the pin-check used to run the full
  // `isBlockingConflict` — which also marks `window` blocking — so a single
  // locked card merely sitting outside the window read as a pin
  // "contradiction" and short-circuited to `infeasible` with a nonsensical
  // one-element `contradictoryPins`. Fixed by scoping that check to pairwise
  // reasons only (`court`, `person_overlap`, direct `order`).
  //
  // Mocked past that point (placing "b" needs a real solve, which this test
  // environment cannot reach) to prove the REST of the chain too: the pin
  // survives into the final board at its out-of-window slot, the resulting
  // `window` conflict is not new relative to greedy's own raw seed (greedy
  // ALSO honours the lock unconditionally) so `rejectedBlockingConflicts`
  // does not reject it, and 2 placed beats greedy's legalised floor of 1
  // (greedy's OWN legalisation drops "a" for the same window breach) so the
  // D6 gate accepts placement's board rather than falling back to the seed.
  it("does NOT reject a board over a blocking breach greedy already had", async () => {
    // R1: the gate is a DELTA. This card is pinned outside the competition
    // window — `buildGrid` admits a pin unconditionally, `encodeBuild` states no
    // clause about `config.window`, and `validateAssignments` calls it a
    // blocking `window` breach. An ABSOLUTE gate refuses the solver's answer
    // here, and would go on refusing it on every board carrying a legacy
    // `person_overlap` too, which is the population `deltaConflicts` exists to
    // keep editable. The breach is greedy's, so it is not laid at the solver's
    // door — it is reported, and the better board still ships.
    const spy = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue({
        assignments: [{ fixtureId: "b", court: "C1", startAtMs: T0 }],
        status: "OPTIMAL",
        tiersCompleted: TIER_COUNT,
        objectiveValues: provedTiers(),
        elapsedMs: 5,
        wallExhausted: false,
      });
      const config = cfg({ courts: ["C1"], window: { from: T0, to: T0 + 60 * MIN } });
      const fixtures = [
        fx("a", "E1", "E2", { locked: { court: "C1", startAt: T0 + 120 * MIN } }),
        fx("b", "E3", "E4"),
      ];
      const built = await buildSchedule({ fixtures, config });
      expect(built.status).toBe("ok");
      expect(built.engine).toBe("optimized");
      expect(built.metrics.placed).toBe(2);
      expect(built.conflicts.some((c) => c.fixtureId === "a" && c.reason === "window")).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  }, 180_000);

  // UN-SKIPPED (fix round 1): the injected fork keys off
  // `assignments.length === 2`, which needs placement's own board to actually
  // have 2 cards — `placement-client.ts` is now ALSO `vi.doMock`'d (matching the
  // existing `./calendar.ts` mock's own style, since `vi.resetModules()` +
  // a fresh dynamic `import("./build.ts")` would otherwise re-resolve a
  // real, un-mocked `placement-client.ts`), returning the file's own measured
  // z3 shape for this corner case (`[b@C1+0, a@C1+30]`).
  it("hands back the greedy seed, LOUDLY, over a breach the solver INTRODUCED", async () => {
    // The rejection branch itself. A genuine encoder/verifier disagreement is
    // not constructible here — `build-encode-parity.test.ts` proves the two
    // agree over every placement two lattices can express, which is the design
    // working — so the disagreement is INJECTED: `validateAssignments` reports
    // a blocking `person_overlap` on the solver's two-card board and nothing on
    // greedy's one-card board. That is exactly the shape a future encoder
    // regression would take, and it is the only way to exercise the fallback
    // and the log without waiting for one.
    vi.resetModules();
    vi.doMock("./placement-client.ts", async () => {
      const actual = await vi.importActual<typeof import("./placement-client.ts")>("./placement-client.ts");
      return {
        ...actual,
        solveBuild: async () => ({
          assignments: [
            { fixtureId: "b", court: "C1", startAtMs: T0 },
            { fixtureId: "a", court: "C1", startAtMs: T0 + 30 * MIN },
          ],
          status: "OPTIMAL",
          tiersCompleted: TIER_COUNT,
          objectiveValues: provedTiers(),
          elapsedMs: 5,
          wallExhausted: false,
        }),
      };
    });
    vi.doMock("./calendar.ts", async () => {
      const actual = await vi.importActual<typeof import("./calendar.ts")>("./calendar.ts");
      return {
        ...actual,
        validateAssignments: (
          assignments: readonly Assignment[],
          ...rest: unknown[]
        ): Conflict[] => [
          ...(actual.validateAssignments as (...a: unknown[]) => Conflict[])(assignments, ...rest),
          ...(assignments.length === 2
            ? [{ fixtureId: "b", reason: "person_overlap" as const, details: { kind: "person_overlap" as const } }]
            : []),
        ],
      };
    });
    try {
      const mod = await import("./build.ts");
      // Spied AFTER the fresh import, matching it: `vi.resetModules()` gives
      // this run's `build.ts` a fresh `./logger.ts` instance too (it is
      // imported transitively), so a spy attached to a pre-reset `log` would
      // watch an object this call never touches. Restoring it is left to the
      // describe block's own `afterEach(() => vi.restoreAllMocks())` — this
      // spy cannot outlive the `vi.resetModules()` below either way.
      const { log } = await import("./logger.ts");
      const spy = vi.spyOn(log, "error").mockImplementation(() => undefined);
      const built = await mod.buildSchedule({ fixtures: cornerFixtures, config: cornerConfig });
      expect(built.status).toBe("verifier_rejected");
      expect(built.engine).toBe("greedy");
      // The greedy seed, not the solver's better board: the organiser still
      // gets a board, and it is the one nothing new is wrong with.
      expect(built.assignments).toHaveLength(1);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[1]).toContain("verifier rejected");
      expect(spy.mock.calls[0]?.[0]).toMatchObject({ rejected: ["b:person_overlap"] });
    } finally {
      vi.doUnmock("./calendar.ts");
      vi.doUnmock("./placement-client.ts");
      vi.resetModules();
    }
  }, 180_000);

  // SKIPPED (Task 06, placement cutover): `solveBuild` no longer imports or
  // calls `loadZ3` at all, so mocking it to reject is mocking something
  // this code path never touches — not "unverifiable", genuinely dead. The
  // placement analog (`solveBuild`'s `SolveBuild` promise rejecting/erroring
  // falls back to greedy with `status: "not_searched"`) is covered by
  // `describe("buildSchedule — Placement path", ...)` below. Prompt 10 removes
  // `z3-load.ts` and this test with it.
});

describe("rejectedBlockingConflicts", () => {
  // The gate's decision, tested where it can actually be exercised. Inside
  // `buildSchedule` an encoder/verifier disagreement is not constructible —
  // `build-encode-parity.test.ts` proves the two agree over every placement two
  // lattices can express, and the one seam outside that envelope (a pin outside
  // `config.window`) is a breach greedy shares, so the delta cancels it. That
  // makes the gate a guard against a FUTURE encoder change, and a guard nothing
  // can trigger is a guard nothing can test end to end.
  const c = (over: Partial<Conflict> & Pick<Conflict, "fixtureId" | "reason">): Conflict => ({
    details: { kind: "inside_blackout" },
    ...over,
  });

  it("passes a blocking conflict the board already carried", () => {
    const before = [c({ fixtureId: "a", reason: "window" })];
    const after = [c({ fixtureId: "a", reason: "window" })];
    expect(rejectedBlockingConflicts(before, after, new Set(["a"]))).toEqual([]);
  });

  // The durable typed rules are NOT on the placement wire — `constraints`
  // carries `matchMinutes`/`gapMinutes` only, `division_rules` (proto field 10)
  // was retired, and `constraints.startWindows` was never sent — so the service
  // cannot honour a `not_before`. Greedy can and does (`calendar.ts:759`,
  // `ready = max(config.startAt, window.notBefore)`). This gate is therefore the
  // only place a rule-breaking solver board can be caught; before 2026-08-13 the
  // sole thing catching it was `isStrictlyBetter` happening to prefer greedy's
  // board, which is incidental rather than a guarantee. Measured that day: with
  // the gate changed to trust the solver's proof instead of ranking, a division
  // whose durable rule forbids anything before noon got six cards at 00:00.
  it("rejects a durable typed-rule breach the solver introduced, though it is warn-only elsewhere", () => {
    const after = [c({ fixtureId: "a", reason: "instruction" })];
    expect(rejectedBlockingConflicts([], after, new Set(["a"]))).toEqual(after);
    // The SHARED predicate is deliberately unchanged: widening it would move
    // the apply gate, the drag path and the AI pipeline too. An organiser must
    // still be able to edit a board that already breaches a rule.
    expect(isBlockingConflict(after[0]!)).toBe(false);
  });

  // P9.5. The comment above names `constraints.startWindows` as a motivating
  // example of "typed rules are not on the wire", but a startWindows breach does
  // NOT report `reason: "instruction"` — that family is the durable typed rules
  // (calendar.ts:1279-1372, rule code H8). A startWindows breach reports
  // `reason: "start_window"` (calendar.ts:1608 on the verify side, :945 on the
  // greedy side). So it falls through this gate entirely: the solver, which was
  // never sent the constraint, can introduce one and nothing rejects the board.
  //
  // Same class, same asymmetry, same argument — two vocabularies for one idea,
  // and the gate only learned one of them.
  it("rejects a start-window breach the solver introduced, for the same reason as a typed rule", () => {
    const after = [c({ fixtureId: "a", reason: "start_window", details: { kind: "outside_start_window" } })];
    expect(rejectedBlockingConflicts([], after, new Set(["a"]))).toEqual(after);
    // The shared predicate stays unchanged, exactly as for `instruction`: an
    // organiser must still be able to edit a board that already breaches one.
    expect(isBlockingConflict(after[0]!)).toBe(false);
  });

  it("passes a start-window breach greedy shares, because refusing it would be a lock-out", () => {
    // The start-date case: move a division's start date and every absolute
    // startWindow can fall outside the new range. Neither producer can satisfy
    // it, so it appears on both sides and cancels rather than stranding the
    // organiser with a board they cannot publish or fix.
    const both = [c({ fixtureId: "a", reason: "start_window", details: { kind: "outside_start_window" } })];
    expect(rejectedBlockingConflicts(both, both, new Set(["a"]))).toEqual([]);
  });

  it("passes a typed-rule breach greedy shares, because refusing it would be a lock-out", () => {
    // A rule NEITHER producer can satisfy appears on both sides and cancels —
    // the same reason `ours` scopes out conflicts between two `existing` rows.
    const before = [c({ fixtureId: "a", reason: "instruction" })];
    const after = [c({ fixtureId: "a", reason: "instruction" })];
    expect(rejectedBlockingConflicts(before, after, new Set(["a"]))).toEqual([]);
  });

  it("rejects a blocking conflict the solver introduced", () => {
    const after = [c({ fixtureId: "a", reason: "person_overlap" })];
    expect(rejectedBlockingConflicts([], after, new Set(["a"]))).toEqual(after);
  });

  it("rejects a MEASURED blocking conflict that got worse", () => {
    // `conflictKey` excludes `shortfallMinutes` on purpose, so a worsening has
    // identical identity and is visible only through the size. A gate built on
    // a plain set difference would wave this through.
    const before = [c({ fixtureId: "a", reason: "order", direct: true, shortfallMinutes: 10 })];
    const after = [c({ fixtureId: "a", reason: "order", direct: true, shortfallMinutes: 30 })];
    expect(rejectedBlockingConflicts(before, after, new Set(["a"]))).toEqual(after);
  });

  it("ignores a blocking conflict on a card this run did not place", () => {
    // `validateAssignments` attributes an `order` conflict between two
    // `existing` rows to a fixture the solver never touched. Refusing our own
    // answer over one would be a lock-out with no fix, since nothing the solver
    // can do changes it.
    const after = [c({ fixtureId: "sibling", reason: "order", direct: true })];
    expect(rejectedBlockingConflicts([], after, new Set(["a"]))).toEqual([]);
  });

  it("filters BLOCKING before it takes the delta, so a warn-only twin cannot cancel it", () => {
    // The rationale the function's doc gives, exercised rather than asserted.
    // `conflictKey` is `fixtureId|reason|canon(details)` and does NOT include `direct`,
    // so a warn-only `order` row and a blocking one are the same key. Take the
    // delta first and they cancel: the board goes from "the dependent is a bit
    // tight" to "the dependent starts before its feeder finishes" and the gate
    // sees nothing at all.
    const before = [c({ fixtureId: "a", reason: "order", direct: false })];
    const after = [c({ fixtureId: "a", reason: "order", direct: true })];
    expect(rejectedBlockingConflicts(before, after, new Set(["a"]))).toEqual(after);
  });

  it("ignores a NON-blocking conflict however new it is", () => {
    // Below-minimum rest is uncomfortable, not impossible, and organisers
    // override it. Rejecting the board over one would make the solver refuse
    // the very trade-offs it exists to make.
    const after = [c({ fixtureId: "a", reason: "rest" }), c({ fixtureId: "a", reason: "blackout" })];
    expect(rejectedBlockingConflicts([], after, new Set(["a"]))).toEqual([]);
  });
});

/**
 * Tiers 1-3.
 *
 * Every board below is MEASURED, not assumed: the premise assertion at the top
 * of each case pins what greedy actually does, because a tier test whose seed is
 * already optimal passes against a solver that ran no tiers at all. The brief's
 * own sketch for this suite had exactly that shape — four disjoint fixtures on
 * two courts, asserting `courtImbalanceMinutes === 0`, on a board greedy
 * already balances 2-2.
 */
// UN-SKIPPED (fix round 1), 4 of 5 cases: each is now driven by a
// `vi.spyOn(await import("./placement-client.ts"))` mock returning the SAME
// board the file's own "Measured:" comments already documented z3 producing
// for that scenario — the point is "does OUR CODE correctly turn a solve
// into the right `BuildResult`", not "does placement actually find that board",
// which is Task 07's parity concern. `objectiveValues`/`tiersCompleted`
// wire semantics are unchanged (design doc: `SolveBuildResponse.tiers
// _completed` carries the "same semantics as `BuildResult.tiersCompleted`").
//
// The 5th, "keeps the encoder and the verifier on ONE immovable board",
// stays skipped — see its own comment, not a live-service gap like the
// others.
describe("buildSchedule — lexicographic tiers", () => {

  // See the identical comment in `describe("buildSchedule", ...)` above —
  // `isolate: false` + no global mock-restore config means a `vi.spyOn` left
  // standing here leaks into every later describe block in this file.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Four slots a side, two fixtures sharing E1. Greedy stacks both on C1 —
   *  it looks for the earliest legal TIME and takes the first court free at it,
   *  so the second card lands on C1 at 09:30 rather than beside the first. The
   *  makespan (60) and the worst idle gap (0) are the same on every board that
   *  places both, so T3 is the tier that decides, and an even split beats a
   *  stack. */
  const balanceConfig = cfg({ courts: ["C1", "C2"], window: { from: T0, to: T0 + 120 * MIN } });
  const balanceFixtures = [fx("a", "E1", "E2"), fx("b", "E1", "E3")];

  it("completes all four tiers, and balances the courts with the last of them", async () => {
    const seed = rawSeedOf({ fixtures: balanceFixtures, config: balanceConfig });
    expect(boardMetrics(seed.assignments, balanceConfig.courts, 2).courtImbalanceMinutes).toBe(60);

    // Measured z3 shape reused as the mock: `a`/`b` share E1, so they cannot
    // overlap in time; splitting them across C1/C2 back-to-back holds T1's
    // makespan (60) and T2's idle gap (0, both already optimal on greedy's
    // own board) while balancing T3 to 0 — strictly better than greedy's
    // 60-minute imbalance from stacking both on C1.
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [
        { fixtureId: "a", court: "C1", startAtMs: T0 },
        { fixtureId: "b", court: "C2", startAtMs: T0 + 30 * MIN },
      ],
      status: "OPTIMAL",
      tiersCompleted: TIER_COUNT,
      objectiveValues: provedTiers(),
      elapsedMs: 5,
      wallExhausted: false,
    });
    const built = await buildSchedule({ fixtures: balanceFixtures, config: balanceConfig });
    expect(built.tiersCompleted).toBe(TIER_COUNT);
    expect(built.budgetExpired).toBe(false);
    expect(built.metrics.placed).toBe(2);
    // T1 and T2 had nothing to give — both are already at their optimum on the
    // greedy board — so the only thing that moved is the court split.
    expect(built.metrics.makespanMinutes).toBe(60);
    expect(built.metrics.worstIdleGapMinutes).toBe(0);
    expect(built.metrics.courtImbalanceMinutes).toBe(0);
    expect(new Set(built.assignments.map((a) => a.court))).toEqual(new Set(["C1", "C2"]));
    expect(built.engine).toBe("optimized");
  }, 180_000);

  it("shortens a makespan greedy left long", async () => {
    // `notBefore` is the one place greedy reliably loses a makespan: it starts
    // the constrained card at EXACTLY 09:45, which is not a lattice multiple,
    // and then packs the other two around it — 09:00, 09:45, 10:15, a 105-minute
    // board. The lattice only offers 09:00 / 09:30 / 10:00 / 10:30, so `a` must
    // take 10:00 or later, and the shortest board is the other two beneath it.
    const config = cfg({
      window: { from: T0, to: T0 + 120 * MIN },
      constraints: cons({
        startWindows: [{ target: { kind: "entrant", id: "E1" }, notBefore: T0 + 45 * MIN }],
      }),
    });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4"), fx("c", "E5", "E6")];
    const seed = rawSeedOf({ fixtures, config });
    expect(boardMetrics(seed.assignments, config.courts, 3).makespanMinutes).toBe(105);

    // `b`/`c` unconstrained, `a` not before 09:45 — packing `a` last on the
    // one court (09:00/09:30/10:00) is one of the two 90-minute boards the
    // comment below names; either is a genuine improvement on greedy's 105.
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [
        { fixtureId: "b", court: "C1", startAtMs: T0 },
        { fixtureId: "c", court: "C1", startAtMs: T0 + 30 * MIN },
        { fixtureId: "a", court: "C1", startAtMs: T0 + 60 * MIN },
      ],
      status: "OPTIMAL",
      tiersCompleted: TIER_COUNT,
      objectiveValues: provedTiers(),
      elapsedMs: 5,
      wallExhausted: false,
    });
    const built = await buildSchedule({ fixtures, config });
    expect(built.metrics.placed).toBe(3);
    expect(built.metrics.makespanMinutes).toBe(90);
    // Forced, not incidental: 90 minutes over one court is three back-to-back
    // slots, and `a` may not start before 09:45, so `a` is the LAST of them.
    //
    // THE ABSOLUTE INSTANT IS NOT FORCED AND MUST NOT BE ASSERTED. Two boards
    // meet all four of D3's tiers here — 09:00/09:30/10:00 and
    // 09:30/10:00/10:30 — with the same `placed`, the same makespan, no idle
    // gap on either (six distinct entrants, one match each) and the same
    // imbalance (one court). Which one comes back is a tie z3 breaks in its own
    // internals, not a property of this design.
    //
    // This asserted 10:00 until R17, and passed only because the solves EARLIER
    // IN THIS FILE left the shared z3 context warm — the cold answer was always
    // 10:30 (measured directly). Now that `buildSchedule` tears the context down
    // itself, every solve is cold and the tie falls the other way. Asserting the
    // instant was pinning the solver's search state; asserting the shape pins
    // what the comment above actually argues.
    const starts = [...built.assignments].map((x) => x.startAt).sort((p, q) => p - q);
    expect(built.assignments.find((x) => x.fixtureId === "a")?.startAt).toBe(starts[2]);
    expect(built.tiersCompleted).toBe(TIER_COUNT);
  }, 180_000);

  it("closes an idle gap greedy left open, without lengthening the board", async () => {
    // Three slots, three cards, so the makespan is 90 on every board that
    // places them all and T1 can do nothing. E1 plays `a` and `d`; greedy
    // walks fixtures in (roundNo, id) order, so `c` gets served before `d`
    // and E1 is left with a 30-minute wait in the middle. T2 swaps them.
    //
    // All three tie at `fx`'s default roundNo (1) rather than `d` carrying an
    // explicit higher one, as an earlier version of this test had it (`b`,
    // before the rename below). C1 (2026-08-12 round-order design) made that
    // round difference load-bearing for a REASON UNRELATED to this test: the
    // "improved" board two paragraphs down moves the round-2 card ahead of
    // the round-1 `c` on the same day, which the new hard constraint now
    // correctly refuses — this test's own idle-gap fix was, incidentally,
    // also a round-order violation once rounds meant anything. Tying all
    // three exempts every pair here from round-order comparison entirely (a
    // round-order pair is never compared when the two rounds are equal), so
    // the greedy processing order this test actually cares about is steered
    // by the id alone instead — `d` sorts after `c` (a < c < d), same
    // processing order the roundNo override used to force.
    const config = cfg({ window: { from: T0, to: T0 + 90 * MIN } });
    const fixtures = [fx("a", "E1", "E2"), fx("d", "E1", "E3"), fx("c", "E4", "E5")];
    const seed = rawSeedOf({ fixtures, config });
    const seedMetrics = boardMetrics(seed.assignments, config.courts, 3);
    expect(seedMetrics.worstIdleGapMinutes).toBe(30);
    expect(seedMetrics.makespanMinutes).toBe(90);

    // `a`/`d` share E1 — placing them back-to-back (rather than greedy's
    // a, c, d order) closes E1's idle gap to 0 without touching the
    // 90-minute makespan three back-to-back slots on one court already have.
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [
        { fixtureId: "a", court: "C1", startAtMs: T0 },
        { fixtureId: "d", court: "C1", startAtMs: T0 + 30 * MIN },
        { fixtureId: "c", court: "C1", startAtMs: T0 + 60 * MIN },
      ],
      status: "OPTIMAL",
      tiersCompleted: TIER_COUNT,
      objectiveValues: provedTiers(),
      elapsedMs: 5,
      wallExhausted: false,
    });
    const built = await buildSchedule({ fixtures, config });
    expect(built.metrics.placed).toBe(3);
    expect(built.metrics.worstIdleGapMinutes).toBe(0);
    expect(built.metrics.makespanMinutes).toBe(90);
    expect(built.tiersCompleted).toBe(TIER_COUNT);
  }, 180_000);

  // UN-SKIPPED (task C2). This was blocked by a STRUCTURAL conflict between
  // what this test needs to construct and Obligation 5
  // (`everyCourtSharesGrid` in `build.ts`): the test's own premise ("C1 is
  // open 09:00-10:00 and C2 only from 10:30") REQUIRES asymmetric court
  // availability to demonstrate the ordering tension at all — with two
  // non-conflicting fixtures and a UNIFORM grid, splitting them across
  // courts at the same early time is simultaneously makespan-optimal AND
  // balanced, so there is no tension left to show. Confirmed before this
  // change: it failed not on a metrics assertion but on `tiersCompleted`
  // reading 0, because the mock was never even called — `solveBuild` routed
  // this exact board to greedy before ever attempting placement. Obligation
  // 5 is gone (`placement.model.build_model` now enforces each court's own
  // tick set directly), so the board this test needs now reaches the mock
  // like any other.
  it("will not buy court balance with makespan", async () => {
    // THE ORDERING TEST, and the only one of these where a tier has something
    // strictly better in reach and may not take it.
    //
    // C1 is open 09:00-10:00 and C2 only from 10:30, so the lattice is
    // C1+09:00, C1+09:30, C2+10:30 and the two cards are disjoint. The shortest
    // board is both on C1 — 60 minutes, and a 60-minute court imbalance. Moving
    // either card to C2 balances the courts perfectly at 0, which T3 would take
    // in a heartbeat, and costs 30 or 60 minutes of makespan, which T1 has
    // already frozen. So the board that wins is the LOPSIDED one.
    //
    // T2's freeze cannot stand in for T1's here: the two fixtures share no
    // participant, so the idle gap is 0 on every board and its clause family is
    // empty. Only the makespan freeze forbids the balanced board.
    const config = cfg({
      courts: ["C1", "C2"],
      window: { from: T0, to: T0 + 120 * MIN },
      blackouts: [
        { court: "C2", from: T0, to: T0 + 90 * MIN },
        { court: "C1", from: T0 + 60 * MIN, to: T0 + 120 * MIN },
      ],
    });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4")];
    expect(buildGrid({ config }).slots.filter((s) => s.court === "C2")).toHaveLength(1);

    // The LOPSIDED board wins: T1 has already frozen the makespan at 60,
    // which forbids the balanced alternative (either card on C2 costs 30-60
    // extra minutes). This is the SAME board greedy already produces
    // (earliest time, first free court) — the mock exists to prove
    // `tiersCompleted`/`status` reflect a real proof rather than "never
    // asked", not to change the board, which is why D6 correctly reports
    // this as `already_optimal` via the greedy floor rather than `engine:
    // "optimized"`.
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [
        { fixtureId: "a", court: "C1", startAtMs: T0 },
        { fixtureId: "b", court: "C1", startAtMs: T0 + 30 * MIN },
      ],
      status: "OPTIMAL",
      tiersCompleted: TIER_COUNT,
      objectiveValues: provedTiers(),
      elapsedMs: 5,
      wallExhausted: false,
    });
    const built = await buildSchedule({ fixtures, config });
    expect(built.metrics.placed).toBe(2);
    expect(built.metrics.makespanMinutes).toBe(60);
    expect(built.metrics.courtImbalanceMinutes).toBe(60);
    // All four, and that is the assertion the freeze actually holds up: without
    // it T3 finds the balanced board, `isStrictlyBetter` refuses it because the
    // makespan regressed, and the tier ends without a verdict.
    expect(built.tiersCompleted).toBe(TIER_COUNT);
    expect(built.status).toBe("already_optimal");
  }, 180_000);

  // STAYS SKIPPED — this is NOT a "needs a live service" gap like its four
  // siblings above, and mocking a compliant response here would be
  // dishonest: what this test checks is IMPOSSIBLE for placement to guarantee
  // today, confirmed straight from the Python model's own source
  // (`services/placement/src/placement/model.py:186-193`, its own docstring, not
  // an inference):
  //
  //   "`existing` rows are not counted against day caps. `on_day` is built
  //   for movable fixtures only, so a pinned row on a capped day does not
  //   consume that day's allowance... It cannot be fixed by adding
  //   `day_index` to `PinnedRow` alone — caps are PER DIVISION and
  //   `PinnedRow` carries no division at all... Closing it needs a
  //   `division_index` on `PinnedRow`, which is a contract addition nothing
  //   has asked for yet."
  //
  // This test's whole premise is "the immovable card `x` correctly counts
  // toward the day cap" — true of z3 (`encodeBuild` seeds its tally from
  // `existing` directly) and STRUCTURALLY untestable against placement, not
  // because of scope (this rule IS competition-scoped, which `dayCapsByDivision`
  // in `build.ts` already can't send — but even rewritten as
  // division-scoped, the Python model would still not count `x`). A mock
  // that made this pass would be asserting a property the wire cannot
  // enforce, which is worse than no test — the exact "green test whose name
  // claims a guarantee" failure mode this fix round is about.
  //
  // Not Task 07's (parity/integration) either — 07 tests behavior against a
  // real service, and a real service would fail this exactly as documented
  // above. This needs a `PinnedRow.division_index` wire change in
  // `services/placement`, own task, own owner decision.
});

describe("buildSchedule — the lattice is the configured courts", () => {
  // Same reasoning as `describe("buildSchedule", ...)`'s own afterEach: with
  // `isolate: false` a `vi.spyOn` left standing here is still active in
  // "the solver queue cap" describe right below, whose own tests assert
  // exact `solveBuild` call counts.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** An immovable row parked on a court the organiser never configured. It is
   *  what drags "C2" into `repairCourts`, and therefore into the lattice. */
  const onC2: Assignment[] = [
    { fixtureId: "x", court: "C2", startAt: T0 + 60 * MIN, endAt: T0 + 90 * MIN, entrants: ["E9"], people: [] },
  ];

  it("places nothing on a court the organiser did not configure", async () => {
    // R3. One session-window slot on the configured court and two fixtures, so
    // the solver has an obvious use for the borrowed court and must decline it.
    const config = cfg({ courts: ["C1"], sessionWindows: [{ from: T0, to: T0 + 30 * MIN }] });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4")];
    // The premise, and the whole reason this is not vacuous: the UNRESTRICTED
    // lattice does offer C2, and a solver allowed to use it places both cards.
    expect(buildGrid({ config, existing: onC2 }).slots.map((s) => s.court)).toEqual(["C1", "C2"]);

    const built = await buildSchedule({ fixtures, config, existing: onC2 });
    expect(built.assignments.map((a) => a.court)).toEqual(["C1"]);
    expect(built.metrics.placed).toBe(1);
  }, 180_000);

  it("still honours a locked card parked on an unconfigured court", async () => {
    // The exemption, and it is load-bearing rather than defensive: `encodeBuild`
    // THROWS when a locked placement is missing from the lattice, so a filter
    // without it turns an odd-looking board into a crash.
    const config = cfg({ courts: ["C1"], sessionWindows: [{ from: T0, to: T0 + 60 * MIN }] });
    const fixtures = [
      fx("a", "E1", "E2", { locked: { court: "C2", startAt: T0 } }),
      fx("b", "E3", "E4"),
    ];
    const built = await buildSchedule({ fixtures, config, existing: onC2 });
    expect(built.status).not.toBe("infeasible");
    expect(built.metrics.placed).toBe(2);
    expect(built.assignments.find((x) => x.fixtureId === "a")).toMatchObject({
      court: "C2",
      startAt: T0,
    });
    // The pin is an exemption for ONE slot, not an amnesty for the court: `b`
    // may not join it there even though C2 has free time.
    expect(built.assignments.filter((x) => x.court === "C2").map((x) => x.fixtureId)).toEqual(["a"]);
  }, 180_000);

  it("declares an obstacle's off-config court on the wire, not just config.courts", async () => {
    // P9 sibling-court gap: `onC2` is a fixed obstacle parked on a court the
    // organiser never configured for THIS division (a sibling division's
    // booking, or another stage's, sharing a physical court). The wire
    // `courts` list used to be sourced from `config.courts` alone, so
    // `courtIndexOf` threw "court \"C2\" ... does not appear in courts" the
    // moment it tried to resolve the obstacle's own court -- caught by
    // `buildSchedule`'s catch-all and silently downgraded to greedy. This
    // does NOT reopen C2 for a NEW placement (see the sibling test above,
    // "places nothing on a court the organiser did not configure") --
    // eligibility for movable fixtures is governed separately by
    // `grid.slots`, unaffected by this list.
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return {
        assignments: [],
        status: "OPTIMAL",
        tiersCompleted: TIER_COUNT,
        objectiveValues: provedTiers(),
        elapsedMs: 1200,
        wallExhausted: false,
      };
    });
    const config = cfg({ courts: ["C1"], sessionWindows: [{ from: T0, to: T0 + 30 * MIN }] });
    const fixtures = [fx("a", "E1", "E2")];
    await buildSchedule({ fixtures, config, existing: onC2 });
    expect(captured).toBeDefined();
    expect(captured!.courts).toEqual(expect.arrayContaining(["C1", "C2"]));
  });
});

describe("buildSchedule — the solver queue cap", () => {

  // DELIBERATELY THE SMALLEST BOARD IN THE FILE. This is the one case that runs
  // `MAX_SOLVER_QUEUE` solves concurrently, and the suite is memory-bound rather
  // than core-bound — `vitest.config.ts` caps `maxWorkers` against total memory
  // because concurrent WASM heaps killed a worker per run, in a different
  // innocent file each time. Two fixtures on two courts is enough to prove every
  // claim below; growing it "to make the solve meaningful" buys nothing and
  // spends the budget that keeps this file honest.
  const config = cfg({ courts: ["C1", "C2"] });
  const fixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4")];

  it("hands the greedy board straight back rather than queueing behind two strangers", async () => {
    // Every call is issued in ONE tick, so the counts asserted here are
    // deterministic rather than a race: `buildSchedule` increments its counter
    // synchronously before it awaits anything, and nothing can decrement until a
    // solve finishes.
    const results = await Promise.all(
      Array.from({ length: MAX_SOLVER_QUEUE + 2 }, () => buildSchedule({ fixtures, config })),
    );
    const busy = results.filter((r) => r.status === "solver_busy");

    // BOTH DIRECTIONS, and the second is the one that means anything.
    // `results.some(r => r.status === "solver_busy")` is satisfied by an
    // implementation that refuses every caller — including one whose cap is 0 —
    // so the complement is asserted as an exact count: the cap must let
    // `MAX_SOLVER_QUEUE` through and refuse the rest.
    expect(busy).toHaveLength(2);
    expect(results.length - busy.length).toBe(MAX_SOLVER_QUEUE);
    // And the ones that got through are the ones that arrived FIRST — a cap that
    // refused an arbitrary two would satisfy the counts above.
    expect(results.map((r) => r.status === "solver_busy")).toEqual([false, false, true, true]);

    for (const r of results) {
      // The refusal costs the organiser nothing they can see: a full board, no
      // conflicts, and the same two cards the solver would have placed.
      expect(r.assignments.map((a) => a.fixtureId).sort()).toEqual(["a", "b"]);
      expect(r.conflicts).toEqual([]);
    }
    for (const r of busy) {
      // Nothing was spent on it, and it says so.
      expect(r.engine).toBe("greedy");
      expect(r.tiersCompleted).toBe(0);
      expect(r.budgetExpired).toBe(false);
      expect(r.rlimitSpent).toBe(0);
    }

    // THE QUEUE DRAINS. `queued` is module state and `isolate: false` shares the
    // module cache across files in a worker, so a counter that failed to
    // decrement would refuse every build for the rest of the run. Asserted
    // through the public API rather than by exporting a reader: a fifth call
    // that is NOT refused is the same evidence, and it reds if the decrement is
    // dropped, which a reader export would only duplicate.
    const after = await buildSchedule({ fixtures, config });
    expect(after.status).not.toBe("solver_busy");
  }, 240_000);

  // C8 coverage loss 1, restored at the seam that replaced the lock.
  //
  // WHAT THE CASE ABOVE CANNOT SEE. It judges the cap from the outside, on
  // statuses alone, and with no `PLACEMENT_SERVICE_HOST` every admitted call
  // rejects inside `solveBuild` and comes back as a greedy board. So a build
  // that was refused BEFORE the client and a build that called the client and
  // fell back are indistinguishable there, and neither of the two admitted
  // calls ever has a solve in flight: nothing in that case is concurrent
  // except the counter arithmetic.
  //
  // `build-teardown.test.ts` used to carry the other half — two concurrent
  // builds really in flight, neither wedged nor crossed — by holding the
  // process-wide z3 lock. C8 deleted the lock and the file with it and
  // recorded the loss. Holding the placement client's promise open restages
  // it: while two solves are pending, the third must be answered without a
  // third call being made, and when they settle each must carry ITS OWN board.
  it("holds two solves in flight, refuses the third before the client, and crosses neither board", async () => {
    // The same corner as `cornerConfig` above (greedy places one card of two,
    // a solver places both), plus a disjoint mirror of it. Two DIFFERENT
    // inputs on purpose: two calls given the same board would satisfy a
    // crossed pair, which is exactly the corruption a shared-nothing claim
    // has to rule out.
    const mirrorConfig = cfg({
      sessionWindows: [{ from: T0, to: T0 + 60 * MIN }],
      constraints: cons({ startWindows: [{ target: { kind: "entrant", id: "F3" }, notAfter: T0 }] }),
    });
    const mirrorFixtures = [fx("c", "F1", "F2"), fx("d", "F3", "F4")];

    /** Ids sorted: the START-WINDOWED fixture (`b`, `d`) sorts SECOND in both
     *  boards, so one rule serves both — it takes T0, the other takes the
     *  30-minute slot. That is the shape `build.test.ts` measured for this
     *  corner; the alphabetical coincidence is why one helper covers both,
     *  and a third board added here must check it still holds. */
    const boardFor = (ids: string[]): SolveBuildOutcome => ({
      assignments: [
        { fixtureId: ids[1]!, court: "C1", startAtMs: T0 },
        { fixtureId: ids[0]!, court: "C1", startAtMs: T0 + 30 * MIN },
      ],
      status: "OPTIMAL",
      tiersCompleted: TIER_COUNT,
      objectiveValues: provedTiers(),
      elapsedMs: 5,
      wallExhausted: false,
    });

    /** Calls parked inside the client, newest last. Released by hand. */
    const parked: (() => void)[] = [];
    /** Every request the client actually received, by fixture id. */
    const seen: string[] = [];
    let openGate = false;
    const release = (): void => {
      openGate = true;
      for (const resume of parked.splice(0)) resume();
    };

    const spy = vi
      .spyOn(await import("./placement-client.ts"), "solveBuild")
      .mockImplementation((input: SolveBuildInput) => {
        const ids = input.fixtures.map((f) => f.fixtureId).sort();
        seen.push(ids.join(""));
        // Keyed off the REQUEST, never off arrival order — an order-keyed stub
        // hands back the right boards even when the caller/board pairing is
        // wrong, which is the failure this case exists to catch.
        if (openGate) return Promise.resolve(boardFor(ids));
        return new Promise<SolveBuildOutcome>((resolve) => {
          parked.push(() => resolve(boardFor(ids)));
        });
      });

    const first = buildSchedule({ fixtures: cornerFixtures, config: cornerConfig });
    const second = buildSchedule({ fixtures: mirrorFixtures, config: mirrorConfig });
    void first.catch(() => undefined);
    void second.catch(() => undefined);
    try {
      // Both are inside the client — polled, not slept: how long the seed and
      // the grid take before the call is not this case's claim.
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2), { timeout: 30_000 });

      // RACED rather than plainly awaited, and the race is the failure mode's
      // shape, not a speed threshold: a third call that joined the queue
      // instead of being refused cannot settle at all while the client is held
      // open, so without this the mutant that removes the cap fails by burning
      // the whole test timeout instead of by saying what went wrong.
      const thirdCall = buildSchedule({ fixtures: cornerFixtures, config: cornerConfig });
      void thirdCall.catch(() => undefined);
      const third = await Promise.race([
        thirdCall.then((result) => ({ kind: "settled" as const, result })),
        new Promise<{ kind: "pending" }>((resolve) => {
          setTimeout(() => resolve({ kind: "pending" }), 10_000).unref?.();
        }),
      ]);
      expect(third.kind).toBe("settled");
      if (third.kind !== "settled") throw new Error("unreachable");
      expect(third.result.status).toBe("solver_busy");
      expect(third.result.engine).toBe("greedy");
      // THE FACT THIS CASE ADDS: the refusal was answered without a third
      // request. A cap that queued instead of refusing would show 3 here even
      // though the status above still read `solver_busy` eventually.
      expect(spy).toHaveBeenCalledTimes(2);
      // …and it was answered while the other two were genuinely stuck, which
      // is what stops this passing on a run where they had already finished.
      // Structural, not timed: the client's promise cannot settle until
      // `release()` below, so any wait at all would be a wait forever.
      expect(await settledWithin(first, 50)).toBe(false);
      expect(await settledWithin(second, 50)).toBe(false);

      release();
      const [a, b] = await Promise.all([first, second]);
      // Each got the solver's board, not a greedy fallback — 2 placed where
      // greedy reaches 1 — and got its OWN.
      expect(a.engine).toBe("optimized");
      expect(b.engine).toBe("optimized");
      expect(a.assignments.map((x) => x.fixtureId).sort()).toEqual(["a", "b"]);
      expect(b.assignments.map((x) => x.fixtureId).sort()).toEqual(["c", "d"]);
      expect(seen.sort()).toEqual(["ab", "cd"]);

      // The slots were freed, and freed by the SOLVES settling rather than by
      // the refusal: a fourth call is admitted and reaches the client.
      const fourth = await buildSchedule({ fixtures: cornerFixtures, config: cornerConfig });
      expect(fourth.status).not.toBe("solver_busy");
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      // Whatever failed above, nothing may be left parked: `queued` is module
      // state and `isolate: false` shares it across every file in this worker,
      // so a build left in flight refuses the rest of the run's builds.
      release();
      await Promise.allSettled([first, second]);
      spy.mockRestore();
    }
  }, 120_000);
});

// Task 06 — solveBuild now calls the placement service instead of z3. Every case
// here mocks `placement-client.ts`'s `solveBuild` via `vi.spyOn(await
// import(...))`, never `vi.doMock`: the recorded trap in this repo is that
// `vi.doMock` (and this spy form too) is INERT if `build.ts` imports the
// module STATICALLY, and it has previously passed 5/5 with the guard
// deleted. `build.ts` loads `placement-client.ts` dynamically at the call site
// for exactly this reason — see the comment there.
describe("buildSchedule — Placement path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const minimalInput = (over: Partial<BuildInput> = {}): BuildInput => ({
    fixtures: [fx("f1", "E1", "E2")],
    config: cfg(),
    ...over,
  });

  const okOutcome = (assignments: SolveBuildOutcome["assignments"] = []): SolveBuildOutcome => ({
    assignments,
    status: "OPTIMAL",
    tiersCompleted: TIER_COUNT,
    objectiveValues: provedTiers(),
    elapsedMs: 1200,
    wallExhausted: false,
  });

  it("uses the Placement client and returns a verified board", async () => {
    // `minimalInput()`'s trivial one-fixture board is the WRONG fixture for
    // this test now that D6 ("never worse than greedy") is enforced: greedy
    // already places a single unconstrained fixture optimally, so a mocked
    // reply that also places it at the same slot TIES the seed rather than
    // beating it, and the D6 gate correctly falls back to greedy — which
    // used to read as "placement wired up" only because nothing checked. Reused
    // instead: `cornerConfig`/`cornerFixtures`, MEASURED (see the file
    // header) to place only 1 of 2 via greedy and 2 of 2 via a real solve
    // (`[b@C1+0, a@C1+30]`) — a genuine, provable improvement, mocked here
    // rather than solved for real.
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue(
      okOutcome([
        { fixtureId: "b", court: "C1", startAtMs: T0 },
        { fixtureId: "a", court: "C1", startAtMs: T0 + 30 * MIN },
      ]),
    );
    const result = await buildSchedule({ fixtures: cornerFixtures, config: cornerConfig });
    expect(result.engine).toBe("optimized");
    expect(result.assignments).toHaveLength(2);
    // proves `validateAssignments` still ran over the placement board — the
    // verifier never moves, it just gets handed a different engine's board.
    expect(result.conflicts).toHaveLength(0);
  });

  it("falls back to the greedy floor when placement's own board is not strictly better (D6)", async () => {
    // D6 ("never worse than greedy") is not structural here the way it was
    // for z3 — z3's own incumbent started AS the seed and was only ever
    // replaced inside an `isStrictlyBetter` check, so a regression was not
    // reachable by construction. placement returns one finished board over a
    // single RPC with nothing upstream comparing it to anything, so a
    // starved or merely-suboptimal reply has to be caught explicitly. Mocked
    // here as a reply that places NOTHING — a legitimate shape for a
    // FEASIBLE/UNKNOWN verdict that ran out of budget mid-search — against
    // `cornerConfig`/`cornerFixtures`, whose greedy floor places 1 of 2. 0
    // placed is strictly WORSE than greedy's 1, so the seed must ship, not
    // the empty board placement actually returned.
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue(
      okOutcome([]),
    );
    const result = await buildSchedule({ fixtures: cornerFixtures, config: cornerConfig });
    expect(result.engine).toBe("greedy");
    expect(result.assignments.map((a) => a.fixtureId)).toEqual(["a"]);
    expect(result.metrics.placed).toBe(1);
  });

  it("falls back to greedy on a Placement rejection, exactly like a z3 gate-reject", async () => {
    const rejection = new Error("placement solveBuild exceeded deadline");
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockRejectedValue(rejection);
    const spy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const result = await buildSchedule(minimalInput());
    expect(result.engine).toBe("greedy");
    expect(result.assignments.map((a) => a.fixtureId)).toEqual(["f1"]);
    // A plain (non-PlacementError) rejection — an unclassified bug at the call
    // site is no less untrustworthy than a classified one, so it gets the
    // same status, not the old `not_searched`.
    expect(result.status).toBe("solver_unavailable");
    // Regression test for the placement-unavailable catch in `build.ts`:
    // before structured logging landed, this branch discarded `err`
    // completely (`catch {`), so a misconfigured shared secret presented as
    // "placement is slow" with nothing anywhere naming the actual cause.
    // Curated fields, not the raw `Error` object — see the log call's own
    // comment — so this asserts on `message`/`failure`, not `err` itself.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      failure: undefined,
      message: rejection.message,
    });
    expect(spy.mock.calls[0]?.[1]).toContain("placement service unavailable");
  });

  it("logs the PlacementError's own `failure` reason when the rejection carries one", async () => {
    const rejection = Object.assign(new Error("placement solveBuild failed: UNAUTHENTICATED"), {
      name: "PlacementError",
      failure: "unauthenticated",
    });
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockRejectedValue(rejection);
    const spy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    await buildSchedule(minimalInput());
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      failure: "unauthenticated",
      message: rejection.message,
    });
  });

  // Coordinator follow-up (found preparing Task 07): the try/catch around
  // `placementClient.solveBuild` swallows every PROMISE REJECTION into one
  // fallback — a different path from the `ERROR`-status split above, which
  // only covers a RESOLVED outcome. `PlacementError["failure"]`
  // (`placement-client.ts`'s `failureFor`) has five members, and all five land
  // on `solver_unavailable` HERE — never `solver_busy`, which promises a
  // retry will help and is true of exactly one cause (`SOLVER_BUSY`, the
  // `ERROR`-status path above). Applying the SAME "does a retry obviously
  // help" test to each:
  //
  //   * `unavailable`/`transport`/`deadline` — a genuine outage or a
  //     service that stopped answering; no promise a retry fixes it.
  //   * `invalid_request` — the SHARPEST case: retrying an identical
  //     malformed request fails identically every time, so this is if
  //     anything a WORSE candidate for "try again" than an outage.
  //   * `unauthenticated` — an operator misconfiguration (the shared
  //     secret unset or wrong on one of the two apps — `DEPLOY.md`'s own
  //     read of the single most likely first-deploy failure), not a solver
  //     condition an organiser's retry can fix at all. No new user-facing
  //     string exists to say so more precisely, so it is NOT invented here
  //     — this status is reused and the gap is named in this task's report
  //     for whoever owns an operator-visible signal later.
  it.each([
    "invalid_request",
    "deadline",
    "unauthenticated",
    "unavailable",
    "transport",
  ] as const)("maps a rejected PlacementError(%s) to solver_unavailable, never solver_busy", async (failure) => {
    const { PlacementError } = await import("./placement-client.ts");
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockRejectedValue(
      new PlacementError(failure, `synthetic ${failure} for the mapping test`),
    );
    const result = await buildSchedule(minimalInput());
    expect(result.engine).toBe("greedy");
    expect(result.status).toBe("solver_unavailable");
    expect(result.status).not.toBe("solver_busy");
  });

  it("reports a board Placement itself marks ERROR the same way as a rejection — never trusted, and defaults to solver_unavailable", async () => {
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [{ fixtureId: "f1", court: "C1", startAtMs: T0 }],
      status: "ERROR",
      tiersCompleted: 0,
      objectiveValues: [],
      elapsedMs: 5,
      wallExhausted: false,
      error: { code: "internal", message: "boom" },
    });
    const result = await buildSchedule(minimalInput());
    expect(result.engine).toBe("greedy");
    // "internal" is not "SOLVER_BUSY", so this is the DEFAULT arm — a genuine
    // outage, not admission-control contention (Task 06b, Correction 2).
    expect(result.status).toBe("solver_unavailable");
  });

  // Task 06b, Correction 2: `SOLVER_BUSY` must NOT map to `solver_unavailable`.
  // Task 08 pinned `PLACEMENT_MAX_WORKERS=1` in `fly.toml` to hold worst-case
  // thread contention at 8-on-2-vCPU, which makes two organisers clicking
  // Auto-schedule at once an ORDINARY-traffic path into `SOLVER_BUSY`
  // (`schema.py`'s `error_response("SOLVER_BUSY", ...)`, called from
  // `main.py`'s admission control), not a rare fault — a retry helps here,
  // unlike a genuine outage, so it must land on the EXISTING `solver_busy`
  // (`build.ts:369`, `result-strip.tsx`'s `statusKey` already handles it),
  // never the new `solver_unavailable`.
  it("maps ERROR + error.code SOLVER_BUSY to the existing solver_busy, not the new solver_unavailable", async () => {
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [],
      status: "ERROR",
      tiersCompleted: 0,
      objectiveValues: [],
      elapsedMs: 5,
      wallExhausted: false,
      error: { code: "SOLVER_BUSY", message: "admission control refused a concurrent solve" },
    });
    const result = await buildSchedule(minimalInput());
    expect(result.engine).toBe("greedy");
    expect(result.status).toBe("solver_busy");
    expect(result.status).not.toBe("solver_unavailable");
  });

  // `UNKNOWN` is the one wire status this function had NO case for at all —
  // it fell through into the tiersCompleted-based ok/already_optimal
  // derivation below and reported "ok" (0 !== TIER_COUNT). That is an
  // invented verdict: `objective.py`'s `_chain_status` returns a raw
  // solver-status name (UNKNOWN here) ONLY on its `if not assignments`
  // path — a mapped status (OPTIMAL/FEASIBLE) is returned whenever there IS
  // a board — so `tiersCompleted` is always 0 here and this outcome can
  // never legitimately reach `already_optimal` either. `cornerFixtures`/
  // `cornerConfig` (measured: greedy places 1 of 2, `[a]`) proves the
  // GREEDY FLOOR still ships, not an empty board and not a fabricated proof.
  it("maps an UNKNOWN outcome (the chain proved nothing) to not_searched, not ok", async () => {
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue({
      assignments: [],
      status: "UNKNOWN",
      tiersCompleted: 0,
      objectiveValues: [],
      elapsedMs: 5,
      wallExhausted: true,
    });
    const result = await buildSchedule({ fixtures: cornerFixtures, config: cornerConfig });
    expect(result.engine).toBe("greedy");
    expect(result.status).toBe("not_searched");
    expect(result.status).not.toBe("ok");
    expect(result.budgetExpired).toBe(true);
    expect(result.assignments.map((a) => a.fixtureId)).toEqual(["a"]);
  });

  it("derives a dense dayIndex matching the verifier's own dayKeyInTz bucketing (obligation 1)", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    await buildSchedule(
      minimalInput({ config: cfg({ window: { from: T0, to: T0 + 28 * 60 * MIN } }) }),
    );
    expect(captured).toBeDefined();
    const slots = captured!.grid.slots;
    expect(slots.length).toBeGreaterThan(0);
    const dayIndexByKey = new Map<string, number>();
    for (const s of slots) {
      const key = dayKeyInTz(s.startAtMs, "Europe/London");
      const seen = dayIndexByKey.get(key);
      if (seen === undefined) dayIndexByKey.set(key, s.dayIndex);
      // Same real calendar day must always get the SAME index.
      else expect(s.dayIndex).toBe(seen);
    }
    // The 28h window actually crosses a real midnight in Europe/London.
    expect(dayIndexByKey.size).toBeGreaterThanOrEqual(2);
    // Dense 0..n-1, and no two distinct days collide on one index.
    const values = [...dayIndexByKey.values()];
    expect(new Set(values).size).toBe(values.length);
    expect([...values].sort((a, b) => a - b)).toEqual(values.map((_, i) => i));
  });

  it("sends dayIndex 0 for every slot and omits maxFixturesPerDay from every rule group when tz is undefined (obligation 1)", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    const config = {
      ...cfg({ window: { from: T0, to: T0 + 28 * 60 * MIN } }),
      tz: undefined,
      hard: [
        { type: "max_fixtures_per_day" as const, count: 1, scope: { kind: "division" as const, divisionId: "D1" } },
      ],
    };
    await buildSchedule(
      minimalInput({ fixtures: [fx("f1", "E1", "E2", { divisionId: "D1" })], config }),
    );
    expect(captured).toBeDefined();
    expect(captured!.grid.slots.length).toBeGreaterThan(0);
    expect(captured!.grid.slots.every((s) => s.dayIndex === 0)).toBe(true);
    // The rule group still ships (never dropped), just without the one field
    // that would bind against a fabricated day -- `constraints.dayCapByDivision`
    // (the OLDER, division-only field this obligation used to be checked
    // against) is retired; `ruleGroups` is the only day-cap path left.
    expect(captured!.ruleGroups).toEqual([
      { fixtureIds: ["f1"], minRestMinutes: undefined, maxFixturesPerDay: undefined },
    ]);
  });

  // C10 (2026-08-16, wire person indices design). Before this task,
  // `placementInput.fixtures` never carried `people` at all -- `toRequest()`
  // (`placement-client.ts`) gaining a `personIndices` field would still have
  // sent nothing, because this call site never forwarded the data to send.
  // This is the OTHER half of the fix the brief's own scouting understated
  // (see the PR body): `placement-client.ts` gaining the field is necessary
  // but not sufficient without this.
  it("forwards a fixture's people onto the wire, as data separate from entrantIds (C10)", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    await buildSchedule(
      minimalInput({ fixtures: [fx("f1", "E1", "E2", { people: ["p1", "p2"] })] }),
    );
    expect(captured).toBeDefined();
    expect(captured!.fixtures).toEqual([
      { fixtureId: "f1", entrantIds: ["E1", "E2"], divisionId: "", roundNo: 1, people: ["p1", "p2"] },
    ]);
  });

  // The undecided-knockout-slot shape itself: no entrants at all, but people
  // — the exact case the pre-C10 wire could not express. `fx` requires
  // `home`/`away` positionally, so they are overridden back to `undefined`
  // via `over` (`SchedulableFixture.home`/`.away` are themselves optional).
  it("forwards people for a fixture with no entrants at all (an undecided knockout slot)", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    await buildSchedule(
      minimalInput({
        fixtures: [
          fx("f1", "E1", "E2", { home: undefined, away: undefined, people: ["p1", "p2", "p3", "p4"] }),
        ],
      }),
    );
    expect(captured).toBeDefined();
    expect(captured!.fixtures).toEqual([
      { fixtureId: "f1", entrantIds: [], divisionId: "", roundNo: 1, people: ["p1", "p2", "p3", "p4"] },
    ]);
  });

  // The default case must stay an empty array, not `undefined` — the
  // generated encoder needs an iterable, and an omitted `people` on
  // `SchedulableFixture` is the overwhelming majority of fixtures (an
  // ordinary, fully-resolved fixture with no cross-registration/undecided-
  // slot concern at all).
  it("sends an empty people array, not undefined, when a fixture carries none", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    await buildSchedule(minimalInput());
    expect(captured).toBeDefined();
    expect(captured!.fixtures[0]?.people).toEqual([]);
  });

  it("derives a rule group's maxFixturesPerDay from a division-scoped max_fixtures_per_day hard rule", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    const config = {
      ...cfg(),
      hard: [
        { type: "max_fixtures_per_day" as const, count: 2, scope: { kind: "division" as const, divisionId: "D1" } },
      ],
    };
    await buildSchedule(
      minimalInput({ fixtures: [fx("f1", "E1", "E2", { divisionId: "D1" })], config }),
    );
    // `constraints.dayCapByDivision` (the OLDER, division-only field this used
    // to be checked against) is retired; `ruleGroups` is the only path left.
    expect(captured!.ruleGroups).toEqual([
      { fixtureIds: ["f1"], minRestMinutes: undefined, maxFixturesPerDay: 2 },
    ]);
  });

  // The regression test for the retirement itself: `division_rules` (proto
  // field 10) is gone, and so are `SolveBuildInput["constraints"].
  // restByDivision`/`dayCapByDivision`, the two fields that used to feed it
  // (`placement-client.ts`'s now-deleted `toDivisionRules`). This runs a
  // board that WOULD have populated both under the old contract -- a
  // division-scoped rest AND a division-scoped day cap, on the same fixture
  // -- so a regression that resurrected either field (a stray `as any`
  // spread, say) would be caught here even though the TYPE alone already
  // makes the obvious mistake a compile error.
  it("emits no divisionRules field and no constraints.restByDivision/dayCapByDivision", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    const hard: HardConstraint[] = [
      { type: "max_fixtures_per_day", count: 2, scope: { kind: "division", divisionId: "D1" } },
    ];
    const config = { ...cfg(), hard, restByDivision: { D1: 30 } };
    await buildSchedule(
      minimalInput({ fixtures: [fx("f1", "E1", "E2", { divisionId: "D1" })], config }),
    );
    expect(captured).toBeDefined();
    expect(captured).not.toHaveProperty("divisionRules");
    expect(Object.keys(captured!.constraints).sort()).toEqual(["gapMinutes", "matchMinutes"]);
    // The board genuinely carried both a rest AND a cap for this division —
    // otherwise the property-absence checks above could pass by having
    // nothing to drop in the first place.
    expect(captured!.ruleGroups!.length).toBeGreaterThan(0);
  });

  it("splits a locked fixture into an existing row and excludes it from fixtures (obligation 3)", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome([{ fixtureId: "free", court: "C1", startAtMs: T0 + 30 * MIN }]);
    });
    const locked = { court: "C1", startAt: T0 };
    const result = await buildSchedule(
      minimalInput({
        fixtures: [fx("pinned", "E1", "E2", { locked }), fx("free", "E3", "E4")],
      }),
    );
    expect(captured).toBeDefined();
    // The pinned fixture must NOT be one of the fixtures placement is asked to
    // place — sending it there too is exactly what silently un-pins it
    // (measured 5/5 under the string contract: it comes back placed a SECOND
    // time, elsewhere, OPTIMAL, no error).
    expect(captured!.fixtures.map((f) => f.fixtureId)).toEqual(["free"]);
    expect(
      captured!.existing.some((e) => e.court === "C1" && e.startAtMs === T0),
    ).toBe(true);
    // And it must still come back on the final board, at its pinned slot —
    // the split must not just protect placement's request, it must not lose the
    // card either.
    const pinnedRow = result.assignments.find((a) => a.fixtureId === "pinned");
    expect(pinnedRow?.court).toBe("C1");
    expect(pinnedRow?.startAt).toBe(T0);
    expect(result.conflicts).toHaveLength(0);
  });

  it("sends a per-court blackout board to Placement instead of routing it to greedy (task C2)", async () => {
    // Obligation 5 used to refuse this exact grid before ever calling
    // Placement (`everyCourtSharesGrid` in `build.ts`, gated on
    // `not_searched`/`per_court_grid`) -- gone now that
    // `placement.model.build_model` enforces each court's own tick set
    // directly. This is the INVERSE of the test it replaces: it proves the
    // client IS reached, not that it is skipped. See
    // `build-rest-lattice.test.ts`'s sibling test (the same regression,
    // proven with real asymmetric grid slots reaching the mock) and
    // `placement-cutover.spec.ts`'s e2e test (the same regression, against a
    // live, unmocked service) for the fuller picture this one unit doesn't
    // need to carry alone.
    const spy = vi
      .spyOn(await import("./placement-client.ts"), "solveBuild")
      .mockResolvedValue(okOutcome([{ fixtureId: "f1", court: "C1", startAtMs: T0 }]));
    const config = cfg({
      courts: ["C1", "C2"],
      window: { from: T0, to: T0 + 120 * MIN },
      blackouts: [{ court: "C1", from: T0 + 90 * MIN, to: T0 + 120 * MIN }],
    });
    const result = await buildSchedule(minimalInput({ config }));
    expect(spy).toHaveBeenCalledOnce();
    // The mocked reply ties greedy's own placement of the single, otherwise
    // unconstrained fixture (both land it on C1 at T0, the earliest legal
    // tick), so the honest verdict is a proved tie, not a refusal.
    expect(result.status).toBe("already_optimal");
    expect(result.notSearchedReason).toBeUndefined();
    expect(result.assignments).toHaveLength(1);
  });

  // #21 (C1/C4/C6) — `ruleGroups`, and pinned rows' `entrantIds`/
  // `ruleGroupIndices`. ANTI-CORRUPTION LAYER ONLY: the domain does not read
  // any of these three fields this round (`schema.py`'s module docstring,
  // "no model, no behaviour change"), so every case below is about what
  // `build.ts` SENDS — never about what a mocked `solveBuild` reply does with
  // it, which would be unable to tell the difference either way.

  /** The scope kinds `buildRuleGroups` has a STATED wire representation for.
   *
   *  Exists because the anti-fork assertion below cannot speak for a scope
   *  whose semantics are "each X separately". Two independent reasons, and
   *  both survive adding a row to that test's `scopes` array:
   *
   *  1. That array is hand-listed, and its own length is the count assertion —
   *     so a new `ConstraintScope` member is untested there rather than red.
   *  2. Its expectation is `fixtures.filter(f => scopeCoversFixture(...))`,
   *     the same function the code under test calls. A universal scope answers
   *     `true` for every fixture, so expected and produced would BOTH be the
   *     whole board and the comparison passes — while the emitted `RuleGroup`
   *     caps the day competition-wide instead of per entity, which is the
   *     misreading `PARSER_PROMPT` rule 8 exists to prevent.
   *
   *  So this is driven off `ConstraintScope.options` — the union itself —
   *  rather than off `scopeCoversFixture`. A member added without a decision
   *  about its wire shape fails HERE, immediately, instead of shipping a
   *  competition-wide cap that every existing test calls correct. */
  const WIRE_STATED_SCOPE_KINDS: ReadonlySet<ConstraintScope["kind"]> = new Set([
    "competition",
    "division",
    "entrant",
    "person",
    "pool",
    // Stated as an EXPANSION, not as a scope: `buildRuleGroups` emits one
    // `RuleGroup` per entity rather than one holding every fixture. The wire
    // has no scope field by design (`proto/scheduler.proto`), and one group
    // over the whole board would be a competition-wide cap.
    "every_entrant",
    "every_person",
  ]);

  it("states a wire representation for every ConstraintScope member", () => {
    // No cast: zod types `.value` as the literal, so the union drives this list
    // rather than a copy of it that can drift.
    const declared = ConstraintScope.options.map((o) => o.shape.kind.value);
    expect([...declared].sort()).toEqual([...WIRE_STATED_SCOPE_KINDS].sort());
  });

  it("expands a universal scope into one RuleGroup per entity, not one over the board", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });

    // Three cards, six distinct entrants, nobody shared.
    const fixtures = [
      fx("f1", "E1", "E2", { divisionId: "D1", people: ["alice", "bob"] }),
      fx("f2", "E3", "E4", { divisionId: "D1", people: ["carol", "dave"] }),
      fx("f3", "E5", "E6", { divisionId: "D1", people: ["erin", "frank"] }),
    ];
    const hard: HardConstraint[] = [
      { type: "max_fixtures_per_day", count: 2, scope: { kind: "every_entrant" } },
    ];

    await buildSchedule({ fixtures, config: { ...cfg(), hard } });
    expect(captured).toBeDefined();

    // ONE group per entrant, not one group holding all three fixtures. The
    // latter is what a fixture-set resolution of a universal scope produces,
    // and it caps the whole competition at two a day instead of each entrant.
    expect(captured!.ruleGroups).toHaveLength(6);
    for (const g of captured!.ruleGroups!) {
      expect(g.maxFixturesPerDay).toBe(2);
      // Each entrant is on exactly one card here, so any group holding more
      // than one fixture means the expansion collapsed back to a board-wide set.
      expect(g.fixtureIds).toHaveLength(1);
    }
    // Every fixture is covered, each by two groups (its two entrants).
    expect(captured!.ruleGroups!.flatMap((g) => g.fixtureIds).sort()).toEqual([
      "f1", "f1", "f2", "f2", "f3", "f3",
    ]);
  });

  it("expands every_person across entrants, catching the player in two divisions", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });

    // `alice` plays for E1 in D1 and for E3 in D2 — two entrants, one human.
    // Her group must hold BOTH cards; an entrant-shaped expansion would split
    // them across two groups and never see that she plays twice.
    const fixtures = [
      fx("f1", "E1", "E2", { divisionId: "D1", people: ["alice", "bob"] }),
      fx("f2", "E3", "E4", { divisionId: "D2", people: ["alice", "carol"] }),
    ];
    const hard: HardConstraint[] = [
      { type: "max_fixtures_per_day", count: 1, scope: { kind: "every_person" } },
    ];

    await buildSchedule({ fixtures, config: { ...cfg(), hard } });
    expect(captured).toBeDefined();

    const groups = captured!.ruleGroups!;
    // alice, bob, carol — one group each.
    expect(groups).toHaveLength(3);
    const sizes = groups.map((g) => g.fixtureIds.slice().sort()).sort((a, b) => b.length - a.length);
    expect(sizes[0]).toEqual(["f1", "f2"]); // alice, spanning both divisions
    expect(sizes[1]).toHaveLength(1);
    expect(sizes[2]).toHaveLength(1);
  });

  // THE ANTI-FORK ASSERTION. Written as a comparison against
  // `scopeCoversFixture` itself, not a hand-listed set: the row shape below is
  // built directly from the raw `SchedulableFixture`s, independently of
  // `build.ts`'s own (private) `scopeRowOf`, so a bug in THAT derivation (say,
  // swapping `poolId`/`divisionId`, or dropping `people`) is exactly what this
  // test is positioned to catch, and a re-implementation of the scope switch
  // inside `buildRuleGroups` instead of calling the shared function would stop
  // this comparing against the real thing.
  it("derives a rule group's fixture set from scopeCoversFixture itself, for every scope kind", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });

    const fixtures = [
      fx("f1", "E1", "E2", { divisionId: "D1", poolId: "P1", people: ["alice"] }),
      fx("f2", "E3", "E4", { divisionId: "D1", poolId: "P2", people: ["bob"] }),
      fx("f3", "E1", "E5", { divisionId: "D2", people: ["alice", "carol"] }),
    ];
    const scopes = [
      { kind: "competition" as const },
      { kind: "division" as const, divisionId: "D1" },
      { kind: "pool" as const, divisionId: "D1", pool: "P1" },
      { kind: "entrant" as const, entrantId: "E1" },
      { kind: "person" as const, personKey: "alice" },
    ];
    const hard: HardConstraint[] = scopes.map((scope) => ({
      type: "min_rest_minutes",
      minutes: 30,
      rest_scope: "per_person",
      scope,
    }));
    const config = { ...cfg(), hard };

    await buildSchedule({ fixtures, config });
    expect(captured).toBeDefined();
    expect(captured!.ruleGroups).toHaveLength(scopes.length);

    const rowOf = (f: SchedulableFixture): ScopeRow => ({
      entrants: [f.home, f.away].filter((e): e is string => e !== undefined),
      people: [...(f.people ?? [])],
      ...(f.poolId !== undefined ? { poolId: f.poolId } : {}),
      ...(f.divisionId !== undefined ? { divisionId: f.divisionId } : {}),
    });
    scopes.forEach((scope, i) => {
      const expectedIds = fixtures.filter((f) => scopeCoversFixture(scope, undefined, rowOf(f))).map((f) => f.id);
      expect(captured!.ruleGroups![i]!.fixtureIds.slice().sort()).toEqual(expectedIds.slice().sort());
    });
    // The premise, so the per-scope loop above is not vacuously comparing
    // empty arrays to empty arrays: at least one scope must select a STRICT
    // subset of the three fixtures.
    expect(captured!.ruleGroups!.some((g) => g.fixtureIds.length > 0 && g.fixtureIds.length < 3)).toBe(true);
  });

  // The brief's original requirement, from when `dayCapsByDivision` (build.ts)
  // still fed the wire's OLD, division-only field alongside `ruleGroups`:
  // "Today dayCapsByDivision drops every scope that is not division — the
  // new path must NOT." That field and the function feeding it are retired
  // (`dayCapsByDivision` generalised nothing `ruleGroups`' own typed-rule
  // pass did not already derive from the same `hard` array), so this is now
  // simply the proof that a competition-scoped rule reaches `ruleGroups` —
  // a scope the OLD, division-only field could never have carried at all.
  it("sends a competition-scoped max_fixtures_per_day rule via ruleGroups, covering every division", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    const fixtures = [fx("f1", "E1", "E2", { divisionId: "D1" }), fx("f2", "E3", "E4", { divisionId: "D2" })];
    const hard: HardConstraint[] = [
      { type: "max_fixtures_per_day", count: 3, scope: { kind: "competition" } },
    ];
    const config = { ...cfg(), hard };

    await buildSchedule({ fixtures, config });
    expect(captured).toBeDefined();
    expect(captured!.ruleGroups).toEqual([
      { fixtureIds: ["f1", "f2"], minRestMinutes: undefined, maxFixturesPerDay: 3 },
    ]);
  });

  // C4's "EMPTY IS A REAL ANSWER, not a missing one" (proto comment) has a
  // sharp edge: if an empty-fixtureIds group were DROPPED instead of kept, a
  // later group's array position would shift, and a pinned row's
  // `ruleGroupIndices` (which names a position, not an id) would silently
  // start pointing at the WRONG rule. This proves both halves survive it: the
  // empty group stays at position 0, and BOTH an obstacle (`existing`) and
  // this run's own pinned fixture correctly reference positions 0 and 1.
  it("keeps an empty-fixture-set rule group at its own array position, and attributes both an obstacle and a pin to it", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    const locked = { court: "C1", startAt: T0 };
    const fixtures = [fx("pinned", "E1", "E2", { divisionId: "D9", locked })];
    // Another division's card, already on the board — never a movable
    // fixture placement is asked to place at all.
    const obstacle: Assignment = {
      fixtureId: "other-div",
      court: "C1",
      startAt: T0 + 90 * MIN,
      endAt: T0 + 120 * MIN,
      entrants: ["E9"],
      people: [],
      divisionId: "D8",
    };
    const hard: HardConstraint[] = [
      // Matches no FREE fixture — the only fixture in this run is pinned, so
      // `freeFixtures` is empty — but must still be a real group at position
      // 0, not dropped.
      { type: "min_rest_minutes", minutes: 15, rest_scope: "per_person", scope: { kind: "competition" } },
      // Position 1 — would silently become 0 if the empty group above were
      // dropped instead of kept.
      { type: "max_fixtures_per_day", count: 2, scope: { kind: "division", divisionId: "D9" } },
    ];
    const config = { ...cfg(), hard };

    await buildSchedule({ fixtures, config, existing: [obstacle] });
    expect(captured).toBeDefined();
    expect(captured!.ruleGroups).toEqual([
      { fixtureIds: [], minRestMinutes: 15, maxFixturesPerDay: undefined },
      { fixtureIds: [], minRestMinutes: undefined, maxFixturesPerDay: 2 },
    ]);

    const byCourtTime = new Map(captured!.existing.map((e) => [`${e.court}@${e.startAtMs}`, e]));
    // The pin: division D9 (matches rule 1) AND the competition scope
    // (matches rule 0, which covers everything) — both, at their real
    // positions.
    expect(byCourtTime.get(`C1@${T0}`)).toEqual({
      fixtureId: "pinned",
      court: "C1",
      startAtMs: T0,
      entrantIds: ["E1", "E2"],
      ruleGroupIndices: [0, 1],
    });
    // The obstacle: division D8, so only the competition-scoped rule 0 covers it.
    expect(byCourtTime.get(`C1@${T0 + 90 * MIN}`)).toEqual({
      fixtureId: "other-div",
      court: "C1",
      startAtMs: T0 + 90 * MIN,
      entrantIds: ["E9"],
      ruleGroupIndices: [0],
    });
  });

  // `build.ts`'s own half of the no-behaviour-change proof. The DEEP proof —
  // that the SOLVED BOARD is unaffected — lives in `schema.py`'s
  // `test_populating_the_new_fields_does_not_change_the_board`, because
  // `solveBuild` is MOCKED in this file: a "same assignments" assertion
  // against a canned mock reply cannot fail no matter what request was built,
  // so it would not be the load-bearing test the brief asks for and is
  // deliberately NOT duplicated here. What CAN genuinely fail at this layer,
  // and is this module's own job to guard, is that adding `ruleGroups` /
  // pinned `entrantIds`/`ruleGroupIndices` did not also perturb any of the
  // OTHER fields the domain actually reads.
  it("leaves every pre-#21 field of the request unchanged whether ruleGroups is populated or not", async () => {
    const capture = async (hard: HardConstraint[] | undefined): Promise<SolveBuildInput> => {
      let captured: SolveBuildInput | undefined;
      vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
        captured = input;
        return okOutcome();
      });
      const fixtures = [
        fx("f1", "E1", "E2", { divisionId: "D1" }),
        fx("f2", "E3", "E4", { divisionId: "D1", locked: { court: "C1", startAt: T0 } }),
      ];
      const config = { ...cfg(), ...(hard !== undefined ? { hard } : {}) };
      await buildSchedule({ fixtures, config });
      vi.restoreAllMocks();
      return captured!;
    };

    const without = await capture(undefined);
    const populated = await capture([
      { type: "min_rest_minutes", minutes: 20, rest_scope: "per_person", scope: { kind: "competition" } },
      { type: "max_fixtures_per_day", count: 4, scope: { kind: "entrant", entrantId: "E1" } },
    ]);

    // First: the new fields really did differ, so the equality checks below
    // are not vacuously comparing two identical requests.
    expect(populated.ruleGroups).not.toEqual(without.ruleGroups);
    expect(populated.existing[0]!.ruleGroupIndices).not.toEqual(without.existing[0]!.ruleGroupIndices);

    // Second, the actual claim: every OTHER field — the ones `build_model`
    // will read once it exists, and today the only ones ANY server reads — is
    // byte-identical.
    expect(populated.courts).toEqual(without.courts);
    expect(populated.fixtures).toEqual(without.fixtures);
    expect(populated.grid).toEqual(without.grid);
    expect(populated.dependencies).toEqual(without.dependencies);
    expect(populated.constraints.matchMinutes).toEqual(without.constraints.matchMinutes);
    expect(populated.constraints.gapMinutes).toEqual(without.constraints.gapMinutes);
    // `constraints.restByDivision`/`dayCapByDivision` used to be compared here
    // too; both are retired (`division_rules`, proto field 10) and no longer
    // exist on `constraints` at all -- there is nothing left to compare.
    expect(populated.wallSeconds).toEqual(without.wallSeconds);
    // `existing` minus the one field that is SUPPOSED to differ.
    expect(populated.existing.map(({ ruleGroupIndices: _rgi, ...rest }) => rest)).toEqual(
      without.existing.map(({ ruleGroupIndices: _rgi, ...rest }) => rest),
    );
  });

  // B5 (#21) — a Settings-level `restByDivision` (no typed `min_rest_minutes`
  // hard rule at all) used to reach the wire ONLY on `constraints.restByDivision`,
  // a field `ruleGroupIndices` cannot name. This is the common production case
  // (measured 2026-08-11 against a live service: two pinned rows 30 minutes
  // apart sharing an entrant, under exactly this Settings-only rest, cleared
  // `OPTIMAL` where `INFEASIBLE` was owed) — so it must ALSO produce a
  // `RuleGroup`, scoped to that division's own free fixtures, same as any typed
  // rule would.
  it("turns a settings-level restByDivision with no typed rest rule into a rule group scoped to that division", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    const fixtures = [
      fx("f1", "E1", "E2", { divisionId: "D1" }),
      fx("f2", "E3", "E4", { divisionId: "D1" }),
      // A different division, to prove the group is SCOPED, not every free
      // fixture on the board — a group covering f3 too would pass a vacuous
      // "some group exists" check without proving membership is correct.
      fx("f3", "E5", "E6", { divisionId: "D2" }),
    ];
    const config = { ...cfg(), restByDivision: { D1: 25 } };
    await buildSchedule({ fixtures, config });
    expect(captured).toBeDefined();
    expect(captured!.ruleGroups).toEqual([{ fixtureIds: ["f1", "f2"], minRestMinutes: 25, maxFixturesPerDay: undefined }]);
  });

  // A pin can only ever be attributed a rest rule through `ruleGroupIndices` —
  // C6's whole fold-in rests on it. This proves the synthetic group from the
  // test above is actually reachable by a pinned row, not merely present in
  // `ruleGroups` and orphaned.
  it("carries a pin's synthetic division-rest group index in its ruleGroupIndices on the wire", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    const locked = { court: "C1", startAt: T0 };
    const fixtures = [
      fx("pinned", "E1", "E2", { divisionId: "D1", locked }),
      fx("free", "E3", "E4", { divisionId: "D1" }),
    ];
    const config = { ...cfg(), restByDivision: { D1: 20 } };
    await buildSchedule({ fixtures, config });
    expect(captured).toBeDefined();
    expect(captured!.ruleGroups).toEqual([{ fixtureIds: ["free"], minRestMinutes: 20, maxFixturesPerDay: undefined }]);
    const pinnedRow = captured!.existing.find((e) => e.fixtureId === "pinned");
    expect(pinnedRow?.ruleGroupIndices).toEqual([0]);
  });

  // Typed rules are appended FIRST, synthetic division-rest groups SECOND
  // (`buildRuleGroups`'s own docstring) — so an index a pin already resolves
  // against a typed rule must never move once a division-rest group joins the
  // list beside it. Proved both ways: the array shape itself, and a pinned row
  // that matches BOTH sources ending up with BOTH indices, in order.
  it("keeps a typed rule's index stable when a synthetic division-rest group is appended after it", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    const locked = { court: "C1", startAt: T0 };
    const fixtures = [
      fx("pinned", "E1", "E2", { divisionId: "D1", locked }),
      fx("free", "E3", "E4", { divisionId: "D2" }),
    ];
    const hard: HardConstraint[] = [{ type: "max_fixtures_per_day", count: 3, scope: { kind: "competition" } }];
    const config = { ...cfg(), hard, restByDivision: { D1: 20 } };
    await buildSchedule({ fixtures, config });
    expect(captured).toBeDefined();
    // Index 0 is still the typed, competition-scoped rule (covers the one free
    // fixture, "free"); index 1 is the new synthetic D1 group, appended after
    // it (covers no FREE fixture — "pinned" is D1 but is not free).
    expect(captured!.ruleGroups).toEqual([
      { fixtureIds: ["free"], minRestMinutes: undefined, maxFixturesPerDay: 3 },
      { fixtureIds: [], minRestMinutes: 20, maxFixturesPerDay: undefined },
    ]);
    const pinnedRow = captured!.existing.find((e) => e.fixtureId === "pinned");
    // Matches BOTH: the competition-scoped typed rule (0, covers everything)
    // and D1's synthetic rest group (1) — at their real, stable positions.
    expect(pinnedRow?.ruleGroupIndices).toEqual([0, 1]);
  });

  // `dayCapByDivision` (the OLDER, division-only field, retired along with
  // `division_rules`) used to be gated on `tz` for exactly this reason
  // (obligation 1, above): with no zone the verifier's own day-cap pass
  // buckets every slot into ONE day, so a real cap would bind the whole
  // board against a fabricated bucket. `buildRuleGroups`'s `maxFixturesPerDay`
  // must honour the SAME gate, or the service (which reads `RuleGroup.
  // max_fixtures_per_day` since C4) enforces a cap the verifier cannot see
  // at all. `minRestMinutes` needs no such gate and must be unaffected
  // either way.
  it("omits maxFixturesPerDay from a rule group when tz is undefined, and includes it when tz is set", async () => {
    const run = async (tz: string | undefined): Promise<SolveBuildInput> => {
      let captured: SolveBuildInput | undefined;
      vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
        captured = input;
        return okOutcome();
      });
      const fixtures = [fx("f1", "E1", "E2", { divisionId: "D1" })];
      const hard: HardConstraint[] = [
        { type: "max_fixtures_per_day", count: 2, scope: { kind: "division", divisionId: "D1" } },
      ];
      const config = { ...cfg(), tz, hard };
      await buildSchedule({ fixtures, config });
      vi.restoreAllMocks();
      return captured!;
    };

    const withoutTz = await run(undefined);
    expect(withoutTz.ruleGroups).toEqual([
      { fixtureIds: ["f1"], minRestMinutes: undefined, maxFixturesPerDay: undefined },
    ]);

    const withTz = await run("Europe/London");
    expect(withTz.ruleGroups).toEqual([{ fixtureIds: ["f1"], minRestMinutes: undefined, maxFixturesPerDay: 2 }]);
  });

  // --- C1: round order on the wire (2026-08-12 round-order design) --------

  it("forwards roundNo on the wire for a round-bearing fixture, omits it for a round-less one", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    const fixtures = [
      fx("with-round", "E1", "E2", { roundNo: 3 }),
      fx("no-round", "E3", "E4", { roundNo: undefined }),
    ];
    await buildSchedule({ fixtures, config: cfg() });
    expect(captured).toBeDefined();
    const byId = new Map(captured!.fixtures.map((f) => [f.fixtureId, f]));
    expect(byId.get("with-round")?.roundNo).toBe(3);
    expect(byId.get("no-round")?.roundNo).toBeUndefined();
  });

  it("forwards a pin's round when exactly one round-robin division is in play", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    const locked = { court: "C1", startAt: T0 };
    const fixtures = [
      fx("movable", "E1", "E2", { roundNo: 1, divisionId: "D1" }),
      fx("pinned", "E3", "E4", { roundNo: 2, divisionId: "D1", locked }),
    ];
    await buildSchedule({ fixtures, config: cfg() });
    expect(captured).toBeDefined();
    const pinnedRow = captured!.existing.find((e) => e.court === "C1" && e.startAtMs === T0);
    expect(pinnedRow?.roundNo).toBe(2);
  });

  it("does not forward a pin's round when movable fixtures span more than one round-bearing division", async () => {
    // `PinnedRow` carries no division index on the wire (its own proto
    // comment explains why), so the model cannot scope a pin-movable round
    // pair by division the way it scopes movable-movable pairs — this is
    // the one case build.ts itself cannot guarantee is unambiguous, and it
    // must not guess.
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    const locked = { court: "C1", startAt: T0 };
    const fixtures = [
      fx("d1-movable", "E1", "E2", { roundNo: 1, divisionId: "D1" }),
      fx("d2-movable", "E5", "E6", { roundNo: 1, divisionId: "D2" }),
      fx("d1-pinned", "E3", "E4", { roundNo: 2, divisionId: "D1", locked }),
    ];
    await buildSchedule({ fixtures, config: cfg() });
    expect(captured).toBeDefined();
    const pinnedRow = captured!.existing.find((e) => e.court === "C1" && e.startAtMs === T0);
    expect(pinnedRow?.roundNo).toBeUndefined();
    // Movable-movable pairs are unaffected: each fixture's own round still
    // rides along, scoped by the wire's own divisionIndex.
    const byId = new Map(captured!.fixtures.map((f) => [f.fixtureId, f]));
    expect(byId.get("d1-movable")?.roundNo).toBe(1);
    expect(byId.get("d2-movable")?.roundNo).toBe(1);
  });

  // C1 fix-loop round 2 (2026-08-12, Item B): the pin-path sibling of the
  // multi-stage/multi-pool contamination guard above. Division alone is not
  // enough to know a pin's round is safe to forward — a division can carry
  // a clean, all-movable round-robin stage AND a second, entirely PINNED
  // round-robin stage (or pool) at once. `multiPoolContaminated`'s own
  // guard never sees the second one: contamination there is scored over
  // `freeFixtures`, and every fixture in the pinned stage/pool is, by
  // construction, not free. Before this fix, `singleRoundRobinDivision`
  // read exactly one DIVISION (stage A's, the only one with a round-bearing
  // movable fixture) and forwarded ANY pin sharing that division — this pin
  // belongs to the SAME division but a DIFFERENT stage, and its round has
  // no business being compared against stage A's.
  it("does not forward a pin's round when it belongs to a DIFFERENT round-robin stage than the single clean movable one", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    const locked = { court: "C1", startAt: T0 };
    const fixtures = [
      fx("stageA-movable", "E1", "E2", { roundNo: 1, divisionId: "D1", stageId: "A" }),
      fx("stageB-pinned", "E3", "E4", { roundNo: 1, divisionId: "D1", stageId: "B", locked }),
    ];
    await buildSchedule({ fixtures, config: cfg() });
    expect(captured).toBeDefined();
    const pinnedRow = captured!.existing.find((e) => e.court === "C1" && e.startAtMs === T0);
    expect(pinnedRow?.roundNo).toBeUndefined();
    const byId = new Map(captured!.fixtures.map((f) => [f.fixtureId, f]));
    expect(byId.get("stageA-movable")?.roundNo).toBe(1);
  });

  // The converse dimension: SAME stage, DIFFERENT pool — a `kind: "group"`
  // stage with one pool entirely movable and a second entirely pinned.
  // `roundBearingSequenceOf` is one compound key over (division, stage,
  // pool) together, but this proves the pool component is independently
  // load-bearing, not merely along for the ride behind stageId.
  it("does not forward a pin's round when it belongs to a DIFFERENT pool of the same round-robin stage than the single clean movable one", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    const locked = { court: "C1", startAt: T0 };
    const fixtures = [
      fx("poolA-movable", "E1", "E2", { roundNo: 1, divisionId: "D1", stageId: "S", poolId: "A" }),
      fx("poolB-pinned", "E3", "E4", { roundNo: 1, divisionId: "D1", stageId: "S", poolId: "B", locked }),
    ];
    await buildSchedule({ fixtures, config: cfg() });
    expect(captured).toBeDefined();
    const pinnedRow = captured!.existing.find((e) => e.court === "C1" && e.startAtMs === T0);
    expect(pinnedRow?.roundNo).toBeUndefined();
    const byId = new Map(captured!.fixtures.map((f) => [f.fixtureId, f]));
    expect(byId.get("poolA-movable")?.roundNo).toBe(1);
  });

  it("strips rounds for a WHOLE division when one of its fixtures also carries a feed dependency (mixed-sequence guard)", async () => {
    // Real round-robin fixtures never have a dependency edge — brackets and
    // stepladder fixtures are already ordered by winner_to/loser_to instead,
    // and never carry a round (design doc). A round-bearing fixture that IS
    // a dependency endpoint is therefore contaminated input (a mixed
    // sequence, or a caller bug), and the guard strips the WHOLE division's
    // rounds rather than risk a false ordering — proven here by an
    // `innocent` third fixture in the SAME division, sharing no dependency
    // edge of its own, whose round is stripped too.
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const fixtures = [
      fx("semi", "E1", "E2", { roundNo: 1, divisionId: "D1" }),
      fx("final", "E3", "E4", { roundNo: 2, divisionId: "D1" }),
      fx("innocent", "E5", "E6", { roundNo: 1, divisionId: "D1" }),
    ];
    await buildSchedule({
      fixtures,
      config: cfg(),
      dependencies: [{ fixtureId: "final", dependsOn: "semi", direct: true }],
    });
    expect(captured).toBeDefined();
    const byId = new Map(captured!.fixtures.map((f) => [f.fixtureId, f]));
    expect(byId.get("semi")?.roundNo).toBeUndefined();
    expect(byId.get("final")?.roundNo).toBeUndefined();
    expect(byId.get("innocent")?.roundNo).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toContain("stripping round");
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({ divisions: ["D1"] });
  });

  it("does not strip an untouched division's rounds when a different division is contaminated", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const fixtures = [
      fx("d1-semi", "E1", "E2", { roundNo: 1, divisionId: "D1" }),
      fx("d1-final", "E3", "E4", { roundNo: 2, divisionId: "D1" }),
      fx("d2-clean", "E5", "E6", { roundNo: 1, divisionId: "D2" }),
    ];
    await buildSchedule({
      fixtures,
      config: cfg(),
      dependencies: [{ fixtureId: "d1-final", dependsOn: "d1-semi", direct: true }],
    });
    expect(captured).toBeDefined();
    const byId = new Map(captured!.fixtures.map((f) => [f.fixtureId, f]));
    expect(byId.get("d1-semi")?.roundNo).toBeUndefined();
    expect(byId.get("d2-clean")?.roundNo).toBe(1);
  });

  // Found via schedule.test.ts's "8-team group+KO division" end-to-end case,
  // not named in the brief: `kind: "group"` with N pools calls
  // `roundRobinGen` once PER POOL, so pool A's round 2 and pool B's round 2
  // are two unrelated "round 2"s. `Fixture` (the wire message) has no pool
  // index at all — only `division_index` — so unlike the TS verifier (which
  // scopes by `Assignment.poolId`, see calendar.test.ts's own pool-scoping
  // tests), the solver-side wire cannot express "these two rounds are
  // incomparable because they're different pools". Stripping the whole
  // division's rounds is therefore the only safe answer here, the identical
  // mechanism the dependency-edge contamination guard already uses.
  it("strips rounds for a division whose round-bearing fixtures span more than one pool", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const fixtures = [
      fx("poolA-r1", "E1", "E2", { roundNo: 1, divisionId: "D1", poolId: "A" }),
      fx("poolA-r2", "E3", "E4", { roundNo: 2, divisionId: "D1", poolId: "A" }),
      fx("poolB-r1", "E5", "E6", { roundNo: 1, divisionId: "D1", poolId: "B" }),
    ];
    await buildSchedule({ fixtures, config: cfg() });
    expect(captured).toBeDefined();
    const byId = new Map(captured!.fixtures.map((f) => [f.fixtureId, f]));
    expect(byId.get("poolA-r1")?.roundNo).toBeUndefined();
    expect(byId.get("poolA-r2")?.roundNo).toBeUndefined();
    expect(byId.get("poolB-r1")?.roundNo).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toContain("span more than one pool");
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({ divisions: ["D1"] });
  });

  it("does not strip a single-pool division when a DIFFERENT division has multiple pools", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const fixtures = [
      fx("d1-poolA-r1", "E1", "E2", { roundNo: 1, divisionId: "D1", poolId: "A" }),
      fx("d1-poolB-r1", "E3", "E4", { roundNo: 1, divisionId: "D1", poolId: "B" }),
      fx("d2-clean", "E5", "E6", { roundNo: 1, divisionId: "D2" }),
    ];
    await buildSchedule({ fixtures, config: cfg() });
    expect(captured).toBeDefined();
    const byId = new Map(captured!.fixtures.map((f) => [f.fixtureId, f]));
    expect(byId.get("d1-poolA-r1")?.roundNo).toBeUndefined();
    expect(byId.get("d2-clean")?.roundNo).toBe(1);
  });

  // C1 fix-loop (2026-08-12 round-order design, Finding 2): the
  // stage-cardinality sibling of the multi-pool test above, and — before
  // this fix — the one shape NEITHER contamination guard caught. A division
  // can carry more than one round-robin-kind stage (two `league` stages, or
  // a `league` beside an unpooled `group` — `stages.ts`'s
  // `stages.per_division.max` caps count, not kind-uniqueness), and none of
  // them needs a pool. Both fixtures below then read `poolId: undefined`,
  // one bucket under the OLD `poolId`-only key, no trip — exactly the
  // "clean non-pooled round-robin stages" shape the review that opened this
  // fix-loop named. `stageId` differs, which is now enough on its own.
  it("strips rounds for a division whose round-bearing fixtures span more than one round-robin STAGE, even with no pool on either side", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const fixtures = [
      fx("stageA-r1", "E1", "E2", { roundNo: 1, divisionId: "D1", stageId: "A" }),
      fx("stageA-r2", "E3", "E4", { roundNo: 2, divisionId: "D1", stageId: "A" }),
      fx("stageB-r1", "E5", "E6", { roundNo: 1, divisionId: "D1", stageId: "B" }),
    ];
    await buildSchedule({ fixtures, config: cfg() });
    expect(captured).toBeDefined();
    const byId = new Map(captured!.fixtures.map((f) => [f.fixtureId, f]));
    expect(byId.get("stageA-r1")?.roundNo).toBeUndefined();
    expect(byId.get("stageA-r2")?.roundNo).toBeUndefined();
    expect(byId.get("stageB-r1")?.roundNo).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toContain("span more than one pool");
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({ divisions: ["D1"] });
  });

  it("does not strip a single-stage division when a DIFFERENT division has multiple round-robin stages", async () => {
    let captured: SolveBuildInput | undefined;
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async (input) => {
      captured = input;
      return okOutcome();
    });
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const fixtures = [
      fx("d1-stageA-r1", "E1", "E2", { roundNo: 1, divisionId: "D1", stageId: "A" }),
      fx("d1-stageB-r1", "E3", "E4", { roundNo: 1, divisionId: "D1", stageId: "B" }),
      fx("d2-clean", "E5", "E6", { roundNo: 1, divisionId: "D2", stageId: "A" }),
    ];
    await buildSchedule({ fixtures, config: cfg() });
    expect(captured).toBeDefined();
    const byId = new Map(captured!.fixtures.map((f) => [f.fixtureId, f]));
    expect(byId.get("d1-stageA-r1")?.roundNo).toBeUndefined();
    expect(byId.get("d2-clean")?.roundNo).toBe(1);
  });

  // C1 fix-loop round 2 (2026-08-12, Item A): the wire-stripping tests just
  // above both call `okOutcome()` with NO argument, whose default is
  // `assignments: []` — `incumbent` (`placedAssignments` + `pinnedAssignments`,
  // both built through `assignmentOf`) is therefore empty and the
  // encoder/verifier SELF-CHECK below the wire call (`conflictsForBoard`
  // over `incumbent`) never runs on anything. `roundBearingFor`'s own
  // stripping (proven above) protects the SOLVER from seeing a false
  // cross-stage round comparison; it says nothing about whether the
  // SELF-CHECK — which reads `assignmentOf`'s OWN `stageId` field, entirely
  // independent of what got stripped for the wire — makes the identical
  // mistake one step later, over the solver's genuine, correct reply.
  //
  // This solver reply is deliberately clean per-stage (stage A: round 1 at
  // T0+60 <= round 2 at T0+90; stage B: round 1 at T0 <= round 2 at T0+30)
  // but, compared as ONE naive sequence with stageId dropped, stage A's
  // round 1 (T0+60) sits AFTER stage B's round 2 (T0+30) — round 1 must be
  // <= round 2, so that pair reads as a violation without `stageId` in the
  // key, and does not with it. All four fixtures sit on the one configured
  // court in disjoint 30-minute windows, so nothing else (court, entrant,
  // rest) has anything to say — round order is the only rule that could
  // possibly fire either way.
  it("does not reject a genuinely valid placement board over a false cross-stage round comparison in its OWN encoder/verifier self-check", async () => {
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => undefined);
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockImplementation(async () =>
      okOutcome([
        { fixtureId: "stageB-r1", court: "C1", startAtMs: T0 },
        { fixtureId: "stageB-r2", court: "C1", startAtMs: T0 + 30 * MIN },
        { fixtureId: "stageA-r1", court: "C1", startAtMs: T0 + 60 * MIN },
        { fixtureId: "stageA-r2", court: "C1", startAtMs: T0 + 90 * MIN },
      ]),
    );
    const fixtures = [
      fx("stageA-r1", "E1", "E2", { roundNo: 1, divisionId: "D1", stageId: "A" }),
      fx("stageA-r2", "E3", "E4", { roundNo: 2, divisionId: "D1", stageId: "A" }),
      fx("stageB-r1", "E5", "E6", { roundNo: 1, divisionId: "D1", stageId: "B" }),
      fx("stageB-r2", "E7", "E8", { roundNo: 2, divisionId: "D1", stageId: "B" }),
    ];
    const result = await buildSchedule({ fixtures, config: cfg({ courts: ["C1"] }) });
    // The exact symptom the review named: a valid solver board quietly
    // discarded, and a false "verifier rejected" error logged nobody would
    // ever see. Without the `stageId` line on `assignmentOf`, this fails —
    // `status` comes back `"verifier_rejected"` and `errorSpy` is called
    // with the false-positive pair.
    expect(errorSpy).not.toHaveBeenCalled();
    expect(result.status).not.toBe("verifier_rejected");
    expect(result.conflicts.filter((c) => c.reason === "order")).toEqual([]);
  });
});
