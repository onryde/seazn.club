import { describe, expect, it } from "vitest";

import northside from "@/demo/ai-templates/northside-open.json";
import { AiRepairReport, ScheduleSolverInfo } from "@/server/api-v1/schemas";

/**
 * C7 — z3 retirement, stage D. `"z3"`, `"z3+lns"` and `"z3_unavailable"` leave
 * the public contract.
 *
 * Nothing has produced any of the three since C4 (`edd358af`) routed REFLOW
 * through the placement service and C9 (`8b85ab39`) moved decomposed repair
 * onto CP-SAT. `"optimized"` and `"solver_unavailable"` are the successors,
 * and both already render through byte-identical user-facing copy in all four
 * locales — which is why this is a deletion rather than a rewording.
 *
 * Deliberately asserts on ACCEPTANCE as well as rejection. A test that only
 * checks the retired values are refused passes just as well against a schema
 * that refuses everything, which is the shape a bad narrowing actually takes.
 */
describe("the public contract has no z3 values left", () => {
  const solver = {
    engine: "optimized" as const,
    status: "ok" as const,
    tiers_completed: 2,
    tiers_total: 4,
    budget_expired: false,
    elapsed_ms: 1234,
    moved: 6,
  };

  it.each(["z3", "z3+lns"])("rejects the retired solver engine %s", (engine) => {
    expect(ScheduleSolverInfo.safeParse({ ...solver, engine }).success).toBe(false);
  });

  it("still accepts both surviving solver engines", () => {
    for (const engine of ["greedy", "optimized"]) {
      expect(ScheduleSolverInfo.parse({ ...solver, engine }).engine).toBe(engine);
    }
  });

  it("rejects the retired z3_unavailable status", () => {
    expect(ScheduleSolverInfo.safeParse({ ...solver, status: "z3_unavailable" }).success).toBe(
      false,
    );
  });

  /** `solver_unavailable` is the successor member and carries the SAME copy
   *  `z3_unavailable` always did, so retiring the older name costs a reader
   *  nothing. Asserted here so the narrowing cannot take both. */
  it("still accepts every surviving status, solver_unavailable included", () => {
    for (const status of [
      "ok",
      "already_optimal",
      "infeasible",
      "verifier_rejected",
      "solver_busy",
      "not_searched",
      "solver_unavailable",
    ]) {
      expect(ScheduleSolverInfo.parse({ ...solver, status }).status).toBe(status);
    }
  });

  it("rejects the retired repair engine z3", () => {
    expect(AiRepairReport.safeParse({ engine: "z3", solver_ran: false }).success).toBe(false);
  });

  it("still accepts every surviving repair engine", () => {
    for (const engine of ["none", "optimized", "llm"]) {
      expect(AiRepairReport.parse({ engine, solver_ran: false }).engine).toBe(engine);
    }
  });

  /**
   * The demo fixture is this repo's stored-artefact analogue of the
   * "pre-migration row" C7's acceptance asks for. No database column holds a
   * solver engine value — verified three ways in C7-1, and recorded in the
   * release-2 index — but this committed blob does, it is parsed by the
   * marketing demo, and it is therefore the one artefact that a narrowing
   * could break.
   */
  it("the shipped demo fixture carries no retired value", () => {
    expect(JSON.stringify(northside)).not.toContain('"z3');
  });
});
