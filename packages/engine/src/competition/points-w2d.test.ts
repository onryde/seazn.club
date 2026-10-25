// W2d Task 2 — the outcome-keyed PointsRule, `payout`, reachable outcomes and coverage (SPEC §5.3, D4, D6, D9, D10(a)(c),
// B1, B2, F11). Rule rows X-PT-2, X-PT-3, X-PT-4, X-WO-1 (amended), X-DW-4, FB-PT-1, VB-PT-2, VB-PT-3, CK-PT-1, CK-PT-2,
// TT-PT-1, IH-PT-1. Every rule below is typed from the rulebook values SPEC §5.10 signs, never from a module; expected
// reachable sets come from the rulebook (and each sport's own declarations), never from `reachableOutcomes`.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SETTLE_METHODS, foldMatchWithStoppage, outcomeOf, settledMethod, type EventEnvelope } from "../core/events.ts";
import { MatchOutcome, type StandingsDelta } from "../core/types.ts";
import { FOLD_EPOCH } from "../sport/fold-epoch.ts";
import type { AnySportModule } from "../sport/module.ts";
// single-sport: badminton is X-WO-1's (amended) set sport with no unplayed loss; the sweeps below cover every sport
import { badminton } from "../sports/setbased/badminton.ts";
// single-sport: PF-10 is an online-chess ruling (core.abandon{noResult}); the sweeps below cover every sport
import { boardgame } from "../sports/boardgame/boardgame.ts";
// single-sport: CK-PT-1/2 and the no_result mapper are cricket's rows (the one sport with a tie and a no result)
import { cricket } from "../sports/cricket/cricket.ts";
// single-sport: FB-PT-1 and the shoot-out sequence are football's rulebook rows (RB2B-7)
import { football } from "../sports/football/football.ts";
// single-sport: hockey is one of X-WO-1's (amended) sports with no unplayed loss; the sweeps below cover every sport
import { hockey } from "../sports/hockey/hockey.ts";
// single-sport: tennis keeps sets_won but no set table (I1: a set map refused where coverage and payout agree)
import { tennis } from "../sports/tennis/tennis.ts";
// single-sport: IH-PT-1 is the IIHF rulebook row (RBG:343-344)
import { icehockey } from "../sports/icehockey/icehockey.ts";
// single-sport: X-WO-1 (amended, D6) is table tennis's unplayed loss, the one sport that declares it
import { tabletennis } from "../sports/setbased/tabletennis.ts";
// single-sport: VB-PT-2/3 are the FIVB set-score rows
import { volleyball } from "../sports/setbased/volleyball.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { readCorpus } from "../testkit/golden.ts";
import { defaultLineupPair, makeEnvelope, tableRulesOf } from "../testkit/index.ts";
// The barrel: Tasks 3, 7, 9, 10 import these names from `@seazn/engine/competition`.
import {
  PointsRule,
  completeTableStage,
  coverage,
  decidedInFor,
  forfeitAwardOffer,
  legacyPointsRule,
  levelOutcomeKey,
  parseStoredPointsRule,
  payout,
  pointsRuleBounds,
  reachableOutcomes,
  setsToWinOf,
  validatePointsRule,
  type FixtureResult,
  type OutcomeKey,
  type TableFixture,
} from "./index.ts";

type Raw = Record<string, unknown>;
const SPORTS = Object.keys(FOLD_EPOCH).length; // the independent count of registered sports (PS-9g)
const CONFIG_INVALID = expect.objectContaining({ code: "CONFIG_INVALID" });

