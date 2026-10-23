import "server-only";
// W2c Task 11 — the stage-rules write path's pure pieces, in a leaf module so the three writers that need them (the stage
// PUT in `stage-rules.ts`, the division PATCH in `divisions.ts`, and the override guards in `fixture-override-guards.ts`)
// read ONE definition and none imports another's usecase (`fixture-override-guards.ts` sits under the writers' own
// imports; see its header).
//
//  1. the KEY allowlist, from the engine's own declaration (spec item 1): a key the sport never declares is
//     UNKNOWN_RULE_KEY; a declared key this stage's kind or variant cannot set, or a points key, is RULE_NOT_SETTABLE;
//  2. how a save lands on the stored rules (carry I2): it MERGES;
//  3. the MERGED PARSE `{division ⊕ stage.rules}` and the points-map answer a `bestOf` needs (batch-1 I-A): the same
//     question when the stage's rules change and when the division under them does;
//  4. (W2c Task 13, ST-G8) the one validation of a stage's own POINTS (`config.points`, the engine's PointsRule), for every
//     door that writes them, and the division save's re-ask of Q1 over the stages that carry them.
import { DRAW_KINDS, EngineError, type StageKind } from "@seazn/engine/core";
import { pointsRuleAwardReachesTable, pointsRuleExpressible, validatePointsRule, type PointsRule } from "@seazn/engine/competition";
import { sportTopKeys, stageTopKeysFor, type AnySportModule } from "@seazn/engine/sport";
import type { Tx } from "@/lib/db";
import { lockedStageIdsAmong } from "./rule-locks";
import { stageScopedCfg } from "@/server/engine-db/stage-cfg";
import { withoutNulls } from "@/lib/stage-decider-off";
import { configIssuesOf } from "@/lib/config-issue-copy";
import { HttpError } from "@/lib/errors";
import { RULE_ERROR_STATUS, ruleErrorMessage } from "@/lib/rule-errors";
import { divisionOnlyStageKeys } from "@/lib/online-time-control";

/**
 * The allowlist, over the keys AS SENT (null-valued ones included): checked BEFORE any null strip, because the other
 * order reads `{notAKey: null}` as an empty fragment that never meets the allowlist, and a misspelled rule would answer
 * 200 and change nothing, with the organiser told it worked.
 *
 * Per key, in the order sent: undeclared is `UNKNOWN_RULE_KEY` (400); declared but not settable for this stage's kind
 * and variant (including every points key, which belongs to the Points section) is `RULE_NOT_SETTABLE` (400,
 * `extra.field`). The keys are the CONFIG keys the engine declares, never the editor's form keys (tennis's `setType`
 * is a form key whose build writes `set`: `setType` is unknown here).
 *
 * Rebase ruling D1 (2026-10-23): a key the DIVISION keeps for itself (`divisionOnlyStageKeys`: an online chess
 * division's clock and clock family, which the Lichess challenge reads off the division alone) is `RULE_NOT_SETTABLE`
 * too, whatever the engine allows a stage of this kind. `divisionConfig` is the config the stage will play under: the
 * stored one for a stage save or a create, the one about to be written for a division save.
 */
export function refuseUnsettableKeys(
  module: AnySportModule,
  sportKey: string,
  kind: StageKind,
  variantKey: string | null,
  divisionConfig: unknown,
  sent: Iterable<string>,
): void {
  const declared = sportTopKeys(module);
  const settable = stageTopKeysFor(module, kind, variantKey);
  for (const key of sent) {
    if (!declared.has(key)) throw new HttpError(400, `"${key}" is not a match rule for ${sportKey}`, "UNKNOWN_RULE_KEY");
    if (!settable.has(key))
      throw new HttpError(
        RULE_ERROR_STATUS.RULE_NOT_SETTABLE,
        ruleErrorMessage("RULE_NOT_SETTABLE", { field: key, reason: "not for this stage's format" }),
        "RULE_NOT_SETTABLE",
        { field: key },
      );
  }
  refuseDivisionOnlyKeys(sportKey, divisionConfig, sent);
}

/** D1's half of the allowlist, on its own for a division save that keeps the variant (the full re-ask is the variant's,
 *  `refuseInvalidatedStageRules`): the first key sent that the division keeps for itself, by name. */
