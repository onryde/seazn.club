// The solver's objective has nothing that spreads a board across a multi-day
// window (build.ts T1 packs days: it minimises the count of calendar days used,
// and every rung is shift-invariant) — so a 7-day window with no explicit day
// cap piled every fixture onto ONE day, not necessarily the first (W3 T11; see
// `withDefaultDaySpread`'s doc), exactly like a 1-day window did. This is the
// default `max_fixtures_per_day` the auto pass now injects to close that gap,
// tested as the pure function it is rather than through a full autoSchedule
// DB round trip.
import { describe, expect, it } from "vitest";
import { calendarDaysCovering, ymdAddDays, zonedTimeToUtc, type SlotConfig, type VerifyConfig } from "@seazn/engine/scheduling";
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
    // A window whose `to` is the EXCLUSIVE midnight after its last day (the shape `applyWindow` always emits) holds
    // exactly its own whole calendar days: Jan 1 00:00 -> Jan 8 00:00 is SEVEN days, the number it was built from.
    // The cap is sized off that, never off `calendarDaysCovering`'s padded, boundary-inclusive count (which says 8
    // here and made seven real days hold 5 x 7 = 35 of 37 fixtures: two could never be placed).
    const out = withDefaultDaySpread(baseConfig(), DIVISION, 37);

    expect(out.constraints?.hard).toEqual([
      { type: "max_fixtures_per_day", count: Math.ceil(37 / 7), scope: { kind: "division", divisionId: DIVISION } },
    ]);
  });

  it("a one-day window written the way applyWindow writes it (exclusive midnight) is a single day: nothing to spread", () => {
    // The Swiss report (2026-11-25): a division moved to ONE day, 12 fixtures. The helper counted two days and capped
    // the day at 6, so half the board was unplaceable and the auto pass dropped round 1.
    const oneDay = { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 2) };
    const config = baseConfig({ window: oneDay });

    const out = withDefaultDaySpread(config, DIVISION, 12);

    expect(out).toBe(config);
  });

  it("the injected cap always holds every fixture: cap x real days >= fixtures, over a sweep of windows, zones and sizes", () => {
    // Capacity is the invariant, whatever the counting convention: a default the organiser never asked for may spread a
    // board but must never make it unplaceable. The real day count comes from the window's own construction (N whole
    // local days from midnight), not from the helper.
    let checked = 0;
    for (const tz of ["UTC", "Asia/Kolkata", "America/New_York"]) {
      for (let days = 1; days <= 9; days++) {
        for (const fixtures of [1, 2, 7, 12, 15, 36, 37, 100]) {
          const from = zonedTimeToUtc("2026-03-05", "00:00", tz);
          const to = zonedTimeToUtc(ymdAddDays("2026-03-05", days), "00:00", tz);
          const out = withDefaultDaySpread(baseConfig({ window: { from, to }, tz }), DIVISION, fixtures);
          const cap = out.constraints?.hard?.find((h) => h.type === "max_fixtures_per_day")?.count;
          const capacity = cap === undefined ? Infinity : cap * days;
          expect(capacity, `${tz}, ${days} day(s), ${fixtures} fixtures: cap ${cap}`).toBeGreaterThanOrEqual(fixtures);
          checked++;
        }
      }
    }
    expect(checked, "anti-vacuity: the sweep ran every window").toBe(3 * 9 * 8);
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
    const days = calendarDaysCovering(WEEK_WINDOW, "UTC").length - 2;
    const out = withDefaultDaySpread(baseConfig(), DIVISION, 1);

    expect(days).toBeGreaterThan(1);
    expect(out.constraints?.hard).toEqual([
      { type: "max_fixtures_per_day", count: 1, scope: { kind: "division", divisionId: DIVISION } },
    ]);
  });
});