// SPEC §5.10's signed values. Parsed lazily, so each case reds on its own when the shape is refused.
const IIHF = (): PointsRule => PointsRule.parse({ win: { regulation: 3, ot: 2 }, loss: { regulation: 0, ot: 1 }, shootoutAs: "result", unit: "whole", bonuses: [] });
const FB = (extra: Raw = {}): PointsRule =>
  PointsRule.parse({ win: { regulation: 3 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "draw_plus_bonus", unit: "whole", bonuses: [], ...extra });
const TT = (extra: Raw = {}): PointsRule =>
  PointsRule.parse({ win: { regulation: 2 }, loss: { regulation: 1, unplayed: 0 }, shootoutAs: "result", unit: "whole", bonuses: [], ...extra });
const CK = (extra: Raw = {}): PointsRule =>
  PointsRule.parse({ win: { regulation: 2 }, loss: { regulation: 0 }, tie: 1, noResult: 1, shootoutAs: "result", unit: "whole", bonuses: [], ...extra });
const FIVB5 = { "3-0": [3, 0], "3-1": [3, 0], "3-2": [2, 1] };
const VB = (bySetScore: Raw): PointsRule =>
  PointsRule.parse({ win: { regulation: 3 }, loss: { regulation: 0 }, bySetScore, shootoutAs: "result", unit: "whole", bonuses: [] });

const win = (winner: "H" | "A", method?: string): MatchOutcome =>
  MatchOutcome.parse({ kind: "win", winner, loser: winner === "H" ? "A" : "H", ...(method === undefined ? {} : { method }) });
const award = (winner: "H" | "A", reason: "walkover" | "retired" | "disqualified" | "withdrew"): MatchOutcome =>
  MatchOutcome.parse({ kind: "award", winner, loser: winner === "H" ? "A" : "H", reason });
const BYE: MatchOutcome = MatchOutcome.parse({ kind: "award", winner: "H", loser: null, reason: "bye" });
const LEVEL = (kind: "draw" | "tie" | "no_result" | "double_walkover"): MatchOutcome => MatchOutcome.parse({ kind });

const side = (entrantId: string, w: number, d: number, l: number, metrics: Record<string, number>): StandingsDelta => ({
  entrantId, played: 1, won: w, drawn: d, lost: l, points: 0, metrics,
});
/** A goal sport's pair as its module books it: the winner (if any) won/lost, gf/ga/gd from the score. */
function pair(hg: number, ag: number, winner: "H" | "A" | null = hg > ag ? "H" : ag > hg ? "A" : null): FixtureResult {
  const goals = (f: number, a: number) => ({ gf: f, ga: a, gd: f - a });
  return [
    side("H", winner === "H" ? 1 : 0, winner === null ? 1 : 0, winner === "A" ? 1 : 0, goals(hg, ag)),
    side("A", winner === "A" ? 1 : 0, winner === null ? 1 : 0, winner === "H" ? 1 : 0, goals(ag, hg)),
  ];
}
/** A set sport's pair: H won `w`-`l` (or A, when `winner` says so). */
function sets(w: number, l: number, winner: "H" | "A" = "H"): FixtureResult {
  const hw = winner === "H" ? w : l;
  const aw = winner === "H" ? l : w;
  return [
    side("H", winner === "H" ? 1 : 0, 0, winner === "A" ? 1 : 0, { sets_won: hw, sets_lost: aw }),
    side("A", winner === "A" ? 1 : 0, 0, winner === "H" ? 1 : 0, { sets_won: aw, sets_lost: hw }),
  ];
}
const level = (metrics: Record<string, number> = {}, drawn = 0): FixtureResult => [side("H", 0, drawn, 0, metrics), side("A", 0, drawn, 0, metrics)];
const pts = (p: FixtureResult): [number, number] => [p[0].points, p[1].points];
const wdl = (d: StandingsDelta): [number, number, number, number] => [d.won, d.drawn, d.lost, d.points];
const sorted = (s: ReadonlySet<string>): string[] => [...s].sort();
/** Table rows by entrant id: the ranking pass orders them, these cases read each entrant's own row. */
const byEntrant = <R extends { entrantId: string }>(rows: readonly R[]): R[] => [...rows].sort((a, b) => a.entrantId.localeCompare(b.entrantId));

/** The decided fixtures of a sport's golden corpus, as a table reads them: the recorded outcome, its decidedIn (Task 1's
 *  `decidedInFor`) and the module's own league delta pair. */
function corpusFixtures(key: string): { config: string; outcome: MatchOutcome; pair: FixtureResult }[] {
  const out: { config: string; outcome: MatchOutcome; pair: FixtureResult }[] = [];
  for (const s of readCorpus(key).streams) {
    const raw: unknown = JSON.parse(s.outcome);
    const deltas = JSON.parse(s.deltas) as { league?: FixtureResult | null };
    if (raw === null || deltas.league == null) continue;
    out.push({ config: s.config, outcome: MatchOutcome.parse(raw), pair: deltas.league });
  }
  return out;
}

describe("W2d payout (SPEC §5.3)", () => {
  // empty case first
  it("an undecided fixture pays nothing and is not counted", () => {
    const stage = { id: "s", kind: "league" as const, entrants: ["H", "A"], rules: tableRulesOf(["points" as const]) };
    const undecided: TableFixture = { id: "f1", status: "scheduled" };
    const rows = byEntrant(completeTableStage(stage, [undecided]).tables.overall!);
    expect(rows.map((r) => [r.entrantId, r.played, r.points])).toEqual([
      ["A", 0, 0],
      ["H", 0, 0],
    ]);
    // An in-play fixture may carry a partial pair from the adapter: it still is not counted.
    const live: TableFixture = { id: "f1", status: "in_play", result: payout(win("H"), "regulation", pair(1, 0), true, FB(), undefined, undefined) };
    expect(completeTableStage(stage, [live]).tables.overall!.map((r) => [r.played, r.points])).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it("X-DW-4 a double walkover pays 0/0 and no bonus, whatever the rule", () => {
    const dw: FixtureResult = [side("H", 0, 0, 1, {}), side("A", 0, 0, 1, {})];
    const bonuses = [
      { when: "forfeit_loss", points: 5 },
      { when: "loss_margin_lte", param: 99, points: 5 },
      { when: "no_result", points: 5 },
    ];
    let checked = 0;
    for (const rule of [IIHF(), FB({ bonuses }), TT({ bonuses, forfeit: { winnerPoints: 3, loserPoints: -2 } }), CK({ bonuses })]) {
      for (const played of [false, true]) {
        const out = payout(LEVEL("double_walkover"), null, dw, played, rule, undefined, undefined);
        expect(pts(out)).toEqual([0, 0]);
        expect(out.map((d) => d.lost)).toEqual([1, 1]);
        checked++;
      }
    }
    expect(checked).toBe(8);
  });

  it("IH-PT-1 an OT win pays 2/1; a GWS with no `so` entry falls back to the OT values 2/1 (RBG:343-344)", () => {
    const ot = win("H", "extra_time");
    const gws = win("A", "shootout");
    // decidedIn from Task 1's declaration (ice hockey: extra_time → ot, shootout → so), not typed here.
    expect(decidedInFor(icehockey, ot)).toBe("ot");
    expect(decidedInFor(icehockey, gws)).toBe("so");
    expect(pts(payout(ot, decidedInFor(icehockey, ot), pair(3, 2), true, IIHF(), undefined, undefined))).toEqual([2, 1]);
    expect(pts(payout(gws, decidedInFor(icehockey, gws), pair(2, 2, "A"), true, IIHF(), undefined, undefined))).toEqual([1, 2]);
    // regulation stays 3/0 (the differential: an OT pair applied everywhere would read 2/1 here)
    expect(pts(payout(win("H", "regulation"), "regulation", pair(4, 1), true, IIHF(), undefined, undefined))).toEqual([3, 0]);
    // an explicit `so` split outranks the OT fallback
    const split = PointsRule.parse({ ...IIHF(), win: { regulation: 3, ot: 2, so: 5 }, loss: { regulation: 0, ot: 1, so: -1 } });
    expect(pts(payout(gws, "so", pair(2, 2, "A"), true, split, undefined, undefined))).toEqual([-1, 5]);
  });

  it("FB-PT-1 X-PT-4 a shoot-out under draw_plus_bonus books drawn/drawn, pays 1+1=2 to the winner and 1 to the loser; won_so 1 on the winner; wins 0 for both (RB2B-7)", () => {
    const [h, a] = payout(win("H", "shootout"), "so", pair(1, 1, "H"), true, FB(), undefined, undefined);
    expect([h.won, h.drawn, h.lost, h.points]).toEqual([0, 1, 0, 2]);
    expect([a.won, a.drawn, a.lost, a.points]).toEqual([0, 1, 0, 1]);
    expect(h.metrics.won_so).toBe(1);
    expect(a.metrics.lost_so).toBe(1);
    expect(a.metrics.won_so).toBeUndefined();
    // the goals stand: only W/D/L and points move (spec §5.1)
    expect([h.metrics.gf, h.metrics.ga, a.metrics.gf]).toEqual([1, 1, 1]);
    // a regulation win under the same rule is a win: 3/0, booked won/lost, no display metric
    const [rw, rl] = payout(win("H", "regulation"), "regulation", pair(2, 0), true, FB(), undefined, undefined);
    expect([wdl(rw), wdl(rl)]).toEqual([[1, 0, 0, 3], [0, 0, 1, 0]]);
    expect(rw.metrics.won_so).toBeUndefined();
    expect(rw.metrics.won_ot).toBeUndefined();
  });

  it("B2 soBonus absent defaults to 1; soBonus 2 pays 3/1 (the differential against a hard-coded 1)", () => {
    expect(pts(payout(win("A", "shootout"), "so", pair(0, 0, "A"), true, FB(), undefined, undefined))).toEqual([1, 2]);
    expect(pts(payout(win("A", "shootout"), "so", pair(0, 0, "A"), true, FB({ soBonus: 2 }), undefined, undefined))).toEqual([1, 3]);
    expect(pts(payout(win("A", "shootout"), "so", pair(0, 0, "A"), true, FB({ soBonus: 0 }), undefined, undefined))).toEqual([1, 1]);
  });

  it("X-WO-1 (amended, D6) TT: an unplayed walkover loser gets loss.unplayed 0; a played loser gets 1; the winner gets 2 either way", () => {
    const wo = payout(award("H", "walkover"), null, sets(3, 0), false, TT(), undefined, undefined);
    expect(pts(wo)).toEqual([2, 0]);
    const played = payout(win("H", "regulation"), "regulation", sets(3, 1), true, TT(), undefined, undefined);
    expect(pts(played)).toEqual([2, 1]);
    // amended 108 names a retirement too (ITTF 3.7.5.1 "uncompleted"): the award's loser is paid the loss not played
    expect(pts(payout(award("A", "retired"), null, sets(3, 2, "A"), true, TT(), undefined, undefined))).toEqual([0, 2]);
    // a pre-W2b walkover WIN is an award too (forfeitShaped), read before its decidedIn ("regulation")
    expect(pts(payout(win("H", "walkover"), "regulation", sets(3, 0), false, TT(), undefined, undefined))).toEqual([2, 0]);
    // the rule without `unplayed` (every other sport, ruling 108 unamended) pays the credited score's loss
    const unamended = TT({ loss: { regulation: 1 } });
    expect(pts(payout(award("H", "walkover"), null, sets(3, 0), false, unamended, undefined, undefined))).toEqual([2, 1]);
  });

  it("X-PT-1 an unplayed forfeit with a forfeit row pays the forfeit row, not loss.unplayed (precedence, SPEC §5.3 step 5)", () => {
    const rule = TT({ forfeit: { winnerPoints: 3, loserPoints: -1 } });
    expect(pts(payout(award("H", "walkover"), null, sets(3, 0), false, rule, undefined, undefined))).toEqual([3, -1]);
    // after play the award is a result: the forfeit row no longer applies, the loss not played does
    expect(pts(payout(award("H", "withdrew"), null, sets(3, 1), true, rule, undefined, undefined))).toEqual([2, 0]);
  });

  it("a bye pays the forfeit row if set, else the clean-sweep win; never awardScore", () => {
    const byePair: FixtureResult = [side("H", 1, 0, 0, { gf: 0, ga: 0, gd: 0 }), side("__bye__", 0, 0, 1, {})];
    const withRow = FB({ forfeit: { winnerPoints: 1, loserPoints: 0, awardScore: [5, 0] } });
    const [h] = payout(BYE, null, byePair, false, withRow, { for: "gf", against: "ga", diff: "gd" }, undefined);
    expect(h.points).toBe(1);
    expect(h.metrics).toEqual({ gf: 0, ga: 0, gd: 0 }); // never the award score
    expect(payout(BYE, null, byePair, false, FB(), undefined, undefined)[0].points).toBe(3);
    // a set sport's clean sweep: the bye's credited 3-0 is paid its own pair, and never loss.unplayed for the empty seat
    const vbBye: FixtureResult = [side("H", 1, 0, 0, { sets_won: 3, sets_lost: 0 }), side("__bye__", 0, 0, 1, { sets_won: 0, sets_lost: 3 })];
    const vb = PointsRule.parse({ ...VB({ "3-0": [3, 0], "3-1": [3, 0], "3-2": [2, 1] }), loss: { regulation: 0, unplayed: -5 } });
    expect(pts(payout(BYE, null, vbBye, false, vb, undefined, 3))).toEqual([3, 0]);
  });

  it("CK-PT-1 cricket: tie 1 each; noResult 1 each; a rule with no noResult pays 0 (D14)", () => {
    expect(pts(payout(LEVEL("tie"), null, level(), true, CK(), undefined, undefined))).toEqual([1, 1]);
    expect(pts(payout(LEVEL("no_result"), null, level(), false, CK(), undefined, undefined))).toEqual([1, 1]);
    const noNr = PointsRule.parse({ win: { regulation: 2 }, loss: { regulation: 0 }, tie: 1, shootoutAs: "result", unit: "whole" });
    expect(pts(payout(LEVEL("no_result"), null, level(), false, noNr, undefined, undefined))).toEqual([0, 0]);
    // a cricket tie books 0/0/0 (cricket.ts standingsDelta): the rule's tie is paid, never its draw
    const both = CK({ draw: 7 });
    expect(pts(payout(LEVEL("tie"), null, level(), true, both, undefined, undefined))).toEqual([1, 1]);
  });

  it("CK-PT-2 a two-innings draw pays `draw` 1 (D10(c))", () => {
    expect(pts(payout(LEVEL("draw"), null, level({}, 1), true, CK({ draw: 1 }), undefined, undefined))).toEqual([1, 1]);
  });

  it("VB-PT-2 bySetScore {2-0:[3,0], 2-1:[2,1]}: 2-1 pays 2:1, not 3:0 (SC-S9); an exact key beats '*'", () => {
    const bo3 = VB({ "2-0": [3, 0], "2-1": [2, 1] });
    expect(pts(payout(win("H"), "regulation", sets(2, 1), true, bo3, undefined, 2))).toEqual([2, 1]);
    expect(pts(payout(win("A"), "regulation", sets(2, 0, "A"), true, bo3, undefined, 2))).toEqual([0, 3]);
    const star = VB({ "*": [3, 0], "2-1": [2, 1] });
    expect(pts(payout(win("H"), "regulation", sets(2, 1), true, star, undefined, 2))).toEqual([2, 1]);
    expect(pts(payout(win("H"), "regulation", sets(2, 0), true, star, undefined, 2))).toEqual([3, 0]);
    // an award pays the pair of its credited set score (ruling 108)
    expect(pts(payout(award("H", "walkover"), null, sets(2, 0), false, bo3, undefined, 2))).toEqual([3, 0]);
    // a score the map neither names nor stars is never paid as a guess
    expect(() => payout(win("H"), "regulation", sets(2, 1), true, VB({ "2-0": [3, 0] }), undefined, 2)).toThrowError(CONFIG_INVALID);
    // and a map on a result with no set score is a refusal, not a 0
    expect(() => payout(win("H"), "regulation", pair(2, 1), true, bo3, undefined, 2)).toThrowError(CONFIG_INVALID);
  });

  it("I2 FIVB 6.4.3 a settled abandon of a set match pays as a team declared incomplete: the winner given the sets it needed, the other side keeping its own (bo5 1-1 → 3-1, 1-2 → 3-2; bo3 1-0 → 2-0; every settle method, both seats; counted)", () => {
    // single-sport: FIVB 6.4.3 is volleyball's rule (its best-of-5 and best-of-3 maps, SPEC §5.10)
    const BO3 = { "2-0": [3, 0], "2-1": [2, 1] };
    let checked = 0;
    for (const [bestOf, map, won, lost] of [
      [5, FIVB5, 1, 1],
      [5, FIVB5, 1, 2],
      [3, BO3, 1, 0],
    ] as const) {
      // The rulebook: a best-of-N match is won on ⌈N/2⌉ sets; the winner's count is completed to it, the loser's kept.
      const key = `${Math.ceil(bestOf / 2)}-${lost}`;
      const want = (map as Readonly<Record<string, readonly number[]>>)[key];
      expect(want, key).toBeDefined();
      for (const m of SETTLE_METHODS) {
        for (const seat of ["H", "A"] as const) {
          const got = payout(win(seat, settledMethod(m)), "regulation", sets(won, lost, seat), true, VB(map), undefined, setsToWinOf(volleyball, { bestOf }));
          expect(pts(got), `bo${bestOf} ${won}-${lost} ${m} ${seat}`).toEqual(seat === "H" ? [want![0], want![1]] : [want![1], want![0]]);
          checked++;
        }
      }
    }
    expect(checked).toBe(3 * SETTLE_METHODS.length * 2);
    // a "*" never stands in for the completed score's own pair (pre-W2d's settle paid "*")
    expect(pts(payout(win("H", settledMethod("lot")), "regulation", sets(1, 1), true, VB({ ...FIVB5, "*": [9, 9] }), undefined, 3))).toEqual([3, 0]);
    // genuinely malformed results still throw: no set score at all, a "winner" holding the loser's majority or more sets
    // than a match is won on, and a set map where the sport keeps no set score
    expect(() => payout(win("H", settledMethod("lot")), "regulation", pair(1, 0), true, VB(FIVB5), undefined, 3)).toThrowError(/names no winner's set score/);
    expect(() => payout(win("H"), "regulation", sets(1, 3), true, VB(FIVB5), undefined, 3)).toThrowError(/1-3 no match won on 3 sets ends on/);
    expect(() => payout(win("H"), "regulation", sets(4, 1), true, VB(FIVB5), undefined, 3)).toThrowError(/4-1 no match won on 3 sets ends on/);
    expect(() => payout(win("H"), "regulation", sets(3, 1), true, VB(FIVB5), undefined, undefined)).toThrowError(/keeps no set score/);
    // the boundary: a played final score is its own key (3-2 pays 3-2's pair, never a completed 3-… guess)
    expect(pts(payout(win("H"), "regulation", sets(3, 2), true, VB(FIVB5), undefined, 3))).toEqual([2, 1]);
  });

  it("F11 a win_margin_gte bonus reads football's gd and cricket's run_diff, not literal diff (validatePointsRule accepts it)", () => {
    const rule = FB({ bonuses: [{ when: "win_margin_gte", param: 3, points: 1 }] });
    // football's own ledger: gf/ga/gd and no generic key
    expect(pts(payout(win("H"), "regulation", pair(4, 1), true, rule, undefined, undefined))).toEqual([4, 0]);
    expect(pts(payout(win("H"), "regulation", pair(3, 1), true, rule, undefined, undefined))).toEqual([3, 0]);
    const cricketPair = (diff: number): FixtureResult => [
      side("H", 1, 0, 0, { runs_for: 150 + diff, runs_against: 150, run_diff: diff }),
      side("A", 0, 0, 1, { runs_for: 150, runs_against: 150 + diff, run_diff: -diff }),
    ];
    const ck = CK({ bonuses: [{ when: "win_margin_gte", param: 30, points: 1 }, { when: "loss_margin_lte", param: 10, points: 1 }] });
    expect(pts(payout(win("H"), "regulation", cricketPair(31), true, ck, undefined, undefined))).toEqual([3, 0]);
    expect(pts(payout(win("H"), "regulation", cricketPair(5), true, ck, undefined, undefined))).toEqual([2, 1]);
    expect(() => validatePointsRule(rule, football.metrics)).not.toThrow();
    expect(() => validatePointsRule(ck, cricket.metrics)).not.toThrow();
    expect(() => validatePointsRule(rule, hockey.metrics)).not.toThrow();
    // a sport that keeps no score under any alias is still refused (volleyball: sets and rally points only)
    expect(() => validatePointsRule(rule, volleyball.metrics)).toThrowError(CONFIG_INVALID);
    // ...and the refusal says why (the stage PUT shows it to the organiser)
    expect(() => validatePointsRule(rule, volleyball.metrics)).toThrow(/emits no score/);
  });

  it("unit 'half' changes nothing payout pays (display only)", () => {
    const cases: [MatchOutcome, FixtureResult][] = [
      [win("H"), pair(2, 0)],
      [win("A", "shootout"), pair(1, 1, "A")],
      [LEVEL("draw"), pair(1, 1)],
      [award("H", "walkover"), pair(0, 0, "H")],
    ];
    let checked = 0;
    for (const [outcome, p] of cases) {
      const d = decidedInFor(football, outcome);
      expect(payout(outcome, d, p, false, FB({ unit: "half" }), undefined, undefined)).toEqual(payout(outcome, d, p, false, FB(), undefined, undefined));
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("a draw under a rule with no draw throws CONFIG_INVALID (coverage should have refused it at save)", () => {
    expect(() => payout(LEVEL("draw"), null, pair(1, 1), true, TT(), undefined, undefined)).toThrowError(CONFIG_INVALID);
    expect(() => payout(LEVEL("tie"), null, level(), true, TT(), undefined, undefined)).toThrowError(CONFIG_INVALID);
    // a draw-plus-bonus shoot-out IS a draw: a rule with no draw cannot pay it either
    const noDraw = PointsRule.parse({ win: { regulation: 3 }, loss: { regulation: 0 }, shootoutAs: "draw_plus_bonus", unit: "whole" });
    expect(() => payout(win("H", "shootout"), "so", pair(1, 1, "H"), true, noDraw, undefined, undefined)).toThrowError(CONFIG_INVALID);
  });

  it("decidedIn is present exactly for a win (a caller's mismatch throws CONFIG_INVALID, never pays regulation)", () => {
    expect(() => payout(win("H"), null, pair(1, 0), true, FB(), undefined, undefined)).toThrowError(CONFIG_INVALID);
    expect(() => payout(LEVEL("draw"), "regulation", pair(1, 1), true, FB(), undefined, undefined)).toThrowError(CONFIG_INVALID);
    expect(() => payout(award("H", "walkover"), "regulation", pair(0, 0, "H"), false, FB(), undefined, undefined)).toThrowError(CONFIG_INVALID);
  });

  it("each refusal says what it refuses: an uncovered outcome, a set score not named, a decidedIn mismatch (message and data)", () => {
    const refusal = (fn: () => unknown): { message: string; data: unknown } => {
      try {
        fn();
      } catch (e) {
        expect(e, "an EngineError").toMatchObject({ code: "CONFIG_INVALID" });
        return { message: (e as Error).message, data: (e as { data?: unknown }).data };
      }
      throw new Error("expected a refusal");
    };
    const noDraw = refusal(() => payout(LEVEL("draw"), null, pair(1, 1), true, TT(), undefined, undefined));
    expect(noDraw.data).toEqual({ outcome: "draw" });
    expect(noDraw.message).toMatch(/"draw"/);
    // a set score the map neither names nor covers with "*"
    const unnamed = refusal(() => payout(win("H"), "regulation", sets(3, 1), true, VB({ "3-0": [3, 0] }), undefined, 3));
    expect(unnamed.data).toEqual({ outcome: "set:3-1" });
    expect(unnamed.message).toMatch(/"set:3-1"/);
    const needs = refusal(() => payout(win("H"), null, pair(1, 0), true, FB(), undefined, undefined));
    expect([needs.message, needs.data]).toEqual(["a win outcome needs decidedIn", { kind: "win", decidedIn: null }]);
    const takes = refusal(() => payout(LEVEL("draw"), "regulation", pair(1, 1), true, FB(), undefined, undefined));
    expect([takes.message, takes.data]).toEqual(["a draw outcome takes no decidedIn", { kind: "draw", decidedIn: "regulation" }]);
    // a set map over a result whose winner's ledger names no set score: refused by name (never "undefined-undefined"
    // falling to "*"), and a pair whose loser has no winner beside it is the same refusal, never a TypeError
    const star = VB({ "*": [3, 0] });
    const noScore = refusal(() => payout(win("H"), "regulation", [side("H", 1, 0, 0, { sets_won: 2 }), side("A", 0, 0, 1, {})], true, star, undefined, 2));
    expect([noScore.message, noScore.data]).toEqual(["the points rule pays by set score, but the result names no winner's set score", { entrants: ["H", "A"] }]);
    const noWon = refusal(() => payout(win("H"), "regulation", [side("H", 1, 0, 0, { sets_lost: 0 }), side("A", 0, 0, 1, {})], true, star, undefined, 2));
    expect(noWon.data, "either half of the set score alone").toEqual({ entrants: ["H", "A"] });
    const noWinner = refusal(() => payout(win("H"), "regulation", [side("H", 0, 0, 0, {}), side("A", 0, 0, 1, {})], true, star, undefined, 2));
    expect(noWinner.data).toEqual({ entrants: ["H", "A"] });
  });

  it("margin and ratio bonuses read the first score alias whose for AND against are both recorded, index for index (F11)", () => {
    // cricket keeps runs_for/runs_against (the second alias) and here no run_diff, so the ratio reads the pair
    const ratio = CK({ bonuses: [{ when: "score_ratio_gte", param: 0.9, points: 1 }] });
    const ck = (hf: number, ha: number, extra: Record<string, number> = {}): FixtureResult => [
      side("H", 1, 0, 0, { runs_for: hf, runs_against: ha }),
      side("A", 0, 0, 1, { runs_for: ha, runs_against: hf, ...extra }),
    ];
    expect(pts(payout(win("H"), "regulation", ck(150, 140), true, ratio, undefined, undefined)), "140/150 >= 0.9: the loser's bonus").toEqual([2, 1]);
    expect(pts(payout(win("H"), "regulation", ck(150, 120), true, ratio, undefined, undefined)), "120/150 < 0.9: none").toEqual([2, 0]);
    // a half pair of an earlier alias (gf with no ga) is skipped, never read as a score
    expect(pts(payout(win("H"), "regulation", ck(150, 140, { gf: 0 }), true, ratio, undefined, undefined))).toEqual([2, 1]);
    expect(pts(payout(win("H"), "regulation", ck(150, 140, { ga: 0 }), true, ratio, undefined, undefined)), "either half alone").toEqual([2, 1]);
  });

  it("a win decided in ot pays ot even where so is set; so pays so; regulation pays regulation (the chain, each link)", () => {
    const rule = PointsRule.parse({ win: { regulation: 3, ot: 2, so: 5 }, loss: { regulation: 0, ot: 1, so: 4 }, shootoutAs: "result", unit: "whole" });
    expect(pts(payout(win("H", "extra_time"), "ot", pair(2, 1), true, rule, undefined, undefined))).toEqual([2, 1]);
    expect(pts(payout(win("H", "shootout"), "so", pair(1, 1, "H"), true, rule, undefined, undefined))).toEqual([5, 4]);
    expect(pts(payout(win("H"), "regulation", pair(2, 1), true, rule, undefined, undefined))).toEqual([3, 0]);
  });

  it("an award under a set map pays the credited score's pair to both sides, not win.regulation / loss.regulation", () => {
    const rule = VB({ "2-0": [4, 1] });
    expect(pts(payout(award("H", "walkover"), null, sets(2, 0), false, rule, undefined, 2))).toEqual([4, 1]);
  });

  it("a side a result books neither won nor lost is paid 0: an award, a set map, the decided-in chain", () => {
    const neutral = (h: StandingsDelta): FixtureResult => [h, side("A", 0, 0, 0, {})];
    const lossPays = PointsRule.parse({ win: { regulation: 3 }, loss: { regulation: 1 }, shootoutAs: "result", unit: "whole" });
    expect(pts(payout(award("H", "walkover"), null, neutral(side("H", 1, 0, 0, {})), false, lossPays, undefined, undefined))).toEqual([3, 0]);
    expect(pts(payout(win("H"), "regulation", neutral(side("H", 1, 0, 0, { sets_won: 2, sets_lost: 0 })), true, VB({ "2-0": [3, 1] }), undefined, 2))).toEqual([3, 0]);
    expect(pts(payout(win("H"), "regulation", neutral(side("H", 1, 0, 0, {})), true, lossPays, undefined, undefined))).toEqual([3, 0]);
  });

  it("a set map is the whole table: a result decided in a shoot-out pays its set pair and books won/lost, never a draw", () => {
    const rule = PointsRule.parse({ win: { regulation: 3 }, loss: { regulation: 0 }, draw: 1, bySetScore: { "*": [3, 0] }, shootoutAs: "draw_plus_bonus", unit: "whole" });
    const out = payout(win("H", "shootout"), "so", sets(2, 1), true, rule, undefined, 2);
    expect([wdl(out[0]), wdl(out[1])]).toEqual([[1, 0, 0, 3], [0, 0, 1, 0]]);
  });

  it("a forfeit-shaped win is an award whatever decidedIn a caller passes: never booked as a shoot-out draw", () => {
    const out = payout(win("H", "walkover"), "so", pair(0, 0, "H"), false, FB(), undefined, undefined);
    expect([wdl(out[0]), wdl(out[1])]).toEqual([[1, 0, 0, 3], [0, 0, 1, 0]]);
    expect(out[0].metrics.won_so, "an award writes no display metric").toBeUndefined();
  });

  it("the rule refuses a field its shoot-out booking can never pay: a `so` split under draw_plus_bonus, a soBonus under result", () => {
    const dpbSplit = { win: { regulation: 3, so: 2 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "draw_plus_bonus", unit: "whole" };
    expect(PointsRule.safeParse(dpbSplit).success).toBe(false);
    expect(PointsRule.safeParse({ ...dpbSplit, win: { regulation: 3 }, loss: { regulation: 0, so: 1 } }).success).toBe(false);
    expect(PointsRule.safeParse({ ...dpbSplit, win: { regulation: 3 } }).success).toBe(true);
    expect(PointsRule.safeParse({ ...dpbSplit, win: { regulation: 3 }, shootoutAs: "result", soBonus: 1 }).success).toBe(false);
    expect(PointsRule.safeParse({ ...dpbSplit, win: { regulation: 3 }, shootoutAs: "result" }).success).toBe(true);
    // Each refusal names the field it refuses (the API's 400 carries the path and the words), one issue per field.
    const issues = (raw: unknown) => {
      const r = PointsRule.safeParse(raw);
      expect(r.success, JSON.stringify(raw)).toBe(false);
      return r.error!.issues.map((i) => ({ path: i.path, code: i.code, named: i.message.length > 0 }));
    };
    const both = { ...dpbSplit, win: { regulation: 3, so: 2 }, loss: { regulation: 0, so: 1 } };
    expect(issues(both)).toEqual([
      { path: ["win", "so"], code: "custom", named: true },
      { path: ["loss", "so"], code: "custom", named: true },
    ]);
    expect(issues({ ...dpbSplit, win: { regulation: 3 }, shootoutAs: "result", soBonus: 1 })).toEqual([{ path: ["soBonus"], code: "custom", named: true }]);
    expect(PointsRule.safeParse(both).error!.issues.map((i) => i.message).join(" ")).toMatch(/soBonus/);
    expect(PointsRule.safeParse({ ...dpbSplit, win: { regulation: 3 }, shootoutAs: "result", soBonus: 1 }).error!.issues[0]!.message).toMatch(/win\.so/);
    // An empty set-score map pays nothing (absent pays every score by the win and the loss): refused by name; one key is a map.
    expect(issues({ ...dpbSplit, win: { regulation: 3 }, bySetScore: {} })).toEqual([{ path: ["bySetScore"], code: "custom", named: true }]);
    expect(PointsRule.safeParse({ ...dpbSplit, win: { regulation: 3 }, bySetScore: {} }).error!.issues[0]!.message).toMatch(/at least one score/);
    expect(PointsRule.safeParse({ ...dpbSplit, win: { regulation: 3 }, bySetScore: { "*": [2, 0] } }).success).toBe(true);
    // a set-score key is "W-L" (any number of digits a side) or "*", the whole key and nothing else
    let keys = 0;
    for (const key of ["3-0", "2-1", "10-12", "*"]) {
      expect(PointsRule.safeParse({ ...dpbSplit, win: { regulation: 3 }, bySetScore: { [key]: [3, 0] } }).success, key).toBe(true);
      keys++;
    }
    for (const key of ["3:0", "x3-0", "3-0x", "3-", "-0", "a-b", "**", "", "3–0"]) {
      expect(PointsRule.safeParse({ ...dpbSplit, win: { regulation: 3 }, bySetScore: { [key]: [3, 0] } }).success, key).toBe(false);
      keys++;
    }
    expect(keys).toBe(13);
  });

  it("the published example (OpenAPI's, from the schema's meta) is a rule the schema takes, and there is one", () => {
    const examples = (PointsRule.meta()?.examples ?? []) as unknown[];
    expect(examples.length).toBeGreaterThan(0);
    for (const ex of examples) {
      expect(PointsRule.safeParse(ex).error?.issues ?? [], JSON.stringify(ex)).toEqual([]);
      // the example is the IIHF table it says it is (spec §5.10): ot splits on both sides and a walkover row
      expect(ex).toMatchObject({ win: { regulation: 3, ot: 2 }, loss: { regulation: 0, ot: 1 }, forfeit: { winnerPoints: 3, loserPoints: 0 } });
    }
  });

  it("Sequence: undecided → decided → second recompute (same points) → void → another sport (cricket tie)", () => {
    // single-sport: the sequence walks football's recorded shoot-out, then cricket's recorded tie (the rule rows' own sports)
    const stage = { id: "s", kind: "league" as const, entrants: ["H", "A"], rules: tableRulesOf(["points" as const]) };
    const rowsOf = (fixtures: TableFixture[]) =>
      byEntrant(completeTableStage(stage, fixtures).tables.overall!).map((r) => [r.entrantId, r.won, r.drawn, r.lost, r.points]);
    // the recorded football shoot-out (football.golden.json), paid under the signed football rule
    const so = corpusFixtures("football").find((f) => f.outcome.kind === "win" && f.outcome.method === "shootout")!;
    expect(so, "premise: the corpus records a football shoot-out").toBeDefined();
    const decided = (): TableFixture => ({ id: "f1", status: "decided", result: payout(so.outcome, decidedInFor(football, so.outcome), so.pair, true, FB(), undefined, undefined) });
    const winner = (so.outcome as { winner: string }).winner;
    expect(rowsOf([{ id: "f1", status: "scheduled" }])).toEqual([["A", 0, 0, 0, 0], ["H", 0, 0, 0, 0]]);
    const once = rowsOf([decided()]);
    expect(once).toEqual([["A", 0, 1, 0, winner === "A" ? 2 : 1], ["H", 0, 1, 0, winner === "H" ? 2 : 1]]);
    expect(rowsOf([decided()]), "a second recompute pays the same, never twice").toEqual(once);
    expect(rowsOf([{ ...decided(), status: "void" }])).toEqual([["A", 0, 0, 0, 0], ["H", 0, 0, 0, 0]]);
    // another sport: the recorded cricket tie under the signed cricket rule
    const tie = corpusFixtures("cricket").find((f) => f.outcome.kind === "tie")!;
    expect(tie, "premise: the corpus records a cricket tie").toBeDefined();
    const ck = payout(tie.outcome, decidedInFor(cricket, tie.outcome), tie.pair, true, CK(), undefined, undefined);
    expect(rowsOf([{ id: "c1", status: "decided", result: ck }])).toEqual([["A", 0, 0, 0, 1], ["H", 0, 0, 0, 1]]);
  });

  it("an organiser No-result abandon (online chess) credits no row; the table equals the one without that fixture", () => {
    // single-sport: PF-10 is an online-chess ruling: the organiser's No result abandon of a board
    // Ruling PF-10 (W2c D3): `core.abandon{noResult: true}` is already the settle and folds to NO outcome, so no payout runs.
    const cfg = boardgame.configSchema.parse({});
    const evs: EventEnvelope[] = [
      makeEnvelope(1, { type: "core.start", payload: {} }),
      makeEnvelope(2, { type: "core.abandon", payload: { reason: "the organiser recorded no result", noResult: true } }),
    ];
    const folded = foldMatchWithStoppage(boardgame as never, cfg as never, defaultLineupPair(boardgame.positions), evs);
    expect(outcomeOf(boardgame as never, folded as never)).toBeNull();
    const chessRule = PointsRule.parse({ win: { regulation: 2 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "half" });
    const decided = corpusFixtures("boardgame").find((f) => f.outcome.kind === "win")!;
    const counted: TableFixture = {
      id: "g1",
      status: "decided",
      result: payout(decided.outcome, decidedInFor(boardgame, decided.outcome), decided.pair, true, chessRule, undefined, undefined),
    };
    const stage = { id: "s", kind: "swiss" as const, entrants: ["H", "A"], rules: tableRulesOf(["points" as const]) };
    // The abandoned board is held by the table read as a fixture with no result (the web's completion reads it void or
    // in play, never decided with a pair): whatever its status, it credits nobody.
    for (const status of ["void", "in_play", "decided"] as const) {
      const withAbandon = completeTableStage(stage, [counted, { id: "g2", status }]).tables.overall;
      expect(withAbandon, status).toEqual(completeTableStage(stage, [counted]).tables.overall);
    }
  });
});

describe("reachableOutcomes + coverage (X-PT-3)", () => {
  it("an empty reachable set is covered (empty case)", () => {
    let checked = 0;
    for (const rule of [IIHF(), FB(), TT(), CK(), VB({ "3-0": [3, 0], "3-2": [2, 1] })]) {
      expect(coverage(rule, new Set())).toEqual({ ok: true });
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("football group with shootout on: {win.regulation, loss.regulation, draw, win.so, loss.so} — no loss.unplayed (PS-7a)", () => {
    // from Task 1's declarations: football reaches so with `shootout`, a draw in every table stage, no loss not played
    const reach = reachableOutcomes(football, { shootout: true }, "group");
    expect(sorted(reach)).toEqual(["draw", "loss.regulation", "loss.so", "win.regulation", "win.so"]);
    expect(reach.has("loss.unplayed")).toBe(false);
    expect(coverage(FB(), reach)).toEqual({ ok: true });
  });

  it("X-WO-1 (amended, D6) table tennis reaches loss.unplayed; football, hockey and badminton do not (declaresUnplayedLoss, counted)", () => {
    const expected: Record<string, boolean> = { tabletennis: true, football: false, hockey: false, badminton: false };
    let checked = 0;
    for (const m of [tabletennis, football, hockey, badminton] as AnySportModule[]) {
      const raw = m.configSchema.safeParse({}).success ? {} : Object.values(m.variants)[0];
      expect(reachableOutcomes(m, raw, "league").has("loss.unplayed"), m.key).toBe(expected[m.key]);
      checked++;
    }
    expect(checked).toBe(4);
    // and across the registry: table tennis is the one sport that declares it (D6 "no other sport declares one")
    const declaring: string[] = [];
    expect(forEachSport(({ module }) => void (reachableOutcomes(module, Object.values(module.variants)[0] ?? {}, "league").has("loss.unplayed") && declaring.push(module.key)))).toBe(SPORTS);
    expect(declaring).toEqual(["tabletennis"]);
  });

  it("X-PT-3 a draw_plus_bonus rule with no draw payout is uncovered ['draw'] on a HAND-BUILT reachable set holding win.so but NOT draw — the so→draw rule refuses it, not a reachable draw (PS-9g)", () => {
    const noDraw = PointsRule.parse({ win: { regulation: 3 }, loss: { regulation: 0 }, shootoutAs: "draw_plus_bonus", unit: "whole" });
    const handBuilt = new Set<OutcomeKey>(["win.regulation", "loss.regulation", "win.so", "loss.so"]);
    expect(handBuilt.has("draw")).toBe(false);
    expect(coverage(noDraw, handBuilt)).toEqual({ ok: false, uncovered: ["draw"], inapplicable: [] });
    // the same rule booked as a result covers the shoot-out through the so → regulation fallback
    expect(coverage(PointsRule.parse({ ...noDraw, shootoutAs: "result" }), handBuilt)).toEqual({ ok: true });
    // and with the draw paid, the draw-plus-bonus rule covers it
    expect(coverage(FB(), handBuilt)).toEqual({ ok: true });
  });

  it("VB-PT-3 {'*':[3,0],'3-2':[2,1]} on bestOf 5 is uncovered ['set:3-0','set:3-1'] — '*' does not count when >1 distinct pair (RBS:566)", () => {
    const reach = reachableOutcomes(volleyball, { bestOf: 5 }, "league");
    expect(coverage(VB({ "*": [3, 0], "3-2": [2, 1] }), reach)).toEqual({ ok: false, uncovered: ["set:3-0", "set:3-1"], inapplicable: [] });
  });

  it("VB-PT-3 a flat {'*':[2,0]} always covers; the explicit FIVB map {3-0,3-1,3-2} covers bestOf 5", () => {
    let checked = 0;
    for (const bestOf of [1, 3, 5]) {
      expect(coverage(VB({ "*": [2, 0] }), reachableOutcomes(volleyball, { bestOf }, "league")), `bestOf ${bestOf}`).toEqual({ ok: true });
      checked++;
    }
    expect(checked).toBe(3);
    expect(coverage(VB(FIVB5), reachableOutcomes(volleyball, { bestOf: 5 }, "league"))).toEqual({ ok: true });
    // a rule with no map pays every set score its win/loss
    expect(coverage(TT(), reachableOutcomes(tabletennis, {}, "league"))).toEqual({ ok: true });
  });

  it("VB-PT-3 a bestOf 3 override on the FIVB bestOf-5 map is uncovered ['set:2-0','set:2-1'] (SPEC §5.4)", () => {
    expect(coverage(VB(FIVB5), reachableOutcomes(volleyball, { bestOf: 3 }, "league"))).toEqual({ ok: false, uncovered: ["set:2-0", "set:2-1"], inapplicable: [] });
  });

  it("cricket: a rule with no tie is uncovered ['tie']; noResult falls back to 0 and is covered", () => {
    const reach = reachableOutcomes(cricket, cricket.variants.t20, "league");
    expect(sorted(reach)).toEqual(["loss.regulation", "noResult", "tie", "win.regulation"]);
    const noTie = PointsRule.parse({ win: { regulation: 2 }, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole" });
    expect(coverage(noTie, reach)).toEqual({ ok: false, uncovered: ["tie"], inapplicable: [] });
    expect(coverage(PointsRule.parse({ ...noTie, tie: 1 }), reach)).toEqual({ ok: true });
  });

  it("each reachable draw and shoot-out key is asked on its own: {draw}, {win.so}, {loss.so} alone (counted)", () => {
    const noDraw = PointsRule.parse({ win: { regulation: 3 }, loss: { regulation: 0 }, shootoutAs: "draw_plus_bonus", unit: "whole" });
    let checked = 0;
    for (const [keys, uncovered] of [
      [["draw"], ["draw"]],
      [["win.so"], ["draw"]],
      [["loss.so"], ["draw"]],
      [["win.regulation", "loss.regulation"], null],
    ] as const) {
      const got = coverage(noDraw, new Set<OutcomeKey>(keys));
      expect(got, keys.join(",")).toEqual(uncovered === null ? { ok: true } : { ok: false, uncovered, inapplicable: [] });
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("I1 a bySetScore map is refused (inapplicable ['bySetScore']) on every sport that declares no set score; the set-table sports take it (registry, counted)", () => {
    let checked = 0;
    const accepting: string[] = [];
    expect(
      forEachSport(({ key, module }) => {
        const reach = reachableOutcomes(module, Object.values(module.variants)[0] ?? {}, "league");
        const base = PointsRule.parse({ win: { regulation: 3 }, loss: { regulation: 0 }, draw: 1, tie: 1, shootoutAs: module.shootoutAs, unit: "whole", bonuses: [] });
        expect(coverage(base, reach), key).toEqual({ ok: true }); // premise: the same rule without the map is covered
        const got = coverage(PointsRule.parse({ ...base, bySetScore: { "*": [3, 0] } }), reach);
        if (got.ok) accepting.push(key);
        else expect(got, key).toEqual({ ok: false, uncovered: [], inapplicable: ["bySetScore"] });
        checked++;
      }),
    ).toBe(SPORTS);
    expect(checked).toBe(SPORTS);
    // FIVB, BWF and ITTF rank a table by set score; tennis keeps sets_won but ranks on wins (no set table)
    expect(accepting.sort()).toEqual(["badminton", "tabletennis", "volleyball"]);
  });

  it("I1 football and tennis: coverage refuses the map exactly where payout would throw on the first win; the refusal sits beside an uncovered outcome; the empty set is still covered", () => {
    const map = { "2-0": [3, 0], "2-1": [2, 1] };
    const fbMap = FB({ bySetScore: map });
    expect(coverage(fbMap, reachableOutcomes(football, {}, "league"))).toEqual({ ok: false, uncovered: [], inapplicable: ["bySetScore"] });
    expect(() => payout(win("H"), "regulation", pair(2, 0), true, fbMap, undefined, setsToWinOf(football, {}))).toThrowError(CONFIG_INVALID);
    // tennis records the sets a set map would read, and still has no set table: refused, and payout agrees
    const tnMap = TT({ bySetScore: map });
    expect(coverage(tnMap, reachableOutcomes(tennis, {}, "league"))).toEqual({ ok: false, uncovered: [], inapplicable: ["bySetScore"] });
    expect(() => payout(win("H"), "regulation", sets(2, 1), true, tnMap, undefined, setsToWinOf(tennis, {}))).toThrowError(/keeps no set score/);
    // both questions answered at once: football's draw is uncovered AND its map inapplicable
    const noDraw = PointsRule.parse({ win: { regulation: 3 }, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bySetScore: map });
    expect(coverage(noDraw, reachableOutcomes(football, {}, "league"))).toEqual({ ok: false, uncovered: ["draw"], inapplicable: ["bySetScore"] });
    // the empty case first: no reachable outcome, nothing to refuse
    expect(coverage(fbMap, new Set())).toEqual({ ok: true });
  });

  it("an override that only removes outcomes (football extra time off) stays covered", () => {
    const stage = reachableOutcomes(football, { extraTime: { enabled: true, halfMinutes: 15 }, shootout: true }, "group");
    const override = reachableOutcomes(football, { extraTime: { enabled: false, halfMinutes: 15 }, shootout: true }, "group");
    expect([...override].every((k) => stage.has(k))).toBe(true);
    expect(override.size).toBeLessThan(stage.size);
    expect(coverage(FB(), stage)).toEqual({ ok: true });
    expect(coverage(FB(), override)).toEqual({ ok: true });
  });

  it("the one mapper: a stored no_result outcome is asked of the reachable set as noResult (cricket; reach.has(kind) misses it)", () => {
    // single-sport: cricket is the one sport that records a no result (the mapper's only reader)
    const reach = reachableOutcomes(cricket, cricket.variants.t20, "league");
    expect((reach as ReadonlySet<string>).has("no_result")).toBe(false); // the trap the mapper exists for
    let checked = 0;
    for (const f of corpusFixtures("cricket")) {
      const k = f.outcome.kind;
      if (k !== "draw" && k !== "tie" && k !== "no_result") continue;
      if (k === "draw") continue; // a two-innings draw is reachable only under inningsPerSide 2 (asked below)
      expect(reach.has(levelOutcomeKey(k)), k).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(1); // the corpus records a tie and no results
    expect(levelOutcomeKey("no_result")).toBe("noResult");
    expect(reachableOutcomes(cricket, { inningsPerSide: 2 }, "league").has(levelOutcomeKey("draw"))).toBe(true);
  });

  it("every decided league outcome in each sport's golden corpus is reachable under its recorded cfg (every sport, counted)", () => {
    // The real producers: each sport's recorded fold (outcome + league delta pair), against `reachableOutcomes`.
    let checked = 0;
    let settledSetScores = 0;
    const missed: string[] = [];
    const n = forEachSport(({ key, module }) => {
      const configs = readCorpus(key).configs;
      for (const f of corpusFixtures(key)) {
        const reach = reachableOutcomes(module, configs[f.config], "league");
        const o = f.outcome;
        const keys: OutcomeKey[] = [];
        if (o.kind === "win" && o.method !== "walkover" && o.method !== "forfeit") {
          const d = decidedInFor(module, o)!;
          keys.push(`win.${d}`, `loss.${d}`);
        } else if (o.kind === "draw" || o.kind === "tie" || o.kind === "no_result") {
          keys.push(levelOutcomeKey(o.kind));
        } else if (o.kind === "award" || o.kind === "win") {
          keys.push("win.regulation", module.declaresUnplayedLoss === true ? "loss.unplayed" : "loss.regulation");
        }
        // A table settle of an abandoned set match (`settled_<method>`, W2c X-AB-5) decides a winner over the sets played
        // so far — 1-2, 1-1 — which no `bestOf` ends on. FIVB 6.4.3 (I2) pays it as a team declared incomplete: the
        // winner's count completed to ⌈bestOf/2⌉ (the rulebook's majority, from the recorded cfg), the other side's kept —
        // a reachable final score, paid under an explicit map with no "*" (every reachable score its own pair).
        const settled = o.kind === "win" && o.method?.startsWith("settled_") === true;
        if (module.reachableSetScores !== undefined && (o.kind === "win" || (o.kind === "award" && o.loser !== null))) {
          const w = f.pair.find((d) => d.won === 1)!;
          if (settled) {
            const toWin = Math.ceil((module.configSchema.parse(configs[f.config]) as { bestOf: number }).bestOf / 2);
            expect(w.metrics.sets_won!, `${key} settle before the end`).toBeLessThan(toWin);
            const completed = `${toWin}-${w.metrics.sets_lost!}` as const;
            keys.push(`set:${completed}`);
            const explicit = Object.fromEntries([...reach].filter((k) => k.startsWith("set:")).map((k, i) => [k.slice(4), [100 + i, i] as [number, number]]));
            const want = explicit[completed];
            expect(want, `${key}/${f.config} ${completed}`).toBeDefined();
            const rule = PointsRule.parse({ win: { regulation: -1 }, loss: { regulation: -1 }, shootoutAs: "result", unit: "whole", bySetScore: explicit });
            const paid = payout(o, decidedInFor(module, o), f.pair, true, rule, module.awardScoreKeys, setsToWinOf(module, configs[f.config]));
            expect(pts(paid), `${key} ${completed}`).toEqual(f.pair.map((d) => (d.won === 1 ? want![0] : want![1])));
            settledSetScores++;
          } else keys.push(`set:${w.metrics.sets_won!}-${w.metrics.sets_lost!}`);
        }
        for (const k of keys) if (!reach.has(k)) missed.push(`${key}/${f.config} ${JSON.stringify(o)} → ${k}`);
        checked++;
      }
    });
    expect(n).toBe(SPORTS);
    expect(missed.join("\n")).toBe("");
    expect(checked).toBeGreaterThan(SPORTS);
    expect(settledSetScores).toBeGreaterThan(0); // the set corpora record settles: the FIVB 6.4.3 arm is reached for real
  });

  it("setsToWinOf: a set-table sport's ⌈bestOf/2⌉ from the cfg (each × bestOf 1/3/5/7); undefined for every other sport (registry, counted)", () => {
    let checked = 0;
    const setSports: string[] = [];
    expect(
      forEachSport(({ key, module }) => {
        const variant = Object.values(module.variants)[0] ?? {};
        if (module.reachableSetScores === undefined) {
          expect(setsToWinOf(module, variant), key).toBeUndefined();
          checked++;
          return;
        }
        setSports.push(key);
        for (const bestOf of [1, 3, 5, 7]) {
          expect(setsToWinOf(module, { ...(variant as Raw), bestOf }), `${key} bo${bestOf}`).toBe(Math.ceil(bestOf / 2));
          checked++;
        }
      }),
    ).toBe(SPORTS);
    expect(setSports.sort()).toEqual(["badminton", "tabletennis", "volleyball"]);
    expect(checked).toBe(SPORTS - 3 + 3 * 4);
  });
});

describe("pointsRuleBounds, legacyPointsRule, parseStoredPointsRule", () => {
  it("pointsRuleBounds over IIHF reachable outcomes is {min 0, max 3}; football draw_plus_bonus with so is {min 0, max 3}", () => {
    const iihf = reachableOutcomes(icehockey, icehockey.variants.iihf, "league");
    expect(sorted(iihf)).toEqual(["loss.ot", "loss.regulation", "loss.so", "win.ot", "win.regulation", "win.so"]);
    expect(pointsRuleBounds(IIHF(), iihf)).toMatchObject({ min: 0, max: 3, winFloor: 2, lossCeil: 1, winsOnly: false });
    const fb = reachableOutcomes(football, { shootout: true }, "group");
    // a shoot-out loser is paid the draw (1): the most a lost match can still pay; a shoot-out win the least a win pays (2)
    expect(pointsRuleBounds(FB(), fb)).toMatchObject({ min: 0, max: 3, winFloor: 2, lossCeil: 1, winsOnly: false });
    // without the shoot-out, a lost football match pays 0 and every win 3
    expect(pointsRuleBounds(FB(), reachableOutcomes(football, {}, "league"))).toMatchObject({ min: 0, max: 3, winFloor: 3, lossCeil: 0 });
  });

  it("pointsRuleBounds contains every value payout pays over the reachable outcomes of every sport's corpus (counted)", () => {
    let checked = 0;
    const outside: string[] = [];
    const rule = (m: AnySportModule): PointsRule =>
      PointsRule.parse({
        win: { regulation: 3, ...(m.shootoutAs === "result" ? { ot: 2, so: 2 } : {}) },
        loss: { regulation: 0, ...(m.shootoutAs === "result" ? { ot: 1, so: 1 } : {}), ...(m.declaresUnplayedLoss ? { unplayed: -1 } : {}) },
        draw: 1,
        tie: 1,
        noResult: 1,
        shootoutAs: m.shootoutAs,
        ...(m.reachableSetScores !== undefined ? { bySetScore: { "*": [3, 0], "2-1": [2, 1], "3-2": [2, 1] } } : {}),
        unit: "whole",
        bonuses: [{ when: "draw", points: 0.5 }],
        forfeit: { winnerPoints: 4, loserPoints: -2 },
      });
    forEachSport(({ key, module }) => {
      const configs = readCorpus(key).configs;
      const r = rule(module);
      for (const f of corpusFixtures(key)) {
        const b = pointsRuleBounds(r, reachableOutcomes(module, configs[f.config], "league"));
        for (const played of [false, true]) {
          for (const d of payout(f.outcome, decidedInFor(module, f.outcome), f.pair, played, r, module.awardScoreKeys, setsToWinOf(module, configs[f.config]))) {
            if (d.points < b.min || d.points > b.max) outside.push(`${key} ${JSON.stringify(f.outcome)} ${d.points} ∉ [${b.min}, ${b.max}]`);
            checked++;
          }
        }
      }
    });
    expect(outside).toEqual([]);
    expect(checked).toBeGreaterThan(SPORTS * 4);
  });

  it("pointsRuleBounds is exact for each outcome class, from the rule's own numbers (empty reachable, ot, so both bookings, set maps, unplayed, level results, draw-class bonuses; counted)", () => {
    const R = (raw: Raw): PointsRule => PointsRule.parse({ shootoutAs: "result", unit: "whole", ...raw });
    const reach = (...keys: string[]) => new Set(keys as OutcomeKey[]);
    type B = { max: number; min: number; winFloor: number; lossCeil: number; winsOnly: boolean };
    // Each expectation is read off the rule: the award's credited win and loss always, each reachable win.<d>/loss.<d> by
    // the chain, a booked shoot-out's draw + soBonus / draw, the reachable level results, the double walkover's 0.
    const cases: [string, PointsRule, ReadonlySet<OutcomeKey>, B][] = [
      ["empty reachable: the award's 3/1 and the double walkover's 0 only (ot values unreachable)",
        R({ win: { regulation: 3, ot: 2 }, loss: { regulation: 1, ot: 2 } }), reach(),
        { max: 3, min: 0, winFloor: 3, lossCeil: 1, winsOnly: false }],
      ["ot reachable under draw_plus_bonus pays ot (only the so link is booked drawn)",
        R({ win: { regulation: 3, ot: 2 }, loss: { regulation: 0, ot: 1 }, draw: 1, shootoutAs: "draw_plus_bonus" }),
        reach("win.regulation", "loss.regulation", "win.ot", "loss.ot", "draw"),
        { max: 3, min: 0, winFloor: 2, lossCeil: 1, winsOnly: false }],
      ["a booked shoot-out reached by win.so alone: winner draw 1 + soBonus 2, loser draw 1",
        R({ win: { regulation: 3 }, loss: { regulation: 0 }, draw: 1, soBonus: 2, shootoutAs: "draw_plus_bonus" }), reach("win.so"),
        { max: 3, min: 0, winFloor: 3, lossCeil: 1, winsOnly: false }],
      ["...and by loss.so alone",
        R({ win: { regulation: 3 }, loss: { regulation: 0 }, draw: 1, soBonus: 2, shootoutAs: "draw_plus_bonus" }), reach("loss.so"),
        { max: 3, min: 0, winFloor: 3, lossCeil: 1, winsOnly: false }],
      ["a booked shoot-out with no draw pays nothing here (payout refuses it)",
        R({ win: { regulation: 3 }, loss: { regulation: 0 }, shootoutAs: "draw_plus_bonus" }), reach("win.so", "loss.so"),
        { max: 3, min: 0, winFloor: 3, lossCeil: 0, winsOnly: true }],
      ["a result-booked shoot-out pays its so split 5/4",
        R({ win: { regulation: 3, so: 5 }, loss: { regulation: 0, so: 4 }, draw: 1 }), reach("win.so", "loss.so"),
        { max: 5, min: 0, winFloor: 3, lossCeil: 4, winsOnly: false }],
      ["a set map pays the reachable scores' pairs, never win/loss.regulation 7 nor an unreachable key's 9/9",
        R({ win: { regulation: 7 }, loss: { regulation: 7 }, bySetScore: { "3-0": [3, 0], "3-1": [3, 0], "3-2": [2, 1], "2-0": [9, 9] } }),
        reach("set:3-0", "set:3-1", "set:3-2"),
        { max: 3, min: 0, winFloor: 2, lossCeil: 1, winsOnly: false }],
      ["a score the map does not name pays '*' (and a level key reads no set pair)",
        R({ win: { regulation: 7 }, loss: { regulation: 7 }, bySetScore: { "*": [2, 0], "3-2": [1, 1] } }), reach("set:3-0", "draw"),
        { max: 2, min: 0, winFloor: 2, lossCeil: 0, winsOnly: true }],
      ["a non-set key never reads '*' as a set pair",
        R({ win: { regulation: 7 }, loss: { regulation: 7 }, bySetScore: { "3-0": [3, 0], "*": [1, 1] } }), reach("set:3-0", "loss.unplayed"),
        { max: 3, min: 0, winFloor: 3, lossCeil: 0, winsOnly: true }],
      ["a score neither named nor starred pays nothing here",
        R({ win: { regulation: 7 }, loss: { regulation: 7 }, bySetScore: { "3-0": [3, 0] } }), reach("set:3-0", "set:3-1"),
        { max: 3, min: 0, winFloor: 3, lossCeil: 0, winsOnly: true }],
      ["a set map with no reachable score bounds every pair it names",
        R({ win: { regulation: 7 }, loss: { regulation: 7 }, bySetScore: { "2-0": [3, 0], "2-1": [2, 1] } }), reach(),
        { max: 3, min: 0, winFloor: 2, lossCeil: 1, winsOnly: false }],
      ["loss.unplayed -1 where reachable",
        R({ win: { regulation: 2 }, loss: { regulation: 1, unplayed: -1 } }), reach("win.regulation", "loss.regulation", "loss.unplayed"),
        { max: 2, min: -1, winFloor: 2, lossCeil: 1, winsOnly: false }],
      ["loss.unplayed set but not reachable pays nothing",
        R({ win: { regulation: 2 }, loss: { regulation: 1, unplayed: -1 } }), reach("win.regulation", "loss.regulation"),
        { max: 2, min: 0, winFloor: 2, lossCeil: 1, winsOnly: false }],
      ["loss.unplayed reachable but unset falls to the credited loss",
        R({ win: { regulation: 2 }, loss: { regulation: 1 } }), reach("win.regulation", "loss.regulation", "loss.unplayed"),
        { max: 2, min: 0, winFloor: 2, lossCeil: 1, winsOnly: false }],
      ["draw 5, tie 6, noResult 7 unreachable pay nothing",
        R({ win: { regulation: 3 }, loss: { regulation: 0 }, draw: 5, tie: 6, noResult: 7 }), reach("win.regulation", "loss.regulation"),
        { max: 3, min: 0, winFloor: 3, lossCeil: 0, winsOnly: true }],
      ["draw 5, tie 6, noResult 7 reachable",
        R({ win: { regulation: 3 }, loss: { regulation: 0 }, draw: 5, tie: 6, noResult: 7 }), reach("draw", "tie", "noResult"),
        { max: 7, min: 0, winFloor: 3, lossCeil: 0, winsOnly: false }],
      ["a reachable draw or tie the rule does not pay adds nothing",
        R({ win: { regulation: 3 }, loss: { regulation: 0 } }), reach("draw", "tie"),
        { max: 3, min: 0, winFloor: 3, lossCeil: 0, winsOnly: true }],
      ["a draw bonus of -1 lowers a booked shoot-out winner's floor (2 - 1)",
        FB({ bonuses: [{ when: "draw", points: -1 }] }), reach("win.so", "loss.so"),
        { max: 3, min: 0, winFloor: 1, lossCeil: 1, winsOnly: false }],
      ["a draw bonus of +2 raises a booked shoot-out loser's ceiling (1 + 2) and the winner's max (2 + 2)",
        FB({ bonuses: [{ when: "draw", points: 2 }] }), reach("win.so", "loss.so"),
        { max: 4, min: 0, winFloor: 2, lossCeil: 3, winsOnly: false }],
    ];
    let checked = 0;
    for (const [name, rule, reachable, want] of cases) {
      expect(pointsRuleBounds(rule, reachable), name).toEqual(want);
      checked++;
    }
    expect(checked).toBe(19);
  });

  it("legacyPointsRule({base:{win:3,draw:1,loss:0}}) pays a shoot-out win as a win (3/0), a tie 0, a no-result 0 (B1)", () => {
    const old = legacyPointsRule({ base: { win: 3, draw: 1, loss: 0 } });
    const [h, a] = payout(win("H", "shootout"), "so", pair(1, 1, "H"), true, old, undefined, undefined);
    expect([wdl(h), wdl(a)]).toEqual([[1, 0, 0, 3], [0, 0, 1, 0]]);
    expect(pts(payout(LEVEL("tie"), null, level(), true, old, undefined, undefined))).toEqual([0, 0]);
    expect(pts(payout(LEVEL("no_result"), null, level(), false, old, undefined, undefined))).toEqual([0, 0]);
    expect(pts(payout(LEVEL("draw"), null, level({}, 1), true, old, undefined, undefined))).toEqual([1, 1]);
    // the bonuses and the forfeit row are kept
    const kept = legacyPointsRule({ base: { win: 3, draw: 1, loss: 0 }, bonuses: [{ when: "no_result", points: 2 }], forfeit: { winnerPoints: 3, loserPoints: -1, awardScore: [3, 0] } });
    expect(kept.bonuses).toEqual([{ when: "no_result", points: 2 }]);
    expect(kept.forfeit).toEqual({ winnerPoints: 3, loserPoints: -1, awardScore: [3, 0] });
    expect(pts(payout(LEVEL("no_result"), null, level(), false, kept, undefined, undefined))).toEqual([2, 2]);
    // ...and a rule with no forfeit row has none: not even an undefined key (the stored shape is read back key for key)
    expect(Object.hasOwn(old, "forfeit")).toBe(false);
    expect(old).toStrictEqual(PointsRule.parse({ win: { regulation: 3 }, loss: { regulation: 0 }, draw: 1, tie: 0, noResult: 0, shootoutAs: "result", unit: "whole" }));
  });

  it("parseStoredPointsRule reads the new shape, the old shape through legacyPointsRule, and nothing else (null, never a throw)", () => {
    const now = { win: { regulation: 3 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "draw_plus_bonus", unit: "whole", bonuses: [] };
    expect(parseStoredPointsRule(now)).toEqual(PointsRule.parse(now));
    expect(parseStoredPointsRule({ base: { win: 2, draw: 1, loss: 0 } })).toEqual(legacyPointsRule({ base: { win: 2, draw: 1, loss: 0 } }));
    let checked = 0;
    for (const junk of [null, undefined, 3, "x", [], {}, { base: { win: "3" } }, { win: 3 }, { base: { win: 2, draw: 1, loss: 0 }, bonuses: [{ when: "nope", points: 1 }] }]) {
      expect(parseStoredPointsRule(junk), JSON.stringify(junk)).toBeNull();
      checked++;
    }
    expect(checked).toBe(9);
  });

  it("forfeitAwardOffer gives the identical ForfeitAward for every rule expressible before W2d (the W2c reading as the oracle, every sport, counted)", () => {
    // The W2c pipeline, frozen as the oracle: fixture-cfg.ts read the stored rule with W2c's own schema (`safeParse`)
    // and offered `forfeit.awardScore` (winner first) only where the module declares `awardScoreKeys`.
    const W2C = z.object({
      base: z.object({ win: z.number(), draw: z.number(), loss: z.number() }),
      bonuses: z.array(z.object({ when: z.string(), param: z.number().optional(), points: z.number() })).default([]),
      forfeit: z.object({ winnerPoints: z.number(), loserPoints: z.number(), awardScore: z.tuple([z.number(), z.number()]).optional() }).optional(),
    });
    const w2cOffer = (raw: unknown, m: AnySportModule): readonly [number, number] | undefined => {
      const r = W2C.safeParse(raw);
      const a = r.success ? r.data.forfeit?.awardScore : undefined;
      return a !== undefined && m.awardScoreKeys !== undefined ? [a[0], a[1]] : undefined;
    };
    const base = { win: 3, draw: 1, loss: 0 };
    const stored: unknown[] = [
      null,
      { base },
      { base, forfeit: { winnerPoints: 3, loserPoints: 0 } },
      { base, forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: [3, 0] } },
      { base, forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: [0, 0] } },
      { base, bonuses: [{ when: "draw", points: 1 }], forfeit: { winnerPoints: 2, loserPoints: -1, awardScore: [5, 2] }, stray: true },
      { base: { win: 2.5, draw: 1, loss: -0.5 }, forfeit: { winnerPoints: 1, loserPoints: 0, awardScore: [1, 0] } },
    ];
    let checked = 0;
    let offered = 0;
    expect(
      forEachSport(({ module }) => {
        for (const raw of stored) {
          const now = forfeitAwardOffer(parseStoredPointsRule(raw), module);
          expect(now, `${module.key} ${JSON.stringify(raw)}`).toEqual(w2cOffer(raw, module));
          if (now !== undefined) offered++;
          checked++;
        }
      }),
    ).toBe(SPORTS);
    expect(checked).toBe(SPORTS * stored.length);
    expect(offered).toBeGreaterThan(0); // the sports with awardScoreKeys take the award…
    expect(offered).toBeLessThan(checked); // …and the rest, and the rules with none, do not
  });
});
