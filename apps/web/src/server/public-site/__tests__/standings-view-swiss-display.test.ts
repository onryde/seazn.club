// W3 app-B T3 (owner Q2, 2026-11-03) - the Swiss standings table's display, in the one shared layer every surface reads
// (`standings-view.ts`: the division page, the embed, the console, the hub, the slideshow, the exports and the OG image).
//
//   1. ONE number format. Buchholz, Buchholz Cut-1, Sonneborn-Berger and Opp diff print in the same spelling as the SAME
//      table's Points column (controller ruling): half-points as "1½" on a half-point table, plain numbers on a whole-point one.
//      Before: a row could read "1½" in one column and "1.5" in the next (SB), and "7½" beside a whole-point table's "7".
//   2. ONE wins column. A board-game Swiss printed W (the table's own) AND Wins (the module's metric of the same count).
//   3. A bye and a late join are marked: `rowMarkers`, and the hub document's `markers` (the two components' parity is
//      `components/public-site/__tests__/standings-swiss-parity.test.ts`).
//
// Expected values come from the rulebook (FIDE 1 / ½ / 0 in halves; UEFA art. 18 and FIDE C.07 arts. 8.1, 9.1 and 14 for the Swiss ladders), the
// engine's own declarations (`pointsText`, the sport's `standingsDelta`) and the dictionaries - never from the builder.
import { describe, expect, it } from "vitest";
import { DERIVED_METRICS, derivedMetricText, pointsText, tableLayoutOf, type StandingsRow } from "@seazn/engine/competition";
import type { AnySportModule, TableStageKind } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, forEachSport } from "@seazn/engine/testkit";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { unpinnedRulesDoc } from "@/server/engine-db/__tests__/helpers/table-rules-doc";
import { TableView } from "../competition-hub-schema";
import {
  buildTableView,
  cellText,
  derivedText,
  rowMarkers,
  tableColumns,
  tableLayoutFor,
  type TableViewInput,
} from "../standings-view";

const sport = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`premise: ${key} is a built-in sport`);
  return m;
};
// single-sport: chess is the half-point Swiss sport (FIDE 1 / ½ / 0); the unit spelling of EVERY sport is swept in the registry test below
const boardgame = sport("boardgame");
// single-sport: football is the whole-point Swiss sport whose chain holds opp_diff (FB-TB-5); the unit spelling of EVERY sport is swept in the registry test below
const football = sport("football");
const halfDoc = unpinnedRulesDoc({ module: boardgame, kind: "swiss", divisionConfig: boardgame.variants.classical });
const wholeDoc = unpinnedRulesDoc({ module: football, kind: "swiss", divisionConfig: {} });

const row = (entrantId: string, over: Partial<StandingsRow>): StandingsRow => ({
  entrantId,
  played: 0,
  won: 0,
  drawn: 0,
  lost: 0,
  points: 0,
  metrics: {},
  ...over,
});

const EN = en as unknown as Dict;
const echo: TableViewInput["msg"] = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : `${key}`);
const enMsg: TableViewInput["msg"] = (key, vars) => t(EN, key, vars);

const input = (doc: typeof halfDoc, m: AnySportModule, rows: StandingsRow[], over: Partial<TableViewInput> = {}): TableViewInput => ({
  id: "t",
  division: { id: "d1", slug: "div", name: "Div" },
  caption: "Swiss",
  fullHref: "/x",
  rows,
  metricSpecs: m.metrics,
  cascade: doc.tiebreakers,
  entrantNames: { A: "Ash", B: "Birch", C: "Cedar", D: "Dogwood", E: "Elm" },
  entrantLogos: {},
  entrantColours: {},
  championIds: [],
  updatedAt: "2026-11-03T10:00:00Z",
  msg: enMsg,
  rules: doc,
  dateOf: () => null,
  // the stage these tables are of: a Swiss (the one kind the owner's number format applies to - see the scope describe below)
  stageKind: "swiss",
  ...over,
});

/** A view's cells for entrant `id`, by column key. */
const cellsOf = (view: ReturnType<typeof buildTableView>, id: string): Record<string, string> => {
  const r = view.rows.find((x) => x.entrantId === id)!;
  return Object.fromEntries(view.columns.map((c, i) => [c.key, r.cells[i]!]));
};

