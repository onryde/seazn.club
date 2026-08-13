// capacity-guard.test.ts — the web-layer AUTHORITY (guardCapacity): the
// throw + structured log around `assessCapacity`. The DB-shape ->
// CapacityInput adapter it re-exports (`capacityInputForFixtures`) is
// tested at its true source, apps/web/src/lib/__tests__/capacity-input.test.ts
// — this file only proves the re-export is wired (first test below) and
// exercises guardCapacity's own behaviour.
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import { v1 } from "@/server/api-v1/http";
import { CAPACITY_REPORT_KEY } from "@/server/api-v1/schemas";
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
    expect((err.extra as Record<string, { verdict?: string } | undefined> | undefined)?.[CAPACITY_REPORT_KEY]?.verdict).toBe(
      "impossible",
    );
  });

  // P1 review finding: the assertion above catches the THROWN HttpError
  // in-process and would have stayed green even while the WIRE key was
  // wrong (the throw used `report`; openapi.ts and smoke.ts both said
  // `capacity_report` — three places that have to agree, silently
  // disagreeing). This test goes through `v1()` — the SAME
  // errorResponse()/NextResponse.json() serialisation a real request
  // hits — and reads the ACTUAL response body, not the exception object.
  it("the WIRE response (not just the thrown object) carries the report under CAPACITY_REPORT_KEY", async () => {
    const config = { ...baseConfig(), matchMinutes: 30, gapMinutes: 10, window: { from: DAY1, to: DAY1 + 240 * MS_PER_MIN } };
    const input = capacityInputForFixtures(
      Array.from({ length: 10 }, () => ({ home: undefined, away: undefined, poolId: undefined })),
      config,
      "div-1",
    );
    const response = await v1(async () => {
      guardCapacity(input, { scope: "stage", divisionId: "div-1" });
      throw new Error("unreachable — guardCapacity must have thrown");
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string; [key: string]: unknown };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("CAPACITY_IMPOSSIBLE");
    const wireReport = body.error[CAPACITY_REPORT_KEY] as { verdict?: string } | undefined;
    expect(wireReport?.verdict).toBe("impossible");
    // The bug this test exists to catch would leave `capacity_report`
    // undefined on the wire while the OLD key (`report`) carried it instead.
    expect((body.error as Record<string, unknown>).report).toBeUndefined();
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
