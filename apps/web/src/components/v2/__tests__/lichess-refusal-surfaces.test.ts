// The Lichess seat-gate refusal now comes back from five more organiser routes than the roster add, so two more screens say
// it in the organiser's language through the SAME helper (entrants-lichess-refusal.ts): the registrant hub (approve, mark
// paid, promote - one registrant's own page, nobody named) and the CSV import (the whole commit refused, the FILE ROWS named).
// This is the mapping: every locale, both reasons, the singular/plural/nameless forms. The wiring (a screen that actually
// calls it) is components/__tests__/lichess-refusal-surfaces-wiring.test.tsx. The expected words come from the dictionaries
// through the runtime, never from a string typed here.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCALES } from "@/lib/i18n-constants";
import type { Dict } from "@/lib/i18n-constants";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import {
  IMPORT_LICHESS_FAMILY,
  LICHESS_REFUSAL_FAMILY,
  REGISTRANT_LICHESS_FAMILY,
  lichessImportRefusalText,
  lichessRefusalText,
  lichessRegistrantRefusalText,
  type LichessRefusalDeps,
} from "../entrants-lichess-refusal";

type Locale = (typeof LOCALES)[number];
const DICTS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Dict]),
) as Record<Locale, Dict>;

function depsFor(locale: Locale, known: Record<string, string> = {}): LichessRefusalDeps {
  const dict = DICTS[locale];
  return {
    nameOf: (id) => known[id],
    list: (names) => new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names),
    plural: (key, count, vars) => pluralRuntime(dict, key, count, locale, vars),
    text: (key) => tRuntime(dict, key),
  };
}

const CODES = ["LICHESS_LINK_REQUIRED", "LICHESS_RECONSENT_REQUIRED"] as const;

describe("the registrant hub's Lichess refusal (approve, mark paid, promote)", () => {
  it("says each reason in every locale's own words, names nobody, and never reads as the other reason", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const text = (key: string) => tRuntime(DICTS[locale], key);
      const texts = CODES.map((code) => {
        // The payload names a person; this page does not (it is the registrant's own page and the person may not exist yet).
        const shown = lichessRegistrantRefusalText({ code, extra: { person_ids: ["p-ada"] } } as { code: string }, text);
        expect(shown, `${locale} ${code}`).toBe(tRuntime(DICTS[locale], `${REGISTRANT_LICHESS_FAMILY[code]}.unnamed`));
        expect(shown, `${locale} ${code}: said, not the key`).not.toBe(`${REGISTRANT_LICHESS_FAMILY[code]}.unnamed`);
        expect(shown, `${locale} ${code}: no placeholder left`).not.toMatch(/[{}]/);
        expect(shown, `${locale} ${code}: no em dash in the copy`).not.toContain("\u2014");
        checked++;
        return shown!;
      });
      expect(texts[0], `${locale}: the two reasons read differently`).not.toBe(texts[1]);
      if (locale === "en") {
        expect(texts[0], "en: link says link, not reconnect").toMatch(/\blink/i);
        expect(texts[0]).not.toMatch(/reconnect/i);
        expect(texts[1], "en: reconnect says reconnect").toMatch(/reconnect/i);
      } else {
        const en = CODES.map((code) => lichessRegistrantRefusalText({ code }, (key) => tRuntime(DICTS.en, key)));
        expect(texts, `${locale}: translated, not the English`).not.toContain(en[0]);
        expect(texts, `${locale}: translated, not the English`).not.toContain(en[1]);
      }
    }
    expect(checked, "anti-vacuity: 2 reasons x every locale").toBe(2 * LOCALES.length);
  });

  it("is its own wording, not the entrants panel's, and null for a code it does not know", () => {
    const entrants = lichessRefusalText({ code: CODES[0] }, depsFor("en"));
    const registrant = lichessRegistrantRefusalText({ code: CODES[0] }, (key) => tRuntime(DICTS.en, key));
    expect(registrant).not.toBe(entrants);
    expect(lichessRegistrantRefusalText({ code: "ELIGIBILITY_VIOLATION" }, (key) => key)).toBeNull();
    expect(lichessRegistrantRefusalText({ code: undefined }, (key) => key)).toBeNull();
    expect(lichessRegistrantRefusalText({ code: "lichess_link_required" }, (key) => key)).toBeNull();
  });
});

