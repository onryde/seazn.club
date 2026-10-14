// Unit tests for the live-seam guard. Unlike placement-integration.test.ts these are NOT skipped without a service: the guard
// is the only thing that notices a live run silently falling back to greedy, so it must be killable on every machine.
import { describe, expect, it } from "vitest";
import { assertNoSilentGreedy } from "./live-seam-guard.ts";

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
