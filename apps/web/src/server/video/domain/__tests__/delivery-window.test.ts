// Seazn-hosted video Task 31: which UTC days one measurement of a Seazn session's delivered minutes reads — PURE.
//
// The rules are the brief's and the controller's (ruling 3, 2026-11-23), typed here, never read back from the module:
//   * a DAILY read covers the day after the last day measured (`*_measured_through`), or the session's first day when it was never
//     measured, THROUGH YESTERDAY (UTC dates, both included). Today is never read: it has not finished. So a second run on the same
//     day reads nothing, and the next day's run reads exactly the one new day — the guard against counting a day twice;
//   * Cloudflare answers at most 32 dates per query (cf-analytics.ts `CF_ANALYTICS_MAX_WINDOW_DAYS`), so a live read is held to the
//     LAST 32 dates when a session's first day lies further back (a guard on "cannot happen": a session lasts at most
//     MAX_DURATION_MINUTES and is read only while it ended within SEAZN_LIVE_MEASURE_DAYS);
//   * a FINAL read, taken just before a replay host's copy is removed (controller ruling 2: a removed copy answers nothing), covers
//     the same start up to NOW — today's partial day included, since nothing of the copy can be read after.
// No sport: the window reads no sport rule.
import { describe, expect, it } from "vitest";
import { CF_ANALYTICS_MAX_WINDOW_DAYS } from "../../cf-analytics";
import { dailyWindow, dayOf, dayText, endOfDay, finalWindow, utcDay } from "../delivery-window";

const d = (iso: string) => new Date(iso);
const day = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
/** A window as the days it names, so a failure reads as dates. */
const days = (w: { from: Date; through: Date; days: number; clamped: boolean } | null) =>
  w === null ? null : { from: dayText(w.from), through: dayText(w.through), days: w.days, clamped: w.clamped };

describe("the UTC day helpers", () => {
  it("utcDay is the UTC midnight the instant falls on — a late-evening instant west of UTC is still its UTC date; endOfDay is that day's last millisecond", () => {
    expect(utcDay(d("2026-11-22T23:59:59.999Z")).toISOString()).toBe("2026-11-22T00:00:00.000Z");
    expect(utcDay(d("2026-11-23T00:00:00.000Z")).toISOString()).toBe("2026-11-23T00:00:00.000Z");
    expect(utcDay(d("2026-11-22T20:30:00.000-05:00")).toISOString(), "01:30 UTC the next day").toBe("2026-11-23T00:00:00.000Z");
    expect(endOfDay(day("2026-11-22")).toISOString()).toBe("2026-11-22T23:59:59.999Z");
  });

  it("dayOf reads a stored `date` column's text as its UTC midnight; null stays null; a text that is not a date is refused by name, never read as some other day", () => {
    expect(dayOf("2026-11-22")?.toISOString()).toBe("2026-11-22T00:00:00.000Z");
    expect(dayOf(null)).toBeNull();
    const refused = ["", "2026-11-22T00:00:00Z", "22/11/2026", "2026-13-01", "2026-02-30", "nope"];
    let checked = 0;
    for (const text of refused) {
      expect(() => dayOf(text), JSON.stringify(text)).toThrow(/not a date/);
      checked++;
    }
    expect(checked, "anti-vacuity: refused texts").toBe(6);
    expect(dayText(day("2026-01-05"))).toBe("2026-01-05");
  });
});

