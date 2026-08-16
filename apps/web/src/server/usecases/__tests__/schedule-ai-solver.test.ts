// W6 (#401), C5 (z3 retirement stage B), C9 (decomposed repair on CP-SAT) —
// the guarantees `solveBoard` makes to both AI runners, tested at the seam
// rather than through a runner: a throw, a kill switch, an unplaced
// violator and a budget-exhausted decomposition are all states
// `repairDecomposedCpsat` cannot be talked into on demand.
//
// `repairDecomposedCpsat` is the only thing mocked, at the same barrel seam
// `buildSchedule` used to be mocked at (C5). C9 moved the actual solve call
// one level down — `solveBoard` now calls the decomposed driver, which
// itself calls `buildSchedule` internally via a RELATIVE import inside
// packages/engine, so mocking `buildSchedule` from this file would no longer
// intercept anything real (this repo's own recorded trap: a mock against a
// module the file under test does not itself statically import is inert).
// The driver's OWN behaviour — reconciliation, the nudge, minimality — is
// covered in `packages/engine/src/scheduling/repair-decompose-cpsat.test.ts`
// and its real-service integration sibling; this file is purely about the
// SEAM `solveBoard` owns: frozen/violator narrowing, the unplaced-violator
// fold, telemetry derivation, and the kill switch.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { repairDecomposedCpsat } = vi.hoisted(() => ({ repairDecomposedCpsat: vi.fn() }));
vi.mock("@seazn/engine/scheduling", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@seazn/engine/scheduling")>()),
  repairDecomposedCpsat,
}));

import { applySolverMoves, solveBoard, solverBudgetMs } from "../schedule-ai-solver";
import type {
  Assignment,
  BuildInput,
  DecomposedRepairResult,
  RepairComponentReport,
  SchedulableFixture,
} from "@seazn/engine/scheduling";

const T = (iso: string) => new Date(iso).getTime();
const MIN = 60_000;

const fixture = (id: string, home: string, away: string): SchedulableFixture => ({
  id,
  home,
  away,
});

const asn = (fixtureId: string, court: string, startAtIso: string): Assignment => ({
  fixtureId,
  court,
  startAt: T(startAtIso),
  endAt: T(startAtIso) + 30 * MIN,
  entrants: [],
  people: [],
});

const config: BuildInput["config"] = {
  startAt: T("2026-08-01T09:00:00Z"),
  matchMinutes: 30,
  gapMinutes: 0,
  perEntrantMinRest: 0,
  courts: ["Court 1", "Court 2"],
  blackouts: [],
  sessionWindows: [],
};

const componentReport = (
  fixtureIds: string[],
  outcome: RepairComponentReport["outcome"],
  overrides: Partial<RepairComponentReport> = {},
): RepairComponentReport => ({
  index: 0,
  size: fixtureIds.length,
  frozen: 0,
  fixtureIds,
  outcome,
  k: 0,
  moved: [],
  checks: 0,
  elapsedMs: 5,
  relaxed: [],
  ...overrides,
});

/** A `repairDecomposedCpsat` result, shaped like a fully-repaired board by
 *  default — the fields a test cares about are always the overrides. */
const decomposedResult = (
  assignments: Assignment[],
  overrides: Partial<DecomposedRepairResult> = {},
): DecomposedRepairResult => ({
  status: "repaired",
  assignments,
  moved: [],
  k: 0,
  elapsedMs: 5,
  checks: 0,
  relaxed: [],
  components: [componentReport(assignments.map((a) => a.fixtureId), "repaired")],
  unresolvedFixtureIds: [],
  minimality: { verdict: "upper_bound", k: 0, lowerBound: 0, witnesses: [], caveats: [] },
  mode: "components",
  residual: [],
  ...overrides,
});

const baseInput = {
  fixtures: [fixture("F1", "E1", "E2"), fixture("F2", "E3", "E4")],
  board: [asn("F1", "Court 1", "2026-08-01T14:00:00Z"), asn("F2", "Court 2", "2026-08-01T14:00:00Z")],
  frozen: new Set(["F2"]),
  existing: [] as Assignment[],
  dependencies: [],
  config,
};

beforeEach(() => {
  repairDecomposedCpsat.mockReset();
  delete process.env.SCHEDULING_REPAIR_SOLVER;
  delete process.env.SCHEDULING_REPAIR_BUDGET_MS;
});

