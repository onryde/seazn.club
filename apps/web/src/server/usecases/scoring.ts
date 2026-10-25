import "server-only";
// THE scoring path (doc 08 §4). Wraps the engine-db appendEvent adapter with:
// Redis idempotency (24 h — courtside retries on flaky Wi-Fi must be safe),
// per-fixture rate limiting, bracket slot progression, standings recompute,
// realtime publish and public-cache invalidation. undo = core.void through the
// same door.
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { cacheGet, cacheSet, cacheDel, sendAfterDeleteOrBound } from "@/lib/cache";
import { rateLimit } from "@/lib/rate-limit";
import { hasFeature, requireFeature } from "@/lib/entitlements";
import { deferred } from "@/lib/deferred";
import { divisionScoringClosed } from "@/lib/division-phase";
import { EngineError } from "@seazn/engine/core";
import { foldEpochOf } from "@seazn/engine/sport";
import { epochFloorOverrideOrOff, judgeEngineEpoch } from "./engine-epoch-override";
import { appendEvent, replayOutcomeFor, resolveModule, rulesVersionNow } from "@/server/engine-db";
import type { CascadeWriter } from "@/server/engine-db/append-event";
import { recomputeStandings } from "@/server/engine-db";
import { advancingSides, lockStageSeats } from "@/server/engine-db/fed-seats";
import { assertAdvancingSeat, assertNoLevelSeat, fedSeatOccupant } from "@/server/engine-db/level-seat";
import { log } from "@/server/logger";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { publishDivisionUpdate, publishFixtureUpdate } from "@/lib/realtime";
import { playerMatchesGenKey } from "@/server/public-site/player-matches-cache-keys";
import { publicFixtureCacheKey } from "@/server/public-site/fixture-doc-cache-key";
import { publicDivisionCacheKeys } from "@/server/public-site/division-doc-cache-keys";
import { publicHubCacheKey } from "@/server/public-site/hub-doc-cache-keys";
import {
  fireScoreRevalidate,
  fireDiscoveryRevalidate,
  invalidateDiscoveryCache,
} from "@/server/public-site/revalidate";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { AppendEventRequest } from "@/server/api-v1/schemas";
import { assertNotFrozen, frozenCompetitionIds } from "./entitlement-freeze";
import { subjectToScorerCapabilityGates } from "./scorers";
import { isOrganiserOnlyEvent } from "@/lib/organiser-only-events";
import { DEPARTED_STATUSES } from "./entrants";
import { hasActiveAbandonSql } from "@/server/engine-db/recorded-abandon";
import { fillSlot, markDependentSeedProposalsStale, resolveBracketSeats, stampDepartedSeat } from "./stages";
import { detectSuspensions, notifyServedSuspensions, type ServedFlip } from "./discipline";
import { draftPostsForDecidedFixture } from "./org-posts";
import {
  RESULT_CARRIED_FORWARD,
  RESULT_CARRIED_FORWARD_MESSAGE,
  SETTLED_OPEN_STATUSES,
  carriedForwardFacts,
  isCarriedForward,
} from "./carried-forward";
import { schedulePlayerStatsRefresh } from "./player-stats-refresh";

export interface ScoreOutcome {
  seq: number;
  state_summary: unknown;
  outcome: unknown;
  status: string;
  /** The id of the row this write created — or, on an idempotent replay, the
   *  row the ORIGINAL write created. A pad that is not told it keeps the event
   *  under the key it minted, and cannot then resolve a void that names the
   *  server's id (the device chrome's "Void my last entry", the console's
   *  undo, a second official's). Every answer this function returns carries
   *  it, cached ones included: the Redis fast path stores this same object. */
  event_id: string;
  /** W2c Task 15 (X-SR-7, owner P-1) — the match's rules version (`fixtures.rules_version`, the corrections of its
   *  format) as this answer saw it. A pad that loaded an older one reloads the rules before its next tap; a tap it sends
   *  under the old version is refused (FIXTURE_RULES_CHANGED). A replayed answer carries the version NOW. */
  rules_version: number;
}

const IDEM_TTL_SECONDS = 24 * 60 * 60; // doc 08 §4
/** The prefix is the cached answer's SHAPE version. v2 = `ScoreOutcome` with
 *  `event_id`: an answer cached under v1 lacks it and outlives a deploy by up
 *  to `IDEM_TTL_SECONDS`, so serving it would ack a pad with no row id — the
 *  shape device-void-mine's Fix A exists to end. A v2 miss falls through to
 *  the durable replay, which carries the id. Bump it again whenever
 *  `ScoreOutcome` gains a field a reader relies on. v3 (W2c Task 15) =
 *  `rules_version`: the API declares it on every accepted answer. */
const idemKey = (fixtureId: string, key: string) => `idemv3:${fixtureId}:${key}`;

// One scorer's cadence (doc 08 §6).
const SCORING_LIMIT = { max: 10, windowSeconds: 1 };

