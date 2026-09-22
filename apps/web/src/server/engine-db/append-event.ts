import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant, type Tx } from "@/lib/db";
import {
  EngineError,
  foldMatch,
  resolveVoids,
  type EventEnvelope,
  type MatchOutcome,
  type ScoreSummary,
  type StageKind,
} from "@seazn/engine/core";
import { resolveModule } from "./registry";
import { loadLineupPair } from "./lineups";
import { hasFrozenCfg, resolveFixtureCfg } from "./fixture-cfg";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { log } from "@/server/logger";

// What a caller supplies; persistence stamps id/seq/recordedAt (spec 03 §2 —
// ids/time are injected). `id`/`recordedAt` are accepted for test determinism.
export interface AppendInput {
  type: string;
  payload: unknown;
  recordedBy?: string | null;
  /** Device-link attribution (doc 13 §7): set when the event arrived via a
   *  dl_ token. Rides OUTSIDE the hash-chain canonical. */
  deviceLinkId?: string | null;
  /** W2 — durable idempotency (design §6). The client's retry key, written so
   *  the unique index on (fixture_id, idempotency_key) can REFUSE a second
   *  write of the same tap. Rides OUTSIDE the hash-chain canonical, exactly
   *  like `deviceLinkId`: V226's trigger names its columns explicitly. Null
   *  for the importer, the rebuild paths, and any caller that never retries. */
  idempotencyKey?: string | null;
  voids?: string;
  id?: string;
  recordedAt?: string;
}

export interface AppendResult {
  seq: number;
  event: EventEnvelope;
  state: unknown;
  summary: ScoreSummary;
  outcome: MatchOutcome | null;
  status: string;
  /** F9 (R3.5 review) — carried through so `appendEvent` can log an accepted
   *  event AFTER `withTenant` has committed, instead of `appendEventInTx`
   *  logging it itself before the fixtures update, the pg_notify, and the
   *  commit (see that function for why: a throw in any of those, or a
   *  caller retrying a serialization/deadlock error, used to leave a log
   *  line describing a write that never reached the ledger, or describing
   *  it twice for the same seq). The P11 batch importer
   *  (`event-import.ts`) gets this field too on its own `AppendResult`s and
   *  does not use it — it has its own, separate per-fixture logging. */
  sportKey: string;
}

interface FixtureRow {
  id: string;
  division_id: string;
  stage_id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: unknown;
  /** V347 — the resolved cfg this fixture was SCORED under; null until its
   *  first event. See `fixture-cfg.ts` for why it exists. */
  config_snapshot: unknown;
}
interface StageRow {
  kind: string;
  config: Record<string, unknown> | null;
}
interface DivisionRow {
  config: unknown;
  sport_key: string;
  module_version: string;
}
interface EventRow {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  recorded_at: Date;
  recorded_by: string | null;
  voids_event_id: string | null;
}

// Terminal DB statuses that lock the ledger against further appends. Exported
// because the V347 config-snapshot escape hatch must refuse on exactly this
// set — rewriting the cfg a FINALIZED result was computed under is the very
// thing the snapshot exists to prevent, so the two guards may not drift apart.
export const LOCKED_FIXTURE_STATUSES: ReadonlySet<string> = new Set(["finalized", "cancelled"]);
const LOCKED = LOCKED_FIXTURE_STATUSES;

// Map the folded ledger onto the fixtures.status enum. Derived from the
// ACTIVE (void-resolved) events, not from event-type transitions: a void can
// erase core.start / core.forfeit / core.abandon / the deciding event, and the
// status must follow the fold or the console dead-ends (v3/09 §2 — the cricket
// "undo made scoring disappear" regression was status=in_play with the fold
// back in the pre phase, so neither the Start button nor the pad rendered).
/** Exported for W2's replay reconstruction (`replay.ts`). A replay must report
 *  the status the ORIGINAL write reported, and deriving that from a second,
 *  hand-written rule is exactly how a read path and a write path drift apart —
 *  the disagreement `fixture-cfg.ts` exists to prevent. One rule, two callers.
 *  Note `fixtureStatusFromFold` alone can never answer "finalized": only this
 *  can, and only because it is told the candidate's TYPE. */