describe("owner Q2.1 - one number format: the Swiss ladders print in the table's own points spelling", () => {
  // Chess: points are stored in HALVES (win 2, draw 1), so Ash's 3 is "1½"; the ladders are stored in WHOLE points
  // (rankStandings divides by the unit), so a Buchholz of 1.5 is "1½" too. The values are chosen so that every spelling
  // question is asked: a half (1.5), a whole (1), a quarter (0.75 - a Sonneborn-Berger drawn against 1½ points), and zero.
  const halfRows = [
    row("A", { rank: 1, played: 3, won: 1, drawn: 1, points: 3, metrics: { wins: 1, buchholz: 1.5, buchholz_cut1: 1, sberger: 1.5 } }),
    row("B", { rank: 2, played: 3, won: 0, drawn: 1, points: 1, metrics: { wins: 0, buchholz: 2, buchholz_cut1: 0.5, sberger: 0.75 } }),
    row("C", { rank: 3, played: 3, won: 0, drawn: 0, points: 0, metrics: { wins: 0, buchholz: 0, buchholz_cut1: 0, sberger: 0 } }),
  ];

  it("a half-point table prints the ladders as halves, like its Points column; a quarter has no half spelling and prints as a decimal", () => {
    const view = buildTableView(input(halfDoc, boardgame, halfRows));
    expect(view.columns.map((c) => c.key), "premise: the chess Swiss table has all three ladders").toEqual(
      expect.arrayContaining(["points", "buchholz", "buchholz_cut1", "sberger"]),
    );
    expect(cellsOf(view, "A")).toMatchObject({ points: "1½", buchholz: "1½", buchholz_cut1: "1", sberger: "1½" });
    expect(cellsOf(view, "B")).toMatchObject({ points: "½", buchholz: "2", buchholz_cut1: "½", sberger: "0.75" });
    expect(cellsOf(view, "C")).toMatchObject({ points: "0", buchholz: "0", buchholz_cut1: "0", sberger: "0" });
  });

  it("every ladder cell is spelled by the engine's own Points formatter for its table's unit (pointsText), cell by cell (counted)", () => {
    const scale = tableLayoutFor(halfDoc).unit === "half" ? 2 : 1;
    expect(scale, "premise: chess is a half-point table").toBe(2);
    const view = buildTableView(input(halfDoc, boardgame, halfRows));
    let checked = 0;
    for (const r of halfRows) {
      const cells = cellsOf(view, r.entrantId);
      for (const key of ["buchholz", "buchholz_cut1", "sberger"] as const) {
        expect(cells[key], `${r.entrantId} ${key}`).toBe(pointsText(r.metrics[key]! * scale, "half"));
        checked++;
      }
    }
    expect(checked).toBe(9);
  });

  it("a whole-point table prints the ladders as plain numbers, like its Points column (no 'half' glyph, whole numbers stay whole)", () => {
    expect(tableLayoutFor(wholeDoc).unit, "premise: football scores in whole points").toBe("whole");
    const rows = [
      row("A", { rank: 1, played: 3, won: 2, drawn: 1, points: 7, metrics: { gf: 5, ga: 1, gd: 4, buchholz: 7.5, buchholz_cut1: 5, sberger: 2.5, opp_diff: -3 } }),
      row("B", { rank: 2, played: 3, won: 0, drawn: 0, lost: 3, points: 0, metrics: { gf: 1, ga: 5, gd: -4, buchholz: 7, buchholz_cut1: 4, sberger: 0, opp_diff: 12 } }),
    ];
    // The stage's order is the caller's: football's own Swiss chain (FB-TB-5) ranks on opp_diff, and a division may add the
    // Buchholz family beside it - this table's order holds all four so every ladder is a column.
    const cascade = [...new Set([...wholeDoc.tiebreakers, "buchholz", "buchholz_cut1", "sberger", "opp_diff"])];
    const view = buildTableView(input(wholeDoc, football, rows, { cascade }));
    expect(view.columns.map((c) => c.key), "premise: the table has every ladder and opp_diff").toEqual(
      expect.arrayContaining(["points", "buchholz", "buchholz_cut1", "sberger", "opp_diff"]),
    );
    expect(cellsOf(view, "A")).toMatchObject({ points: "7", buchholz: "7.5", buchholz_cut1: "5", sberger: "2.5", opp_diff: "-3" });
    expect(cellsOf(view, "B")).toMatchObject({ points: "0", buchholz: "7", buchholz_cut1: "4", sberger: "0", opp_diff: "12" });
    for (const cell of view.rows.flatMap((r) => r.cells)) expect(cell, "no half glyph on a whole-point table").not.toContain("½");
  });

  it("every sport's Swiss table spells each ladder in ITS unit - '7½' on a half-point table, '7.5' on a whole-point one - and Opp diff as the integer it is (registry sweep, every declared cfg, counted)", () => {
    const units = new Set<string>();
    let stages = 0;
    let cells = 0;
    const visited = forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m)) {
        const doc = unpinnedRulesDoc({ module: m, kind: "swiss", divisionConfig: cfg });
        // the unit is the ENGINE's declaration for the stage's points rule (the function the builder itself defers to), never the
        // builder's own reading of it; the stored ladders are whole points, so 7.5 is fifteen halves on a half-point table
        const unit = tableLayoutOf(doc.points, doc.reachable, doc.ballsPerOver).unit;
        units.add(unit);
        const want = unit === "half" ? "7½" : "7.5";
        const cascade = [...new Set([...doc.tiebreakers, "buchholz", "buchholz_cut1", "sberger", "opp_diff"])];
        const r = row("A", { rank: 1, played: 3, metrics: { buchholz: 7.5, buchholz_cut1: 7.5, sberger: 7.5, opp_diff: -3 } });
        const shown = cellsOf(buildTableView(input(doc, m, [r], { cascade })), "A");
        for (const key of ["buchholz", "buchholz_cut1", "sberger"] as const) {
          expect(shown[key], `${m.key} ${name} (${unit}) ${key}`).toBe(want);
          cells++;
        }
        expect(shown.opp_diff, `${m.key} ${name}: Opp diff has no unit and is never halved`).toBe("-3");
        cells++;
        stages++;
      }
    });
    expect(visited, "sports swept").toBe(builtinModules.length);
    expect(stages, "(sport, cfg) Swiss stages swept: more than one per sport").toBeGreaterThan(builtinModules.length);
    expect(cells, "cells compared").toBe(stages * 4);
    // anti-vacuity: the sweep met BOTH spellings, so '7½' was asked of a half-point table and '7.5' of a whole-point one
    expect([...units].sort()).toEqual(["half", "whole"]);
  });

  it("opp_diff is a difference of scores, never halved: a half-point layout still prints it as the integer it is", () => {
    // Not a reachable table (chess records no goal difference) - the formatter's own contract: a sum of differences has no unit.
    const r = row("A", { metrics: { opp_diff: 6 } });
    expect(derivedText(r, "opp_diff", tableLayoutFor(halfDoc, "swiss"))).toBe("6");
    expect(derivedText(r, "opp_diff", tableLayoutFor(wholeDoc, "swiss"))).toBe("6");
    expect(derivedText(row("A", { metrics: {} }), "opp_diff", tableLayoutFor(wholeDoc, "swiss")), "no value is a dash").toBe("—");
  });

  it("the ladders still print a dash for a row with none (Elm has not played), and every other derived column is the engine's text", () => {
    const rows = [...halfRows, row("E", { played: 0, metrics: {} })];
    const view = buildTableView(input(halfDoc, boardgame, rows));
    expect(cellsOf(view, "E")).toMatchObject({ buchholz: "—", buchholz_cut1: "—", sberger: "—" });
    // a derived column that is not a Swiss ladder keeps the engine's own text: net run rate is signed, to three places
    // single-sport: net run rate is cricket's own column (only cricket declares the runs ledger it reads), hand-derived from ECB 16.9.4(a)
    const cricket = sport("cricket");
    const nrr = derivedText(
      row("A", { metrics: { runs_for: 120, runs_against: 100, balls_faced_eff: 120, balls_bowled_eff: 120 } }),
      "nrr",
      tableLayoutFor(unpinnedRulesDoc({ module: cricket, kind: "league", divisionConfig: declaredCfgs(cricket)[0]!.cfg })),
    );
    // 6 balls x 120 runs / 120 balls = 6.000 per over for, 6 x 100 / 120 = 5.000 against (ECB 16.9.4(a)): +1.000
    expect(nrr).toBe("+1.000");
  });

  it("the table's cell expression and the hub's view agree on every derived column of every sport (the one function, registry sweep, counted)", () => {
    let cells = 0;
    const visited = forEachSport(({ module: m }) => {
      const doc = unpinnedRulesDoc({ module: m, kind: "league", divisionConfig: declaredCfgs(m)[0]!.cfg });
      const layout = tableLayoutFor(doc);
      const rows = [row("A", { rank: 1, played: 1, won: 1, points: 3, metrics: Object.fromEntries([...m.metrics.map((x) => x.key), ...DERIVED_METRICS.map((d) => d.key)].map((k, i) => [k, 2 + i / 2])) })];
      const columns = tableColumns(m.metrics, DERIVED_METRICS.map((d) => d.key), rows, layout);
      const view = buildTableView(input(doc, m, rows, { cascade: DERIVED_METRICS.map((d) => d.key), stageKind: "league" }));
      expect(view.columns.map((c) => c.key), m.key).toEqual(columns.map((c) => c.key));
      columns.forEach((c, i) => {
        expect(view.rows[0]!.cells[i], `${m.key} ${c.key}`).toBe(cellText(rows[0]!, c, layout));
        cells++;
      });
    });
    expect(visited, "sports swept").toBeGreaterThan(5);
    expect(cells, "cells compared").toBeGreaterThan(50);
  });
});

