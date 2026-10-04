// B05 T1 — the single-event write-path fold (design doc §3 D4, §4).
//
// Folds a pack's own event streams through the LIVE single-event scoring
// route (`POST /api/v1/fixtures/{id}/events`, `AppendEventRequest` —
// `expected_seq`, `type`, `payload`) — the same door live scoring uses. This
// is the seam `seed.ts`'s `bindStreamFixtures` resolves fixture ids for and
// then never reads `.events` at all (B05 design doc §1) — closing it is
// this file's entire job.
//
// ---------------------------------------------------------------------------
// `expected_seq` is the stream's own 0-based array index
// ---------------------------------------------------------------------------
// `append-event.ts`'s optimistic-concurrency check reads the ledger TIP
// before the candidate is appended (`coalesce(max(seq),0)`) and requires
// `lastSeq === expectedSeq`, then mints the candidate's own seq as
// `expectedSeq + 1` (engine-db/append-event.ts:184-213). An empty ledger's
// tip is 0, so the FIRST event's `expected_seq` is 0, not 1 — exactly what
// pack-schema.ts's header note 2 already says from the authoring side
// ("array order IS the sequence"). This file mints `expected_seq: i` for the
// event at array index `i`, never a value read from the pack (packs carry no
// `seq` field at all, on purpose — see that same header note).
//
// ---------------------------------------------------------------------------
// Sequential per fixture, concurrent across fixtures IN A WAVE (_RULES.md §3)
// ---------------------------------------------------------------------------
// One fixture's events are folded with a plain sequential loop (`await`ed one
// at a time) — sending event N+1 before event N's response is back would
// race the real ledger's own optimistic-concurrency check. Multiple
// fixtures' streams are independent of each other (different rows, no shared
// ledger), so they run concurrently via `Promise.all`.
//
// CORRECTED IN B06b: that independence claim holds for a LEAGUE and is FALSE
// for a BRACKET. A knockout fixture's entrants are written by its feeders'
// decisions, so fixture N+1 depends on fixture N, and one flat `Promise.all`
// refused all 63 of suite 11's later-round fixtures with `WRONG_PHASE —
// fixture has an unassigned entrant (bye/TBD)`. It survived five waves because
// `_tiny`'s only multi-fixture stage is a league and its knockout is a single
// fixture. Callers now pass `roundByFixtureKey` and folding proceeds round by
// round — see that field's doc comment.
//
// ---------------------------------------------------------------------------
// A refusal is a FINDING, never a silent skip and never a retry (D5)
// ---------------------------------------------------------------------------
// Three statuses are recognized refusals, each with a real production
// meaning: 409 `SEQ_CONFLICT` (the optimistic-concurrency door,
// `api-v1/http.ts:21`, carrying `current_seq` in the body — B05-repins'
// F-verified pin), 402 `PAYMENT_REQUIRED` (the REAL shape an entitlement/
// feature gate refuses with — `PaymentRequiredError` maps to 402, never 422;
// see `dls-gate.ts`'s own header comment: "never the 'typed 422' an earlier
// draft of this task expected" — the SAME stale premise this task's brief
// carried, corrected the same way here), and 422 (kept as a second, generic
// refusal bucket in case some OTHER business-rule gate uses it — never
// assumed to carry an entitlement reason specifically). Hitting any of the
// three stops folding THAT fixture's stream (a later event's `expected_seq`
// is only valid relative to a ledger tip this file no longer knows for
// certain) and records a `SimulateFinding`; it never retries the failed call
// and never silently drops the rest of the stream without saying so. Every
// OTHER status (5xx, or a 4xx none of the above) is a genuine bug the bench
// must catch — this file throws rather than swallowing it.
import { BenchHttpError, raw, type RawResult, type Session } from "./http.ts";
import { fixtureKey, type PackStream } from "./pack-schema.ts";

// ---------------------------------------------------------------------------
// Transport — narrow, injected, defaulted to the real thing (same DI shape
// as `seed.ts`'s `SeedTransport` and `dls-gate.ts`'s `ProbeTransport`,
// narrowed to exactly the one primitive this file calls: `raw()`, because a
// refusal has to be read back as a real status + body, which `request()`
// deliberately discards by throwing).
// ---------------------------------------------------------------------------
export interface SimTransport {
  raw(base: string, s: Session, path: string, method?: string, body?: unknown): Promise<RawResult>;
}

export const defaultSimTransport: SimTransport = { raw };

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface SimulateFinding {
  /** `fixtureKey(divisionRef, ext_key)` — the same composite key
   *  `bindStreamFixtures` binds against. */
  readonly streamKey: string;
  readonly fixtureId: string;
  /** 0-based index into the stream's own `events[]` — the event that was
   *  refused, i.e. the LAST `expected_seq` this file sent for this fixture. */
  readonly eventIndex: number;
  readonly status: number;
  readonly code: string;
  readonly message: string;
  /** Present only on a 409 `SEQ_CONFLICT` body (`api-v1/http.ts`'s
   *  `current_seq` extra). */
  readonly currentSeq?: number;
}

