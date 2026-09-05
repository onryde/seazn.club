// The schedule-lock refusal, said in the READER's language.
//
// `@/lib/schedule-lock` exports the refusal ONCE, and every server path throws
// it with `SCHEDULE_LOCKED_CODE` at 422. That constant is English prose, and
// two client surfaces used to paint it straight onto the screen:
//
//   - `board/ai-competition-console.tsx` interpolated the server's `reason`
//     into `board.ai.joint.undoneReason`'s `{reason}` placeholder, so a raw
//     English clause sat mid-sentence inside a fully translated card;
//   - `history-panel.tsx`'s generic `catch` rendered `err.message`.
//
// The fix is a LOCAL dictionary string chosen off the CODE. This file guards
// the copy half of that: the three keys exist in all four locales, they are
// really translated rather than the English value copied across, they carry no
// placeholders to lose in translation, and neither component holds the English
// as a literal. Without the last guard the components would render correctly
// under `useMsg`'s English fallback whether the sentence came from the
// dictionary or from a hardcoded string.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

const DICTS: Record<string, Record<string, string>> = {
  en: enUi as unknown as Record<string, string>,
  es: esUi as unknown as Record<string, string>,
  fr: frUi as unknown as Record<string, string>,
  nl: nlUi as unknown as Record<string, string>,
};
const EN = DICTS.en!;

/** The three sentences this fix introduced, and the component each is spoken
 *  by — so "the English is not a literal" is checked against the file that
 *  would hold it, not against the tree at large. */
const KEYS: { key: string; source: string }[] = [
  { key: "board.ai.joint.reasonLocked", source: "src/components/v2/board/ai-competition-console.tsx" },
  { key: "history.error.frozen", source: "src/components/v2/history-panel.tsx" },
  { key: "history.checkpoint.frozenDelete", source: "src/components/v2/history-panel.tsx" },
];

/** Comments stripped: this file's own prose quotes the sentences it guards, and
 *  a component's comment may legitimately do the same. Only rendered code
 *  counts as a hardcoded literal. */
function code(relative: string): string {
  return readFileSync(join(process.cwd(), relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("the schedule-lock refusal's local copy", () => {
  // First, because every assertion below is DERIVED from these values: a
  // missing key makes the expectation `undefined`, and `not.toContain(undefined)`
  // passes on any input, so the source scans would go vacuously green.
  for (const { key } of KEYS) {
    for (const locale of Object.keys(DICTS)) {
      it(`${locale}/ui.json carries ${key}`, () => {
        expect(DICTS[locale], `${key} is missing from ${locale}/ui.json`).toHaveProperty(key);
        expect(typeof DICTS[locale]![key], `${locale}/${key} must be a string`).toBe("string");
        expect(DICTS[locale]![key]!.length, `${locale}/${key} is empty`).toBeGreaterThan(0);
      });
    }
  }

  it("is translated, not the English value copied into three files", () => {
    for (const { key } of KEYS) {
      for (const locale of ["es", "fr", "nl"]) {
        expect(DICTS[locale]![key], `${locale}/${key} is still the English string`).not.toBe(
          EN[key],
        );
      }
    }
  });

  it("carries no placeholders, so no locale can rename one into literal braces", () => {
    // A translated placeholder name renders as literal `{llaves}`. These three
    // sentences interpolate nothing, and the cheapest way to keep that true in
    // four files is to assert it.
    for (const { key } of KEYS) {
      for (const locale of Object.keys(DICTS)) {
        expect(DICTS[locale]![key], `${locale}/${key} grew a placeholder`).not.toMatch(/\{[^}]*\}/);
      }
    }
  });

  it("is read from the dictionary, not hardcoded in the component that speaks it", () => {
    for (const { key, source } of KEYS) {
      expect(code(source), `${key}'s English is hardcoded in ${source}`).not.toContain(EN[key]!);
    }
  });

  it("never hardcodes the SERVER's sentence in a client component either", async () => {
    // The whole defect in one line: matching or restating
    // `SCHEDULE_LOCKED_MESSAGE` in the browser is what this change removes. The
    // client must branch on the CODE, so the English sentence has no business
    // in either file — a client that recognised the refusal by its prose would
    // break the moment the prose was reworded.
    const { SCHEDULE_LOCKED_MESSAGE } = await import("@/lib/schedule-lock");
    for (const source of new Set(KEYS.map((k) => k.source))) {
      expect(code(source), `${source} matches the server's English sentence`).not.toContain(
        SCHEDULE_LOCKED_MESSAGE,
      );
    }
  });

  it("points at the freeze control the same way its neighbours in the same panel do", () => {
    // "Above" is per-locale copy, not a constant, and `history.checkpoint.frozen`
    // / `history.danger.frozen` already say it in each language. Three sentences
    // in one console must not disagree about which direction the checkbox is in.
    const DEIXIS: Record<string, string> = {
      en: "above",
      es: "arriba",
      fr: "ci-dessus",
      nl: "hierboven",
    };
    for (const key of ["history.error.frozen", "history.checkpoint.frozenDelete"]) {
      for (const [locale, word] of Object.entries(DEIXIS)) {
        expect(
          DICTS[locale]!["history.checkpoint.frozen"]!.toLowerCase(),
          `the sibling sentence stopped saying "${word}" in ${locale} — re-pick the word`,
        ).toContain(word);
        expect(
          DICTS[locale]![key]!.toLowerCase(),
          `${locale}/${key} must point at the freeze checkbox the same way its neighbour does`,
        ).toContain(word);
      }
    }
  });

  it("does not send the joint card's reader to a control that card does not have", () => {
    // The AI console is competition-scoped: the freeze it is refused by belongs
    // to ONE division and is set on that division's own page, not anywhere on
    // this card. The panel's own "unfreeze it above" would be a false direction
    // here, so this key must NOT reuse it.
    const DEIXIS = ["above", "arriba", "ci-dessus", "hierboven"];
    for (const locale of Object.keys(DICTS)) {
      const value = DICTS[locale]!["board.ai.joint.reasonLocked"]!.toLowerCase();
      for (const word of DEIXIS) {
        expect(value, `${locale}/board.ai.joint.reasonLocked points at a control it has not got`)
          .not.toContain(word);
      }
    }
  });
});
