import "server-only";
// THE scoring path (doc 08 §4). Wraps the engine-db appendEvent adapter with:
// Redis idempotency (24 h — courtside retries on flaky Wi-Fi must be safe),
// per-fixture rate limiting, bracket slot progression, standings recompute,
// realtime publish and public-cache invalidation. undo = core.void through the
// same door.
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { cacheGet, cacheSet, cacheDelPattern } from "@/lib/cache";
import { rateLimit } from "@/lib/rate-limit";
import { hasFeature, requireFeature } from "@/lib/entitlements";
import { deferred } from "@/lib/deferred";
import { EngineError } from "@seazn/engine/core";
import { appendEvent } from "@/server/engine-db";
import { recomputeStandings } from "@/server/engine-db";
import { log } from "@/server/logger";
import { publishDivisionUpdate, publishFixtureUpdate } from "@/lib/realtime";
import {
  fireDivisionRevalidate,
  fireDiscoveryRevalidate,
  invalidateDiscoveryCache,
} from "@/server/public-site/revalidate";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { AppendEventRequest } from "@/server/api-v1/schemas";
import { assertNotFrozen, frozenCompetitionIds } from "./entitlement-freeze";
import { scoresViaAssignment } from "./scorers";
import { fillSlot, markDependentSeedProposalsStale } from "./stages";
import { detectSuspensions } from "./discipline";
import { draftPostsForDecidedFixture } from "./org-posts";

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

  // A decision (or a void that may have erased one) moves brackets/standings.
  if (result.outcome !== null || input.type === "core.void") {
    await onDecided(auth, fixtureId, result.outcome);
    await refreshDiscipline(auth, fixtureId);
    await refreshNews(auth, fixtureId);
  }

  if (cacheKey) await cacheSet(cacheKey, out, IDEM_TTL_SECONDS);
  // After commit (doc 08 §4): realtime + public cache, both fire-and-forget.
  // Discovery surfaces refresh on decided/void/start writes only — and only
  // when the competition is discoverable (doc 15 §2, checked inside).
  const movesDiscovery =
    result.outcome !== null || input.type === "core.void" || input.type === "core.start";
  void publishFixtureUpdate(fixtureId, "event");
  // Division-wide state_changed so multi-fixture listeners (slideshow) get
  // one channel per division instead of one per fixture.
  void sql<{ division_id: string }[]>`select division_id from fixtures where id = ${fixtureId}`
    .then(([row]) => row && publishDivisionUpdate(row.division_id, "score"))
    .catch(() => null);
  void invalidatePublicCache(auth.orgId, fixtureId, movesDiscovery);
  return out;
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

  // Scorer capabilities (doc 13 §2): coverage was proven at the door
  // (requireFixtureActor → requireScorable); here the per-division config
  // gates apply — to scorers and to viewers scoring via assignment alike.
  // Finalize is config-gated; undo is own-fixture PRE-finalize only — a
  // finalized ledger is an editor's to reopen.
  if (scoresViaAssignment(auth.role)) {
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
// serving counter — but only when the division has enabled rules. A one-query
// probe keeps the hot scoring path free for every division without discipline.
//
// Exported (P11): the batch importer fires the exact same decided side
// effects scoreEvent does, in the same order — reusing these three rather
// than copying their bodies is what keeps the two paths from drifting apart.
export async function refreshDiscipline(auth: AuthCtx, fixtureId: string): Promise<void> {
  await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ division_id: string }[]>`
      select division_id from fixtures where id = ${fixtureId}`;
    if (!row) return;
    const [enabled] = await tx`
      select 1 from discipline_rules where division_id = ${row.division_id} and enabled`;
    if (!enabled) return;
    await detectSuspensions(tx, row.division_id);
  });
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
    // V395 made `news.auto` false on Free and left it granted on both Event
    // Pass rungs, so an org-wide resolve falls through to the community row and
    // a pass holder's decided fixture silently drafts nothing on the
    // competition they paid for (`pass-scoping-guard.test.ts`).
    const [scope] = await sql<{ competition_id: string }[]>`
      select d.competition_id from fixtures f join divisions d on d.id = f.division_id
      where f.id = ${fixtureId}`;
    const newsAuto = await hasFeature(auth.orgId, "news.auto", scope?.competition_id);
    await withTenant(auth.orgId, async (tx) => {
      const [row] = await tx<{ auto_posts: boolean }[]>`
        select d.auto_posts from fixtures f join divisions d on d.id = f.division_id
        where f.id = ${fixtureId}`;
      if (!row?.auto_posts) return;
      await draftPostsForDecidedFixture(tx, fixtureId, newsAuto);
    });
  } catch (err) {
    log.error({ err }, "scoring: news auto-draft failed (score write unaffected)");
  }
}

// A decided fixture feeds brackets (winner_to/loser_to slots) and refreshes
// the table-stage standings snapshot.
export async function onDecided(auth: AuthCtx, fixtureId: string, outcome: unknown): Promise<void> {
  // outcome may be null here (a void erased the decision) — recompute only.
  const o = (outcome ?? {}) as { kind?: string; winner?: string; loser?: string };
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
      await fillSlot(tx, fixture.winner_to_fixture, fixture.winner_to_slot, winner);
    }
    if (loser && fixture.loser_to_fixture && fixture.loser_to_slot) {
      await fillSlot(tx, fixture.loser_to_fixture, fixture.loser_to_slot, loser);
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
    await completeStage(auth, stageId);
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
export async function invalidatePublicCache(
  orgId: string,
  fixtureId: string,
  movesDiscovery = false,
): Promise<void> {
  const row = await withTenant(orgId, async (tx) => {
    const [r] = await tx<
      { division_id: string; competition_id: string; discoverable: boolean }[]
    >`
      select f.division_id, d.competition_id, c.discoverable
      from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      where f.id = ${fixtureId}`;
    return r ?? null;
  });
  await cacheDelPattern(`pub:v1:fixture:${fixtureId}`);
  if (row) {
    await cacheDelPattern(`pub:v1:div:${row.division_id}:*`);
    fireDivisionRevalidate(row.division_id, row.competition_id);
    // Cheap by design (doc 15 §2 / PROMPT-19 item 4): the `discovery` tag
    // fires only for discoverable competitions.
    if (movesDiscovery && row.discoverable) {
      deferred(async () => {
        await invalidateDiscoveryCache();
        fireDiscoveryRevalidate();
      });
    }
  }
}
