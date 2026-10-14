// Fakes for the engine's solver and logger ports (engine-split plan Task 1a-2). They replace the old
// `vi.spyOn(await import("./placement-client.ts"), "solveBuild")` (since moved to `@seazn/scheduler`) and the `vi.spyOn(log, ...)` calls: a test now hands
// `buildSchedule` the solver it wants answered by, instead of reaching round the engine to the module it imports.
import { vi } from "vitest";
import type { EngineLogger, PlacementSolver, SolveBuildOutcome } from "../solver-port.ts";
export { silentLogger } from "../solver-port.ts";

/** What the old tests got when no spy was installed: the client could not reach a service. */
export const unavailableSolver: PlacementSolver = () =>
  Promise.reject(Object.assign(new Error("placement service unavailable (test fake)"), { failure: "unavailable" }));

export const fakeSolver = (impl: PlacementSolver) => vi.fn<PlacementSolver>(impl);

export const resolvingSolver = (outcome: SolveBuildOutcome) => vi.fn<PlacementSolver>(() => Promise.resolve(outcome));

export const recordingLogger = () => {
  const lines: { level: keyof EngineLogger; fields: Record<string, unknown>; message: string }[] = [];
  const at = (level: keyof EngineLogger) => (fields: Record<string, unknown>, message: string) => void lines.push({ level, fields, message });
  return { lines, log: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") } satisfies EngineLogger };
};
