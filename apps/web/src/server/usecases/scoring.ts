import "server-only";
// THE scoring path (doc 08 §4). Wraps the engine-db appendEvent adapter with:
// Redis idempotency (24 h — courtside retries on flaky Wi-Fi must be safe),
// per-fixture rate limiting, bracket slot progression, standings recompute,
// realtime publish and public-cache invalidation. undo = core.void through the
// same door.
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { cacheGet, cacheSet, cacheDel, cacheDelPattern, sendAfterDeleteOrBound } from "@/lib/cache";
import { rateLimit } from "@/lib/rate-limit";
import { hasFeature, requireFeature } from "@/lib/entitlements";
import { deferred } from "@/lib/deferred";
import { EngineError } from "@seazn/engine/core";
import { appendEvent } from "@/server/engine-db";
import { recomputeStandings } from "@/server/engine-db";
import { log } from "@/server/logger";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { publishDivisionUpdate, publishFixtureUpdate } from "@/lib/realtime";
import { playerMatchesGenKey } from "@/server/public-site/player-matches-cache-keys";
import { publicFixtureCacheKey } from "@/server/public-site/fixture-doc-cache-key";
import {
  fireScoreRevalidate,
  fireDiscoveryRevalidate,
  invalidateDiscoveryCache,
} from "@/server/public-site/revalidate";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { AppendEventRequest } from "@/server/api-v1/schemas";
import { assertNotFrozen, frozenCompetitionIds } from "./entitlement-freeze";
import { subjectToScorerCapabilityGates } from "./scorers";
import { fillSlot, markDependentSeedProposalsStale } from "./stages";
import { detectSuspensions, notifyServedSuspensions, type ServedFlip } from "./discipline";
import { draftPostsForDecidedFixture } from "./org-posts";
import { schedulePlayerStatsRefresh } from "./player-stats-refresh";

export interface ScoreOutcome {
  seq: number;
  state_summary: unknown;
  outcome: unknown;
  status: string;
}

const IDEM_TTL_SECONDS = 24 * 60 * 60; // doc 08 §4
const idemKey = (fixtureId: string, key: string) => `idemv1:${fixtureId}:${key}`;

// One scorer's cadence (doc 08 §6).
const SCORING_LIMIT = { max: 10, windowSeconds: 1 };

const TABLE_KINDS = new Set(["league", "group", "swiss"]);

const ENGINE_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Engine rejections carry raw ids — the engine is pure and knows no names
 *  ('scorer "9c87…" is not on the pitch for "7b94…"'). Swap person/entrant
 *  UUIDs in the message for their display names before it reaches a scorer's
 *  pad; the code and extra stay untouched so clients keep the machine part.
 *  Best-effort: unknown ids stay as-is, and a lookup failure never masks the
 *  original error. */
export async function humanizeEngineMessage(orgId: string, message: string): Promise<string> {
  const ids = [...new Set((message.match(ENGINE_ID_RE) ?? []).map((m) => m.toLowerCase()))];
  if (ids.length === 0) return message;
  try {
    return await withTenant(orgId, async (tx) => {
      const persons = await tx<{ id: string; full_name: string }[]>`
        select id, full_name from persons where id = any(${ids}::uuid[])`;
      const entrants = await tx<{ id: string; display_name: string }[]>`
        select id, display_name from entrants where id = any(${ids}::uuid[])`;
      let out = message;
      for (const { id, full_name } of persons) {
        out = out.replaceAll(`"${id}"`, full_name).replaceAll(id, full_name);
      }
      for (const { id, display_name } of entrants) {
        out = out.replaceAll(`"${id}"`, display_name).replaceAll(id, display_name);
      }
      return out;
    });
  } catch {
    return message;
  }
}

/**
 * Append one score event. 201-shape on success; EngineError SEQ_CONFLICT →
 * 409 (v1 kernel maps it); module rejection → 422, nothing persisted.
 */