describe("owner Q2.2 - one wins column: the board-game Swiss no longer prints W and Wins side by side", () => {
  const rows = [row("A", { rank: 1, played: 2, won: 2, points: 4, metrics: { wins: 2, buchholz: 2 } })];
  const cascade = ["points", "buchholz", "lots"];

  it("the chess table keeps the table's own W (the column the cascade's wins step ranks on) and drops the module's duplicate", () => {
    const columns = tableColumns(boardgame.metrics, cascade, rows, tableLayoutFor(halfDoc));
    const keys = columns.map((c) => c.key);
    expect(keys, "premise: chess declares a visible wins metric, and the rows carry it").toContain("won");
    expect(boardgame.metrics.some((m) => m.key === "wins" && m.display !== false)).toBe(true);
    expect(rows[0]!.metrics.wins, "premise: the rows carry the wins metric").toBe(2);
    expect(keys.filter((k) => k === "won")).toHaveLength(1);
    expect(keys).not.toContain("wins");
    expect(buildTableView(input(halfDoc, boardgame, rows, { cascade })).columns.map((c) => c.key)).not.toContain("wins");
  });

  it("the dropped column carried no information: every outcome the sport pays credits `wins` exactly as it credits `won` (the engine's own standingsDelta)", () => {
    const cfg = boardgame.configSchema.parse({});
    const ctx = { roundNo: 1 } as never;
    const entrants = { home: { entrantId: "H", slots: [] }, away: { entrantId: "V", slots: [] } };
    const state = boardgame.init(cfg, entrants);
    const outcomes = [
      { kind: "win", winner: "H", loser: "V" },
      { kind: "win", winner: "V", loser: "H" },
      { kind: "draw" },
      { kind: "award", winner: "H", loser: "V", reason: "forfeit" },
      { kind: "award", winner: "V", loser: null, reason: "bye" },
    ] as const;
    let checked = 0;
    for (const o of outcomes) {
      for (const delta of boardgame.standingsDelta(o as never, cfg, ctx, state)) {
        expect(delta.metrics.wins ?? 0, `${o.kind}/${"winner" in o ? o.winner : ""} ${delta.entrantId}`).toBe(delta.won);
        checked++;
      }
    }
    expect(checked, "deltas compared").toBe(outcomes.length * 2);
  });

  it("no other sport loses a column: only a metric that repeats a structural column is dropped (registry sweep, counted)", () => {
    let dropped = 0;
    let kept = 0;
    forEachSport(({ module: m }) => {
      const doc = unpinnedRulesDoc({ module: m, kind: "league", divisionConfig: declaredCfgs(m)[0]!.cfg });
      const layout = tableLayoutFor(doc);
      const everything = [row("A", { rank: 1, metrics: Object.fromEntries(m.metrics.map((x) => [x.key, 1])) })];
      const shown = tableColumns(m.metrics, [], everything, layout).map((c) => c.key);
      for (const spec of m.metrics) {
        if (spec.display === false) continue;
        if (shown.includes(spec.key)) kept++;
        else {
          expect(spec.key, `${m.key}: only the wins metric repeats W`).toBe("wins");
          dropped++;
        }
      }
    });
    expect(dropped, "the board-game wins metric is the one repeat").toBe(1);
    expect(kept, "every other visible metric stays").toBeGreaterThan(10);
  });
});

