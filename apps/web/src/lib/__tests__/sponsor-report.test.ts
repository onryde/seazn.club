// R4 sponsors on stream, S13 - the Overview's period rules and the report link's path (lib/sponsor-report.ts), pure.
//
// THE RULEBOOK these expectations come from (stated here, never read back from the module under test):
//   - every period is HALF-OPEN in UTC: [from, to). Spec §5.1 names the three periods and says nothing of their edges, so the
//     controller's default rule stands (addendum 2026-11-01);
//   - "This year" is 1 January 00:00 UTC of `now`'s UTC year up to (not including) 1 January of the next;
//   - "Last 30 days" is 30 whole UTC days ending with `now`'s own day: from 00:00 UTC 29 days before today, to 00:00 UTC
//     tomorrow. Whole days, so a report link (whose bounds are DATES, V483 from_date/to_date) can carry exactly this period;
//   - "One competition" has no time bound at all (null window): it is every airing and click whose fixture is in it.
// Literal dates below are typed from that rule by hand.
import { describe, expect, it } from "vitest";
import {
  LAST_DAYS,
  fmtIsoDay,
  fmtOnScreen,
  isIsoDay,
  linkWindow,
  overviewHref,
  periodWindow,
  reportLinkPath,
  resolveSponsorPeriod,
  windowDates,
  type SponsorPeriod,
} from "../sponsor-report";

const at = (iso: string) => new Date(iso);
const THIS_YEAR: SponsorPeriod = { kind: "this_year" };
const LAST_30: SponsorPeriod = { kind: "last_30_days" };