export async function scoreEvent(
  auth: AuthCtx,
  fixtureId: string,
  input: AppendEventRequest,
): Promise<ScoreOutcome> {
  await rateLimit(`scorev1:${fixtureId}`, SCORING_LIMIT);

  const cacheKey = input.idempotency_key ? idemKey(fixtureId, input.idempotency_key) : null;
  if (cacheKey) {
    const replay = await cacheGet<ScoreOutcome>(cacheKey);
    if (replay) return replay; // retried request: same answer, no double write
  }

  await assertEntitledToScore(auth, fixtureId, input);
  if (input.type === "core.void") await assertUndoTarget(auth, fixtureId, input);

  let result;
  try {
    result = await appendEvent(auth.orgId, fixtureId, input.expected_seq, {
      type: input.type,
      payload: input.payload,
      // Device links: recorded_by = issued_by (auth.userId carries the issuer,
      // doc 13 §7) + the device_link_id rider so the ledger distinguishes them.
      recordedBy: auth.userId,
      deviceLinkId: auth.deviceLinkId ?? null,
      ...(input.type === "core.void" &&
      typeof (input.payload as { event_id?: unknown })?.event_id === "string"
        ? { voids: (input.payload as { event_id: string }).event_id }
        : {}),
    });
  } catch (err) {
    // SEQ_CONFLICT is the hot recovery path and carries no ids — skip it.
    if (err instanceof EngineError && err.code !== "SEQ_CONFLICT") {
      err.message = await humanizeEngineMessage(auth.orgId, err.message);
    }
    throw err;
  }

  const out: ScoreOutcome = {
    seq: result.seq,
    state_summary: result.summary,
    outcome: result.outcome,
    status: result.status,
  };

  // R10 M3: everything from here on runs AFTER the event committed, so the
  // invalidation and the pushes sit in `finally`. A post-commit hook that
  // throws (`onDecided` and `refreshDiscipline` do not swallow their own
  // failures) used to skip both, and the public pages kept serving the old
  // document for a score that already stood: the shape F3 fixed in
  // event-import.ts. The hook's error still propagates unchanged: `finally`
  // rethrows it once the awaited invalidation is done, and the invalidation's
  // own `.catch` means its failure can never replace it.
  // R10h: the fixtures this score named a winner (or loser) INTO, from the
  // advance's own write. The `finally` below reads it as it stands when it
  // runs, so a throw from a LATER hook (discipline, news) still publishes
  // them. A throw from inside `onDecided` itself, after its fill committed,
  // does not — that path leaves the next fixture on its own 30s TTL, which is
  // what every score did before this change.
  // Player stats (owner ruling 2026-09-16, option B): a result, or an undo that
  // may have changed one, refolds the division's stat snapshot AFTER the
  // response (`player-stats-refresh.ts`, which explains the timing and the
  // coalescing). Scheduled before the hooks below, so a hook that throws cannot
  // skip it: the events have committed either way.
  // An undo names its own seq: the refresh skips it when no fold ever read the
  // event it took back (a mid-play undo), which is most of them.
  if (refreshesPlayerStats(input.type, result.outcome)) {
    schedulePlayerStatsRefresh(
      auth.orgId,
      input.type === "core.void" ? { fixtureId, voidSeq: result.seq } : { fixtureId },
    );
  }

  let advanced: readonly string[] = [];
  try {
    // A decision (or a void that may have erased one) moves brackets/standings.
    if (result.outcome !== null || input.type === "core.void") {
      advanced = await onDecided(auth, fixtureId, result.outcome);
      await refreshDiscipline(auth, fixtureId);
      await refreshNews(auth, fixtureId);
    }

    if (cacheKey) await cacheSet(cacheKey, out, IDEM_TTL_SECONDS);
  } finally {
    await invalidateAndPush(auth, fixtureId, input, result, advanced);
  }
  return out;
}

/** Does this write change what the stats snapshot should say?
 *
 *  - A write that leaves the fixture decided: the deciding event itself, and
 *    anything recorded on a decided fixture afterwards.
 *  - Any `core.void`: an undo can drop a goal, or erase the decision.
 *
 *  `core.finalize` is left out. It locks a result that the deciding write
 *    already refreshed, and it carries no stat, so it would only fold the whole
 *    division a second time for every finished match.
 *
 *  Writes during play refresh nothing: leaders move when a result stands, not
 *  on every ball. */
export function refreshesPlayerStats(type: string, outcome: unknown): boolean {
  if (type === "core.void") return true;
  if (type === "core.finalize") return false;
  return outcome !== null;
}

/** scoreEvent's post-commit invalidation and realtime pushes (R10 M3: run from
 *  its `finally`). Never rejects. */
