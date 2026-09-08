// B05 T2 — the batch write-path fold (design doc §3 D4, §4).
//
// D4: both write paths ship, split across `_tiny`'s two divisions. Division
// A folds through the single-event door (`simulate.ts`, T1); THIS file folds
// division B's own streams through the LIVE batch-import route instead —
// `POST /api/v1/divisions/{id}/events/import`, `EventImportRequest`
// (`import_id`, `streams[].fixture{id|ext_key}`, `streams[].events[]{type,
// payload,at?}`). Rationale for the split (D4): the single-POST path is what
// live scoring uses and must never lose coverage; an import path built now
// and first exercised in B08 would be an inert seam for three waves — the
// exact failure class this wave exists to close.
//
// ---------------------------------------------------------------------------
// `IMPORT_CAPS` — a HAND MIRROR, not an import
// ---------------------------------------------------------------------------
// `apps/web/src/server/usecases/event-import.ts:39` declares the real
// ceilings: `IMPORT_CAPS = { streams: 50, eventsPerFixture: 1_000,
// eventsPerCall: 10_000 }` (R4 — a single huge stream is a hung request, not
// a rejection, because `appendEventInTx` re-folds the whole prior stream on
// every append).
//
// That file cannot be imported from here. It opens with `import
// "server-only"`, which is a Next.js BUILD-TIME webpack alias
// (`node_modules/next/dist/build/create-compiler-aliases.js`), not a real npm
// package — there is no `server-only` anywhere under this repo's
// node_modules, confirmed directly (`node -e "require.resolve('server-only',
// {paths:[...]})"` from inside `apps/web/src/server/usecases` throws
// `MODULE_NOT_FOUND`). `apps/web/vitest.config.ts` says the same thing in its
// own words — "'server-only' is a Next build-time marker, absent under
// vitest" — and supplies a stub alias that exists ONLY inside apps/web's own
// vitest config. Neither this file's runtime (`node --experimental-strip-
// types`, no bundler, no alias) nor `scripts/bench`'s own vitest run
// (packages/engine's binary, no apps/web config in scope) can resolve it, so
// `import { IMPORT_CAPS } from "../../../apps/web/src/server/usecases/
// event-import.ts"` would crash EVERY caller at module load — not a subtle
// bug, a guaranteed `ERR_MODULE_NOT_FOUND` before a single test runs.
//
// This is the SAME constraint `validate-pack.ts`'s `STAGE_DECIDER_KEYS`
// mirror already lives under (that file's own comment: "GLOBAL.md: `@/`
// aliases do not resolve here and most of that tree is `server-only`"), and
// the same fix: a HAND MIRROR here, checked against the real file as TEXT by
// `__tests__/import.test.ts` ("the mirror is diffed against apps/web, not
// itself" — `validate-pack.test.ts`'s own established pattern for
// `STAGE_DECIDER_KEYS`), red on absence rather than silently drifting.
export const IMPORT_CAPS = { streams: 50, eventsPerFixture: 1_000, eventsPerCall: 10_000 } as const;

import { BenchHttpError, raw, type RawResult, type Session } from "./http.ts";
import { computeEventsPerSecond, resolvePayloadRefs } from "./simulate.ts";
import { fixtureKey, type PackStream } from "./pack-schema.ts";

// ---------------------------------------------------------------------------
// Transport — same narrow, injected, defaulted-to-the-real-thing shape every
// other bench probe in this directory uses (`SimTransport`, `ProbeTransport`,
// `SeedTransport`), declared fresh rather than imported: this file's only
// primitive is `raw()`, for the same reason `simulate.ts` needs it — reading
// back a refusal's real status and body, which `request()` discards.
// ---------------------------------------------------------------------------
export interface ImportTransport {
  raw(base: string, s: Session, path: string, method?: string, body?: unknown): Promise<RawResult>;
}

export const defaultImportTransport: ImportTransport = { raw };

