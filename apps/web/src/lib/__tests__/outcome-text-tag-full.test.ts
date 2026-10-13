// Design audit 4.3 — the organiser's tag carries its expansion (accessible name and tooltip). Every tag kind the house
// declares (`FORFEIT_TAG_KEY`, scoring-vocab) owes one in every locale, and it must say more than the tag it expands:
// an expansion equal to its abbreviation would name nothing. Swept over the declaration and the four dictionaries.
import { describe, expect, it } from "vitest";
import { FORFEIT_TAG_KEY } from "@/lib/forfeit-tag";
import { FORFEIT_TAG_FULL_KEY, outcomeTagWords } from "@/lib/outcome-text";
import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import es from "@/dictionaries/es/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { messages } from "@/lib/messages";
import { t } from "@/lib/i18n-runtime";

const LOCALES = { en, fr, es, nl } as unknown as Record<string, Record<string, string>>;

describe("every tag kind has its expansion, in every locale (audit 4.3)", () => {
  it("the expansion exists and is not the tag, for each declared kind × 4 locales", () => {
    const kinds = Object.keys(FORFEIT_TAG_KEY) as (keyof typeof FORFEIT_TAG_KEY)[];
    expect(kinds.length, "premise: the house declares its tag kinds").toBeGreaterThanOrEqual(8);
    let checked = 0;
    for (const kind of kinds) {
      for (const [loc, dict] of Object.entries(LOCALES)) {
        const full = dict[FORFEIT_TAG_FULL_KEY[kind]];
        const tag = dict[FORFEIT_TAG_KEY[kind]];
        expect(full, `${loc} ${kind}: ${FORFEIT_TAG_FULL_KEY[kind]}`).toBeTruthy();
        expect(full, `${loc} ${kind}: the expansion says more than "${tag}"`).not.toBe(tag);
        checked++;
      }
    }
    expect(checked).toBe(kinds.length * 4);
  });

  it("outcomeTagWords: the tag and its expansion for a tagged result; null for a bye and for no result", () => {
    const msg = (k: string, v?: Record<string, string | number>) => t(messages as never, k as never, v);
    const UI = messages as Record<string, string>;
    expect(outcomeTagWords(msg as never, { kind: "award", winner: "a", loser: "b", reason: "retired" })).toEqual({
      word: UI["forfeit.tag.retired"],
      full: UI["forfeit.tagFull.retired"],
    });
    expect(outcomeTagWords(msg as never, { kind: "award", winner: "a", loser: "b", reason: "withdrew" })?.full, "withdrew: its own expansion").toBe(UI["forfeit.tagFull.withdrew"]);
    expect(outcomeTagWords(msg as never, { kind: "award", winner: "a", loser: null, reason: "bye" }), "a bye").toBeNull();
    expect(outcomeTagWords(msg as never, null), "no result").toBeNull();
  });
});
