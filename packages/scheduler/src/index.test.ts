// The package's public surface (engine-split plan Task 1a-3). `schedulerLog` is the one adapter nothing else exercises
// without a live service: the engine's logger port is fed by it in production, so a level mapped to the wrong pino method
// would reach nothing but a log line nobody reads.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as barrel from "./index.ts";
import { log } from "./logger.ts";
import { PlacementError } from "./placement-client.ts";
import { placementSolver } from "./solver.ts";

const LEVELS = ["debug", "info", "warn", "error"] as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("@seazn/scheduler public surface", () => {
  it("exports exactly what its consumers import, and re-exports the same objects the modules define", () => {
    expect(Object.keys(barrel).sort()).toEqual(["PlacementError", "placementSolver", "schedulerLog"]);
    expect(barrel.PlacementError, "instanceof PlacementError must hold across the barrel").toBe(PlacementError);
    expect(barrel.placementSolver).toBe(placementSolver);
  });

  it.each(LEVELS)("schedulerLog.%s hands the fields and the message to pino at that level and no other", (level) => {
    const spies = Object.fromEntries(LEVELS.map((l) => [l, vi.spyOn(log, l).mockImplementation(() => undefined)])) as Record<
      (typeof LEVELS)[number],
      ReturnType<typeof vi.spyOn>
    >;
    barrel.schedulerLog[level]({ fixtureId: "f1" }, "hello");
    expect(spies[level]).toHaveBeenCalledExactlyOnceWith({ fixtureId: "f1" }, "hello");
    for (const other of LEVELS.filter((l) => l !== level)) expect(spies[other], `${other} must not fire`).not.toHaveBeenCalled();
  });

  it("is the logger the engine's scheduler used to own: the same name, and LOG_LEVEL decides its level", async () => {
    expect(log.bindings()).toEqual({ name: "engine.scheduling" });
    vi.stubEnv("LOG_LEVEL", "warn");
    vi.resetModules();
    expect((await import("./logger.ts")).log.level).toBe("warn");
    vi.stubEnv("LOG_LEVEL", undefined);
    vi.resetModules();
    expect((await import("./logger.ts")).log.level, "unset LOG_LEVEL falls back to info").toBe("info");
  });
});