describe("solveBoard (#401, C5, C9)", () => {
  it("makes no attempt at all when the kill switch is off", async () => {
    process.env.SCHEDULING_REPAIR_SOLVER = "off";

    const out = await solveBoard(baseInput);

    expect(out.telemetry).toEqual({ solver_ran: false, fallback: "disabled" });
    expect(repairDecomposedCpsat).not.toHaveBeenCalled();
  });

  it("never asks the decomposed driver when every fixture is already frozen", async () => {
    const out = await solveBoard({ ...baseInput, frozen: new Set(["F1", "F2"]) });

    expect(repairDecomposedCpsat).not.toHaveBeenCalled();
    expect(out.assignments).toEqual(baseInput.board);
    expect(out.movedFixtureIds).toEqual([]);
    expect(out.telemetry.solver_ran).toBe(false);
  });

  it("delegates to the decomposed driver even when a violator's dependency touches a frozen feeder", async () => {
    // C5 shipped a narrow guard here (`a59a9916`) that declined the solver
    // entirely for this shape, because `buildSchedule`'s own encoder drops a
    // dependency edge with exactly one end frozen. C9 removed that guard —
    // decomposition (with its own targeted nudge for exactly this residual
    // shape) is now expected to handle it, so this module trusts the driver
    // rather than pre-empting it.
    repairDecomposedCpsat.mockResolvedValueOnce(decomposedResult(baseInput.board));

    const out = await solveBoard({
      ...baseInput,
      dependencies: [{ fixtureId: "F1", dependsOn: "F2", direct: true }],
    });

    expect(repairDecomposedCpsat).toHaveBeenCalledTimes(1);
    expect(out.telemetry.solver_ran).toBe(true);
  });

  it("passes the caller's own frozen/violator split straight through as callerFrozen", async () => {
    repairDecomposedCpsat.mockResolvedValueOnce(decomposedResult(baseInput.board));

    await solveBoard({ ...baseInput, frozen: new Set(["F2"]) });

    const sent = repairDecomposedCpsat.mock.calls[0]![0];
    expect(sent.callerFrozen).toEqual(new Set(["F2"]));
    expect(sent.fixtures).toEqual(baseInput.fixtures);
    expect(sent.proposal).toEqual(baseInput.board);
  });

  it("keeps a frozen id with no known slot out of callerFrozen instead of anchoring it to an invented one", async () => {
    // Defensive narrowing (module doc comment): a fixture the model reported
    // unschedulable is absent from `board`. If the caller carelessly left it
    // in `frozen` anyway, this module must not forward it as `callerFrozen`
    // — the decomposed driver has no slot to anchor it to either.
    repairDecomposedCpsat.mockResolvedValueOnce(
      decomposedResult([asn("F1", "Court 1", "2026-08-01T14:00:00Z")]),
    );

    await solveBoard({
      ...baseInput,
      board: [asn("F1", "Court 1", "2026-08-01T14:00:00Z")], // F2 absent: unschedulable
      frozen: new Set(["F2"]), // caller still names it
    });

    const sent = repairDecomposedCpsat.mock.calls[0]![0];
    expect(sent.callerFrozen).toEqual(new Set());
  });

  it("forwards the run's remaining budget as the driver's budgetMs", async () => {
    repairDecomposedCpsat.mockResolvedValueOnce(decomposedResult(baseInput.board));

    await solveBoard({ ...baseInput, budgetMs: 12_345 });

    const sent = repairDecomposedCpsat.mock.calls[0]![0];
    expect(sent.budgetMs).toBe(12_345);
  });

  it("never lets a driver throw reach the run, and records it", async () => {
    repairDecomposedCpsat.mockRejectedValueOnce(new Error("placement service exploded"));

    const out = await solveBoard(baseInput);

    expect(out.assignments).toBeNull();
    expect(out.telemetry.solver_ran).toBe(true);
    expect(out.telemetry.fallback).toBe("error");
  });

  it("reports repaired, with minimality, when the driver fully resolves the violator set", async () => {
    repairDecomposedCpsat.mockResolvedValueOnce(
      decomposedResult(
        [asn("F1", "Court 2", "2026-08-01T15:00:00Z"), asn("F2", "Court 2", "2026-08-01T14:00:00Z")],
        {
          moved: ["F1"],
          k: 1,
          unresolvedFixtureIds: [],
          minimality: { verdict: "proved", k: 1, lowerBound: 1, witnesses: [], caveats: [] },
        },
      ),
    );

    const out = await solveBoard(baseInput);

    expect(out.movedFixtureIds).toEqual(["F1"]);
    expect(out.telemetry.status).toBe("repaired");
    expect(out.telemetry.fallback).toBeUndefined();
    expect(out.telemetry.minimality).toBe("proved");
  });

  it("does not report minimality on a partial or unrepaired result", async () => {
    repairDecomposedCpsat.mockResolvedValueOnce(
      decomposedResult(baseInput.board, {
        status: "unrepaired",
        moved: [],
        unresolvedFixtureIds: ["F1"],
        minimality: { verdict: "upper_bound", k: 0, lowerBound: 1, witnesses: [], caveats: [] },
      }),
    );

    const out = await solveBoard(baseInput);

    expect(out.telemetry.status).toBe("unrepaired");
    expect(out.telemetry.minimality).toBeUndefined();
  });

  it("reports partial when a violator is still blocking after the attempt, narrowed to violators only", async () => {
    const out1 = componentReport(["F1"], "repaired", { k: 1, moved: ["F1"] });
    const out2 = componentReport(["F3"], "infeasible");
    repairDecomposedCpsat.mockResolvedValueOnce(
      decomposedResult(
        [
          asn("F1", "Court 2", "2026-08-01T18:00:00Z"),
          asn("F2", "Court 2", "2026-08-01T14:00:00Z"),
          asn("F3", "Court 1", "2026-08-01T18:00:00Z"),
        ],
        {
          status: "partial",
          moved: ["F1"],
          unresolvedFixtureIds: ["F3"],
          components: [out1, out2],
        },
      ),
    );

    const out = await solveBoard({
      ...baseInput,
      fixtures: [...baseInput.fixtures, fixture("F3", "E5", "E6")],
      frozen: new Set(["F2"]),
    });

    expect(out.telemetry.status).toBe("partial");
    expect(out.unresolvedFixtureIds).toEqual(["F3"]);
    expect(out.telemetry.fallback).toBe("partial");
    expect(out.telemetry.components_solved).toBe(1);
    expect(out.telemetry.components_skipped).toBe(1);
  });

  it("folds a violator the model never gave a slot at all into unresolvedFixtureIds — invisible to the driver, not silently clean", async () => {
    // The decomposed driver works over CURRENT PLACEMENTS: a violator absent
    // from `board` from the start has no row for `repairComponents` to build
    // a component from, so it can never appear in the driver's own
    // `unresolvedFixtureIds`. `solveBoard` must fold it in itself. F2 stays
    // genuinely frozen AND present here, deliberately, so this test isolates
    // the unplaced-violator fold from the separate defensive-narrowing path
    // (covered above, "keeps a frozen id with no known slot...").
    repairDecomposedCpsat.mockResolvedValueOnce(
      decomposedResult(baseInput.board, {
        status: "unrepaired",
        moved: [],
        unresolvedFixtureIds: [],
        components: [],
      }),
    );

    const out = await solveBoard({
      ...baseInput,
      fixtures: [...baseInput.fixtures, fixture("F3", "E5", "E6")],
      frozen: new Set(["F2"]),
      // F3 never appears in `board` at all — the model never scheduled it.
    });

    expect(out.telemetry.status).toBe("unrepaired");
    expect(out.unresolvedFixtureIds).toEqual(["F3"]);
    expect(out.movedFixtureIds).toEqual([]);
  });

  it("also folds a claimed-frozen-but-unplaced fixture into unresolvedFixtureIds, via the same defensive narrowing", async () => {
    // Combines both effects at once: F2 is named `frozen` but absent from
    // `board`, so it is narrowed OUT of `callerFrozen` (never anchored to an
    // invented slot) AND — since it then has no row for the driver to build
    // a component from either — folded into `unresolvedFixtureIds` here,
    // never silently dropped.
    repairDecomposedCpsat.mockResolvedValueOnce(
      decomposedResult([asn("F1", "Court 1", "2026-08-01T14:00:00Z")], {
        status: "unrepaired",
        moved: [],
        unresolvedFixtureIds: [],
        components: [],
      }),
    );

    const out = await solveBoard({
      ...baseInput,
      board: [asn("F1", "Court 1", "2026-08-01T14:00:00Z")], // F2 absent, still named frozen
      frozen: new Set(["F2"]),
    });

    expect(out.telemetry.status).toBe("unrepaired");
    expect(out.unresolvedFixtureIds).toEqual(["F2"]);
  });

  it("reports unrepaired, with a budget fallback, when a component's own budget was exhausted", async () => {
    repairDecomposedCpsat.mockResolvedValueOnce(
      decomposedResult(baseInput.board, {
        status: "unrepaired",
        moved: [],
        unresolvedFixtureIds: ["F1"],
        components: [componentReport(["F1"], "skipped", { skipReason: "budget_exhausted" })],
      }),
    );

    const out = await solveBoard(baseInput);

    expect(out.telemetry.status).toBe("unrepaired");
    expect(out.telemetry.fallback).toBe("budget");
    expect(out.telemetry.timed_out).toBe(true);
    expect(out.movedFixtureIds).toEqual([]);
  });

  it("defaults the budget to 45s and honours the deployment override", () => {
    expect(solverBudgetMs()).toBe(45_000);
    process.env.SCHEDULING_REPAIR_BUDGET_MS = "7000";
    expect(solverBudgetMs()).toBe(7_000);
  });
});

describe("applySolverMoves", () => {
  it("rewrites only the fixtures the solver moved", () => {
    const plan = {
      assignments: [
        { fixture_id: "a", scheduled_at: "2026-08-01T14:00:00+01:00", court_label: "Court 1" },
        { fixture_id: "b", scheduled_at: "2026-08-01T14:00:00+01:00", court_label: "Court 2" },
      ],
    };
    const repaired: Assignment[] = [
      { ...asn("a", "Court 2", "2026-08-01T15:00:00Z"), entrants: [], people: [] },
    ];

    const out = applySolverMoves(plan, repaired, ["a"], () => "2026-08-01T16:00:00+01:00");

    expect(out.assignments[0]).toEqual({
      fixture_id: "a",
      scheduled_at: "2026-08-01T16:00:00+01:00",
      court_label: "Court 2",
    });
    // Untouched byte for byte — a diff between the two boards shows the repair
    // and nothing else.
    expect(out.assignments[1]).toBe(plan.assignments[1]);
  });
});