describe("owner Q2.3 - the bye and late-join words (rowMarkers)", () => {
  it("empty case first: a row with no facts has no markers", () => {
    expect(rowMarkers(undefined, echo)).toEqual([]);
    expect(rowMarkers({ byeRounds: [], joinedRound: null }, echo)).toEqual([]);
  });

  it("a bye names its round(s) and a late join the round she joined and the rounds that count as unplayed; late first, then bye", () => {
    expect(rowMarkers({ byeRounds: [3], joinedRound: null }, echo)).toEqual([
      { kind: "bye", text: 'table.marker.bye:{"rounds":"3"}', title: 'table.marker.byeTitle:{"rounds":"3"}' },
    ]);
    expect(rowMarkers({ byeRounds: [], joinedRound: 3 }, echo)).toEqual([
      { kind: "late", text: 'table.marker.late:{"round":3}', title: 'table.marker.lateTitle:{"round":3,"missed":"1–2"}' },
    ]);
    expect(rowMarkers({ byeRounds: [], joinedRound: 2 }, echo)[0]!.title, "one missed round is '1', not '1–1'").toBe('table.marker.lateTitle:{"round":2,"missed":"1"}');
    expect(rowMarkers({ byeRounds: [2, 5], joinedRound: 2 }, echo).map((m) => m.kind)).toEqual(["late", "bye"]);
    expect(rowMarkers({ byeRounds: [2, 5], joinedRound: null }, echo)[0]!.text).toBe('table.marker.bye:{"rounds":"2/5"}');
  });

  it("English reads as a sentence a spectator understands", () => {
    const [late, bye] = rowMarkers({ byeRounds: [3], joinedRound: 3 }, enMsg);
    expect(late).toEqual({ kind: "late", text: "From R3", title: "Joined in round 3. Earlier rounds (1–2) count as unplayed." });
    expect(bye).toEqual({ kind: "bye", text: "Bye R3", title: "Bye in round 3: no opponent that round." });
  });

  it("every marker word is authored in all four locales, keeps its placeholders, and no locale pastes the English", () => {
    // "bye" is the Dutch word too (the Swiss refusal copy says "Een bye wordt niet gespeeld"): the one pair equal to English by design.
    const identicalByDesign: Readonly<Record<string, readonly string[]>> = { "table.marker.bye": ["nl"] };
    const keys = { "table.marker.bye": ["rounds"], "table.marker.byeTitle": ["rounds"], "table.marker.late": ["round"], "table.marker.lateTitle": ["round", "missed"] } as const;
    const dicts = { en, es, fr, nl } as Record<string, Record<string, string>>;
    let checked = 0;
    for (const [key, vars] of Object.entries(keys)) {
      for (const [locale, dict] of Object.entries(dicts)) {
        expect(Object.hasOwn(dict, key), `${locale} ${key}`).toBe(true);
        for (const v of vars) expect(dict[key], `${locale} ${key} keeps {${v}}`).toContain(`{${v}}`);
        if (locale !== "en") expect(dict[key] === dicts.en![key], `${locale} ${key} vs the English`).toBe(identicalByDesign[key]?.includes(locale) ?? false);
        checked++;
      }
    }
    expect(checked).toBe(16);
  });

  it("buildTableView carries markers on the marked rows only, in the document's schema, and a table with none is the table it was", () => {
    const rows = ["A", "B", "C"].map((id, i) => row(id, { rank: i + 1 }));
    const marked = buildTableView(input(halfDoc, boardgame, rows, { swissFacts: { B: { byeRounds: [3], joinedRound: null }, C: { byeRounds: [], joinedRound: 3 } } }));
    expect(marked.rows.map((r) => [r.entrantId, (r.markers ?? []).map((m) => m.kind)])).toEqual([["A", []], ["B", ["bye"]], ["C", ["late"]]]);
    expect(TableView.safeParse(marked).success, "the document parses").toBe(true);
    // no facts, or facts that mark nobody: the key is not there at all (a cached document and a plain table are one shape)
    for (const swissFacts of [undefined, {}] as const) {
      const plain = buildTableView(input(halfDoc, boardgame, rows, { swissFacts }));
      for (const r of plain.rows) expect(Object.hasOwn(r, "markers"), `${r.entrantId} ${JSON.stringify(swissFacts)}`).toBe(false);
    }
  });
});

