// The standings tie-break cascade caption used to join raw engine rule keys
// ("h2h_points", "diff", ...) verbatim — English regardless of locale, inside
// an otherwise fully translated caption (design/fix-ui/03-console-division.md).
// localizedTieBreakLabel routes each rule name through the real `ui`
// dictionaries instead.
import { describe, expect, it } from "vitest";
import { localizedTieBreakLabel } from "@/lib/tiebreak-label";
import { builtinModules } from "@seazn/engine/sports";
import { TIE_BREAK_MSG_KEYS } from "@/server/public-site/standings-view";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

describe("localizedTieBreakLabel", () => {
  it("translates known engine rule keys via the ui catalog", () => {
    expect(localizedTieBreakLabel(en, "h2h_points")).toBe("head-to-head");
    expect(localizedTieBreakLabel(fr, "h2h_points")).toBe("confrontation directe");
    expect(localizedTieBreakLabel(fr, "lots")).toBe("tirage au sort");
    expect(localizedTieBreakLabel(fr, "diff")).toBe("différence");
  });

  it("falls back to the raw key for a rule not yet in the catalog, instead of throwing or leaking a dotted message key", () => {
    expect(localizedTieBreakLabel(fr, "some_future_rule")).toBe("some_future_rule");
  });

  // Fix round 1: the console said "goal/run difference" / "goals/runs scored"
  // for every sport while the public tables said the sport's own word.
  it("diff and for say the sport's word when the page names the ledger family, the plain word when it does not", () => {
    expect(localizedTieBreakLabel(en, "diff")).toBe("difference");
    expect(localizedTieBreakLabel(en, "for")).toBe("total scored");
    expect(localizedTieBreakLabel(en, "diff", "plain")).toBe("difference");
    expect(localizedTieBreakLabel(en, "diff", "goals")).toBe("goal difference");
    expect(localizedTieBreakLabel(en, "diff", "runs")).toBe("run difference");
    expect(localizedTieBreakLabel(en, "for", "goals")).toBe("goals scored");
    expect(localizedTieBreakLabel(en, "for", "runs")).toBe("runs scored");
    expect(localizedTieBreakLabel(nl, "diff", "goals")).toBe("doelsaldo");
    expect(localizedTieBreakLabel(es, "for", "runs")).toBe("carreras a favor");
  });

  it("a family never changes any other rule's word", () => {
    expect(localizedTieBreakLabel(en, "points", "goals")).toBe("points");
    expect(localizedTieBreakLabel(en, "h2h_diff", "runs")).toBe("head-to-head difference");
  });

  // Every rule the public tables can name (`TIE_BREAK_MSG_KEYS`) and every
  // built-in sport's default cascade, in every locale and every ledger family:
  // a real word, never the raw key (tennis's `game_ratio` printed "game_ratio"
  // in the console) and never a slashed catch-all.
  it("every rule, locale and family has a word of its own, with no slash", () => {
    const rules = new Set([...Object.keys(TIE_BREAK_MSG_KEYS), ...builtinModules.flatMap((m) => m.defaultTiebreakers)]);
    expect(rules, "premise: the sweep reaches tennis's game ratio").toContain("game_ratio");
    const bad: string[] = [];
    for (const [locale, dict] of Object.entries({ en, es, fr, nl })) {
      for (const rule of rules) {
        for (const family of [undefined, "plain", "goals", "runs"] as const) {
          const word = localizedTieBreakLabel(dict, rule, family);
          if (word.includes("/")) bad.push(`${locale} ${rule}/${family}: "${word}"`);
        }
        // Authored, not fallen through (en "wins" IS its key, so ask the dict).
        if (!Object.hasOwn(dict, `div.detail.tiebreak.rule.${rule}`)) bad.push(`${locale} ${rule}: raw key`);
      }
      for (const key of ["diffGoals", "diffRuns", "forGoals", "forRuns"]) {
        if (!Object.hasOwn(dict, `div.detail.tiebreak.rule.${key}`)) bad.push(`${locale} ${key}: missing`);
      }
    }
    expect(bad).toEqual([]);
  });
});
