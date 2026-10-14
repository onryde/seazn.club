import { afterEach, describe, expect, it, vi } from "vitest";
import type { SolveBuildInput, SolveBuildOutcome } from "@seazn/engine/scheduling";
import { placementSolver } from "./solver.ts";

const INPUT = { wallSeconds: 1 } as unknown as SolveBuildInput; // the adapter forwards it untouched; its shape is the client's concern
const OK: SolveBuildOutcome = { assignments: [], status: "OPTIMAL", tiersCompleted: 0, objectiveValues: [], elapsedMs: 1, wallExhausted: false };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("placementSolver (the adapter behind the engine's solver port)", () => {
  it("forwards the engine's question and requestId, and the secret from the environment", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_SECRET", "test-secret");
    const spy = vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue(OK);
    const outcome = await placementSolver(INPUT, { requestId: "build-1f1c-7" });
    expect(spy).toHaveBeenCalledWith(INPUT, { secret: "test-secret", requestId: "build-1f1c-7" });
    expect(outcome, "the client's outcome is handed back as it came").toBe(OK);
  });

  it("sends an empty secret when none is configured, and lets the client's rejection through unchanged", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_SECRET", undefined);
    const spy = vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockRejectedValue(Object.assign(new Error("no"), { failure: "unauthenticated" }));
    await expect(placementSolver(INPUT, { requestId: "r" })).rejects.toMatchObject({ failure: "unauthenticated" });
    expect(spy.mock.calls[0]![1]).toEqual({ secret: "", requestId: "r" });
  });
});
