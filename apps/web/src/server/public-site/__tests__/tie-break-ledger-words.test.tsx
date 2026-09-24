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
import {
  AGAINST_KEYS,
  DIFF_KEYS,
  FOR_KEYS,
  foldResults,
  rankStandings,
  type FixtureResult,
  type StandingsRow,
} from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t, type TKey } from "@/lib/i18n-runtime";
import { StandingsTable } from "@/components/public-site/standings-table";
import {
  LEDGER_ALIAS_FAMILY,
  LEDGER_RULE_MSG_KEYS,
  TIE_BREAK_MSG_KEYS,
  buildTableView,
  sportLedgerFamily,
  tieBreakRule,
} from "../standings-view";
import { localizedTieBreakLabel } from "@/lib/tiebreak-label";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

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
      expect(tieBreakRule(rule, msg, ledgerRow(sport, "a"), []), `${sport} ${rule}`).toBe(phrase);
    }
  });

  it("a table with no ledger anywhere falls to the plain phrase, and every other rule is untouched", () => {
    const msg = (k: TKey) => t(en as unknown as Dict, k);
    const bare = { ...ledgerRow("generic", "a"), metrics: {} };
    expect(tieBreakRule("diff", msg, bare, [bare])).toBe("difference");
    expect(tieBreakRule("for", msg, bare, [bare])).toBe("total scored");
    expect(tieBreakRule("h2h_points", msg, ledgerRow("football", "a"), [])).toBe("head-to-head");
    expect(tieBreakRule("nrr", msg, ledgerRow("cricket", "a"), [])).toBe("net run rate");
  });

  it("the key the engine COMPARES decides: a cricket row a rule forfeit also gave the generic keys still reads runs", () => {
    // `applyPointsRule` writes for/against/diff into a forfeit's delta, so a
    // cricket row can record those beside its own `runs_for`/`run_diff`. The
    // engine reads the sport's own ledger first (DIFF_KEYS gd, run_diff, diff;
    // FOR_KEYS gf, runs_for, for — P1, owner-approved), so that is what it
    // compares and what the note names. Before P1 the generic keys came first
    // and this row read "difference" / "total scored".
    const msg = (k: TKey) => t(en as unknown as Dict, k);
    const forfeited = ledgerRow("cricket", "a");
    expect(Object.keys(forfeited.metrics), "premise: cricket's ledger records run_diff").toContain("run_diff");
    forfeited.metrics = { ...forfeited.metrics, for: 10, against: 0, diff: 10 };
    expect(tieBreakRule("diff", msg, forfeited, [])).toBe("run difference");
    expect(tieBreakRule("for", msg, forfeited, [])).toBe("runs scored");
    // A row with no `run_diff` (a snapshot folded before cricket recorded one)
    // compares the plain `diff` it does carry, and says so; each rule reads
    // ITS OWN alias first, then the others.
    const split = { ...ledgerRow("cricket", "a"), metrics: { runs_for: 7, runs_against: 3, diff: 4 } };
    expect(tieBreakRule("diff", msg, split, [])).toBe("difference");
    expect(tieBreakRule("for", msg, split, [])).toBe("runs scored");
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

// ── A row with no ledger of its own (review m1) ────────────────────────────
//
// An entrant yet to play records NO ledger key (`zeroRow` folds from `{}`),
// so its own row cannot say which sport's word the tie was split on. Hockey,
// round 1 of five: A 2–1 B, C 3–1 D, E sits out. B, D and E all have 0
// points and the default cascade splits them on `diff` — B −1, D −2, E none
// (an absent value ranks below a recorded one). E's partners were compared on
// `gd`, so E's note says "goal difference" like theirs. (The review named it
// "a bye row"; a real award bye folds `gd: 0` and 3 points through the
// module's own delta, so the ledgerless row is the entrant with no fixture.)
describe("a tied row with no ledger reads its partners' word", () => {
  const HOCKEY = moduleOf("hockey");
  /** One side of a result, carrying every ledger key hockey's delta writes. */
  const side = (entrantId: string, gf: number, ga: number): FixtureResult[number] => ({
    entrantId,
    played: 1,
    won: gf > ga ? 1 : 0,
    drawn: 0,
    lost: gf < ga ? 1 : 0,
    points: gf > ga ? 3 : 0,
    metrics: { ...Object.fromEntries(HOCKEY.metrics.map((m) => [m.key, 0])), gf, ga, gd: gf - ga },
  });
  const RESULTS: FixtureResult[] = [
    [side("A", 2, 1), side("B", 1, 2)],
    [side("C", 3, 1), side("D", 1, 3)],
  ];
  const ranked = () =>
    rankStandings(foldResults(["A", "B", "C", "D", "E"], RESULTS), {
      cascade: HOCKEY.defaultTiebreakers,
      results: RESULTS,
    }).rows;

  it("premise: the real fold and ranking leave E ledgerless, split from B and D on diff", () => {
    const rows = ranked();
    const e = rows.find((r) => r.entrantId === "E")!;
    expect(e.metrics).toEqual({});
    expect(e.points).toBe(0);
    expect(e.tieBreak?.key).toBe("diff");
    expect(e.tieBreak?.with).toEqual(expect.arrayContaining(["B", "D"]));
    expect(rows.map((r) => r.entrantId)).toEqual(["C", "A", "B", "D", "E"]);
  });

  it("hub and division page: E's note says goal difference, like B's and D's", () => {
    const rows = ranked();
    const names = { A: "Ash", B: "Birch", C: "Cedar", D: "Dogwood", E: "Elm" };
    const hub = buildTableView({
      id: "t",
      division: { id: "d1", slug: "div", name: "Div" },
      caption: "League",
      fullHref: "/x",
      metricSpecs: HOCKEY.metrics,
      cascade: HOCKEY.defaultTiebreakers,
      rows,
      entrantNames: names,
      entrantLogos: {},
      entrantColours: {},
      championId: null,
      updatedAt: "2026-09-24T10:00:00Z",
      msg: (k, v) => t(en as unknown as Dict, k, v),
    });
    const notes = Object.fromEntries(hub.rows.map((r) => [r.entrantId, r.tieBreakText]));
    for (const id of ["B", "D", "E"]) expect(notes[id], id).toMatch(/split on goal difference$/);
    const html = renderToStaticMarkup(
      <StandingsTable
        rows={rows}
        metricSpecs={HOCKEY.metrics}
        cascade={HOCKEY.defaultTiebreakers}
        entrantNames={names}
        dict={en as unknown as Dict}
      />,
    );
    expect(html).not.toMatch(/split on difference</);
    expect(html).toContain(">Tied with Birch, Dogwood — split on goal difference</span>");
  });

  it("the partner decides before the rest of the table: a partner on the plain ledger reads plain", () => {
    // A football table where P's only result was a stage rule's scored
    // walkover (`for`/`against`/`diff` only) and E has played nothing: the
    // engine compared P's plain `diff` with E's absent one.
    const msg = (k: TKey) => t(en as unknown as Dict, k);
    const X = ledgerRow("football", "X");
    const P = { ...ledgerRow("football", "P"), metrics: { for: 0, against: 3, diff: -3 } };
    const E = { ...ledgerRow("football", "E"), metrics: {}, tieBreak: { key: "diff", with: ["P"] } };
    expect(tieBreakRule("diff", msg, E, [X, P, E])).toBe("difference");
    // …and with no partner that records anything, the table's first ledger.
    const lone = { ...E, tieBreak: { key: "diff", with: ["nobody"] } };
    expect(tieBreakRule("diff", msg, lone, [X, P, E])).toBe("goal difference");
  });
});

// The organiser console's cascade caption names `diff`/`for` before any tie
// exists, so it has no row to read: it takes the family from the module's
// declared ledger (`sportLedgerFamily`) and must say what the public tables say.
describe("the console caption's diff/for word (sportLedgerFamily)", () => {
  const RULES = ["diff", "for"] as const;

  it("football, hockey, ice hockey: goals; cricket (runs_for, no run difference): runs; generic and the ratio sports: plain", () => {
    const fam = (sport: string) => RULES.map((r) => sportLedgerFamily(moduleOf(sport).metrics, r));
    expect(fam("football")).toEqual(["goals", "goals"]);
    expect(fam("hockey")).toEqual(["goals", "goals"]);
    expect(fam("icehockey")).toEqual(["goals", "goals"]);
    expect(fam("cricket")).toEqual(["runs", "runs"]);
    expect(fam("generic")).toEqual(["plain", "plain"]);
    expect(fam("carrom")).toEqual(["plain", "plain"]);
  });

  it("every built-in sport: the module's family is the one a row folding its declared ledger reads", () => {
    const key = (k: TKey) => k;
    for (const sport of builtinModules) {
      const row: StandingsRow = {
        entrantId: "r",
        rank: 1,
        played: 1,
        won: 1,
        drawn: 0,
        lost: 0,
        points: 3,
        metrics: Object.fromEntries(sport.metrics.map((m) => [m.key, 0])),
      };
      for (const rule of RULES) {
        expect(LEDGER_RULE_MSG_KEYS[rule][sportLedgerFamily(sport.metrics, rule)], `${sport.key} ${rule}`).toBe(
          tieBreakRule(rule, key, row, [row]),
        );
      }
    }
  });

  it("the console's word IS the public tables' phrase, in every locale and family", () => {
    const UI = { en: enUi, es: esUi, fr: frUi, nl: nlUi } as unknown as Record<string, Dict>;
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const rule of RULES) {
        for (const family of ["goals", "runs", "plain"] as const) {
          expect(localizedTieBreakLabel(UI[locale]!, rule, family), `${locale} ${rule} ${family}`).toBe(
            t(dict, LEDGER_RULE_MSG_KEYS[rule][family]),
          );
        }
      }
    }
  });
});

// Fix round 1: `table.tieBreak.h2h_for` still read "goles/carreras …" /
// "buts/points …" / "doelpunten/runs …" in es/fr/nl after P6 retired the
// slashed catch-all everywhere else.
describe("no public tie-break phrase is a slashed catch-all", () => {
  it("every table.tieBreak.* phrase the tables print, in every locale", () => {
    const keys = [...Object.values(TIE_BREAK_MSG_KEYS), ...Object.values(LEDGER_RULE_MSG_KEYS).flatMap((f) => Object.values(f))];
    expect(keys, "premise: the sweep reaches h2h_for").toContain("table.tieBreak.h2h_for");
    const slashed = Object.entries(LOCALES).flatMap(([locale, dict]) =>
      keys.map((k) => [locale, k, t(dict, k)] as const).filter(([, , w]) => w.includes("/")),
    );
    expect(slashed.map(([l, k, w]) => `${l} ${k}: ${w}`)).toEqual([]);
  });
});
