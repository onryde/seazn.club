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
// WHAT IT SAYS, in order: the base points (win / draw / loss; win / loss where the rule pays no draw), or - for a rule
// that pays by set score - the map, which is the whole table (each score's pair, then "any other score"); W2d M5: an
// overtime split and a shoot-out split (each side falling back so -> ot -> regulation, D9), or a draw-plus-bonus
// shoot-out's bonus where the rule sets one; the walkover row (the points the winner and the loser are paid); the SCORE
// a walkover is awarded (`forfeit.awardScore`), only where the caller states that the award reaches the sport's table
// (X-WO-1 part B, Task 16b); and how many bonus rules there are (counted, not listed - the public line is a sentence,
// not a table). Not yet said (routed past W2d T2): `loss.unplayed`, cricket's `tie` and `noResult`.
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

/** W2d: a regulation win / draw / regulation loss off the outcome-keyed rule (`win.regulation`, `draw`, `loss.regulation`),
 *  or off a W2c `base` a stored row still carries until it is converted (W2d Task 7). */
function headOf(r: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const base = record(r?.base);
  if (base !== undefined) return base;
  return { win: record(r?.win)?.regulation, draw: r?.draw, loss: record(r?.loss)?.regulation };
}

/** An absent split falls back to `fallback`; a present one that is no number (null, "2") stays as it is, so it is never
 *  said - never the fallback's number in its place. */
const or = (v: unknown, fallback: unknown): unknown => (v === undefined ? fallback : v);

const SET_KEY = /^(\d+)-(\d+)$/;
/** W2d M5: a `bySetScore` map as clauses, each named score in order, then "any other score". `undefined` for a map with
 *  a key or a pair it cannot read: a table missing a row is no table. */
function setScoreClauses(map: Record<string, unknown>): PointsClause[] | undefined {
  const named: { won: number; lost: number; pair: [number, number] }[] = [];
  let other: [number, number] | undefined;
  for (const [key, value] of Object.entries(map)) {
    if (!Array.isArray(value) || value.length !== 2 || !isNum(value[0]) || !isNum(value[1])) return undefined;
    const pair: [number, number] = [value[0], value[1]];
    if (key === "*") {
      other = pair;
      continue;
    }
    const m = SET_KEY.exec(key);
    if (m === null) return undefined;
    named.push({ won: Number(m[1]), lost: Number(m[2]), pair });
  }
  named.sort((a, b) => a.won - b.won || a.lost - b.lost);
  const out: PointsClause[] = named.map(({ won, lost, pair }) => ({
    key: "format.points.setScore",
    params: { won, lost, winner: pair[0], loser: pair[1] },
  }));
  if (other !== undefined) out.push({ key: "format.points.setScoreOther", params: { winner: other[0], loser: other[1] } });
  return out;
}

/** W2d M5: the decided-beyond-regulation splits. An overtime clause where either side splits `ot`; a shoot-out booked as a
 *  result where either side splits `so` (each side so -> ot -> regulation); a draw-plus-bonus shoot-out's `soBonus` where
 *  the rule sets it (absent, it pays the default 1, which the line does not claim to know is reachable). */
function splitClauses(r: Record<string, unknown> | undefined): PointsClause[] {
  const win = record(r?.win);
  const loss = record(r?.loss);
  const out: PointsClause[] = [];
  if (win?.ot !== undefined || loss?.ot !== undefined) {
    const w = or(win?.ot, win?.regulation);
    const l = or(loss?.ot, loss?.regulation);
    if (isNum(w) && isNum(l)) out.push({ key: "format.points.ot", params: { win: w, loss: l } });
  }
  if (r?.shootoutAs === "draw_plus_bonus") {
    if (isNum(r.soBonus)) out.push({ key: "format.points.soBonus", params: { bonus: r.soBonus } });
  } else if (win?.so !== undefined || loss?.so !== undefined) {
    const w = or(win?.so, or(win?.ot, win?.regulation));
    const l = or(loss?.so, or(loss?.ot, loss?.regulation));
    if (isNum(w) && isNum(l)) out.push({ key: "format.points.so", params: { win: w, loss: l } });
  }
  return out;
}

export function pointsLine(rule: PointsRule, opts: PointsLineOptions = {}): PointsClause[] {
  const r = record(rule);
  const out: PointsClause[] = [];
  const map = record(r?.bySetScore);
  if (map !== undefined) {
    // A set map is the whole table (SPEC §5.3 step 6): its pairs are said, never the win / loss it overrides.
    const sets = setScoreClauses(map);
    if (sets === undefined || sets.length === 0) return [];
    out.push(...sets);
  } else {
    const base = headOf(r);
    // The base is the sentence's head: without a win and a loss there is nothing honest to say; a draw that is there
    // but no number is the same (never "draw" dropped silently).
    if (!isNum(base?.win) || !isNum(base?.loss)) return [];
    if (isNum(base.draw)) out.push({ key: "format.points.base", params: { win: base.win, draw: base.draw, loss: base.loss } });
    else if (base.draw === undefined) out.push({ key: "format.points.winLoss", params: { win: base.win, loss: base.loss } });
    else return [];
    out.push(...splitClauses(r));
  }

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
