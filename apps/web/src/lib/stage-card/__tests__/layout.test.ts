// Match Day Phase C, Task C3 (spec 2026-10-31-match-day-design.md §12 Phase C items 1, 8, 12) - the stage card's layout
// decisions, as pure functions: whether the kind pill repeats the stage's name, how many matches "Complete stage unlocks when
// all N matches are played" counts, which parts of the card's summary line differ from the division's, and the one-line
// summary itself. The expected values come from the engine's own declarations (its stage kinds, a sport's default order) and
// from the C1 summaries these read - never from the code under test.
//
// Anti-vacuity (TEST-STRATEGY 2): every sweep returns how many items it visited; zero fails.
import { describe, expect, it } from "vitest";
import { StageKind } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { defaultOrderOf, forEachSport } from "@seazn/engine/testkit";
import type { TableStageKind } from "@seazn/engine/sport";
import { showKindPill, tiesSummary } from "@/lib/stage-card/layout";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import type { MessageKey } from "@/lib/messages";

const LOCALES = { en, es, fr, nl } as const;

describe("showKindPill (item 1: the kind pill repeats the stage name)", () => {
  it("drops the pill when the name says the kind, in any case", () => {
    expect(showKindPill("League", "league")).toBe(false);
    expect(showKindPill("LEAGUE", "league")).toBe(false);
    expect(showKindPill("Swiss", "swiss")).toBe(false);
    expect(showKindPill("Group A", "group")).toBe(false);
    expect(showKindPill("The Knockout", "knockout")).toBe(false);
  });

  it("keeps the pill when the name does not say the kind", () => {
    expect(showKindPill("Pool A", "group")).toBe(true);
    expect(showKindPill("Finals", "knockout")).toBe(true);
    expect(showKindPill("Round robin", "league")).toBe(true);
  });

  it("reads a two-word kind as the words a person writes (double_elim / page_playoff)", () => {
    expect(showKindPill("Double elimination", "double_elim")).toBe(false);
    expect(showKindPill("Page playoff", "page_playoff")).toBe(false);
    expect(showKindPill("Playoff", "page_playoff")).toBe(true);
  });

  it("an empty name keeps the pill (it is then the only thing naming the stage)", () => {
    expect(showKindPill("", "league")).toBe(true);
  });

  it("sweeps every engine stage kind: its own name drops the pill, an unrelated name keeps it", () => {
    let visited = 0;
    for (const kind of StageKind.options) {
      visited++;
      const spoken = kind.replace(/_/g, " ");
      expect(showKindPill(spoken, kind), `${kind}: a stage named for its kind`).toBe(false);
      expect(showKindPill(`1. ${spoken}`, kind), `${kind}: with a number in front`).toBe(false);
      expect(showKindPill("Xyzzy", kind), `${kind}: an unrelated name`).toBe(true);
    }
    expect(visited, "premise: the sweep visits every engine stage kind").toBe(StageKind.options.length);
    expect(visited).toBeGreaterThan(0);
  });
});

describe("tiesSummary (the 'Ties: wins, then game difference…' clause)", () => {
  const nameOf = (key: string) => key.toUpperCase();
  const then = " > ";

  it("names the first two real criteria and an ellipsis when more follow", () => {
    expect(tiesSummary(["wins", "diff", "for", "lots"], nameOf, then)).toBe("WINS > DIFF…");
  });

  it("names every criterion when there are two or fewer", () => {
    expect(tiesSummary(["wins", "diff"], nameOf, then)).toBe("WINS > DIFF");
    expect(tiesSummary(["wins"], nameOf, then)).toBe("WINS");
  });

  it("takes the two-way head-to-head rung out: it is one explanatory sentence, not a step", () => {
    expect(tiesSummary(["h2h_two", "wins", "h2h_two", "diff", "lots"], nameOf, then)).toBe("WINS > DIFF…");
  });

  it("an order with no real criterion says nothing", () => {
    expect(tiesSummary([], nameOf, then)).toBeNull();
    expect(tiesSummary(["h2h_two"], nameOf, then)).toBeNull();
  });

  it("sweeps every sport and table kind: the summary never leads with the head-to-head rung and always says something", () => {
    let visited = 0;
    const kinds: TableStageKind[] = ["league", "group", "swiss"];
    forEachSport(({ module }) => {
      for (const kind of kinds) {
        const keys = defaultOrderOf(module, kind);
        const said = tiesSummary(keys, nameOf, then);
        visited++;
        expect(said, `${module.key} ${kind}: the sport's own default order has a real criterion`).not.toBeNull();
        expect(said!.startsWith("H2H_TWO"), `${module.key} ${kind}: never leads with the two-way rung`).toBe(false);
      }
    });
    expect(visited).toBe(builtinModules.length * kinds.length);
  });
});

describe("the dictionary words this task adds exist in all four locales", () => {
  const KEYS = [
    "stageCard.summary.ties",
    "stageCard.summary.then",
    "stageCard.summary.differs",
    "stageCard.completeHint.one",
    "stageCard.completeHint.other",
    "stageCard.settings",
  ] as const satisfies readonly MessageKey[];

  it.each(Object.keys(LOCALES) as (keyof typeof LOCALES)[])("%s has every key, non-empty", (locale) => {
    const dict = LOCALES[locale] as unknown as Record<string, string>;
    let checked = 0;
    for (const key of KEYS) {
      checked++;
      expect(dict[key], `${locale}: ${key}`).toBeTruthy();
    }
    expect(checked).toBe(KEYS.length);
  });
});
