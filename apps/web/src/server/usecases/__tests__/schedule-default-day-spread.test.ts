// The solver's objective has nothing that spreads a board across a multi-day
// window (build.ts T1 packs days: it minimises the count of calendar days used,
// and every rung is shift-invariant) — so a 7-day window with no explicit day
// cap piled every fixture onto ONE day, not necessarily the first (W3 T11; see
// `withDefaultDaySpread`'s doc), exactly like a 1-day window did. This is the
// default `max_fixtures_per_day` the auto pass now injects to close that gap,
// tested as the pure function it is rather than through a full autoSchedule
// DB round trip.
import { describe, expect, it } from "vitest";
import { type SlotConfig, type VerifyConfig } from "@seazn/engine/scheduling";
import { withDefaultDaySpread } from "../schedule";

type Config = SlotConfig & VerifyConfig;

const DIVISION = "div-1";
const DAY_MS = 86_400_000;
// Jan 1 00:00 UTC → Jan 8 00:00 UTC: exactly 7 whole UTC calendar days,
// midnight-aligned so the expected day count is unambiguous.
const WEEK_WINDOW = { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 1) + 7 * DAY_MS };
const SAME_DAY_WINDOW = { from: Date.UTC(2026, 0, 1, 9, 0), to: Date.UTC(2026, 0, 1, 18, 0) };
const CONSTRAINT_DEFAULTS = {
  noBackToBack: false,
  startWindows: [],
  fieldFairness: "off" as const,
  parallelism: "mixed" as const,
  crossPersonClash: "warn" as const,
};

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    startAt: WEEK_WINDOW.from,
    matchMinutes: 30,
    gapMinutes: 10,
    courts: ["C1", "C2"],
    perEntrantMinRest: 10,
    window: WEEK_WINDOW,
    tz: "UTC",
    ...overrides,
  };
}

describe("withDefaultDaySpread", () => {
  it("injects ceil(fixtures / availableDays) when nothing was set", () => {
    // Seven days, read off the window itself: `to` is exclusive (midnight after
    // the last day, which is what `applyWindow` hands over).
    const days = (WEEK_WINDOW.to - WEEK_WINDOW.from) / DAY_MS;
    expect(days).toBe(7);

    const out = withDefaultDaySpread(baseConfig(), DIVISION, 37);

    expect(out.constraints?.hard).toEqual([
      { type: "max_fixtures_per_day", count: Math.ceil(37 / days), scope: { kind: "division", divisionId: DIVISION } },
    ]);
  });

  it("never overwrites an explicit whole-division cap the organiser already set", () => {
    const explicit = [
      { type: "max_fixtures_per_day" as const, count: 3, scope: { kind: "division" as const, divisionId: DIVISION } },
    ];
    const config = baseConfig({ constraints: { ...CONSTRAINT_DEFAULTS, hard: explicit } });

    const out = withDefaultDaySpread(config, DIVISION, 37);

    expect(out).toBe(config);
    expect(out.constraints?.hard).toEqual(explicit);
  });

  it("leaves an AI-compiled cap for a DIFFERENT scope alone and still adds the default", () => {
    const entrantScoped = [
      { type: "max_fixtures_per_day" as const, count: 2, scope: { kind: "entrant" as const, entrantId: "e1" } },
    ];
    const config = baseConfig({ constraints: { ...CONSTRAINT_DEFAULTS, hard: entrantScoped } });

    const out = withDefaultDaySpread(config, DIVISION, 14);

    expect(out.constraints?.hard).toEqual([
      ...entrantScoped,
      { type: "max_fixtures_per_day", count: 2, scope: { kind: "division", divisionId: DIVISION } },
    ]);
  });

  it("does nothing for a single-day window — nothing to spread across", () => {
    const config = baseConfig({ window: SAME_DAY_WINDOW });

    const out = withDefaultDaySpread(config, DIVISION, 40);

    expect(out).toBe(config);
  });

  it("does nothing without a resolved org timezone", () => {
    const config = baseConfig({ tz: undefined });

    const out = withDefaultDaySpread(config, DIVISION, 40);

    expect(out).toBe(config);
  });

  it("does nothing for zero schedulable fixtures", () => {
    const config = baseConfig();

    const out = withDefaultDaySpread(config, DIVISION, 0);

    expect(out).toBe(config);
  });

  it("always caps at 1, never 0, even with far more days than fixtures", () => {
    const out = withDefaultDaySpread(baseConfig(), DIVISION, 1);

    expect(out.constraints?.hard).toEqual([
      { type: "max_fixtures_per_day", count: 1, scope: { kind: "division", divisionId: DIVISION } },
    ]);
  });
});