async function invalidateAndPush(
  auth: AuthCtx,
  fixtureId: string,
  input: AppendEventRequest,
  result: { outcome: unknown },
  /** R10h: the fixtures this score advanced a name into (`onDecided`'s own
   *  write). Empty for every score that advances nobody. */
  advanced: readonly string[] = [],
): Promise<void> {
  // After commit (doc 08 §4): realtime fire-and-forget, the public cache
  // awaited. Discovery surfaces refresh on decided/void/start writes only — and
  // only when the competition is discoverable (doc 15 §2, checked inside).
  const movesDiscovery =
    result.outcome !== null || input.type === "core.void" || input.type === "core.start";
  // P1 — AWAITED, never `void`. Next applies a route handler's revalidation
  // tags in ONE flush the moment the handler resolves and silently drops any
  // tag fired later. The voided call fired its tag after a DB lookup, so after
  // every score the hub, the competition page and the division page kept
  // serving the pre-score document until their 30s TTL ran out
  // (`__tests__/score-revalidate-in-request.test.ts`). The Redis sweeps inside
  // stay non-blocking. A failure is logged, not thrown: the score has already
  // committed, and this must not report it as failed.
  //
  // P1 round 2 (F2) — the realtime pushes go out only once the public Redis
  // copies they send a spectator back to have been DELETED (the delete
  // settled, whichever way it went), never before, and without holding this
  // response. Both channels have public receivers that refetch a Redis-cached
  // document on a push: `fixture:{id}` → the match centre and overlay
  // (`pub:v1:fixture:{id}`), `division:{id}` → the hub
  // (`pub:v1:hub:{competitionId}`). A refetch that beat the delete read the old
  // copy, and a subscribed page only polls as a slow safety net.
  //
  // R10 H4: both of those keys are literal, so the pushes wait on one direct
  // DEL, not on a full-keyspace SCAN; the division's glob sweep is not waited
  // on at all. The division push is addressed from the invalidation's own
  // lookup rather than a second query.
  //
  // R10 I1: and never longer than PUSH_AFTER_DELETE_BOUND_MS. A DEL that
  // never answers sends the pushes at the bound instead of never, once.
  //
  // R10h: a score that advances a winner (or a loser) into the next fixture
  // changes THAT fixture's public document too — the slot label it showed
  // becomes a name. Its key joins the one DEL above, and its push goes out
  // from this same callback, so it waits on that DEL exactly as the decided
  // fixture's does. Without it a spectator already watching the next round
  // (the final, opened while the semis play) sat on "TBD" until the 30s TTL
  // expired and the next poll landed. The reason is "schedule", the same one
  // every other slot-fill sends (`afterScheduleWrite`): what changed is who
  // is playing, not this fixture's score.
  await invalidatePublicCache(auth.orgId, fixtureId, movesDiscovery, (scope) => {
    void publishFixtureUpdate(fixtureId, "event");
    if (scope) void publishDivisionUpdate(scope.divisionId, "score");
    for (const id of advanced) void publishFixtureUpdate(id, "schedule");
  }, advanced).catch((err: unknown) => {
    log.error({ err, fixture: fixtureId }, "scoring: public cache invalidation failed (the score stands)");
    // It failed before any sweep started (the lookup, or the tag call), so
    // there is nothing to wait for. The scorer's other devices read the
    // ledger, not Redis, and still need their ping.
    //
    // R10h: and only that one. No DEL went out, so a push for a fixture this
    // score advanced a name into would send its spectators straight back to
    // the stale copy they are already showing; they keep their own poll.
    void publishFixtureUpdate(fixtureId, "event");
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Undo with nothing to undo is a 409, never a crash (v3/09 §2): a missing /
// unknown / already-voided target answers CONFLICT before the fold would 422,
// so a double-tapped "Undo last" degrades to a calm "already undone".
async function assertUndoTarget(
  auth: AuthCtx,
  fixtureId: string,
  input: AppendEventRequest,
): Promise<void> {
  const eventId = (input.payload as { event_id?: unknown } | null)?.event_id;
  if (typeof eventId !== "string" || !UUID_RE.test(eventId)) {
    throw new HttpError(409, "Nothing to undo");
  }
  const [target] = await withTenant(auth.orgId, (tx) => tx<{ type: string; voided: boolean }[]>`
    select e.type,
           exists (select 1 from score_events v
                   where v.fixture_id = e.fixture_id and v.voids_event_id = e.id) as voided
    from score_events e
    where e.id = ${eventId} and e.fixture_id = ${fixtureId}`);
  if (!target) throw new HttpError(409, "Nothing to undo — that entry does not exist");
  if (target.voided) throw new HttpError(409, "Nothing to undo — that entry is already undone");
  if (target.type === "core.void") {
    throw new HttpError(409, "An undo cannot be undone — re-record the entry instead");
  }
}

// Entitlement gates at THE scoring door:
//  - cricket.dls: a `cricket.revise` WITHOUT a manual target under a
//    dls-enabled config makes the fold compute a DLS target — Pro only. A
//    manual umpire target is always allowed;
//  - freeze: fixtures of an over-quota (frozen) competition are read-only.
// W1 (entitlements v18, owner ruling 2026-08-30): the fidelity-band gate that
// used to live here (event-type → feature, derived from the pinned module's
// `fidelityTiers`) is deleted — scoring detail is free on every plan, for
// every module, at every band. `cricket.dls` is untouched: it is a SEPARATE
// gate keyed on the event's payload + the division's config, not on fidelity.
// Unknown fixtures fall through — appendEvent owns that error.
async function assertEntitledToScore(
  auth: AuthCtx,
  fixtureId: string,
  input: AppendEventRequest,
): Promise<void> {
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  const ctx = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<
      {
        sport_key: string;
        module_version: string;
        config: unknown;
        competition_id: string;
        division_status: string;
        fixture_status: string;
        scorer_can_finalize: boolean;
      }[]
    >`
      select d.sport_key, d.module_version, d.config, d.competition_id,
             d.status as division_status, f.status as fixture_status,
             d.scorer_can_finalize
      from fixtures f join divisions d on d.id = f.division_id
      where f.id = ${fixtureId}`;
    if (!row) return null;
    assertNotFrozen(frozen, row.competition_id);
    return row;
  });
  if (!ctx) return;

  // Doc 12 §1: scoring opens only after the explicit start action
  // (division_started). A published-but-unstarted timetable stays read-only.
  if (ctx.division_status === "setup" || ctx.division_status === "scheduled") {
    throw new EngineError("WRONG_PHASE", "division has not started — scoring is closed", {
      divisionStatus: ctx.division_status,
    });
  }

  // Device-link capabilities (doc 13 §7): strictly ⊂ scorer. Append + void
  // OWN-LINK events pre-finalize; finalizing needs a human with a name.
  if (auth.via === "device_link") {
    if (input.type === "core.finalize") {
      throw new HttpError(403, "Finalizing needs an organiser or scorer account");
    }
    if (input.type === "core.void") {
      if (ctx.fixture_status === "finalized") {
        throw new HttpError(403, "This fixture is finalized — ask the organiser");
      }
      const eventId = (input.payload as { event_id?: unknown } | null)?.event_id;
      const isUuid =
        typeof eventId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId);
      const [target] = isUuid
        ? await withTenant(auth.orgId, (tx) => tx<{ device_link_id: string | null }[]>`
            select device_link_id from score_events
            where id = ${eventId} and fixture_id = ${fixtureId}`)
        : [];
      if (!target || target.device_link_id !== auth.deviceLinkId) {
        throw new HttpError(403, "A device link can only undo its own events");
      }
    }
  }

  // Scorer capabilities: coverage was proven at the door
  // (requireFixtureActor → requireScorable); here the per-division config
  // gates apply to non-editors (accepted officials). Finalize is config-gated;
  // undo is own-fixture PRE-finalize only — a finalized ledger is an editor's
  // to reopen.
  if (subjectToScorerCapabilityGates(auth)) {
    if (input.type === "core.finalize" && !ctx.scorer_can_finalize) {
      throw new HttpError(403, "Finalizing is restricted to organisers in this division");
    }
    if (input.type === "core.void" && ctx.fixture_status === "finalized") {
      throw new HttpError(403, "This fixture is finalized — ask an organiser to reopen it");
    }
  }

  // W1: scoring detail is free on every plan; only the DLS rain-rule gate
  // remains here until W2.
  if (requiresDlsEntitlement(input.type, ctx.config, input.payload)) {
    await requireFeature(auth.orgId, "cricket.dls");
  }
}