// ---------------------------------------------------------------------------
// The wire shapes this file sends/reads — hand-declared, matching the
// product's `EventImportRequest` (schemas.ts) / `ImportReport` (event-
// import.ts) field for field, for the SAME "cannot import apps/web" reason
// `IMPORT_CAPS` above cites. `schemas.ts` itself is safely importable (it is
// explicitly "NOT server-only: pure Zod" and other bench test files already
// do), but no PRODUCTION file under `scripts/bench/lib/` imports from
// `apps/web` at all — `pack-schema.ts`'s own `PackEvent`/`PackStream` mirror
// this same product shape by hand rather than importing it, and this file
// follows that established convention rather than being the first exception.
// ---------------------------------------------------------------------------

interface ImportEventBody {
  readonly type: string;
  readonly payload: unknown;
  readonly at?: string;
}

interface ImportStreamBody {
  readonly fixture: { readonly id: string };
  readonly events: readonly ImportEventBody[];
}

export interface EventImportRequestBody {
  readonly import_id: string;
  readonly streams: readonly ImportStreamBody[];
}

/** One row of `ImportReport.results[]` (event-import.ts:41-53), read back
 *  off a 200 response. */
interface ImportReportRow {
  readonly fixture: string;
  readonly status: "imported" | "skipped_duplicate" | "rejected";
  readonly eventsAppended: number;
  readonly outcome?: unknown;
  readonly error?: {
    readonly code: string;
    readonly eventIndex?: number;
    readonly engineCode?: string;
    readonly feature?: string;
    readonly matches?: number;
  };
}

interface ImportReportBody {
  readonly importId: string;
  readonly totals: { readonly imported: number; readonly skipped: number; readonly rejected: number };
  readonly results: readonly ImportReportRow[];
}

/** The v1 error envelope this file actually reads (`api-v1/http.ts`'s
 *  `errorResponse`: `{ ok: false, error: { code, message, ...extra } }`) —
 *  same local type, same reason, as `simulate.ts`'s own `V1ErrorEnvelope`. */
