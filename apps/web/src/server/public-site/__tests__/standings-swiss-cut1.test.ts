// W3 app-B T3, carry n1 from the Task 1 re-review: "Buchholz Cut-1 'drop the lowest' is unwitnessed - the lowest opponent
// scored 0". When the dropped opponent scored 0 the cut and "no cut" print the same number, so a Cut-1 that dropped NOTHING
// (or dropped the wrong end) passed every rig. This rig gives the witness: a Swiss table whose entrant A met an opponent who
// scored a NON-ZERO lowest score, so that Cut-1 differs from the plain Buchholz AND from a cut of the highest.
//
// The expected numbers are hand-derived from FIDE C.07 (in force from 1 March 2026), never read from the code under test: the
// Buchholz of a player is the sum of her opponents' final scores (art. 8.1); the Cut-1 variant leaves out the opponent with the
// LOWEST score (the Cut-1 modifier, art. 14); and a played game needs no dummy opponent (art. 16.4's dummy only stands in for an
// UNPLAYED round - there is none here, nobody is absent: the premise below pins it). Clause numbers are the W3 rulebook's
// (`rulebook-W3-swiss.md`, source A4); art. 16 is not where Buchholz or Cut-1 are defined.
//
//   six players A..F, three rounds, chess scoring (win 1, draw 1/2, loss 0):
//     R1  A 1-0 B    C 1/2 D    E 1-0 F
//     R2  A 1-0 C    E 1-0 B    D 1-0 F
//     R3  A 1/2 E    B 1-0 D    C 1-0 F
//   final scores   A 2.5   B 1   C 1.5   D 1.5   E 2.5   F 0
//   A met B (1), C (1.5), E (2.5):
//     Buchholz           1 + 1.5 + 2.5   = 5
//     Cut-1 (drop B=1)   1.5 + 2.5       = 4       <- the witness: B, the lowest, scored 1 (not 0)
//     cut the HIGHEST    1 + 1.5         = 2.5     (the wrong end)
//   the rest of the table, by the same arithmetic:
//     B met A 2.5, E 2.5, D 1.5  -> Buchholz 6.5, Cut-1 6.5 - 1.5 = 5
//     C met D 1.5, A 2.5, F 0    -> Buchholz 4,   Cut-1 4 - 0     = 4     (this one cannot tell a cut: F scored 0)
//     D met C 1.5, F 0, B 1      -> Buchholz 2.5, Cut-1 2.5 - 0   = 2.5   (nor this one)
//     E met F 0, B 1, A 2.5      -> Buchholz 3.5, Cut-1 3.5 - 0   = 3.5   (nor this one)
//     F met E 2.5, D 1.5, C 1.5  -> Buchholz 5.5, Cut-1 5.5 - 1.5 = 4
//
// The table is ranked by the engine's own `completeTableStage` and printed through the shared layer's `buildTableView`, so the
// number checked is the one a visitor reads in the Cut-1 column, in its table's Points spelling (owner Q2).
// (`swiss-art16-producer.test.ts` sweeps the DB-backed producer; this file pins the arithmetic once, at the display seam.)
import { describe, expect, it } from "vitest";
import { MatchOutcome, type StandingsDelta } from "@seazn/engine/core";
import {
  completeTableStage,
  payout,
  swissDrawFactsOf,
  type FixtureResult,
  type StandingsRow,
  type TableFixture,
  type TableStage,
} from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import type { TiebreakerKey } from "@seazn/engine/sport";
import { tableRulesOf } from "@seazn/engine/testkit";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { unpinnedRulesDoc } from "@/server/engine-db/__tests__/helpers/table-rules-doc";
import { swissAbsentRounds } from "@/server/engine-db/swiss-absent-rounds";
import { buildTableView, type TableViewInput } from "../standings-view";

const EN = en as unknown as Dict;
const msg: TableViewInput["msg"] = (key, vars) => t(EN, key, vars);
// single-sport: the rig is FIDE C.07's own arithmetic (win 1, draw 1/2, loss 0 and a hand-derived table), which only chess plays
const bg = builtinModules.find((m) => m.key === "boardgame")!;
const cfg = bg.variants.classical;
const doc = unpinnedRulesDoc({ module: bg, kind: "swiss", divisionConfig: cfg });
// The Buchholz family must be ON the stage's order, or the engine computes none of it: pin the premise, then rank by the
// stage's own order.
const CASCADE: TiebreakerKey[] = [...new Set<TiebreakerKey>([...doc.tiebreakers, "buchholz", "buchholz_cut1"])];

type Result = "home" | "away" | "draw";
const games: { round: number; home: string; away: string; result: Result }[] = [
  { round: 1, home: "A", away: "B", result: "home" },
  { round: 1, home: "C", away: "D", result: "draw" },
  { round: 1, home: "E", away: "F", result: "home" },
  { round: 2, home: "A", away: "C", result: "home" },
  { round: 2, home: "E", away: "B", result: "home" },
  { round: 2, home: "D", away: "F", result: "home" },
  { round: 3, home: "A", away: "E", result: "draw" },
  { round: 3, home: "B", away: "D", result: "home" },
  { round: 3, home: "C", away: "F", result: "home" },
];