/** The replay path's abuse CEILING — not a pacing control (2026-09-21, W1
 *  round 2). A replay performs no write, so nothing about a real pad's rhythm
 *  should ever approach this: a queue drained after a tab death is a handful of
 *  requests, and even several devices on one fixture retrying at once are tens,
 *  not hundreds. It exists only to bound a caller hammering ONE known
 *  idempotency key, which a leaked `dl_` URL makes reachable — see the note on
 *  the replay branch below.
 *
 *  Derived from `SCORING_LIMIT`, never typed beside it, so raising the scoring
 *  cadence raises this with it and the two cannot silently invert. Deliberately
 *  fail-OPEN (no `failClosed`), exactly like the write limiter: a Redis outage
 *  must never stop a scorer recording a match. */
const REPLAY_LIMIT = {
  max: SCORING_LIMIT.max * 6,
  windowSeconds: SCORING_LIMIT.windowSeconds,
};

/** The unique index V413 added: `(fixture_id, idempotency_key)`. Matched on the
 *  NAME, never on a bare 23505 — `score_events` carries other unique
 *  constraints (its primary key, and the `(fixture_id, seq)` gapless index),
 *  and treating one of THOSE as "you already sent this" would answer a real
 *  collision with a fabricated success. Same rule as `slugs.ts:61` and
 *  `event-import.ts:84`. */
