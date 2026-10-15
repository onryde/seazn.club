import "server-only";
// Per-stage match-format override (design 2026-09-17 §T3, rulings D1/D2/D2a).
// An organiser runs Best-of-1 in the league/Swiss stage and Best-of-3 in the
// playoff of the same division. The stage stores a partial FRAGMENT at
// `stages.config.rules`; `stageScopedCfg` overlays it on the division config,
// and the existing freeze-on-first-event keeps already-scored fixtures on the
// config they were scored under.
//
// W2c Task 11: the allowlist of keys is no longer `@/lib/match-rules`'s editor
// table (`configKeysFor`, four sports) but the ENGINE's own declaration of what
// a stage of this kind and variant may set (`stageTopKeysFor`), read in
// `stage-rules-merge.ts` with the other pure pieces of this write path.
import type { StageKind } from "@seazn/engine/core";
import { PointsRule } from "@seazn/engine/competition";
import type { z } from "zod";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { RULE_ERROR_STATUS, ruleErrorMessage } from "@/lib/rule-errors";
import { resolveModule } from "@/server/engine-db";
import { recomputeStandings } from "@/server/engine-db/competition";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import type { AuthCtx } from "@/server/api-v1/auth";
import { assertNotFrozen, frozenCompetitionIds } from "./entitlement-freeze";
import { heldAwards, rewriteHeldAwards } from "./award-rewrite";
import { refuseInvalidatedOverrides } from "./fixture-override-guards";
import { mergedStageRules, refuseStagePoints, refuseUnsettableKeys, setsBestOf, stageRulesProblem, stageSaveRefusal } from "./stage-rules-merge";
import { assertCustomPointsAllowed } from "./stages";
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
 *
 * W2c Task 13 (ST-G8): the body is `{rules?, points?}`, two arms, each left as stored when omitted. `points` is the
 * stage's own PointsRule (the engine's), written WHOLE to `config.points` (a rule is one sentence, not a fragment: a
 * second save replaces it); `points: null` removes it. Asked the questions every door asks of a stage's points
 * (`refuseStagePoints`: a bracket kind, Q1's inexpressible division, a walkover score the table never reads, metrics the
 * sport does not emit), behind the ONE entitlement gate (`assertCustomPointsAllowed`), and under the same per-stage lock.
 * A save that moves the points re-folds a table that already has rows (a Swiss bye), after the commit.
 */