const delta = (entrantId: string, won: number, drawn: number, lost: number): StandingsDelta => ({
  entrantId,
  played: 1,
  won,
  drawn,
  lost,
  points: 0,
  metrics: { wins: won },
});
function fixtureOf(g: (typeof games)[number], i: number): TableFixture {
  const draw = g.result === "draw";
  const winner = g.result === "home" ? g.home : g.away;
  const loser = winner === g.home ? g.away : g.home;
  const pair: FixtureResult = [
    delta(g.home, !draw && winner === g.home ? 1 : 0, draw ? 1 : 0, !draw && winner === g.away ? 1 : 0),
    delta(g.away, !draw && winner === g.away ? 1 : 0, draw ? 1 : 0, !draw && winner === g.home ? 1 : 0),
  ];
  const outcome = draw ? MatchOutcome.parse({ kind: "draw" }) : MatchOutcome.parse({ kind: "win", winner, loser });
  return { id: `g${i}`, roundNo: g.round, status: "decided", unplayed: null, result: payout(outcome, draw ? null : "regulation", pair, true, doc.points, undefined, undefined) };
}

const entrants = ["A", "B", "C", "D", "E", "F"];
// the DB's rows for the same games, so the absent-rounds producer reads what production reads
const dbFixtures = games.map((g, i) => ({
  round_no: g.round,
  ext_key: `sw-r${g.round}-b${(i % 3) + 1}`,
  home_entrant_id: g.home,
  away_entrant_id: g.away,
  outcome: g.result === "draw" ? { kind: "draw" } : { kind: "win", winner: g.result === "home" ? g.home : g.away, loser: g.result === "home" ? g.away : g.home },
}));
const absent = swissAbsentRounds(dbFixtures, entrants);
const stage: TableStage = {
  id: "swiss-cut1",
  kind: "swiss",
  entrants,
  rules: tableRulesOf(CASCADE, doc.points),
  swiss: true,
  swissDraw: swissDrawFactsOf(bg, cfg),
  swissAbsentRounds: absent,
  rounds: 3,
} as TableStage;
const rows: StandingsRow[] = [...completeTableStage(stage, games.map(fixtureOf)).tables.overall!];

const view = buildTableView({
  id: "t",
  division: { id: "d1", slug: "div", name: "Div" },
  caption: "Swiss",
  fullHref: "/x",
  rows,
  metricSpecs: bg.metrics,
  cascade: CASCADE,
  entrantNames: Object.fromEntries(entrants.map((e) => [e, `Player ${e}`])),
  entrantLogos: {},
  entrantColours: {},
  championIds: [],
  updatedAt: "2026-11-03T10:00:00Z",
  msg,
  rules: doc,
  dateOf: () => null,
});
const cell = (id: string, key: string) => {
  const col = view.columns.findIndex((c) => c.key === key);
  expect(col, `the table has a ${key} column`).toBeGreaterThanOrEqual(0);
  return view.rows.find((r) => r.entrantId === id)!.cells[col];
};

describe("Buchholz Cut-1 drops the LOWEST opponent score, witnessed with a non-zero lowest (n1, FIDE C.07 (2026) arts. 8.1 and 14)", () => {
  it("premise: nobody is absent from a round, the stage's order carries the Buchholz family, all six are on the table", () => {
    expect(absent.size, "no absent rounds: every opponent was met over the board").toBe(0);
    expect(CASCADE).toEqual(expect.arrayContaining(["buchholz", "buchholz_cut1"]));
    expect(rows).toHaveLength(6);
    expect(view.rows).toHaveLength(6);
  });

  it("A's Cut-1 is 4: the lowest opponent B (1) is left out - not nothing (5), not the highest (2.5)", () => {
    const WANT = { buchholz: 5, cut1: 4, cutHighest: 2.5 };
    // the witness only means something if the three readings DIFFER (the old rig's 0-lowest made two of them equal)
    expect(new Set([WANT.buchholz, WANT.cut1, WANT.cutHighest]).size, "three distinct readings").toBe(3);
    const a = rows.find((r) => r.entrantId === "A")!;
    expect(a.metrics.buchholz, "A's Buchholz on the engine's own row").toBe(WANT.buchholz);
    expect(a.metrics.buchholz_cut1, "A's Cut-1 on the engine's own row").toBe(WANT.cut1);
    expect(cell("A", "buchholz"), "the Buchholz cell").toBe("5");
    expect(cell("A", "buchholz_cut1"), "the Cut-1 cell").toBe("4");
  });

  it("the whole table's Buchholz and Cut-1, hand-derived (six rows checked): the cut differs from the plain sum exactly where the lowest opponent scored", () => {
    const WANT: Record<string, { buchholz: number; cut1: number }> = {
      A: { buchholz: 5, cut1: 4 },
      B: { buchholz: 6.5, cut1: 5 },
      C: { buchholz: 4, cut1: 4 },
      D: { buchholz: 2.5, cut1: 2.5 },
      E: { buchholz: 3.5, cut1: 3.5 },
      F: { buchholz: 5.5, cut1: 4 },
    };
    let checked = 0;
    for (const [id, want] of Object.entries(WANT)) {
      const row = rows.find((r) => r.entrantId === id)!;
      expect(row.metrics.buchholz, `${id} Buchholz`).toBe(want.buchholz);
      expect(row.metrics.buchholz_cut1, `${id} Cut-1`).toBe(want.cut1);
      checked++;
    }
    expect(checked, "rows checked").toBe(6);
    // A, B and F have a non-zero lowest opponent, so their cut shows; C, D and E met a 0-scorer, so theirs cannot.
    const showsCut = Object.entries(WANT).filter(([, w]) => w.cut1 !== w.buchholz).map(([id]) => id);
    expect(showsCut).toEqual(["A", "B", "F"]);
  });
});
