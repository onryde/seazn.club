// capacity-input.test.ts — the CLIENT-SAFE DB/wire-shape -> CapacityInput
// adapter (D2). No DB, no server-only import: this is what the setup card
// imports directly, and capacity-guard.ts (server-only) re-exports the same
// function rather than holding a second copy.
import { describe, expect, it } from "vitest";
import type { HardConstraint } from "@seazn/engine/scheduling";
import { assessCapacity } from "@seazn/engine/scheduling/capacity";
import { weekdayOfYmd } from "@seazn/engine/scheduling/tz";
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

/** `fixture_on_date`/`fixture_on_weekday` — the other two HardConstraint
 *  variants the forced-demand tests below build, both with an `id` selector
 *  (the one selector kind `capacityInputForFixtures` can resolve without a
 *  full RuleFixture identity — see the `terminal` tests further down, which
 *  build their own literal). */
function fixtureOnDate(fixtureId: string, date: string, scope: HardConstraint["scope"]): HardConstraint {
  return { type: "fixture_on_date", selector: { kind: "id", fixtureId }, date, scope };
}
function fixtureOnWeekday(
  fixtureId: string,
  weekday: ReturnType<typeof weekdayOfYmd>,
  scope: HardConstraint["scope"],
): HardConstraint {
  return { type: "fixture_on_weekday", selector: { kind: "id", fixtureId }, weekday, scope };
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

  // The mirror of the case above, and the one that actually shipped broken:
  // both client call sites (stages-panel.tsx, board/settings-panel.tsx) encode
  // "no start date" as `from: -Infinity`, exactly as they encode "no end date"
  // as `to: Infinity`. Only `to` was ever checked, so an end-without-start
  // config reached `calendarDays` -> `dayKeyInTz(-Infinity, tz)` ->
  // `Intl.DateTimeFormat.format(new Date(-Infinity))`, which throws
  // `RangeError: Invalid time value` inside a render-phase useMemo and takes
  // the whole division page down (stg, div 0cb7e4bd, 2026-08-15).
  it("returns null when the window's start is not finite (endAt set, startAt absent)", () => {
    const config = { ...baseConfig(), window: { from: Number.NEGATIVE_INFINITY, to: DAY1 + DAY_MS } };
    expect(() => capacityInputForFixtures([], config, "div-1")).not.toThrow();
    expect(capacityInputForFixtures([], config, "div-1")).toBeNull();
  });

  // `Date.parse` of an unparseable stored date yields NaN, which every call
  // site passes straight through — NaN is not finite either, and reaches the
  // same formatter with the same RangeError.
  it("returns null when either end of the window is NaN (an unparseable stored date)", () => {
    expect(capacityInputForFixtures([], { ...baseConfig(), window: { from: NaN, to: DAY1 + DAY_MS } }, "div-1")).toBeNull();
    expect(capacityInputForFixtures([], { ...baseConfig(), window: { from: DAY1, to: NaN } }, "div-1")).toBeNull();
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

// P10 §4: `courtCalendars` is new — only the SERVER caller
// (capacity-guard.ts's assessCapacityForDivision) ever populates it. These
// are the pure, DB-free proof that the threading itself is correct; the
// server-side resolution (auth, tenant scoping, the DB lookup) is proven at
// its own layer by capacity-endpoint.test.ts (DB-backed).
describe("capacityInputForFixtures — court calendars (P10 §4)", () => {
  // NUMERIC weekday (0=Sunday), the CourtHoursRow convention — NOT
  // weekdayOfYmd's own return, which is the three-letter NAME ("MON") that
  // court-windows.ts's baseFor() indexes WEEKDAY_NAMES[h.weekday] to compare
  // against. Plugging weekdayOfYmd's string straight into `weekday` type-
  // checks as a mismatch (caught only by hand here — vitest does not
  // typecheck test files) and silently filters every hours row out. DAY1
  // (2026-10-19T00Z) is a Monday; verified via
  // `new Date(Date.UTC(2026,9,19)).getUTCDay()`, not assumed.
  const DAY1_WEEKDAY = 1;

  it("narrows a court's usable window to its own calendar hours when courtCalendars supplies one", () => {
    const config = {
      ...baseConfig(),
      courtCalendars: [
        { courtId: "Court 1", hours: [{ weekday: DAY1_WEEKDAY, openMin: 9 * 60, closeMin: 11 * 60 }], exceptions: [] },
      ],
    };
    const input = capacityInputForFixtures([], config, "div-1")!;
    expect(input.days[0]!.courts).toEqual([
      { court: "Court 1", windows: [{ from: DAY1 + 9 * 60 * MS_PER_MIN, to: DAY1 + 11 * 60 * MS_PER_MIN }] },
    ]);
  });

  it("a court absent from courtCalendars keeps the open-all-day default, even while a sibling court IS calendared", () => {
    const config = {
      ...baseConfig(),
      courts: ["Court 1", "Court 2"],
      courtCalendars: [
        { courtId: "Court 2", hours: [{ weekday: DAY1_WEEKDAY, openMin: 0, closeMin: 60 }], exceptions: [] },
      ],
    };
    const input = capacityInputForFixtures([], config, "div-1")!;
    const court1 = input.days[0]!.courts.find((c) => c.court === "Court 1")!;
    const court2 = input.days[0]!.courts.find((c) => c.court === "Court 2")!;
    expect(court1.windows).toEqual([{ from: DAY1, to: DAY1 + DAY_MS }]);
    expect(court2.windows).toEqual([{ from: DAY1, to: DAY1 + 60 * MS_PER_MIN }]);
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

describe("capacityInputForFixtures — forced demand (fixture_on_date / fixture_on_weekday floors)", () => {
  const DIV_SCOPE: HardConstraint["scope"] = { kind: "division", divisionId: "div-1" };

  // Two roomy days: m=30 g=10 -> slot=40, a 240-minute window each day ->
  // supply 6/day, 12 total -- ample for 8 fixtures on TOTAL supply alone
  // (ratio 12/8=1.5 >= TIGHT_RATIO -> "ok" with no rule at all). Same
  // numbers capacity.test.ts's own "per-day FLOOR" describe block uses on
  // the engine side; reusing them here proves this ADAPTER resolves a real
  // fixture_on_date rule into that same forcedDemand field end to end, not
  // just that the engine's walk honours the field once populated by hand.
  function twoRoomyDaysConfig(hard: HardConstraint[] | undefined) {
    return {
      ...baseConfig(),
      window: { from: DAY1, to: DAY1 + 2 * DAY_MS },
      sessionWindows: [
        { from: DAY1, to: DAY1 + 240 * MS_PER_MIN },
        { from: DAY1 + DAY_MS, to: DAY1 + DAY_MS + 240 * MS_PER_MIN },
      ],
      gapMinutes: 10,
      hard,
    };
  }
  const eightFixtures = Array.from({ length: 8 }, (_, i) => ({ id: `f${i + 1}` }));
  const idRulesFor = (ids: string[], date: string): HardConstraint[] => ids.map((id) => fixtureOnDate(id, date, DIV_SCOPE));

  it("fixture_on_date nailing more fixtures onto one day than it holds is impossible, even though total supply is ample", () => {
    const config = twoRoomyDaysConfig(idRulesFor(["f1", "f2", "f3", "f4", "f5", "f6", "f7"], "2026-10-19"));
    const input = capacityInputForFixtures(eightFixtures, config, "div-1")!;
    expect(input.days[0]!.forcedDemand).toBe(7);
    expect(assessCapacity(input).verdict).toBe("impossible");
  });

  it("the paired control -- the SAME board with the rule removed -- is not impossible (the floor is doing the work, not the arithmetic)", () => {
    const config = twoRoomyDaysConfig(undefined);
    const input = capacityInputForFixtures(eightFixtures, config, "div-1")!;
    expect(input.days[0]!.forcedDemand).toBeUndefined();
    expect(assessCapacity(input).verdict).not.toBe("impossible");
  });

  it("two rules naming the SAME fixture on the same date -- one compiled, one durable -- count it once, not twice", () => {
    const config = {
      ...twoRoomyDaysConfig([fixtureOnDate("f1", "2026-10-19", DIV_SCOPE)]),
      constraints: { hard: [fixtureOnDate("f1", "2026-10-19", DIV_SCOPE)] },
    };
    const input = capacityInputForFixtures(eightFixtures, config, "div-1")!;
    expect(input.days[0]!.forcedDemand).toBe(1);
  });

  it("fixture_on_weekday matching SEVERAL dates in the window contributes NO floor on any of them", () => {
    // 8 consecutive days -> day1 and day8 share a weekday (7 days apart); a
    // rule targeting that weekday is a subset restriction across BOTH
    // dates, not a floor on either one (capacity.ts's own doc comment on
    // `forcedDemand`: proving infeasibility over subsets is a Hall
    // condition this precheck deliberately does not attempt).
    const config = {
      ...baseConfig(),
      window: { from: DAY1, to: DAY1 + 8 * DAY_MS },
      hard: [fixtureOnWeekday("f1", weekdayOfYmd("2026-10-19"), DIV_SCOPE)],
    };
    const input = capacityInputForFixtures([{ id: "f1" }], config, "div-1")!;
    expect(input.days).toHaveLength(8);
    expect(input.days[0]!.forcedDemand).toBeUndefined();
    expect(input.days[7]!.forcedDemand).toBeUndefined();
  });

  it("fixture_on_weekday matching EXACTLY ONE date in the window DOES floor that date (the positive counterpart)", () => {
    const config = {
      ...baseConfig(),
      hard: [fixtureOnWeekday("f1", weekdayOfYmd("2026-10-19"), DIV_SCOPE)],
    };
    const input = capacityInputForFixtures([{ id: "f1" }, { id: "f2" }], config, "div-1")!;
    expect(input.days[0]!.forcedDemand).toBe(1);
  });

  it("fixture_on_date outside the window's day buckets is ignored (it constrains nothing inside this window)", () => {
    const config = twoRoomyDaysConfig([fixtureOnDate("f1", "2026-11-01", DIV_SCOPE)]);
    const input = capacityInputForFixtures(eightFixtures, config, "div-1")!;
    expect(input.days.every((d) => d.forcedDemand === undefined)).toBe(true);
  });

  it("a pool-scoped rule is ignored for forcedDemand, exactly as dayCapFor ignores one for demandCap (v1 scope: competition/division only)", () => {
    const config = twoRoomyDaysConfig([
      fixtureOnDate("f1", "2026-10-19", { kind: "pool", divisionId: "div-1", pool: "A" }),
    ]);
    const input = capacityInputForFixtures(eightFixtures, config, "div-1")!;
    expect(input.days[0]!.forcedDemand).toBeUndefined();
  });

  it("a caller supplying no fixture identity (id absent) gets forcedDemand ABSENT, never 0-by-accident", () => {
    // Same rule as the impossible case above, but the fixtures carry no
    // `id` at all -- exactly the client card's shape today (home/away/
    // poolId only, see settings-panel.tsx). The rule cannot be resolved
    // against unidentifiable fixtures, so the day must read as "not
    // assessed" (key absent), never as a computed, misleadingly precise 0.
    const config = twoRoomyDaysConfig(idRulesFor(["f1", "f2", "f3", "f4", "f5", "f6", "f7"], "2026-10-19"));
    const input = capacityInputForFixtures([{ home: "A", away: "B" }, { home: "C", away: "D" }], config, "div-1")!;
    expect(input.days[0]!.forcedDemand).toBeUndefined();
  });

  it("an unknown winnerTo (caller never supplied it) never matches a `terminal` selector -- unknown must not default to null", () => {
    // `null` is resolveSelector's OWN definition of "terminal" (winnerTo
    // === null). Defaulting an UNKNOWN status to null would make every
    // fixture of unknown terminal status match a `terminal` selector --
    // the overcounting direction forcedDemand's own doc comment forbids
    // ("undercounting only ever costs a missed warning; it can never
    // manufacture a false impossible").
    const config = {
      ...baseConfig(),
      hard: [{ type: "fixture_on_date", selector: { kind: "terminal" }, date: "2026-10-19", scope: DIV_SCOPE } satisfies HardConstraint],
    };
    const input = capacityInputForFixtures([{ id: "f1" }], config, "div-1")!; // winnerTo NEVER supplied
    expect(input.days[0]!.forcedDemand).toBeUndefined();
  });

  it("an EXPLICITLY terminal fixture (winnerTo: null) DOES match a `terminal` selector", () => {
    const config = {
      ...baseConfig(),
      hard: [{ type: "fixture_on_date", selector: { kind: "terminal" }, date: "2026-10-19", scope: DIV_SCOPE } satisfies HardConstraint],
    };
    const input = capacityInputForFixtures(
      [
        { id: "f1", winnerTo: null }, // terminal
        { id: "f2", winnerTo: "f1" }, // feeds f1 -- not terminal
      ],
      config,
      "div-1",
    )!;
    expect(input.days[0]!.forcedDemand).toBe(1);
  });
});
