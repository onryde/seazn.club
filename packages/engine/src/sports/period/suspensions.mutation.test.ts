// Engine mutation debt (sport-free lane) — period/suspensions.ts: the suspension class ladders the two hockey codes resolve,
// the overtime strength rule and the FIH escalation hint. Expected values come from the rulebooks the file cites and from the
// modules' own declarations:
//   * FIH Rule 14 — the team plays short on EVERY card; red is permanent. The youth ladder keeps the adult grades and scales
//     each duration by the youth preset's own period ratio, rounded down (the file's W5 note).
//   * IIHF Rules 16 and 20.4 — a minor is 2 minutes, the team plays short, and a power-play goal ends it. The recreational
//     ladder is the IIHF ladder's 2-minute classes, unchanged (icehockey/DOMAIN.md: "2 minutes, that's it").
//   * NHL Rule 84.4 / IIHF Rule 84 — in 3-on-3 overtime the non-offending side GAINS a skater per net penalty, capped at full
//     strength: strength(X) = min(base, skaters + max(0, short(opponent) − short(X))).
//
// Hockey codes only, on purpose: suspension classes are declared by the period kernel's two hockey modules and by no other
// sport.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { hockey } from "../hockey/hockey.ts";
import { icehockey } from "../icehockey/icehockey.ts";
import type { PeriodCfg, PeriodState } from "./kernel.ts";
import {
  escalationHints,
  overtimeStrengthChip,
  overtimeStrengthOf,
  type ActiveSuspension,
  type CardRecordEntry,
  type SuspensionClasses,
} from "./suspensions.ts";

const start: ModuleEvent = { type: "core.start", payload: {} };
const envelopes = (events: ModuleEvent[]): EventEnvelope[] => events.map((event, i) => makeEnvelope(i, event));
const at = (period: string, elapsed: number) => ({ period, elapsed });
const strengthChipOf = (summary: { detail?: unknown }): string | null =>
  (summary.detail as { strength?: string | null }).strength ?? null;
const classesOf = (cfg: PeriodCfg): SuspensionClasses => {
  const classes = cfg.suspensions?.classes;
  if (classes === undefined) throw new Error("premise: this variant declares suspension classes");
  return classes;
};

const fihLineups = defaultLineupPair(hockey.positions);
const FA = fihLineups.away.entrantId;
const iceLineups = defaultLineupPair(icehockey.positions);
const IH = iceLineups.home.entrantId;
const IA = iceLineups.away.entrantId;

