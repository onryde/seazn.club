import "server-only";
// W2c Task 11 — the stage-rules write path's pure pieces, in a leaf module so the three writers that need them (the stage
// PUT in `stage-rules.ts`, the division PATCH in `divisions.ts`, and the override guards in `fixture-override-guards.ts`)
// read ONE definition and none imports another's usecase (`fixture-override-guards.ts` sits under the writers' own
// imports; see its header).
//
//  1. the KEY allowlist, from the engine's own declaration (spec item 1): a key the sport never declares is
//     UNKNOWN_RULE_KEY; a declared key this stage's kind or variant cannot set, or a points key, is RULE_NOT_SETTABLE;
//  2. how a save lands on the stored rules (carry I2): it MERGES;
//  3. the MERGED PARSE `{division ⊕ stage.rules}` (batch-1 I-A): the same question when the stage's rules change and when
//     the division under them does. (W2c's points-map answer a `bestOf` needs is W2d's coverage question now, asked of the
//     rule the stage will pay: `table-rule-guards.ts`, Task 10);
//  4. (W2c Task 13, ST-G8) the one validation of a stage's own POINTS (`config.points`, the engine's PointsRule), for every
//     door that writes them. (W2c's Q1 — a division whose points a rule cannot express — retired with W2d's rule, which
//     can say every split: spec §5.3, Task 10.)
import { DRAW_KINDS, EngineError, type StageKind } from "@seazn/engine/core";
import { pointsRuleAwardReachesTable, validatePointsRule, type PointsRule } from "@seazn/engine/competition";
import { sportTopKeys, stageTopKeysFor, type AnySportModule } from "@seazn/engine/sport";
import type { Tx } from "@/lib/db";
import { stageScopedCfg } from "@/server/engine-db/stage-cfg";
import { withoutNulls } from "@/lib/stage-decider-off";
import { configIssuesOf } from "@/lib/config-issue-copy";
import { HttpError } from "@/lib/errors";
import { RULE_ERROR_STATUS, notSettableReasonEn, ruleErrorMessage } from "@/lib/rule-errors";
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
 *  `refuseInvalidatedStageRules`): the first key sent that the division keeps for itself, by name. The refusal carries its
 *  reason as a CODE (`extra.reason: "online_division"`, final review M1), which a client says in the reader's language
 *  (`ruleRefusalText`); the message is the en dictionary's sentence for it. */
