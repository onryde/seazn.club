// W2c Task 9 (X-PT-1) — one rule, two readers. The standings fold scores a forfeit through `payout`; the public
// qualification view decides whether the rule's awarded score is in a match's ledger through `ruleScoreReaches`. They
// must agree on every award shape: a disagreement makes the what-if count a match the table never scored (or skip one it
// did). The expected side is the ENGINE's answer (`payout` changed the score), never a table typed here.
import { describe, expect, it } from "vitest";
import { AWARD_REASONS, type MatchOutcome } from "@seazn/engine/core";
import { payout, PointsRule, type FixtureResult } from "@seazn/engine/competition";
import { byeAward } from "@/lib/fixture-bye";
import { builtinModules } from "@seazn/engine/sports";
import { divisionAwardAddsToLedger, pointsRuleScoresForfeits, ruleScoreReaches, type StageQualMeta } from "../qualification-view";

const rule = PointsRule.parse({ win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [3, 0] } });
const meta = (pointsRule: unknown): StageQualMeta => ({
  qualifyCount: 2,
  qualifyPerGroup: false,
  nextStageName: "Finals",
  swissRounds: null,
  pointsRule,
  hasRankOverrides: false,
});
/** The sport's credit before the rule: a 1–0 the awarded 3–0 is told apart from. */
const pair = (): FixtureResult => [
  { entrantId: "H", played: 1, won: 1, drawn: 0, lost: 0, points: 0, metrics: { for: 1, against: 0, diff: 1 } },
  { entrantId: "A", played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: { for: 0, against: 1, diff: -1 } },
];
/** The pair is generic-shaped (its own score keys ARE for/against/diff), so no further score keys are named. */
const scoreChanged = (outcome: MatchOutcome, played: boolean, r = rule): boolean =>
  payout(outcome, outcome.kind === "win" ? "regulation" : null, pair(), played, r, undefined)[0].metrics.for !== 1;

