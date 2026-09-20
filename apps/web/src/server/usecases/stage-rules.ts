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
import { EngineError } from "@seazn/engine/core";
import { configKeysFor, STAGE_RULES_SPORTS } from "@/lib/match-rules";
import { withTenant, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { resolveModule } from "@/server/engine-db";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import type { AuthCtx } from "@/server/api-v1/auth";
import { assertNotFrozen, frozenCompetitionIds } from "./entitlement-freeze";

/**
 * "Which of these stages have already started?" — THE format-lock predicate,
 * stated ONCE and interpolated by both halves of the lock: the single-stage
 * guard in `putStageRules` below, which REFUSES the write, and
 * `formatLockedStageIds`, which the division page reads so the fixtures panel
 * knows whether to OFFER the editor at all. Two copies of this expression
 * would drift, and the shape of that drift is an organiser shown an Edit
 * button whose Save comes back 409. Change it here and both change.
 *
 * D1 — the predicate is MONOTONIC. Deliberately not `fixtures.status`:
 * `fixtureStatusFromFold` returns `in_play` only while an active `core.start`
 * exists, so voiding a start moves a fixture back to `scheduled` and a status
 * predicate would re-open a stage that has already been played. A frozen
 * `config_snapshot` and a score event both only ever appear; neither goes
 * away. The `score_events` half also covers the JSON-`null`-config carve-out,
 * where a fixture records events and never takes a snapshot at all.
 */
async function lockedStageIdsAmong(tx: Tx, stageIds: readonly string[]): Promise<Set<string>> {
  if (stageIds.length === 0) return new Set();
  const rows = await tx<{ stage_id: string }[]>`
    select distinct f.stage_id from fixtures f
     where f.stage_id = any(${stageIds as string[]}::uuid[])
       and (f.config_snapshot is not null
            or exists(select 1 from score_events e where e.fixture_id = f.id))`;
  return new Set(rows.map((r) => r.stage_id));
}

/**
 * The stages of one division whose match format is locked — the READ half of
 * the lock, for the fixtures panel's "Match format" row (design §T5, D7).
 *
 * The division page cannot derive this itself: `FIXTURE_COLS` does not select
 * `config_snapshot` (and `stages.ts:147-162` records a payload-budget ruling
 * against widening it), and `score_events` reaches no page prop at all. The
 * only client-visible signal is `fixtures.status`, which is exactly the
 * non-monotonic predicate the comment above rejects.
 *
 * Call it only for a sport in `STAGE_RULES_SPORTS` — the panel renders no row
 * for any other sport, so the page should not pay for the query.
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
 * exists. A forfeit is the one other payer and it uses `cleanSweepPair`, which
 * falls back rather than looking a score up.
 *
 * Returns `[]` — no opinion — for a config with no `pointsMap` at all. That is
 * what excludes TENNIS, which pays a flat `points {win, loss}`: derived from
 * the parsed config rather than from a sport list that would need keeping in
 * step with `STAGE_RULES_SPORTS`.
 */
function unansweredSetScores(bestOf: unknown, pointsMap: unknown): string[] {
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
  return Array.from({ length: winning }, (_, lost) => `${winning}-${lost}`).filter(
    (scoreKey) => !Object.hasOwn(map, scoreKey),
  );
}

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
        competition_id: string;
        sport_key: string;
        module_version: string;
        division_config: Record<string, unknown> | null;
      }[]
    >`
      select s.division_id, d.competition_id, d.sport_key, d.module_version,
             d.config as division_config
        from stages s join divisions d on d.id = s.division_id
       where s.id = ${stageId}`;
    // `withTenant` scopes the read to this org, so another tenant's stage is
    // indistinguishable from a missing one — 404, never 403.
    if (!stage) throw new HttpError(404, "stage not found");
    assertNotFrozen(frozen, stage.competition_id);

    // D2a — the sport gate is a guard, not prose. Without it a football
    // division could POST `rules.points`, a shape SPORT_RULES.football
    // genuinely emits, and the overlay would feed it to standingsDelta with
    // the standings.custom_points entitlement never consulted.
    if (!STAGE_RULES_SPORTS.has(stage.sport_key))
      throw new HttpError(
        400,
        `${stage.sport_key} does not support per-stage match rules`,
        "SPORT_NOT_SUPPORTED",
      );

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
      throw new HttpError(
        409,
        "this stage has already started — its match rules are locked",
        "STAGE_FORMAT_LOCKED",
      );

    // D2 — the allowlist is the union of the CONFIG keys each field's build()
    // emits, never the FORM keys. For tennis the two diverge three ways
    // (setType→set, noAd→game, tiebreakWinBy→tiebreak), so a `f.key` list
    // would refuse four of its five overrides.
    //
    // Checked over the keys AS SENT, BEFORE the null strip below. The other
    // order looks equivalent and is not: `{notAKey: null}` would strip to an
    // empty fragment and never meet the allowlist at all, so a misspelled rule
    // would answer 200 and change nothing — the worst shape available, because
    // the organiser is told the save worked.
    if (input.rules !== null) {
      const allowed = configKeysFor(stage.sport_key);
      for (const key of Object.keys(input.rules))
        if (!allowed.has(key))
          throw new HttpError(
            400,
            `"${key}" is not a match rule for ${stage.sport_key}`,
            "UNKNOWN_RULE_KEY",
          );
    }

    // "Inherit" is key ABSENCE, never an explicit null — the overlay spreads
    // what it is given, so a null reaching the column blanks the division's
    // value instead of deferring to it.
    const fragment =
      input.rules === null
        ? {}
        : Object.fromEntries(
            Object.entries(input.rules).filter(([, v]) => v !== null && v !== undefined),
          );

    // `{rules: null}`, `{rules: {}}` and `{rules: {bestOf: null}}` are one
    // intent — inherit the division's format — so all three land on the same
    // `- 'rules'`. Storing an empty `rules: {}` instead would leave a key that
    // overrides nothing: the overlay would walk it for no reason, and every
    // `"rules" in config` reader (the panel's "Same as division" state) would
    // report an override that is not there.
    if (Object.keys(fragment).length === 0) {
      // `- 'rules'` removes the KEY. Writing null instead would leave a null
      // the overlay copies over the division's value.
      await tx`update stages set config = config - 'rules' where id = ${stageId}`;
      return { rules: null, divisionId: stage.division_id, competitionId: stage.competition_id };
    }

    // Validate the MERGE, store the FRAGMENT. The fragment alone cannot be
    // parsed — the schema's defaults would fill it out — and storing
    // `parsed.data` would write a defaults-materialised copy of the whole
    // division format into `config.rules`, pinning the stage to every division
    // key forever. Note this parse ACCEPTS `points` for tennis: the allowlist
    // above is the only thing keeping it out, which is why it is a guard.
    const module_ = resolveModule(stage.sport_key, stage.module_version);
    const parsed = module_.configSchema.safeParse({
      ...(stage.division_config ?? {}),
      ...fragment,
    });
    if (!parsed.success)
      throw new EngineError("CONFIG_INVALID", `invalid ${stage.sport_key} config`, {
        issues: parsed.error.issues,
      });

    // D10 — the merged config is structurally valid and can still crash
    // standings. Checked only when the fragment actually moves `bestOf`: a
    // division already missing entries for its OWN format is a division-level
    // problem this endpoint did not cause and cannot fix, so refusing an
    // unrelated `setTo` override for it would block a save for no reason.
    // See `unansweredSetScores` for why the reachable set is derived.
    if (Object.hasOwn(fragment, "bestOf")) {
      const merged = parsed.data as { bestOf?: unknown; pointsMap?: unknown };
      const missing = unansweredSetScores(merged.bestOf, merged.pointsMap);
      if (missing.length > 0)
        throw new HttpError(
          422,
          `best of ${String(merged.bestOf)} can end ${missing.join(", ")}, ` +
            `and this division's points table has no entry for ` +
            `${missing.length === 1 ? "that score" : "those scores"} and no "*" fallback — ` +
            `add them to the division's points table first, or standings for this stage ` +
            `would fail`,
          "POINTS_MAP_INCOMPLETE",
        );
    }

    // Server-side merge (§T2): six other writers rewrite this column from a
    // JS-side read, and a spread of a stale read would revert this write.
    await tx`
      update stages set config = config || ${tx.json({ rules: fragment } as never)}
       where id = ${stageId}`;
    return { rules: fragment, divisionId: stage.division_id, competitionId: stage.competition_id };
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
