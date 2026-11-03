// e2e clock guard - the Match Day specs seed "today, near now" and must not depend on the time of day.
//
// On 2026-11-03 main's e2e went red on `match-day.spec.ts` ("E2 items 1, 2, 3, 5, 7 (desktop)", CI run 41548545074, started 23:55Z):
// the seed planned every division in UTC and clamped each instant into the UTC day (`Math.min(dayStart + 86_400_000 - 60_000, ...)`),
// so from about 21:55Z on the future offsets (+45, +50, +60, +75, +120 minutes) all clamped to the SAME 23:59 and the board's order and
// its "Next on <court>" lines were no longer the ones the test derives from those offsets. Nothing in the product had changed.
//
// WHY A NODE TEST. Playwright is not run here, and the failure needs a particular clock to show. So this pins the two halves the fix
// depends on instead (the `e2e-future-day.test.ts` pattern):
//
//   - the ARITHMETIC, by importing the real `middayZoneFor` / `withinToday` (a pure e2e module with no imports of its own) and
//     sweeping them over every five minutes of a UTC day, against the engine's own `dayKeyInTz` - the function the board buckets
//     "today" with - and against the offsets the spec REALLY uses, read from its source;
//   - the WIRING, by reading the spec's own source. The arithmetic alone stays green with the spec reverted to the clamp, which is the
//     regression this file exists to catch, so the source scan is the half with teeth.
//
// Sport-agnostic on purpose: the property is about the clock and the planning zone.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";
import { localDay, middayZoneFor, withinToday } from "../../../e2e/midday-zone";

/** apps/web - this file lives at apps/web/src/lib/__tests__/. */
const WEB = resolve(import.meta.dirname, "../../..");
const SPEC = readFileSync(resolve(WEB, "e2e/match-day.spec.ts"), "utf8");

const MIN = 60_000;
const DAY_MS = 86_400_000;

/** Every five minutes of three UTC days: a month end, an ordinary day and the leap-free February end, so the calendar rolls over in
 *  the sweep. 288 readings a day, including 23:55:00Z - the minute CI ran. */
const NOWS: number[] = [];
for (const day of [Date.UTC(2026, 9, 31), Date.UTC(2026, 10, 3), Date.UTC(2027, 1, 28)]) {
  for (let m = 0; m < 1440; m += 5) NOWS.push(day + m * MIN);
}

/** The offsets (minutes from now) the spec seeds, read from its source: `within(-20)` and `withinToday(now, zone)(-10)`. */
function specOffsets(): number[] {
  const found = [...SPEC.matchAll(/\bwithin\((-?\d+)\)/g), ...SPEC.matchAll(/withinToday\([^)]*\)\((-?\d+)\)/g)].map((m) => Number(m[1]));
  return [...new Set(found)].sort((a, b) => a - b);
}

/** The clamp the spec used to carry, verbatim in arithmetic. */
const oldClamp = (now: number, offsetMin: number): number => {
  const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  return Math.min(dayStart + DAY_MS - 60_000, Math.max(dayStart + 60_000, now + offsetMin * MIN));
};

describe("the offsets the spec seeds", () => {
  it("are read from the spec source, and are enough to mean something (anti-vacuity)", () => {
    const offsets = specOffsets();
    expect(offsets.length, `read ${JSON.stringify(offsets)}`).toBeGreaterThanOrEqual(8);
    // The largest future offset is the one that overran the day first; the earliest past one is the other end.
    expect(Math.max(...offsets)).toBeGreaterThanOrEqual(120);
    expect(Math.min(...offsets)).toBeLessThanOrEqual(-40);
  });
});

describe("the old UTC-day clamp, replayed: the bug is real", () => {
  it("at 23:55Z the future offsets collapse onto one instant (the CI failure), and they do not at midday", () => {
    const future = specOffsets().filter((o) => o >= 45);
    expect(future.length, "the spec seeds several distinct future offsets").toBeGreaterThanOrEqual(4);
    const at2355 = Date.UTC(2026, 10, 3, 23, 55);
    expect(new Set(future.map((o) => oldClamp(at2355, o))).size, "tied at 23:55Z").toBe(1);
    const noon = Date.UTC(2026, 10, 3, 12, 0);
    expect(new Set(future.map((o) => oldClamp(noon, o))).size, "distinct at noon").toBe(future.length);
  });
});

describe("middayZoneFor + withinToday - the same offsets keep their order and their day at every five minutes of the day", () => {
  it("the zone puts the clock at local midday (read from Intl, not from the helper), at every reading", () => {
    let checked = 0;
    for (const now of NOWS) {
      const zone = middayZoneFor(now);
      const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }).format(new Date(now)));
      expect(hour, `${new Date(now).toISOString()} in ${zone}`).toBe(12);
      checked++;
    }
    expect(checked).toBe(NOWS.length);
    expect(NOWS.length).toBe(3 * 288);
  });

  it("every offset the spec uses stays on the planning day of `now` (the engine's own day key) and keeps its order, at every reading", () => {
    const offsets = specOffsets();
    let checked = 0;
    for (const now of NOWS) {
      const zone = middayZoneFor(now);
      const within = withinToday(now, zone);
      const today = dayKeyInTz(now, zone);
      const instants = offsets.map((o) => Date.parse(within(o)));
      for (const [i, at] of instants.entries()) {
        expect(dayKeyInTz(at, zone), `${new Date(now).toISOString()} ${offsets[i]} min in ${zone}`).toBe(today);
        checked++;
      }
      expect(new Set(instants).size, `${new Date(now).toISOString()}: no two offsets tie`).toBe(offsets.length);
    }
    expect(checked).toBe(NOWS.length * offsets.length);
  });

  it("the old clamp ties offsets at some reading in the same sweep (so the property above can fail)", () => {
    const offsets = specOffsets().filter((o) => o >= 45);
    const tied = NOWS.filter((now) => new Set(offsets.map((o) => oldClamp(now, o))).size < offsets.length);
    expect(tied.length, "readings where the old clamp tied").toBeGreaterThan(0);
    expect(tied.map((n) => new Date(n).toISOString().slice(11, 16))).toContain("23:55");
  });
});

