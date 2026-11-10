// Owner ruling (1), 2026-10-19: gallery check 4c drives every Result card through the REAL result producer and the
// REAL headline ladder — so the staff gallery takes a stress mode: `?decided=<fixture.decidedBy key>` makes every
// winner-bearing decided template that key's sentence, `?name=` / `?away=` give the home / away side a display name
// (each side its OWN, never one name on both), and `?code=` an explicit short name (the model's `short`).
//
// Everything here is checked against the real dictionaries and the real renderer (`renderDecidedOutcome`), never a
// sentence typed into the test.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { interpolate } from "@/lib/i18n-runtime";
import { decidedOutcomeTemplates, renderDecidedOutcome } from "@/lib/scoring-vocab";
import {
  parseGalleryStress,
  parseStressClock,
  STRESS_SCORE,
  stressFootballClock,
  stressSides,
  stressTemplates,
} from "../gallery-stress";
import { clockLabelAt } from "@/components/overlay/use-overlay-clock";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";

const DICT = join(dirname(fileURLToPath(import.meta.url)), "../../../../dictionaries");
const en = JSON.parse(readFileSync(join(DICT, "en", "ui.json"), "utf8")) as Record<string, string>;
const m = (key: string) => en[key] ?? key;
const DECIDED_KEYS = Object.keys(en).filter((k) => k.startsWith("fixture.decidedBy."));
const SIDES = [
  { id: "home", name: "Ashgrove Rovers" },
  { id: "away", name: "Northbridge Athletic Football & Social Club" },
] as const;

describe("parseGalleryStress — only a real decided key, a bounded name and code; anything else is no stress", () => {
  it("anti-vacuity: the dictionary has the decided sentences the sweep walks", () => {
    expect(DECIDED_KEYS.length).toBeGreaterThanOrEqual(10);
  });

  it("accepts every fixture.decidedBy key the locale's dictionary declares", () => {
    let checked = 0;
    for (const key of DECIDED_KEYS) {
      expect(parseGalleryStress({ decided: key }, en).decided).toBe(key);
      checked++;
    }
    expect(checked).toBe(DECIDED_KEYS.length);
  });

  it("refuses a key outside fixture.decidedBy, one the dictionary lacks, and an empty or over-long name or code", () => {
    expect(parseGalleryStress({ decided: "overlay.brand" }, { ...en, "overlay.brand": "seazn" }).decided).toBeNull();
    expect(parseGalleryStress({ decided: "fixture.decidedBy.notAKey" }, en).decided).toBeNull();
    expect(parseGalleryStress({ name: "   " }, en).name).toBeNull();
    expect(parseGalleryStress({ name: "x".repeat(121) }, en).name).toBeNull();
    expect(parseGalleryStress({ name: "x".repeat(120) }, en).name).toBe("x".repeat(120));
    expect(parseGalleryStress({ away: "   " }, en).away).toBeNull();
    expect(parseGalleryStress({ away: "x".repeat(121) }, en).away).toBeNull();
    expect(parseGalleryStress({ away: " Harrow " }, en).away).toBe("Harrow");
    expect(parseGalleryStress({ code: "y".repeat(41) }, en).code).toBeNull();
    expect(parseGalleryStress({ code: " HARUTO-KENJI " }, en).code).toBe("HARUTO-KENJI");
    expect(parseGalleryStress({}, en)).toEqual({ decided: null, name: null, away: null, code: null });
  });
});

describe("stressSides — each side its OWN long name, so the capture is a real fixture and the winner is long whoever wins", () => {
  it("?name= alone names the HOME side; the away side keeps the gallery's own long club name — two distinct long names, different first letters", () => {
    const long = "Haruto Fujimoto and Kenji Watanabe-Yamamoto";
    const out = stressSides(SIDES, { decided: null, name: long, away: null, code: "HARUTO" });
    expect(out.map((s) => [s.id, s.name, s.short])).toEqual([
      ["home", long, "HARUTO"],
      ["away", SIDES[1].name, "HARUTO"],
    ]);
    expect(out[0].name).not.toBe(out[1].name);
    expect(out[0].name[0]).not.toBe(out[1].name[0]);
    // Long whoever wins: the away side's own name is as long as the stress name the e2e uses.
    expect(out[1].name.length).toBe(long.length);
  });

  it("?name= and ?away= name each side — the shared-prefix pair the code collision check drives (Harlow v Harrow)", () => {
    const out = stressSides(SIDES, { decided: null, name: "Harlow", away: "Harrow", code: null });
    expect(out.map((s) => [s.id, s.name, s.short])).toEqual([
      ["home", "Harlow", undefined],
      ["away", "Harrow", undefined],
    ]);
  });

  it("the empty case: nothing set leaves the gallery's own sides untouched", () => {
    expect(stressSides(SIDES, { decided: null, name: null, away: null, code: null })).toEqual([{ ...SIDES[0] }, { ...SIDES[1] }]);
  });
});

