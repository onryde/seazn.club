import "server-only";
import { payout, setsToWinOf, type PointsRule } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import type { MatchOutcome, StandingsDelta } from "@seazn/engine/core";

/**
 * W3 app-B T7 (X-SW-11; rulebook-W3-swiss.md §4 "Win points means the table's `win` value"; FIDE C.04.3 (1 Feb 2026) Art. 1.8):
 * the most TABLE POINTS one fixture can pay one side under `rule` - bonuses included. A Swiss final round's topscorer line is
 * "over half of the most an entrant could have scored" (`SwissConstraints.finalRoundMaxScore`), in the units of the pairing
 * score; the pairing score is the stage's table points (`stageTablePoints`, T5), which include every bonus the rule pays, so
 * this maximum has to include them too. One bonus policy for the score and for the maximum.
 *
 * Never a hand formula (`rule.win.regulation`, or a clean-sweep lookup in `bySetScore`): a formula is a second authority that
 * drifts the moment a rule pays a bonus. This calls the engine's own `payout` - the very call `loadStageInputs` pays every
 * decided fixture with (`engine-db/competition.ts`) - on a REGULATION WIN with the CLEAN-SWEEP result of the sport's format
 * (`setsToWinOf(module, cfg)` sets to none; a sport with no set table has no set score to carry), and takes the winner's
 * points. The winner's margin is the largest a score can show (`Number.MAX_SAFE_INTEGER`), so a margin bonus the rule pays is
 * in the number; a bonus that pays a loser, a draw or a forfeit is not (this fixture is a played win).
 *
 * `cfg` is the stage's merged format (the division's cfg with the stage's rules): it is parsed through the sport's schema, as
 * every fixture's own cfg is, so a best-of-five and a best-of-three sweep differently under a set-score map. A `bySetScore`
 * rule on a sport that keeps no set score is refused by the engine (CONFIG_INVALID, `coverage` refuses it at save): never read
 * as `win.regulation`.
 */
export function maxRoundPoints(rule: PointsRule, module: AnySportModule, cfg: unknown): number {
  const setsToWin = setsToWinOf(module, cfg);
  // The largest margin a score can show, under the one key `payout`'s margin bonus reads first (`DIFF_KEYS`).
  const winner: StandingsDelta = {
    entrantId: "max-round-points:winner",
    played: 1,
    won: 1,
    drawn: 0,
    lost: 0,
    points: 0,
    metrics: { ...(setsToWin === undefined ? {} : { sets_won: setsToWin, sets_lost: 0 }), diff: Number.MAX_SAFE_INTEGER },
  };
  const loser: StandingsDelta = {
    entrantId: "max-round-points:loser",
    played: 1,
    won: 0,
    drawn: 0,
    lost: 1,
    points: 0,
    metrics: { ...(setsToWin === undefined ? {} : { sets_won: 0, sets_lost: setsToWin }), diff: -Number.MAX_SAFE_INTEGER },
  };
  const outcome: MatchOutcome = { kind: "win", winner: winner.entrantId, loser: loser.entrantId };
  const [paid] = payout(outcome, "regulation", [winner, loser], true, rule, module.awardScoreKeys, setsToWin);
  return paid.points;
}
