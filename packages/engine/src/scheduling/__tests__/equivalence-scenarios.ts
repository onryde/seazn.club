// The scenarios behind `build-port-equivalence.test.ts` (engine-split plan Task 1a-2, Step 1).
//
// Every entry is LIFTED from a test that already pins a real outcome of `buildSchedule`, so the input and the solver's
// behaviour are the repo's own, not something invented to suit the proof. `source` names the test each came from. Where a
// premise in the plan proved false (no existing test drives the solver-reported `INFEASIBLE` arm), the entry says so.
//
// A scenario is a request WITHOUT its ports plus a solver that answers it. What the solver is asked, what the logger is
// told and what the engine returns are what `build-port-equivalence.test.ts` records; this file only declares the inputs.
import { TIER_COUNT, TIER_NAMES } from "../build.ts";
import type { SchedulableFixture, SlotConfig } from "../calendar.ts";
import type { BuildProblem, SolveBuildInput, SolveBuildOutcome } from "../solver-port.ts";

/** What the ORIGINAL test asserted about this case — never read back from the code under test. A field is present only
 *  where the source test pins it; `calls` is the number of times the solver must have been asked. */
export interface ScenarioExpectation {
  status?: string;
  engine?: "greedy" | "optimized";
  calls?: number;
  placed?: number;
}

export interface EquivalenceScenario {
  name: string;
  source: string;
  problem: () => BuildProblem;
  solver: (input: SolveBuildInput) => Promise<SolveBuildOutcome>;
  expects: ScenarioExpectation;
}

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);

type Cfg = SlotConfig & { courts: string[] };

// `build.test.ts`'s own `cfg` / `cons` / `fx` helpers, verbatim.
const cfg = (over: Partial<SlotConfig> & { courts?: string[] } = {}): Cfg => ({
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["C1"],
  perEntrantMinRest: 0,
  tz: "Europe/London",
  window: { from: T0, to: T0 + 180 * MIN },
  ...over,
});
const cons = (over: Record<string, unknown>) =>
  ({ noBackToBack: false, startWindows: [], fieldFairness: "off", parallelism: "mixed", crossPersonClash: "warn", ...over }) as NonNullable<
    SlotConfig["constraints"]
  >;
const fx = (id: string, home: string, away: string, over: Partial<SchedulableFixture> = {}): SchedulableFixture => ({
  id,
  home,
  away,
  roundNo: 1,
  ...over,
});

/** A FULLY PROVED reply: every tier of OUR ladder, by name, in order (`build.test.ts`'s `provedTiers`). */
const proved = (
  assignments: SolveBuildOutcome["assignments"],
  elapsedMs = 5,
  wallExhausted = false,
): SolveBuildOutcome => ({
  assignments,
  status: "OPTIMAL",
  tiersCompleted: TIER_COUNT,
  objectiveValues: TIER_NAMES.map((name, i) => ({ name, value: i })),
  elapsedMs,
  wallExhausted,
});
const answers =
  (outcome: SolveBuildOutcome) =>
  (): Promise<SolveBuildOutcome> =>
    Promise.resolve(outcome);
const rejects =
  (error: Error) =>
  (): Promise<SolveBuildOutcome> =>
    Promise.reject(error);

/** `build.test.ts` :139-143 — one court, two slots, a start window only `b` can use. Greedy places `[a]`; a real solve
 *  places `[b@C1+0, a@C1+30]`. */
const cornerConfig = cfg({
  sessionWindows: [{ from: T0, to: T0 + 60 * MIN }],
  constraints: cons({ startWindows: [{ target: { kind: "entrant", id: "E3" }, notAfter: T0 }] }),
});
const cornerFixtures = (): SchedulableFixture[] => [fx("a", "E1", "E2"), fx("b", "E3", "E4")];
const cornerBoard = (): SolveBuildOutcome["assignments"] => [
  { fixtureId: "b", court: "C1", startAtMs: T0 },
  { fixtureId: "a", court: "C1", startAtMs: T0 + 30 * MIN },
];

/** `build.test.ts` :1514 `minimalInput()` — the one-fixture request the rejection and ERROR cases use. */
const minimalProblem = (): BuildProblem => ({ fixtures: [fx("f1", "E1", "E2")], config: cfg() });

/** `build-day-gate.test.ts` :31-62 — two courts, a 240-minute window, two cards locked onto the 09:00 row. */
const dayGateConfig: Cfg = {
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["C1", "C2"],
  perEntrantMinRest: 0,
  window: { from: T0, to: T0 + 240 * MIN },
  tz: "Europe/London",
};
const lockedPair = (): SchedulableFixture[] => [
  { id: "a", roundNo: 1, home: "E1", away: "E2", locked: { court: "C1", startAt: T0 } },
  { id: "b", roundNo: 1, home: "E3", away: "E4", locked: { court: "C2", startAt: T0 } },
];

/** `build-pins.test.ts` :32-56 — one court, two disjoint-entrant cards, a 120-minute window. */
const pinsConfig: Cfg = {
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["C1"],
  perEntrantMinRest: 0,
  window: { from: T0, to: T0 + 120 * MIN },
  tz: "Europe/London",
};

