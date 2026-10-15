// W2c Task 16 (X-PT-1, D12) - a stage's OWN points rule as ONE sentence on the public stage line
// (`server/public-site/stage-format-lines.ts`: the hub's Info tab and the division page's stage chips).
//
// The stage editor does NOT print it yet: a live preview there is a later task's, and this module is client-safe so
// that task can call it without a second wording. The result is a list of `Msg` clauses (dictionary key + params),
// like every format line: the surface resolves them against whichever dictionary it holds (`rulesLineText`,
// lib/rules-line.ts), and the joiner capitalises the sentence, so every clause here sits anywhere in a line and begins
// lowercase.
//
// CLIENT-SAFE on purpose: no `server-only`, no value import from the engine (`import type` is erased).
//
// WHAT IT SAYS, in order: the base points (win / draw / loss); the walkover row (the points the winner and the loser
// are paid); the SCORE a walkover is awarded (`forfeit.awardScore`), only where the caller states that the award reaches
// the sport's table (X-WO-1 part B, Task 16b); and how many bonus rules there are (counted, not listed - the public line
// is a sentence, not a table).
//
// THE AWARDED SCORE is said only on `awardReaches`: the engine's `pointsRuleAwardReachesTable(module)`, which this
// client-safe file cannot import (no value import from the engine). That is the same declaration that lets the sport's
// fold read the rule's award on a walkover nobody played, so the number on the line is the number on the headline and in
// the table. A sport the award never reaches (the set sports, carrom, the board games, cricket) or a retired module (none
// to ask) says nothing of it: a score the headline cannot show would be a second number for one walkover. Task 16 part A
// printed it unconditionally and its fix round 1 (I-1) took it out for exactly that contradiction.
//
// WHAT IT NEVER SAYS: a number it cannot read. `public_stages_v` rebuilds the rule from only the keys `PointsRule` reads,
// but a hand-edited or pre-schema row can still reach it malformed; a missing or non-numeric part says nothing about
// itself, never a confident 0. Every number is checked finite (`Number.isFinite` never coerces: "3" is no number).
import type { PointsRule } from "@seazn/engine/competition";

/** A clause: a dictionary key and its params (`Msg`'s shape, `lib/rules-line.ts`'s `RulesClause`). */
export interface PointsClause {
  key: string;
  params?: Record<string, number>;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const record = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export interface PointsLineOptions {
  /** The engine's `pointsRuleAwardReachesTable(module)` for the stage's sport: the rule's `forfeit.awardScore` is read by
   *  its table and its walkover headline, so the line may say it. Absent/false: never said. */
  awardReaches?: boolean;
}

export function pointsLine(rule: PointsRule, opts: PointsLineOptions = {}): PointsClause[] {
  const r = record(rule);
  const base = record(r?.base);
  // The base is the sentence's head: without all three numbers there is nothing honest to say.
  if (!isNum(base?.win) || !isNum(base?.draw) || !isNum(base?.loss)) return [];
  const out: PointsClause[] = [{ key: "format.points.base", params: { win: base.win, draw: base.draw, loss: base.loss } }];

  const forfeit = record(r?.forfeit);
  if (isNum(forfeit?.winnerPoints) && isNum(forfeit?.loserPoints)) {
    out.push({ key: "format.points.forfeit", params: { winner: forfeit.winnerPoints, loser: forfeit.loserPoints } });
    const score = forfeit.awardScore;
    if (opts.awardReaches === true && Array.isArray(score) && score.length === 2 && isNum(score[0]) && isNum(score[1]))
      out.push({ key: "format.points.forfeitScore", params: { winner: score[0], loser: score[1] } });
  }

  const bonuses = Array.isArray(r?.bonuses) ? r.bonuses.length : 0;
  if (bonuses === 1) out.push({ key: "format.points.bonus" });
  else if (bonuses > 1) out.push({ key: "format.points.bonuses", params: { n: bonuses } });
  return out;
}
