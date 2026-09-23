// The `diff` and `for` tie-break rules say the SPORT's word — "goal
// difference" in football, "run difference" in cricket, plain "difference"
// in the generic module — never the one catch-all "goal/run difference" /
// "goals/runs scored" every sport used to print (owner copy fix, 2026-09-23).
//
// The word follows the LEDGER, not a list of sports: the engine resolves the
// abstract `diff`/`for` to whichever alias a row records (`DIFF_KEYS`,
// `FOR_KEYS`, `metricKeyOf`), and the phrase is that alias's family. So the
// rows below carry exactly the ledger keys each module declares
// (`module.metrics`) — what its `standingsDelta` folds — and the enumeration
// test pins that every alias the engine can read has a family.
//
// Three surfaces print the rule: the hub's tie note (`buildTableView`), the
// division page / embed / console tie note (`StandingsTable`), and the
// what-if (`qualification-view.test.ts`, "what-if (§3.4)", which carries the
// football, cricket and generic cases for that surface).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AGAINST_KEYS, DIFF_KEYS, FOR_KEYS, type StandingsRow } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t, type TKey } from "@/lib/i18n-runtime";
import { StandingsTable } from "@/components/public-site/standings-table";
import { LEDGER_ALIAS_FAMILY, LEDGER_RULE_MSG_KEYS, buildTableView, tieBreakRule } from "../standings-view";

const LOCALES = { en, es, fr, nl } as unknown as Record<string, Dict>;

