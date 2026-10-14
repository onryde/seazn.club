// Before/after proof for the solver port (engine-split plan Task 1a-2): the port changes HOW the solver and the logger are
// reached, never WHAT the engine asks, says or returns. The snapshot was recorded on the pre-port code and must not change
// now the port has landed. It records, per scenario: every request the solver was asked (and the shape of its correlation
// id), every line the engine logged (level, fields, message), and the board the engine returned.
import { describe, expect, it } from "vitest";
import { buildSchedule } from "./build.ts";
import { EQUIVALENCE_SCENARIOS } from "./__tests__/equivalence-scenarios.ts";
import { fakeSolver, recordingLogger } from "./__tests__/solver-fakes.ts";

// elapsedMs / requestId vary per run; wallSeconds is derived from elapsed time (build.ts:2096) and can cross a rounding edge.
const VOLATILE = new Set(["elapsedMs", "requestId", "wallSeconds"]);
const stable = (r: object) => JSON.parse(JSON.stringify(r, (k, v) => (VOLATILE.has(k) ? 0 : v)));
/** `build-<fixtures>f<courts>c-<t0>`: the first two parts are the request's shape, the last is a clock reading. */
const idShape = (id: string | undefined) => (id ?? "<none>").replace(/-\d+$/, "-<t0>");

describe("solver port equivalence", () => {
  it(`covers ${EQUIVALENCE_SCENARIOS.length} scenarios, including optimized and the empty input`, () => {
    expect(EQUIVALENCE_SCENARIOS.length).toBeGreaterThanOrEqual(10);
    expect(EQUIVALENCE_SCENARIOS.map((s) => s.name)).toEqual(expect.arrayContaining(["optimized", "already_optimal", "empty"]));
    expect(new Set(EQUIVALENCE_SCENARIOS.map((s) => s.name)).size, "scenario names are unique").toBe(EQUIVALENCE_SCENARIOS.length);
  });

  for (const s of EQUIVALENCE_SCENARIOS) {
    it(`asks the solver the same question and returns the same board: ${s.name} (from ${s.source})`, async () => {
      const calls: { input: unknown; requestIdShape: string }[] = [];
      const solve = fakeSolver((input, ctx) => {
        calls.push({ input, requestIdShape: idShape(ctx.requestId) });
        return s.solver(input);
      });
      const { lines, log } = recordingLogger();
      const result = await buildSchedule({ ...s.problem(), solve, log });
      const logs = lines.map(({ level, fields, message }) => ({ level, fields, message }));
      // A leaked queue counter from another file would read solver_busy; only the scenario that IS the busy refusal may.
      if (s.expects.status !== "solver_busy") expect(result.status, "queue counter leaked").not.toBe("solver_busy");
      // What the SOURCE test pinned, so a scenario cannot decay into a snapshot of greedy or of an unreached solver.
      expect(solve, "the injected solver is what was asked").toHaveBeenCalledTimes(calls.length);
      if (s.expects.calls !== undefined) expect(calls.length, "solver calls").toBe(s.expects.calls);
      if (s.expects.status !== undefined) expect(result.status).toBe(s.expects.status);
      if (s.expects.engine !== undefined) expect(result.engine).toBe(s.expects.engine);
      if (s.expects.placed !== undefined) expect(result.metrics.placed).toBe(s.expects.placed);
      expect(logs.some((l) => l.message === "buildSchedule: start"), "the start line is logged on every arm").toBe(true);
      expect(stable({ calls, logs, result })).toMatchSnapshot();
    });
  }
});