describe("stressTemplates — every winner-bearing template becomes the forced sentence, through the real renderer", () => {
  const base = decidedOutcomeTemplates(m);
  const names = { home: "Haruto Fujimoto and Kenji Watanabe-Yamamoto", away: "Royals" };

  it("every method, the plain and the shootout fallbacks, and every scored tie-break rung render the forced sentence", () => {
    const key = "fixture.decidedBy.settled.organiser";
    const forced = stressTemplates(base, en[key]!);
    const want = interpolate(en[key]!.replaceAll("{score}", STRESS_SCORE), { winner: names.home });
    let checked = 0;
    for (const method of Object.keys(base.byMethod)) {
      const got = renderDecidedOutcome({ kind: "win", winner: "home", method } as never, names, forced, { home: 4, away: 3 }, "4–3");
      expect(got, method).toBe(want);
      checked++;
    }
    expect(renderDecidedOutcome({ kind: "win", winner: "home" } as never, names, forced)).toBe(want);
    checked++;
    expect(checked).toBe(Object.keys(base.byMethod).length + 1);
    expect(checked).toBeGreaterThan(5);
    const rungs = Object.keys(base.tiebreakScored ?? {});
    expect(rungs.length, "premise: the scored tie-break rungs exist").toBeGreaterThan(0);
    for (const rung of rungs) expect(forced.tiebreakScored?.[rung], rung).toBe(forced.plain);
    expect(forced.shootoutPlain).toBe(forced.plain);
  });

  it("{score} is filled with the stress score, never left as a literal placeholder", () => {
    const key = "fixture.decidedBy.shootout";
    expect(en[key], "premise: the shootout sentence carries {score}").toContain("{score}");
    const forced = stressTemplates(base, en[key]!);
    const got = renderDecidedOutcome({ kind: "win", winner: "home", method: "regulation" } as never, names, forced);
    expect(got).toContain(STRESS_SCORE);
    expect(got).not.toMatch(/\{[a-z]+\}/i);
  });

  it("a tie is not a winner sentence and keeps its own template", () => {
    const forced = stressTemplates(base, en["fixture.decidedBy.settled.organiser"]!);
    expect(forced.tie).toBe(base.tie);
  });
});

// S2-5 ruling 110: the bug's clock cell must hold football's widest reading, `120+15:00` — 15 minutes into the second
// half of extra time's added time. `?clock=ET_H2.1800` puts that reading on football's live sample.
describe("?clock= — football's live sample at a stressed match-time reading (S2-5 ruling 110)", () => {
  it("parses a period the stress cfg reaches and bounded whole seconds; anything else is no stress", () => {
    expect(parseStressClock("ET_H2.1800")).toEqual({ period: "ET_H2", seconds: 1800 });
    expect(parseStressClock(" H1.0 ")).toEqual({ period: "H1", seconds: 0 });
    expect(parseStressClock("H2.3600")).toEqual({ period: "H2", seconds: 3600 });
    expect(parseStressClock("H2.3601"), "over an hour").toBeNull();
    expect(parseStressClock("Q3.60"), "no quarters under 2 × 45").toBeNull();
    expect(parseStressClock("PSO.60"), "the shootout has no clock").toBeNull();
    expect(parseStressClock("ET_H2.-1")).toBeNull();
    expect(parseStressClock("ET_H2.18.5")).toBeNull();
    expect(parseStressClock("ET_H2")).toBeNull();
    expect(parseStressClock(undefined)).toBeNull();
  });

  const snap = (status: string) => ({ status }) as unknown as OverlayLiveData;
  const SNAPSHOTS = {
    football: { warming: snap("scheduled"), live: snap("in_play"), ended: snap("decided") },
    hockey: { warming: snap("scheduled"), live: snap("in_play"), ended: snap("decided") },
  };

  it("ET_H2.1800 holds football's live sample at 120+15:00, paused; nothing else moves", () => {
    const out = stressFootballClock(SNAPSHOTS, parseStressClock("ET_H2.1800"), 5_000);
    const clock = out.football.live.clock!;
    expect(clock).toMatchObject({ phase: "ET_H2", anchorSeconds: 1800, running: false });
    expect(clockLabelAt(clock, 5_000 + 60_000, 0, null), "paused: the same a minute on").toBe("120+15:00");
    expect(out.football.warming).toBe(SNAPSHOTS.football.warming);
    expect(out.football.ended).toBe(SNAPSHOTS.football.ended);
    expect(out.hockey).toBe(SNAPSHOTS.hockey);
  });

  it("no ?clock= is the snapshots as they were", () => {
    expect(stressFootballClock(SNAPSHOTS, null, 5_000)).toBe(SNAPSHOTS);
  });
});

