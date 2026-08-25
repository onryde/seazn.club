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
import { requiredFeatureForEvent } from "./fidelity";
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

  // 2. Guard unstarted: any existing score_events row, or a live/decided
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

  // 3. Unassigned entrant (bye/TBD) — nothing to fold against.
  if (!fixture.home_entrant_id || !fixture.away_entrant_id) {
    return {
      fixture: fixtureId,
      status: "rejected",
      eventsAppended: 0,
      error: { code: "import.slots_unfilled" },
    };
  }

  // 4. Entitlement per distinct event type, still on the pooled proxy.
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

  // 5. Dry-run fold: its own read-only transaction (loadLineupPair needs a
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

  // 6. Not implemented yet — Task 4 replaces this with the real write.
  return {
    fixture: fixtureId,
    status: "rejected",
    eventsAppended: 0,
    error: { code: "import.not_implemented" },
  };
}

export async function importEvents(
  auth: AuthCtx,
  divisionId: string,
  input: EventImportRequest,
): Promise<ImportReport> {
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
  return buildReport(input.import_id, results);
}
