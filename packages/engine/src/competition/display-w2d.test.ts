// W2d Task 17 — the public table's display (SPEC §5.7, §9 "public table"; D10(b)). Rule rows BG-PT-1, IH-PT-1 (the
// columns), X-TB-6, HK-TB-2 (the field-goals column; the ranking half is Task 14's) and ST-G29 (a column per new key).
// Every expected value is the rulebook's: FIDE 1 / ½ / 0 (RB2B-17), IIHF 3/2/1/0 with OT and GWS decisions in OTW/OTL
// (RBG §3.4, lines 343-344), BWF's games and points difference (16.2.3, 16.2.4), FIH's field goals (GTR App. 3). Rows
// come from the real producers — a sport's own `tablePointsRule`, `payout` and `completeTableStage` — never typed in.
import { describe, expect, it } from "vitest";
import { MatchOutcome, type StandingsDelta } from "../core/types.ts";
import type { AnySportModule, DecidedIn, TableStageKind } from "../sport/module.ts";
// single-sport: BG-PT-1 is chess's half-point row (FIDE 1 / ½ / 0, RB2B-17); the layout sweep below covers every sport
import { boardgame } from "../sports/boardgame/boardgame.ts";
// single-sport: IH-PT-1 is the IIHF columns row (RBG:343-344); the layout sweep below covers every sport
import { icehockey } from "../sports/icehockey/icehockey.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { tableRulesOf } from "../testkit/index.ts";
import {
  DERIVED_METRICS,
  LEVEL_RANK,
  PLAIN_LAYOUT,
  completeTableStage,
  derivedMetricText,
  fieldGoalsOf,
  foldResults,
  isLevelTable,
  ledgerDifference,
  payout,
  pointsText,
  pointsToText,
  rankStandings,
  rankText,
  reachableOutcomes,
  resultColumnText,
  tableLayoutOf,
  type FixtureResult,
  PointsRule,
  type StandingsRow,
  type TableFixture,
} from "./index.ts";

const TABLE_KINDS: readonly TableStageKind[] = ["league", "group", "swiss", "americano"];

const delta = (entrantId: string, won: number, drawn: number, lost: number, metrics: Record<string, number>): StandingsDelta => ({
  entrantId,
  played: 1,
  won,
  drawn,
  lost,
  points: 0,
  metrics,
});

/** One decided fixture paid by `rule`, as the table's caller pays it (`payout`): `home` beat `away` when `decidedIn` is
 *  set, a draw when it is null. Goals ride as the period kernel books them (gf/ga/gd). */
function played(id: string, home: string, away: string, score: readonly [number, number], decidedIn: DecidedIn | null, rule: PointsRule): TableFixture {
  const [hg, ag] = score;
  const goals = (f: number, a: number) => ({ gf: f, ga: a, gd: f - a });
  const draw = decidedIn === null;
  const winner = hg >= ag ? home : away;
  const pair: FixtureResult = [
    delta(home, !draw && winner === home ? 1 : 0, draw ? 1 : 0, !draw && winner === away ? 1 : 0, goals(hg, ag)),
    delta(away, !draw && winner === away ? 1 : 0, draw ? 1 : 0, !draw && winner === home ? 1 : 0, goals(ag, hg)),
  ];
  const outcome = draw
    ? MatchOutcome.parse({ kind: "draw" })
    : MatchOutcome.parse({ kind: "win", winner, loser: winner === home ? away : home });
  return { id, status: "decided", result: payout(outcome, decidedIn, pair, true, rule, undefined, undefined) };
}

const tableOf = (entrants: readonly string[], fixtures: readonly TableFixture[], rule: PointsRule): readonly StandingsRow[] =>
  completeTableStage({ id: "s", kind: "league", entrants, rules: tableRulesOf(["points", "lots"], rule) }, fixtures).tables.overall!;
