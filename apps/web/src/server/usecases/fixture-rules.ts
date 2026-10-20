import "server-only";
import { EngineError, type MatchOutcome, type StageKind } from "@seazn/engine/core";
import { checkFixtureOverride, sportTopKeys, type AnySportModule } from "@seazn/engine/sport";
import { canonicalJson } from "@/lib/canonical-json";
import { withTenant, type Tx } from "@/lib/db";
import { configIssuesOf } from "@/lib/config-issue-copy";
import { HttpError } from "@/lib/errors";
import { FORMAT_FIT_REASONS, RULE_ERROR_STATUS, fitReasonOf, ruleErrorMessage, type FixtureLockReason } from "@/lib/rule-errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { LOCKED_FIXTURE_STATUSES, hasFrozenCfg, resolveModule } from "@/server/engine-db";
import { awardFit, isScoredAward, loadAward, writeAwardedMatchState } from "@/server/engine-db/awarded-state";
import { formatStanding } from "@/server/engine-db/format-standing";
import { bracketOrder } from "@/server/engine-db/fed-seats";
import { liveCfg, mergeRulesOverride } from "@/server/engine-db/fixture-cfg";
import { foldFrom, loadFoldInputs } from "@/server/engine-db/fold";
import { RefreezeFoldError, freezeCfg, refreezeFixture } from "@/server/engine-db/refreeze";
import { bumpRulesVersion } from "@/server/engine-db/rules-version";
import { log } from "@/server/logger";
import { assertNotFrozen, frozenCompetitionIds } from "./entitlement-freeze";
import { matchName } from "./fixture-override-guards";
import { schedulePlayerStatsRefresh } from "./player-stats-refresh";
import { invalidatePublicCache } from "./scoring";