function refuseDivisionOnlyKeys(sportKey: string, divisionConfig: unknown, sent: Iterable<string>): void {
  const kept = divisionOnlyStageKeys(sportKey, divisionConfig);
  if (kept.size === 0) return;
  for (const key of sent) {
    if (kept.has(key))
      throw new HttpError(
        RULE_ERROR_STATUS.RULE_NOT_SETTABLE,
        ruleErrorMessage("RULE_NOT_SETTABLE", { field: key, reason: notSettableReasonEn("online_division") }),
        "RULE_NOT_SETTABLE",
        { field: key, reason: "online_division" },
      );
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
// `withoutNulls` and `mergedStageRules` (how a save merges) live in lib/stage-decider-off.ts with the rest of the stage-cfg
// composition (fix round 2, review M-3): the create door and the format-matrix harness merge with the same code.
export { mergedStageRules, withoutNulls } from "@/lib/stage-decider-off";

export type StageRulesProblem = {
  readonly kind: "invalid";
  readonly issues: readonly { path: readonly PropertyKey[]; message: string }[];
};

/**
 * The MERGED parse: `{division ⊕ rules}` through the sport's own schema. The fragment alone cannot be parsed (the schema's
 * defaults would fill it out), and what is STORED is the fragment, never `parsed.data`: storing the parse would write a
 * defaults-materialised copy of the whole division format into `config.rules`, pinning the stage to every division key
 * forever. Null = no problem.
 *
 * W2d Task 10: W2c's second question here — whether the division's `pointsMap` answers every set score a moved `bestOf`
 * can end on (D10; its `"*"` early return, its `unansweredSetScores`) — is the coverage question now
 * (`coverage(rule, reachableOutcomes(...))`, `table-rule-guards.ts`), asked of the rule the stage will actually pay (its
 * own, its pin, or the sport's under the merged cfg) rather than of the division's map, and by every door that moves it.
 */
export function stageRulesProblem(
  module: AnySportModule,
  divisionConfig: unknown,
  rules: Record<string, unknown>,
): StageRulesProblem | null {
  // Through the resolver itself (`stageScopedCfg`), so what is validated is what a match folds: a null is inherit, and a
  // decider's `false` is the engine's off where that off is null (fix round 1, R-T12-1). Anywhere else a `false` reaches
  // the schema as sent and is refused there by name, as any value the sport does not take.
  const parsed = module.configSchema.safeParse(stageScopedCfg(isObj(divisionConfig) ? divisionConfig : {}, { rules }, module));
  if (!parsed.success) return { kind: "invalid", issues: parsed.error.issues };
  return null;
}

/** The stage PUT's refusal for a problem: the engine's CONFIG_INVALID (422, `issues`). */
export function stageSaveRefusal(p: StageRulesProblem, sportKey: string): EngineError {
  return new EngineError("CONFIG_INVALID", `invalid ${sportKey} config`, { issues: p.issues });
}

/** The division PATCH's refusal for a problem in one stage's rules, naming the stage (batch-1 I-A): the code the stage PUT
 *  answers with, `extra` carrying the stage. */
export function divisionSaveRefusal(p: StageRulesProblem, sportKey: string, stage: { id: string; name: string }): HttpError {
  const extra = { stage_id: stage.id, stage_name: stage.name };
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
 * config the schema refuses (Pool B's `cap: 21` under a division whose `setTo` is now 25) is frozen as is.
 * `nextDivisionConfig` is the config about to be written. Refuses the first stage in board order, naming it; null rules
 * are not asked. (A points table that no longer pays a stage's `bestOf` is the division save's coverage question, W2d:
 * `refuseDivisionTableSave`.)
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
    const problem = stageRulesProblem(module, nextDivisionConfig, rules);
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

const notSettable = (field: string, reason: string): HttpError =>
  new HttpError(RULE_ERROR_STATUS.RULE_NOT_SETTABLE, ruleErrorMessage("RULE_NOT_SETTABLE", { field, reason }), "RULE_NOT_SETTABLE", { field });

/**
 * W2c Task 13 (ST-G8) — the one validation of a stage's own points (`config.points`, the engine's PointsRule), for every
 * door that writes them: the stage PUT (`stage-rules.ts`), and `createStages` / `replaceStages` / template instantiation
 * through `validatedStageConfig`. In order, each refused by name:
 *  1. a stage with no table (a bracket kind) has nothing its points would rank: RULE_NOT_SETTABLE, field `points`;
 *  2. (W2c's Q1 "inexpressible" refusal is retired: W2d's rule says every split a division can — spec §5.3. Whether the
 *     rule PAYS every outcome the stage reaches is the coverage question, `table-rule-guards.ts`);
 *  3. batch-3 I3: a walkover score (`forfeit.awardScore`) where it does not reach the sport's table
 *     (`pointsRuleAwardReachesTable`: the set sports, carrom, the board games) is a number that changes nothing:
 *     RULE_NOT_SETTABLE, field `points.forfeit.awardScore`;
 *  4. a rule that reads metrics the sport does not emit (a margin bonus on a sport with no score): the engine's
 *     CONFIG_INVALID (`validatePointsRule`).
 * No entitlement half: bonuses and a forfeit row are free on every plan (W2d T10 fix round 1, I4: the owner's "all
 * scoring is free"; the `standings.custom_points` gate is deleted). Pure; the caller's transaction is untouched.
 */
export function refuseStagePoints(module: AnySportModule, kind: StageKind, rule: PointsRule): void {
  if (!DRAW_KINDS.has(kind)) throw notSettable("points", "a bracket stage has no table to rank");
  if (rule.forfeit?.awardScore !== undefined && !pointsRuleAwardReachesTable(module))
    throw notSettable(AWARD_SCORE_FIELD, "a walkover's score does not reach this sport's table");
  validatePointsRule(rule, module.metrics);
}
