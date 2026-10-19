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
import { parseGalleryStress, STRESS_SCORE, stressSides, stressTemplates } from "../gallery-stress";

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