/**
 * W2c Task 14 — THE ONE WRITER of `fixtures.rules_override` (V463): one match's own format (X-SR-2), and the live
 * correction of a started match's format (X-SR-5, owner Q11 / P-1 / P-4). Nothing else in `apps/web` writes the column;
 * `fixture-cfg.ts` `resolveFixtureCfg` is its one reader (every call site pinned in `bracket-overlay-callers.test.ts`).
 *
 * Per fixture, all or nothing across the batch, under `division:<id>` then `fixture:<id>` advisory locks (the house
 * order: stage, division, fixture — nothing takes a division lock after a fixture lock; the fixtures in bracket order,
 * `fed-seats.ts` `bracketOrder`, the order a fed-seat release takes them in):
 *  1. Refused if the match is finished (`LOCKED_FIXTURE_STATUSES`, the set the ledger itself guards appends on).
 *  2. Every top-level key AS SENT must be one the sport declares (`UNKNOWN_RULE_KEY`) — before the null strip, so a
 *     misspelled `{notARule: null}` is not a silent 200.
 *  3. NULL = INHERIT (Task 10 M2): a null top-level value is dropped, never stored. All-null, `{}` and `null` clear.
 *  4. The stage's format is resolved (`division ⊕ stage.rules ⊕ bracketDeciders`) and PARSED by the sport's schema
 *     before the X-SR-2 check reads it (Task 4 M2): an ice hockey stage that inherits the schema's overtime has none in
 *     its raw config, and the check would read a shortened overtime as switching one ON.
 *  5. The corrected format (stage ⊕ fragment, the resolver's own merge) must parse (`CONFIG_INVALID` 422, the engine's
 *     message on the field — carrom's game-to below the stage's queen cap is refused, never clamped; Task 5 I3), and
 *     every leaf it changes must be a match key inside its bound (`checkFixtureOverride`: `RULE_NOT_SETTABLE`).
 *  6. STORED: only the leaves the corrected format changes against the parsed stage (carry (c)) — so a later stage
 *     edit still reaches every leaf the match did not change, and a leaf the schema strips (`set.bogus`, Task 4 M3)
 *     never lands. Self-checked: the stored diff must resolve back to the same parsed format, or the changed top-level
 *     values are stored whole.
 *  7. STARTED (a frozen `config_snapshot`): the correction must fit the recorded play (X-SR-5) — the ledger refolded
 *     under the corrected cfg must fold at all, keep the outcome, and keep the score as shown (P-4: it may not end the
 *     match either). Then `refreezeFixture` re-freezes, refolds every cache and bumps `rules_version` (P-1). A
 *     correction that resolves to the snapshot already frozen is a no-op for the ledger: no re-freeze, no bump.
 *  7a. DECIDED WITHOUT PLAY (an outcome no standing event records — `awardSeededByes`' bye, or ruling 116's walkover
 *     over a withdrawn winner's dead seat; fix round 1, I1): started, whatever its snapshot says. There is no play to
 *     refold, so the fit is the award's own fold (`awardedMatchState`): under the corrected cfg the walkover must
 *     still decide the stored award and keep its credited score, or the correction is refused
 *     (`FORMAT_DOES_NOT_FIT_PLAY`). A bye credits no score and nothing records it, so fitting does not apply: a change
 *     is refused (`FIXTURE_FORMAT_LOCKED`) — as is an award its current format cannot reproduce (`awarded-state.ts`
 *     `awardFit`, the pure verdict). Re-sending the format it already plays is no change: nothing is fitted. On a fit the award's score is re-written under the corrected cfg; a frozen
 *     snapshot is re-frozen and bumped (`freezeCfg` — never `refreezeFixture`, whose refold of the empty ledger would
 *     write over the award), and an award with no snapshot, which resolves live, is bumped by hand (`bumpRulesVersion`,
 *     as 7b does): a take-back can reopen a ruling-116 walkover, and a pad opened on that match before the correction
 *     would otherwise freeze the corrected format under a pad folding the old (batch-5 re-review N-5). A bye is the
 *     exception that is refused outright (above), so nothing of its own is ever bumped here.
 *  7b. NO FROZEN CFG and not decided without play — UNSTARTED, or played before V347 froze a snapshot (legacy, which
 *     must fit its play first, X-SR-5): the match folds, or will freeze at its first event, under the live resolution.
 *     A write that moves what it resolves to bumps `rules_version` (W2c Task 15 fix round 1, I-1 and M-4), so a pad open
 *     on it before the write is refused on its first tap (409 FIXTURE_RULES_CHANGED) rather than freezing a format it is
 *     not folding. Under this writer's `fixture:` lock — the one every append takes before it reads the version — and no
 *     `division-config:` lock: this writer shares exactly one key with an append, so the two cannot deadlock
 *     (`division-config-lock.test.ts` parks one behind the other). A re-send of what it already resolves to bumps
 *     nothing.
 *  8. One `competition_events` row per fixture (`fixture.rules_override`: before, after, started).
 */
export interface OverrideWriteResult {
  readonly fixtures: readonly { id: string; started: boolean; rules_version: number }[];
}

