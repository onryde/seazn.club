// W6 (#401), C5 (z3 retirement stage B) — the guarantees `solveBoard` makes
// to both AI runners, tested at the seam rather than through a runner: a
// throw, a reconciliation and a kill switch are all states `buildSchedule`
// cannot be talked into on demand.
//
// `buildSchedule` is the only thing mocked. Everything else in the engine
// barrel is the real module, so `validateAssignments`/`isBlockingConflict`
// stay honest — this file's own `unresolved`/`residual`/`status` counts are
// computed by the REAL verifier over whatever board a test hands back from
// the mock, exactly as `solveBoard` itself does in production.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildSchedule } = vi.hoisted(() => ({ buildSchedule: vi.fn() }));
vi.mock("@seazn/engine/scheduling", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@seazn/engine/scheduling")>()),
  buildSchedule,
}));

import { boardMetrics } from "@seazn/engine/scheduling";
import { applySolverMoves, solveBoard, solverBudgetMs } from "../schedule-ai-solver";
import type { Assignment, BuildInput, BuildResult, SchedulableFixture } from "@seazn/engine/scheduling";

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

/** A `buildSchedule` result over `assignments`, with real metrics computed
 *  the same way the engine itself does — hand-enumerating `BoardMetrics`'s
 *  fields would be a second, driftable copy of the shape. */
const buildResult = (assignments: Assignment[], overrides: Partial<BuildResult> = {}): BuildResult => ({
  assignments,
  conflicts: [],
  metrics: boardMetrics(assignments, config.courts, assignments.length),
  engine: "optimized",
  status: "ok",
  tiersCompleted: 0,
  budgetExpired: false,
  elapsedMs: 5,
  moved: 0,
  lost: 0,
  rlimitSpent: 0,
  lnsWindowRlimits: [],
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
  buildSchedule.mockReset();
  delete process.env.SCHEDULING_REPAIR_SOLVER;
  delete process.env.SCHEDULING_REPAIR_BUDGET_MS;
});

