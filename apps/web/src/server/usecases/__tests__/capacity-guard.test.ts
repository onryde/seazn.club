// capacity-guard.test.ts — the web-layer AUTHORITY (guardCapacity): the
// throw + structured log around `assessCapacity`. The DB-shape ->
// CapacityInput adapter it re-exports (`capacityInputForFixtures`) is
// tested at its true source, apps/web/src/lib/__tests__/capacity-input.test.ts
// — this file only proves the re-export is wired (first test below) and
// exercises guardCapacity's own behaviour.
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import { capacityInputForFixtures as capacityInputForFixturesDirect } from "@/lib/capacity-input";
import { capacityInputForFixtures, guardCapacity } from "../capacity-guard";

const MS_PER_MIN = 60_000;
const DAY_MS = 24 * 60 * MS_PER_MIN;
// 2026-10-19T00:00:00Z, an exact UTC midnight so day-bucket math is trivial.
const DAY1 = Date.UTC(2026, 9, 19, 0, 0);

function baseConfig() {
  return {
    courts: ["Court 1"],
    sessionWindows: [] as { from: number; to: number }[],
    blackouts: [] as { court?: string; from: number; to: number }[],
    matchMinutes: 30,
    gapMinutes: 0,
    perEntrantMinRest: 0,
    window: { from: DAY1, to: DAY1 + DAY_MS },
    tz: "UTC",
  };
}

describe("capacity-guard's re-export", () => {
  it("is the SAME function as @/lib/capacity-input's, not a second copy", () => {
    expect(capacityInputForFixtures).toBe(capacityInputForFixturesDirect);
  });
});

describe("guardCapacity", () => {
  it("throws HttpError 422 CAPACITY_IMPOSSIBLE with the report attached when the verdict is impossible", () => {
    // 1 court, 240-minute window, m=30 g=10 -> supply=6; 10 fixtures -> impossible.
    const config = { ...baseConfig(), matchMinutes: 30, gapMinutes: 10, window: { from: DAY1, to: DAY1 + 240 * MS_PER_MIN } };
    const input = capacityInputForFixtures(
      Array.from({ length: 10 }, () => ({ home: undefined, away: undefined, poolId: undefined })),
      config,
      "div-1",
    );
    let caught: unknown;
    try {
      guardCapacity(input, { scope: "stage", divisionId: "div-1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    const err = caught as HttpError;
    expect(err.status).toBe(422);
    expect(err.code).toBe("CAPACITY_IMPOSSIBLE");
    expect((err.extra as { report?: { verdict?: string } } | undefined)?.report?.verdict).toBe("impossible");
  });

  it("does not throw, and returns the report, when the verdict is ok", () => {
    const config = { ...baseConfig(), window: { from: DAY1, to: DAY1 + 240 * MS_PER_MIN } };
    const input = capacityInputForFixtures([], config, "div-1");
    const report = guardCapacity(input, { scope: "stage", divisionId: "div-1" });
    expect(report?.verdict).toBe("ok");
  });

  it("passes null straight through without throwing or logging (nothing to assess)", () => {
    const spy = vi.spyOn(log, "info").mockImplementation(() => log);
    expect(guardCapacity(null, { scope: "stage", divisionId: "div-1" })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("logs a capacity_assessed pino event carrying the verdict", () => {
    const spy = vi.spyOn(log, "info").mockImplementation(() => log);
    const config = { ...baseConfig(), window: { from: DAY1, to: DAY1 + 240 * MS_PER_MIN } };
    const input = capacityInputForFixtures([], config, "div-1");
    guardCapacity(input, { scope: "stage", divisionId: "div-1" });
    expect(spy).toHaveBeenCalledTimes(1);
    const [payload] = spy.mock.calls[0]!;
    expect(payload).toMatchObject({ event: "capacity_assessed", verdict: "ok", scope: "stage", divisionId: "div-1" });
    spy.mockRestore();
  });
});
