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
// the copy half of that: each key exists in all four locales, is really
// translated rather than the English value copied across, carries no
// placeholders to lose in translation, and is not held as a literal by the
// component that speaks it. Without the last guard the components would render
// correctly under `useMsg`'s English fallback whether the sentence came from
// the dictionary or from a hardcoded string — and that guard is the ONLY thing
// that can see the difference, because the hook harness those components are
// driven through has no provider tree at all.
//
// WIDENED (2026-09-05): the schedule lock was the first refusal to get this
// treatment, not the only one that needed it. Two more English sentences were
// left behind by that pass and are now covered here, because they are the same
// defect in the same two components rather than a new one:
//
//   - `board.ai.joint.reasonSuperseded` — the usecase's own English sentence
//     for a rewind a newer joint apply overtook, landing in the SAME
//     `{reason}` placeholder the freeze sentence used to;
//   - `history.error.seqConflict` — "Someone else edited this division …",
//     a hardcoded literal in the branch immediately above the freeze branch.
//
// The filename still says schedule-lock; the describe titles below say what is
// actually asserted. Sweep this file by what it ASSERTS, not by its name.
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

/** Every refusal sentence these two components say in the reader's own
 *  language, and the component each is spoken by — so "the English is not a
 *  literal" is checked against the file that would hold it, not against the
 *  tree at large. */
const KEYS: { key: string; source: string }[] = [
  { key: "board.ai.joint.reasonLocked", source: "src/components/v2/board/ai-competition-console.tsx" },
  { key: "board.ai.joint.reasonSuperseded", source: "src/components/v2/board/ai-competition-console.tsx" },
  { key: "history.error.frozen", source: "src/components/v2/history-panel.tsx" },
  { key: "history.error.seqConflict", source: "src/components/v2/history-panel.tsx" },
  { key: "history.checkpoint.frozenDelete", source: "src/components/v2/history-panel.tsx" },
];

/** The two JOINT-card sentences. Grouped because the card is
 *  competition-scoped and neither may point at a control it has not got. */
const JOINT_KEYS = ["board.ai.joint.reasonLocked", "board.ai.joint.reasonSuperseded"];

/** Comments stripped: this file's own prose quotes the sentences it guards, and
 *  a component's comment may legitimately do the same. Only rendered code
 *  counts as a hardcoded literal. */
function code(relative: string): string {
  return readFileSync(join(process.cwd(), relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("the refusal sentences these two components say locally", () => {
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

    // The superseded refusal's sentence is NOT exported: it is server-side
    // prose, and `@/lib/joint-undo` deliberately shares only the code, so that
    // English never sits one import away from a browser surface. Its most
    // distinctive clause stands in — a console that recognised this refusal by
    // its prose would break the moment the prose was reworded, which is the
    // whole reason the code exists.
    for (const source of new Set(KEYS.map((k) => k.source))) {
      expect(
        code(source),
        `${source} matches the superseded refusal's English prose instead of its code`,
      ).not.toContain("newer joint apply");
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
    for (const key of JOINT_KEYS) {
      for (const locale of Object.keys(DICTS)) {
        const value = DICTS[locale]![key]!.toLowerCase();
        for (const word of DEIXIS) {
          expect(value, `${locale}/${key} points at a control it has not got`).not.toContain(word);
        }
      }
    }
  });
});