const at = (iso: string) => Date.parse(iso);

function capFor(opts: {
  from: string;
  to: string;
  fixtures: number;
  tz?: string;
  sessions?: [string, string][];
  courts?: number;
  gapMinutes?: number;
  /** Starts of cards already on the board that the day tally will count against the cap. */
  taken?: string[];
}) {
  const config = {
    tz: opts.tz ?? "UTC",
    courts: Array.from({ length: opts.courts ?? 2 }, (_, i) => `C${i + 1}`),
    matchMinutes: 30,
    gapMinutes: opts.gapMinutes ?? 0,
    window: { from: at(opts.from), to: at(opts.to) },
    sessionWindows: (opts.sessions ?? []).map(([a, b]) => ({ from: at(a), to: at(b) })),
  } as unknown as SlotConfig & VerifyConfig;
  const taken = (opts.taken ?? []).map((t) => at(t));
  const rule = withDefaultDaySpread(config, "d1", opts.fixtures, taken).constraints?.hard?.find(
    (h) => h.type === "max_fixtures_per_day",
  );
  return rule?.type === "max_fixtures_per_day" ? rule.count : undefined;
}

// 2026-11-25, stg: a 2-day window counted as 3 days capped 12 Swiss fixtures at
// 4 a day, so only 8 could ever be placed.
describe("withDefaultDaySpread day count", () => {
  it("counts a 2-day window as 2 days", () => {
    expect(capFor({ from: "2026-11-25T00:00:00Z", to: "2026-11-27T00:00:00Z", fixtures: 12 })).toBe(6);
  });

  it("adds no cap to a 1-day window", () => {
    expect(capFor({ from: "2026-11-26T00:00:00Z", to: "2026-11-27T00:00:00Z", fixtures: 12 })).toBeUndefined();
  });

  it("counts days in the org zone across a DST change", () => {
    // London leaves BST on 25 Oct 2026: local midnights 24, 25, 26 -> excl. 27.
    expect(
      capFor({ from: "2026-10-23T23:00:00Z", to: "2026-10-27T00:00:00Z", fixtures: 12, tz: "Europe/London" }),
    ).toBe(4);
  });

  it("never caps below what the window can hold", () => {
    let checked = 0;
    for (let days = 1; days <= 7; days++) {
      for (let fixtures = 1; fixtures <= 40; fixtures++) {
        const to = new Date(at("2026-11-01T00:00:00Z") + days * 86_400_000).toISOString();
        const cap = capFor({ from: "2026-11-01T00:00:00Z", to, fixtures });
        if (cap !== undefined) expect(cap * days).toBeGreaterThanOrEqual(fixtures);
        checked++;
      }
    }
    expect(checked).toBe(280);
  });

  it("counts only days that have play hours, when play hours are set", () => {
    // 3-day window, play hours on the middle day alone: nothing to spread over.
    expect(
      capFor({
        from: "2026-11-25T00:00:00Z",
        to: "2026-11-28T00:00:00Z",
        fixtures: 12,
        sessions: [["2026-11-26T10:00:00Z", "2026-11-26T20:00:00Z"]],
      }),
    ).toBeUndefined();
    // Two sessions on one day are one day.
    expect(
      capFor({
        from: "2026-11-25T00:00:00Z",
        to: "2026-11-28T00:00:00Z",
        fixtures: 12,
        sessions: [
          ["2026-11-25T09:00:00Z", "2026-11-25T12:00:00Z"],
          ["2026-11-25T14:00:00Z", "2026-11-25T18:00:00Z"],
          ["2026-11-26T10:00:00Z", "2026-11-26T20:00:00Z"],
        ],
      }),
    ).toBe(6);
  });
});

