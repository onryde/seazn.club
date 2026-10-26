// W2d Task 10 fix round 1, I2 (owner decision 2026-10-26) — what a FLAT points rule cannot say of a sport's own points for
// a stage. A flat rule is the shape the stage points editor writes: one amount for every win and one for every loss (no
// overtime, shoot-out or not-played split, no set-score table, a shoot-out booked as a result), plus a draw, a tie and a
// no result. Read off the ENGINE: the sport's own rule for the stage (`tablePointsRule` under the stage's cfg) paid through
// `payout` on every outcome the stage can reach (`reachableOutcomes`) — never a list of sports or fields typed here, so a
// sport added to the engine is asked the same question.
//
// Two readers, one answer:
//  - the editor (`components/v2/stage-rules/stage-points-model.ts` `pointsEditorFits`): where its flat rule would pay an
//    outcome the stage reaches other than the sport does, the section shows "can't be set per stage yet" and sends nothing
//    (a Save would flatten that outcome onto the win or the loss);
//  - the server's defence in depth (`server/usecases/table-rule-guards.ts`): a flat rule written to a stage whose sport
//    pays an outcome its own way is refused 422 POINTS_SPLIT_FLATTENED, naming the splits (`sportPointsSplits`).
// It reads the SPORT's rule for the stage, never a stage's pinned rules (those are the loader's, `engine-db/table-rules.ts`).
//
// Client-safe: no `server-only`, no `@/server` import.
import { DECIDED_IN, payout, reachableOutcomes, setsToWinOf, type FixtureResult, type PointsRule } from "@seazn/engine/competition";
import { DRAW_KINDS, EngineError, StageKind, type MatchOutcome, type StandingsDelta } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { SPLIT_REASONS, type SplitReason } from "@/lib/rule-errors";

/** One outcome's pay, the winner's then the loser's (each side of a level result), or "unpaid" where `payout` refuses it
 *  (the rule leaves it uncovered: coverage's gap, never a 0 made up here). */
type Paid = readonly [string, string];
const UNPAID: Paid = ["unpaid", "unpaid"];

const WINNER = "winner";
const LOSER = "loser";
const side = (entrantId: string, won: 0 | 1, drawn: 0 | 1, lost: 0 | 1, metrics: Record<string, number>): StandingsDelta => ({
  entrantId,
  played: 1,
  won,
  drawn,
  lost,
  points: 0,
  metrics,
});
/** A decided pair, the winner first, carrying a final set score where the stage reaches one (a set table reads it). */
function decidedPair(score: string | null): FixtureResult {
  if (score === null) return [side(WINNER, 1, 0, 0, {}), side(LOSER, 0, 0, 1, {})];
  const [w, l] = score.split("-").map(Number) as [number, number];
  return [side(WINNER, 1, 0, 0, { sets_won: w, sets_lost: l }), side(LOSER, 0, 0, 1, { sets_won: l, sets_lost: w })];
}
const LEVEL_PAIR: FixtureResult = [side(WINNER, 0, 1, 0, {}), side(LOSER, 0, 1, 0, {})];

function paid(run: () => FixtureResult): Paid {
  try {
    const [a, b] = run();
    return [String(a.points), String(b.points)];
  } catch (e) {
    // Only the engine's own refusal is "unpaid"; anything else is a defect, never a silent difference.
    if (e instanceof EngineError) return UNPAID;
    throw e;
  }
}

/**
 * What `rule` pays on every outcome a stage of `kind` reaches under `cfg` (as the sport parses it), keyed: a decided
 * result per way it can be decided (`regulation`, `ot`, `so`) and per final set score where the stage reaches one
 * (`ot@3-2`); an award (`award`, per set score likewise) — every table can produce one, a forfeit with nothing played;
 * and the level results the stage reaches (`draw`, `tie`, `noResult`).
 */
function paidOutcomes(module: AnySportModule, cfg: unknown, kind: StageKind, rule: PointsRule): ReadonlyMap<string, Paid> {
  const reach = reachableOutcomes(module, cfg, kind);
  let setsToWin: number | undefined;
  try {
    setsToWin = setsToWinOf(module, cfg);
  } catch (e) {
    if (!(e instanceof EngineError)) throw e;
    setsToWin = undefined;
  }
  const scores: (string | null)[] = [...reach].filter((k) => k.startsWith("set:")).map((k) => k.slice("set:".length));
  if (scores.length === 0) scores.push(null);
  const keys = module.awardScoreKeys;
  const at = (base: string, score: string | null) => (score === null ? base : `${base}@${score}`);
  const out = new Map<string, Paid>();
  const win: MatchOutcome = { kind: "win", winner: WINNER, loser: LOSER };
  for (const d of DECIDED_IN) {
    if (!reach.has(`win.${d}`)) continue;
    for (const s of scores) out.set(at(d, s), paid(() => payout(win, d, decidedPair(s), true, rule, keys, setsToWin)));
  }
  const award: MatchOutcome = { kind: "award", winner: WINNER, loser: LOSER, reason: "walkover" };
  for (const s of scores) out.set(at("award", s), paid(() => payout(award, null, decidedPair(s), false, rule, keys, setsToWin)));
  const LEVEL = [["draw", "draw"], ["tie", "tie"], ["noResult", "no_result"]] as const;
  for (const [key, outcomeKind] of LEVEL) {
    if (reach.has(key)) out.set(key, paid(() => payout({ kind: outcomeKind }, null, LEVEL_PAIR, true, rule, keys, setsToWin)));
  }
  return out;
}

