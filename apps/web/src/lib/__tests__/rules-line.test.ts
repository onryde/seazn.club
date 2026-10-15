// `rulesLineText` — the ONE place a match-rules format line (a list of Msg
// clauses from `describe-rules.ts`) becomes words. The match page, the hub's
// Info tab and the division page's stage chips all call it, so the joiner and
// the per-clause resolution are pinned here once.
import { describe, expect, it } from "vitest";
import enPublic from "@/dictionaries/en/public.json";
import frPublic from "@/dictionaries/fr/public.json";
import { t } from "@/lib/i18n-runtime";
import { RULES_LINE_JOINER, type RulesClause, rulesLineText } from "@/lib/rules-line";

describe("rulesLineText", () => {
  const fast4: RulesClause[] = [
    { key: "format.rules.tennis.bestOfSets", params: { n: 3 } },
    { key: "format.rules.tennis.setsTo", params: { games: 4 } },
    { key: "format.rules.tennis.noAd" },
  ];

  it("resolves EACH clause with its own params and joins them with a comma — never the header's ' · '", () => {
    expect(RULES_LINE_JOINER).toBe(", ");
    expect(rulesLineText(enPublic, fast4)).toBe("Best of 3 sets, first to 4 games, no-ad scoring");
    expect(rulesLineText(enPublic, fast4)).not.toContain("·");
  });

  it("resolves against the dictionary it is GIVEN (the hub's slice, the org's locale)", () => {
    expect(rulesLineText(frPublic, fast4)).toBe(fast4.map((c) => t(frPublic, c.key, c.params)).join(", "));
    expect(rulesLineText(frPublic, fast4)).not.toBe(rulesLineText(enPublic, fast4));
  });

  it("the LINE starts with a capital, whichever clause leads - and only the first letter is touched (W2c Task 16)", () => {
    // Clauses are written to sit anywhere in a line, so they begin lowercase ("walkover 2–0", "penalties (5 each)").
    // The joiner capitalises the sentence's first letter, once; a clause that leads with a digit is left alone.
    const lowerFirst: RulesClause[] = [
      { key: "format.rules.decider.extraTime", params: { n: 15 } },
      { key: "format.rules.decider.penalties", params: { n: 5 } },
    ];
    expect(rulesLineText(enPublic, lowerFirst)).toBe("Extra time (2 × 15 min), penalties (5 each)");
    expect(rulesLineText(enPublic, [lowerFirst[1]!, lowerFirst[0]!])).toBe("Penalties (5 each), extra time (2 × 15 min)");
    expect(rulesLineText(enPublic, [{ key: "format.rules.period.halves", params: { m: 45 } }, lowerFirst[0]!])).toBe(
      "2 halves of 45 min, extra time (2 × 15 min)",
    );
    // The same in a locale whose first letter is an accented capital candidate.
    expect(rulesLineText(frPublic, lowerFirst).charAt(0)).toBe(rulesLineText(frPublic, lowerFirst).charAt(0).toUpperCase());
  });

  it("a one-clause line is that clause alone, with no joiner", () => {
    const swiss: RulesClause[] = [{ key: "format.rules.oneGamePointsCap", params: { points: 15, cap: 21 } }];
    expect(rulesLineText(enPublic, swiss)).toBe(t(enPublic, swiss[0]!.key, swiss[0]!.params));
    expect(rulesLineText(enPublic, [])).toBe("");
  });
});