export function nextStatus(
  candidateType: string,
  outcome: MatchOutcome | null,
  active: readonly EventEnvelope[],
): string {
  if (candidateType === "core.finalize") return "finalized";
  return fixtureStatusFromFold(outcome, active);
}

/**
 * The same rule for a fold with no candidate event — a fixture whose cached
 * status has to be re-derived from a stream that did not change (the V347
 * re-snapshot hatch). Exported so the two can never drift: a hatch that wrote
 * its own status rule would reintroduce exactly the read/write disagreement
 * `fixture-cfg.ts` exists to prevent.
 *
 * `finalized` is deliberately NOT reachable here even when the ledger holds an
 * active `core.finalize`: every caller of this overload has already refused a
 * fixture in `LOCKED_FIXTURE_STATUSES`, so the only way to arrive with a
 * finalize in the stream is that staff reopened the fixture on purpose, and
 * re-deriving it back to `finalized` would silently undo that.
 */
export function fixtureStatusFromFold(
  outcome: MatchOutcome | null,
  active: readonly EventEnvelope[],
): string {
  const has = (type: string) => active.some((event) => event.type === type);
  // Abandon first: cricket abandon folds to a no_result OUTCOME, but the
  // fixture status stays "abandoned" (replay policy owns it from here).
  if (has("core.abandon")) return "abandoned";
  if (outcome !== null) return has("core.forfeit") ? "forfeited" : "decided";
  return has("core.start") ? "in_play" : "scheduled";
}

export type FirstResult = { distinctId: string; sportKey: string; status: string };

/** The transactional body of an append (spec 03 §5), callable inside a caller's
 *  transaction. `appendEvent` wraps it in `withTenant`; the P11 importer calls
 *  it in a loop so a whole fixture's stream commits or rolls back together.
 *  There is exactly one append path — do not add a second. */