describe("withinToday refuses an offset that leaves the day - the guard is reachable", () => {
  it("a day-leaving offset throws, naming the offset; an in-day one returns an ISO instant", () => {
    const now = Date.UTC(2026, 10, 3, 23, 55);
    const zone = middayZoneFor(now);
    expect(() => withinToday(now, zone)(12 * 60 + 5)).toThrow(/not on/);
    expect(() => withinToday(now, "UTC")(30)).toThrow(/30 min/);
    expect(withinToday(now, "UTC")(-30)).toBe(new Date(now - 30 * MIN).toISOString());
    expect(localDay(now, "UTC")).toBe("2026-11-03");
  });

  it("rejects a non-finite clock reading", () => {
    expect(() => middayZoneFor(Number.NaN)).toThrow(RangeError);
  });
});

describe("match-day.spec.ts is wired to it", () => {
  it("no UTC-day clamp is left in the spec", () => {
    expect(SPEC).not.toMatch(/Math\.min\(\s*dayStart/);
    expect(SPEC).not.toMatch(/\bdayStart\b/);
    expect(SPEC).not.toContain("86_400_000");
  });

  it("every seed that plans times schedules its division in the midday zone, not UTC (four seeds)", () => {
    // `tz: zone` PUTs: the board seed, the sport seed, E2's divisions and the tiny seed.
    const zoned = SPEC.match(/schedule-settings`, "PUT", \{\s*tz: zone/g) ?? [];
    expect(zoned.length, "schedule-settings PUTs that plan in the midday zone").toBe(4);
    // The one remaining UTC PUT seeds a match with NO planned time at all (the no-court seed), so there is no day to straddle.
    const utc = SPEC.match(/schedule-settings`, "PUT", \{\s*tz: "UTC"/g) ?? [];
    expect(utc.length).toBe(1);
    expect(SPEC.match(/middayZoneFor\(now\)/g)?.length, "one zone per seed").toBe(4);
  });
});

// PB3 review m2: the clamp was not only in match-day.spec.ts. Two walkthroughs carried it (competitions-home, frozen-competition) and
// run-sheet.spec.ts carried a COPY of `middayZoneFor`. One source scan over EVERY e2e file, so the next spec that pastes it reds here.
describe("no e2e file carries the UTC-day clamp or its own copy of the midday zone", () => {
  function e2eFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "node_modules") e2eFiles(full, out);
      } else if (name.endsWith(".ts")) out.push(full);
    }
    return out;
  }
  const FILES = e2eFiles(resolve(WEB, "e2e"));
  const rel = (f: string) => f.slice(WEB.length + 1);
  /** The helper's own file explains the clamp in a comment; everything else is a spec or a kit. */
  const others = FILES.filter((f) => rel(f) !== "e2e/midday-zone.ts");

  it("scanned every e2e file (anti-vacuity: zero or a handful is a failure), including the specs that carried it", () => {
    expect(FILES.length, "e2e .ts files scanned").toBeGreaterThan(100);
    for (const must of [
      "e2e/match-day.spec.ts",
      "e2e/run-sheet.spec.ts",
      "e2e/walkthrough/competitions-home.spec.ts",
      "e2e/walkthrough/frozen-competition.spec.ts",
      "e2e/midday-zone.ts",
    ]) {
      expect(FILES.map(rel), `${must} was scanned`).toContain(must);
    }
  });

  it("none clamps a seeded instant into today's UTC day", () => {
    const offenders = others
      .filter((f) => /Math\.min\(\s*dayStart/.test(readFileSync(f, "utf8")) || /dayStart\s*\+\s*86_400_000\s*-/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(offenders, "these files still clamp to the UTC day - plan in middayZoneFor(now) and use withinToday").toEqual([]);
  });

  it("none defines its own middayZoneFor: the helper is the one copy", () => {
    const offenders = others.filter((f) => /function\s+middayZoneFor\b/.test(readFileSync(f, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("the specs that plan 'today' use the shared helper (read from their imports)", () => {
    for (const [file, from] of [
      ["e2e/match-day.spec.ts", "./midday-zone"],
      ["e2e/run-sheet.spec.ts", "./midday-zone"],
      ["e2e/walkthrough/competitions-home.spec.ts", "../midday-zone"],
      ["e2e/walkthrough/frozen-competition.spec.ts", "../midday-zone"],
    ] as const) {
      expect(readFileSync(resolve(WEB, file), "utf8"), file).toContain(`from "${from}"`);
    }
  });
});
