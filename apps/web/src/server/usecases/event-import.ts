import "server-only";
// P11 (D6) batch score-event import (design doc
// docs/superpowers/specs/2026-08-25-p11-batch-event-import-design.md). One
// call imports N fixtures' finished streams: resolve → guard → entitle →
// dry-run fold (no writes) → one transaction per fixture, gated behind the
// event_imports receipt table's UNIQUE index (V376), which IS the
// idempotency guarantee — this file only makes the common case cheap and the
// message honest (see the receipt pre-check in runStream below).
//
// There is exactly one append path in this codebase: `appendEventInTx`
// (engine-db/append-event.ts). This file calls it in a loop, once per event,
// inside its own withTenant per fixture — it does not re-implement any part
// of what that function does.
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import { EngineError, foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { resolveModule, resolveFixtureCfg } from "@/server/engine-db";
import { loadLineupPair } from "@/server/engine-db/lineups";
import { appendEventInTx, type AppendResult, type FirstResult } from "@/server/engine-db/append-event";
import { requiredFeatureForEvent } from "./fidelity";
import { onDecided, refreshDiscipline, refreshNews } from "./scoring";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { log } from "@/server/logger";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { EventImportRequest } from "@/server/api-v1/schemas";

// R4 — see the design doc §6 "Why the caps are what they are": appendEventInTx
// re-reads and re-folds the whole prior stream on every append (O(n^2) per
// fixture), so a single huge stream is a hung request, not a rejection.
export const IMPORT_CAPS = { streams: 50, eventsPerFixture: 1_000, eventsPerCall: 10_000 } as const;

export type ImportStreamResult = {
  fixture: string; // resolved id, or the ext_key as given
  status: "imported" | "skipped_duplicate" | "rejected";
  eventsAppended: number;
  outcome?: unknown;
  error?: { code: string; eventIndex?: number; engineCode?: string; feature?: string; matches?: number };
};

export type ImportReport = {
  importId: string;
  totals: { imported: number; skipped: number; rejected: number };
  results: ImportStreamResult[];
};

interface DivisionCtx {
  id: string;
  status: string;
  sportKey: string;
  moduleVersion: string;
  config: unknown;
}

interface FixtureRow {
  id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  config_snapshot: unknown;
  stage_id: string;
}

type StreamInput = EventImportRequest["streams"][number];

/** postgres.js names the tripped index on `constraint_name`; other drivers use
 *  `constraint`. Matched on the NAME, never on a bare 23505 (person-claims.ts
 *  carries the same eight-line helper, private to that file for a different
 *  constraint — not worth sharing across files for this). */
function isUniqueViolation(e: unknown, constraint: string): boolean {
  if (typeof e !== "object" || e === null) return false;
  if ((e as { code?: string }).code !== "23505") return false;
  const named =
    (e as { constraint_name?: string }).constraint_name ?? (e as { constraint?: string }).constraint ?? "";
  return String(named) === constraint;
}

/** R4's three ceilings, checked in order streams → per-fixture → per-call —
 *  each 413 names the first one the call actually trips. */
function assertWithinCaps(input: EventImportRequest): void {
  if (input.streams.length > IMPORT_CAPS.streams) {
    throw new HttpError(
      413,
      `too many streams in one call: ${input.streams.length} > ${IMPORT_CAPS.streams}`,
      "import.too_large",
      { cap: "streams", limit: IMPORT_CAPS.streams, actual: input.streams.length },
    );
  }
  for (const stream of input.streams) {
    if (stream.events.length > IMPORT_CAPS.eventsPerFixture) {
      throw new HttpError(
        413,
        `too many events for one fixture: ${stream.events.length} > ${IMPORT_CAPS.eventsPerFixture}`,
        "import.too_large",
        { cap: "eventsPerFixture", limit: IMPORT_CAPS.eventsPerFixture, actual: stream.events.length },
      );
    }
  }
  const totalEvents = input.streams.reduce((n, s) => n + s.events.length, 0);
  if (totalEvents > IMPORT_CAPS.eventsPerCall) {
    throw new HttpError(
      413,
      `too many events in one call: ${totalEvents} > ${IMPORT_CAPS.eventsPerCall}`,
      "import.too_large",
      { cap: "eventsPerCall", limit: IMPORT_CAPS.eventsPerCall, actual: totalEvents },
    );
  }
}

/** Pooled read (no withTenant): the division's existence, scoped to the
 *  caller's org, plus everything a stream's fold needs to resolve its module
 *  and cfg — one round trip instead of a second lookup later. */
async function loadDivision(auth: AuthCtx, divisionId: string): Promise<DivisionCtx> {
  const [row] = await sql<
    { id: string; status: string; sport_key: string; module_version: string; config: unknown }[]
  >`
    select id, status, sport_key, module_version, config
    from divisions where id = ${divisionId} and org_id = ${auth.orgId}`;
  if (!row) throw new HttpError(404, "division not found", "import.division_not_found");
  return {
    id: row.id,
    status: row.status,
    sportKey: row.sport_key,
    moduleVersion: row.module_version,
    config: row.config,
  };
}

function buildReport(importId: string, results: ImportStreamResult[]): ImportReport {
  const totals = { imported: 0, skipped: 0, rejected: 0 };
  for (const r of results) {
    if (r.status === "imported") totals.imported++;
    else if (r.status === "skipped_duplicate") totals.skipped++;
    else totals.rejected++;
  }
  return { importId, totals, results };
}

/** Resolve `{id}` | `{ext_key}` to exactly one fixture in this division, on
 *  the pooled proxy. `ext_key` is unique per STAGE, not per division
 *  (fixtures_stage_ext_key_idx) — so it can legitimately match more than one
 *  fixture here, which the caller turns into `import.fixture_unknown`. */
async function resolveFixture(
  divisionId: string,
  ref: StreamInput["fixture"],
): Promise<{ row: FixtureRow | undefined; matches: number }> {
  const rows =
    "id" in ref
      ? await sql<FixtureRow[]>`
          select id, home_entrant_id, away_entrant_id, status, config_snapshot, stage_id
          from fixtures where id = ${ref.id} and division_id = ${divisionId}`
      : await sql<FixtureRow[]>`
          select id, home_entrant_id, away_entrant_id, status, config_snapshot, stage_id
          from fixtures where division_id = ${divisionId} and ext_key = ${ref.ext_key}`;
  return { row: rows[0], matches: rows.length };
}

const fixtureRefLabel = (ref: StreamInput["fixture"]): string => ("id" in ref ? ref.id : ref.ext_key);

/**
 * One stream, start to finish (design doc §4's per-stream order):
 * resolve → replay guard (receipt) → unstarted guard → slots → entitlement →
 * dry-run fold → write. Every pooled read/entitlement check below runs
 * BEFORE any transaction opens — `withTenant` must not nest, and nothing
 * inside it may touch the pooled `sql` proxy (lib/db.ts:179-181).
 */
async function runStream(
  auth: AuthCtx,
  division: DivisionCtx,
  importId: string,
  stream: StreamInput,
): Promise<ImportStreamResult> {
  // 1. Resolve the fixture.
  const { row: fixture, matches } = await resolveFixture(division.id, stream.fixture);
  if (!fixture || matches !== 1) {
    return {
      fixture: fixtureRefLabel(stream.fixture),
      status: "rejected",
      eventsAppended: 0,
      error: { code: "import.fixture_unknown", matches },
    };
  }
  const fixtureId = fixture.id;

  // 2. Replay guard, on the pooled proxy: a replay of an already-imported
  // (division, import_id, fixture) must not even open a transaction. This
  // read makes the common case cheap and the message honest — the UNIQUE
  // index inserted in the write transaction below (event_imports_key_idx,
  // V376) is the actual idempotency guarantee, for the genuinely concurrent
  // case this pre-check can race. Deliberately BEFORE the unstarted guard:
  // by the time a replay reaches here the fixture already has the first
  // call's events, so if this ran after that guard every replay would read
  // as import.fixture_started instead of skipped_duplicate.
  const [existing] = await sql<{ events_appended: number }[]>`
    select events_appended from event_imports
    where division_id = ${division.id} and import_id = ${importId} and fixture_id = ${fixtureId}`;
  if (existing) {
    return { fixture: fixtureId, status: "skipped_duplicate", eventsAppended: 0 };
  }

  // 3. Guard unstarted: any existing score_events row, or a live/decided
  // status, refuses the whole stream.
  const [{ n: eventCount }] = await sql<{ n: number }[]>`
    select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
  if (eventCount > 0 || fixture.status !== "scheduled") {
    return {
      fixture: fixtureId,
      status: "rejected",
      eventsAppended: 0,
      error: { code: "import.fixture_started" },
    };
  }

  // 4. Unassigned entrant (bye/TBD) — nothing to fold against.
  if (!fixture.home_entrant_id || !fixture.away_entrant_id) {
    return {
      fixture: fixtureId,
      status: "rejected",
      eventsAppended: 0,
      error: { code: "import.slots_unfilled" },
    };
  }

  // 5. Entitlement per distinct event type, still on the pooled proxy.
  const sportModule = resolveModule(division.sportKey, division.moduleVersion);
  const requiredFeatures = new Set<string>();
  for (const ev of stream.events) {
    const feature = requiredFeatureForEvent(sportModule, ev.type);
    if (feature) requiredFeatures.add(feature);
  }
  for (const feature of requiredFeatures) {
    try {
      await requireFeature(auth.orgId, feature);
    } catch (err) {
      if (err instanceof PaymentRequiredError) {
        return {
          fixture: fixtureId,
          status: "rejected",
          eventsAppended: 0,
          error: { code: "import.entitlement", feature },
        };
      }
      throw err;
    }
  }

  // 6. Dry-run fold: its own read-only transaction (loadLineupPair needs a
  // Tx). No writes happen here — a throw just rolls back reads.
  const [stage] = await sql<{ kind: string; config: Record<string, unknown> | null }[]>`
    select kind, config from stages where id = ${fixture.stage_id}`;
  const cfg = resolveFixtureCfg(fixture.config_snapshot, division.config, stage?.config);
  // Same field names appendEventInTx assigns, so the fold sees exactly what
  // the writer will later hand it (seq 1..n, gapless). `id` is deliberately
  // just the array index as a string: on an EngineError the engine echoes the
  // offending event's id back as `data.eventId`, and using the index AS the
  // id turns that straight back into `eventIndex` with no lookup table.
  const envelopes: EventEnvelope[] = stream.events.map((ev, i) => ({
    id: String(i),
    fixtureId,
    seq: i + 1,
    type: ev.type,
    payload: ev.payload,
    recordedAt: ev.at ?? new Date().toISOString(),
    recordedBy: auth.userId,
  }));

  let state: unknown;
  try {
    state = await withTenant(auth.orgId, async (tx) => {
      const lineups = await loadLineupPair(
        tx,
        fixtureId,
        fixture.home_entrant_id!,
        fixture.away_entrant_id!,
      );
      return foldMatch(sportModule, cfg, lineups, envelopes, { strictFromSeq: 1 });
    });
  } catch (err) {
    if (err instanceof EngineError) {
      const eventIndex = Number((err.data as { eventId?: string } | undefined)?.eventId);
      return {
        fixture: fixtureId,
        status: "rejected",
        eventsAppended: 0,
        error: {
          code: "import.fold_rejected",
          ...(Number.isFinite(eventIndex) ? { eventIndex } : {}),
          engineCode: err.code,
        },
      };
    }
    throw err;
  }
  if (sportModule.outcome(state) === null) {
    return {
      fixture: fixtureId,
      status: "rejected",
      eventsAppended: 0,
      error: { code: "import.not_decided" },
    };
  }

  // 7. One transaction per fixture. `appendEventInTx` in a loop for seq
  // 0..n-1 — it assigns `expectedSeq + 1` as the stored seq, so this is what
  // yields the gapless 1..n the dry run already validated. The receipt row is
  // inserted in the SAME transaction: a crash between the two can never leave
  // an imported fixture with no receipt, or a receipt with no events. This is
  // the ONLY call site in this file that writes a score_events row — every
  // event goes through the one append path the whole codebase shares.
  let firstResult: FirstResult | null;
  let last: AppendResult;
  try {
    // Return the loop's results THROUGH the transaction's promise rather than
    // mutating an outer `let` from inside the closure — TS's control-flow
    // narrowing does not follow a mutation made inside a nested function back
    // out to the call site, so `firstResult`/`last` read from the awaited
    // result below narrow normally; read from a closure-mutated outer
    // variable, `if (firstResult)` narrowed to `never`.
    const commit = await withTenant(auth.orgId, async (tx) => {
      let first: FirstResult | null = null;
      let lastAppended: AppendResult | undefined;
      for (const [i, ev] of stream.events.entries()) {
        const r = await appendEventInTx(tx, auth.orgId, fixtureId, i, {
          type: ev.type,
          payload: ev.payload,
          recordedBy: auth.userId,
          ...(ev.at ? { recordedAt: ev.at } : {}),
        });
        first ??= r.firstResult;
        lastAppended = r.appended;
      }
      await tx`
        insert into event_imports (org_id, division_id, import_id, fixture_id, events_appended, imported_by)
        values (${auth.orgId}, ${division.id}, ${importId}, ${fixtureId},
                ${stream.events.length}, ${auth.userId})`;
      // stream.events has at least one entry (schema `.min(1)`), so the loop
      // above always ran at least once and lastAppended is always set.
      return { first, last: lastAppended! };
    });
    firstResult = commit.first;
    last = commit.last;
  } catch (err) {
    if (isUniqueViolation(err, "event_imports_key_idx")) {
      // Review finding #4: unreachable through any call this codebase can
      // make, now that `importEvents` (above) holds a session lock over the
      // whole call, per (division, import_id) — the ONLY writer of this
      // table is `runStream`, so two writes to the same key can no longer
      // even be IN FLIGHT together, let alone race each other's insert. The
      // pooled pre-check (step 2) was the sole guard before the lock existed
      // and left exactly this gap open; the lock closes it structurally, not
      // by making the race rarer. Kept as defence-in-depth rather than
      // deleted: the UNIQUE index is the actual idempotency guarantee (design
      // doc §5) and this branch is the difference between an unhandled 500
      // and a calm `skipped_duplicate` for the one case that could still
      // reach it — a future caller of `runStream` that forgets the lock, or
      // an operator inserting a row by hand. See the Task 5 report for why no
      // test forces this branch: reaching it needs a writer other than
      // `importEvents` itself, which does not exist in this codebase, so a
      // test that reached it would have to fabricate one.
      return { fixture: fixtureId, status: "skipped_duplicate", eventsAppended: 0 };
    }
    if (err instanceof EngineError) {
      // The dry run already validated this exact stream, so reaching here
      // means something changed under us between the dry run and the write
      // (e.g. a concurrent SEQ_CONFLICT) — a genuine race, not the common
      // case the dry run exists to catch. Any throw here rolls the whole
      // fixture back to zero rows (spec 03 §2 guarantee 2).
      return {
        fixture: fixtureId,
        status: "rejected",
        eventsAppended: 0,
        error: { code: "import.fold_rejected", engineCode: err.code },
      };
    }
    throw err;
  }

  // 8. After commit — never inside it — the same decided side effects
  // scoreEvent fires, in the same order (scoring.ts:129-133). Unconditional
  // here: the dry run already proved this stream decides, and import never
  // carries a core.void, so there is no "outcome erased by an undo" case to
  // special-case the way scoreEvent's own condition does.
  await onDecided(auth, fixtureId, last.outcome);
  await refreshDiscipline(auth, fixtureId);
  await refreshNews(auth, fixtureId);
  if (firstResult) {
    await captureServer({
      event: EVENTS.RESULT_ENTERED,
      distinctId: firstResult.distinctId,
      orgId: auth.orgId,
      properties: { sport_key: firstResult.sportKey, status: firstResult.status, fixture_id: fixtureId },
    });
  }

  return {
    fixture: fixtureId,
    status: "imported",
    eventsAppended: stream.events.length,
    outcome: last.outcome,
  };
}

// TTL: 30 minutes (design doc §5.1). A crashed process leaves its row
// behind; this is what lets the NEXT caller proceed instead of a division
// being wedged forever — long enough that a legitimate import (up to 1,000
// events per fixture, refolded O(n²) on every append) refreshes well before
// it would matter (see runImport's between-streams refresh).

/**
 * Acquire the row lock for `(divisionId, importId)`, or take over one whose
 * TTL has already elapsed, in the single statement design doc §5.1
 * specifies. `ON CONFLICT ... DO UPDATE ... WHERE` is what makes this ONE
 * round trip atomic: a conflicting row that does NOT satisfy the WHERE
 * (i.e. a live holder) is left alone and produces no returned row — it is
 * not an error, just nothing to return — so two concurrent callers racing
 * for the same key can never both come back with a row. Returns the fresh
 * `holder` (a random uuid minted per call, never reused) on success; `null`
 * when someone else holds a live lock.
 *
 * Runs on the POOLED `sql` proxy, never inside `withTenant` — this is
 * exactly why the lock moved into a row in the first place: no reserved
 * connection, no session, so no dependency on how the app is connected to
 * Postgres. RLS on `import_locks` does not scope this query (the pooled
 * connection is not `app_user` with `current_org_id()` set — same reason
 * every other pooled read in this file filters by org itself), so `org_id`
 * is an explicit predicate, not RLS's job.
 */
async function acquireImportLock(divisionId: string, importId: string, orgId: string): Promise<string | null> {
  const holder = randomUUID();
  const [row] = await sql<{ holder: string }[]>`
    insert into import_locks (division_id, import_id, org_id, holder, expires_at)
    values (${divisionId}, ${importId}, ${orgId}, ${holder}, now() + interval '30 minutes')
    on conflict (division_id, import_id) do update
      set holder = excluded.holder, acquired_at = now(), expires_at = excluded.expires_at
      where import_locks.expires_at < now()
    returning holder`;
  return row ? row.holder : null;
}

/**
 * Push the lock's `expires_at` out again — called BETWEEN streams (never
 * inside a stream's own write transaction: a refresh inside a transaction
 * is invisible to every other caller until that transaction commits, which
 * defeats the entire purpose of refreshing at all). Best-effort: if the
 * lock was somehow already lost (a prior refresh missed the window and a
 * successor took over), this predicate simply matches zero rows and the
 * next `runStream` call proceeds regardless — the actual correctness
 * backstop is `event_imports`'s unique index, not this row.
 */
async function refreshImportLock(
  divisionId: string,
  importId: string,
  orgId: string,
  holder: string,
): Promise<void> {
  await sql`
    update import_locks set expires_at = now() + interval '30 minutes'
    where division_id = ${divisionId} and import_id = ${importId}
      and org_id = ${orgId} and holder = ${holder}`;
}

/**
 * Release the lock — but ONLY the caller's own row. The `holder` predicate
 * is load-bearing, not decoration (review, fix round 2, requirement #3): it
 * is what stops an already-timed-out call's late release from deleting a
 * SUCCESSOR's lock on the same `(divisionId, importId)` key — without it, a
 * slow caller finishing after its TTL expired and a new caller already took
 * over would delete the new caller's row out from under it.
 *
 * Exported so a test can prove that predicate directly: seed a row with a
 * foreign `holder`, call this with a different one, assert the row survives
 * unchanged. A genuine end-to-end race (this call's own successful acquire,
 * followed by a real takeover arriving mid-flight, followed by this call's
 * own late release) is real but not deterministically constructible without
 * either fabricating one with mocks or accepting flaky timing — the WHERE
 * clause's correctness does not need a live race to prove; it needs exactly
 * this.
 */
export async function releaseImportLock(
  divisionId: string,
  importId: string,
  orgId: string,
  holder: string,
): Promise<void> {
  await sql`
    delete from import_locks
    where division_id = ${divisionId} and import_id = ${importId}
      and org_id = ${orgId} and holder = ${holder}`;
}

/**
 * Acquire `acquire`, run `fn` with whatever it returned, then ALWAYS attempt
 * `release` — but never let a `release` failure replace `fn`'s real outcome
 * (review, fix round 1, finding #1, carried over unchanged into the row
 * lock). A successful import, or a legitimate rejection `fn` threw on
 * purpose (402/409/413/a per-stream result), must be reported as exactly
 * that even if letting go of the lock afterwards failed; a release failure
 * is a leaked lock row (harmless — it expires on its own via the TTL above),
 * not a failed import, and is logged rather than raised.
 *
 * `acquire` returning `null` means someone else holds a live lock;
 * `onNotAcquired` decides what that means to the caller (here: 409
 * `import.concurrent`) and is typed `() => never` — the ONLY way execution
 * reaches the `try`/`finally` below is with a real, non-null `lock`, so
 * there is no separate "was it acquired" guard to write inside `finally`
 * (an earlier draft of this file, over the now-deleted advisory-lock
 * mechanism, added one anyway; a mutation check proved it dead code, and
 * removing it — not keeping a redundant check — was the fix).
 */
export async function withLock<L, T>(
  acquire: () => Promise<L | null>,
  release: (lock: L) => Promise<void>,
  onNotAcquired: () => never,
  fn: (lock: L) => Promise<T>,
): Promise<T> {
  const lock = await acquire();
  if (lock === null) onNotAcquired();
  try {
    return await fn(lock);
  } finally {
    try {
      await release(lock);
    } catch (err) {
      log.error({ err }, "event-import: releasing the import lock failed (import result unaffected)");
    }
  }
}

/**
 * Concurrency lock (Task 5, review finding #7; row-based since fix round 2,
 * owner ruling 2026-08-25 — design doc §5.1). One `importEvents` call at a
 * time per `(division, import_id)`: a losing caller gets 409
 * `import.concurrent` rather than interleaving with the call already
 * running.
 *
 * A ROW, not a Postgres advisory lock (fix round 1 shipped the latter; the
 * owner retired it). An advisory lock is held by a SESSION — under a
 * transaction-mode pooler (e.g. Supabase's `:6543`) the physical backend can
 * be reassigned between the lock and unlock statements, silently breaking
 * the cross-process guarantee — and keeping a session alive for the whole
 * call is exactly what forced reserving a dedicated pool connection
 * (`sql.reserve()`, fix round 1's `withReserveTimeout`), which pinned a pool
 * slot for the call's full O(n²) duration and could starve the pool under
 * concurrent imports on different keys. A row is data: it survives pooler
 * reassignment because there is no session to lose, and it reserves
 * nothing, so `withReserveTimeout` and its pool-starvation bound are DELETED
 * outright rather than kept — there is no reserve left to time out.
 *
 * Acquired here, in the usecase — not the route — because a route can be
 * reached more than one way (the D6 HTTP surface is the only one today, but
 * the lock's job is protecting the receipt table, which is the usecase's,
 * not the route's, invariant to hold).
 *
 * Correctness does not rest on this lock. It rests on `event_imports`'s
 * unique index (Tasks 1/3/4), which no pooling mode can weaken and which a
 * premature takeover (a stale row whose TTL elapsed) cannot bypass — this
 * lock only turns what would otherwise be a race on that index into a clean
 * 409 up front.
 */
export async function importEvents(
  auth: AuthCtx,
  divisionId: string,
  input: EventImportRequest,
): Promise<ImportReport> {
  return withLock(
    () => acquireImportLock(divisionId, input.import_id, auth.orgId),
    (holder) => releaseImportLock(divisionId, input.import_id, auth.orgId, holder),
    () => {
      throw new HttpError(
        409,
        "another import with this import_id is already running for this division",
        "import.concurrent",
      );
    },
    (holder) => runImport(auth, divisionId, input, holder),
  );
}

async function runImport(
  auth: AuthCtx,
  divisionId: string,
  input: EventImportRequest,
  lockHolder: string,
): Promise<ImportReport> {
  const startedAt = performance.now();
  assertWithinCaps(input);
  const division = await loadDivision(auth, divisionId);
  // Doc 12 §1 / R1: import inherits live scoring's phase gate — a published
  // but unstarted timetable stays read-only.
  if (division.status === "setup" || division.status === "scheduled") {
    throw new HttpError(
      409,
      "division has not started — import is closed",
      "import.division_not_started",
      { divisionStatus: division.status },
    );
  }
  const results: ImportStreamResult[] = [];
  for (const stream of input.streams) {
    // Sequential, by design (design doc §4) — bounded, predictable load.
    results.push(await runStream(auth, division, input.import_id, stream));
    // Between streams, never inside one — design doc §5.1. A refresh run
    // from inside runStream's own write transaction would be invisible to
    // every other caller until that transaction commits, which is the
    // opposite of what keeping the lock alive is for. Guarded the same way
    // the release path already is (withLock's finally, above): a lock-table
    // hiccup here must not abort an import whose per-fixture writes already
    // committed.
    try {
      await refreshImportLock(divisionId, input.import_id, auth.orgId, lockHolder);
    } catch (err) {
      log.error({ err }, "event-import: refreshing the import lock failed (import result unaffected)");
    }
  }
  const report = buildReport(input.import_id, results);
  const appended = results.reduce((n, r) => n + r.eventsAppended, 0);
  log.info(
    {
      division: divisionId,
      import_id: input.import_id,
      streams: input.streams.length,
      appended,
      rejected: report.totals.rejected,
      ms: Math.round(performance.now() - startedAt),
    },
    "events_imported",
  );
  return report;
}
