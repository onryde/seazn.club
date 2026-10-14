import "server-only";
// Per-stage match-format override (design 2026-09-17 §T3, rulings D1/D2/D2a).
// An organiser runs Best-of-1 in the league/Swiss stage and Best-of-3 in the
// playoff of the same division. The stage stores a partial FRAGMENT at
// `stages.config.rules`; `stageScopedCfg` overlays it on the division config,
// and the existing freeze-on-first-event keeps already-scored fixtures on the
// config they were scored under.
//
// This module is the reason the rules table had to leave the `"use client"`
// component (§T0): a server module importing `@/components/v2/match-rules`
// receives client REFERENCES, not values, and `configKeysFor` would silently
// derive nothing. `@/lib/match-rules` is directive-free precisely so this
// import returns real functions.
import type { StageKind } from "@seazn/engine/core";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { RULE_ERROR_STATUS, ruleErrorMessage } from "@/lib/rule-errors";
import { resolveModule } from "@/server/engine-db";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import type { AuthCtx } from "@/server/api-v1/auth";
import { assertNotFrozen, frozenCompetitionIds } from "./entitlement-freeze";
import { heldAwards, rewriteHeldAwards } from "./award-rewrite";
import { refuseInvalidatedOverrides } from "./fixture-override-guards";
import { mergedStageRules, refuseUnsettableKeys, setsBestOf, stageRulesProblem, stageSaveRefusal } from "./stage-rules-merge";
// The format-lock predicate lives in rule-locks.ts (moved from here, W2c Task 2): the division PATCH asks the same
// question per stage, and both halves must read one definition of "started".
import { lockedStageIdsAmong } from "./rule-locks";

/**
 * The stages of one division whose match format is locked — the READ half of
 * the lock, for the fixtures panel's "Match format" row (design §T5, D7).
 *
 * The division page cannot derive this itself: `FIXTURE_COLS` does not select
 * `config_snapshot` (and `stages.ts:147-162` records a payload-budget ruling
 * against widening it), and `score_events` reaches no page prop at all. The
 * only client-visible signal is `fixtures.status`, which is exactly the
 * non-monotonic predicate `lockedStageIdsAmong`'s comment (rule-locks.ts) rejects.
 *
 * W2c Task 11: every sport has a stage rules row now, so the division page loads this for every sport.
 */
export async function formatLockedStageIds(auth: AuthCtx, divisionId: string): Promise<string[]> {
  return withTenant(auth.orgId, async (tx) => {
    const stages = await tx<{ id: string }[]>`
      select id from stages where division_id = ${divisionId}`;
    const locked = await lockedStageIdsAmong(
      tx,
      stages.map((s) => s.id),
    );
    return [...locked];
  });
}

/**
 * `PUT /stages/:id/rules` — the stage's own match rules, for EVERY sport (W2c Task 11).
 *
 * What is settable is the ENGINE's declaration, per stage kind and variant (`stageTopKeysFor`, `stage-rules-merge.ts`),
 * not a list kept here: a key the sport never declares is UNKNOWN_RULE_KEY, a declared key this stage cannot set (or a
 * points key) is RULE_NOT_SETTABLE. The body is a fragment that MERGES into the stored rules (carry I2): a key it omits
 * is kept, a null removes that key, `{}` and `null` clear them all. The merged result must parse with the division's
 * config, a `bestOf` must be answered by its points map, and no unstarted match's own format may stop fitting.
 */
