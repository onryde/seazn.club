// The guard the live placement tests run after each case (plan Review Focus 2): with the service configured, a
// `solver_unavailable` result means the real adapter failed to reach it and the engine fell back to greedy, and most boards
// in the live files are ones greedy alone can place, so nothing else would notice. It lives here, apart from the skipped
// describe it guards, so a unit test can reach it without a service (live-seam-guard.test.ts).
import { expect } from "vitest";
import type { BuildResult, PlacementSolver } from "@seazn/engine/scheduling";

/**
 * Throws unless the boards a live test built prove the real solver was asked.
 *
 * - An EMPTY list fails whatever `deliberate` says: a test that built nothing proves nothing about the seam.
 * - Any `solver_unavailable` fails, unless `deliberate`: the one test that points at a dead port on purpose.
 */
export function assertNoSilentGreedy(results: readonly Pick<BuildResult, "status">[], deliberate: boolean): void {
  expect(results.length, "the test built no board over the live seam").toBeGreaterThan(0);
  if (!deliberate) {
    expect(
      results.filter((r) => r.status === "solver_unavailable").length,
      "the real adapter could not reach the service: this run silently exercised greedy",
    ).toBe(0);
  }
}

/** One question the engine put to the solver: it answered, or the adapter threw (the service could not be reached). */
export type SolverCall = { ok: true } | { ok: false; error: unknown };

/**
 * Wraps the real adapter so a live test can count what the engine asked it. `repairDecomposedCpsat` folds a component whose
 * solve failed into its own fallback and reports no per-component status, so a dead service looks like a repaired board:
 * the adapter's calls are the only witness. A rejection is rethrown UNCHANGED, so the engine behaves exactly as it would
 * without the wrapper.
 */
export function recordSolver(solver: PlacementSolver): { solve: PlacementSolver; calls: SolverCall[] } {
  const calls: SolverCall[] = [];
  const solve: PlacementSolver = async (input, ctx) => {
    try {
      const outcome = await solver(input, ctx);
      calls.push({ ok: true });
      return outcome;
    } catch (error) {
      calls.push({ ok: false, error });
      throw error;
    }
  };
  return { solve, calls };
}

/**
 * Throws unless the real solver was asked at least once and answered every time.
 *
 * - NO calls fails: a test that never reached the solver proves nothing about the seam.
 * - Any rejected call fails: the real adapter could not reach the service and the engine fell back to greedy.
 */
export function assertSolverReached(calls: readonly SolverCall[]): void {
  expect(calls.length, "the solver was never asked: this run exercised no live seam").toBeGreaterThan(0);
  expect(
    calls.flatMap((c) => (c.ok ? [] : [String(c.error)])),
    "the real adapter could not reach the service: this run silently exercised greedy",
  ).toEqual([]);
}
