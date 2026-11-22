// Spec 2026-10-09 §3.2.2 - the check-in extension's words exist in every locale. Swept from the vocabulary's own lists and from the
// source files that ask for them, so a reason or a key added with no copy (or with a typo) reds here, not in a browser.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { LOCALES } from "@/lib/i18n-constants";
import { EXTEND_REFUSALS, EXTEND_REFUSAL_KEYS, EXTEND_ROUND_SKIP_COPY } from "@/lib/checkin-extend";
import { RETIRED_EXTEND_WORDS } from "./_retired-extend-reasons";

const DICTS: Record<(typeof LOCALES)[number], Record<string, string>> = { en, es, fr, nl };
const PREFIX = "externalPlay.checkinExtend.";
const slots = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();
const SRC = join(__dirname, "..", "..");

describe("check-in extension copy", () => {
  const enKeys = Object.keys(en).filter((k) => k.startsWith(PREFIX));

  it("the vocabulary's own lists (every refusal, every skip line) have copy in every locale", () => {
    const keys = [
      ...EXTEND_REFUSALS.map((r) => EXTEND_REFUSAL_KEYS[r]),
      ...Object.values(EXTEND_ROUND_SKIP_COPY).flatMap((base) => [`${base}.one`, `${base}.other`]),
    ];
    let checked = 0;
    for (const loc of LOCALES) {
      for (const k of keys) {
        const v = DICTS[loc][k];
        expect(typeof v === "string" && v.trim().length > 0, `${loc} ${k}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: (5 refusals + 6 skip lines x 2) x 4 locales").toBe((EXTEND_REFUSALS.length + Object.keys(EXTEND_ROUND_SKIP_COPY).length * 2) * LOCALES.length);
    expect(EXTEND_REFUSALS.length).toBeGreaterThan(0);
  });

  it("every key the extension has in English is in all four locales, with the SAME slots, and none exists only elsewhere", () => {
    expect(enKeys.length, "anti-vacuity: the English keys").toBeGreaterThanOrEqual(30);
    let checked = 0;
    for (const loc of LOCALES) {
      const own = Object.keys(DICTS[loc]).filter((k) => k.startsWith(PREFIX));
      expect(own.sort(), `${loc}: the same key set as English`).toEqual([...enKeys].sort());
      for (const k of enKeys) {
        const v = DICTS[loc][k]!;
        expect(v.trim().length, `${loc} ${k}`).toBeGreaterThan(0);
        expect(slots(v), `${loc} ${k}: slots`).toEqual(slots(en[k as keyof typeof en] as string));
        checked += 1;
      }
    }
    expect(checked).toBe(enKeys.length * LOCALES.length);
  });

  it("each plural base has .one and .other, and the .other carries {count}", () => {
    const bases = [...new Set(enKeys.filter((k) => /\.(one|other)$/.test(k)).map((k) => k.replace(/\.(one|other)$/, "")))];
    expect(bases.length, "anti-vacuity: the round line, its hint and one per skip reason").toBe(2 + Object.keys(EXTEND_ROUND_SKIP_COPY).length);
    for (const loc of LOCALES) {
      for (const b of bases) {
        expect(DICTS[loc][`${b}.one`], `${loc} ${b}.one`).toBeTruthy();
        expect(DICTS[loc][`${b}.other`], `${loc} ${b}.other`).toContain("{count}");
      }
    }
  });

  it("no two refusals share a sentence (each reason is said in its own words)", () => {
    for (const loc of LOCALES) {
      const texts = EXTEND_REFUSALS.map((r) => DICTS[loc][EXTEND_REFUSAL_KEYS[r]]);
      expect(new Set(texts).size, loc).toBe(texts.length);
    }
  });

  it("the helper line has copy in every locale, with its slots", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      expect(slots(DICTS[loc]["externalPlay.checkinExtend.helper"]!), `${loc}: the helper line's slots`).toEqual(["max", "minutes"]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: one helper line a locale").toBe(LOCALES.length);
  });

  it("the retired 'why' family (the reasons a +5 is not offered) stays out of every dictionary: no screen draws one, so no locale carries one (B1)", () => {
    // Match Day prints no unprompted reason where a +5 is not offered (Task 7 M5, owner sign-off); the keys were declared, translated and
    // read by helpers nothing called. A key nothing draws is dead weight in four files, so a new one under this prefix must be drawn first.
    let checked = 0;
    for (const loc of LOCALES) {
      const keys = Object.keys(DICTS[loc]);
      expect(keys.filter((k) => k.startsWith(`${PREFIX}why.`)), `${loc}: no why key`).toEqual([]);
      expect(keys.filter((k) => k.startsWith(PREFIX)).length, `${loc}: premise - the family's other keys are there`).toBeGreaterThan(20);
      checked += 1;
    }
    // English only: the typed sentences are English, and a key moved elsewhere (under another prefix) would still carry them.
    expect(Object.values(DICTS.en).filter((v) => RETIRED_EXTEND_WORDS.some((w) => v.includes(w))), "no English entry says a retired reason or its lead-in").toEqual([]);
    expect(RETIRED_EXTEND_WORDS.length, "anti-vacuity: five sentences and two lead-ins").toBe(7);
    expect(checked, "anti-vacuity: four locales").toBe(LOCALES.length);
  });

  it("every key a source file asks for exists: an exact key, or a plural base with both forms", () => {
    // open-round-control.tsx left this list when the round's +5 moved into the round column (phase 2, Task 10): it no longer asks for any
    // extend key, and a file listed here must ask for at least one. board-decision.tsx (Match Day Task 8: the Decision the board panel
    // moved out of the Arbiter panel) is the one that STAYS; arbiter-panel.tsx left this list when Match Day's Task 10 deleted it.
    const files = ["components/v2/checkin-extend-ui.ts", "components/v2/match-day/board-decision.tsx", "components/v2/match-day/round-focus.tsx", "lib/checkin-extend.ts"];
    let asked = 0;
    for (const f of files) {
      const src = readFileSync(join(SRC, f), "utf8");
      const literals = [...new Set(src.match(/externalPlay\.checkinExtend\.[A-Za-z]+(?:\.[A-Za-z]+)*/g) ?? [])];
      expect(literals.length, `${f}: asks for at least one key`).toBeGreaterThan(0);
      for (const key of literals) {
        const exact = key in en;
        const plural = `${key}.one` in en && `${key}.other` in en;
        expect(exact || plural, `${f}: ${key}`).toBe(true);
        asked += 1;
      }
    }
    expect(asked, "anti-vacuity: keys asked for").toBeGreaterThanOrEqual(20);
  });
});