export async function putStageRules(
  auth: AuthCtx,
  stageId: string,
  input: { rules: Record<string, unknown> | null },
): Promise<{ rules: Record<string, unknown> | null }> {
  // Resolved BEFORE the transaction: `frozenCompetitionIds` runs its own
  // pooled query, and issuing that inside a `withTenant` callback that already
  // pins a connection is the nesting `entitlement-freeze.ts`'s header warns
  // about — its `tx` parameter was DELETED rather than fixed so the trap could
  // not be re-set. `assertNotFrozen` is pure and takes the competition id the
  // transaction reads below.
  const frozen = await frozenCompetitionIds(auth.orgId);

  const out = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<
      {
        division_id: string;
        stage_name: string;
        stage_kind: StageKind;
        competition_id: string;
        sport_key: string;
        variant_key: string;
        module_version: string;
        division_config: Record<string, unknown> | null;
      }[]
    >`
      select s.division_id, s.name as stage_name, s.kind as stage_kind, d.competition_id, d.sport_key, d.variant_key,
             d.module_version, d.config as division_config
        from stages s join divisions d on d.id = s.division_id
       where s.id = ${stageId}`;
    // `withTenant` scopes the read to this org, so another tenant's stage is
    // indistinguishable from a missing one — 404, never 403.
    if (!stage) throw new HttpError(404, "stage not found");
    assertNotFrozen(frozen, stage.competition_id);

    // The division advisory lock every sibling stage writer takes
    // (`stages.ts` replaceStages/deleteStage, overrideStandings, issueChallenge)
    // — and this endpoint needs it for a reason of its own. Without it the
    // lock-predicate read below races the freeze in `append-event.ts`, which
    // resolves cfg and then snapshots under a FIXTURE-scoped lock: the two
    // never serialise against each other. A scorer reads the old cfg, this PUT
    // sees no snapshot and commits 200, and the fixture then freezes the OLD
    // format while the stage is permanently locked — the organiser is told the
    // save worked, the pad disagrees, and there is no retry that fixes it.
    // Taken BEFORE the read it guards, so the predicate and the write are one
    // atomic decision.
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;

    // D1 — the lock is per stage. The predicate itself lives in
    // `lockedStageIdsAmong` above, shared with the panel's read half so the
    // two cannot drift; its header explains why this is not `fixtures.status`.
    const locked = (await lockedStageIdsAmong(tx, [stageId])).has(stageId);
    if (locked)
      // Batch-3 M1: the spec's sentence (lib/rule-errors.ts), and the stage's name for a client to say it with.
      throw new HttpError(
        RULE_ERROR_STATUS.STAGE_FORMAT_LOCKED,
        ruleErrorMessage("STAGE_FORMAT_LOCKED", { stage: stage.stage_name }),
        "STAGE_FORMAT_LOCKED",
        { stage_name: stage.stage_name },
      );

    // D2 / Task 11 — the allowlist is the engine's declaration for THIS stage's kind and variant, over the config
    // keys (never the editor's form keys), checked over the keys AS SENT, before the merge below drops a null. The
    // module is resolved at the division's pinned version, as every other reader of its config does.
    const module_ = resolveModule(stage.sport_key, stage.module_version);
    if (input.rules !== null) refuseUnsettableKeys(module_, stage.sport_key, stage.stage_kind, stage.variant_key, Object.keys(input.rules));

    // The stored rules, read UNDER the division lock (the read above this lock could be stale). The merge is computed
    // here, on the JS side, and written whole: every stage writer takes this lock, so nothing moves in between.
    const [{ rules: stored }] = await tx<{ rules: unknown }[]>`select config -> 'rules' as rules from stages where id = ${stageId}`;

    // "Inherit" is key ABSENCE, never an explicit null — the overlay spreads
    // what it is given, so a null reaching the column blanks the division's
    // value instead of deferring to it. `{rules: null}`, `{rules: {}}` and an
    // emptied merge are one intent — inherit the division's format — so all
    // three land on the same `- 'rules'`. Storing an empty `rules: {}` instead
    // would leave a key that overrides nothing: the overlay would walk it for
    // no reason, and every `"rules" in config` reader (the panel's "Same as
    // division" state) would report an override that is not there.
    const next = mergedStageRules(stored, input.rules);

    // W2c batch-3 I1: the walkovers no event records, as they resolve BEFORE this save — re-written after it, under the
    // format the stage now plays (`award-rewrite.ts`). The stage lock above does not count them as play.
    const held = await heldAwards(tx, tx`stage_id = ${stageId}`);

    if (next === null) {
      // `- 'rules'` removes the KEY. Writing null instead would leave a null
      // the overlay copies over the division's value.
      await tx`update stages set config = config - 'rules' where id = ${stageId}`;
    } else {
      // Validate the MERGE, store the FRAGMENT: `division ⊕ rules` through the sport's schema (the merged parse, in
      // `stage-rules-merge.ts`), and — when the body moves `bestOf` — whether the division's `pointsMap` answers it
      // (D10: checked only when this save actually moves `bestOf`; a division already missing entries for its OWN
      // format is a division-level problem this endpoint did not cause and cannot fix).
      const moved = input.rules !== null && setsBestOf(input.rules);
      const problem = stageRulesProblem(module_, stage.division_config, next, moved);
      if (problem !== null) throw stageSaveRefusal(problem, stage.sport_key);
      // Server-side merge (§T2): six other writers rewrite this column from a
      // JS-side read, and a spread of a stale read would revert this write.
      await tx`
        update stages set config = config || ${tx.json({ rules: next } as never)}
         where id = ${stageId}`;
    }
    // Task 14's overnight ruling: no unstarted match's own format may be left unable to fit the stage it now plays
    // in. Read from the row just written, so a refusal rolls this save back whole.
    await refuseInvalidatedOverrides(tx, stage.division_id, stage.division_config, module_, stage.variant_key, stageId);
    await rewriteHeldAwards(tx, held);
    return { rules: next, divisionId: stage.division_id, competitionId: stage.competition_id };
  });

  // AFTER the transaction commits, and not voided. `stages.ts` has four
  // `void fireStageRevalidate(...)` calls already recorded as a defect; this
  // is deliberately neither of those shapes. `fireStageRevalidate` is
  // module-private and opens a `withTenant` of its OWN purely to look up the
  // division and competition — ids this transaction has already read — so
  // calling it from inside the callback would re-set the nesting trap above,
  // and calling it after would just repeat a query for nothing. The
  // revalidation itself is synchronous (`fireDivisionRevalidate` returns
  // void), so there is no promise left floating either way.
  fireDivisionRevalidate(out.divisionId, out.competitionId);
  return { rules: out.rules };
}