interface LockedRow {
  id: string;
  fixture_no: number | null;
  status: string;
  outcome: MatchOutcome | null;
  config_snapshot: unknown;
  rules_override: Record<string, unknown> | null;
  rules_version: number;
  division_id: string;
  competition_id: string;
  division_config: unknown;
  variant_key: string | null;
  sport_key: string;
  module_version: string;
  stage_kind: string | null;
  stage_config: Record<string, unknown> | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A key written as an own data property whatever its name (`__proto__` included) — never through a setter. */
function put(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

const SAME = Symbol("same");
/** The leaves `after` changes against `before`: objects on both sides are descended over `after`'s keys; anything else
 *  is compared whole. A key `after` lacks cannot be expressed as a change — the self-check catches that case. */
function leafDiff(before: unknown, after: unknown): unknown {
  if (isObj(before) && isObj(after)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(after)) {
      const d = leafDiff(before[k], after[k]);
      if (d !== SAME) put(out, k, d);
    }
    return Object.keys(out).length === 0 ? SAME : out;
  }
  return canonicalJson(before) === canonicalJson(after) ? SAME : after;
}

/** X-SR-5 — a correction is refused when the two folds disagree on the outcome (`outcomesDiffer`) or on the score. */
const outcomesDiffer = (a: MatchOutcome | null, b: MatchOutcome | null): boolean => canonicalJson(a) !== canonicalJson(b);

function configInvalid(row: LockedRow, issues: readonly { path: readonly PropertyKey[]; message: string }[], sent: readonly string[]): HttpError {
  const first = issues[0];
  const top = first?.path[0];
  // The field the organiser changed: the issue's own key when it is one of theirs, else the first key they sent (a
  // cross-field refinement — carrom's queen cap — names the stage key it checks, which the organiser did not touch).
  const field = typeof top === "string" && sent.includes(top) ? top : sent[0];
  return new HttpError(
    422,
    `${matchName(row.fixture_no)}'s format is invalid — ${first?.message ?? "the sport's rules refuse it"}`,
    "CONFIG_INVALID",
    // Batch-3 M2: the one wire shape for CONFIG_INVALID's issues, `{path, message}` — as v1 forwards the engine's
    // (http.ts), never the raw zod issue with its `input`.
    { fixture_id: row.id, field, issues: configIssuesOf({ issues }) ?? undefined },
  );
}

/** What the writer stores for one row, or a refusal. Pure over the row and its stage's format: no database. */
function overrideFor(
  row: LockedRow,
  m: AnySportModule,
  stageResolved: unknown,
  fragment: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const sent = fragment === null ? {} : fragment;
  // (2) every key AS SENT, null-valued ones included.
  const known = sportTopKeys(m);
  for (const key of Object.keys(sent))
    if (!known.has(key))
      throw new HttpError(400, `"${key}" is not a ${row.sport_key} rule`, "UNKNOWN_RULE_KEY", { fixture_id: row.id, field: key });
  // (3) null = inherit.
  const frag: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sent)) if (v !== null && v !== undefined) put(frag, k, v);
  const keys = Object.keys(frag);
  if (keys.length === 0) return null;

  // (4) the stage's format, parsed.
  if (!isObj(stageResolved)) throw new HttpError(422, `${matchName(row.fixture_no)}'s division has no format to change`, "CONFIG_INVALID", { fixture_id: row.id });
  const parsedStage = m.configSchema.safeParse(stageResolved);
  if (!parsedStage.success) throw configInvalid(row, parsedStage.error.issues, keys);
  // (5) the corrected format: the resolver's own merge, parsed.
  const parsedCorrected = m.configSchema.safeParse(mergeRulesOverride(stageResolved, frag));
  if (!parsedCorrected.success) throw configInvalid(row, parsedCorrected.error.issues, keys);
  const stageCfg = parsedStage.data as Record<string, unknown>;
  const corrected = parsedCorrected.data as Record<string, unknown>;
  const sentWhole: Record<string, unknown> = {};
  for (const k of keys) put(sentWhole, k, corrected[k]);
  const check = checkFixtureOverride(m, row.stage_kind as StageKind | null, row.variant_key, stageCfg, sentWhole);
  if (!check.ok) {
    const params = { field: check.path, reason: check.reason };
    throw new HttpError(
      check.code === "RULE_NOT_SETTABLE" ? RULE_ERROR_STATUS.RULE_NOT_SETTABLE : 400,
      check.code === "RULE_NOT_SETTABLE" ? ruleErrorMessage("RULE_NOT_SETTABLE", params) : check.reason,
      check.code,
      { fixture_id: row.id, field: check.path },
    );
  }

  // (6) store the changed leaves; prove they resolve back.
  const resolvesTo = (stored: Record<string, unknown>): boolean => {
    const back = m.configSchema.safeParse(mergeRulesOverride(stageResolved, stored));
    return back.success && canonicalJson(back.data) === canonicalJson(corrected);
  };
  const leaves: Record<string, unknown> = {};
  for (const k of keys) {
    const d = leafDiff(stageCfg[k], corrected[k]);
    if (d !== SAME) put(leaves, k, d);
  }
  if (Object.keys(leaves).length === 0) return null;
  if (resolvesTo(leaves)) return leaves;
  const whole: Record<string, unknown> = {};
  for (const k of Object.keys(leaves)) put(whole, k, corrected[k]);
  if (resolvesTo(whole)) return whole;
  const field = Object.keys(leaves)[0]!;
  throw new HttpError(
    RULE_ERROR_STATUS.RULE_NOT_SETTABLE,
    ruleErrorMessage("RULE_NOT_SETTABLE", { field, reason: "it can't be stored as a change to its stage's format" }),
    "RULE_NOT_SETTABLE",
    { fixture_id: row.id, field },
  );
}