export const EQUIVALENCE_SCENARIOS: EquivalenceScenario[] = [
  {
    name: "optimized",
    source: 'build.test.ts :265 "places a card greedy declared unplaceable"',
    problem: () => ({ fixtures: cornerFixtures(), config: cornerConfig }),
    solver: answers(proved(cornerBoard())),
    // asserted there: placed 2, engine "optimized", status "ok"
    expects: { calls: 1, placed: 2, engine: "optimized", status: "ok" },
  },
  {
    name: "already_optimal",
    source: 'build-day-gate.test.ts :156 "still claims already_optimal on our own ladder"',
    problem: () => ({ fixtures: lockedPair(), config: dayGateConfig, frozen: ["a", "b"] }),
    solver: answers(proved([])),
    expects: { calls: 1, status: "already_optimal" },
  },
  {
    name: "polish_published_slot",
    source: 'build-polish.test.ts :181 "freezes a card to where it was PUBLISHED, not to where greedy re-placed it" (frozen + current)',
    problem: () => ({
      fixtures: cornerFixtures(),
      config: cornerConfig,
      frozen: ["a"],
      current: [
        {
          fixtureId: "a",
          court: "C1",
          startAt: T0 + 30 * MIN,
          endAt: T0 + 60 * MIN,
          entrants: [],
          people: [],
        },
      ],
    }),
    solver: answers(proved([{ fixtureId: "b", court: "C1", startAtMs: T0 }])),
    // asserted there: `a` stays at T0+30, placed 2
    expects: { calls: 1, placed: 2 },
  },
  {
    // PREMISE FALSE: the plan sends us to `build.test.ts` for a solver-reported INFEASIBLE, and no existing test drives
    // that arm (`status: "INFEASIBLE"` appears in no test file). The input is `build-pins.test.ts`'s plus an `existing`
    // row on the only court; the reply is the arm's own wire shape (a verdict with no board).
    name: "infeasible_reported_by_solver",
    source: "build-pins.test.ts :32-56 input + one existing pin; the INFEASIBLE reply has no source test (arm previously unpinned)",
    problem: () => ({
      fixtures: [fx("a", "E1", "E2"), fx("b", "E3", "E4")],
      config: pinsConfig,
      existing: [
        { fixtureId: "z", court: "C1", startAt: T0, endAt: T0 + 30 * MIN, entrants: ["E9", "E10"], people: [] },
      ],
    }),
    solver: answers({
      assignments: [],
      status: "INFEASIBLE",
      tiersCompleted: 0,
      objectiveValues: [],
      elapsedMs: 5,
      wallExhausted: false,
    }),
    expects: { calls: 1, status: "infeasible", engine: "greedy" },
  },
  {
    name: "infeasible_pins_local",
    source: 'build.test.ts :454 "proves infeasible only when the pins really do contradict" (caught locally, solver never asked)',
    problem: () => ({
      fixtures: [
        fx("a", "E1", "E2", { locked: { court: "C1", startAt: T0 } }),
        fx("b", "E3", "E4", { locked: { court: "C1", startAt: T0 } }),
      ],
      config: cfg({ courts: ["C1"], sessionWindows: [{ from: T0, to: T0 + 60 * MIN }] }),
    }),
    solver: answers(proved([])),
    // asserted there: infeasible, engine greedy. Header of :423 says the pin check runs BEFORE placement is called.
    expects: { calls: 0, status: "infeasible", engine: "greedy" },
  },
  {
    name: "dependencies",
    source: 'build.test.ts :2507 "strips rounds for a WHOLE division when one of its fixtures also carries a feed dependency"',
    problem: () => ({
      fixtures: [
        fx("semi", "E1", "E2", { roundNo: 1, divisionId: "D1" }),
        fx("final", "E3", "E4", { roundNo: 2, divisionId: "D1" }),
        fx("innocent", "E5", "E6", { roundNo: 1, divisionId: "D1" }),
      ],
      config: cfg(),
      dependencies: [{ fixtureId: "final", dependsOn: "semi", direct: true }],
    }),
    solver: answers(proved([])),
    // asserted there: the solver was asked once, and the strip logged exactly one warning (recorded in the snapshot)
    expects: { calls: 1 },
  },
  {
    // Same input as `dependencies`, but the solver answers with a board that honours the edge (semi before final). The
    // source test replies with an EMPTY board, which never reaches the verifier's `order` pass; this one does.
    name: "dependencies_board",
    source: 'build.test.ts :2507 input, with a reply that places all three cards in dependency order',
    problem: () => ({
      fixtures: [
        fx("semi", "E1", "E2", { roundNo: 1, divisionId: "D1" }),
        fx("final", "E3", "E4", { roundNo: 2, divisionId: "D1" }),
        fx("innocent", "E5", "E6", { roundNo: 1, divisionId: "D1" }),
      ],
      config: cfg(),
      dependencies: [{ fixtureId: "final", dependsOn: "semi", direct: true }],
    }),
    solver: answers(
      proved([
        { fixtureId: "semi", court: "C1", startAtMs: T0 },
        { fixtureId: "innocent", court: "C1", startAtMs: T0 + 30 * MIN },
        { fixtureId: "final", court: "C1", startAtMs: T0 + 90 * MIN },
      ]),
    ),
    expects: { calls: 1 },
  },
  {
    name: "multi_pool_strip",
    source: 'build.test.ts :2575 "strips rounds for a division whose round-bearing fixtures span more than one pool"',
    problem: () => ({
      fixtures: [
        fx("poolA-r1", "E1", "E2", { roundNo: 1, divisionId: "D1", poolId: "A" }),
        fx("poolA-r2", "E3", "E4", { roundNo: 2, divisionId: "D1", poolId: "A" }),
        fx("poolB-r1", "E5", "E6", { roundNo: 1, divisionId: "D1", poolId: "B" }),
      ],
      config: cfg(),
    }),
    solver: answers(proved([])),
    expects: { calls: 1 },
  },
  {
    name: "rejected_unavailable",
    source: 'build.test.ts :1636 "maps a rejected PlacementError(unavailable) to solver_unavailable"',
    problem: minimalProblem,
    solver: rejects(Object.assign(new Error("synthetic unavailable for the mapping test"), { failure: "unavailable" })),
    expects: { calls: 1, status: "solver_unavailable", engine: "greedy" },
  },
  {
    name: "rejected_plain_error",
    source: 'build.test.ts :1575 "falls back to greedy on a Placement rejection" (a plain Error, no `failure`)',
    problem: minimalProblem,
    solver: rejects(new Error("placement solveBuild exceeded deadline")),
    expects: { calls: 1, status: "solver_unavailable", engine: "greedy" },
  },
  {
    name: "error_internal",
    source: 'build.test.ts :1653 "reports a board Placement itself marks ERROR the same way as a rejection"',
    problem: minimalProblem,
    solver: answers({
      assignments: [{ fixtureId: "f1", court: "C1", startAtMs: T0 }],
      status: "ERROR",
      tiersCompleted: 0,
      objectiveValues: [],
      elapsedMs: 5,
      wallExhausted: false,
      error: { code: "internal", message: "boom" },
    }),
    expects: { calls: 1, status: "solver_unavailable", engine: "greedy" },
  },
  {
    name: "error_solver_busy",
    source: 'build.test.ts :1679 "maps ERROR + error.code SOLVER_BUSY to the existing solver_busy"',
    problem: minimalProblem,
    solver: answers({
      assignments: [],
      status: "ERROR",
      tiersCompleted: 0,
      objectiveValues: [],
      elapsedMs: 5,
      wallExhausted: false,
      error: { code: "SOLVER_BUSY", message: "admission control refused a concurrent solve" },
    }),
    expects: { calls: 1, status: "solver_busy", engine: "greedy" },
  },
  {
    name: "unknown",
    source: 'build.test.ts :1705 "maps an UNKNOWN outcome (the chain proved nothing) to not_searched, not ok"',
    problem: () => ({ fixtures: cornerFixtures(), config: cornerConfig }),
    solver: answers({
      assignments: [],
      status: "UNKNOWN",
      tiersCompleted: 0,
      objectiveValues: [],
      elapsedMs: 5,
      wallExhausted: true,
    }),
    expects: { calls: 1, status: "not_searched", engine: "greedy" },
  },
  {
    name: "worse_than_seed",
    source: 'build.test.ts :1566 (a reply that places nothing, against a seed that places 1; D6 ships the seed)',
    problem: () => ({ fixtures: cornerFixtures(), config: cornerConfig }),
    solver: answers(proved([])),
    expects: { calls: 1, engine: "greedy", placed: 1 },
  },
  {
    name: "verifier_rejected",
    source: 'build.test.ts :761 "hands back the greedy seed, LOUDLY, over a breach the solver INTRODUCED" (here a real overlap: both cards on C1 at T0)',
    problem: () => ({ fixtures: cornerFixtures(), config: cornerConfig }),
    solver: answers(
      proved([
        { fixtureId: "b", court: "C1", startAtMs: T0 },
        { fixtureId: "a", court: "C1", startAtMs: T0 },
      ]),
    ),
    // asserted there: status verifier_rejected, engine greedy, the greedy seed's one card
    expects: { calls: 1, status: "verifier_rejected", engine: "greedy", placed: 1 },
  },
  {
    name: "wall_zero",
    source: 'build.test.ts :437 "stops on the outer wall cap without inventing a verdict" (bails before the solver)',
    problem: () => ({ fixtures: cornerFixtures(), config: cornerConfig, wallMs: 0 }),
    solver: answers(proved(cornerBoard())),
    // asserted there: budgetExpired, status not_searched, one card
    expects: { calls: 0, status: "not_searched", placed: 1 },
  },
  {
    // The empty input. No source test pins it: the expectation is the rulebook's, that nothing to place places nothing.
    name: "empty",
    source: "0 fixtures (no existing test; the empty case TEST-STRATEGY owes every sequence)",
    problem: () => ({ fixtures: [], config: cfg() }),
    solver: answers(proved([])),
    expects: { placed: 0 },
  },
];