/**
 * The SECOND, non-fidelity entitlement gate (doc 10 §2 rule 4). A
 * `cricket.revise` carrying no manual umpire target, under a division whose
 * config enables DLS, is what makes the fold COMPUTE a Duckworth-Lewis-Stern
 * target — Pro only. A manual target is an umpire's own number and is always
 * allowed.
 *
 * W1 (entitlements v18): this is now the ONLY entitlement gate left at the
 * scoring door — `requiredFeatureForEvent` and the whole fidelity-band gate
 * it drove are deleted (scoring detail is free on every plan, owner ruling
 * 2026-08-30). It never overlapped with that gate anyway: the rule is about
 * the event's PAYLOAD and the DIVISION's config, neither of which a fidelity
 * band knows about.
 *
 * Exported (P11) for the batch importer, the same reason `onDecided` /
 * `refreshDiscipline` / `refreshNews` are exported just below: the importer
 * has to apply the identical gate, and one predicate with two callers is what
 * stops the live path and the import path from drifting. `divisionConfig` is
 * the DIVISION's `config` column — exactly what `assertEntitledToScore` reads
 * above — never a fixture cfg snapshot, which can legitimately differ.
 *
 * Pure: no I/O, so it is unit-testable and safe to call from anywhere,
 * including inside a transaction.
 */
