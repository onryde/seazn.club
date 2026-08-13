// capacity-guard.test.ts — the web-layer adapter between DB-shaped schedule
// config/fixtures and the pure engine lib (@seazn/engine/scheduling/capacity).
// No DB: capacityInputForFixtures takes plain in-memory objects, so these
// run as ordinary unit tests, not against the test database.
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import type { HardConstraint } from "@seazn/engine/scheduling";
import { capacityInputForFixtures, guardCapacity } from "../capacity-guard";

const MS_PER_MIN = 60_000;
const DAY_MS = 24 * 60 * MS_PER_MIN;
// 2026-10-19T00:00:00Z, an exact UTC midnight so day-bucket math is trivial.
const DAY1 = Date.UTC(2026, 9, 19, 0, 0);

/** `max_fixtures_per_day` is the only HardConstraint variant these tests
 *  build — a tiny typed helper beats hand-rolling the discriminated union
 *  (whose `type` a loose `string` literal does not narrow) at every call
 *  site. */
function maxPerDay(count: number, scope: HardConstraint["scope"]): HardConstraint {
  return { type: "max_fixtures_per_day", count, scope };
}

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
    constraints: undefined,
    hard: undefined as HardConstraint[] | undefined,
  };
}

describe("capacityInputForFixtures — when to skip", () => {
  it("returns null when the config has no window at all (unbounded span — nothing to precheck)", () => {
    const config = { ...baseConfig(), window: undefined };
    expect(capacityInputForFixtures([], config, "div-1")).toBeNull();
  });

  it("returns null when the window's end is not finite", () => {
    const config = { ...baseConfig(), window: { from: DAY1, to: Number.POSITIVE_INFINITY } };
    expect(capacityInputForFixtures([], config, "div-1")).toBeNull();
  });

  it("returns null when tz is absent (day-bucket math has no zone to run in)", () => {
    const config = { ...baseConfig(), tz: undefined };
    expect(capacityInputForFixtures([], config, "div-1")).toBeNull();
  });
});

describe("capacityInputForFixtures — day/window construction", () => {
  it("builds one day per calendar day in the window, with sessionWindows-minus-blackouts as that court's usable windows", () => {
    // One day, one court. sessionWindows: 09:00-17:00 (480 min). A blackout
    // 12:00-13:00 (60 min) on that same court splits it into two pieces.
    const config = {
      ...baseConfig(),
      sessionWindows: [{ from: DAY1 + 9 * 60 * MS_PER_MIN, to: DAY1 + 17 * 60 * MS_PER_MIN }],
      blackouts: [{ court: "Court 1", from: DAY1 + 12 * 60 * MS_PER_MIN, to: DAY1 + 13 * 60 * MS_PER_MIN }],
    };
    const input = capacityInputForFixtures([], config, "div-1")!;
    expect(input.days).toHaveLength(1);
    expect(input.days[0]!.date).toBe("2026-10-19");
    expect(input.days[0]!.courts).toEqual([
      {
        court: "Court 1",
        windows: [
          { from: DAY1 + 9 * 60 * MS_PER_MIN, to: DAY1 + 12 * 60 * MS_PER_MIN },
          { from: DAY1 + 13 * 60 * MS_PER_MIN, to: DAY1 + 17 * 60 * MS_PER_MIN },
        ],
      },
    ]);
  });

  it("with no sessionWindows declared, the whole day is usable (matches the placer's own 'empty = unrestricted' rule)", () => {
    const input = capacityInputForFixtures([], baseConfig(), "div-1")!;
    expect(input.days[0]!.courts).toEqual([{ court: "Court 1", windows: [{ from: DAY1, to: DAY1 + DAY_MS }] }]);
  });

  it("a global blackout (no court key) subtracts from every court", () => {
    const config = {
      ...baseConfig(),
      courts: ["Court 1", "Court 2"],
      blackouts: [{ from: DAY1, to: DAY1 + 60 * MS_PER_MIN }], // first hour, whole venue
    };
    const input = capacityInputForFixtures([], config, "div-1")!;
    for (const c of input.days[0]!.courts) {
      expect(c.windows).toEqual([{ from: DAY1 + 60 * MS_PER_MIN, to: DAY1 + DAY_MS }]);
    }
  });
});

describe("capacityInputForFixtures — day cap resolution (max_fixtures_per_day)", () => {
  it("applies a division-scoped cap for THIS division, ignores one scoped to a different division", () => {
    const config = {
      ...baseConfig(),
      hard: [
        maxPerDay(5, { kind: "division", divisionId: "div-1" }),
        maxPerDay(1, { kind: "division", divisionId: "OTHER" }),
      ],
    };
    const input = capacityInputForFixtures([], config, "div-1")!;
    expect(input.days[0]!.demandCap).toBe(5);
  });

  it("applies a competition-scoped cap", () => {
    const config = { ...baseConfig(), hard: [maxPerDay(7, { kind: "competition" })] };
    const input = capacityInputForFixtures([], config, "div-1")!;
    expect(input.days[0]!.demandCap).toBe(7);
  });

  it("takes the MINIMUM when both a competition and a division cap apply", () => {
    const config = {
      ...baseConfig(),
      hard: [
        maxPerDay(9, { kind: "competition" }),
        maxPerDay(2, { kind: "division", divisionId: "div-1" }),
      ],
    };
    const input = capacityInputForFixtures([], config, "div-1")!;
    expect(input.days[0]!.demandCap).toBe(2);
  });

  it("ignores a pool/entrant-scoped cap (v1 scope: whole-day aggregate caps only) and leaves demandCap undefined", () => {
    const config = {
      ...baseConfig(),
      hard: [maxPerDay(1, { kind: "pool", divisionId: "div-1", pool: "A" })],
    };
    const input = capacityInputForFixtures([], config, "div-1")!;
    expect(input.days[0]!.demandCap).toBeUndefined();
  });
});

describe("capacityInputForFixtures — entrant aggregation", () => {
  it("counts each entrant's fixtures across home/away, asymmetrically, and carries poolId as groupId", () => {
    const fixtures = [
      { home: "A", away: "B", poolId: "pool-1" },
      { home: "A", away: "C", poolId: "pool-1" },
      { home: "A", away: "D", poolId: "pool-1" },
      { home: "B", away: "C", poolId: "pool-1" },
    ];
    const input = capacityInputForFixtures(fixtures, baseConfig(), "div-1")!;
    expect(input.fixtureCount).toBe(4);
    const byId = new Map(input.entrants.map((e) => [e.entrantId, e]));
    expect(byId.get("A")).toMatchObject({ fixtures: 3, groupId: "pool-1" });
    expect(byId.get("B")).toMatchObject({ fixtures: 2, groupId: "pool-1" });
    expect(byId.get("C")).toMatchObject({ fixtures: 2, groupId: "pool-1" });
    expect(byId.get("D")).toMatchObject({ fixtures: 1, groupId: "pool-1" });
  });

  it("a TBD side (home/away undefined) contributes to fixtureCount but not to any entrant's load", () => {
    const fixtures = [{ home: "A", away: undefined, poolId: undefined }];
    const input = capacityInputForFixtures(fixtures, baseConfig(), "div-1")!;
    expect(input.fixtureCount).toBe(1);
    expect(input.entrants).toEqual([{ entrantId: "A", fixtures: 1 }]);
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