function isIdemKeyViolation(e: unknown): boolean {
  const pg = e as { code?: string; constraint_name?: string } | null;
  return pg?.code === "23505" && pg?.constraint_name === "score_events_idem_key";
}

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
  /** Server-internal, never a request field (W2b PF-2): the withdrawal cascade names itself here, and only it may
   *  record the cascade-only events (append-event.ts `assertW2bWriteGuards`). */
  opts: { writer?: CascadeWriter } = {},
): Promise<ScoreOutcome> {
  // A FAST PATH, no longer the guarantee (W2, design §6). Until this wave the
  // cache was the ONLY thing standing between a retry and a second write, so a
  // cold, down, or past-TTL Redis meant a duplicated score — silently, because
  // cacheGet fails open. The durable answer now lives in the ledger, on the
  // `(fixture_id, idempotency_key)` unique index, and is served from the catch
  // block below. This check survives only to spare Postgres the round trip.
  //
  // The replay check runs FIRST (2026-09-21, W1). A retry carrying a key we
  // have already answered performs no write, so charging it a WRITE slot made
  // retries self-amplifying against a bucket that is PER FIXTURE — every device
  // scoring the same match shares it.
  //
  // That ordering is right and stays. What it left behind (found in review, W1
  // round 2) is that a replay then passed NO limiter at all. The first version
  // of this comment argued it was not a new surface because the check is one
  // Redis GET, "the same cost class as the limiter's own INCR" — which is true
  // about the cost of one request and says nothing about how many may be sent.
  // Bounded cost times unbounded count is unbounded, and a `dl_` secret is a
  // shareable URL, so anyone holding a leaked link could replay one known key
  // forever. Hence a SECOND, far more generous ceiling on the replay branch
  // only; the write path below is untouched.
  const cacheKey = input.idempotency_key ? idemKey(fixtureId, input.idempotency_key) : null;
  if (cacheKey) {
    const replay = await cacheGet<ScoreOutcome>(cacheKey);
    if (replay) {
      await rateLimit(`scorereplayv1:${fixtureId}`, REPLAY_LIMIT);
      // Batch-5 m-2: a replayed answer carries the rules version NOW (`ScoreOutcome.rules_version`), whichever tier serves
      // it - the durable replay reads it off the row, and the cached answer holds the version of the original write. A
      // lost-ack retry after a correction is what tells the pad to reload; an overlay per answer, never written back.
      // Best-effort: the overlay only ENRICHES an answer the pad already has, and the cache fails open for the same reason
      // (a retry must not be refused because a backing store is down). A read that rejects keeps the cached answer.
      const now = await rulesVersionNow(auth.orgId, fixtureId).catch(() => null);
      return now === null || now === replay.rules_version ? replay : { ...replay, rules_version: now }; // same answer, no double write
    }
  }

  await rateLimit(`scorev1:${fixtureId}`, SCORING_LIMIT);

  // `replay` is non-null only when a device link's keyed RETRY meets the carried-forward
  // refusal and the ledger already holds that key (scorer sheets §4.3, review
  // I1): the retry gets the original answer, exactly as the catch below would
  // have given it had the refusal not stood in front of appendEvent.
  const { replay: carriedReplay, sport } = await assertEntitledToScore(auth, fixtureId, input);
  if (carriedReplay) {
    await rateLimit(`scorereplayv1:${fixtureId}`, REPLAY_LIMIT);
    if (cacheKey) await cacheSet(cacheKey, carriedReplay, IDEM_TTL_SECONDS);
    return carriedReplay;
  }

  // Engine-split D15/D26/D31: a client whose fold epoch for this sport is BEHIND the server's would fold the ledger it
  // writes to differently, so a NEW write from it is refused. It sits here, and nowhere earlier, on purpose:
  //   - after the cache replay above and after assertEntitledToScore: authorisation, entitlement and phase refusals
  //     outrank it (an outdated phone that may not write at all learns that, not "update"), and a retry the cache
  //     already answered is a replay, not a write;
  //   - after a DURABLE replay lookup (assertEngineEpoch): a retry of a key the ledger already holds answers 201
  //     whether the cache is warm or cold, even though the epoch has moved since that first write was accepted.
  // `core.void` is included: an outdated phone's undo would void against a ledger it folds differently.
  const answerReplay = async (replayed: ScoreOutcome): Promise<ScoreOutcome> => {
    await rateLimit(`scorereplayv1:${fixtureId}`, REPLAY_LIMIT);
    if (cacheKey) await cacheSet(cacheKey, replayed, IDEM_TTL_SECONDS);
    return replayed;
  };
  const clientEpoch = input.engine_epoch;
  if (clientEpoch !== undefined && sport !== null) {
    const replayed = await assertEngineEpoch(auth, fixtureId, sport, clientEpoch, input.idempotency_key);
    if (replayed) return answerReplay(replayed);
  }
  if (input.type === "core.void") {
    // Review 1f F4: a KEYED void's retry meets a target the first void already undid, so assertUndoTarget would refuse it
    // 409 UNDO_ALREADY_VOIDED before appendEvent's own durable replay (its catch, below) is ever reached — with the cache cold
    // (TTL, Redis down) the pad would be told "nothing to undo" for an undo that landed. Ask the ledger first: one query,
    // and only for a keyed void. An unkeyed double-void, or a key the ledger does not hold, still reaches the 409.
    if (input.idempotency_key) {
      const replayed = await replayOutcomeFor(auth.orgId, fixtureId, input.idempotency_key);
      if (replayed) return answerReplay(replayed);
    }
    await assertUndoTarget(auth, fixtureId, input);
  }

  let result;
  try {
    result = await appendEvent(auth.orgId, fixtureId, input.expected_seq, {
      type: input.type,
      payload: input.payload,
      // Device links: recorded_by = issued_by (auth.userId carries the issuer,
      // doc 13 §7) + the device_link_id rider so the ledger distinguishes them.
      recordedBy: auth.userId,
      deviceLinkId: auth.deviceLinkId ?? null,
      // W2 — the durable half of idempotency. The cache above is now only a
      // fast path; THIS is what makes a retry safe when Redis is down, cold,
      // or past its 24h TTL. The column is nullable and NULLs are distinct in
      // a unique index, so un-keyed callers are entirely unaffected.
      idempotencyKey: input.idempotency_key ?? null,
      // W2c Task 15 (X-SR-7, owner P-1): only a scoring pad sends it, and only a sent version is checked; the console
      // and the server's own writers (cascade, finalize, settle) never do.
      ...(input.rules_version !== undefined ? { rulesVersion: input.rules_version } : {}),
      ...(opts.writer !== undefined ? { writer: opts.writer } : {}),
      ...(input.type === "core.void" &&
      typeof (input.payload as { event_id?: unknown })?.event_id === "string"
        ? { voids: (input.payload as { event_id: string }).event_id }
        : {}),
    });
  } catch (err) {
    // A duplicate of a write we ALREADY recorded arrives in two shapes, and
    // the plan for this wave only anticipated the second. Both are caught here,
    // OUTSIDE appendEvent's own `withTenant`: a 23505 aborts that transaction,
    // so any query issued inside it would fail 25P02 and mask the real error.
    //
    //   1. The sequential retry — the common case, and the one the Redis cache
    //      used to absorb. The first write COMMITTED, so the ledger tip has
    //      moved and the retry's `expected_seq` is now stale: appendEvent's
    //      optimistic-concurrency check (append-event.ts:198) raises
    //      SEQ_CONFLICT and returns BEFORE the insert is ever attempted. No
    //      unique violation happens, so matching only on 23505 would let this
    //      case through as a 409 — measured, not assumed (2026-09-22).
    //   2. The genuine race — two requests carrying the same key, both with a
    //      valid `expected_seq`, both past the seq check. The loser's insert
    //      trips the unique index.
    //
    //   3. The retry of the write that LOCKED the fixture (review 1f F11): a
    //      finalize, or a fixture cancelled since. appendEvent refuses a locked
    //      fixture BEFORE its seq check (ALREADY_DECIDED), so neither shape
    //      above is ever raised — with the cache cold, the lost-ack retry of
    //      the deciding tap would be told the match is already decided.
    //
    // In all three, the question is the same: did THIS fixture already record
    // THIS key? The ledger answers it. A SEQ_CONFLICT or ALREADY_DECIDED with no
    // such key is a real refusal — another device got ahead, or the match is
    // over — and must still raise, which is why the lookup gates the answer
    // rather than the error code alone.
    if (
      input.idempotency_key &&
      ((err instanceof EngineError && (err.code === "SEQ_CONFLICT" || err.code === "ALREADY_DECIDED")) ||
        // W2c Task 15: the rules check runs BEFORE the seq check, so a keyed retry of a tap the ledger recorded
        // before a correction meets FIXTURE_RULES_CHANGED, not SEQ_CONFLICT. It already landed: the original answer.
        (err instanceof HttpError && err.code === "FIXTURE_RULES_CHANGED") ||
        isIdemKeyViolation(err))
    ) {
      const replayed = await replayOutcomeFor(auth.orgId, fixtureId, input.idempotency_key);
      if (replayed) {
        await rateLimit(`scorereplayv1:${fixtureId}`, REPLAY_LIMIT);
        // Warm the fast path so the NEXT retry never reaches Postgres. Best
        // effort by design: cacheSet is a no-op without Redis, and the ledger
        // answer above does not depend on it.
        if (cacheKey) await cacheSet(cacheKey, replayed, IDEM_TTL_SECONDS);
        return replayed;
      }
    }
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
    event_id: result.event.id,
    rules_version: result.rulesVersion,
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

  // Owner ruling 2026-09-23: a write that erased a knockout decision — or,
  // since fix round 1, FLIPPED it to the other side — has ALREADY emptied the
  // seats that decision filled, inside the append's own transaction
  // (`result.released`). Those fixtures changed exactly the way an
  // advanced-into fixture does — a name became "Winner of …" (and, on a flip,
  // `onDecided` below seats the new winner there) — so they seed the same list,
  // and ride the same DEL and push, even if a hook below throws.
  let advanced: readonly string[] = result.released;
  try {
    // A decision (or a void that may have erased one) moves brackets/standings.
    // W2a (spec §5.4.4): a HELD fixture (needs_decision) seats nobody, so onDecided is not called for it.
    if ((result.outcome !== null && result.status !== "needs_decision") || input.type === "core.void") {
      const filled = await onDecided(auth, fixtureId);
      advanced = [...result.released, ...filled.filter((id) => !result.released.includes(id))];
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
  // (`__tests__/score-revalidate-in-request.test.ts`). The Redis delete inside
  // stays non-blocking. A failure is logged, not thrown: the score has already
  // committed, and this must not report it as failed.
  //
  // P1 round 2 (F2) — the realtime pushes go out only once the public Redis
  // copies they send a spectator back to have been DELETED (the delete
  // settled, whichever way it went), never before, and without holding this
  // response. Both channels have public receivers that refetch a Redis-cached
  // document on a push: `fixture:{id}` → the match centre and overlay
  // (`pub:v1:fixture:v3:{id}`), `division:{id}` → the hub
  // (`pub:v1:hub:{competitionId}`). A refetch that beat the delete read the old
  // copy, and a subscribed page only polls as a slow safety net.
  //
  // R10 H4: both of those keys are literal, so the pushes wait on one direct
  // DEL, not on a full-keyspace SCAN. Review r2-m4: the division's documents
  // ride that same DEL by name, and no SCAN is sent at all. The division push
  // is addressed from the invalidation's own lookup rather than a second query.
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
    // It failed before the delete started (the lookup, or the tag call), so
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
//
// Each case carries its OWN wire code (2026-09-21, W1). All four are TERMINAL:
// no expected_seq can satisfy them. `transport.ts` classifies on these codes so
// the pad stops renegotiating a refusal it can never win — which used to wedge
// the queue head permanently. A new terminal case added here MUST get a code
// and copy, or it falls back to CONFLICT and reintroduces the wedge.
async function assertUndoTarget(
  auth: AuthCtx,
  fixtureId: string,
  input: AppendEventRequest,
): Promise<void> {
  const eventId = (input.payload as { event_id?: unknown } | null)?.event_id;
  if (typeof eventId !== "string" || !UUID_RE.test(eventId)) {
    throw new HttpError(409, "Nothing to undo", "UNDO_NOOP");
  }
  const [target] = await withTenant(auth.orgId, (tx) => tx<{ type: string; voided: boolean }[]>`
    select e.type,
           exists (select 1 from score_events v
                   where v.fixture_id = e.fixture_id and v.voids_event_id = e.id) as voided
    from score_events e
    where e.id = ${eventId} and e.fixture_id = ${fixtureId}`);
  if (!target) {
    throw new HttpError(409, "Nothing to undo — that entry does not exist", "UNDO_TARGET_MISSING");
  }
  if (target.voided) {
    throw new HttpError(
      409,
      "Nothing to undo — that entry is already undone",
      "UNDO_ALREADY_VOIDED",
    );
  }
  if (target.type === "core.void") {
    throw new HttpError(
      409,
      "An undo cannot be undone — re-record the entry instead",
      "UNDO_NOT_UNDOABLE",
    );
  }
}

/** Test-only alias. `assertUndoTarget` is module-private by intent; the wire
 *  codes it throws are a contract `transport.ts` classifies on, so they get a
 *  direct test rather than one mediated by the whole scoreEvent path. */
export const __assertUndoTargetForTests = assertUndoTarget;

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
// Returns `{ replay, sport }`. `replay` is null, except for a device link's keyed
// RETRY on a carried-forward fixture, where it is the ledger's replay of the
// original write (review I1; see the device-link block). `sport` is the fixture's
// sport as its division pins it, handed on to the engine-epoch gate; null for an
// unknown fixture (appendEvent owns that error).
async function assertEntitledToScore(
  auth: AuthCtx,
  fixtureId: string,
  input: AppendEventRequest,
): Promise<{ replay: ScoreOutcome | null; sport: FixtureSport | null }> {
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
  if (!ctx) return { replay: null, sport: null };
  const sport: FixtureSport = { key: ctx.sport_key, moduleVersion: ctx.module_version };

  // Doc 12 §1: scoring opens only after the explicit start action
  // (division_started). A published-but-unstarted timetable stays read-only.
  // The same predicate the scan page opens "Not started yet" on (scorer
  // sheets, owner fix 2026-09-24), so that screen and this refusal agree.
  if (divisionScoringClosed(ctx.division_status)) {
    throw new EngineError("WRONG_PHASE", "division has not started — scoring is closed", {
      divisionStatus: ctx.division_status,
    });
  }

  // X-ST-2 (ruling 77, widened by owner ruling D-O1): settle, forfeit and abandon — and a sport event that records a
  // forfeit or walkover (chess `boardgame.result` method forfeit/double_forfeit) — end or decide a match, so only an
  // organiser may record them: never a device link, never an official scorer (subjectToScorerCapabilityGates: a
  // session that is not owner/admin). An org API key is an organiser credential and passes, as it does for finalize
  // and void. Placed before the device and scorer branches so neither can let one through; 403 → FORBIDDEN on the
  // wire. The pad reads the same predicate (pad-host.tsx), so the two cannot drift. The authority is this request's
  // AuthCtx, resolved once at the door: a role change lands on the next request.
  if (isOrganiserOnlyEvent(input.type, input.payload) && (auth.via === "device_link" || subjectToScorerCapabilityGates(auth))) {
    const verb =
      input.type === "core.settle"
        ? "settle"
        : input.type === "core.forfeit"
          ? "record a walkover for"
          : input.type === "core.abandon"
            ? "abandon"
            : "record a forfeit in";
    throw new HttpError(403, `Only an organiser can ${verb} a match`);
  }

  // Device-link capabilities (doc 13 §7): strictly ⊂ scorer. Append + void
  // OWN-LINK events pre-finalize; finalizing needs a human with a name.
  if (auth.via === "device_link") {
    if (input.type === "core.finalize") {
      throw new HttpError(403, "Finalizing needs an organiser or scorer account");
    }
    // Scorer sheets §4.3: once a settled result has moved the competition on —
    // a feed seated, the next Swiss round seated, the stage complete — a
    // device link may do nothing more with this fixture; corrections are the
    // organiser's. Evaluated LIVE (unpairing re-opens it), and only for a
    // settled fixture, so a live tap never pays for the query.
    // ONE status gate on this path, and it is this one: the facts are read
    // without resultCarriedForward's own status check, so neither guard
    // covers for the other (pre-flight A15).
    if (SETTLED_OPEN_STATUSES.has(ctx.fixture_status)) {
      const loaded = await withTenant(auth.orgId, (tx) => carriedForwardFacts(tx, fixtureId));
      if (loaded && isCarriedForward(loaded.facts)) {
        // Review I1: a keyed RETRY of a write the ledger already holds is a
        // replay, not a new write. The device's own deciding tap is what
        // carries a knockout SF, so a lost ack's retry lands here; with Redis
        // down (or the retry beating the cacheSet) the fast path misses, and
        // appendEvent's catch — the durable replay — is behind this throw.
        // Ask the ledger first. Only a settled, carried fixture pays for it.
        if (input.idempotency_key) {
          const replayed = await replayOutcomeFor(auth.orgId, fixtureId, input.idempotency_key);
          if (replayed) return { replay: replayed, sport };
        }
        throw new HttpError(403, RESULT_CARRIED_FORWARD_MESSAGE, RESULT_CARRIED_FORWARD);
      }
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
  return { replay: null, sport };
}

/** The fixture's sport as its division pins it: what `assertEntitledToScore` already loaded, handed on for the epoch gate. */
interface FixtureSport {
  key: string;
  moduleVersion: string;
}

/**
 * The server minimum-epoch gate (engine-split D15, D26, D31; spec §5.6). Refuses a write carrying an `engine_epoch` LOWER than
 * `foldEpochOf(sport)` — 426 ENGINE_OUTDATED, `{ sport, required, got }` — and returns null when the write may proceed.
 * Higher is accepted on purpose (owner, 2026-10-15: a phone ahead of the server is a supported release-discipline state), and
 * so is an absent epoch (D31; the caller asks only when one is present — that one `!== undefined` test is the sole guard).
 *
 * Returns a ScoreOutcome ONLY for a retry of a key the ledger already holds: it must be asked before the refusal, so an
 * accepted write retried after the epoch moved gets its original answer instead of an "update the app" it cannot act on.
 * The lookup is the one the 23505 catch in `scoreEvent` uses (`replayOutcomeFor`), and it costs a query only when the phone is
 * actually behind. A refusal writes nothing and caches nothing, so the key is not burned.
 *
 * THE SPORT IS RESOLVED FIRST. `foldEpochOf` throws a plain Error for a sport it has no epoch for (engine `fold-epoch.ts`), which
 * the v1 kernel would answer as a 500; the registry throws EngineError("MODULE_NOT_FOUND") — a 422 — for the same unknown
 * sport or a pinned version this build no longer ships, so an unknown sport can never reach `foldEpochOf`.
 *
 * THE FLOOR OVERRIDE (`ENGINE_EPOCH_FLOOR_OVERRIDE`, engine-split spec §5.6, `engine-epoch-override.ts`): a default-off emergency lever that
 * LOWERS the floor for the sports it names, `min(foldEpochOf(sport), override)`, never raises it. A request admitted ONLY because of it
 * (below the sport's own epoch, at or above the lowered floor) logs `ENGINE_EPOCH_FLOOR_OVERRIDDEN`: at most one line per request that
 * passed the gate (it says the gate admitted, not that a row was written - a cold retry of a key the ledger holds passes it again and is
 * then replayed). A refusal under an override reports the EFFECTIVE floor as `required` (what the client must reach to be admitted),
 * and the lockout line adds `declared`, the sport's own epoch; `required` always means the effective floor, `declared` the sport's own.
 * A malformed override does NOT throw here (boot refuses it): `epochFloorOverrideOrOff` answers "no override", which is today's floors,
 * and reports the bad value once. The replay lookup below is untouched: it still runs before any refusal.
 */
async function assertEngineEpoch(
  auth: AuthCtx,
  fixtureId: string,
  sport: FixtureSport,
  got: number,
  idempotencyKey: string | undefined,
): Promise<ScoreOutcome | null> {
  const sportKey = resolveModule(sport.key, sport.moduleVersion).key;
  const declared = foldEpochOf(sportKey);
  const verdict = judgeEngineEpoch(got, declared, epochFloorOverrideOrOff().get(sportKey));
  if (verdict.admitted) {
    if (verdict.viaOverride) {
      // Ops visibility for the lever: this request passed the gate only because the floor was lowered by hand. At most one line per
      // request - the gate admitted it, which is not the same as a row being written (see the doc above).
      log.warn(
        { code: "ENGINE_EPOCH_FLOOR_OVERRIDDEN", sport: sportKey, floor: verdict.floor, declared, got, via: auth.via, deviceLinkId: auth.deviceLinkId ?? null, fixtureId },
        "scoring: ENGINE_EPOCH_FLOOR_OVERRIDDEN — a request was admitted below the server's fold epoch by ENGINE_EPOCH_FLOOR_OVERRIDE",
      );
    }
    return null;
  }
  const required = verdict.floor;
  if (idempotencyKey) {
    const replayed = await replayOutcomeFor(auth.orgId, fixtureId, idempotencyKey);
    if (replayed) return replayed;
  }
  // Ops visibility (review 1f F5): a refusal is a scorer locked out of a match, and the v1 kernel logs only 5xx. One structured
  // line per 426 — ids and numbers only, no names or tokens; requestId / orgId / userId arrive through the logger's mixin.
  log.warn(
    {
      code: "ENGINE_OUTDATED",
      sport: sportKey,
      required,
      // Only under an override: the sport's own epoch, so a lockout line shows both numbers. Absent otherwise (the line is unchanged).
      ...(required === declared ? {} : { declared }),
      got,
      via: auth.via,
      deviceLinkId: auth.deviceLinkId ?? null,
      fixtureId,
    },
    "scoring: ENGINE_OUTDATED — a client's fold epoch is behind the server's",
  );
  throw new HttpError(
    426,
    `This app's scoring rules for ${sportKey} are out of date — update the app to keep scoring`,
    "ENGINE_OUTDATED",
    { sport: sportKey, required, got },
  );
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
//
// Review M2 (fix round 2): it reads the result it acts on ITSELF, under the
// fixture's own append lock, and never takes one from its caller. It runs
// after the append committed, so a void can commit in between: that void's
// un-fill (fed-seats.ts) finds the seat still empty — this fill has not run —
// and a fill from the caller's copy would then seat the very winner the void
// took away. Under the lock, the void has either committed (and this reads
// its erased or flipped outcome) or not started (and its un-fill will find
// the name this writes and take it back).
export async function onDecided(auth: AuthCtx, fixtureId: string): Promise<string[]> {
  const advanced: string[] = [];
  const context = await withTenant(auth.orgId, async (tx) => {
    // Loop R I-2 / R2 N-1: a line that feeds a seat reads the seats it feeds, and the cascade below reads every feeder's
    // stored decision — so first the stage lock a double walkover's void holds while it revives (`lockStageSeats`), and
    // it comes BEFORE this fixture's own lock: the one order (stage, then fixtures), so a void holding the stage while
    // it asks for this fixture's lock never waits on a decision that holds this fixture's lock while it asks for the
    // stage. Read without a lock: a fixture never changes stage. A line that feeds nothing (a league, a group, a final)
    // never waits.
    const [pre] = await tx<{ stage_id: string; feeds: boolean }[]>`
      select stage_id, (winner_to_fixture is not null or loser_to_fixture is not null) as feeds
        from fixtures where id = ${fixtureId}`;
    if (pre?.feeds) await lockStageSeats(tx, pre.stage_id);
    await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + fixtureId}))`;
    const [fixture] = await tx<
      {
        outcome: unknown;
        status: string;
        stage_id: string;
        pool_id: string | null;
        home_entrant_id: string | null;
        away_entrant_id: string | null;
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
      select f.outcome, f.status, f.stage_id, f.pool_id, f.home_entrant_id, f.away_entrant_id,
             f.winner_to_fixture, f.winner_to_slot,
             f.loser_to_fixture, f.loser_to_slot, s.kind, f.ext_key,
             s.config as stage_config, s.division_id
      from fixtures f join stages s on s.id = f.stage_id
      where f.id = ${fixtureId}`;
    if (!fixture) return null;
    // An edge wired between the two reads (`wireCrossFeeds` runs when a later stage is generated, play or no play): the
    // stage lock late, behind this fixture's — the one window the old order survives in, and still better than a
    // cascade that reads its feeders unserialised.
    if (!pre?.feeds && (fixture.winner_to_fixture !== null || fixture.loser_to_fixture !== null)) await lockStageSeats(tx, fixture.stage_id);
    // W2c Task 15 (Task 2 I-1, batch-3 carry): a decision that feeds a seat may AWARD the line it feeds (the cascade
    // below walks an opponent over a dead feeder, `resolveBracketSeats`), and that line, unstarted, has no snapshot: its
    // award is scored under the division's LIVE config. So the format freeze's lock, SHARED, as a first append takes it
    // (`append-event.ts`): a division or stage format save in flight (holding it EXCLUSIVE) commits first and the award
    // is scored under what it committed; a save that arrives after waits for this award to commit and then sees it.
    // After the stage seats and this fixture's lock (the one order: `division:` → stage seats → `fixture:` →
    // `division-config:`). A decision that feeds nothing awards nothing and never waits.
    if (fixture.winner_to_fixture !== null || fixture.loser_to_fixture !== null) {
      await tx`select pg_advisory_xact_lock_shared(hashtext(${"division-config:" + fixture.division_id}))`;
    }
    // X-BR-1: a level outcome under a seating status in a bracket is the bug shape (level-seat.ts).
    assertNoLevelSeat({ fixtureId, stageKind: fixture.kind, status: fixture.status, outcome: fixture.outcome });
    // W2b D20: a double walkover advances nobody, so a seat it feeds holding one of its entrants is the bug shape.
    const fed = new Map<string, readonly [string | null, string | null]>();
    for (const target of [fixture.winner_to_fixture, fixture.loser_to_fixture]) {
      if (target === null || fed.has(target)) continue;
      const [t] = await tx<{ home_entrant_id: string | null; away_entrant_id: string | null }[]>`
        select home_entrant_id, away_entrant_id from fixtures where id = ${target}`;
      if (t) fed.set(target, [t.home_entrant_id, t.away_entrant_id]);
    }
    assertAdvancingSeat({
      fixtureId,
      stageKind: fixture.kind,
      status: fixture.status,
      outcome: fixture.outcome,
      seatedEntrant: fedSeatOccupant(fixture, (id) => fed.get(id) ?? null),
    });
    // One reading of who advances, shared with the un-fill (fed-seats.ts), so
    // the two can never disagree about which name a decision put where.
    const { winner, loser } = advancingSides(fixture.outcome);
    // Loop-F I-1: a DEPARTED winner (a void re-opened her line after she left, and she won it again) is never seated;
    // her seat is stamped dead as her withdrawal stamped it, and the cascade below walks her opponent over it.
    const winnerDeparted =
      winner !== undefined &&
      (await tx<{ id: string }[]>`select id from entrants where id = ${winner} and status in ${tx([...DEPARTED_STATUSES])}`)
        .length > 0;
    if (winner && fixture.winner_to_fixture && fixture.winner_to_slot) {
      const filled = winnerDeparted
        ? await stampDepartedSeat(tx, fixture.winner_to_fixture, fixture.winner_to_slot)
        : await fillSlot(tx, fixture.winner_to_fixture, fixture.winner_to_slot, winner);
      if (filled !== null) advanced.push(filled);
    }
    // W2b X-WD-5: a departed entrant (`DEPARTED_STATUSES`: withdrawn or disqualified) is never seated on a loser
    // edge. A decision that names her as its loser — a settle on a LEGACY held line (plan PF-8a), or a line she lost
    // after a disqualification (a status change, no cascade) — leaves her seat empty, and the cascade below reads it
    // dead (`loserFeederIsDead`) and walks her opponent over it. Loop-F R-1: the seat is STAMPED dead as well, as a
    // departed winner's is (I-1), so a void of this line finds the stamp and revives whatever the dead seat settled — a
    // third-place line voided because both its loser feeds were dead stays void otherwise, and the side re-deciding
    // this line would be seated into the abandoned row.
    const loserDeparted =
      loser !== undefined &&
      (await tx<{ id: string }[]>`select id from entrants where id = ${loser} and status in ${tx([...DEPARTED_STATUSES])}`)
        .length > 0;
    if (loser && fixture.loser_to_fixture && fixture.loser_to_slot) {
      const filled = loserDeparted
        ? await stampDepartedSeat(tx, fixture.loser_to_fixture, fixture.loser_to_slot)
        : await fillSlot(tx, fixture.loser_to_fixture, fixture.loser_to_slot, loser);
      if (filled !== null) advanced.push(filled);
    }
    // The cascade (owner ruling 2026-09-21, resolveBracketSeats). Gated on this
    // fixture FEEDING something, which is the only way this decision can have
    // changed another seat's situation — and it covers both directions: a win
    // that just seated someone next to a dead feeder, and a VOID (outcome
    // null, no winner) that just BECAME the dead feeder for a seat whose
    // neighbour was already occupied. A league or group fixture feeds nothing,
    // so the hot path pays nothing.
    //
    // The LOSER edge has to open this gate too (review round 5, N1). A
    // double_elim line that only feeds a losers-bracket seat has no
    // `winner_to_fixture`; gating on the winner edge alone meant deciding it
    // never ran the cascade, and the losers bracket stayed dead.
    if (fixture.winner_to_fixture !== null || fixture.loser_to_fixture !== null) {
      for (const id of await resolveBracketSeats(tx, fixture.stage_id)) {
        if (!advanced.includes(id)) advanced.push(id);
      }
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
      // Server-side merge, not a spread of the `stage_config` joined in at the
      // top of this transaction (design §T2): this is the hot recordResult
      // path, and spreading a stale read back reverts any other stage-config
      // key — a per-stage `rules` override among them — with no error.
      await tx`
        update stages set config = config || ${tx.json({ rank_overrides: overrides } as never)}
        where id = ${fixture.stage_id}`;
    }
    // Ladder (Jul3/08 §6): the challenger taking the game takes the position — a walkover too. `advancingSides`
    // sends no loser on for an `award` (a forfeit loser is out of a BRACKET, X-DE-1), but a ladder moves nobody to a
    // seat: it swaps the two positions the award names. W2b X-WD-2: a holder who withdraws from a pending challenge
    // is walked over, and without this she kept the top of the ladder — a withdrawn champion. A bye names no loser.
    const ladderLoser =
      loser ?? ((fixture.outcome as { kind?: string; loser?: string | null } | null)?.kind === "award"
        ? ((fixture.outcome as { loser?: string | null }).loser ?? undefined)
        : undefined);
    if (fixture.kind === "ladder" && winner !== undefined && ladderLoser !== undefined) {
      const cfg = fixture.stage_config as { ladder_order?: string[] };
      const order = [...(cfg.ladder_order ?? [])];
      const wi = order.indexOf(winner);
      const li = order.indexOf(ladderLoser);
      if (wi >= 0 && li >= 0 && wi > li) {
        [order[wi], order[li]] = [order[li]!, order[wi]!];
        // Server-side merge (design §T2) — see the rank_overrides write above.
        await tx`
          update stages set config = config || ${tx.json({ ladder_order: order } as never)}
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
  if (context && (context.outcome as { kind?: string } | null)?.kind !== undefined) {
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
    // W2b D18 (spec §13 premise 9): the FINISHED statuses — a result (decided, forfeited), a locked result
    // (finalized: an organiser who finalizes as they go must still advance) and a cancelled fixture. Everything else
    // (scheduled, in_play, needs_decision, abandoned) is still owed something — except (owner ruling 105, loop-F M-10)
    // an abandoned fixture whose active abandon is a withdrawal's EXPUNGE (D5): the match left the table, nothing is
    // owed on it. A plain recorded abandon still holds (W2a: it is not a dead feeder, and it awaits the organiser).
    const [{ open }] = await tx<{ open: number }[]>`
      select count(*) filter (where status not in ('decided', 'forfeited', 'finalized', 'cancelled')
                                and not ${hasActiveAbandonSql(tx, "fixtures", { expunge: true })})::int as open
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
   *  response. The division's documents are in that DEL (review r2-m4). Handed
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
  // R10 H4: every key goes out BY NAME in ONE direct DEL (`cacheDel`):
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
  //   - the division's public schedule, standings and entrants documents
  //     (`publicDivisionCacheKeys`, division-doc-cache-keys.ts, the same names
  //     `afterScheduleWrite` drops). These were a `pub:v1:div:{id}:*` SCAN over
  //     the whole keyspace on every score write, every page of it a billed
  //     Upstash command (review r2-m4). No reader of these three refetches on
  //     a push today — they are polled — so the gain is the SCAN, not the
  //     ordering: they now ride a DEL the pushes already wait on (and the
  //     1500 ms bound can still fire with that DEL in flight, R10 I1).
  // No SCAN is sent. The hub rebuilds through `loadCompetitionHub` and the
  // fixture through `publicFixture`'s own query.
  const fixtureKey = publicFixtureCacheKey(fixtureId);
  // R10h: the advanced-into fixtures' own documents ride the same DEL, after
  // the keys every score drops. One round trip, and the pushes below then wait
  // on the delete that covers all of them.
  const keys = row
    ? [
        fixtureKey,
        publicHubCacheKey(row.competition_id),
        playerMatchesGenKey(row.competition_id),
        `pub:v1:org-live:${row.org_id}`,
        ...publicDivisionCacheKeys(row.division_id),
      ]
    : [fixtureKey];
  for (const id of alsoFixtureIds) keys.push(publicFixtureCacheKey(id));
  // F4: the call is never left to reject unhandled. The helper fails open
  // inside its try, but `client()` sits outside it (cache.ts). ioredis's
  // constructor throws synchronously on a REDIS_URL it cannot parse, so every
  // call would then reject.
  const deleted = cacheDel(...keys).catch((err: unknown) => {
    log.error({ err, fixture: fixtureId, keys }, "scoring: a public Redis delete failed (the write stands)");
  });
  // F2: the catch above means this cannot reject, so it settles exactly when
  // the DEL has, whichever way that went.
  //
  // R10 I1: the pushes wait for it, but never longer than
  // PUSH_AFTER_DELETE_BOUND_MS, and exactly once.
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