export function requiresDlsEntitlement(
  eventType: string,
  divisionConfig: unknown,
  payload: unknown,
): boolean {
  if (eventType !== "cricket.revise") return false;
  const manualTarget = (payload as { target?: unknown } | null)?.target !== undefined;
  const dlsEnabled = (divisionConfig as { dls?: { enabled?: boolean } } | null)?.dls?.enabled === true;
  return dlsEnabled && !manualTarget;
}

// Discipline (SPEC-1): a decided/void write re-folds the division's card ledger
// into suspensions (recompute-on-read's write-side twin) and advances the
// serving counter — when the division has enabled rules OR holds an active ban.
// The second arm is a manual ban in a division whose auto-discipline is off:
// nothing else on the write path serves it, and the public readers that used to
// (the division page) are not a write path anyone should depend on. A one-query
// probe keeps the hot scoring path free for every division with neither.
//
// Exported (P11): the batch importer fires the exact same decided side
// effects scoreEvent does, in the same order — reusing these three rather
// than copying their bodies is what keeps the two paths from drifting apart.
export async function refreshDiscipline(auth: AuthCtx, fixtureId: string): Promise<void> {
  const served = await withTenant(auth.orgId, async (tx): Promise<ServedFlip[]> => {
    const [row] = await tx<{ division_id: string }[]>`
      select division_id from fixtures where id = ${fixtureId}`;
    if (!row) return [];
    const [due] = await tx`
      select 1
      where exists (select 1 from discipline_rules where division_id = ${row.division_id} and enabled)
         or exists (select 1 from suspensions where division_id = ${row.division_id} and status = 'active')`;
    if (!due) return [];
    return detectSuspensions(tx, row.division_id);
  });
  // After the commit, and only for the bans this pass flipped. The notice never
  // throws (see `notifyServedSuspensions`): the score already stands.
  await notifyServedSuspensions(served);
}

// News auto-drafts (SPEC-2): a decided/void write may draft a result/round_recap
// post when the division opted in AND the org has news.auto. A one-query probe
// (auto_posts) keeps the hot path free for divisions without news; the whole
// hook is swallowed — a draft/template hiccup must NEVER fail the score write
// (same isolation principle as the discipline/email fire-and-forget sends).
export async function refreshNews(auth: AuthCtx, fixtureId: string): Promise<void> {
  try {
    // The entitlement answer BEFORE the transaction: `hasFeature` is a pooled
    // read, and asking for it inside `withTenant` is the pool self-deadlock
    // (lib/db.ts). It is resolved unconditionally — one cached lookup on a path
    // that is about to open a transaction anyway.
    //
    // WITH the competition id, which costs the pooled lookup right above it.
    // V396 made `news.auto` false on Free and left it granted on both Event
    // Pass rungs, so an org-wide resolve falls through to the community row and
    // a pass holder's decided fixture silently drafts nothing on the
    // competition they paid for (`pass-scoping-guard.test.ts`).
    const [scope] = await sql<{ competition_id: string }[]>`
      select d.competition_id from fixtures f join divisions d on d.id = f.division_id
      where f.id = ${fixtureId}`;
    const newsAuto = await hasFeature(auth.orgId, "news.auto", scope?.competition_id);
    const drafted = await withTenant(auth.orgId, async (tx) => {
      const [row] = await tx<{ auto_posts: boolean }[]>`
        select d.auto_posts from fixtures f join divisions d on d.id = f.division_id
        where f.id = ${fixtureId}`;
      if (!row?.auto_posts) return [];
      return draftPostsForDecidedFixture(tx, fixtureId, newsAuto);
    });
    // AFTER the transaction commits, never inside it (review round 1, finding
    // 1): captureServer does a real network round trip, and this tx is the
    // live score write itself — holding it open on PostHog would stall a
    // scorer's tap. Fire-and-forget, matching `void publishFixtureUpdate`'s
    // shape below; captureServer never throws, so no `.catch` is needed. The
    // "only on a real insert" guard already ran inside the transaction
    // (`insertDraft`'s on-conflict-do-nothing check) — `drafted` only ever
    // carries rows that were actually written.
    for (const post of drafted) {
      void captureServer({
        event: EVENTS.POST_AUTO_DRAFTED,
        distinctId: `org:${post.orgId}`,
        orgId: post.orgId,
        properties: { kind: post.kind, trigger: post.trigger },
      });
    }
  } catch (err) {
    log.error({ err }, "scoring: news auto-draft failed (score write unaffected)");
  }
}

