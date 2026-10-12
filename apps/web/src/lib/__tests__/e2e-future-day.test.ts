// e2e date bomb guard — journey-pro's seeded kick-offs can never be "today".
//
// On 2026-10-12 main's e2e went red on `journey-pro.spec.ts` ("start the
// tournament from the division console"). Nothing in the product had changed:
// the spec seeded its fifteen fixtures at `Date.UTC(2026, 9, 12, 9, 0, 0)`,
// written 2026-09-05 as "well past today", and on the 12th itself the run
// sheet's ladder (`fixtureRowAction`, src/lib/fixture-row-action.ts — a fixture
// scheduled TODAY in the venue zone with no officials offers "Assign scorer",
// not "Score") correctly stopped offering the link the journey waits for. A
// calendar literal in a spec that reads the real clock is green until the day
// it is not.
//
// WHY A NODE TEST. Playwright is not run here, so this pins the two halves the
// fix depends on instead (the `spectator-walkthrough-budget.test.ts` pattern):
//
//   - the ARITHMETIC, by importing the real `futureDayUtc` (a pure e2e module
//     with no imports of its own) and sweeping it against the engine's own
//     `dayKeyInTz` — the exact function the ladder buckets "today" with — in
//     every IANA zone this runtime knows, across a year of clock readings;
//   - the WIRING, by reading the spec's own source. The arithmetic alone stays
//     green with the spec reverted to a literal, which is the regression this
//     file exists to catch, so the source scan is the half with teeth.
//
// Sport-agnostic on purpose: the property is about the clock and the venue
// zone, and the ladder reads neither the sport nor the variant.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";
import { futureDayUtc } from "../../../e2e/future-day";

/** apps/web — this file lives at apps/web/src/lib/__tests__/. */
const WEB = resolve(import.meta.dirname, "../../..");

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Every zone the runtime knows, plus the two fixed-offset extremes the
 *  canonical list may omit (`Etc/GMT+12` is UTC-12, `Etc/GMT-14` is UTC+14 —
 *  POSIX signs are inverted). Deduplicated so the count below is honest. */
const ZONES = [...new Set([...Intl.supportedValuesOf("timeZone"), "UTC", "Etc/GMT+12", "Etc/GMT-14"])];

/** One clock reading per UTC day for a year, at 23:59:59.999Z — the WORST
 *  instant of each day for this property, because `futureDayUtc` pins the
 *  kick-off to a UTC midnight, so the last millisecond of the UTC day is the
 *  closest "now" ever gets to it (and local day is monotone in the instant, in
 *  every zone). A midday reading rides along as an ordinary case. Spanning a
 *  whole year walks every zone through both of its DST transitions. */
const NOWS: number[] = [];
for (let d = 0; d < 366; d++) {
  const dayStart = Date.UTC(2026, 9, 1) + d * DAY_MS;
  NOWS.push(dayStart + DAY_MS - 1, dayStart + 12 * HOUR_MS);
}

type Collision = { tz: string; now: string; kickoff: string; day: string };

/** "Today" for every (zone, now), computed once and shared by every sweep —
 *  it does not depend on the kick-off, and it is half of the formatting cost. */
let todayKeys: Map<string, string[]> | null = null;
function todayIn(tz: string): string[] {
  todayKeys ??= new Map(ZONES.map((z) => [z, NOWS.map((now) => dayKeyInTz(now, z))]));
  return todayKeys.get(tz)!;
}

/** Each sweep is ~300k day-key formats; generous so a loaded CI box reports a
 *  real collision rather than a timeout. */
const SWEEP_TIMEOUT_MS = 30_000;

/** Every (zone, now) where `kickoffOf(now)` lands on the same venue-zone day
 *  as `now` — the ladder's "today" — or earlier. Reports how many pairs it
 *  checked, so an empty sweep cannot pass as a clean one. */