/** `rule` with every per-outcome split taken out: the flat rule paying its win, loss, draw, tie and no result. */
export function flatOf(rule: PointsRule): PointsRule {
  return {
    win: { regulation: rule.win.regulation },
    loss: { regulation: rule.loss.regulation },
    ...(rule.draw === undefined ? {} : { draw: rule.draw }),
    ...(rule.tie === undefined ? {} : { tie: rule.tie }),
    ...(rule.noResult === undefined ? {} : { noResult: rule.noResult }),
    shootoutAs: "result",
    unit: rule.unit,
    bonuses: rule.bonuses,
    ...(rule.forfeit === undefined ? {} : { forfeit: rule.forfeit }),
  };
}

/** Is `rule` flat: no field that pays one win or one loss apart from the others (what the stage points editor writes). A
 *  `soBonus` is not asked: the PointsRule schema takes one only beside a draw-plus-bonus shoot-out, which `shootoutAs`
 *  already answers (pinned in `stage-points-splits.test.ts`). */
export function isFlatRule(rule: PointsRule): boolean {
  return (
    rule.win.ot === undefined &&
    rule.win.so === undefined &&
    rule.loss.ot === undefined &&
    rule.loss.so === undefined &&
    rule.loss.unplayed === undefined &&
    rule.bySetScore === undefined &&
    rule.shootoutAs === "result"
  );
}

/** The sport's own rule for a stage of `kind` under `cfg`, with the cfg as the sport parses it; null where there is none to
 *  ask: a kind with no table, a cfg the sport refuses, or a rule the sport cannot read from it (its own CONFIG_INVALID). */
export function sportStageRule(module: AnySportModule, cfg: unknown, kind: string): { cfg: unknown; kind: StageKind; rule: PointsRule } | null {
  const stageKind = StageKind.safeParse(kind);
  if (!stageKind.success || !(DRAW_KINDS as ReadonlySet<string>).has(stageKind.data)) return null;
  const parsed = module.configSchema.safeParse(cfg);
  if (!parsed.success) return null;
  try {
    return { cfg: parsed.data, kind: stageKind.data, rule: module.tablePointsRule(parsed.data, stageKind.data) };
  } catch (e) {
    if (e instanceof EngineError) return null;
    throw e;
  }
}

/** Which split one differing outcome is, named by the SPORT's field that pays it (`side` 0 = the winner's, 1 = the loser's;
 *  a level result is both). Null for a difference no split explains (the win or loss amount itself). */
function reasonOf(sport: PointsRule, key: string, sideIx: 0 | 1): SplitReason | null {
  const [base, score] = key.split("@") as [string, string | undefined];
  if (base === "tie" || base === "noResult") return base;
  if (base === "draw") return null;
  if (base === "award" && sideIx === 1 && sport.loss.unplayed !== undefined) return "unplayed";
  if (sport.bySetScore !== undefined && (score !== undefined || base === "regulation" || base === "award")) return "pointsMap";
  if (base === "ot") return sideIx === 0 ? "otWin" : "otLoss";
  if (base === "so") {
    if (sport.shootoutAs === "draw_plus_bonus") return "soBonus";
    const own = sideIx === 0 ? sport.win.so : sport.loss.so;
    if (own !== undefined) return sideIx === 0 ? "shootoutWin" : "shootoutLoss";
    return sideIx === 0 ? "otWin" : "otLoss";
  }
  return null;
}

/** Where `other` pays an outcome the stage reaches other than `sport` does: whether any differs, and the splits that
 *  explain the differences (in `SPLIT_REASONS` order). */
export function splitsLost(
  module: AnySportModule,
  stage: { cfg: unknown; kind: StageKind; rule: PointsRule },
  other: PointsRule,
): { differs: boolean; reasons: SplitReason[] } {
  const want = paidOutcomes(module, stage.cfg, stage.kind, stage.rule);
  const got = paidOutcomes(module, stage.cfg, stage.kind, other);
  const found = new Set<SplitReason>();
  let differs = false;
  for (const [key, pay] of want) {
    const theirs = got.get(key);
    for (const sideIx of [0, 1] as const) {
      if (theirs?.[sideIx] === pay[sideIx]) continue;
      differs = true;
      const reason = reasonOf(stage.rule, key, sideIx);
      if (reason !== null) found.add(reason);
    }
  }
  return { differs, reasons: SPLIT_REASONS.filter((r) => found.has(r)) };
}

/** What the sport pays apart on a stage of `kind` under `cfg` (its merged cfg): the splits its own rule makes on outcomes
 *  the stage reaches, which no flat rule can carry. Empty where a flat rule says the sport's points whole — or where there
 *  is no sport rule to ask (a kind with no table, a cfg the sport refuses: the server's other questions answer those). */
export function sportPointsSplits(module: AnySportModule, cfg: unknown, kind: string): SplitReason[] {
  const stage = sportStageRule(module, cfg, kind);
  return stage === null ? [] : splitsLost(module, stage, flatOf(stage.rule)).reasons;
}