describe("periodWindow - half-open UTC windows from `now`, never the wall clock", () => {
  it("this year: 1 Jan of now's UTC year to 1 Jan of the next, for a now late on 31 Dec (UTC) and early on 1 Jan", () => {
    expect(periodWindow(THIS_YEAR, at("2026-11-01T10:00:00.000Z"))).toEqual({ from: at("2026-01-01T00:00:00.000Z"), to: at("2027-01-01T00:00:00.000Z") });
    expect(periodWindow(THIS_YEAR, at("2026-12-31T23:59:59.999Z"))).toEqual({ from: at("2026-01-01T00:00:00.000Z"), to: at("2027-01-01T00:00:00.000Z") });
    expect(periodWindow(THIS_YEAR, at("2027-01-01T00:00:00.000Z"))).toEqual({ from: at("2027-01-01T00:00:00.000Z"), to: at("2028-01-01T00:00:00.000Z") });
  });

  it("last 30 days: 30 whole UTC days ending today - across a month end, a year end and a leap day", () => {
    const cases: [string, string, string][] = [
      ["2026-11-01T10:00:00.000Z", "2026-10-03T00:00:00.000Z", "2026-11-02T00:00:00.000Z"],
      ["2026-01-10T00:00:00.000Z", "2025-12-12T00:00:00.000Z", "2026-01-11T00:00:00.000Z"],
      ["2028-03-15T23:59:59.999Z", "2028-02-15T00:00:00.000Z", "2028-03-16T00:00:00.000Z"], // 2028 is a leap year: 29 Feb counts
    ];
    let checked = 0;
    for (const [now, from, to] of cases) {
      const w = periodWindow(LAST_30, at(now));
      expect(w, now).toEqual({ from: at(from), to: at(to) });
      expect((w!.to.getTime() - w!.from.getTime()) / 86_400_000, `${now}: whole days`).toBe(30);
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(LAST_DAYS).toBe(30);
  });

  it("one competition has no time window", () => {
    expect(periodWindow({ kind: "competition", competitionId: "c1" }, at("2026-11-01T10:00:00.000Z"))).toBeNull();
  });

  it("an invalid `now` is refused by name, never turned into a NaN window", () => {
    expect(() => periodWindow(THIS_YEAR, new Date(Number.NaN))).toThrow(/sponsor period: `now` is not a valid date/);
    expect(() => periodWindow(LAST_30, new Date("nonsense"))).toThrow(/sponsor period: `now` is not a valid date/);
  });

  it("a kind the rule does not know is refused by name, never read as some other period", () => {
    expect(() => periodWindow({ kind: "last_7_days" } as unknown as SponsorPeriod, at("2026-11-01T10:00:00.000Z")))
      .toThrow(/sponsor period: unknown kind "last_7_days"/);
  });
});

describe("windowDates - the INCLUSIVE dates a report link carries for a window (V483 date columns)", () => {
  it("this year => 1 Jan .. 31 Dec; last 30 days => 29 days ago .. today", () => {
    expect(windowDates(periodWindow(THIS_YEAR, at("2026-11-01T10:00:00.000Z"))!)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(windowDates(periodWindow(LAST_30, at("2026-11-01T10:00:00.000Z"))!)).toEqual({ from: "2026-10-03", to: "2026-11-01" });
  });
});

describe("resolveSponsorPeriod - the URL's ?period=, kept only when it names a period or one of THIS org's competitions", () => {
  const competitions = [{ id: "11111111-1111-4111-8111-111111111111" }, { id: "22222222-2222-4222-8222-222222222222" }];

  it("absent, empty, unknown, repeated, inherited keys and another org's competition all read as This year (counted)", () => {
    const raws: (string | string[] | undefined)[] = [
      undefined, "", "bogus", "this_year", "THIS_YEAR", "Last_30_days", ["last_30_days"], ["last_30_days", "last_30_days"],
      "__proto__", "constructor", "33333333-3333-4333-8333-333333333333",
    ];
    let checked = 0;
    for (const raw of raws) {
      expect(resolveSponsorPeriod(raw, competitions), JSON.stringify(raw)).toEqual(THIS_YEAR);
      checked++;
    }
    expect(checked).toBe(raws.length);
  });

  it("last_30_days and each of the org's competitions resolve (the positive pair)", () => {
    expect(resolveSponsorPeriod("last_30_days", competitions)).toEqual(LAST_30);
    let checked = 0;
    for (const c of competitions) {
      expect(resolveSponsorPeriod(c.id, competitions)).toEqual({ kind: "competition", competitionId: c.id });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("an org with no competitions can only pick a time period", () => {
    expect(resolveSponsorPeriod(competitions[0]!.id, [])).toEqual(THIS_YEAR);
  });
});

describe("overviewHref - the picker's URL round-trips through resolveSponsorPeriod", () => {
  it("This year is the hub's bare landing URL; the others carry ?period=", () => {
    expect(overviewHref("riverside", THIS_YEAR)).toBe("/o/riverside/sponsors");
    expect(overviewHref("riverside", LAST_30)).toBe("/o/riverside/sponsors?period=last_30_days");
    expect(overviewHref("riverside", { kind: "competition", competitionId: "abc" })).toBe("/o/riverside/sponsors?period=abc");
  });

  it("every period resolves back to itself from its own href (counted)", () => {
    const competitions = [{ id: "11111111-1111-4111-8111-111111111111" }];
    const periods: SponsorPeriod[] = [THIS_YEAR, LAST_30, { kind: "competition", competitionId: competitions[0]!.id }];
    let checked = 0;
    for (const p of periods) {
      const raw = new URL(overviewHref("x", p), "http://h").searchParams.get("period") ?? undefined;
      expect(resolveSponsorPeriod(raw, competitions), JSON.stringify(p)).toEqual(p);
      checked++;
    }
    expect(checked).toBe(3);
  });
});

describe("isIsoDay - a real calendar date in YYYY-MM-DD, nothing else", () => {
  it("accepts real dates (a leap day included) and refuses everything else (counted)", () => {
    const good = ["2026-01-01", "2026-12-31", "2028-02-29"];
    const bad = ["2026-02-29", "2026-13-01", "2026-00-10", "2026-1-1", "2026-01-01T00:00:00Z", "", "20260101", "2026-02-30", " 2026-01-01"];
    for (const s of good) expect(isIsoDay(s), s).toBe(true);
    for (const s of bad) expect(isIsoDay(s), s).toBe(false);
    expect(good.length + bad.length).toBe(12);
  });
});

describe("reportLinkPath - spec §5.2's /r/sponsor/[token]", () => {
  it("puts the token after /r/sponsor/ and nothing else", () => {
    expect(reportLinkPath("abc_DEF-123")).toBe("/r/sponsor/abc_DEF-123");
  });
});

describe("fmtOnScreen - time on screen, to the second (a card holds for seconds, so whole minutes would read 0)", () => {
  // Expected strings from Intl itself (the same unit style the house fmtDuration uses), never retyped per locale.
  const unit = (locale: string, v: number, u: "hour" | "minute" | "second") =>
    new Intl.NumberFormat(locale, { style: "unit", unit: u, unitDisplay: "short" }).format(v);

  it("zero, seconds, minutes and seconds, hours - in every locale (counted)", () => {
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"]) {
      expect(fmtOnScreen(locale, 0), locale).toBe(unit(locale, 0, "second"));
      expect(fmtOnScreen(locale, 8_000), locale).toBe(unit(locale, 8, "second"));
      expect(fmtOnScreen(locale, 850_000), locale).toBe(`${unit(locale, 14, "minute")} ${unit(locale, 10, "second")}`);
      expect(fmtOnScreen(locale, 120_000), locale).toBe(unit(locale, 2, "minute"));
      expect(fmtOnScreen(locale, 3_605_000), locale).toBe(`${unit(locale, 1, "hour")} ${unit(locale, 5, "second")}`);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("rounds to the nearest second and never shows a negative", () => {
    expect(fmtOnScreen("en", 8_499)).toBe(unit("en", 8, "second"));
    expect(fmtOnScreen("en", 8_500)).toBe(unit("en", 9, "second"));
    expect(fmtOnScreen("en", -5_000)).toBe(unit("en", 0, "second"));
  });
});

describe("fmtIsoDay - a link's date in the reader's locale, the UTC day it names", () => {
  it("formats the named day in every locale, whatever the process time zone (counted)", () => {
    // Expected from Intl itself at UTC, never retyped per locale.
    const want = (locale: string, iso: string) =>
      new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"]) {
      for (const day of ["2026-01-01", "2026-12-31", "2028-02-29"]) {
        expect(fmtIsoDay(locale, day), `${locale} ${day}`).toBe(want(locale, day));
        checked++;
      }
    }
    expect(checked).toBe(12);
    // The day, not its neighbour: 1 January stays 1 January (a zone west of UTC would otherwise read 31 December).
    expect(fmtIsoDay("en", "2026-01-01")).toMatch(/2026/);
    expect(fmtIsoDay("en", "2026-01-01")).toMatch(/\b1\b/);
  });
});

// R4 S14 - the public report's window (controller addendum 2026-11-01: S13's rule, `[from_date, to_date + 1 day)` in UTC). A link
// carries INCLUSIVE dates, so the window is from 00:00 UTC of its first day to 00:00 UTC of the day AFTER its last. The expected
// instants are typed from that rule by hand. `windowDates` is the inverse, so a window round-trips through a link.
describe("linkWindow - a report link's inclusive dates as the half-open UTC window the report counts", () => {
  it("from 00:00 UTC of the first day to 00:00 UTC of the day after the last - a one-day link, a month end, a year end, a leap day", () => {
    const cases: [string, string, string, string][] = [
      ["2026-06-15", "2026-06-15", "2026-06-15T00:00:00.000Z", "2026-06-16T00:00:00.000Z"],
      ["2026-06-01", "2026-06-30", "2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z"],
      ["2026-01-01", "2026-12-31", "2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
      ["2028-02-01", "2028-02-29", "2028-02-01T00:00:00.000Z", "2028-03-01T00:00:00.000Z"],
    ];
    let checked = 0;
    for (const [from, to, wantFrom, wantTo] of cases) {
      expect(linkWindow(from, to), `${from}..${to}`).toEqual({ from: at(wantFrom), to: at(wantTo) });
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("round-trips with windowDates: the dates a window gives back are the dates it was made from (counted)", () => {
    let checked = 0;
    for (const [from, to] of [["2026-06-15", "2026-06-15"], ["2025-12-12", "2026-01-10"], ["2028-02-29", "2028-03-01"]] as const) {
      expect(windowDates(linkWindow(from, to)), `${from}..${to}`).toEqual({ from, to });
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("refuses what is not a pair of real dates in order - by name, never a NaN or an inverted window", () => {
    const bad: [string, string][] = [["2026-02-30", "2026-03-01"], ["2026-06-01T00:00", "2026-06-02"], ["", "2026-06-02"], ["2026-06-02", "2026-06-01"]];
    for (const [from, to] of bad) expect(() => linkWindow(from, to), `${from}..${to}`).toThrow(RangeError);
    expect(bad.length).toBe(4);
  });
});
