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