export interface SimulateStreamResult {
  readonly streamKey: string;
  readonly fixtureId: string;
  /** Events actually appended (201) before either the stream ran out or a
   *  refusal stopped it. */
  readonly eventsSent: number;
  /** Set iff a refusal stopped this fixture's fold before its last event. */
  readonly finding?: SimulateFinding;
}

export interface SimulateResult {
  /** Total across every stream folded. */
  readonly eventsSent: number;
  readonly wallMs: number;
  readonly eventsPerSecond: number;
  readonly streams: readonly SimulateStreamResult[];
  /** Every stream's finding, flattened — empty on a clean fold. */
  readonly findings: readonly SimulateFinding[];
}

export interface SimulateStreamsInput {
  readonly base: string;
  readonly session: Session;
  /** Already filtered to ONE division by the caller (D4 — division A's
   *  streams only; division B's import path is a separate task). */
  readonly streams: readonly PackStream[];
  /** `bindStreamFixtures`'s own result map — this file never re-resolves a
   *  fixture id. */
  readonly fixtureIdByKey: ReadonlyMap<string, string>;
  /** Entrant AND person ids, merged into one map — pack-schema.ts header
   *  note 6's `@`-sigil is ONE namespace across both kinds, so a single map
   *  is exactly as authoritative as two. */
  readonly refIdByKey: ReadonlyMap<string, string>;
  /**
   * B06b — DEPENDENCY WAVES. Keyed by `fixtureKey(divisionRef, extKey)`, the
   * value is the fixture's `round_no` off the real board.
   *
   * This file's header says fixtures "are independent of each other (different
   * rows, no shared ledger)", and for a LEAGUE that is true. For a BRACKET it
   * is false: a knockout fixture's entrants are written by its feeders'
   * decisions, so fixture N+1 genuinely depends on fixture N. Folding all of
   * them through one `Promise.all` refuses every later round with
   * `WRONG_PHASE — fixture has an unassigned entrant (bye/TBD)`.
   *
   * Nothing caught this for five waves because `_tiny`'s only multi-fixture
   * stage is a league and its knockout is a single fixture. Suite 11 is the
   * first real bracket, and all nine remaining pack sessions are brackets too.
   *
   * When given, streams fold round by round — ascending, awaited between
   * rounds, still concurrent WITHIN a round, so a league (one round number, or
   * this map omitted) behaves exactly as before.
   */
  readonly roundByFixtureKey?: ReadonlyMap<string, number>;
  readonly transport?: SimTransport;
}

// ---------------------------------------------------------------------------
// Throughput — pure, so the arithmetic is unit-testable independent of any
// real wall-clock measurement (Math.round elsewhere keeps the reported ms an
// integer; this function is never handed a fractional eventsSent).
// ---------------------------------------------------------------------------
export function computeEventsPerSecond(eventsSent: number, wallMs: number): number {
  if (wallMs <= 0) return eventsSent;
  return (eventsSent / wallMs) * 1000;
}

// ---------------------------------------------------------------------------
// The `@`-sigil rewrite (pack-schema.ts header note 6). Stage 0 (`validate-
// pack.ts`'s `unresolvedPayloadRefs`) already proves every ref in a VALID
// pack resolves against the pack's OWN declared refs before any HTTP call
// happens; this is a second, independent check against the REAL ids
// `seedSuite` actually minted; a miss here means a bug in what the caller
// merged into `refIdByKey`, not a bad pack.
// ---------------------------------------------------------------------------
/** `caller` names WHO is resolving refs, for the thrown message's prefix
 *  ONLY — never read for any other purpose. `import.ts:336` reuses this
 *  function (its own header comment says so) and used to inherit a
 *  hardcoded `"simulate:"` prefix, so an import-fold failure misreported
 *  itself as a simulate failure (T2.5 review MINOR). Defaults to
 *  `"simulate"` — this file's own call site — so every existing caller and
 *  test is unaffected. */
export function resolvePayloadRefs(
  value: unknown,
  refIdByKey: ReadonlyMap<string, string>,
  caller = "simulate",
): unknown {
  if (typeof value === "string") {
    if (!value.startsWith("@")) return value;
    const ref = value.slice(1);
    const id = refIdByKey.get(ref);
    if (id === undefined) {
      throw new Error(
        `${caller}: payload ref "${value}" resolved to no known entrant/person id — check what seedSuite actually bound`,
      );
    }
    return id;
  }
  if (Array.isArray(value)) return value.map((v) => resolvePayloadRefs(v, refIdByKey, caller));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolvePayloadRefs(v, refIdByKey, caller)]),
    );
  }
  return value;
}