function refuseDivisionOnlyKeys(sportKey: string, divisionConfig: unknown, sent: Iterable<string>): void {
  const kept = divisionOnlyStageKeys(sportKey, divisionConfig);
  if (kept.size === 0) return;
  for (const key of sent) {
    if (kept.has(key))
      throw new HttpError(
        RULE_ERROR_STATUS.RULE_NOT_SETTABLE,
        ruleErrorMessage("RULE_NOT_SETTABLE", { field: key, reason: "an online (Lichess) division plays its own clock in every stage" }),
        "RULE_NOT_SETTABLE",
        { field: key },
      );
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
// `withoutNulls` and `mergedStageRules` (how a save merges) live in lib/stage-decider-off.ts with the rest of the stage-cfg
// composition (fix round 2, review M-3): the create door and the format-matrix harness merge with the same code.
export { mergedStageRules, withoutNulls } from "@/lib/stage-decider-off";

/**
 * D10 — the final set scores a `bestOf` match can END on that the division's
 * `pointsMap` cannot answer.
 *
 * `pointsMap` is looked up by the final set score (`setbased/kernel.ts`
 * `matchPoints`): exact `"W-L"`, else `"*"`, else `invalid()`, which THROWS.
 * And `pointsMap` is deliberately NOT in the per-stage allowlist — no
 * `RuleField` writes it — so it cannot move with the format. A division whose
 * map enumerates only the scores ITS OWN bestOf reaches, plus a stage
 * overridden to a different bestOf, produces a score no entry answers and the
 * standings page throws. Not a wrong number: a crash, on a save this endpoint
 * had already reported as successful.
 *
 * The reachable set is DERIVED, never a table typed in here: a side wins on
 * `⌈bestOf/2⌉` sets (the kernel's `majority`, and the schema refuses an even
 * `bestOf`), so the loser holds 0..⌈bestOf/2⌉−1 and no other final score
 * exists. A forfeit pays the same lookup at its CREDITED score (W2b X-WO-1):
 * the winner is credited the majority and the offender keeps the sets it won,
 * which is inside that same set, so this check prices every forfeit too. Only
 * a bye still pays `cleanSweepPair`.
 *
 * Returns `[]` — no opinion — for a config with no `pointsMap` at all. That is
 * what excludes TENNIS, which pays a flat `points {win, loss}`: derived from
 * the parsed config rather than from a sport list that would need keeping in
 * step with which sports a stage can carry rules for.
 */
export function unansweredSetScores(bestOf: unknown, pointsMap: unknown): string[] {
  if (typeof bestOf !== "number" || !Number.isInteger(bestOf) || bestOf < 1) return [];
  if (typeof pointsMap !== "object" || pointsMap === null || Array.isArray(pointsMap)) return [];
  const map = pointsMap as Record<string, unknown>;
  // `Object.hasOwn` rather than `in` or a truthiness check. Be honest about
  // what that buys HERE: nothing yet. Every key looked up below is CONSTRUCTED
  // (`"*"`, `"${w}-${l}"`), and `Object.prototype` declares none of those, so
  // `in` would answer identically today — this is an equivalent mutant, not a
  // live guard, and no test can kill it. It is written this way because the
  // engine reads the SAME map with a bare `cfg.pointsMap[key]`
  // (`setbased/kernel.ts` `matchPoints`), and if a future caller ever looks up
  // a key it did not build, `hasOwn` is the form that stays correct.
  if (Object.hasOwn(map, "*")) return [];
  const winning = Math.ceil(bestOf / 2);
  return Array.from({ length: winning }, (_, lost) => `${winning}-${lost}`).filter((scoreKey) => !Object.hasOwn(map, scoreKey));
}

export type StageRulesProblem =
  | { readonly kind: "invalid"; readonly issues: readonly { path: readonly PropertyKey[]; message: string }[] }
  | { readonly kind: "points_map"; readonly bestOf: unknown; readonly missing: readonly string[] };

/** Whether these rules move `bestOf` (a null value inherits, so it moves nothing). */
export const setsBestOf = (rules: Record<string, unknown>): boolean => rules.bestOf !== null && rules.bestOf !== undefined;

/**
 * The MERGED parse: `{division ⊕ rules}` through the sport's own schema, and — when the rules move `bestOf` — whether the
 * division's `pointsMap` answers every final set score that `bestOf` can end on. The fragment alone cannot be parsed (the
 * schema's defaults would fill it out), and what is STORED is the fragment, never `parsed.data`: storing the parse would
 * write a defaults-materialised copy of the whole division format into `config.rules`, pinning the stage to every
 * division key forever.
 *
 * `checkPointsMap` is asked only where the CALLER moved `bestOf`: a division already missing entries for its own format is
 * a division-level problem a stage save did not cause and cannot fix. Null = no problem.
 */
export function stageRulesProblem(
  module: AnySportModule,
  divisionConfig: unknown,
  rules: Record<string, unknown>,
  checkPointsMap: boolean,
): StageRulesProblem | null {
  // Through the resolver itself (`stageScopedCfg`), so what is validated is what a match folds: a null is inherit, and a
  // decider's `false` is the engine's off where that off is null (fix round 1, R-T12-1). Anywhere else a `false` reaches
  // the schema as sent and is refused there by name, as any value the sport does not take.
  const parsed = module.configSchema.safeParse(stageScopedCfg(isObj(divisionConfig) ? divisionConfig : {}, { rules }, module));
  if (!parsed.success) return { kind: "invalid", issues: parsed.error.issues };
  if (checkPointsMap) {
    const merged = parsed.data as { bestOf?: unknown; pointsMap?: unknown };
    const missing = unansweredSetScores(merged.bestOf, merged.pointsMap);
    if (missing.length > 0) return { kind: "points_map", bestOf: merged.bestOf, missing };
  }
  return null;
}

const pointsMapMessage = (p: Extract<StageRulesProblem, { kind: "points_map" }>): string =>
  `best of ${String(p.bestOf)} can end ${p.missing.join(", ")}, ` +
  `and this division's points table has no entry for ` +
  `${p.missing.length === 1 ? "that score" : "those scores"} and no "*" fallback — ` +
  `add them to the division's points table first, or standings for this stage ` +
  `would fail`;

/** The stage PUT's refusal for a problem: the engine's CONFIG_INVALID (422, `issues`) or 422 POINTS_MAP_INCOMPLETE. */
export function stageSaveRefusal(p: StageRulesProblem, sportKey: string): EngineError | HttpError {
  if (p.kind === "invalid") return new EngineError("CONFIG_INVALID", `invalid ${sportKey} config`, { issues: p.issues });
  return new HttpError(422, pointsMapMessage(p), "POINTS_MAP_INCOMPLETE");
}

/** The division PATCH's refusal for a problem in one stage's rules, naming the stage (batch-1 I-A): the same two codes
 *  the stage PUT answers with, `extra` carrying the stage. */
export function divisionSaveRefusal(p: StageRulesProblem, sportKey: string, stage: { id: string; name: string }): HttpError {
  const extra = { stage_id: stage.id, stage_name: stage.name };
  if (p.kind === "points_map") return new HttpError(422, `${stage.name}: ${pointsMapMessage(p)}`, "POINTS_MAP_INCOMPLETE", extra);
  const first = p.issues[0];
  return new HttpError(
    422,
    `${stage.name}'s own rules would be invalid under this ${sportKey} format — ${first?.message ?? "the sport's rules refuse it"}. Change the stage's rules first.`,
    "CONFIG_INVALID",
    { ...extra, issues: configIssuesOf({ issues: p.issues }) ?? undefined },
  );
}

/**
 * batch-1 I-A — the division PATCH re-asks, for EVERY stage that carries rules, the question the stage PUT asked when
 * they were saved: since owner P-2 "A" the division config can change after a stage stored `config.rules`, and a merged
 * config the schema refuses (Pool B's `cap: 21` under a division whose `setTo` is now 25) or a `pointsMap` that no
 * longer answers a stage's `bestOf` is frozen as is. `nextDivisionConfig` is the config about to be written. Refuses
 * the first stage in board order, naming it; null rules are not asked.
 *
 * W2c Task 12 (Task 11 review M1): `nextVariant` is the variant about to be written when the save CHANGES it, else null.
 * The keys a stage may set depend on its variant (`stageTopKeysFor`), so a change re-asks the ALLOWLIST first, over the
 * keys each stage stores: a t20 stage's `superOver: false` under a test-match division is a key nothing can remove
 * (`{superOver: null}` is itself refused there). RULE_NOT_SETTABLE (400), naming the stage and the key.
 *
 * Rebase ruling D1 (2026-10-23): a save that keeps the variant still asks every stage's stored keys the division's own
 * question (`divisionOnlyStageKeys`, under the config about to be written): online play turned on over a stage that holds
 * a clock is refused by name, so the organiser clears the stage's clock first rather than leave one no game plays.
 */
export async function refuseInvalidatedStageRules(
  tx: Tx,
  divisionId: string,
  nextDivisionConfig: unknown,
  module: AnySportModule,
  sportKey: string,
  nextVariant: string | null = null,
): Promise<void> {
  const stages = await tx<{ id: string; name: string; kind: StageKind; rules: unknown }[]>`
    select id, name, kind, config -> 'rules' as rules from stages
     where division_id = ${divisionId} and config -> 'rules' is not null order by seq`;
  for (const s of stages) {
    if (!isObj(s.rules)) continue;
    const rules = withoutNulls(s.rules);
    if (Object.keys(rules).length === 0) continue;
    if (nextVariant !== null) namingStage(s, () => refuseUnsettableKeys(module, sportKey, s.kind, nextVariant, nextDivisionConfig, Object.keys(rules)));
    else namingStage(s, () => refuseDivisionOnlyKeys(sportKey, nextDivisionConfig, Object.keys(rules)));
    const problem = stageRulesProblem(module, nextDivisionConfig, rules, setsBestOf(rules));
    if (problem !== null) throw divisionSaveRefusal(problem, sportKey, s);
  }
}

/** An allowlist refusal for one stage under a division save, naming the stage (`stage_id`, `stage_name`) the way
 *  `divisionSaveRefusal` does: the organiser is told which stage to clear the key on. */
function namingStage(stage: { id: string; name: string }, refuse: () => void): void {
  try {
    refuse();
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    throw new HttpError(e.status, `${stage.name}: ${e.message}`, e.code, { ...e.extra, stage_id: stage.id, stage_name: stage.name });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// W2c Task 13 (ST-G8, spec item 10, Q1) — a stage's own points.
// ---------------------------------------------------------------------------------------------------------------------

/** The field a walkover score is refused under (batch-3 I3): the path in the PUT's body. */
export const AWARD_SCORE_FIELD = "points.forfeit.awardScore";

/** The division config Q1 is asked against: the sport's own parse (defaults applied, so a sparse stored config still
 *  splits by its schema's defaults), else the config as stored. */
function parsedDivisionCfg(module: AnySportModule, divisionConfig: unknown): unknown {
  const parsed = module.configSchema.safeParse(isObj(divisionConfig) ? divisionConfig : {});
  return parsed.success ? parsed.data : divisionConfig;
}

/** Q1's refusal: 422 POINTS_RULE_INEXPRESSIBLE, the split keys in `extra.keys` (the engine's, never English), the
 *  sentence naming them by their labels (`lib/rule-errors.ts`). */
function inexpressibleRefusal(keys: readonly string[], stage?: { id: string; name: string }): HttpError {
  const sentence = ruleErrorMessage("POINTS_RULE_INEXPRESSIBLE", { keys });
  return new HttpError(
    RULE_ERROR_STATUS.POINTS_RULE_INEXPRESSIBLE,
    stage === undefined ? sentence : `${stage.name}: ${sentence}`,
    "POINTS_RULE_INEXPRESSIBLE",
    { keys: [...keys], ...(stage === undefined ? {} : { stage_id: stage.id, stage_name: stage.name }) },
  );
}

const notSettable = (field: string, reason: string): HttpError =>
  new HttpError(RULE_ERROR_STATUS.RULE_NOT_SETTABLE, ruleErrorMessage("RULE_NOT_SETTABLE", { field, reason }), "RULE_NOT_SETTABLE", { field });

/**
 * W2c Task 13 (ST-G8) — the one validation of a stage's own points (`config.points`, the engine's PointsRule), for every
 * door that writes them: the stage PUT (`stage-rules.ts`), and `createStages` / `replaceStages` / template instantiation
 * through `validatedStageConfig`. In order, each refused by name:
 *  1. a stage with no table (a bracket kind) has nothing its points would rank: RULE_NOT_SETTABLE, field `points`;
 *  2. Q1 (owner "A"): a division whose points a rule cannot say without dropping some (`pointsRuleExpressible`: ice
 *     hockey's OT split, a shoot-out split, cricket's tie and no result, a set-score map paying more than one pair) is
 *     422 POINTS_RULE_INEXPRESSIBLE, its split keys in `extra.keys` — refused, never silently dropped;
 *  3. batch-3 I3: a walkover score (`forfeit.awardScore`) where it does not reach the sport's table
 *     (`pointsRuleAwardReachesTable`: the set sports, carrom, the board games) is a number that changes nothing:
 *     RULE_NOT_SETTABLE, field `points.forfeit.awardScore`;
 *  4. a rule that reads metrics the sport does not emit (a margin bonus on a sport with no score): the engine's
 *     CONFIG_INVALID (`validatePointsRule`).
 * The entitlement half (bonuses and a forfeit row need `standings.custom_points`) is `assertCustomPointsAllowed`
 * (`stages.ts`): a pooled read, asked before the caller's transaction opens. Pure; the caller's transaction is untouched.
 */
export function refuseStagePoints(module: AnySportModule, kind: StageKind, divisionConfig: unknown, rule: PointsRule): void {
  if (!DRAW_KINDS.has(kind)) throw notSettable("points", "a bracket stage has no table to rank");
  const expressible = pointsRuleExpressible(parsedDivisionCfg(module, divisionConfig));
  if (!expressible.ok) throw inexpressibleRefusal(expressible.keys);
  if (rule.forfeit?.awardScore !== undefined && !pointsRuleAwardReachesTable(module))
    throw notSettable(AWARD_SCORE_FIELD, "a walkover's score does not reach this sport's table");
  validatePointsRule(rule, module.metrics);
}

/**
 * W2c Task 13 — the division save re-asks Q1 (`refuseStagePoints` step 2) for every stage that carries its own points and
 * has NOT started, under the config about to be written: a variant change (to hockey's fih-shootout) or a config edit (a
 * shoot-out split added to `points`) would otherwise leave such a stage paying a rule that drops the division's split,
 * which the stage PUT refuses. Refused naming the first such stage in board order; the organiser clears its points first.
 *
 * A STARTED stage is not asked: its points are locked (STAGE_FORMAT_LOCKED), so a refusal could never be cleared and would
 * block every other stage's change for good; and the division's `points` never reach it (its own rule REPLACES them,
 * `STAGE_POINTS_REPLACES`, which is why the lock lets the change through for it). The empty case first: a config whose
 * points a rule can express asks nothing and costs no query.
 *
 * Fix round 1: a save is asked only about a split it ADDS. When every split key of the next config is already a split key
 * of the config as it stands, this save did not cause the split (a legacy stage's points over a division that already
 * split them, then an unrelated `periods` edit): refusing it would block every edit to the division for a state no door
 * writes now. A save that adds a split key (or splits a division that did not) is asked as before.
 */
export async function refuseInexpressibleStagePoints(
  tx: Tx,
  divisionId: string,
  currentDivisionConfig: unknown,
  nextDivisionConfig: unknown,
  module: AnySportModule,
): Promise<void> {
  const expressible = pointsRuleExpressible(parsedDivisionCfg(module, nextDivisionConfig));
  if (expressible.ok) return;
  const standing = pointsRuleExpressible(parsedDivisionCfg(module, currentDivisionConfig));
  if (!standing.ok && expressible.keys.every((k) => standing.keys.includes(k))) return;
  const stages = await tx<{ id: string; name: string }[]>`
    select id, name from stages
     where division_id = ${divisionId} and jsonb_typeof(config -> 'points') = 'object' order by seq`;
  if (stages.length === 0) return;
  const started = await lockedStageIdsAmong(tx, stages.map((s) => s.id));
  const first = stages.find((s) => !started.has(s.id));
  if (first !== undefined) throw inexpressibleRefusal(expressible.keys, first);
}