export async function appendEventInTx(
  tx: Tx,
  orgId: string,
  fixtureId: string,
  expectedSeq: number,
  input: AppendInput,
): Promise<{ appended: AppendResult; firstResult: FirstResult | null }> {
  // Serialise all appends to this fixture (spec 02 §8 — fixture is the write
  // aggregate). The lock is held to commit, so a concurrent appender blocks,
  // then re-reads the committed max seq and 409s.
  await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + fixtureId}))`;

  const [fixture] = await tx<FixtureRow[]>`
    select id, division_id, stage_id, home_entrant_id, away_entrant_id, status, outcome,
           config_snapshot
    from fixtures where id = ${fixtureId}
  `;
  if (!fixture) {
    throw new EngineError("INVALID_EVENT", `fixture ${fixtureId} not found`, { fixtureId });
  }
  if (LOCKED.has(fixture.status)) {
    throw new EngineError("ALREADY_DECIDED", `fixture ${fixtureId} is ${fixture.status}`, {
      fixtureId,
      status: fixture.status,
    });
  }
  if (!fixture.home_entrant_id || !fixture.away_entrant_id) {
    throw new EngineError("WRONG_PHASE", "fixture has an unassigned entrant (bye/TBD)", {
      fixtureId,
    });
  }

  const [division] = await tx<DivisionRow[]>`
    select config, sport_key, module_version from divisions where id = ${fixture.division_id}
  `;
  if (!division) {
    throw new EngineError("CONFIG_INVALID", "division not found for fixture", { fixtureId });
  }
  const sportModule = resolveModule(division.sport_key, division.module_version);
  // The fixture's stage kind gates draw finalization (PROMPT-61); its config
  // may carry stage-scoped decider overrides.
  const [stage] = await tx<StageRow[]>`
    select kind, config from stages where id = ${fixture.stage_id}
  `;

  // Optimistic concurrency: the client's expectedSeq must equal the current
  // ledger tip. Gapless seq is assigned here, under the lock (doc 07 note 3).
  const [{ seq: lastSeq }] = await tx<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int as seq from score_events where fixture_id = ${fixtureId}
  `;
  if (lastSeq !== expectedSeq) {
    throw new EngineError(
      "SEQ_CONFLICT",
      `expected seq ${expectedSeq} but ledger is at ${lastSeq}`,
      { fixtureId, expectedSeq, actualSeq: lastSeq },
    );
  }

  const priorRows = await tx<EventRow[]>`
    select id, seq, type, payload, recorded_at, recorded_by, voids_event_id
    from score_events where fixture_id = ${fixtureId} order by seq
  `;
  const prior: EventEnvelope[] = priorRows.map((r) => ({
    id: r.id,
    fixtureId,
    seq: r.seq,
    type: r.type,
    payload: r.payload,
    recordedAt: r.recorded_at.toISOString(),
    recordedBy: r.recorded_by,
    ...(r.voids_event_id ? { voids: r.voids_event_id } : {}),
  }));

  const candidate: EventEnvelope = {
    id: input.id ?? randomUUID(),
    fixtureId,
    seq: expectedSeq + 1,
    type: input.type,
    payload: input.payload,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    recordedBy: input.recordedBy ?? null,
    ...(input.voids ? { voids: input.voids } : {}),
  };

  const lineups = await loadLineupPair(
    tx,
    fixtureId,
    fixture.home_entrant_id,
    fixture.away_entrant_id,
  );

  // Fold-validate the full stream INCLUDING the candidate. A throwing module
  // (invalid event, already-decided, …) aborts the tx before any insert, so
  // the ledger only ever holds valid events (spec 03 §2 guarantee 2).
  const stream = [...prior, candidate];
  // V347 — the cfg this fixture is SCORED under, frozen the moment it has
  // history worth protecting. Before this, `cfg` was rebuilt LIVE from
  // `division.config` on every call while every READ replayed the whole
  // stream from `init`, so editing a division's config changed the input to
  // every past fold at once: finished fixtures silently rescored, and any
  // cfg-derived refusal started firing on events already in the ledger, with
  // no event to void and no scorer action that recovers it.
  //
  // A fixture with ZERO events deliberately reads LIVE cfg — `lastSeq === 0`
  // below is exactly "nothing recorded yet", and an organiser still setting
  // the division up must have the format they choose apply. See
  // `fixture-cfg.ts` for the full rationale; it is the single reader of the
  // column, shared with `fold.ts` so the two folds cannot drift apart.
  const cfg = resolveFixtureCfg(fixture.config_snapshot, division.config, stage?.config);
  // Take it on the FIRST event only. The advisory lock above is held to
  // commit, so no concurrent appender can interleave between this decision
  // and the write below — the snapshot is taken exactly once.
  //
  // `cfg != null` is not paranoia: `tx.json(null)` writes a SQL NULL, so a
  // division whose config is a JSON null would stamp `config_snapshot_at`
  // while `config_snapshot` still read as "never frozen" — a row claiming a
  // freeze that did not happen, and a fixture that quietly keeps following
  // live config. Better to leave both columns honestly null.
  const freezeSnapshot = !hasFrozenCfg(fixture.config_snapshot) && lastSeq === 0 && cfg != null;
  // W4a (#425) §3.3 — the strict-on-write seam. A refusal computed from cfg
  // cannot tell "the scorer just typed a period this sport does not have"
  // from "an organiser lowered bestOf after the match was scored". The first
  // is fixable; the second has no event to void. `strictFromSeq` names the
  // ONE event that is not yet in the ledger, so the candidate is validated in
  // full and `prior` — which the ledger already accepted, under the cfg now
  // frozen above — is replayed. `fold.ts` and every other read path pass no
  // options at all.
  // R3.5 Task K — this funnel was entirely silent: every super-over ball,
  // every shoot-out kick and every refusal on both was invisible in
  // production. Wrap ONLY the fold: everything from here to the insert below
  // runs inside `tx`, where a throw aborts the transaction before any write
  // (PROMPT-61, above) — that must keep happening exactly as it does today,
  // so the catch below re-throws unchanged and never touches SQL itself.
  const state = (() => {
    try {
      return foldMatch(sportModule, cfg, lineups, stream, {
        strictFromSeq: candidate.seq,
      });
    } catch (error) {
      // IDs, types and codes only. The payload carries striker/nonStriker/
      // bowler/person ids and, for some events, free text; persons in this
      // product carry consent flags, so a payload is never a log-safe value
      // (case K5).
      if (EngineError.is(error)) {
        log.warn(
          { fixtureId, eventType: input.type, code: error.code },
          "scoring event refused",
        );
      } else {
        // F10 (R3.5 review) — this catch only instrumented the EngineError
        // (422) case above. A TypeError/RangeError thrown from inside a
        // sport module, or a Zod issue surfacing as a plain Error, used to
        // re-throw with NOTHING written to the log: production saw a bare
        // 500 with no fixtureId, no event type, no seq to chase — strictly
        // worse than the refusal case, which at least names the fixture and
        // the code. Same ID-only-fields posture as the branch above (no
        // `code` — a non-engine error has none); the error itself is
        // untouched, re-thrown exactly as before, just below.
        log.error(
          { fixtureId, eventType: input.type, seq: candidate.seq },
          "scoring event fold crashed",
        );
      }
      throw error;
    }
  })();
  const summary = sportModule.summary(state);
  const outcome = sportModule.outcome(state);
  const active = resolveVoids(stream);

  // PROMPT-61: a stage that cannot end level refuses to finalize a draw —
  // the throw aborts the tx before insert, so the bracket never silently
  // stalls on an outcome with no winner to advance.
  if (
    outcome !== null &&
    (outcome as { kind?: string }).kind === "draw" &&
    stage !== undefined &&
    !sportModule.supportsDraws(cfg as never, stage.kind as StageKind)
  ) {
    throw new EngineError(
      "DRAW_NOT_ALLOWED",
      "this stage cannot end level — decide it by extra time or a shootout",
      { fixtureId, stage: stage.kind },
    );
  }

  // Same transaction as the event that made it necessary: a crash between the
  // two can never leave a fixture with history and no frozen cfg.
  if (freezeSnapshot) {
    await tx`
      update fixtures
      set config_snapshot = ${tx.json(cfg as never)}, config_snapshot_at = now()
      where id = ${fixtureId}
    `;
  }

  await tx`
    insert into score_events (id, fixture_id, seq, type, payload, recorded_by, recorded_at, voids_event_id, device_link_id, idempotency_key)
    values (${candidate.id}, ${fixtureId}, ${candidate.seq}, ${candidate.type},
            ${tx.json(candidate.payload as never)}, ${candidate.recordedBy},
            ${candidate.recordedAt}, ${candidate.voids ?? null}, ${input.deviceLinkId ?? null},
            ${input.idempotencyKey ?? null})
  `;

  await tx`
    insert into match_states (fixture_id, last_seq, state, summary)
    values (${fixtureId}, ${candidate.seq}, ${tx.json(state as never)}, ${tx.json(summary as never)})
    on conflict (fixture_id) do update set
      last_seq = excluded.last_seq, state = excluded.state,
      summary = excluded.summary, updated_at = now()
  `;

  const status = nextStatus(candidate.type, outcome, active);
  // Fire once, on the transition from no-result to a decided result. F9
  // (R3.5 review) — this used to be the trigger for a "fixture decided"
  // `log.info` call right here, before the fixtures update, the pg_notify,
  // and the commit below. Logging now happens in `appendEvent`, AFTER
  // `withTenant` resolves — see there for why. `firstResult` itself stays
  // here: `appendEvent`'s PostHog capture and `event-import.ts`'s own
  // per-fixture handling both still need it from this same computation, so
  // the two can never disagree about when a fixture was decided.
  const firstResult: FirstResult | null =
    fixture.outcome === null && outcome !== null
      ? { distinctId: candidate.recordedBy ?? `org:${orgId}`, sportKey: division.sport_key, status }
      : null;
  // Also rewrite when a void erased a previously-stored outcome — otherwise
  // fixtures.outcome would go stale against the fold (doc 08 §4 undo).
  if (status !== fixture.status || outcome !== null || fixture.outcome !== null) {
    await tx`
      update fixtures set
        status = ${status},
        outcome = ${outcome === null ? null : tx.json(outcome as never)}
      where id = ${fixtureId}
    `;
  }

  // Delivered to LISTEN'ers on commit (Postgres queues NOTIFY until commit) —
  // the "publish after commit" of spec 03 §5, dependency-free.
  await tx`select pg_notify('fixture_events', ${JSON.stringify({
    fixtureId,
    seq: candidate.seq,
    status,
  })})`;

  return {
    appended: {
      seq: candidate.seq,
      event: candidate,
      state,
      summary,
      outcome,
      status,
      sportKey: division.sport_key,
    },
    firstResult,
  };
}