describe("the CSV import's Lichess refusal (the whole commit refused, the file rows named)", () => {
  it("names the rows in every locale, in that locale's list form, for both reasons", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const list = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(["3", "7", "12"]);
      const texts = CODES.map((code) => {
        const text = lichessImportRefusalText({ code, extra: { rows: [3, 7, 12] } }, depsFor(locale));
        expect(text, `${locale} ${code}`).toBe(pluralRuntime(DICTS[locale], IMPORT_LICHESS_FAMILY[code], 3, locale, { players: list }));
        for (const row of ["3", "7", "12"]) expect(text, `${locale} ${code}: names row ${row}`).toContain(row);
        expect(text, `${locale} ${code}: no placeholder left`).not.toMatch(/[{}]/);
        expect(text, `${locale} ${code}: no em dash in the copy`).not.toContain("—");
        checked++;
        return text!;
      });
      expect(texts[0], `${locale}: the two reasons read differently`).not.toBe(texts[1]);
    }
    expect(checked, "anti-vacuity: 2 reasons x every locale").toBe(2 * LOCALES.length);
  });

  it("one row is the singular form, several the plural (the plural machinery is reached), and nothing named is the file's own", () => {
    const keys: string[] = [];
    const record: Pick<LichessRefusalDeps, "list" | "plural" | "text"> = {
      ...depsFor("en"),
      plural: (key, count) => (keys.push(`${key}#${count}`), key),
    };
    lichessImportRefusalText({ code: CODES[0], extra: { rows: [4] } }, record);
    lichessImportRefusalText({ code: CODES[0], extra: { rows: [4, 9] } }, record);
    expect(keys).toEqual([`${IMPORT_LICHESS_FAMILY.LICHESS_LINK_REQUIRED}#1`, `${IMPORT_LICHESS_FAMILY.LICHESS_LINK_REQUIRED}#2`]);

    for (const locale of LOCALES) {
      const none = lichessImportRefusalText({ code: CODES[1], extra: {} }, depsFor(locale));
      expect(none, `${locale}: no rows`).toBe(tRuntime(DICTS[locale], `${IMPORT_LICHESS_FAMILY.LICHESS_RECONSENT_REQUIRED}.unnamed`));
      const junk = lichessImportRefusalText({ code: CODES[1], extra: { rows: ["3", 2.5, null] } }, depsFor(locale));
      expect(junk, `${locale}: rows that are not integers name nothing`).toBe(none);
      const one = lichessImportRefusalText({ code: CODES[1], extra: { rows: [4] } }, depsFor(locale));
      expect(one, `${locale}: one row is not the nameless copy`).not.toBe(none);
    }
  });

  it("anything else is not its business: other codes, and no code, return null so the caller keeps its own handling", () => {
    for (const err of [{ code: "ELIGIBILITY_VIOLATION", extra: { rows: [1] } }, { code: undefined, extra: {} }, { code: "lichess_link_required" }]) {
      expect(lichessImportRefusalText(err, depsFor("en"))).toBeNull();
    }
  });
});

describe("every copy key the new screens can reach exists in every locale (counted)", () => {
  it("registrant hub: 2 reasons x the nameless form; import: 2 reasons x one/other/unnamed", () => {
    let checked = 0;
    const need: [string, boolean][] = [
      ...Object.values(REGISTRANT_LICHESS_FAMILY).map((f): [string, boolean] => [`${f}.unnamed`, false]),
      ...Object.values(IMPORT_LICHESS_FAMILY).flatMap((f): [string, boolean][] => [
        [`${f}.one`, true],
        [`${f}.other`, true],
        [`${f}.unnamed`, false],
      ]),
    ];
    for (const [key, takesRows] of need) {
      for (const locale of LOCALES) {
        const value = DICTS[locale][key];
        expect(typeof value, `${locale} ${key}`).toBe("string");
        expect((value as string).length, `${locale} ${key}`).toBeGreaterThan(20);
        if (takesRows) expect(value, `${locale} ${key} takes the rows`).toContain("{players}");
        checked++;
      }
    }
    expect(checked, "(2 + 6) keys x every locale").toBe((2 + 6) * LOCALES.length);
  });

  it("the three screens use three different families, with the same two codes", () => {
    const families = [LICHESS_REFUSAL_FAMILY, REGISTRANT_LICHESS_FAMILY, IMPORT_LICHESS_FAMILY];
    for (const f of families) expect(Object.keys(f).sort()).toEqual([...CODES].sort());
    const all = families.flatMap((f) => Object.values(f));
    expect(new Set(all).size, "no two screens share a key family").toBe(all.length);
  });
});