const rowOf = (table: readonly StandingsRow[], id: string): StandingsRow => {
  const row = table.find((r) => r.entrantId === id);
  if (row === undefined) throw new Error(`premise: the table has a row for ${id}`);
  return row;
};
const cfgNamed = (module: AnySportModule, name: string): unknown => {
  const found = declaredCfgs(module).find((c) => c.name === name);
  if (found === undefined) throw new Error(`premise: ${module.key} declares a ${name} cfg`);
  return found.cfg;
};

describe("W2d T17 — the public table (SPEC §5.7, §9)", () => {
  it("BG-PT-1 chess 3 half-points print '1½' (D10(b), RB2B-17)", () => {
    const cfg = boardgame.configSchema.parse({});
    const rule = boardgame.tablePointsRule(cfg, "league");
    const layout = tableLayoutOf(rule, reachableOutcomes(boardgame, cfg, "league"));
    // A beats B, draws C, loses to D: FIDE 1 + ½ + 0 = 1½ — stored as 3 half-points.
    const table = tableOf(
      ["A", "B", "C", "D"],
      [played("g1", "A", "B", [1, 0], "regulation", rule), played("g2", "A", "C", [0, 0], null, rule), played("g3", "D", "A", [1, 0], "regulation", rule)],
      rule,
    );
    expect(rowOf(table, "A").points, "premise: the table stores half-points").toBe(3);
    const shown = Object.fromEntries(["A", "B", "C", "D"].map((id) => [id, resultColumnText(rowOf(table, id), "points", layout)]));
    expect(shown).toEqual({ A: "1½", B: "0", C: "½", D: "1" });
    // The 3/1/0 preset some opens use (RB2B-18) is whole points: the same three results print 3 + 1 + 0 = 4.
    const presets = boardgame.tablePresets?.("league").points ?? [];
    const threeOneZero = presets.find((p) => p.rule.unit === "whole");
    expect(threeOneZero, "premise: a round robin offers a whole-point preset").toBeDefined();
    const whole = tableOf(
      ["A", "B", "C", "D"],
      [played("g1", "A", "B", [1, 0], "regulation", threeOneZero!.rule), played("g2", "A", "C", [0, 0], null, threeOneZero!.rule), played("g3", "D", "A", [1, 0], "regulation", threeOneZero!.rule)],
      threeOneZero!.rule,
    );
    const wholeLayout = tableLayoutOf(threeOneZero!.rule, reachableOutcomes(boardgame, cfg, "league"));
    expect(resultColumnText(rowOf(whole, "A"), "points", wholeLayout)).toBe("4");
    // One spelling of a half-point score: the table's and the Swiss card's (`pointsToText`) agree on every score.
    let checked = 0;
    for (let half = 0; half <= 40; half++) {
      expect(pointsText(half, "half"), `${half} half-points`).toBe(pointsToText(half));
      checked++;
    }
    expect(checked).toBe(41);
    expect(pointsText(7, "whole")).toBe("7");
  });

  it("IH-PT-1 IIHF prints OTW/OTL as OT+SO sums; recreational prints GP W D L (RBG:343-344)", () => {
    const iihf = cfgNamed(icehockey, "iihf");
    const rule = icehockey.tablePointsRule(iihf as never, "league");
    const layout = tableLayoutOf(rule, reachableOutcomes(icehockey, iihf, "league"));
    expect(layout.apart, "OT and GWS decisions both land in OTW/OTL").toEqual(["ot", "so"]);
    // A: a regulation win, an OT win, a GWS win, an OT loss.
    const table = tableOf(
      ["A", "B", "C", "D", "E"],
      [
        played("g1", "A", "B", [4, 1], "regulation", rule),
        played("g2", "A", "C", [3, 2], "ot", rule),
        played("g3", "A", "D", [3, 2], "so", rule),
        played("g4", "E", "A", [2, 1], "ot", rule),
      ],
      rule,
    );
    const cols = ["played", "won", "otw", "otl", "lost", "points"] as const;
    const line = (id: string) => cols.map((k) => resultColumnText(rowOf(table, id), k, layout));
    // Points 3 / 2 / 1 / 0 (RBG §3.4): A 3 + 2 + 2 + 1 = 8.
    expect(line("A")).toEqual(["4", "1", "2", "1", "0", "8"]);
    expect(line("B")).toEqual(["1", "0", "0", "0", "1", "0"]);
    expect(line("C")).toEqual(["1", "0", "0", "1", "0", "1"]);
    expect(line("D")).toEqual(["1", "0", "0", "1", "0", "1"]);
    expect(line("E")).toEqual(["1", "0", "1", "0", "0", "2"]);
    // GP = W + OTW + OTL + L on every row: nothing is counted twice or dropped.
    for (const id of ["A", "B", "C", "D", "E"]) {
      const [gp, w, otw, otl, l] = line(id).map(Number);
      expect(w! + otw! + otl! + l!, id).toBe(gp);
    }
    // Recreational (product variant): no OT, draws stand, 2/1/0 — GP W D L, no OT columns.
    const rec = cfgNamed(icehockey, "recreational");
    const recRule = icehockey.tablePointsRule(rec as never, "league");
    const recLayout = tableLayoutOf(recRule, reachableOutcomes(icehockey, rec, "league"));
    expect(recLayout.apart).toEqual([]);
    const recTable = tableOf(["A", "B", "C"], [played("g1", "A", "B", [3, 1], "regulation", recRule), played("g2", "A", "C", [2, 2], null, recRule)], recRule);
    const recCols = ["played", "won", "drawn", "lost", "points"] as const;
    expect(recCols.map((k) => resultColumnText(rowOf(recTable, "A"), k, recLayout))).toEqual(["2", "1", "1", "0", "3"]);
  });

  it("every sport's table layout: OTW/OTL only for IIHF ice hockey (RBG §3.4), half-points only for chess (RB2B-17) — every declared cfg and table kind, counted", () => {
    let layouts = 0;
    let apart = 0;
    let halves = 0;
    const sports = forEachSport(({ module }) => {
      for (const { name, cfg } of declaredCfgs(module)) {
        for (const kind of TABLE_KINDS) {
          const layout = tableLayoutOf(module.tablePointsRule(cfg as never, kind), reachableOutcomes(module, cfg, kind));
          const iihf = module.key === "icehockey" && name !== "recreational";
          expect(layout.apart, `${module.key} ${name} ${kind}`).toEqual(iihf ? ["ot", "so"] : []);
          expect(layout.unit, `${module.key} ${name} ${kind}`).toBe(module.key === "boardgame" ? "half" : "whole");
          layouts++;
          if (layout.apart.length > 0) apart++;
          if (layout.unit === "half") halves++;
        }
      }
    });
    expect(sports).toBeGreaterThan(1);
    expect(layouts).toBeGreaterThan(sports);
    expect(apart, "anti-vacuity: the IIHF layouts").toBeGreaterThan(0);
    expect(halves, "anti-vacuity: the chess layouts").toBeGreaterThan(0);
  });

  it("a draw-plus-bonus shoot-out (booked a draw, B2) never reaches OTW: its win is a draw on the table; a split is a column only when reachable and paid, on either side", () => {
    // A league paying an OT decision 2/1 whose shoot-out is a draw plus a bonus (B2). The schema refuses a `so` payout
    // beside draw_plus_bonus, so the shoot-out's chain falls back to the OT split (`byChain`) — paid apart, and still
    // no column: the table books it a draw. Parsed, so the rule is one an organiser can actually store.
    const rule: PointsRule = PointsRule.parse({
      win: { regulation: 3, ot: 2 },
      loss: { regulation: 0, ot: 1 },
      draw: 1,
      soBonus: 1,
      shootoutAs: "draw_plus_bonus",
      unit: "whole",
    });
    const reach = new Set(["win.regulation", "loss.regulation", "win.ot", "loss.ot", "win.so", "loss.so", "draw"] as const);
    expect(tableLayoutOf(rule, reach).apart).toEqual(["ot"]);
    // Its pair, differing ONLY in the booking: the shoot-out booked as a result is a win on the table, paid 2/1 — apart.
    expect(tableLayoutOf(PointsRule.parse({ ...rule, soBonus: undefined, shootoutAs: "result" }), reach).apart).toEqual(["ot", "so"]);
    // The same split booked as a result pays the shoot-out apart, so it is counted apart.
    const asResult: PointsRule = { ...rule, soBonus: undefined, shootoutAs: "result", win: { regulation: 3, so: 2 }, loss: { regulation: 0, so: 1 } };
    expect(tableLayoutOf(asResult, reach).apart).toEqual(["so"]);
    // A decision that pays a regulation result is not a column (an OT win paying a win, D9).
    expect(tableLayoutOf({ ...asResult, win: { regulation: 3, so: 3 }, loss: { regulation: 0, so: 0 } }, reach).apart).toEqual([]);
    // Unreachable is never a column, however the rule pays it.
    expect(tableLayoutOf(asResult, new Set(["win.regulation", "loss.regulation"] as const)).apart).toEqual([]);
    // A split paid on the LOSER's side alone is still paid (two for any win, one for a loss beyond regulation): apart.
    const loserOnly = PointsRule.parse({ win: { regulation: 2 }, loss: { regulation: 0, ot: 1 }, shootoutAs: "result", unit: "whole" });
    expect(tableLayoutOf(loserOnly, reach).apart).toEqual(["ot", "so"]);
    // A set-score map pays by set score, never by decision (SC-S9; `payout` reads `bySetScore` before the OT chain): the
    // same OT split beside a map is never paid, so never a column — even where the stage can reach an OT decision.
    const bySets = PointsRule.parse({ win: { regulation: 3, ot: 2 }, loss: { regulation: 0, ot: 1 }, bySetScore: { "*": [3, 0] }, shootoutAs: "result", unit: "whole" });
    expect(tableLayoutOf(bySets, reach).apart).toEqual([]);
    const { bySetScore: _map, ...withoutMap } = bySets;
    expect(tableLayoutOf(withoutMap, reach).apart, "the pair: the same rule without its map pays the split").toEqual(["ot", "so"]);
  });

  it("a column per new key in the order: set_diff, point_diff, field_goals, SB (round robin), game ratio — only when the key is in the effective order (ST-G29)", () => {
    const order = DERIVED_METRICS.map((m) => m.key);
    const at = (k: string) => order.indexOf(k as never);
    for (const k of ["set_diff", "point_diff", "field_goals", "sberger", "game_ratio"]) expect(at(k), k).toBeGreaterThanOrEqual(0);
    expect(at("set_diff")).toBeLessThan(at("point_diff"));
    expect(at("point_diff")).toBeLessThan(at("field_goals"));
    expect(at("field_goals")).toBeLessThan(at("sberger"));
    expect(at("sberger")).toBeLessThan(at("game_ratio"));
    // BWF 16.2.3 / 16.2.4: games and points difference are won − lost over the ratio's own pair.
    const row = (metrics: Record<string, number>): StandingsRow => ({ entrantId: "X", played: 3, won: 2, drawn: 0, lost: 1, points: 0, metrics });
    const r = row({ sets_won: 4, sets_lost: 2, points_won: 150, points_lost: 160, games_won: 20, games_lost: 14 });
    expect(derivedMetricText(r, "set_diff")).toBe("2");
    expect(derivedMetricText(r, "point_diff")).toBe("-10");
    expect(derivedMetricText(r, "game_ratio")).toBe("1.43");
    // No ledger yet: a dash, never a zero the row did not earn (the comparator sorts it last, #429).
    expect(derivedMetricText(row({}), "set_diff")).toBe("—");
    expect(derivedMetricText(row({}), "point_diff")).toBe("—");
    expect(ledgerDifference(row({ sets_won: 3 }), "set_ratio")).toBe(3);
    expect(ledgerDifference(row({}), "set_ratio")).toBeUndefined();
    // FIH GTR App. 3: goals less penalty-corner and penalty-stroke goals (HK-TB-2's column).
    expect(derivedMetricText(row({ gf: 7, goals_pc: 2, goals_stroke: 1 }), "field_goals")).toBe("4");
    expect(derivedMetricText(row({ gf: 3 }), "field_goals")).toBe("3");
    expect(derivedMetricText(row({}), "field_goals")).toBe("—");
    expect(fieldGoalsOf(row({ gf: 7, goals_pc: 2, goals_stroke: 1 }))).toBe(4);
  });

  it("each new column prints the value its cascade step ranks on: higher text ranks higher, counted (one authority)", () => {
    const rows: StandingsRow[] = [
      { entrantId: "P", played: 2, won: 1, drawn: 0, lost: 1, points: 3, metrics: { sets_won: 3, sets_lost: 3, points_won: 120, points_lost: 100, gf: 5, goals_pc: 4 } },
      { entrantId: "Q", played: 2, won: 1, drawn: 0, lost: 1, points: 3, metrics: { sets_won: 3, sets_lost: 2, points_won: 100, points_lost: 130, gf: 3 } },
      { entrantId: "R", played: 2, won: 1, drawn: 0, lost: 1, points: 3, metrics: { sets_won: 1, sets_lost: 3, points_won: 110, points_lost: 105, gf: 4, goals_stroke: 2 } },
    ];
    let checked = 0;
    for (const key of ["set_diff", "point_diff", "field_goals"] as const) {
      const ranked = rankStandings(rows, { cascade: ["points", key, "lots"], rngSeed: 1 }).rows;
      const byRank = [...ranked].sort((a, b) => a.rank! - b.rank!);
      const values = byRank.map((r) => Number(derivedMetricText(r, key)));
      // premise: the three differ, so an order that ignored the value is seen
      expect(new Set(values).size, key).toBe(3);
      expect(values, key).toEqual([...values].sort((a, b) => b - a));
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("X-TB-6 an empty table is level: every rank prints '–' (the leader row and chips are the web tables' — standings-view-w2d)", () => {
    // empty case first: a stage with no counted fixture is level on every row (anti-goal 3)
    const cfg = icehockey.configSchema.parse({});
    const rule = icehockey.tablePointsRule(cfg, "league");
    const empty = tableOf(["A", "B", "C"], [{ id: "g1", status: "scheduled" }], rule);
    expect(empty.length).toBe(3);
    expect(isLevelTable(empty)).toBe(true);
    expect(empty.map((r) => rankText(r, true))).toEqual([LEVEL_RANK, LEVEL_RANK, LEVEL_RANK]);
    expect(LEVEL_RANK).toBe("–");
    // One result: nobody is level, every rank is the cascade's.
    const one = tableOf(["A", "B", "C"], [played("g1", "A", "B", [2, 0], "regulation", rule)], rule);
    expect(isLevelTable(one)).toBe(false);
    expect(one.every((r) => r.level !== true), "no row of a played table is level").toBe(true);
    expect(rankText(rowOf(one, "A"), isLevelTable(one))).toBe("1");
    for (const r of one) expect(rankText(r, false), r.entrantId).toMatch(/^[1-3]$/);
    // A void that re-levels it: the voided fixture no longer counts, the table is level again.
    const voided = tableOf(["A", "B", "C"], [{ ...played("g1", "A", "B", [2, 0], "regulation", rule), status: "void" }], rule);
    expect(isLevelTable(voided)).toBe(true);
    // The empty case of the predicate itself: no rows is no table, not a level one.
    expect(isLevelTable([])).toBe(false);
    // Another sport: chess's empty round robin is level too.
    const bg = boardgame.configSchema.parse({});
    const bgRule = boardgame.tablePointsRule(bg, "league");
    expect(isLevelTable(tableOf(["A", "B"], [], bgRule))).toBe(true);
  });
});

// W2d T17 MD-1 — the lines the per-task Stryker sweep found unwitnessed (task-17-stryker-report.md). Each expected value
// is the rule's or the spec's, never display.ts's: D9's split, RBG §3.4's columns, the half-point unit (D10(b)) and
// Jul3/05 §2 (fractional and negative points are legal).
describe("W2d T17 MD-1 — the public table's untested edges", () => {
  it("MD-1 every derived column has a header to print: a non-empty label, no two alike (spec §5.7: each new key needs a column and a label), counted", () => {
    // sport-agnostic: DERIVED_METRICS is the one list every sport's table reads its derived columns from
    let checked = 0;
    for (const m of DERIVED_METRICS) {
      expect(m.label.trim(), m.key).not.toBe("");
      checked++;
    }
    expect(checked, "anti-vacuity: the derived columns").toBe(DERIVED_METRICS.length);
    expect(checked).toBeGreaterThan(0);
    const labels = DERIVED_METRICS.map((m) => m.label);
    expect(new Set(labels).size, "two columns under one header cannot be told apart").toBe(labels.length);
  });

  it("MD-1 PLAIN_LAYOUT (a stage with no rules to read) is the plain table — W and L as folded, whole points (RBG §3.4 'Recreational: GP W D L'): the layout every whole-point table without a split computes, every sport, counted", () => {
    let plain = 0;
    const sports = forEachSport(({ module }) => {
      for (const { name, cfg } of declaredCfgs(module)) {
        for (const kind of TABLE_KINDS) {
          const layout = tableLayoutOf(module.tablePointsRule(cfg as never, kind), reachableOutcomes(module, cfg, kind));
          if (layout.apart.length > 0 || layout.unit !== "whole") continue;
          expect(layout, `${module.key} ${name} ${kind}`).toStrictEqual(PLAIN_LAYOUT);
          plain++;
        }
      }
    });
    expect(sports).toBeGreaterThan(1);
    expect(plain, "anti-vacuity: the plain layouts").toBeGreaterThan(sports);
    // What it prints, on IIHF results: nothing is counted apart — A's regulation, OT and GWS wins are all W, its OT loss an
    // L, and its points are IIHF's 3 + 2 + 2 + 1 = 8, whole.
    const iihf = cfgNamed(icehockey, "iihf");
    const rule = icehockey.tablePointsRule(iihf as never, "league");
    const table = tableOf(
      ["A", "B", "C", "D", "E"],
      [
        played("g1", "A", "B", [4, 1], "regulation", rule),
        played("g2", "A", "C", [3, 2], "ot", rule),
        played("g3", "A", "D", [3, 2], "so", rule),
        played("g4", "E", "A", [2, 1], "ot", rule),
      ],
      rule,
    );
    const cols = ["played", "won", "otw", "otl", "drawn", "lost", "points"] as const;
    expect(cols.map((k) => resultColumnText(rowOf(table, "A"), k, PLAIN_LAYOUT))).toEqual(["4", "3", "0", "0", "0", "1", "8"]);
  });

  it("MD-1 a half-point total that is negative or not a whole number of half-points (fractional and negative points are legal, Jul3/05 §2) prints its own value with its sign: the text reads back as stored ÷ 2 — every case counted, and through the fold", () => {
    // The half-point spelling read back: "1½" is 1.5, "½" 0.5, "-½" −0.5.
    const readBack = (text: string): number => Number(text.replace(/^(-?)½$/, (_m, sign: string) => `${sign}0.5`).replace(/½$/, ".5"));
    const stored = [...Array.from({ length: 19 }, (_, i) => i - 9), 0.5, 1.5, -0.5, -2.5, 3.25, -3.75, 7.5];
    let checked = 0;
    let negative = 0;
    let fractional = 0;
    for (const half of stored) {
      const text = pointsText(half, "half");
      expect(text, `${half} half-points`).not.toBe("");
      expect(readBack(text), `${half} half-points print ${text}`).toBe(half / 2);
      expect(text.startsWith("-"), `${half}: the sign is kept`).toBe(half < 0);
      // A whole number of half-points spells its half as "½" (FIDE 1 / ½ / 0); any other remainder is never a "½".
      expect(text.endsWith("½"), `${half}: ${text}`).toBe(Number.isInteger(half) && half % 2 !== 0);
      checked++;
      if (half < 0) negative++;
      if (!Number.isInteger(half)) fractional++;
    }
    expect(checked).toBe(stored.length);
    expect(negative, "anti-vacuity: negative totals").toBeGreaterThan(0);
    expect(fractional, "anti-vacuity: totals that are not a whole number of half-points").toBeGreaterThan(0);
    // single-sport: chess is the one half-point sport (the layout sweep above asserts it). Through the fold and `payout`:
    // a half-point rule paying 2.5 for a win (1.25 points), 1 for a draw (½) and −1 for a loss (a deduction, −½).
    const cfg = boardgame.configSchema.parse({});
    const rule = PointsRule.parse({ win: { regulation: 2.5 }, loss: { regulation: -1 }, draw: 1, shootoutAs: "result", unit: "half" });
    const layout = tableLayoutOf(rule, reachableOutcomes(boardgame, cfg, "league"));
    expect(layout.unit, "premise: the rule's own unit").toBe("half");
    // A beats B, then draws C: A 2.5 + 1 = 3.5 half-points (1.75); B −1 (−½); C 1 (½).
    const table = tableOf(["A", "B", "C"], [played("g1", "A", "B", [1, 0], "regulation", rule), played("g2", "A", "C", [0, 0], null, rule)], rule);
    expect(Object.fromEntries(["A", "B", "C"].map((id) => [id, resultColumnText(rowOf(table, id), "points", layout)]))).toEqual({ A: "1.75", B: "-½", C: "½" });
  });

  it("MD-1 a row the ranking pass left without a place prints no place on a played table (never 'undefined'), and '–' on a level one", () => {
    // sport-agnostic: the fold is every sport's; it writes no rank (StandingsRow: `rank` is the ranking pass's)
    const folded = foldResults(["A", "B"], []);
    expect(folded.length, "premise: a row per entrant").toBe(2);
    let checked = 0;
    for (const row of folded) {
      expect(row.rank, `premise: ${row.entrantId} has no place yet`).toBeUndefined();
      expect(rankText(row, false), row.entrantId).toBe("");
      expect(rankText(row, true), row.entrantId).toBe(LEVEL_RANK);
      checked++;
    }
    expect(checked).toBe(2);
    // The pair: a place prints as itself.
    expect(rankText({ rank: 2 }, false)).toBe("2");
  });

  it("MD-1 a split paid on the WINNER's side alone is a column too (D9: an OT win pays a win 'unless a split is set'): every point the table prints is accounted for by its columns", () => {
    // Three for a regulation win, two for an OT win, nothing for any loss: the split is on the winner's side only (the
    // loser-only case is the shoot-out test above). A loss beyond regulation falls back to the regulation loss (§5.3).
    const rule = PointsRule.parse({ win: { regulation: 3, ot: 2 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "whole" });
    const reach = new Set(["win.regulation", "loss.regulation", "win.ot", "loss.ot", "draw"] as const);
    const layout = tableLayoutOf(rule, reach);
    expect(layout.apart).toEqual(["ot"]);
    // A: a regulation win, an OT win, an OT loss — 3 + 2 + 0 = 5. Every row's points equal its columns paid by the rule.
    const table = tableOf(
      ["A", "B", "C", "D"],
      [played("g1", "A", "B", [2, 0], "regulation", rule), played("g2", "A", "C", [2, 1], "ot", rule), played("g3", "D", "A", [3, 2], "ot", rule)],
      rule,
    );
    const otWin = rule.win.ot ?? rule.win.regulation;
    const otLoss = rule.loss.ot ?? rule.loss.regulation;
    let checked = 0;
    for (const row of table) {
      const n = (k: "won" | "otw" | "otl" | "drawn" | "lost") => Number(resultColumnText(row, k, layout));
      const paid = n("won") * rule.win.regulation + n("otw") * otWin + n("otl") * otLoss + n("drawn") * rule.draw! + n("lost") * rule.loss.regulation;
      expect(Number(resultColumnText(row, "points", layout)), row.entrantId).toBe(paid);
      checked++;
    }
    expect(checked).toBe(4);
    expect(resultColumnText(rowOf(table, "A"), "points", layout)).toBe("5");
    expect((["won", "otw", "otl", "lost"] as const).map((k) => resultColumnText(rowOf(table, "A"), k, layout))).toEqual(["1", "1", "1", "0"]);
  });
});