/**
 * Append one event to a fixture's ledger (spec 03 §5). Within a tenant tx:
 * advisory-lock the fixture → optimistic seq check (409 on mismatch) → load
 * state + tail events → fold-validate through the pinned module (invalid event
 * never enters the ledger) → insert event (org_id + hash chain filled by
 * triggers) → upsert match_state → write fixtures.outcome+status on decision →
 * NOTIFY after commit.
 *
 * @throws EngineError('SEQ_CONFLICT') on a stale expectedSeq (→ HTTP 409).
 * @throws EngineError(...) from the module on an invalid event (→ 422).
 */
export async function appendEvent(
  orgId: string,
  fixtureId: string,
  expectedSeq: number,
  input: AppendInput,
): Promise<AppendResult> {
  // Activation funnel (feature 1): the first time a fixture yields a result is
  // the "aha" moment. The tx returns whether this append crossed that line;
  // capture happens OUTSIDE the tx (below) so a PostHog flush never touches the
  // write path.
  const { appended, firstResult } = await withTenant(orgId, (tx) =>
    appendEventInTx(tx, orgId, fixtureId, expectedSeq, input),
  );

  // F9 (R3.5 review) — this used to log from INSIDE appendEventInTx, before
  // the fixtures update, the pg_notify, and the commit: a throw in any of
  // those, or a caller retrying a serialization/deadlock error, meant the
  // line described an append that never reached the ledger, or described it
  // twice for the same seq — exactly wrong for the question this logging
  // exists to answer ("was this super over actually recorded?"). `withTenant`
  // (postgres.js `sql.begin`) only resolves once COMMIT has gone through, so
  // everything below can only ever describe a write that is actually in the
  // ledger. IDs, types and counts only (case K5: never a payload value).
  // `phase` is the fold's OWN phase, which is what makes a decider visible:
  // the first accepted line whose phase is "super_over"/"SHOOTOUT" IS the
  // decider entry, deliberately with no separate line.
  log.info(
    {
      fixtureId,
      sportKey: appended.sportKey,
      eventType: appended.event.type,
      seq: appended.seq,
      phase: (appended.state as { phase?: unknown }).phase ?? null,
      status: appended.status,
    },
    "scoring event appended",
  );
  if (firstResult !== null) {
    // `method` is what a support question about a knockout result actually
    // needs: shootout / super_over / boundary_count / extra_time — the
    // difference between "they won" and "they won on penalties". Reuses the
    // SAME `firstResult` the fold computed rather than re-testing outcomes a
    // second time out here, so the two can never disagree about when a
    // fixture was decided.
    log.info(
      {
        fixtureId,
        sportKey: firstResult.sportKey,
        kind: (appended.outcome as { kind?: unknown }).kind ?? null,
        method: (appended.outcome as { method?: unknown }).method ?? null,
      },
      "fixture decided",
    );
  }

  if (firstResult) {
    await captureServer({
      event: EVENTS.RESULT_ENTERED,
      distinctId: firstResult.distinctId,
      orgId,
      properties: { sport_key: firstResult.sportKey, status: firstResult.status, fixture_id: fixtureId },
    });
  }
  return appended;
}