function sweep(kickoffOf: (nowMs: number) => number): { checked: number; collisions: Collision[] } {
  let checked = 0;
  const collisions: Collision[] = [];
  for (const tz of ZONES) {
    const todays = todayIn(tz);
    for (const [i, now] of NOWS.entries()) {
      const kickoff = kickoffOf(now);
      const today = todays[i]!;
      const day = dayKeyInTz(kickoff, tz);
      checked++;
      // `YYYY-MM-DD` keys order lexically. Strictly AFTER today, not merely
      // "not equal": a kick-off in the past is not today either, but it is
      // not the property the journey needs (a fixture that already "happened"
      // is a different run-sheet state) and it would hide a sign error.
      if (!(day > today)) {
        collisions.push({ tz, now: new Date(now).toISOString(), kickoff: new Date(kickoff).toISOString(), day });
      }
    }
  }
  return { checked, collisions };
}

describe("futureDayUtc — the day it seeds is after today in every zone", () => {
  it("knows enough zones and clock readings for the sweep to mean something", () => {
    // ~418 on current ICU. A runtime that returned a handful would make every
    // sweep below vacuously green.
    expect(ZONES.length, "Intl.supportedValuesOf('timeZone') returned too few zones").toBeGreaterThanOrEqual(300);
    expect(NOWS.length).toBe(732);
  });

  it("at the two-day floor and hour 0 (its earliest possible kick-off), no zone ever calls it today", () => {
    // Monotone in both arguments, so the floor (2 days) at the earliest hour is
    // the worst case for every caller: journey-pro's (30, 9) is strictly later.
    const { checked, collisions } = sweep((now) => futureDayUtc(now, 2, 0));
    expect(checked, "the sweep checked nothing").toBe(ZONES.length * NOWS.length);
    expect(collisions.slice(0, 5), `${collisions.length} of ${checked} (zone, now) pairs read as today`).toEqual([]);
  }, SWEEP_TIMEOUT_MS);

  it("journey-pro's own call (30 days, 09:00Z) is never today either", () => {
    const { checked, collisions } = sweep((now) => futureDayUtc(now, 30, 9));
    expect(checked).toBe(ZONES.length * NOWS.length);
    expect(collisions.slice(0, 5), `${collisions.length} of ${checked} pairs read as today`).toEqual([]);
  }, SWEEP_TIMEOUT_MS);

  it("the sweep can SEE a collision — one day ahead is today east of UTC", () => {
    // The counterfactual the helper refuses, computed by hand here: the start
    // of the NEXT UTC day. At 23:59Z it is already 13:59 tomorrow in
    // Kiritimati (UTC+14), and that next UTC midnight is 14:00 the same local
    // day. If this found nothing the sweeps above would be decoration.
    const { checked, collisions } = sweep((now) => Math.floor(now / DAY_MS) * DAY_MS + DAY_MS);
    expect(checked).toBe(ZONES.length * NOWS.length);
    expect(collisions.length, "a one-day horizon must collide somewhere").toBeGreaterThan(0);
    expect(collisions.map((c) => c.tz)).toContain("Pacific/Kiritimati");
  }, SWEEP_TIMEOUT_MS);

  it("…and sees the literal that actually broke main, at the instant CI ran", () => {
    // Run 38226505632 started 2026-10-12T08:54:49Z; the spec seeded 09:00Z
    // that day. The ladder's own day function calls it today — in UTC, and in
    // every European venue zone CI's orgs could resolve to.
    const ciRan = Date.parse("2026-10-12T08:54:49Z");
    const literal = Date.UTC(2026, 9, 12, 9, 0, 0);
    for (const tz of ["UTC", "Europe/London", "Europe/Amsterdam"]) {
      expect(dayKeyInTz(literal, tz), tz).toBe(dayKeyInTz(ciRan, tz));
    }
    // …while the relative kick-off, computed at that same instant, is not.
    expect(dayKeyInTz(futureDayUtc(ciRan, 30, 9), "UTC") > dayKeyInTz(ciRan, "UTC")).toBe(true);
  });

  it("refuses a horizon that can still be today, and a nonsense hour — the guard is reachable", () => {
    const now = Date.parse("2026-10-12T23:00:00Z");
    for (const days of [-1, 0, 1, 1.5, Number.NaN]) {
      expect(() => futureDayUtc(now, days, 9), `daysAhead ${days}`).toThrow(RangeError);
    }
    for (const hour of [-1, 24, Number.NaN]) {
      expect(() => futureDayUtc(now, 2, hour), `hourUtc ${hour}`).toThrow(RangeError);
    }
    expect(() => futureDayUtc(Number.NaN, 2, 9)).toThrow(RangeError);
    // The boundary itself is accepted — the refusal is not a blanket one.
    expect(futureDayUtc(now, 2, 0)).toBe(Date.UTC(2026, 9, 14));
  });
});

