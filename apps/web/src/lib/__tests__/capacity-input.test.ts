// capacity-input.test.ts — the CLIENT-SAFE DB/wire-shape -> CapacityInput
// adapter (D2). No DB, no server-only import: this is what the setup card
// imports directly, and capacity-guard.ts (server-only) re-exports the same
// function rather than holding a second copy.
import { describe, expect, it } from "vitest";
import type { HardConstraint } from "@seazn/engine/scheduling";
import { capacityInputForFixtures } from "../capacity-input";

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

  it("spans multiple calendar days without the solver lattice's +-1 day padding", () => {
    const config = { ...baseConfig(), window: { from: DAY1, to: DAY1 + 3 * DAY_MS } };
    const input = capacityInputForFixtures([], config, "div-1")!;
    expect(input.days.map((d) => d.date)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21"]);
  });

  it("a sub-day window is ONE day CLIPPED to its real span, not a full day and not zero days", () => {
    // The tournament's whole window is 4 hours on its only day — the day
    // must not disappear (excluding it entirely silently reports whatever
    // the rest of the arithmetic assumes as ample supply) and must not
    // widen to the full 24h (which would silently overstate supply too).
    const config = { ...baseConfig(), window: { from: DAY1, to: DAY1 + 240 * MS_PER_MIN } };
    const input = capacityInputForFixtures([], config, "div-1")!;
    expect(input.days).toHaveLength(1);
    expect(input.days[0]!.courts).toEqual([{ court: "Court 1", windows: [{ from: DAY1, to: DAY1 + 240 * MS_PER_MIN }] }]);
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
      hard: [maxPerDay(9, { kind: "competition" }), maxPerDay(2, { kind: "division", divisionId: "div-1" })],
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

  it("merges a durable constraints.hard cap with a compiled top-level hard cap (effectiveHard's own merge, reimplemented)", () => {
    const config = {
      ...baseConfig(),
      hard: [maxPerDay(6, { kind: "division", divisionId: "div-1" })],
      constraints: { hard: [maxPerDay(3, { kind: "division", divisionId: "div-1" })] },
    };
    const input = capacityInputForFixtures([], config, "div-1")!;
    expect(input.days[0]!.demandCap).toBe(3);
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
