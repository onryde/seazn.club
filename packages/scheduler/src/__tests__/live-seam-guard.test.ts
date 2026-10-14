// Unit tests for the live-seam guard. Unlike placement-integration.test.ts these are NOT skipped without a service: the guard
// is the only thing that notices a live run silently falling back to greedy, so it must be killable on every machine.
import { describe, expect, it } from "vitest";
import type { PlacementSolver, SolveBuildInput, SolveBuildOutcome } from "@seazn/engine/scheduling";
import { assertNoSilentGreedy, assertSolverReached, recordSolver } from "./live-seam-guard.ts";

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

  it("does not read any status other than solver_unavailable as a silent fallback", () => {
    expect(() => assertNoSilentGreedy([{ status: "solver_busy" }, { status: "verifier_rejected" }], false)).not.toThrow();
  });

  it("fails an empty list, deliberate or not: a test that built no board proves nothing about the seam", () => {
    expect(() => assertNoSilentGreedy([], false)).toThrow(/built no board/);
    expect(() => assertNoSilentGreedy([], true)).toThrow(/built no board/);
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
