// Before/after proof for the solver port (engine-split plan Task 1a-2): the port changes HOW the solver and the logger are
// reached, never WHAT the engine asks, says or returns. The snapshot is recorded on the pre-port code and must not change
// when the port lands. It records, per scenario: every request the solver was asked (and the shape of its correlation id),
// every line the engine logged (level, fields, message), and the board the engine returned.
import { describe, expect, it, vi } from "vitest";
import { buildSchedule } from "./build.ts";
import { EQUIVALENCE_SCENARIOS } from "./__tests__/equivalence-scenarios.ts";

// elapsedMs / requestId vary per run; wallSeconds is derived from elapsed time (build.ts:2096) and can cross a rounding edge.
const VOLATILE = new Set(["elapsedMs", "requestId", "wallSeconds"]);
const stable = (r: object) => JSON.parse(JSON.stringify(r, (k, v) => (VOLATILE.has(k) ? 0 : v)));
/** `build-<fixtures>f<courts>c-<t0>`: the first two parts are the request's shape, the last is a clock reading. */
const idShape = (id: string | undefined) => (id ?? "<none>").replace(/-\d+$/, "-<t0>");

const LEVELS = ["debug", "info", "warn", "error"] as const;

describe("solver port equivalence", () => {
  it(`covers ${EQUIVALENCE_SCENARIOS.length} scenarios, including optimized and the empty input`, () => {
    expect(EQUIVALENCE_SCENARIOS.length).toBeGreaterThanOrEqual(10);
    expect(EQUIVALENCE_SCENARIOS.map((s) => s.name)).toEqual(expect.arrayContaining(["optimized", "already_optimal", "empty"]));
    expect(new Set(EQUIVALENCE_SCENARIOS.map((s) => s.name)).size, "scenario names are unique").toBe(EQUIVALENCE_SCENARIOS.length);
  });

  for (const s of EQUIVALENCE_SCENARIOS) {
    it(`asks the solver the same question and returns the same board: ${s.name} (from ${s.source})`, async () => {
      const calls: { input: unknown; requestIdShape: string }[] = [];
      const logs: { level: string; fields: unknown; message: unknown }[] = [];
      const client = await import("./placement-client.ts");
      const logger = await import("./logger.ts");
      const solveSpy = vi.spyOn(client, "solveBuild").mockImplementation(async (input, opts) => {
        calls.push({ input, requestIdShape: idShape(opts?.requestId) });
        return s.solver(input);
      });
      const logSpies = LEVELS.map((level) =>
        vi.spyOn(logger.log, level).mockImplementation((fields: unknown, message?: unknown) => {
          logs.push({ level, fields, message });
        }),
      );
      let result;
      try {
        result = await buildSchedule(s.problem());
      } finally {
        solveSpy.mockRestore();
        for (const spy of logSpies) spy.mockRestore();
      }
      // A leaked queue counter from another file would read solver_busy; only the scenario that IS the busy refusal may.
      if (s.expects.status !== "solver_busy") expect(result.status, "queue counter leaked").not.toBe("solver_busy");
      // What the SOURCE test pinned, so a scenario cannot decay into a snapshot of greedy or of an unreached solver.
      if (s.expects.calls !== undefined) expect(calls.length, "solver calls").toBe(s.expects.calls);
      if (s.expects.status !== undefined) expect(result.status).toBe(s.expects.status);
      if (s.expects.engine !== undefined) expect(result.engine).toBe(s.expects.engine);
      if (s.expects.placed !== undefined) expect(result.metrics.placed).toBe(s.expects.placed);
      expect(logs.some((l) => l.message === "buildSchedule: start"), "the start line is logged on every arm").toBe(true);
      expect(stable({ calls, logs, result })).toMatchSnapshot();
    });
  }
});
