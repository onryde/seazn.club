// Design audit 4.3 — the organiser's tag carries its expansion (accessible name and tooltip). Every tag kind the house
// declares (`FORFEIT_TAG_KEY`, scoring-vocab) owes one in every locale, and it must say more than the tag it expands:
// an expansion equal to its abbreviation would name nothing. Swept over the declaration and the four dictionaries.
import { describe, expect, it } from "vitest";
import { FORFEIT_TAG_KEY } from "@/lib/forfeit-tag";
import { FORFEIT_TAG_FULL_KEY, ORGANISER_TAG_FULL_KEY, outcomeTagWords } from "@/lib/outcome-text";
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

// W3 T15 ruling 2 (controller, 2026-11-02): a disqualification runs the withdrawal cascade, whose award over her open
// board carries reason `withdrew` (the engine has no unplayed `disqualified` forfeit, PF-2). The organiser's surfaces —
// the run sheet, the fixture console — never label her as having withdrawn: where they state the reason (the tag's
// expansion), they say she was DISQUALIFIED. The public posture (I4: the plain walkover) is the default map's; the
// organiser passes `ORGANISER_TAG_FULL_KEY`. The tag itself stays "w/o" for both: the line reads the walkover it is.
// Both reasons, every locale; each locale's own words come from its dictionary, never from the code under test.
describe("the organiser's expansion of a disqualified entrant's cascade walkover says disqualified, never withdrew (W3 T15 ruling 2)", () => {
  const award = { kind: "award", winner: "w", loser: "her", reason: "withdrew" } as const;
  /** The locale's own word for a withdrawal: its "withdrew" expansion less the walkover's (e.g. "withdrew"). */
  const withdrawalWord = (d: Record<string, string>) =>
    d["forfeit.tagFull.withdrew"]!.replace(d["forfeit.tagFull.walkover"]!, "").replace(/[—–-]/gu, "").trim();

  it("both reasons × 4 locales: withdrawn keeps today's expansion; disqualified names the disqualification and no withdrawal", () => {
    let checked = 0;
    for (const [loc, dict] of Object.entries(LOCALES)) {
      const msg = (k: string, v?: Record<string, string | number>) => t(dict as never, k as never, v);
      const words = (status: string) => outcomeTagWords(msg as never, award, undefined, undefined, { her: status }, ORGANISER_TAG_FULL_KEY);
      const wd = withdrawalWord(dict);
      const dqWord = dict["forfeit.tagFull.disqualified"]!;
      expect(wd.length, `${loc}: premise, the locale words a withdrawal`).toBeGreaterThan(0);
      expect(dqWord.toLowerCase(), `${loc}: premise, the disqualification word is not the withdrawal's`).not.toContain(wd.toLowerCase());
      // Withdrawn: today's words, byte for byte.
      expect(words("withdrawn"), `${loc}: withdrawn`).toEqual({ word: dict["forfeit.tag.walkover"], full: dict["forfeit.tagFull.withdrew"] });
      // Disqualified: the walkover's tag; the expansion is the organiser's own key, says the locale's DQ word, and no withdrawal.
      const dq = words("disqualified")!;
      expect(dq, `${loc}: disqualified`).toEqual({ word: dict["forfeit.tag.walkover"], full: dict["forfeit.tagFull.disqualifiedWalkover"] });
      expect(dq.full.toLowerCase(), `${loc}: "${dq.full}" says "${dqWord}"`).toContain(dqWord.toLowerCase());
      expect(dq.full.toLowerCase(), `${loc}: "${dq.full}" says no "${wd}"`).not.toContain(wd.toLowerCase());
      expect(dq.full, `${loc}: the expansion says more than the tag`).not.toBe(dq.word);
      checked++;
    }
    expect(checked, `locales checked: ${checked}`).toBe(4);
  });

  it("the organiser map differs from the public one ONLY for that walkover; the public map keeps I4's plain walkover", () => {
    const kinds = Object.keys(FORFEIT_TAG_FULL_KEY) as (keyof typeof FORFEIT_TAG_FULL_KEY)[];
    const differ = kinds.filter((k) => ORGANISER_TAG_FULL_KEY[k] !== FORFEIT_TAG_FULL_KEY[k]);
    expect(kinds.length, "premise: every tag kind is declared").toBe(Object.keys(FORFEIT_TAG_KEY).length);
    expect(differ).toEqual(["walkover_plain"]);
    const msg = (k: string, v?: Record<string, string | number>) => t(messages as never, k as never, v);
    const UI = messages as Record<string, string>;
    expect(outcomeTagWords(msg as never, award, undefined, undefined, { her: "disqualified" })?.full, "public: the plain walkover").toBe(UI["forfeit.tagFull.walkover"]);
    expect(outcomeTagWords(msg as never, award, undefined, undefined, undefined, ORGANISER_TAG_FULL_KEY)?.full, "organiser, no statuses held: today's withdrawal").toBe(UI["forfeit.tagFull.withdrew"]);
  });
});