interface V1ErrorEnvelope {
  readonly ok: false;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** One stream's outcome as the PRODUCT reported it inside a 200 response —
 *  never silently dropped: a status other than `"imported"` also produces an
 *  `ImportFinding` (below) so a caller cannot lose track of it by only
 *  reading `eventsSent`. */
export interface ImportStreamOutcome {
  readonly streamKey: string;
  readonly fixture: string;
  readonly status: "imported" | "skipped_duplicate" | "rejected";
  readonly eventsAppended: number;
  readonly error?: ImportReportRow["error"];
}

/** A stream whose own `events[]` exceeds `IMPORT_CAPS.eventsPerFixture` on
 *  its own — chunking cannot help (splitting one fixture's events across two
 *  calls would mean the second call sees a fixture with existing
 *  `score_events` rows and 409s `import.fixture_started`; see event-
 *  import.ts step 3). Reported here, BEFORE any HTTP call for this stream is
 *  ever attempted. */
export interface ImportOversizeFinding {
  readonly kind: "stream_oversize";
  readonly streamKey: string;
  readonly eventCount: number;
  readonly cap: number;
}

/** A whole call refused before any of its streams ran — 400 (schema
 *  refusal, e.g. `core.void`), 402 (`import.events` not entitled, or a
 *  frozen competition), 409 (`import.concurrent`, or
 *  `import.division_not_started`). Never a silent skip and never a retry
 *  (matching `simulate.ts`'s D5 convention exactly): this aborts the WHOLE
 *  chunk, so every streamKey the chunk carried is named. */
export interface ImportCallRefusedFinding {
  readonly kind: "call_refused";
  readonly chunkIndex: number;
  readonly streamKeys: readonly string[];
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** A stream the product's 200 response reported as `skipped_duplicate` or
 *  `rejected` — DATA inside a successful call, never an HTTP refusal, but
 *  still never silent: a stream that failed to land is exactly the "inert
 *  seam" risk this whole wave exists to close. */
export interface ImportStreamNotImportedFinding {
  readonly kind: "stream_not_imported";
  readonly streamKey: string;
  readonly fixture: string;
  readonly status: "skipped_duplicate" | "rejected";
  readonly code?: string;
  readonly eventIndex?: number;
}

export type ImportFinding =
  | ImportOversizeFinding
  | ImportCallRefusedFinding
  | ImportStreamNotImportedFinding;

export interface ImportDivisionStreamsInput {
  readonly base: string;
  readonly session: Session;
  readonly divisionId: string;
  readonly importId: string;
  /** Already filtered to ONE division by the caller (D4 — division B's
   *  streams only; division A's single-event path is `simulate.ts`'s job). */
  readonly streams: readonly PackStream[];
  /** `bindStreamFixtures`'s own result map — this file never re-resolves a
   *  fixture id, same as `simulate.ts`. */
  readonly fixtureIdByKey: ReadonlyMap<string, string>;
  /** Entrant AND person ids merged into one map — same "`@`-sigil is ONE
   *  namespace" reasoning as `simulate.ts`'s own `SimulateStreamsInput`. */
  readonly refIdByKey: ReadonlyMap<string, string>;
  readonly transport?: ImportTransport;
  /** Overridable so a unit test can drive the boundary/over-cap chunking
   *  branches without constructing a 50-stream, 10,000-event pack by hand
   *  for every assertion. Defaults to the real `IMPORT_CAPS` — a live run
   *  never passes this. */
  readonly caps?: { readonly streams: number; readonly eventsPerFixture: number; readonly eventsPerCall: number };
}

export interface ImportResult {
  /** Total across every chunk, summing each stream's `eventsAppended` —
   *  `"skipped_duplicate"`/`"rejected"` rows always carry 0, so this equals
   *  the sum over `"imported"` rows alone. */
  readonly eventsSent: number;
  readonly wallMs: number;
  readonly eventsPerSecond: number;
  /** Number of HTTP calls this fold actually made. */
  readonly chunks: number;
  readonly streamOutcomes: readonly ImportStreamOutcome[];
  /** Every finding from every chunk, flattened — empty on a clean fold. */
  readonly findings: readonly ImportFinding[];
}

// ---------------------------------------------------------------------------
// Chunking — pure, so the boundary/over-cap branches are unit-testable
// without any HTTP at all (scope note 2: `_tiny` never exercises these live).
// ---------------------------------------------------------------------------

export interface ChunkStreamsResult {
  readonly chunks: readonly (readonly PackStream[])[];
  /** Streams excluded from every chunk because they alone exceed
   *  `eventsPerFixture` — never silently dropped. */
  readonly oversize: readonly ImportOversizeFinding[];
}

/** Greedily packs streams into calls, each respecting BOTH `caps.streams`
 *  (a call's own stream count) and `caps.eventsPerCall` (a call's own total
 *  event count) — checked in that order, matching `assertWithinCaps`'s own
 *  order (event-import.ts:89-117), though this file's whole job is to never
 *  let either trip. A stream whose OWN `events.length` exceeds
 *  `caps.eventsPerFixture` is excluded before packing even starts: no
 *  chunking arrangement can make it fit (see `ImportOversizeFinding`'s own
 *  doc comment on why splitting it across two calls cannot substitute). */
export function chunkStreamsForImport(
  streams: readonly PackStream[],
  caps: { readonly streams: number; readonly eventsPerFixture: number; readonly eventsPerCall: number } = IMPORT_CAPS,
): ChunkStreamsResult {
  const oversize: ImportOversizeFinding[] = [];
  const importable: PackStream[] = [];
  for (const stream of streams) {
    if (stream.events.length > caps.eventsPerFixture) {
      oversize.push({
        kind: "stream_oversize",
        streamKey: fixtureKey(stream.divisionRef, stream.fixtureExtKey),
        eventCount: stream.events.length,
        cap: caps.eventsPerFixture,
      });
      continue;
    }
    importable.push(stream);
  }

  const chunks: PackStream[][] = [];
  let current: PackStream[] = [];
  let currentEvents = 0;
  for (const stream of importable) {
    const wouldExceedStreams = current.length + 1 > caps.streams;
    const wouldExceedEvents = currentEvents + stream.events.length > caps.eventsPerCall;
    if (current.length > 0 && (wouldExceedStreams || wouldExceedEvents)) {
      chunks.push(current);
      current = [];
      currentEvents = 0;
    }
    current.push(stream);
    currentEvents += stream.events.length;
  }
  if (current.length > 0) chunks.push(current);

  return { chunks, oversize };
}

// ---------------------------------------------------------------------------
// `import_id` — deterministic per (run, division), never random
// ---------------------------------------------------------------------------
//
// event-import.ts's own idempotency guarantee (its header comment, and step
// 2 of `runStream`) is keyed on `(division_id, import_id, fixture_id)`: a
// REPEAT call carrying the SAME `import_id` against a fixture that already
// has a receipt row returns `"skipped_duplicate"` without even opening a
// transaction, while a call carrying a DIFFERENT `import_id` against a
// fixture that already has `score_events` rows (from an earlier import)
// hits the UNSTARTED guard instead and is `"rejected"` with
// `"import.fixture_started"` — two different refusals for two different
// mistakes, both pinned by `__tests__/import.test.ts`.
//
// `runId` (bench.ts's own `resolveRunId(--run-id, gitSha)` — stable across
// reruns AT THE SAME COMMIT, never a fresh random value per invocation) is
// threaded through so a rerun at the same commit reuses the same
// `import_id` — which is exactly what lets a non-`--wipe` rerun exercise the
// REAL replay guarantee instead of minting a fresh id that could never
// collide with anything. Falls back to a stable literal when absent (every
// unit test, and any caller that never resolved a run id).
export function buildImportId(divisionRef: string, runId?: string): string {
  return `bench-import:${runId ?? "local"}:${divisionRef}`;
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

function buildImportRequestBody(
  importId: string,
  streams: readonly PackStream[],
  fixtureIdByKey: ReadonlyMap<string, string>,
  refIdByKey: ReadonlyMap<string, string>,
): EventImportRequestBody {
  return {
    import_id: importId,
    streams: streams.map((stream) => {
      const streamKey = fixtureKey(stream.divisionRef, stream.fixtureExtKey);
      const fixtureId = fixtureIdByKey.get(streamKey);
      if (fixtureId === undefined) {
        throw new Error(
          `import: stream "${streamKey}" matched no bound fixture — bindStreamFixtures should have refused this earlier`,
        );
      }
      return {
        fixture: { id: fixtureId },
        // `at` unconditionally, never a conditional spread: `at` is optional
        // on both `PackEvent` and the wire `EventImportRequest` schema, and
        // `JSON.stringify` (`http.ts`'s `raw()`) drops an `undefined`-valued
        // key before anything reaches the wire — a conditional spread here
        // would be a distinction with no observable difference, which a
        // mutation sweep found: removing it changed no test outcome.
        events: stream.events.map((event) => ({
          type: event.type,
          payload: resolvePayloadRefs(event.payload, refIdByKey),
          at: event.at,
        })),
      };
    }),
  };
}

/** Recognized call-level refusals — a whole call refused before any stream
 *  ran. Exactly the set the brief names: 400 (schema refusal, `core.void`),
 *  402, 409, 422. NOT 413: this file's entire job is to never trip it, so a
 *  413 reaching here means the CHUNKER has a bug, not a legitimate business
 *  refusal — it falls through to the throw below, same as an unrecognized
 *  5xx does in `simulate.ts`. */
const CALL_REFUSAL_STATUSES = new Set([400, 402, 409, 422]);

function findingFromCallRefusal(
  result: RawResult,
  chunkIndex: number,
  streamKeys: readonly string[],
): ImportCallRefusedFinding {
  const body = result.json as unknown as V1ErrorEnvelope;
  const err = body?.ok === false ? body.error : undefined;
  return {
    kind: "call_refused",
    chunkIndex,
    streamKeys,
    status: result.status,
    code: err?.code ?? `HTTP_${result.status}`,
    message: err?.message ?? "(no message in response body)",
  };
}

async function runChunk(
  base: string,
  session: Session,
  divisionId: string,
  importId: string,
  chunkStreams: readonly PackStream[],
  fixtureIdByKey: ReadonlyMap<string, string>,
  refIdByKey: ReadonlyMap<string, string>,
  chunkIndex: number,
  t: ImportTransport,
): Promise<{ eventsSent: number; streamOutcomes: ImportStreamOutcome[]; findings: ImportFinding[] }> {
  const streamKeys = chunkStreams.map((s) => fixtureKey(s.divisionRef, s.fixtureExtKey));
  const path = `/api/v1/divisions/${divisionId}/events/import`;
  const body = buildImportRequestBody(importId, chunkStreams, fixtureIdByKey, refIdByKey);
  const result = await t.raw(base, session, path, "POST", body);

  if (result.status === 200) {
    const report = (result.json as unknown as { data?: ImportReportBody }).data;
    if (report === undefined) {
      throw new Error(`import: 200 response for ${path} carried no data — cannot read its report`);
    }
    // POSITIONAL correlation: `runImport` (event-import.ts:712-732) is a
    // plain synchronous `for...of input.streams` loop pushing exactly one
    // result per stream, in order — so `report.results[i]` answers for
    // `chunkStreams[i]`. Not a documented wire contract on `ImportReport`
    // itself, but true of the implementation this fold drives, and the only
    // way to attach a streamKey to a response row that otherwise carries
    // only the resolved fixture id.
    if (report.results.length !== chunkStreams.length) {
      throw new Error(
        `import: chunk sent ${chunkStreams.length} stream(s) but the report carries ${report.results.length} result(s) — ` +
          "positional correlation would silently mismatch",
      );
    }
    let eventsSent = 0;
    const streamOutcomes: ImportStreamOutcome[] = [];
    const findings: ImportFinding[] = [];
    for (let i = 0; i < chunkStreams.length; i += 1) {
      const row = report.results[i];
      const streamKey = streamKeys[i];
      eventsSent += row.eventsAppended;
      streamOutcomes.push({
        streamKey,
        fixture: row.fixture,
        status: row.status,
        eventsAppended: row.eventsAppended,
        ...(row.error !== undefined ? { error: row.error } : {}),
      });
      if (row.status !== "imported") {
        findings.push({
          kind: "stream_not_imported",
          streamKey,
          fixture: row.fixture,
          status: row.status,
          ...(row.error?.code !== undefined ? { code: row.error.code } : {}),
          ...(row.error?.eventIndex !== undefined ? { eventIndex: row.error.eventIndex } : {}),
        });
      }
    }
    return { eventsSent, streamOutcomes, findings };
  }

  if (CALL_REFUSAL_STATUSES.has(result.status)) {
    return {
      eventsSent: 0,
      streamOutcomes: [],
      findings: [findingFromCallRefusal(result, chunkIndex, streamKeys)],
    };
  }

  throw new BenchHttpError(path, result.status, result.json);
}

/**
 * Folds division B's own streams through the batch-import route, one HTTP
 * call per chunk. Chunks are sent SEQUENTIALLY (unlike `simulate.ts`'s
 * cross-fixture concurrency): every chunk shares ONE `(division, import_id)`
 * row lock (`event-import.ts`'s `withLock`/`acquireImportLock`), so two
 * chunks in flight together would only serialize behind that lock anyway —
 * the loser gets 409 `import.concurrent`, which from this file would look
 * like a spurious call-level refusal rather than the predictable N calls a
 * sequential fold actually makes.
 */
export async function importDivisionStreams(input: ImportDivisionStreamsInput): Promise<ImportResult> {
  const t = input.transport ?? defaultImportTransport;
  const caps = input.caps ?? IMPORT_CAPS;
  const start = performance.now();

  const { chunks, oversize } = chunkStreamsForImport(input.streams, caps);
  const findings: ImportFinding[] = [...oversize];
  const streamOutcomes: ImportStreamOutcome[] = [];
  let eventsSent = 0;

  for (let i = 0; i < chunks.length; i += 1) {
    const outcome = await runChunk(
      input.base,
      input.session,
      input.divisionId,
      input.importId,
      chunks[i],
      input.fixtureIdByKey,
      input.refIdByKey,
      i,
      t,
    );
    eventsSent += outcome.eventsSent;
    streamOutcomes.push(...outcome.streamOutcomes);
    findings.push(...outcome.findings);
  }

  const wallMs = Math.round(performance.now() - start);
  return {
    eventsSent,
    wallMs,
    eventsPerSecond: computeEventsPerSecond(eventsSent, wallMs),
    chunks: chunks.length,
    streamOutcomes,
    findings,
  };
}
