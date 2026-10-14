// Unit tests for the live-seam guard. Unlike placement-integration.test.ts these are NOT skipped without a service: the guard
// is the only thing that notices a live run silently falling back to greedy, so it must be killable on every machine.
import { describe, expect, it } from "vitest";
import type { BuildStatus, PlacementSolver, SolveBuildInput, SolveBuildOutcome } from "@seazn/engine/scheduling";
import { assertLiveSeam, assertNoSilentGreedy, assertSolverReached, recordSolver } from "./live-seam-guard.ts";

/**
 * Every status `buildSchedule` can report, and whether a live, non-deliberate board may END on it. A `Record` over the engine's
 * own `BuildStatus`, so a status added to the engine is a type error here until someone decides which side of the line it is on.
 *
 * Only `ok` (the service's board beat greedy and was accepted) and `already_optimal` (the service proved nothing better exists)
 * mean the real service was asked and answered with a board. Every other status is greedy's board:
 *   - solver_unavailable: the adapter could not reach the service, or it answered ERROR;
 *   - solver_busy: it answered ERROR + SOLVER_BUSY, or the engine's own queue was full;
 *   - verifier_rejected: it answered, and the engine's verifier refused the board;
 *   - not_searched: no verdict (UNKNOWN, out of time, too big, no usable lattice);
 *   - infeasible: it "proved" no board exists, which none of the live files' boards (all feasible by construction) can be.
 */
const MAY_END_ON: Record<BuildStatus, boolean> = {
  ok: true,
  already_optimal: true,
  infeasible: false,
  verifier_rejected: false,
  solver_unavailable: false,
  not_searched: false,
  solver_busy: false,
};
const STATUSES = Object.keys(MAY_END_ON) as BuildStatus[];

describe("assertNoSilentGreedy", () => {
  it("passes a list in which the solver was reached on every board", () => {
    expect(() => assertNoSilentGreedy([{ status: "ok" }, { status: "ok" }], false)).not.toThrow();
  });

  it("fails when any board fell back with solver_unavailable, however many reached the solver", () => {
    expect(() => assertNoSilentGreedy([{ status: "ok" }, { status: "solver_unavailable" }, { status: "ok" }], false)).toThrow(
      /silently exercised greedy/,
    );
  });

  it("passes solver_unavailable when the test pointed at a dead port on purpose", () => {
    expect(() => assertNoSilentGreedy([{ status: "solver_unavailable" }], true)).not.toThrow();
  });

  it("reads every status that is greedy's board as a silent fallback, and only ok / already_optimal as a live answer", () => {
    expect(STATUSES.length, "statuses swept").toBeGreaterThanOrEqual(7);
    expect(STATUSES.filter((s) => MAY_END_ON[s])).toEqual(["ok", "already_optimal"]);
    for (const status of STATUSES) {
      const run = () => assertNoSilentGreedy([{ status }], false);
      if (MAY_END_ON[status]) expect(run, status).not.toThrow();
      else expect(run, status).toThrow(/silently exercised greedy/);
    }
  });

  it("names the status in the failure, so a red live run says which fallback it was", () => {
    expect(() => assertNoSilentGreedy([{ status: "ok" }, { status: "solver_busy" }], false)).toThrow(/solver_busy/);
  });

  it("deliberate: any status is accepted (the dead-port test), but never an empty list", () => {
    for (const status of STATUSES) expect(() => assertNoSilentGreedy([{ status }], true), status).not.toThrow();
  });

  it("fails an empty list, deliberate or not: a test that built no board proves nothing about the seam", () => {
    expect(() => assertNoSilentGreedy([], false)).toThrow(/built no board/);
    expect(() => assertNoSilentGreedy([], true)).toThrow(/built no board/);
  });
});