// A decided fixture feeds brackets (winner_to/loser_to slots) and refreshes
// the table-stage standings snapshot.
//
// R10h: returns the fixtures it named an entrant INTO, taken from the fill's
// own `returning id` — never from a re-read or a scan of the bracket, so a
// slot that was already filled (the update touches no row) is not reported as
// changed. `scoreEvent` DELs and pushes them beside the decided fixture; the
// batch importer ignores them, as it ignores its own pushes.
export async function onDecided(auth: AuthCtx, fixtureId: string, outcome: unknown): Promise<string[]> {
  // outcome may be null here (a void erased the decision) — recompute only.
  const o = (outcome ?? {}) as { kind?: string; winner?: string; loser?: string };
  const advanced: string[] = [];
  const context = await withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx<
      {
        stage_id: string;
        pool_id: string | null;
        winner_to_fixture: string | null;
        winner_to_slot: number | null;
        loser_to_fixture: string | null;
        loser_to_slot: number | null;
        kind: string;
        ext_key: string | null;
        stage_config: Record<string, unknown>;
        division_id: string;
      }[]
    >`
      select f.stage_id, f.pool_id, f.winner_to_fixture, f.winner_to_slot,
             f.loser_to_fixture, f.loser_to_slot, s.kind, f.ext_key,
             s.config as stage_config, s.division_id
      from fixtures f join stages s on s.id = f.stage_id
      where f.id = ${fixtureId}`;
    if (!fixture) return null;
    const winner = o.kind === "win" || o.kind === "award" ? o.winner : undefined;
    const loser = o.kind === "win" ? o.loser : undefined;
    if (winner && fixture.winner_to_fixture && fixture.winner_to_slot) {
      const filled = await fillSlot(tx, fixture.winner_to_fixture, fixture.winner_to_slot, winner);
      if (filled !== null) advanced.push(filled);
    }
    if (loser && fixture.loser_to_fixture && fixture.loser_to_slot) {
      const filled = await fillSlot(tx, fixture.loser_to_fixture, fixture.loser_to_slot, loser);
      if (filled !== null) advanced.push(filled);
    }
    // Placement games (Jul3/08 §4, 3 Jun/17 May): "winner of game X = 15th" —
    // the decided fixture writes rank locks via the Jul3/05 mechanism, never
    // alphabetical.
    const placements = (fixture.stage_config as { placements?: Record<string, [number, number]> })
      ?.placements;
    const place = fixture.ext_key !== null ? placements?.[fixture.ext_key] : undefined;
    if (place !== undefined && winner !== undefined && loser !== undefined) {
      const overrides =
        ((fixture.stage_config as { rank_overrides?: { entrant_id: string; rank: number }[] })
          .rank_overrides ?? []).filter((r) => r.entrant_id !== winner && r.entrant_id !== loser);
      overrides.push({ entrant_id: winner, rank: place[0] });
      overrides.push({ entrant_id: loser, rank: place[1] });
      await tx`
        update stages set config = ${tx.json({ ...(fixture.stage_config as object), rank_overrides: overrides } as never)}
        where id = ${fixture.stage_id}`;
    }
    // Ladder (Jul3/08 §6): the challenger taking the game takes the position.
    if (fixture.kind === "ladder" && winner !== undefined && loser !== undefined) {
      const cfg = fixture.stage_config as { ladder_order?: string[] };
      const order = [...(cfg.ladder_order ?? [])];
      const wi = order.indexOf(winner);
      const li = order.indexOf(loser);
      if (wi >= 0 && li >= 0 && wi > li) {
        [order[wi], order[li]] = [order[li]!, order[wi]!];
        await tx`
          update stages set config = ${tx.json({ ...(fixture.stage_config as object), ladder_order: order } as never)}
          where id = ${fixture.stage_id}`;
      }
    }
    return fixture;
  });
  if (context && TABLE_KINDS.has(context.kind)) {
    await recomputeStandings(auth.orgId, context.stage_id, context.pool_id ?? undefined);
    // D4a (P5 review finding): a decided-fixture correction is a standings
    // mutation exactly like overrideStandings' — LOCKED_FIXTURE_STATUSES
    // doesn't cover "decided", so this fires even on a fixture inside an
    // already-COMPLETE source stage. Same best-effort contract as the
    // overrideStandings call site: never blocks a score write that already
    // committed.
    await markDependentSeedProposalsStale(auth, context.stage_id);
  }
  // Auto-advance (Jul3/08 §5, 16 Sep): when the flag is on and the stage just
  // finished, progression fires without a button.
  if (context && o.kind !== undefined) {
    await maybeAutoAdvance(auth, context.stage_id, context.division_id);
  }
  // Only ever reached once the transaction above COMMITTED: a rollback throws
  // out of `withTenant`, so the ids of a fill that was undone never leave.
  return advanced;
}

