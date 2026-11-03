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
import enPublic from "@/dictionaries/en/public.json";
import esPublic from "@/dictionaries/es/public.json";
import frPublic from "@/dictionaries/fr/public.json";
import nlPublic from "@/dictionaries/nl/public.json";
import { RATIO_LEDGERS } from "@seazn/engine/competition";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { defaultOrderOf } from "@seazn/engine/testkit";
import { TiebreakerKeyS } from "@/server/api-v1/schemas";

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
    const rules = new Set([...Object.keys(TIE_BREAK_MSG_KEYS), ...builtinModules.flatMap((m) => defaultOrderOf(m))]);
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

  // W3 app-B T3 (X-SW-31, step 1): the key list is the engine's own TiebreakerKey vocabulary - the wire enum
  // `TiebreakerKeyS`, which `schemas.ts` holds equal to the engine's type in BOTH directions (an `AssertTrue`) - never a
  // list typed here. Counted: a vocabulary that grew a key gains a row of words in all four locales or this reds.
  it("every TiebreakerKey the engine declares has a console rule word and a public tie-break word in all four locales (counted)", () => {
    const keys = TiebreakerKeyS.options;
    expect(keys.length, "premise: the engine declares its tie-break vocabulary").toBeGreaterThan(20);
    expect(keys, "premise: the Swiss goals chain's opp_diff is in it").toContain("opp_diff");
    const locales = {
      en: [en, enPublic],
      es: [es, esPublic],
      fr: [fr, frPublic],
      nl: [nl, nlPublic],
    } as const;
    const missing: string[] = [];
    let checked = 0;
    for (const [locale, [ui, pub]] of Object.entries(locales)) {
      for (const key of keys) {
        const consoleKey = `div.detail.tiebreak.rule.${key}`;
        if (!Object.hasOwn(ui, consoleKey)) missing.push(`${locale} ${consoleKey}`);
        const publicKey = TIE_BREAK_MSG_KEYS[key];
        if (publicKey === undefined || !Object.hasOwn(pub, publicKey)) missing.push(`${locale} public ${key}`);
        checked++;
      }
    }
    expect(missing).toEqual([]);
    expect(checked, "keys x locales swept").toBe(keys.length * 4);
  });

  // The Swiss chain's opponents' difference reads in the SPORT-NEUTRAL word (owner, 2026-11-03: hockey and ice hockey
  // are not "goals" in every locale), the same in the console's caption and in the public tie sentence, and each locale
  // says it in its own words rather than pasting English.
  it("opp_diff reads the same neutral word in the console and on the public table, in every locale, and no locale pastes the English", () => {
    const pairs = [
      ["en", en, enPublic, /goal/i],
      ["es", es, esPublic, /gol/i],
      ["fr", fr, frPublic, /\bbuts?\b/i],
      ["nl", nl, nlPublic, /doel/i],
    ] as const;
    const enConsole = localizedTieBreakLabel(en, "opp_diff");
    expect(enConsole).toBe("opponents' score difference");
    for (const [locale, ui, pub, goalWord] of pairs) {
      const console_ = localizedTieBreakLabel(ui, "opp_diff");
      const publicWord = t(pub as unknown as Dict, TIE_BREAK_MSG_KEYS.opp_diff!);
      const column = t(pub as unknown as Dict, "table.col.oppDiff");
      expect(console_, `${locale}: the console and the public tie sentence say one word`).toBe(publicWord);
      expect(column.toLowerCase(), `${locale}: the column's long form is the same words`).toBe(publicWord.toLowerCase());
      expect(goalWord.test(console_), `${locale}: "${console_}" is not sport-neutral`).toBe(false);
      if (locale !== "en") expect(console_, `${locale} pastes the English`).not.toBe(enConsole);
    }
  });

  // Fix round 2: Dutch said "setratio" on the public table and "setverhouding"
  // in the organiser console (and "bordverhouding"/"puntenverhouding" beside
  // them), so one carrom cascade read two ways. The public word is the one
  // players read, so the console takes it — for every ratio rule the engine
  // knows (`RATIO_LEDGERS`), in every locale.
  it("each ratio rule reads exactly as the public tables name it, in every locale", () => {
    const pairs = [
      ["en", en, enPublic],
      ["es", es, esPublic],
      ["fr", fr, frPublic],
      ["nl", nl, nlPublic],
    ] as const;
    const rules = Object.keys(RATIO_LEDGERS);
    expect(rules, "premise: the sweep reaches set ratio").toContain("set_ratio");
    const apart: string[] = [];
    for (const [locale, ui, pub] of pairs) {
      for (const rule of rules) {
        const console_ = localizedTieBreakLabel(ui, rule);
        const publicWord = t(pub as unknown as Dict, TIE_BREAK_MSG_KEYS[rule]!);
        if (console_ !== publicWord) apart.push(`${locale} ${rule}: console "${console_}" vs public "${publicWord}"`);
      }
    }
    expect(apart).toEqual([]);
  });
});