/** Block comments and WHOLE-LINE `//` comments only (the
 *  `time-step-coverage.test.ts` convention): a trailing `//` can sit inside a
 *  string, and the specs' own prose quotes the old literal on purpose. A
 *  literal followed by a trailing comment is still code, so it is still seen. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** Specs whose seeded kick-offs feed a "today" decision and are now relative.
 *  Add a spec here when it is converted; the scan below then holds it there. */
const GUARDED_SPECS = ["e2e/journey-pro.spec.ts"] as const;

/** A calendar date in a string literal: `"2026-10-12"`, `'2026-10-12T09:00Z'`. */
const DATE_LITERAL = /(["'`])(\d{4}-\d{2}-\d{2})(T[^"'`]*)?\1/g;
/** The one place a calendar literal is harmless in these specs: a competition's
 *  far-off `starts_on`/`ends_on` bound, which no ladder rung reads as "today". */
const BOUND_KEY = /\b(?:starts_on|ends_on)\s*:\s*$/;

describe.each(GUARDED_SPECS)("%s seeds its kick-offs from the clock, never the calendar", (rel) => {
  const code = stripComments(readFileSync(join(WEB, rel), "utf8"));
  const lines = code.split("\n");

  it("has no literal-year Date.UTC(...) anywhere in its code", () => {
    const hits = lines.filter((l) => /\bDate\.UTC\(\s*\d{4}\b/.test(l)).map((l) => l.trim());
    expect(hits, "a literal calendar instant is back — it goes red the day the calendar reaches it").toEqual([]);
  });

  it("has no calendar date in a string literal, except a competition's starts_on/ends_on bound", () => {
    let bounds = 0;
    const hits: string[] = [];
    for (const line of lines) {
      for (const m of line.matchAll(DATE_LITERAL)) {
        if (!m[3] && BOUND_KEY.test(line.slice(0, m.index))) bounds++;
        else hits.push(line.trim());
      }
    }
    expect(hits, "a calendar date literal is back in a scheduling position").toEqual([]);
    // Reported, so a scan that matched nothing at all is visible as such:
    // journey-pro carries two `ends_on: "2030-12-31"` bounds.
    expect(bounds, "the date-literal scan recognised none of the file's competition bounds").toBeGreaterThan(0);
  });

  it("derives every scheduled_at from futureDayUtc(Date.now(), …) — the positive half", () => {
    const anchor = [...code.matchAll(/const base = futureDayUtc\(\s*Date\.now\(\)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g)];
    expect(anchor.length, "the kick-off base is not futureDayUtc(Date.now(), days, hour)").toBe(1);
    expect(Number(anchor[0]![1]), "daysAhead below the floor futureDayUtc enforces").toBeGreaterThanOrEqual(2);

    const sites = lines.filter((l) => /\bscheduled_at\s*:/.test(l));
    expect(sites.length, "no scheduled_at site found — the scan is looking at the wrong file").toBeGreaterThan(0);
    const unanchored = sites.filter((l) => !/scheduled_at\s*:\s*new Date\(\s*base\b/.test(l)).map((l) => l.trim());
    expect(unanchored, `${sites.length} scheduled_at site(s); these are not derived from base`).toEqual([]);
  });
});