export async function putStageRules(
  auth: AuthCtx,
  stageId: string,
  input: { rules?: Record<string, unknown> | null; points?: z.input<typeof PointsRule> | null },
): Promise<{ rules: Record<string, unknown> | null; points: PointsRule | null }> {
  // The rule as the engine reads it (defaults applied), parsed here as well as at the route: an internal caller reaches
  // this usecase with no schema in front of it.
  const points = input.points === undefined || input.points === null ? input.points : PointsRule.parse(input.points);
  // The entitlement gate is a pooled read: asked BEFORE the transaction opens (createStages does the same), never inside.
  // A stage that is not there (or is another org's) answers 404 before it, never the gate's 402: one short tenant-scoped
  // read first (fix round 1), only when there is a rule to gate.
  if (points !== undefined && points !== null) {
    const exists = await withTenant(auth.orgId, async (tx) => (await tx`select 1 from stages where id = ${stageId}`).length > 0);
    if (!exists) throw new HttpError(404, "stage not found");
    await assertCustomPointsAllowed(auth, points);
  }
  // Resolved BEFORE the transaction: `frozenCompetitionIds` runs its own
  // pooled query, and issuing that inside a `withTenant` callback that already
  // pins a connection is the nesting `entitlement-freeze.ts`'s header warns
  // about — its `tx` parameter was DELETED rather than fixed so the trap could
  // not be re-set. `assertNotFrozen` is pure and takes the competition id the
  // transaction reads below.
  const frozen = await frozenCompetitionIds(auth.orgId);

  const out = await withTenant(auth.orgId, async (tx) => {
    // FIRST read: only what cannot move under us - which division this stage belongs to, and its competition (a stage
    // never changes division). `withTenant` scopes the read to this org, so another tenant's stage is
    // indistinguishable from a missing one - 404, never 403.
    const [first] = await tx<{ division_id: string; competition_id: string }[]>`
      select s.division_id, d.competition_id from stages s join divisions d on d.id = s.division_id
       where s.id = ${stageId}`;
    if (!first) throw new HttpError(404, "stage not found");
    assertNotFrozen(frozen, first.competition_id);

    // The division advisory lock every sibling stage writer takes
    // (`stages.ts` replaceStages/deleteStage, overrideStandings, issueChallenge).
    // It pairs with `patchDivision`'s lock on the SAME key (divisions.ts, "division:<id>", taken before it reads the
    // division's config): a division config or variant save and a stage rules save serialise on it, so the division
    // config this save validates against, and the variant its allowlist reads, are the ones that stand when it commits.
    //
    // It does NOT serialise this save against the format freeze (W2c Task 2 I-1; this comment claimed it did until W2c
    // Task 15): the freeze in `append-event.ts` resolves the cfg and snapshots it under a FIXTURE-scoped lock and never
    // takes `division:`. A scorer read the old cfg, this PUT saw no snapshot and committed 200, and the match then froze
    // the OLD format while the stage was locked for good — the organiser told the save worked, the pad disagreeing, and no
    // retry that fixes it. The lock that closes it is the next one.
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + first.division_id}))`;
    // W2c Task 15 (Task 2 I-1) — the format freeze's lock, EXCLUSIVE: the append takes it SHARED while the match it
    // writes is unsnapshotted, before it resolves the cfg. A first tap in flight therefore commits its snapshot before
    // the lock-predicate read below runs (it sees the stage started: 409), and a first tap that arrives after waits for
    // this save to commit (it freezes the NEW rules). Taken BEFORE the read it guards, so the predicate and the write are
    // one atomic decision. Global order: `division:` → stage seats → `fixture:` → `division-config:` → rows; a holder of
    // this X lock takes no stage-seat or fixture lock after it.
    await tx`select pg_advisory_xact_lock(hashtext(${"division-config:" + first.division_id}))`;

    // SECOND read, UNDER the lock: everything that is validated against - the division's config and variant, the stage's
    // kind and name, and the rules it stores now. (Read before the lock, a division save committing in between would
    // have the merged parse and the override guard below run on a stale config and store `{division + rules}` that the
    // sport refuses, the D10 crash class.) Each is a new statement, so READ COMMITTED sees what the other writer committed.
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
        stored_rules: unknown;
      }[]
    >`
      select s.division_id, s.name as stage_name, s.kind as stage_kind, d.competition_id, d.sport_key, d.variant_key,
             d.module_version, d.config as division_config, s.config -> 'rules' as stored_rules
        from stages s join divisions d on d.id = s.division_id
       where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found"); // deleted while this save waited for the lock

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

    // W2c Task 13: the points arm's questions are asked before either arm writes, so a refused rule rolls back nothing
    // and a refused fragment nothing either (one transaction, but a refusal should not depend on which arm wrote first).
    if (points !== undefined && points !== null) refuseStagePoints(module_, stage.stage_kind, stage.division_config, points);

    if (input.rules !== undefined) {
      const rules = input.rules;
      if (rules !== null) refuseUnsettableKeys(module_, stage.sport_key, stage.stage_kind, stage.variant_key, Object.keys(rules));

      // The merge is computed here, on the JS side, from the rules read under the lock above, and written whole: every
      // stage writer takes that lock, so nothing moves in between.
      const stored = stage.stored_rules;

      // "Inherit" is key ABSENCE, never an explicit null — the overlay spreads
      // what it is given, so a null reaching the column blanks the division's
      // value instead of deferring to it. `{rules: null}`, `{rules: {}}` and an
      // emptied merge are one intent — inherit the division's format — so all
      // three land on the same `- 'rules'`. Storing an empty `rules: {}` instead
      // would leave a key that overrides nothing: the overlay would walk it for
      // no reason, and every `"rules" in config` reader (the panel's "Same as
      // division" state) would report an override that is not there.
      const next = mergedStageRules(stored, rules);

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
        const moved = rules !== null && setsBestOf(rules);
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
    }

    // W2c Task 13 — the points arm. A rule is written WHOLE (server-side `||`, as the rules arm, so a stale JS read of
    // the column never reverts another writer); null removes the KEY, never a stored JSON null (`competition.ts` reads
    // `stage.config?.points` truthily, and a null would be one more shape every reader must know).
    if (points !== undefined) {
      if (points === null) await tx`update stages set config = config - 'points' where id = ${stageId}`;
      else await tx`update stages set config = config || ${tx.json({ points } as never)} where id = ${stageId}`;
    }

    // The stage as it now stands, both arms: what the save answers with.
    const [after] = await tx<{ rules: Record<string, unknown> | null; points: PointsRule | null; snapshots: boolean }[]>`
      select config -> 'rules' as rules, config -> 'points' as points,
             exists (select 1 from standings_snapshots ss where ss.stage_id = ${stageId}) as snapshots
        from stages where id = ${stageId}`;
    return {
      rules: after!.rules ?? null,
      points: after!.points ?? null,
      // A table already cached (a Swiss bye, an event-less walkover) is re-folded under the new points after the commit:
      // `getStandings` answers from the snapshot, and nothing else re-folds a stage nobody has played in.
      refold: points !== undefined && after!.snapshots,
      divisionId: stage.division_id,
      competitionId: stage.competition_id,
    };
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
  if (out.refold) await recomputeStandings(auth.orgId, stageId);
  fireDivisionRevalidate(out.divisionId, out.competitionId);
  return { rules: out.rules, points: out.points };
}
