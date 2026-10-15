// W2c Task 16 (X-PT-1, D12) - a stage's OWN points rule as ONE sentence.
//
// The public stage line (`server/public-site/stage-format-lines.ts`) and the stage editor's live preview both print it,
// so the two cannot word one rule two ways. The result is a list of `Msg` clauses (dictionary key + params), like every
// format line: the surface resolves them against whichever dictionary it holds (`rulesLineText`, lib/rules-line.ts), and
// the joiner capitalises the sentence, so every clause here sits anywhere in a line and begins lowercase.
//
// CLIENT-SAFE on purpose: no `server-only`, no value import from the engine (`import type` is erased). The editor is a
// client component.
//
// WHAT IT SAYS, in order: the base points (win / draw / loss); how many bonus rules there are (counted, not listed - the
// public line is a sentence, not a table); the walkover row (winner's points - loser's points); and the score a walkover
// is awarded, when the rule sets one (X-WO-1: the stage rule's award, the one number every surface prints).
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

export function pointsLine(rule: PointsRule): PointsClause[] {
  const r = record(rule);
  const base = record(r?.base);
  // The base is the sentence's head: without all three numbers there is nothing honest to say.
  if (!isNum(base?.win) || !isNum(base?.draw) || !isNum(base?.loss)) return [];
  const out: PointsClause[] = [{ key: "format.points.base", params: { win: base.win, draw: base.draw, loss: base.loss } }];

  const forfeit = record(r?.forfeit);
  if (isNum(forfeit?.winnerPoints) && isNum(forfeit?.loserPoints)) {
    out.push({ key: "format.points.forfeit", params: { winner: forfeit.winnerPoints, loser: forfeit.loserPoints } });
    const score = forfeit.awardScore;
    if (Array.isArray(score) && score.length === 2 && isNum(score[0]) && isNum(score[1]))
      out.push({ key: "format.points.forfeitScore", params: { winner: score[0], loser: score[1] } });
  }

  const bonuses = Array.isArray(r?.bonuses) ? r.bonuses.length : 0;
  if (bonuses === 1) out.push({ key: "format.points.bonus" });
  else if (bonuses > 1) out.push({ key: "format.points.bonuses", params: { n: bonuses } });
  return out;
}