/** The v1 error envelope this file actually reads (`api-v1/http.ts`'s
 *  `errorResponse`: `{ ok: false, error: { code, message, ...extra } }`) —
 *  a LOCAL type, not `lib/http.ts`'s own loosely-typed `RawJson` (`error?:
 *  string`, written for a DIFFERENT envelope — see `dls-gate.ts`'s identical
 *  note on why the two disagree in this codebase). */
interface V1ErrorEnvelope {
  readonly ok: false;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly current_seq?: number;
  };
}

const REFUSAL_STATUSES = new Set([409, 402, 422]);

function findingFromRefusal(
  result: RawResult,
  streamKey: string,
  fixtureId: string,
  eventIndex: number,
): SimulateFinding {
  const body = result.json as unknown as V1ErrorEnvelope;
  const err = body?.ok === false ? body.error : undefined;
  const currentSeq = err?.current_seq;
  return {
    streamKey,
    fixtureId,
    eventIndex,
    status: result.status,
    code: err?.code ?? `HTTP_${result.status}`,
    message: err?.message ?? "(no message in response body)",
    ...(typeof currentSeq === "number" ? { currentSeq } : {}),
  };
}

async function foldOneStream(
  base: string,
  session: Session,
  stream: PackStream,
  fixtureIdByKey: ReadonlyMap<string, string>,
  refIdByKey: ReadonlyMap<string, string>,
  t: SimTransport,
): Promise<SimulateStreamResult> {
  const streamKey = fixtureKey(stream.divisionRef, stream.fixtureExtKey);
  const fixtureId = fixtureIdByKey.get(streamKey);
  if (fixtureId === undefined) {
    throw new Error(
      `simulate: stream "${streamKey}" matched no bound fixture — bindStreamFixtures should have refused this earlier`,
    );
  }

  const path = `/api/v1/fixtures/${fixtureId}/events`;
  let eventsSent = 0;
  for (let i = 0; i < stream.events.length; i += 1) {
    const event = stream.events[i];
    const payload = resolvePayloadRefs(event.payload, refIdByKey, "simulate");
    const body = { expected_seq: i, type: event.type, payload };
    // Sequential, on purpose: the next iteration must not fire until THIS
    // one's response is back (_RULES.md §3's "strictly sequential per
    // fixture" — see this file's header comment).
    const result = await t.raw(base, session, path, "POST", body);
    if (result.status === 201) {
      eventsSent += 1;
      continue;
    }
    if (REFUSAL_STATUSES.has(result.status)) {
      return { streamKey, fixtureId, eventsSent, finding: findingFromRefusal(result, streamKey, fixtureId, i) };
    }
    throw new BenchHttpError(path, result.status, result.json);
  }
  return { streamKey, fixtureId, eventsSent };
}

/**
 * Split streams into dependency waves. One wave when no round map is given —
 * which is every league, and is byte-for-byte the old behaviour.
 *
 * A stream whose fixture is absent from the map keeps its own wave position by
 * landing in wave `-1`, folded FIRST rather than dropped: an unmapped fixture
 * is a binding anomaly `bindStreamFixtures` should already have refused, and
 * silently reordering it would hide that.
 */
function dependencyWaves(
  streams: readonly PackStream[],
  roundByFixtureKey: ReadonlyMap<string, number> | undefined,
): readonly (readonly PackStream[])[] {
  if (roundByFixtureKey === undefined) return streams.length > 0 ? [streams] : [];
  const byRound = new Map<number, PackStream[]>();
  for (const s of streams) {
    const round = roundByFixtureKey.get(fixtureKey(s.divisionRef, s.fixtureExtKey)) ?? -1;
    byRound.set(round, [...(byRound.get(round) ?? []), s]);
  }
  return [...byRound.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group);
}

export async function simulateDivisionStreams(input: SimulateStreamsInput): Promise<SimulateResult> {
  const t = input.transport ?? defaultSimTransport;
  const start = performance.now();
  // Concurrent ACROSS fixtures WITHIN a wave, sequential BETWEEN waves — see
  // `roundByFixtureKey`'s doc comment for why a bracket cannot be one wave.
  const streamResults: SimulateStreamResult[] = [];
  for (const wave of dependencyWaves(input.streams, input.roundByFixtureKey)) {
    streamResults.push(
      ...(await Promise.all(
        wave.map((s) => foldOneStream(input.base, input.session, s, input.fixtureIdByKey, input.refIdByKey, t)),
      )),
    );
  }
  const wallMs = Math.round(performance.now() - start);
  const eventsSent = streamResults.reduce((sum, r) => sum + r.eventsSent, 0);
  const findings = streamResults.flatMap((r) => (r.finding ? [r.finding] : []));
  return {
    eventsSent,
    wallMs,
    eventsPerSecond: computeEventsPerSecond(eventsSent, wallMs),
    streams: streamResults,
    findings,
  };
}