describe("solveBoard (#401, C5)", () => {
  it("makes no attempt at all when the kill switch is off", async () => {
    process.env.SCHEDULING_REPAIR_SOLVER = "off";

    const out = await solveBoard(baseInput);

    expect(out.telemetry).toEqual({ solver_ran: false, fallback: "disabled" });
    expect(buildSchedule).not.toHaveBeenCalled();
  });

  it("never asks buildSchedule when every fixture is already frozen", async () => {
    // The placement service refuses zero movable fixtures — mirrors
    // reflowExisting's identical fully-frozen fast path. Reachable when the
    // ONLY blocking conflict names two fixtures the caller ALSO pinned.
    const out = await solveBoard({ ...baseInput, frozen: new Set(["F1", "F2"]) });

    expect(buildSchedule).not.toHaveBeenCalled();
    expect(out.assignments).toEqual(baseInput.board);
    expect(out.movedFixtureIds).toEqual([]);
    expect(out.telemetry.solver_ran).toBe(false);
  });

  it("reconciles a frozen fixture back onto its known slot, even when buildSchedule itself moved it", async () => {
    // THE regression this module exists to prevent: buildSchedule's fallback
    // exits (already_optimal, a proved tie, verifier_rejected, not_searched)
    // report the plain unpinned greedy seed, which has no idea a
    // current-only frozen id is supposed to stay put (the same finding C4
    // recorded for reflowExisting). F2 is frozen; the mock "incorrectly"
    // relocates it anyway, standing in for that fallback shape.
    buildSchedule.mockResolvedValueOnce(
      buildResult([
        asn("F1", "Court 2", "2026-08-01T15:00:00Z"), // the violator, genuinely repaired
        asn("F2", "Court 1", "2026-08-01T16:00:00Z"), // frozen — buildSchedule moved it anyway
      ]),
    );

    const out = await solveBoard(baseInput);

    expect(out.assignments).toEqual(
      expect.arrayContaining([
        { fixtureId: "F2", court: "Court 2", startAt: T("2026-08-01T14:00:00Z"), endAt: T("2026-08-01T14:30:00Z"), entrants: [], people: [] },
      ]),
    );
    // The frozen fixture never counts as moved, however buildSchedule reported it.
    expect(out.movedFixtureIds).toEqual(["F1"]);
    expect(out.telemetry.status).toBe("repaired");
    expect(out.telemetry.fallback).toBeUndefined();
  });

  it("keeps a frozen id with no known slot free instead of anchoring it to an invented one", async () => {
    // Defensive narrowing (module doc comment): a fixture the model reported
    // unschedulable is absent from `board`. If the caller carelessly left it
    // in `frozen` anyway, this module must NOT forward it to buildSchedule's
    // own `frozen` list — that would pin it to whatever slot buildSchedule's
    // internal greedy seed invents, not leave it free to be placed.
    buildSchedule.mockResolvedValueOnce(buildResult([asn("F1", "Court 1", "2026-08-01T14:00:00Z")]));

    await solveBoard({
      ...baseInput,
      board: [asn("F1", "Court 1", "2026-08-01T14:00:00Z")], // F2 absent: unschedulable
      frozen: new Set(["F2"]), // caller still names it
    });

    const sent = buildSchedule.mock.calls[0]![0] as BuildInput;
    expect(sent.frozen).toEqual([]);
  });

  it("forwards the run's remaining budget as buildSchedule's wall", async () => {
    buildSchedule.mockResolvedValueOnce(buildResult(baseInput.board));

    await solveBoard({ ...baseInput, budgetMs: 12_345 });

    const sent = buildSchedule.mock.calls[0]![0] as BuildInput;
    expect(sent.wallMs).toBe(12_345);
  });

  it("never lets a buildSchedule throw reach the run, and records it", async () => {
    buildSchedule.mockRejectedValueOnce(new Error("placement service exploded"));

    const out = await solveBoard(baseInput);

    expect(out.assignments).toBeNull();
    expect(out.telemetry.solver_ran).toBe(true);
    expect(out.telemetry.fallback).toBe("error");
  });

  it("reports partial when a violator is still blocking after the attempt", async () => {
    // F1 (violator) lands cleanly; F3 (violator) lands ON TOP OF an obstacle —
    // a genuine court double-booking the REAL validateAssignments will catch.
    const obstacle = asn("obstacle:0", "Court 1", "2026-08-01T18:00:00Z");
    buildSchedule.mockResolvedValueOnce(
      buildResult([
        asn("F1", "Court 2", "2026-08-01T18:00:00Z"),
        asn("F3", "Court 1", "2026-08-01T18:00:00Z"), // collides with the obstacle
      ]),
    );

    const out = await solveBoard({
      ...baseInput,
      fixtures: [...baseInput.fixtures, fixture("F3", "E5", "E6")],
      frozen: new Set(["F2"]),
      existing: [obstacle],
    });

    expect(out.telemetry.status).toBe("partial");
    expect(out.unresolvedFixtureIds).toEqual(["F3"]);
    expect(out.telemetry.fallback).toBe("partial");
  });

  it("reports a violator buildSchedule dropped entirely as unresolved, not silently clean", async () => {
    // validateAssignments "cannot report an absence — it iterates the rows
    // it is handed" (BuildResult.conflicts's own doc), so a violator missing
    // from buildSchedule's own assignments never reaches a blocking-conflict
    // row on its own. Checked directly against the reconciled board's
    // membership, not merely its conflict list.
    buildSchedule.mockResolvedValueOnce(buildResult([])); // F1 dropped entirely

    const out = await solveBoard(baseInput);

    expect(out.telemetry.status).toBe("unrepaired");
    expect(out.unresolvedFixtureIds).toEqual(["F1"]);
    expect(out.movedFixtureIds).toEqual([]);
  });

  it("reports unrepaired, with a budget fallback, when buildSchedule never got to search", async () => {
    buildSchedule.mockResolvedValueOnce(
      buildResult(baseInput.board, {
        status: "not_searched",
        notSearchedReason: "out_of_time",
        budgetExpired: true,
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