// Batch-3 M1: each refusal carries the facts a client says it with (`lib/rule-errors.ts` `ruleRefusalText`): why a match
// is locked (`reason`: finished, cancelled, or decided without play — a bye, an award its format cannot re-score), and which fit
// reason refused it (`fit_reason`, absent for the engine's own sentence).
const lockedRefusal = (id: string, lock: FixtureLockReason) =>
  new HttpError(RULE_ERROR_STATUS.FIXTURE_FORMAT_LOCKED, ruleErrorMessage("FIXTURE_FORMAT_LOCKED", { lock }), "FIXTURE_FORMAT_LOCKED", {
    fixture_id: id,
    reason: lock,
  });
const notFit = (id: string, reason: string) =>
  new HttpError(RULE_ERROR_STATUS.FORMAT_DOES_NOT_FIT_PLAY, ruleErrorMessage("FORMAT_DOES_NOT_FIT_PLAY", { reason }), "FORMAT_DOES_NOT_FIT_PLAY", {
    fixture_id: id,
    fit_reason: fitReasonOf(reason),
  });

/** (7a) An award no event records: `awardFit`'s verdict (the award's own walkover fold under the format it plays now
 *  and under `corrected`), as a named refusal. A bye is refused before its sides are read (it seats one side only). */
async function assertAwardFits(tx: Tx, row: LockedRow, corrected: unknown): Promise<void> {
  if (!isScoredAward(row.outcome)) throw lockedRefusal(row.id, "decided");
  const award = await loadAward(tx, row.id);
  const verdict = awardFit(award.module, award.cfg, corrected, award.lineups, award.outcome, {
    fixtureId: row.id,
    recordedAt: new Date().toISOString(),
  });
  if (verdict.ok) return;
  throw verdict.code === "FIXTURE_FORMAT_LOCKED" ? lockedRefusal(row.id, "decided") : notFit(row.id, verdict.reason);
}

/** (7) X-SR-5: the recorded play, refolded under `corrected`, must fold, keep its outcome and keep its score. */
async function assertFits(tx: Tx, row: LockedRow, corrected: unknown): Promise<void> {
  const inputs = await loadFoldInputs(tx, row.id);
  if (inputs === null) return; // a frozen cfg with no ledger behind it: nothing recorded, nothing to contradict
  const before = foldFrom(row.id, inputs);
  let after;
  try {
    after = foldFrom(row.id, { ...inputs, cfg: corrected });
  } catch (err) {
    if (!EngineError.is(err)) throw err;
    throw new HttpError(
      RULE_ERROR_STATUS.FORMAT_DOES_NOT_FIT_PLAY,
      ruleErrorMessage("FORMAT_DOES_NOT_FIT_PLAY", { reason: err.message }),
      "FORMAT_DOES_NOT_FIT_PLAY",
      { fixture_id: row.id },
    );
  }
  let reason: string | null = null;
  if (outcomesDiffer(before.outcome, after.outcome))
    reason = before.outcome === null ? FORMAT_FIT_REASONS.ends : FORMAT_FIT_REASONS.result;
  else if (before.summary.headline !== after.summary.headline) reason = FORMAT_FIT_REASONS.score;
  if (reason !== null) throw notFit(row.id, reason);
}