// A day can only take as many matches as fit in it. An even share ignores that: a window opening at
// 23:00 gave a day that holds two matches half of twelve, and the other half could not follow it.
describe("withDefaultDaySpread room per day", () => {
  const LATE = { from: "2026-11-25T23:00:00Z", to: "2026-11-27T00:00:00Z" };

  it("gives the days with room what a short day cannot hold", () => {
    expect(capFor({ ...LATE, fixtures: 12, courts: 1 })).toBe(10);
  });

  it("counts every court", () => {
    expect(capFor({ ...LATE, fixtures: 12, courts: 2 })).toBe(8);
  });

  it("counts the gap between matches, but not after the last one", () => {
    // 23:00-24:00 holds two 30-minute matches back to back, one with a 10-minute gap, and two again
    // from 22:50 (30 + 10 + 30 = 70 minutes exactly).
    expect(capFor({ ...LATE, fixtures: 12, courts: 1, gapMinutes: 10 })).toBe(11);
    expect(capFor({ ...LATE, from: "2026-11-25T22:50:00Z", fixtures: 12, courts: 1, gapMinutes: 10 })).toBe(10);
  });

  it("drops a day too short for one match", () => {
    expect(capFor({ ...LATE, from: "2026-11-25T23:45:00Z", fixtures: 12 })).toBeUndefined();
  });

  it("adds no cap when the window cannot hold the fixtures at all", () => {
    expect(capFor({ ...LATE, fixtures: 51, courts: 1 })).toBeUndefined();
    expect(capFor({ ...LATE, fixtures: 50, courts: 1 })).toBe(48);
  });

  it("counts overlapping play hours once", () => {
    // 10:00-11:00 and 10:30-11:00 are one hour: 2 slots on 1 court, not 3.
    const day = (d: number, from: string, to: string): [string, string] => [
      `2026-11-${d}T${from}:00Z`,
      `2026-11-${d}T${to}:00Z`,
    ];
    expect(
      capFor({
        from: "2026-11-25T00:00:00Z",
        to: "2026-11-27T00:00:00Z",
        fixtures: 6,
        courts: 1,
        sessions: [day(25, "10:00", "11:00"), day(25, "10:30", "11:00"), day(26, "10:00", "20:00")],
      }),
    ).toBe(4);
  });

  it("leaves room for the cards already on a day", () => {
    const taken = ["08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00", "11:30"].map(
      (t) => `2026-11-25T${t}:00Z`,
    );
    // The first day's tally starts at 8, so a cap of 6 would leave it nothing and the next day 6 of 8.
    expect(capFor({ ...LATE, fixtures: 8, courts: 1, taken })).toBe(8);
    // A card on a day outside the window takes nothing from any day inside it.
    expect(capFor({ ...LATE, fixtures: 8, courts: 1, taken: ["2026-11-24T08:00:00Z"] })).toBe(6);
  });

  it("every cap it sets leaves room for every fixture", () => {
    let capped = 0;
    for (let courts = 1; courts <= 3; courts++) {
      for (let fixtures = 1; fixtures <= 60; fixtures++) {
        const cap = capFor({ ...LATE, fixtures, courts });
        if (cap === undefined) continue;
        expect(Math.min(cap, 2 * courts) + Math.min(cap, 48 * courts)).toBeGreaterThanOrEqual(fixtures);
        // ...and it is the smallest that does.
        expect(Math.min(cap - 1, 2 * courts) + Math.min(cap - 1, 48 * courts)).toBeLessThan(fixtures);
        capped++;
      }
    }
    expect(capped).toBeGreaterThan(100);
  });
});
