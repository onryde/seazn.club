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
  vi.doUnmock("@grpc/grpc-js");
  vi.doUnmock("@bufbuild/protobuf/wire");
  vi.resetModules();
});

/** Make loading either transport library an immediate failure for every module imported AFTER this call (vitest reports a
 *  throwing mock factory as "There was an error when mocking a module", with the factory's own message as the cause). */
function forbidTransportLibraries(): void {
  vi.doMock("@grpc/grpc-js", () => {
    throw new Error("@grpc/grpc-js was loaded");
  });
  vi.doMock("@bufbuild/protobuf/wire", () => {
    throw new Error("@bufbuild/protobuf was loaded");
  });
}

describe("@seazn/scheduler public surface", () => {
  it("exports exactly what its consumers import, and re-exports the same objects the modules define", () => {
    expect(Object.keys(barrel).sort()).toEqual(["PlacementError", "placementSolver", "schedulerLog"]);
    expect(barrel.PlacementError, "instanceof PlacementError must hold across the barrel").toBe(PlacementError);
    expect(barrel.placementSolver).toBe(placementSolver);
  });

  // The engine used to load its client lazily (`await import`), so the first `import` of the scheduling usecases never paid
  // for gRPC and protobuf. A static `export { PlacementError } from "./placement-client.ts"` made `@seazn/scheduler`'s index
  // load both the first time apps/web's schedule.ts is imported, for every route that touches it, solver or not. The error
  // type lives in its own module so the barrel's static graph stays free of the transport.
  it("importing the barrel loads neither gRPC nor protobuf — the client loads only when a solve is asked for", async () => {
    vi.resetModules();
    forbidTransportLibraries();
    // Positive control, first: the guard bites. The client DOES need them, so importing it fails with the named error.
    await expect(import("./placement-client.ts"), "the mock must make the client's own import fail").rejects.toThrow(/error when mocking a module/);
    vi.resetModules();
    const fresh = await import("./index.ts");
    expect(Object.keys(fresh).sort()).toEqual(["PlacementError", "placementSolver", "schedulerLog"]);
  });

  it("an error the real client throws is an instance of the barrel's PlacementError (one class, however it is imported)", async () => {
    vi.resetModules();
    vi.stubEnv("PLACEMENT_SERVICE_HOST", "127.0.0.1:1"); // port 1 is never bound: the dial is refused at once
    const fresh = await import("./index.ts");
    const input = {
      courts: ["Court 1"],
      fixtures: [],
      grid: { slots: [], stepMinutes: 10 },
      existing: [],
      dependencies: [],
      constraints: { matchMinutes: 30, gapMinutes: 10 },
      wallSeconds: 8,
    };
    const failure = await fresh.placementSolver(input, { requestId: "identity" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure, "the closed port must make the real client reject").toBeInstanceOf(Error);
    expect(failure).toBeInstanceOf(fresh.PlacementError);
    expect((failure as InstanceType<typeof fresh.PlacementError>).failure).toBe("unavailable");
    // And the module the client itself defines it from is the same one the barrel re-exports.
    expect((await import("./placement-client.ts")).PlacementError).toBe(fresh.PlacementError);
  }, 30_000);

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