export async function writeFixtureRulesOverride(
  auth: AuthCtx,
  fixtureIds: readonly string[],
  fragment: Record<string, unknown> | null,
): Promise<OverrideWriteResult> {
  const ids = [...new Set(fixtureIds)];
  if (ids.length === 0) return { fixtures: [] };
  // Before the transaction: `frozenCompetitionIds` runs its own pooled query (entitlement-freeze.ts header).
  const frozen = await frozenCompetitionIds(auth.orgId);

  const { results, byDivision, corrected } = await withTenant(auth.orgId, async (tx) => {
    // `withTenant` scopes the read to this org: another tenant's fixture is indistinguishable from a missing one.
    const owners = await tx<{ id: string; division_id: string; round_no: number }[]>`
      select id, division_id, round_no from fixtures where id in ${tx(ids)}`;
    const missing = ids.find((id) => !owners.some((o) => o.id === id));
    if (missing !== undefined) throw new HttpError(404, "fixture not found", undefined, { fixture_id: missing });
    // Sorted, so two batches over the same divisions/fixtures can never take them in opposite orders.
    for (const d of [...new Set(owners.map((o) => o.division_id))].sort())
      await tx`select pg_advisory_xact_lock(hashtext(${"division:" + d}))`;
    // Bracket order, as a fed-seat release takes them: never a later round's lock while asking for an earlier one's.
    for (const o of [...owners].sort(bracketOrder)) await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + o.id}))`;

    const results: { id: string; started: boolean; rules_version: number }[] = [];
    // Per division, every fixture whose public documents this write made stale: the written ones and any seat a
    // re-freeze released (`refreezeFixture`).
    const byDivision = new Map<string, Set<string>>();
    const touch = (divisionId: string, fixtureIds: readonly string[]) => {
      const set = byDivision.get(divisionId) ?? new Set<string>();
      for (const f of fixtureIds) set.add(f);
      byDivision.set(divisionId, set);
    };
    const corrected: string[] = [];
    for (const id of ids) {
      // Re-read ON THE TX, under the locks: every guard below reads this row, never one read before them.
      const [row] = await tx<LockedRow[]>`
        select f.id, f.fixture_no, f.status, f.outcome, f.config_snapshot, f.rules_override, f.rules_version,
               f.division_id, d.competition_id, d.config as division_config, d.variant_key, d.sport_key,
               d.module_version, s.kind as stage_kind, s.config as stage_config
          from fixtures f join divisions d on d.id = f.division_id left join stages s on s.id = f.stage_id
         where f.id = ${id}`;
      if (!row) throw new HttpError(404, "fixture not found", undefined, { fixture_id: id });
      assertNotFrozen(frozen, row.competition_id);
      // (1)
      // Batch-6 M-1: a cancelled match says cancelled (it was never finished); every other locked status is finished.
      if (LOCKED_FIXTURE_STATUSES.has(row.status)) throw lockedRefusal(id, row.status === "cancelled" ? "cancelled" : "finished");
      const m = resolveModule(row.sport_key, row.module_version);
      // The stage's format (`division ⊕ stage.rules ⊕ bracketDeciders`), as the resolver builds it for this row.
      const stageResolved = liveCfg(row.division_config, { kind: row.stage_kind, config: row.stage_config }, m);
      const stored = overrideFor(row, m, stageResolved, fragment);
      const next = stored === null || Object.keys(stored).length === 0 ? null : stored;

      // Which cfg the match folds under now — its frozen one, or the live resolution (fixture-cfg.ts): the re-freeze's
      // question, not "has it started".
      const snapshotted = hasFrozenCfg(row.config_snapshot);
      // Where it stands, read as every format door reads it (`format-standing.ts`, batch-3 I1): PLAYED (a frozen cfg or
      // a recorded event) and (7a) DECIDED WITHOUT PLAY (an outcome no standing event records).
      const { played, decidedWithoutPlay: withoutPlay } = await formatStanding(tx, id);
      const started = played || withoutPlay;
      let version = row.rules_version;
      // The corrected cfg is exactly what `resolveFixtureCfg` returns for this row once `next` is stored and the
      // snapshot cleared: the stage's format with the override merged last (fixture-cfg.ts).
      const cfg = isObj(stageResolved) ? mergeRulesOverride(stageResolved, next) : stageResolved;
      let rewriteAward = false;
      // What the match resolves to LIVE now (no frozen cfg), built as `cfg` is (`resolveFixtureCfg`'s live branch).
      const liveNow = isObj(stageResolved) ? mergeRulesOverride(stageResolved, row.rules_override) : stageResolved;
      if (withoutPlay) {
        // What the match resolves to now, built as `cfg` is (`resolveFixtureCfg`'s two branches, over this row).
        const current = snapshotted ? row.config_snapshot : liveNow;
        if (canonicalJson(cfg) !== canonicalJson(current)) {
          await assertAwardFits(tx, row, cfg);
          // A frozen award re-freezes (which bumps); one with NO snapshot resolves LIVE, so a correction that moves it is the
          // 7b write and bumps by hand: a take-back can reopen a ruling-116 walkover, and a pad opened on that match before the
          // correction must be refused on its first tap, not freeze a format it is not folding (batch-5 re-review N-5).
          version = snapshotted ? (await freezeCfg(tx, id, cfg)).rules_version : await bumpRulesVersion(tx, id);
          rewriteAward = true;
        }
      } else if (snapshotted) {
        if (canonicalJson(cfg) !== canonicalJson(row.config_snapshot)) {
          await assertFits(tx, row, cfg);
          try {
            const r = await refreezeFixture(tx, id, cfg);
            version = r.rules_version;
            touch(row.division_id, [id, ...r.released]);
          } catch (err) {
            // `assertFits` folded this very cfg a moment ago, so a fold refusal here is not a verdict on the format.
            throw err instanceof RefreezeFoldError ? err.foldError : err;
          }
          corrected.push(id);
        }
      } else {
        // Played with no frozen cfg (a row scored before V347 froze one): it folds under the live resolution, so the
        // override moves its play like a correction — X-SR-5's fit, with nothing to re-freeze.
        if (played) await assertFits(tx, row, cfg);
        // (7b) Unstarted, or that legacy shape: a write that moves what it resolves to moves its version.
        if (canonicalJson(cfg) !== canonicalJson(liveNow)) version = await bumpRulesVersion(tx, id);
      }
      await tx`update fixtures set rules_override = ${next === null ? null : tx.json(next as never)} where id = ${id}`;
      // After the override lands: the award's score re-written under the cfg the fixture now resolves to.
      if (rewriteAward) await writeAwardedMatchState(tx, id, { rewrite: true });
      await tx`
        insert into competition_events (competition_id, org_id, type, payload, actor_id)
        values (${row.competition_id}, ${auth.orgId}, 'fixture.rules_override',
                ${tx.json({ fixture_id: id, before: row.rules_override, after: next, started } as never)}, ${auth.userId})`;
      touch(row.division_id, [id]);
      results.push({ id, started, rules_version: version });
    }
    return { results, byDivision, corrected };
  });

  for (const id of corrected) schedulePlayerStatsRefresh(auth.orgId, { fixtureId: id });
  for (const touched of byDivision.values()) {
    const [first, ...rest] = [...touched];
    await invalidatePublicCache(auth.orgId, first!, false, undefined, rest).catch((err: unknown) => {
      log.error({ err, fixture: first }, "fixture-rules: public cache invalidation failed (the format stands)");
    });
  }
  return { fixtures: results };
}