async function maybeAutoAdvance(auth: AuthCtx, stageId: string, divisionId: string): Promise<void> {
  const ready = await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ auto_progress: boolean }[]>`
      select auto_progress from divisions where id = ${divisionId}`;
    if (!division?.auto_progress) return false;
    const [stage] = await tx<{ status: string }[]>`
      select status from stages where id = ${stageId}`;
    if (stage?.status === "complete") return false;
    const [{ open }] = await tx<{ open: number }[]>`
      select count(*) filter (where status <> 'decided' and status <> 'forfeited')::int as open
      from fixtures where stage_id = ${stageId}`;
    return open === 0;
  });
  if (!ready) return;
  const { completeStage } = await import("./stages");
  try {
    await completeStage(auth, stageId, { publish: false });
    await withTenant(auth.orgId, async (tx) => {
      const [{ seq: last }] = await tx<{ seq: number }[]>`
        select coalesce(max(seq), 0)::int as seq from division_events
        where division_id = ${divisionId}`;
      await tx`
        insert into division_events (division_id, seq, type, payload, actor_id)
        values (${divisionId}, ${last + 1}, 'stage_auto_advanced',
                ${tx.json({ stage_id: stageId } as never)}, ${auth.userId})`;
      await tx`update divisions set seq = ${last + 1} where id = ${divisionId}`;
    });
  } catch {
    // not ready (e.g. lots pending) — the organiser completes manually
  }
}

/** Finalize: lock the ledger via core.finalize (same path, same audit). */
export async function finalizeFixture(
  auth: AuthCtx,
  fixtureId: string,
  expectedSeq: number,
): Promise<ScoreOutcome> {
  return scoreEvent(auth, fixtureId, {
    expected_seq: expectedSeq,
    type: "core.finalize",
    payload: {},
  });
}