describe("assertLiveSeam (what the live file's afterEach runs: both guards, one call)", () => {
  const reached = [{ ok: true }] as const;
  const refused = [{ ok: false, error: { code: "SOLVER_BUSY", message: "all workers busy" } }] as const;

  it("passes a live board that the solver answered", () => {
    expect(() => assertLiveSeam([{ status: "ok" }], reached, false)).not.toThrow();
    expect(() => assertLiveSeam([{ status: "already_optimal" }], reached, false)).not.toThrow();
  });

  it("fails on the board's status alone: the solver 'answered' every time, yet the board is greedy's", () => {
    expect(() => assertLiveSeam([{ status: "verifier_rejected" }], reached, false)).toThrow(/silently exercised greedy/);
  });

  it("fails on the solver's calls alone: the board status reads fine, but the service refused (the review's SOLVER_BUSY)", () => {
    expect(() => assertLiveSeam([{ status: "ok" }], refused, false)).toThrow(/SOLVER_BUSY/);
  });

  it("fails when the solver was never asked, even though the board reads fine", () => {
    expect(() => assertLiveSeam([{ status: "ok" }], [], false)).toThrow(/never asked/);
  });

  it("deliberate: a refused call and solver_unavailable are expected, but the solver must still have been asked", () => {
    expect(() => assertLiveSeam([{ status: "solver_unavailable" }], refused, true)).not.toThrow();
    expect(() => assertLiveSeam([{ status: "solver_unavailable" }], [], true)).toThrow(/never asked/);
    expect(() => assertLiveSeam([], refused, true)).toThrow(/built no board/);
  });
});

const INPUT = { wallSeconds: 1 } as unknown as SolveBuildInput;
const OUTCOME: SolveBuildOutcome = { assignments: [], status: "OPTIMAL", tiersCompleted: 0, objectiveValues: [], elapsedMs: 1, wallExhausted: false };

describe("recordSolver / assertSolverReached (the live repair test cannot see a per-component status, so it counts the real adapter's calls)", () => {
  it("records a resolved call and hands the outcome and the request through untouched", async () => {
    let seen: unknown[] = [];
    const inner: PlacementSolver = (input, ctx) => {
      seen = [input, ctx];
      return Promise.resolve(OUTCOME);
    };
    const { solve, calls } = recordSolver(inner);
    await expect(solve(INPUT, { requestId: "r1" })).resolves.toBe(OUTCOME);
    expect(seen).toEqual([INPUT, { requestId: "r1" }]);
    expect(calls).toEqual([{ ok: true }]);
  });

  it("records a rejected call and rethrows the very same error", async () => {
    const boom = Object.assign(new Error("no service"), { failure: "unavailable" });
    const { solve, calls } = recordSolver(() => Promise.reject(boom));
    await expect(solve(INPUT, { requestId: "r2" })).rejects.toBe(boom);
    expect(calls).toEqual([{ ok: false, error: boom }]);
  });

  it("records a RESOLVED status ERROR as not reached, and still returns the outcome unchanged and unthrown", async () => {
    // build.ts folds a resolved ERROR (SOLVER_BUSY, INVALID_REQUEST, proto drift) into greedy exactly as it folds a rejection
    const refused: SolveBuildOutcome = { ...OUTCOME, status: "ERROR", error: { code: "SOLVER_BUSY", message: "all workers busy" } };
    const { solve, calls } = recordSolver(() => Promise.resolve(refused));
    await expect(solve(INPUT, { requestId: "r3" })).resolves.toBe(refused);
    expect(calls).toEqual([{ ok: false, error: refused.error }]);
    expect(() => assertSolverReached(calls)).toThrow(/SOLVER_BUSY/);
    // an ERROR that carries no detail is still a refusal
    const bare = recordSolver(() => Promise.resolve({ ...OUTCOME, status: "ERROR" }));
    await bare.solve(INPUT, { requestId: "r4" });
    expect(() => assertSolverReached(bare.calls)).toThrow(/silently exercised greedy/);
  });

  it.each(["OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"] as const)(
    "records a resolved %s as reached: the service answered, whatever the answer",
    async (status) => {
      const { solve, calls } = recordSolver(() => Promise.resolve({ ...OUTCOME, status }));
      await solve(INPUT, { requestId: "r5" });
      expect(calls).toEqual([{ ok: true }]);
      expect(() => assertSolverReached(calls)).not.toThrow();
    },
  );

  it("fails an empty list: a test whose solver was never asked proves nothing about the seam", () => {
    expect(() => assertSolverReached([])).toThrow(/never asked/);
  });

  it("fails when any call was rejected, however many others resolved", () => {
    expect(() => assertSolverReached([{ ok: true }, { ok: false, error: new Error("connect ECONNREFUSED") }, { ok: true }])).toThrow(
      /silently exercised greedy/,
    );
  });

  it("passes when the solver was asked and answered every time", () => {
    expect(() => assertSolverReached([{ ok: true }])).not.toThrow();
    expect(() => assertSolverReached([{ ok: true }, { ok: true }])).not.toThrow();
  });
});