const moduleOf = (key: string) => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no module ${key}`);
  return m;
};

/** A row carrying exactly the ledger keys `sport` declares. */
function ledgerRow(sport: string, entrantId: string, over: Partial<StandingsRow> = {}): StandingsRow {
  return {
    entrantId,
    played: 2,
    won: 1,
    drawn: 0,
    lost: 1,
    points: 3,
    metrics: Object.fromEntries(moduleOf(sport).metrics.map((s, i) => [s.key, i + 1])),
    ...over,
  };
}

/** [sport, rule, the English phrase]. */
const CASES: [string, "diff" | "for", string][] = [
  ["football", "diff", "goal difference"],
  ["football", "for", "goals scored"],
  ["hockey", "diff", "goal difference"],
  ["icehockey", "for", "goals scored"],
  ["cricket", "diff", "run difference"],
  ["cricket", "for", "runs scored"],
  ["generic", "diff", "difference"],
  ["generic", "for", "total scored"],
];

describe("the ledger family of a diff/for tie-break", () => {
  it("every alias the engine's diff/for/against read has a family — exactly those", () => {
    expect(Object.keys(LEDGER_ALIAS_FAMILY).sort()).toEqual([...DIFF_KEYS, ...FOR_KEYS, ...AGAINST_KEYS].sort());
  });

  it("each family's phrase exists in all four locales, and none is the old slashed catch-all", () => {
    for (const byFamily of Object.values(LEDGER_RULE_MSG_KEYS)) {
      for (const key of Object.values(byFamily)) {
        for (const [locale, dict] of Object.entries(LOCALES)) {
          const phrase = (dict as Record<string, string>)[key];
          expect(phrase, `${locale} ${key}`).toBeTypeOf("string");
          expect(phrase, `${locale} ${key}`).not.toContain("/");
        }
      }
    }
  });

  it("the three families say three different things in every locale", () => {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const byFamily of Object.values(LEDGER_RULE_MSG_KEYS)) {
        const words = Object.values(byFamily).map((k) => (dict as Record<string, string>)[k]);
        expect(new Set(words).size, `${locale} ${JSON.stringify(words)}`).toBe(words.length);
      }
    }
  });

  it("tieBreakRule reads the row's own ledger: football, hockey, ice hockey, cricket, generic", () => {
    const msg = (k: TKey) => t(en as unknown as Dict, k);
    for (const [sport, rule, phrase] of CASES) {
      expect(tieBreakRule(rule, msg, ledgerRow(sport, "a")), `${sport} ${rule}`).toBe(phrase);
    }
  });

  it("a row with no ledger at all falls to the plain phrase, and every other rule is untouched", () => {
    const msg = (k: TKey) => t(en as unknown as Dict, k);
    const bare = { ...ledgerRow("generic", "a"), metrics: {} };
    expect(tieBreakRule("diff", msg, bare)).toBe("difference");
    expect(tieBreakRule("for", msg, bare)).toBe("total scored");
    expect(tieBreakRule("h2h_points", msg, ledgerRow("football", "a"))).toBe("head-to-head");
    expect(tieBreakRule("nrr", msg, ledgerRow("cricket", "a"))).toBe("net run rate");
  });

  it("the key the engine COMPARES decides: a cricket row a rule forfeit gave a plain `diff` reads plain", () => {
    // `applyPointsRule` writes for/against/diff into a forfeit's delta, so a
    // cricket row can record `diff` (and no `run_diff`, which cricket's ledger
    // lacks). `metricKeyOf(row, DIFF_KEYS)` is then "diff" — that is the value
    // the engine compares, so the note names it rather than claiming runs.
    const msg = (k: TKey) => t(en as unknown as Dict, k);
    const forfeited = ledgerRow("cricket", "a");
    forfeited.metrics = { ...forfeited.metrics, for: 10, against: 0, diff: 10 };
    expect(tieBreakRule("diff", msg, forfeited)).toBe("difference");
    // Same for `for`: FOR_KEYS lists `for` before `runs_for`, so the engine
    // compares the forfeit's `for`, and the note names that. (The alias-order
    // proposal in this branch's report would reorder FOR_KEYS; this pin flips
    // with it, to "runs scored".)
    expect(tieBreakRule("for", msg, forfeited)).toBe("total scored");
    // Each rule reads ITS OWN alias first, then the others: a row whose `for`
    // resolves to runs but whose difference is the plain key names each.
    const split = { ...ledgerRow("cricket", "a"), metrics: { runs_for: 7, runs_against: 3, diff: 4 } };
    expect(tieBreakRule("diff", msg, split)).toBe("difference");
    expect(tieBreakRule("for", msg, split)).toBe("runs scored");
  });
});

describe("the tie note says the sport's word — on the hub and on the division page", () => {
  const hubNote = (sport: string, rule: string, dict: Dict) => {
    const m = moduleOf(sport);
    return buildTableView({
      id: "t",
      division: { id: "d1", slug: "div", name: "Div" },
      caption: "League",
      fullHref: "/x",
      metricSpecs: m.metrics,
      cascade: m.defaultTiebreakers,
      rows: [ledgerRow(sport, "a", { rank: 1 }), ledgerRow(sport, "b", { rank: 2, tieBreak: { key: rule, with: ["a"] } })],
      entrantNames: { a: "Alpha", b: "Beta" },
      entrantLogos: {},
      entrantColours: {},
      championId: null,
      updatedAt: "2026-09-23T10:00:00Z",
      msg: (k, v) => t(dict, k, v),
    }).rows[1]!.tieBreakText;
  };
  const divisionHtml = (sport: string, rule: string, dict: Dict) => {
    const m = moduleOf(sport);
    return renderToStaticMarkup(
      <StandingsTable
        rows={[ledgerRow(sport, "a", { rank: 1 }), ledgerRow(sport, "b", { rank: 2, tieBreak: { key: rule, with: ["a"] } })]}
        metricSpecs={m.metrics}
        cascade={m.defaultTiebreakers}
        entrantNames={{ a: "Alpha", b: "Beta" }}
        dict={dict}
      />,
    );
  };

  for (const [sport, rule, phrase] of CASES.filter(([s]) => ["football", "cricket", "generic"].includes(s))) {
    it(`${sport}, ${rule}: "${phrase}"`, () => {
      const sentence = `Tied with Alpha — split on ${phrase}`;
      expect(hubNote(sport, rule, en as unknown as Dict)).toBe(sentence);
      expect(divisionHtml(sport, rule, en as unknown as Dict)).toContain(`>${sentence}</span>`);
    });
  }

  it("es/fr/nl word it from their own dictionaries (football diff, cricket for)", () => {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      const d = dict as Record<string, string>;
      const frame = (rule: string) => d["table.tieBreak"]!.replace("{with}", "Alpha").replace("{rule}", rule);
      expect(hubNote("football", "diff", dict), locale).toBe(frame(d[LEDGER_RULE_MSG_KEYS.diff.goals]!));
      expect(hubNote("cricket", "for", dict), locale).toBe(frame(d[LEDGER_RULE_MSG_KEYS.for.runs]!));
    }
  });
});
