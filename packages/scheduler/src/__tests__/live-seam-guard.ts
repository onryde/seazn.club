// The guard the live placement tests run after each case (plan Review Focus 2): with the service configured, a
// `solver_unavailable` result means the real adapter failed to reach it and the engine fell back to greedy, and most boards
// in the live files are ones greedy alone can place, so nothing else would notice. It lives here, apart from the skipped
// describe it guards, so a unit test can reach it without a service (live-seam-guard.test.ts).
import { expect } from "vitest";
import type { BuildResult } from "@seazn/engine/scheduling";

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
