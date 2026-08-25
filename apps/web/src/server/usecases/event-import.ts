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

/**
 * How long `importEvents` will wait to reserve a dedicated connection for
 * the concurrency lock before giving up (fix round 1, review finding #2).
 * Deliberately short: `reserve()` on a healthy pool resolves in single-digit
 * milliseconds, so a multi-second wait means the pool's `max` connections
 * (`DB_POOL_MAX`, default 5 — `lib/db.ts`'s `connectionOptions`) are
 * genuinely all busy. And since each reservation below is held for the
 * WHOLE call — including the O(n²) re-fold `IMPORT_CAPS.eventsPerFixture`
 * allows up to 1,000 events of — "genuinely busy" can mean "busy for a
 * while yet". Waiting longer would not turn a caller stuck behind that into
 * a success; it would only make the eventual 409 slower. Ruling: fail fast,
 * don't queue.
 */
const RESERVE_TIMEOUT_MS = 2_000;

/**
 * Race `reserve` against a timeout so pool exhaustion is a prompt 409
 * `import.concurrent` instead of an indefinite hang — see
 * `RESERVE_TIMEOUT_MS`'s own doc comment for why. Generic over any
 * reserve-shaped function (real production use passes `() => sql.reserve()`)
 * so a test can prove the timeout itself fires with a `reserve` that simply
 * never resolves, with no need to actually exhaust a real connection pool.
 *
 * If `reserve()` eventually settles AFTER the timeout has already won the
 * race, the connection it hands back is released immediately — the caller
 * gave up on it the moment the 409 was thrown, so nothing else is left
 * holding a reference, and not releasing it would pin that connection
 * forever instead of just for `ms`.
 */
export async function withReserveTimeout<T extends { release(): void }>(
  reserve: () => Promise<T>,
  ms: number,
): Promise<T> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = reserve();
  pending
    .then((conn) => {
      if (timedOut) conn.release();
    })
    .catch(() => {
      // The timeout branch below is what the caller actually sees; a late
      // rejection here (the pool itself erroring after we stopped waiting)
      // has nowhere useful left to go.
    });
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(
            new HttpError(
              409,
              "no database connection was available to acquire the import lock",
              "import.concurrent",
            ),
          );
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Acquire a session advisory lock via `acquire`, run `fn`, then ALWAYS
 * attempt `release` — but never let a `release` failure replace `fn`'s real
 * outcome (fix round 1, review finding #1). A successful import, or a
 * legitimate rejection `fn` threw on purpose (402/409/413/a per-stream
 * result), must be reported as exactly that even if the unlock afterwards
 * failed; a release failure is a leaked session lock, not a failed import,
 * and is logged rather than raised. `release` is skipped entirely when the
 * lock was never acquired (finding #3) — nothing to release, and every
 * `import.concurrent` 409 would otherwise cost a wasted round trip and log
 * noise for no reason.
 */
export async function withAdvisoryLock<T>(
  acquire: () => Promise<boolean>,
  release: () => Promise<void>,
  onNotAcquired: () => never,
  fn: () => Promise<T>,
): Promise<T> {
  const locked = await acquire();
  // `onNotAcquired` is typed `() => never` and this line is reached at all
  // only when it did NOT throw — i.e. only when `locked` was true. Nothing
  // past this point can still be running with `locked === false`, which is
  // finding #3's "skip release when the lock was never taken": there is no
  // separate guard to write, because the not-acquired path never reaches
  // the `try`/`finally` below in the first place. (An earlier draft added a
  // redundant `if (locked)` here anyway; a mutation check on it proved the
  // branch dead — removing it is the fix, not adding a second guard.)
  if (!locked) onNotAcquired();
  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch (err) {
      log.error({ err }, "event-import: releasing the import advisory lock failed (import result unaffected)");
    }
  }
}

/**
 * Concurrency lock (Task 5, review finding #7): one `importEvents` call at a
 * time per `(division, import_id)`. A losing caller gets 409
 * `import.concurrent` rather than interleaving with the call already running.
 *
 * SESSION-scoped (`pg_try_advisory_lock`/`pg_advisory_unlock`), not the
 * `_xact_` variant a first read of this suggests: the call spans MULTIPLE
 * independent transactions (a read-only dry-run tx and a write tx, once per
 * stream) plus pooled reads with nothing wrapping them — a lock tied to any
 * ONE of those transactions releases the moment that transaction commits,
 * long before the call is done, which does not serialise anything. A session
 * lock held on a single RESERVED connection for the call's whole lifetime
 * (`sql.reserve()`, released unconditionally below whether the call
 * succeeds, rejects a stream, or throws) is what actually holds it "for the
 * whole call" the brief asks for. Acquired here, in the usecase — not the
 * route — because a route can be reached more than one way (the D6 HTTP
 * surface is the only one today, but the lock's job is protecting the
 * receipt table, which is the usecase's, not the route's, invariant to
 * hold).
 *
 * SESSION-MODE POOLING ONLY (fix round 1 — flagged by review, owner
 * notified separately). A TRANSACTION-mode pooler in front of Postgres
 * (e.g. Supabase's `:6543`) can reassign the physical backend between this
 * function's lock and unlock statements — each one is its own checkout from
 * the pooler's point of view — which would silently break the mutual
 * exclusion this entire mechanism depends on. `DATABASE_URL` for any
 * deployment that imports must point at a session-mode endpoint (the
 * session pooler / `:5432`, per `lib/db.ts`'s own connection doc), never a
 * transaction-mode one.
 *
 * DB_POOL_MAX floor: each call below pins one pool connection for its whole
 * duration (`RESERVE_TIMEOUT_MS`'s doc comment). A deployment that expects N
 * concurrent imports needs `DB_POOL_MAX` above N plus its normal request
 * load, or unrelated requests start losing the race for a connection while
 * an import runs. (Owed a line on the help page too — Task 10 had not
 * written `content/help/**` for this feature as of this fix round; see the
 * Task 5 report.)
 */
export async function importEvents(
  auth: AuthCtx,
  divisionId: string,
  input: EventImportRequest,
): Promise<ImportReport> {
  const lockKey = `import:${divisionId}:${input.import_id}`;
  const reserved = await withReserveTimeout(() => sql.reserve(), RESERVE_TIMEOUT_MS);
  try {
    return await withAdvisoryLock(
      async () => {
        const [row] = await reserved<{ locked: boolean }[]>`
          select pg_try_advisory_lock(hashtext(${lockKey})) as locked`;
        return row!.locked;
      },
      async () => {
        await reserved`select pg_advisory_unlock(hashtext(${lockKey}))`;
      },
      () => {
        throw new HttpError(
          409,
          "another import with this import_id is already running for this division",
          "import.concurrent",
        );
      },
      () => runImport(auth, divisionId, input),
    );
  } finally {
    reserved.release();
  }
}

async function runImport(
  auth: AuthCtx,
  divisionId: string,
  input: EventImportRequest,
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