describe("FIH ladders (hockey) — Rule 14: every card plays the team short", () => {
  const adult = hockey.configSchema.parse({});
  const youth = hockey.configSchema.parse(hockey.variants.youth);

  it("every class of every hockey variant is team-short; red is permanent and open-ended", () => {
    let classes = 0;
    for (const [variant, raw] of Object.entries(hockey.variants)) {
      for (const [key, cls] of Object.entries(classesOf(hockey.configSchema.parse(raw)))) {
        expect(cls.teamShort, `${variant} ${key}`).toBe(true);
        if (key === "red") {
          expect(cls.permanent, `${variant} red`).toBe(true);
          expect(cls.minutes, `${variant} red`).toBeNull();
        }
        classes++;
      }
    }
    expect(classes).toBeGreaterThan(0);
  });

  it("youth keeps the adult grades and scales each duration by the youth period ratio, rounded down", () => {
    const ratio = youth.periods.minutes / adult.periods.minutes;
    expect(ratio).toBeLessThan(1); // premise: youth periods are the shorter ones
    const adultClasses = classesOf(adult);
    const youthClasses = classesOf(youth);
    expect(Object.keys(youthClasses).sort()).toEqual(Object.keys(adultClasses).sort());
    let checked = 0;
    for (const [key, a] of Object.entries(adultClasses)) {
      const y = youthClasses[key];
      expect(y?.teamShort, key).toBe(a.teamShort);
      expect(Boolean(y?.permanent), key).toBe(Boolean(a.permanent));
      expect(y?.minutes, key).toBe(a.minutes === null ? null : Math.floor(a.minutes * ratio));
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("through the fold: each youth card leaves the carded side one short of the youth roster", () => {
    const base = youth.strength.base;
    let checked = 0;
    for (const key of Object.keys(classesOf(youth))) {
      const events: ModuleEvent[] = [start, { type: "hockey.suspension.start", payload: { by: FA, class: key } }];
      const state = foldMatch(hockey, youth, fihLineups, envelopes(events));
      expect(strengthChipOf(hockey.summary(state)), `youth ${key}`).toBe(`${base}v${base - 1}`);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("IIHF ladders (icehockey) — the recreational ladder is the IIHF minors, unchanged", () => {
  const iihf = icehockey.configSchema.parse({});
  const rec = icehockey.configSchema.parse(icehockey.variants.recreational);

  it("the IIHF minors are 2 minutes, team-short and released by a power-play goal (Rules 16, 20.4)", () => {
    for (const key of ["minor", "bench_minor"]) {
      const cls = classesOf(iihf)[key];
      expect(cls?.minutes, key).toBe(2);
      expect(cls?.teamShort, key).toBe(true);
      expect(cls?.releaseOnGoal, key).toBe(true);
    }
  });

  it("every recreational class is the IIHF class of the same name, field for field, and every 2-minute IIHF class is kept", () => {
    const recClasses = classesOf(rec);
    const iihfClasses = classesOf(iihf);
    let checked = 0;
    for (const [key, cls] of Object.entries(recClasses)) {
      expect(cls, key).toStrictEqual(iihfClasses[key]);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    const twoMinute = Object.entries(iihfClasses).filter(([, c]) => c.minutes === 2).map(([k]) => k).sort();
    expect(Object.keys(recClasses).sort()).toEqual(twoMinute);
  });

  it("through the fold: each recreational penalty plays the side short, and a stamped power-play goal ends it", () => {
    const base = rec.strength.base;
    const fold = (events: ModuleEvent[]): PeriodState => foldMatch(icehockey, rec, iceLineups, envelopes(events));
    let checked = 0;
    for (const key of Object.keys(classesOf(rec))) {
      const card: ModuleEvent = { type: "icehockey.suspension.start", payload: { by: IA, class: key, at: at("P1", 100) } };
      const carded = fold([start, card]);
      expect(carded.suspensions, key).toHaveLength(1);
      expect(strengthChipOf(icehockey.summary(carded)), key).toBe(`${base}v${base - 1}`);
      // 2:00 from 100 runs to 220; the home goal at 200 comes before that, so only the power-play rule can end it.
      const scored = fold([start, card, { type: "icehockey.goal", payload: { by: IH, at: at("P1", 200) } }]);
      expect(scored.suspensions, `${key} after a power-play goal`).toEqual([]);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    // Positive pair: the same goal leaves an IIHF major running — the release is the class's, not every penalty's.
    const major = foldMatch(icehockey, iihf, iceLineups, envelopes([
      start,
      { type: "icehockey.suspension.start", payload: { by: IA, class: "major", at: at("P1", 100) } },
      { type: "icehockey.goal", payload: { by: IH, at: at("P1", 200) } },
    ]));
    expect(major.suspensions).toHaveLength(1);
  });
});

describe("overtime strength — NHL 84.4 / IIHF 84 (3-on-3, full strength 5)", () => {
  const minor = (side: "home" | "away"): ActiveSuspension => ({ side, classKey: "minor", teamShort: true, permanent: false });
  const misconduct = (side: "home" | "away"): ActiveSuspension => ({ side, classKey: "misconduct", teamShort: false, permanent: false });
  const SKATERS = 3;
  const BASE = 5;

  // [running suspensions, home strength, away strength] — hand arithmetic on the rule in the header.
  const table: [string, ActiveSuspension[], number, number][] = [
    ["one home minor: away gains one", [minor("home")], 3, 4],
    ["one away minor: home gains one", [minor("away")], 4, 3],
    ["two home minors: away gains two", [minor("home"), minor("home")], 3, 5],
    ["three home minors: capped at full strength", [minor("home"), minor("home"), minor("home")], 3, 5],
    ["one each: coincidental, nobody gains", [minor("home"), minor("away")], 3, 3],
    ["two home, one away: away gains one", [minor("home"), minor("away"), minor("home")], 3, 4],
    ["a misconduct is not team-short", [misconduct("home")], 3, 3],
  ];

  it("each side's strength, both sides, for every row", () => {
    let checked = 0;
    for (const [name, active, home, away] of table) {
      expect(overtimeStrengthOf(active, "home", SKATERS, BASE), `${name} — home`).toBe(home);
      expect(overtimeStrengthOf(active, "away", SKATERS, BASE), `${name} — away`).toBe(away);
      checked++;
    }
    expect(checked).toBe(table.length);
  });

  it("the chip prints both sides while any team-short penalty runs, and nothing at even strength with none", () => {
    expect(overtimeStrengthChip([], SKATERS, BASE)).toBeNull();
    expect(overtimeStrengthChip([misconduct("away")], SKATERS, BASE)).toBeNull();
    let checked = 0;
    for (const [name, active, home, away] of table) {
      if (!active.some((s) => s.teamShort)) continue;
      expect(overtimeStrengthChip(active, SKATERS, BASE), name).toBe(`${home}v${away}`);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("escalationHints — FIH progressive escalation (v6/01 §3)", () => {
  const card = (classKey: string, person?: string): CardRecordEntry => ({
    side: "home",
    classKey,
    ...(person === undefined ? {} : { person }),
  });

  it("the empty case: no cards, or no green card with a named person, hints nobody", () => {
    expect(escalationHints([])).toEqual([]);
    expect(escalationHints([card("yellow", "amy"), card("red", "bo"), card("green")])).toEqual([]);
  });

  it("names each green-carded person once, in the same order whichever order the cards were shown", () => {
    const log = [card("green", "zed"), card("yellow", "amy"), card("green", "amy"), card("green", "mo"), card("green", "zed")];
    expect(escalationHints(log)).toEqual(["amy", "mo", "zed"]);
    expect(escalationHints([...log].reverse())).toEqual(["amy", "mo", "zed"]);
  });
});