describe("X-PT-1 qualification-view agrees with payout on where the awarded score lands", () => {
  it("empty case first: no stage rule, or a rule with no awarded score, reaches nothing — every award reason × played (counted)", () => {
    const noScore = PointsRule.parse({ win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", forfeit: { winnerPoints: 2, loserPoints: 0 } });
    let checked = 0;
    for (const reason of AWARD_REASONS)
      for (const played of [false, true]) {
        const outcome = { kind: "award", winner: "H", loser: reason === "bye" ? null : "A", reason } as MatchOutcome;
        const f = { outcome, played, home_entrant_id: "H", away_entrant_id: reason === "bye" ? null : "A" };
        expect(ruleScoreReaches(f, meta(null)), `${reason}/played=${played}: no rule`).toBe(false);
        expect(scoreChanged(outcome, played, noScore), `${reason}/played=${played}: premise, no awarded score`).toBe(false);
        expect(ruleScoreReaches(f, meta(noScore)), `${reason}/played=${played}: a rule with no awarded score`).toBe(false);
        checked++;
      }
    expect(checked).toBe(AWARD_REASONS.length * 2);
    expect([pointsRuleScoresForfeits(null), pointsRuleScoresForfeits(noScore)], "no rule, no awarded score: nothing scores").toEqual([false, false]);
  });

  it("every award reason × played (counted): ruleScoreReaches ⇔ payout changed the score", () => {
    let checked = 0;
    let reached = 0;
    for (const reason of AWARD_REASONS)
      for (const played of [false, true]) {
        const outcome = { kind: "award", winner: "H", loser: reason === "bye" ? null : "A", reason } as MatchOutcome;
        const f = { outcome, played, home_entrant_id: "H", away_entrant_id: reason === "bye" ? null : "A" };
        const changed = scoreChanged(outcome, played);
        expect(ruleScoreReaches(f, meta(rule)), `${reason}/played=${played}`).toBe(changed);
        checked++;
        if (changed) reached++;
      }
    expect(checked).toBe(AWARD_REASONS.length * 2);
    // Both answers occur, so the sweep is no constant: every forfeit reason with nothing played, plus the walkover after
    // a Start (a walkover is nothing played, whatever the ledger reads), and nothing else.
    expect(reached).toBeGreaterThan(0);
    expect(reached).toBeLessThan(checked);
  });

  it("a stored pre-W2b award (no reason, no loser) is the bye it was in both readers; a seated walkover method is a walkover in both", () => {
    const cases: { outcome: MatchOutcome; away: string | null }[] = [
      { outcome: { kind: "award", winner: "H" } as MatchOutcome, away: null },
      { outcome: { kind: "award", winner: "H" } as MatchOutcome, away: "A" },
      { outcome: { kind: "award", winner: "H", method: "walkover" } as unknown as MatchOutcome, away: "A" },
    ];
    let checked = 0;
    for (const { outcome, away } of cases)
      for (const played of [false, true]) {
        const f = { outcome, played, home_entrant_id: "H", away_entrant_id: away };
        expect(ruleScoreReaches(f, meta(rule)), `${JSON.stringify(outcome)}/${away}/played=${played}`).toBe(scoreChanged(outcome, played));
        checked++;
      }
    expect(checked).toBe(cases.length * 2);
  });

  it("a one-sided award is the fold's bye path, whatever it carries: the fold scores it as `byeAward` with nothing played, so neither reader scores it", () => {
    // engine-db/competition.ts routes every one-sided award to `awardByeDelta`, which hands the rule the TYPED bye
    // (`byeAward`), never the stored outcome — so the expected side is that call, not the stored outcome's.
    const viaByePath = scoreChanged(byeAward("H") as MatchOutcome, false);
    let checked = 0;
    for (const outcome of [
      { kind: "award", winner: "H", loser: null, reason: "bye" },
      { kind: "award", winner: "H" },
      { kind: "award", winner: "H", method: "walkover" },
    ] as unknown as MatchOutcome[])
      for (const played of [false, true]) {
        expect(ruleScoreReaches({ outcome, played, home_entrant_id: "H", away_entrant_id: null }, meta(rule)), `${JSON.stringify(outcome)}/played=${played}`).toBe(viaByePath);
        checked++;
      }
    expect(checked).toBe(6);
    expect(viaByePath, "premise: the bye path pays no awarded score").toBe(false);
  });

  it("a rule awarding 0–0 is a scoring award: it replaces the sport's credit, so both readers place it where a scored rule's lands (fix round 2)", () => {
    // A SET awardScore is a score, 0–0 included: `payout` writes it whenever it is set, so the view must read it
    // as one. Expected side: the engine's write, and the placement of the scored rule's — never a typed table.
    const zero = PointsRule.parse({ win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [0, 0] } });
    const walkover = { kind: "award", winner: "H", loser: "A", reason: "walkover" } as MatchOutcome;
    expect(scoreChanged(walkover, false, zero), "premise: the engine writes the awarded 0–0 over the 1–0 credit").toBe(true);
    expect(pointsRuleScoresForfeits(zero), "the gate the played-facts loader and a retired build read").toBe(true);
    let checked = 0;
    let reached = 0;
    for (const reason of AWARD_REASONS)
      for (const played of [false, true]) {
        const outcome = { kind: "award", winner: "H", loser: reason === "bye" ? null : "A", reason } as MatchOutcome;
        const f = { outcome, played, home_entrant_id: "H", away_entrant_id: reason === "bye" ? null : "A" };
        const changed = scoreChanged(outcome, played, zero);
        expect(ruleScoreReaches(f, meta(zero)), `${reason}/played=${played}`).toBe(changed);
        expect(changed, `${reason}/played=${played}: lands where the scored rule's lands`).toBe(scoreChanged(outcome, played));
        checked++;
        if (changed) reached++;
      }
    expect(checked).toBe(AWARD_REASONS.length * 2);
    expect(reached).toBeGreaterThan(0);
    expect(reached).toBeLessThan(checked);
  });

  it("guard for `ruleScoreInAverage` reading only `for`: every sport declaring other score keys credits its ledger on a walkover at its schema's floor, and refuses a 0-goal award", () => {
    // Since gap (a) the rule also writes a sport's declared keys (`gf`), which `ruleScoreInAverage` does not tell; the
    // what-if still counts such an award because `ledgerless` falls through to `awardAddsToLedger`. That holds only
    // while no such sport's walkover can credit nothing — swept over the registry, at the lowest award the schema admits.
    let checked = 0;
    for (const m of builtinModules) {
      const keys = m.awardScoreKeys;
      if (keys === undefined || keys.for === "for") continue;
      const floor = { awardScore: { goals: 1 } };
      expect(m.configSchema.safeParse(floor).success, `${m.key}: premise, the floor parses`).toBe(true);
      expect(divisionAwardAddsToLedger(m, floor), `${m.key}: a 1-goal walkover credits the ledger`).toBe(true);
      expect(divisionAwardAddsToLedger(m, {}), `${m.key}: the default walkover credits the ledger`).toBe(true);
      expect(m.configSchema.safeParse({ awardScore: { goals: 0 } }).success, `${m.key}: a 0-goal award is refused`).toBe(false);
      checked++;
    }
    expect(checked, "sports whose declared score keys are not `for`").toBeGreaterThan(0);
  });

  it("an open fixture (no outcome) reaches nothing, played or not", () => {
    for (const played of [false, true]) {
      expect(ruleScoreReaches({ outcome: null, played, home_entrant_id: "H", away_entrant_id: "A" }, meta(rule))).toBe(false);
    }
  });
});