// Public dashboards cache in two layers, both invalidated by exactly this
// write: Redis pub:v1:* (the /api/v1/public endpoints, doc 08 §6) and Next's
// ISR tag cache (the (public) pages, doc 09 §3 — same write that publishes
// realtime fires the tag).
//
// Exported (P11), the same reason `onDecided`/`refreshDiscipline`/`refreshNews`
// above are: the batch importer has to invalidate exactly what a live score
// write invalidates, and reusing this rather than copying its body is what
// keeps the two paths from drifting. An import that skipped it left the public
// pages, the public API and discovery serving pre-import content — on a
// feature whose whole point is filling those pages (design doc §1/§2.1).
//
// P1 — every caller AWAITS this inside its request (`scoreEvent`,
// `importEvents`): the tag call below reaches Next's per-request flush only if
// it happens before the route handler resolves.
export async function invalidatePublicCache(
  orgId: string,
  fixtureId: string,
  movesDiscovery = false,
  /** Runs EXACTLY ONCE: when the literal-key DEL below settles (resolved or
   *  rejected), or after PUSH_AFTER_DELETE_BOUND_MS, whichever comes first
   *  (R10 I1). Never awaited by this function, so it never holds the caller's
   *  response. It does NOT wait for the division glob's SCAN (R10 H4). Handed
   *  the fixture's division and competition, or null when the fixture no
   *  longer exists. `scoreEvent` sends its realtime pushes here (P1 round 2,
   *  F2). Must not throw. */
  afterDeletes?: (scope: { divisionId: string; competitionId: string } | null) => void,
  /** R10h: other fixtures this same write changed — the ones a bracket advance
   *  named a winner or loser INTO. Their public documents are stale for the
   *  same reason the decided fixture's is, so their keys join the ONE DEL
   *  below instead of a second one. Caller-supplied, and already the product
   *  of its own write: this function never derives or re-reads them. */
  alsoFixtureIds: readonly string[] = [],
): Promise<void> {
  const row = await withTenant(orgId, async (tx) => {
    const [r] = await tx<
      { division_id: string; competition_id: string; org_id: string; discoverable: boolean }[]
    >`
      select f.division_id, d.competition_id, c.org_id, c.discoverable
      from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      where f.id = ${fixtureId}`;
    return r ?? null;
  });
  // The ISR tag FIRST, straight after the one awaited lookup. `fireScoreRevalidate`
  // expires the division tag outright instead of marking it stale
  // (revalidate.ts); `getPublicCompetitionHub` tags every division it read, so
  // this also drops the hub page's ISR entry.
  if (row) fireScoreRevalidate(row.division_id, row.competition_id);
  // The Redis deletes AFTER the tag, and not awaited. A delete that finished
  // before the tag would let a hub read in between rebuild from the
  // still-cached division and put the stale document back.
  //
  // R10 H4: two doors. The LITERAL keys, whose names are known, go out in ONE
  // direct DEL (`cacheDel`):
  //   - the fixture's own document;
  //   - W2's competition HUB document (usecases/public.ts's
  //     `pub:v1:hub:{competitionId}`). It carries every division's live
  //     scores, so a write to any fixture in the competition makes it stale.
  //     It is competition-keyed, not division-keyed, because one document
  //     spans the whole competition.
  //   - W2 Task 14's player-matches GENERATION
  //     (`pub:v1:player-matches-gen:{competitionId}`,
  //     player-matches-cache-keys.ts). The public player page's poll keys each
  //     person's lines under it; deleting it retires all of them. Those keys
  //     are per PERSON and this write does not know who played, so the only
  //     other door was a second keyspace SCAN on every score write.
  //   - the org home's live document (`pub:v1:org-live:{orgId}`,
  //     usecases/public.ts's `publicOrgLive`, spectator W2 Task 15). It counts
  //     every listed competition's in-play fixtures, and a score write is what
  //     moves a fixture into and out of `in_play`. Keyed by the fixture's own
  //     org, read in the lookup above.
  // Only the division's glob still needs a SCAN over the whole keyspace
  // (cache.ts), and no push depends on it. The hub rebuilds through
  // `loadCompetitionHub` and the fixture through `publicFixture`'s own query.
  // `pub:v1:div:{id}:*` backs only the public schedule, standings and entrants
  // endpoints.
  const fixtureKey = publicFixtureCacheKey(fixtureId);
  // R10h: the advanced-into fixtures' own documents ride the same DEL, after
  // the four keys every score drops. One round trip, and the pushes below then
  // wait on the delete that covers all of them.
  const keys = row
    ? [
        fixtureKey,
        `pub:v1:hub:${row.competition_id}`,
        playerMatchesGenKey(row.competition_id),
        `pub:v1:org-live:${row.org_id}`,
      ]
    : [fixtureKey];
  for (const id of alsoFixtureIds) keys.push(publicFixtureCacheKey(id));
  // F4: neither call is ever left to reject unhandled. Both helpers fail open
  // inside their try, but `client()` sits outside it (cache.ts). ioredis's
  // constructor throws synchronously on a REDIS_URL it cannot parse, so every
  // call would then reject.
  const deleted = cacheDel(...keys).catch((err: unknown) => {
    log.error({ err, fixture: fixtureId, keys }, "scoring: a public Redis delete failed (the write stands)");
  });
  if (row) {
    const pattern = `pub:v1:div:${row.division_id}:*`;
    void cacheDelPattern(pattern).catch((err: unknown) => {
      log.error({ err, fixture: fixtureId, pattern }, "scoring: a public Redis sweep failed (the write stands)");
    });
  }
  // F2: the catch above means this cannot reject, so it settles exactly when
  // the DEL has, whichever way that went. It does not wait for the SCAN.
  //
  // R10 I1: nor longer than PUSH_AFTER_DELETE_BOUND_MS, and exactly once.
  // `sendAfterDeleteOrBound` (cache.ts) owns that, and the schedule path sends
  // through the same helper (R10c m1).
  const scope = row ? { divisionId: row.division_id, competitionId: row.competition_id } : null;
  if (afterDeletes) sendAfterDeleteOrBound(deleted, () => afterDeletes(scope));
  if (!row) return;
  // Cheap by design (doc 15 §2 / PROMPT-19 item 4): the `discovery` tag
  // fires only for discoverable competitions.
  if (movesDiscovery && row.discoverable) {
    deferred(async () => {
      await invalidateDiscoveryCache();
      fireDiscoveryRevalidate();
    });
  }
}
