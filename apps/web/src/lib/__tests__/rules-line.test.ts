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

  it("a one-clause line is that clause alone, with no joiner", () => {
    const swiss: RulesClause[] = [{ key: "format.rules.oneGamePointsCap", params: { points: 15, cap: 21 } }];
    expect(rulesLineText(enPublic, swiss)).toBe(t(enPublic, swiss[0]!.key, swiss[0]!.params));
    expect(rulesLineText(enPublic, [])).toBe("");
  });
});