describe("dailyWindow — through yesterday, from the day after the last one measured", () => {
  const NOW = d("2026-11-23T04:17:00.000Z");   // the sweep's daily slot (cron-worker schedule: 04:17 UTC)

  it("EMPTY CASE FIRST: a session that began today has no finished day to read — and neither does one already measured through yesterday (the second run on one day)", () => {
    expect(dailyWindow({ firstAt: d("2026-11-23T01:00:00.000Z"), measuredThrough: null, now: NOW })).toBeNull();
    expect(dailyWindow({ firstAt: d("2026-11-20T21:30:00.000Z"), measuredThrough: day("2026-11-22"), now: NOW })).toBeNull();
    expect(dailyWindow({ firstAt: d("2026-11-20T21:30:00.000Z"), measuredThrough: day("2026-11-23"), now: NOW }), "a stored day at or past today reads nothing").toBeNull();
  });

  it("never measured: from the session's first UTC date through yesterday, both included", () => {
    expect(days(dailyWindow({ firstAt: d("2026-11-20T21:30:00.000Z"), measuredThrough: null, now: NOW })))
      .toEqual({ from: "2026-11-20", through: "2026-11-22", days: 3, clamped: false });
    expect(days(dailyWindow({ firstAt: d("2026-11-22T23:59:00.000Z"), measuredThrough: null, now: NOW })), "began late yesterday: yesterday only")
      .toEqual({ from: "2026-11-22", through: "2026-11-22", days: 1, clamped: false });
  });

  it("THE SEQUENCE: the first run reads three days, a second run the same day reads nothing, the next day's run reads only the one new day", () => {
    const firstAt = d("2026-11-20T21:30:00.000Z");
    const first = dailyWindow({ firstAt, measuredThrough: null, now: NOW });
    expect(days(first)).toEqual({ from: "2026-11-20", through: "2026-11-22", days: 3, clamped: false });
    // The pass stores `through` as the day measured; the same day's second run starts after it.
    expect(dailyWindow({ firstAt, measuredThrough: first!.through, now: d("2026-11-23T22:00:00.000Z") })).toBeNull();
    const next = dailyWindow({ firstAt, measuredThrough: first!.through, now: d("2026-11-24T04:17:00.000Z") });
    expect(days(next)).toEqual({ from: "2026-11-23", through: "2026-11-23", days: 1, clamped: false });
    // A pass missed for two days catches up in one read, without a gap and without a repeat.
    expect(days(dailyWindow({ firstAt, measuredThrough: next!.through, now: d("2026-11-26T04:17:00.000Z") })))
      .toEqual({ from: "2026-11-24", through: "2026-11-25", days: 2, clamped: false });
  });

  it("the midnight boundary: a run at exactly 00:00 UTC reads through the day that just ended", () => {
    expect(days(dailyWindow({ firstAt: d("2026-11-22T10:00:00.000Z"), measuredThrough: null, now: d("2026-11-23T00:00:00.000Z") })))
      .toEqual({ from: "2026-11-22", through: "2026-11-22", days: 1, clamped: false });
  });

  it("the guard: a live read whose first day lies more than Cloudflare's 32 dates back is held to the LAST 32 and says so; exactly 32 is not clamped; with no limit nothing is", () => {
    const max = CF_ANALYTICS_MAX_WINDOW_DAYS;
    expect(max, "PREMISE: Cloudflare's documented 32 days").toBe(32);
    const through = day("2026-11-22");
    const firstOf = (n: number) => new Date(through.getTime() - (n - 1) * 86_400_000 + 3_600_000);   // n dates back, through included
    expect(days(dailyWindow({ firstAt: firstOf(max), measuredThrough: null, now: NOW, maxDays: max })))
      .toEqual({ from: dayText(utcDay(firstOf(max))), through: "2026-11-22", days: max, clamped: false });
    const clamped = dailyWindow({ firstAt: firstOf(max + 8), measuredThrough: null, now: NOW, maxDays: max });
    expect(days(clamped)).toEqual({ from: "2026-10-22", through: "2026-11-22", days: max, clamped: true });
    expect(days(dailyWindow({ firstAt: firstOf(max + 8), measuredThrough: null, now: NOW })), "the replay host has no such limit")
      .toEqual({ from: "2026-10-14", through: "2026-11-22", days: max + 8, clamped: false });
  });
});

describe("finalWindow — the last read before a copy is removed, up to now", () => {
  const NOW = d("2026-11-23T15:42:10.000Z");

  it("never measured: from the session's first UTC date up to now", () => {
    const w = finalWindow({ firstAt: d("2026-11-20T21:30:00.000Z"), measuredThrough: null, now: NOW });
    expect(w && { from: w.from.toISOString(), to: w.to.toISOString() }).toEqual({ from: "2026-11-20T00:00:00.000Z", to: NOW.toISOString() });
  });

  it("measured through yesterday: today's partial day, from its midnight up to now — the day the daily pass would read tomorrow, when the copy is gone", () => {
    const w = finalWindow({ firstAt: d("2026-11-20T21:30:00.000Z"), measuredThrough: day("2026-11-22"), now: NOW });
    expect(w && { from: w.from.toISOString(), to: w.to.toISOString() }).toEqual({ from: "2026-11-23T00:00:00.000Z", to: NOW.toISOString() });
  });

  it("a stored day at or past today has nothing left to read before now", () => {
    expect(finalWindow({ firstAt: d("2026-11-20T21:30:00.000Z"), measuredThrough: day("2026-11-23"), now: NOW })).toBeNull();
  });
});
