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
import { bumpMovedRules, unfrozenRules } from "@/server/engine-db/rules-version";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import type { AuthCtx } from "@/server/api-v1/auth";
import { assertNotFrozen, frozenCompetitionIds } from "./entitlement-freeze";
import { heldAwards, rewriteHeldAwards } from "./award-rewrite";
import { refuseInvalidatedOverrides } from "./fixture-override-guards";
import { mergedStageRules, refuseStagePoints, refuseUnsettableKeys, stageRulesProblem, stageSaveRefusal } from "./stage-rules-merge";
import type { TiebreakerKey } from "@seazn/engine/sport";
import { repinStageOwnRules, tableRulesRowsOf } from "@/server/engine-db/table-rules";
import { refuseStageTableSave } from "./table-rule-guards";
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
 * sport does not emit), under the same per-stage lock; no entitlement gate (W2d T10 fix round 1, I4: all scoring is free).
 * A save that moves the points re-folds a table that already has rows (a Swiss bye), after the commit.
 *
 * W2d Task 10 (spec §5.4, §5.5, §10; D3, D9; PS-5d; X-TB-2, X-TB-5, X-PT-3) — two more arms, the stage's OWN tie-break
 * order (`config.tiebreakers`) and cross-group order (`config.crossGroupTiebreakers`), each absent = kept, null = removed
 * (the stage inherits: the division's order, else the sport's; a derived cross-group order). Every arm is asked BEFORE
 * anything is written (`refuseStageTableSave`): an order it writes is `validateCascade`d on the stage's kind (422
 * TIEBREAK_KEY_INVALID, `extra.refusals`), and the points the stage will pay must pay every outcome its matches can reach
 * (`coverage`; 422 POINTS_OUTCOME_UNCOVERED, `extra.uncovered`, replacing W2c's POINTS_MAP_INCOMPLETE). Between
 * activation and the first score the save is accepted and RE-PINS only the fields it wrote (`repinStageOwnRules`); after
 * the first score it is 409 STAGE_FORMAT_LOCKED (the lock above, W2c's monotonic predicate), a void notwithstanding.
 */
export async function putStageRules(
  auth: AuthCtx,
  stageId: string,
  input: {
    rules?: Record<string, unknown> | null;
    points?: z.input<typeof PointsRule> | null;
    tiebreakers?: readonly TiebreakerKey[] | null;
    crossGroupTiebreakers?: readonly TiebreakerKey[] | null;
  },
): Promise<{ rules: Record<string, unknown> | null; points: PointsRule | null }> {
  // The rule as the engine reads it (defaults applied), parsed here as well as at the route: an internal caller reaches
  // this usecase with no schema in front of it.
  const points = input.points === undefined || input.points === null ? input.points : PointsRule.parse(input.points);
  // W2d Task 10 fix round 1 (I4; owner standing rule "all scoring is free"): a stage's own points ask no entitlement gate.
  // The `standings.custom_points` read (and the existence read that put a 404 before its 402) is gone.
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
    if (points !== undefined && points !== null) refuseStagePoints(module_, stage.stage_kind, points);

    // The rules arm's own questions, asked before any arm writes too (W2d Task 10: the table guard below reads the config
    // the save leaves, which the merge decides). The merge is computed here, on the JS side, from the rules read under the
    // lock above, and written whole below: every stage writer takes that lock, so nothing moves in between.
    let nextRules: Record<string, unknown> | null | undefined;
    if (input.rules !== undefined) {
      if (input.rules !== null) refuseUnsettableKeys(module_, stage.sport_key, stage.stage_kind, stage.variant_key, stage.division_config, Object.keys(input.rules));
      // "Inherit" is key ABSENCE, never an explicit null — the overlay spreads
      // what it is given, so a null reaching the column blanks the division's
      // value instead of deferring to it. `{rules: null}`, `{rules: {}}` and an
      // emptied merge are one intent — inherit the division's format — so all
      // three land on the same `- 'rules'`. Storing an empty `rules: {}` instead
      // would leave a key that overrides nothing: the overlay would walk it for
      // no reason, and every `"rules" in config` reader (the panel's "Same as
      // division" state) would report an override that is not there.
      nextRules = mergedStageRules(stage.stored_rules, input.rules);
      // Validate the MERGE, store the FRAGMENT: `division ⊕ rules` through the sport's schema (the merged parse, in
      // `stage-rules-merge.ts`). Whether the stage's points still pay every set score the merged `bestOf` reaches is the
      // table guard's coverage question below (W2d: it replaced W2c's points-map arm).
      if (nextRules !== null) {
        const problem = stageRulesProblem(module_, stage.division_config, nextRules);
        if (problem !== null) throw stageSaveRefusal(problem, stage.sport_key);
      }
    }

    // W2d Task 10 — the table guard, over the stage's row as the loader reads it and the config the save leaves.
    const tableArms = { points, tiebreakers: input.tiebreakers, crossGroupTiebreakers: input.crossGroupTiebreakers };
    const writesTable = points !== undefined || input.tiebreakers !== undefined || input.crossGroupTiebreakers !== undefined;
    if (writesTable || input.rules !== undefined) {
      const [read] = await tableRulesRowsOf(tx, { stageIds: [stageId] });
      if (read === undefined) throw new HttpError(404, "stage not found");
      const afterConfig: Record<string, unknown> = { ...(read.row.stageConfig ?? {}) };
      if (nextRules !== undefined) {
        if (nextRules === null) delete afterConfig.rules;
        else afterConfig.rules = nextRules;
      }
      for (const [key, value] of Object.entries(tableArms)) {
        if (value === undefined) continue;
        if (value === null) delete afterConfig[key];
        else afterConfig[key] = value;
      }
      refuseStageTableSave(module_, read.row, afterConfig, tableArms);
    }

    // W2c Task 15 fix round 1 (I-1): what every unstarted match of the stage resolves to before this save - read under the
    // `division-config:` EXCLUSIVE lock above, so no first event freezes between it and the bump after both arms. W2c Task 16b:
    // the points arm joins it, because a stage points rule's walkover award is part of what a match resolves to
    // (`resolvedNow`), and the version is meant to be an honest reading of that. It protects no forfeit: the pad never sends
    // `core.forfeit` and the console's forfeit POST carries no `rulesVersion`, so neither door is refused by this bump. What
    // it does is keep the PAD's own version true after a pre-kickoff award edit - a pad open on an unstarted match is asked
    // to reload (409 FIXTURE_RULES_CHANGED) rather than hold a version that no longer describes the match.
    const rulesBefore = input.rules !== undefined || points !== undefined ? await unfrozenRules(tx, { stageId }) : null;

    if (nextRules !== undefined) {
      const next = nextRules;
      // W2c batch-3 I1: the walkovers no event records, as they resolve BEFORE this save — re-written after it, under the
      // format the stage now plays (`award-rewrite.ts`). The stage lock above does not count them as play.
      const held = await heldAwards(tx, tx`stage_id = ${stageId}`);

      if (next === null) {
        // `- 'rules'` removes the KEY. Writing null instead would leave a null
        // the overlay copies over the division's value.
        await tx`update stages set config = config - 'rules' where id = ${stageId}`;
      } else {
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
    // W2d Task 10 — the two order arms, written as the points arm is (whole; null removes the KEY: the stage inherits).
    if (input.tiebreakers !== undefined) {
      if (input.tiebreakers === null) await tx`update stages set config = config - 'tiebreakers' where id = ${stageId}`;
      else await tx`update stages set config = config || ${tx.json({ tiebreakers: input.tiebreakers } as never)} where id = ${stageId}`;
    }
    if (input.crossGroupTiebreakers !== undefined) {
      if (input.crossGroupTiebreakers === null) await tx`update stages set config = config - 'crossGroupTiebreakers' where id = ${stageId}`;
      else
        await tx`update stages set config = config || ${tx.json({ crossGroupTiebreakers: input.crossGroupTiebreakers } as never)} where id = ${stageId}`;
    }
    // PS-5d: a stage activated and not yet scored (the lock above let the save through) re-pins ONLY the fields this save
    // wrote, each to its own new value or (cleared) the layer below as it stands now; a pending stage has no pin (no-op).
    if (writesTable) {
      await repinStageOwnRules(tx, stageId, { points, tiebreakers: input.tiebreakers, crossGroup: input.crossGroupTiebreakers });
    }
    // ...and every unstarted match whose format (or walkover award) the save moved gets a new version: a pad open on it is
    // refused on its first tap (409 FIXTURE_RULES_CHANGED) instead of freezing a format it is not folding.
    if (rulesBefore !== null) await bumpMovedRules(tx, rulesBefore);

    // The stage as it now stands, both arms: what the save answers with.
    const [after] = await tx<
      {
        rules: Record<string, unknown> | null;
        points: PointsRule | null;
        snapshots: boolean;
      }[]
    >`
      select config -> 'rules' as rules, config -> 'points' as points,
             exists (select 1 from standings_snapshots ss where ss.stage_id = ${stageId}) as snapshots
        from stages where id = ${stageId}`;
    return {
      rules: after!.rules ?? null,
      points: after!.points ?? null,
      // A table already cached (a Swiss bye, an event-less walkover) is re-folded under the new points or order after the
      // commit: `getStandings` answers from the snapshot, and nothing else re-folds a stage nobody has played in.
      refold: writesTable && after!.snapshots,
      divisionId: stage.division_id,
      competitionId: stage.competition_id,
    };
  });

  // AFTER the transaction commits, and not voided. `stages.ts` used to `void`
  // its `fireStageRevalidate(...)` calls (a recorded defect, now awaited;
  // stage-revalidate-settles.test.ts); this is deliberately neither of those
  // shapes. `fireStageRevalidate` is
  // module-private and opens a `withTenant` of its OWN purely to look up the
  // division and competition — ids this transaction has already read — so
  // calling it from inside the callback would re-set the nesting trap above,
  // and calling it after would just repeat a query for nothing. The
  // revalidation itself is synchronous (`fireDivisionRevalidate` returns
  // void), so there is no promise left floating either way.
  if (out.refold) await recomputeStandings(auth.orgId, stageId);
  fireDivisionRevalidate(out.divisionId, out.competitionId);
  // The answer stays `{rules, points}` (`StageRules` on the wire): the orders' HTTP arm and their answer are Task 13's.
  return { rules: out.rules, points: out.points };
}
