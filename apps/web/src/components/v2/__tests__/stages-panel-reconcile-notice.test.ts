// W4 app-A Task 8 (FX-G2): the desk's green line after a knockout Generate over existing lines. Main said "Nothing new to
// generate — fixtures are up to date." when a seventh entrant had in fact been placed (it inserted nothing, so it counted
// nothing). Now "up to date" is said ONLY for the named no-op; a change in place counts who was placed and who was taken
// out, and a redraw says so. Driven through the REAL dictionaries and the REAL plural runtime (no stubbed translator), as
// stages-panel-reshape-notice.test.ts does; the English expected strings are typed here from the copy decision, never read
// from the dictionary under test.
import { describe, expect, it } from "vitest";
import { generateNoticeText, reconcileNotice, type GenerateNoticeWire } from "../stages-panel";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict, Locale } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

const DICTS: Record<Locale, Dict> = { en: en as Dict, es: es as Dict, fr: fr as Dict, nl: nl as Dict };
const LOCALES = Object.keys(DICTS) as Locale[];

function bind(locale: Locale) {
  const dict = DICTS[locale];
  return {
    msg: (key: string, vars?: Record<string, string | number>) => tRuntime(dict, key, vars),
    msgPlural: (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(dict, key, count, locale, vars),
  };
}
const text = (locale: Locale, out: GenerateNoticeWire) => {
  const { msg, msgPlural } = bind(locale);
  return generateNoticeText(out, msg as never, msgPlural, locale);
};

const UP_TO_DATE = "Nothing new to generate — fixtures are up to date.";

describe("the Generate notice after a knockout reconcile (FX-G2)", () => {
  it("says 'up to date' only for the named no-op (and a plain Generate that created nothing)", () => {
    expect(text("en", { created: 0, existing: 7, reconcile: { kind: "noop", placed: [], vacated: [], vacated_seats: 0 } })).toBe(UP_TO_DATE);
    expect(text("en", { created: 0, existing: 7 })).toBe(UP_TO_DATE);
  });

  it("a placement in place is counted, never 'up to date'", () => {
    expect(text("en", { created: 0, existing: 7, reconcile: { kind: "in_place", placed: ["p7"], vacated: [], vacated_seats: 0 } })).toBe(
      "1 new entrant placed in a bye.",
    );
    expect(text("en", { created: 0, existing: 7, reconcile: { kind: "in_place", placed: ["p7", "p8"], vacated: [], vacated_seats: 0 } })).toBe(
      "2 new entrants placed in byes.",
    );
  });

  it("a departure in place is counted with the bye it leaves; both clauses together", () => {
    expect(text("en", { created: 0, existing: 7, reconcile: { kind: "in_place", placed: [], vacated: ["x"], vacated_seats: 1 } })).toBe(
      "1 entrant who left was taken out; their opponent now has a bye.",
    );
    expect(text("en", { created: 0, existing: 7, reconcile: { kind: "in_place", placed: ["a"], vacated: ["x", "y"], vacated_seats: 2 } })).toBe(
      "1 new entrant placed in a bye. 2 entrants who left were taken out; their opponents now have byes.",
    );
  });

  it("a seat whose entrant was DELETED counts, though no id is listed — never 'up to date' after a write (fix round 1, I2)", () => {
    expect(text("en", { created: 0, existing: 7, reconcile: { kind: "in_place", placed: [], vacated: [], vacated_seats: 1 } })).toBe(
      "1 entrant who left was taken out; their opponent now has a bye.",
    );
  });

  it("a redraw says the bracket was drawn again, what became of its slots, and that printed sheets stop — never that every match kept its time (fix round 1, I1)", () => {
    const redraw = (slots: { kept: number; freed: number; unscheduled: number }) =>
      text("en", { created: 15, existing: 0, reconcile: { kind: "regenerated", placed: ["p9"], vacated: [], vacated_seats: 0, slots } });
    expect(redraw({ kept: 7, freed: 0, unscheduled: 1 })).toBe(
      "The bracket was drawn again to match the current entrants. 7 slot(s) kept, 0 freed, 1 unscheduled. Printed scorer sheets for this stage will stop working.",
    );
    // A bracket nobody laid out has no slot to report (Rebuild's own rule): the slot clause is dropped, the sheets one is not.
    expect(redraw({ kept: 0, freed: 0, unscheduled: 0 })).toBe(
      "The bracket was drawn again to match the current entrants. Printed scorer sheets for this stage will stop working.",
    );
    expect(redraw({ kept: 7, freed: 0, unscheduled: 1 })).not.toMatch(/keeps the time and court/);
  });

  // Fix round 2 (item 3): a redraw has four causes — the field crossed a power of two, a bye holder left, both players of
  // one match left, a bye nobody holds — and three of them change no size. The sentence names none of them, in any locale.
  it("a redraw's sentence claims no cause: the same words whatever moved, and no locale says the bracket changed size", () => {
    const SIZE_WORDS: Record<Locale, RegExp> = { en: /\bsize\b/i, es: /tamaño/i, fr: /taille/i, nl: /grootte/i };
    const causes: GenerateNoticeWire["reconcile"][] = [
      { kind: "regenerated", placed: ["p9"], vacated: [], vacated_seats: 0 },
      { kind: "regenerated", placed: [], vacated: ["a", "b"], vacated_seats: 2 },
      { kind: "regenerated", placed: [], vacated: [], vacated_seats: 0 },
    ];
    let checked = 0;
    for (const locale of LOCALES) {
      const said = causes.map((reconcile) => text(locale, { created: 15, existing: 0, reconcile }));
      expect(new Set(said).size, `${locale}: one sentence for every cause`).toBe(1);
      expect(said[0], locale).not.toMatch(SIZE_WORDS[locale]);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("every locale renders every reconcile line, translated, with no raw key and no unfilled placeholder", () => {
    let checked = 0;
    const cases: GenerateNoticeWire["reconcile"][] = [
      { kind: "in_place", placed: ["a"], vacated: [], vacated_seats: 0 },
      { kind: "in_place", placed: ["a", "b", "c"], vacated: [], vacated_seats: 0 },
      { kind: "in_place", placed: [], vacated: ["x"], vacated_seats: 1 },
      { kind: "in_place", placed: [], vacated: ["x", "y"], vacated_seats: 2 },
      { kind: "regenerated", placed: [], vacated: [], vacated_seats: 0, slots: { kept: 3, freed: 1, unscheduled: 0 } },
    ];
    for (const r of cases) {
      const english = (() => {
        const { msg, msgPlural } = bind("en");
        return reconcileNotice(r, msg as never, msgPlural);
      })();
      for (const locale of LOCALES) {
        const { msg, msgPlural } = bind(locale);
        const line = reconcileNotice(r, msg as never, msgPlural);
        expect(line, `${locale} ${JSON.stringify(r)}`).not.toBeNull();
        expect(line!, `${locale}: no raw key`).not.toMatch(/schedule\.notice/);
        expect(line!, `${locale}: no unfilled placeholder`).not.toMatch(/\{\w+\}/);
        if (locale !== "en") expect(line, `${locale} is translated`).not.toBe(english);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: (case, locale) pairs").toBe(cases.length * LOCALES.length);
  });

  it("no reconcile line for a first Generate or the no-op (the ordinary line stands)", () => {
    const { msg, msgPlural } = bind("en");
    expect(reconcileNotice(undefined, msg as never, msgPlural)).toBeNull();
    expect(reconcileNotice({ kind: "noop", placed: [], vacated: [], vacated_seats: 0 }, msg as never, msgPlural)).toBeNull();
  });
});