// Controller ruling (review m1, 2026-11-03): the owner's number format is about the SWISS table. A round-robin or groups table has
// the same columns, but its Sonneborn-Berger is a different measure (the pool ledger's game points / 4, `tiebreakers.js` in the
// engine) and re-spelling it is a separate, parked follow-up - so every other stage kind keeps the engine's own text.
describe("owner Q2 scope - only a Swiss stage's ladders are re-spelled; every other table kind prints the engine's text", () => {
  // Typed over the engine's own kind list: a new table kind is a compile error here until it is decided.
  const IS_SWISS: Record<TableStageKind, boolean> = { league: false, group: false, americano: false, swiss: true };
  const kinds = Object.keys(IS_SWISS) as TableStageKind[];

  it("empty case first: the sweep covers every table kind, exactly one of them Swiss", () => {
    expect(kinds.length).toBeGreaterThan(1);
    expect(kinds.filter((k) => IS_SWISS[k])).toEqual(["swiss"]);
  });

  it("a half-point table (chess): every kind but Swiss prints the engine's text (SB 3.5 stays '3.5'); Swiss spells it '3½' (counted)", () => {
    const r = row("A", { rank: 1, played: 3, metrics: { buchholz: 2.5, buchholz_cut1: 1.5, sberger: 3.5 } });
    let checked = 0;
    for (const kind of kinds) {
      const layout = tableLayoutFor(halfDoc, kind);
      for (const key of ["buchholz", "buchholz_cut1", "sberger"] as const) {
        const engine = derivedMetricText(r, key);
        const swiss = pointsText(r.metrics[key]! * 2, "half");
        expect(derivedText(r, key, layout), `${kind} ${key}`).toBe(IS_SWISS[kind] ? swiss : engine);
        checked++;
      }
    }
    expect(checked, "cells checked").toBe(kinds.length * 3);
    // the witness: the two spellings are different strings for the value the owner's table prints
    expect(derivedMetricText(r, "sberger")).toBe("3.5");
    expect(pointsText(7, "half")).toBe("3½");
    expect(derivedText(r, "sberger", tableLayoutFor(halfDoc, "league")), "a round-robin SB").toBe("3.5");
    expect(derivedText(r, "sberger", tableLayoutFor(halfDoc, "swiss")), "a Swiss SB").toBe("3½");
  });

  it("a whole-point table (football): a Buchholz of 7.5 is the engine's '7½' off Swiss and the plain '7.5' on it", () => {
    const r = row("A", { rank: 1, played: 3, metrics: { buchholz: 7.5, buchholz_cut1: 5, sberger: 2.5, opp_diff: -3 } });
    for (const kind of kinds) {
      const layout = tableLayoutFor(wholeDoc, kind);
      for (const key of ["buchholz", "buchholz_cut1", "sberger", "opp_diff"] as const) {
        expect(derivedText(r, key, layout), `${kind} ${key}`).toBe(IS_SWISS[kind] ? pointsText(r.metrics[key]!, "whole") : derivedMetricText(r, key));
      }
    }
    expect(derivedText(r, "buchholz", tableLayoutFor(wholeDoc, "league"))).toBe("7½");
    expect(derivedText(r, "buchholz", tableLayoutFor(wholeDoc, "swiss"))).toBe("7.5");
  });

  it("no kind given (a hand-built or cached caller) is not Swiss: the engine's text, as before this task", () => {
    const r = row("A", { metrics: { sberger: 3.5 } });
    expect(derivedText(r, "sberger", tableLayoutFor(halfDoc))).toBe("3.5");
    expect(derivedText(r, "sberger", tableLayoutFor(null, "swiss")), "a Swiss whose rules the loader refused spells in whole points (the plain layout)").toBe("3.5");
  });

  it("the hub's view applies the same scope: one chess table, three kinds, only the Swiss one re-spells (through buildTableView)", () => {
    const rows = [row("A", { rank: 1, played: 3, won: 1, points: 3, metrics: { wins: 1, buchholz: 2.5, buchholz_cut1: 1.5, sberger: 3.5 } })];
    const cellOf = (kind: string | undefined) =>
      cellsOf(buildTableView(input(halfDoc, boardgame, rows, kind === undefined ? { stageKind: undefined } : { stageKind: kind })), "A");
    expect(cellOf("swiss")).toMatchObject({ buchholz: "2½", buchholz_cut1: "1½", sberger: "3½" });
    for (const kind of ["league", "group", undefined]) {
      expect(cellOf(kind), `kind ${kind}`).toMatchObject({ buchholz: derivedMetricText(rows[0]!, "buchholz"), sberger: "3.5" });
    }
  });
});
