// The append/replay protocol (S10 ruling — see the dispatch brief's "THE
// RULING THIS PASS EXISTS TO IMPLEMENT"). Pure decision functions
// (resolveConflict, deepEqual, reconcile) plus the thin network-driving
// functions (sendOne, drainQueue) that consume an INJECTED `ScoringTransport`
// — no real fetch/apiV1 wiring here; that adapter belongs to the pass that
// wires this chassis into a route (auth headers, device-link vs authed
// console differ there, per the S10 brief's "later pass owns React/routes").
//
// THE RULE: replay after tab death/offline sends the ORIGINAL expected_seq
// and the ORIGINAL idempotency_key — never a blind renegotiation. A Redis
// hit on the server replays the recorded outcome with no second write; a
// miss returns 409, a REFUSAL, not a write. On 409 the client decides
// whether its event already landed by inspecting the ledger SLOT
// (appendEvent accepts only at exactly expected_seq — server/engine-db/
// append-event.ts: the accepted event lands at `expected_seq + 1`, so THAT
// seq is a complete test). Only when that slot holds a FOREIGN event does
// the client renegotiate (expected_seq := current_seq) and resend — once.
import type {
  AppendSuccess,
  ConflictResolution,
  LedgerSlotEvent,
  OwnIdentity,
  PendingEvent,
  ReconcileResult,
  SendOutcome,
} from "./types";
import type { QueueStore } from "./queue-store";
import { markAcked, markDropped, peekInOrder, recordAttempt, renegotiateExpectedSeq } from "./queue";

// ---------------------------------------------------------------------------
// Pure: structural equality, used for both payload comparison (the 409
// ledger-slot test) and state comparison (reconcile). JSON-like data only —
// no Map/Set/Date, matching what the engine's State/payload shapes actually
// are (they round-trip through jsonb).
// ---------------------------------------------------------------------------
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((k) => Object.prototype.hasOwnProperty.call(bObj, k) && deepEqual(aObj[k], bObj[k]))
  );
}

/** `undefined` and `null` mean the same thing for these two identity fields
 *  ("nobody"/"not applicable") but are NOT `===`. `slot` is cast from ledger
 *  JSON — transport.ts validates it with zod at the wire boundary, but this
 *  is a pure function tested (and callable) independently of that boundary,
 *  so it normalises defensively on BOTH sides rather than trusting the
 *  caller already did. Review finding 1: an omitted key reading as
 *  `undefined` while our own identity holds `null` must NOT make an
 *  already-applied own event look foreign (renegotiate + resend a real
 *  duplicate) — the mirror-image risk is normalising so hard that a
 *  genuinely different value also reads as a match, which is why this stays
 *  a value-equality helper, not a "treat any falsy as absent" one. */
function sameIdentityField(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * The pure 409 verdict. `slot` is the ledger row at exactly the seq OUR
 * event would have landed at (null = unreadable OR absent — the fetch
 * failed, or the ledger has not reached that seq yet); `identity` is the
 * caller's own recorded_by/device_link_id to compare the slot against,
 * since the request body never carries them (they are server-stamped).
 *
 * Three outcomes, matching the S10 acceptance criteria exactly:
 *  - no slot at all → indeterminate. NEVER renegotiate on a guess — that is
 *    the duplicate bug this ruling exists to prevent.
 *  - slot's type/payload/recorded_by/device_link_id all match ours, AND
 *    `event.attempts > 0` → already-applied. Our own RETRIED request
 *    landed; drop it.
 *  - anything else (a foreign slot, OR a content-matching slot on an
 *    event's FIRST attempt) → renegotiate, but only if a currentSeq is
 *    actually available; otherwise indeterminate too.
 *
 * Task 10 fix round 3 (B07a, ruling R65/R67) — the `event.attempts > 0` gate
 * is the fix itself. Before it, a content-match ALONE meant "already
 * applied", which is unsound: two DIFFERENT, legitimately identical events
 * from the same device (e.g. a scorer awarding the same entrant the same
 * single point twice in a row) are indistinguishable from a genuine retry by
 * content alone, and the second one landed on a 409 was being silently and
 * permanently dropped — proven live-mechanism by
 * `__tests__/pipeline.test.ts`'s "F2/R63" describe block. `attempts` is
 * exactly "this SAME queued event was sent before, in ANY process", so
 * gating on it says "already-applied" only for an event's own recognized
 * retry, never for a fresh send that merely happens to look like something
 * already on the ledger. A fresh send whose content collides with an
 * existing row now renegotiates at the current seq (or stays indeterminate
 * with no currentSeq) — the SAME fallback an outright-foreign slot already
 * used, so this changes no other branch's behaviour.
 *
 * Task 10 fix round 4 (R68, review finding C1) — the round-3 gate above is
 * unchanged, but round 3 only ever wrote `attempts` to the store AFTER an
 * OBSERVED failure (`sendOne`'s network-error/indeterminate/conflict-again
 * branches). A send whose response is never observed at all — the tab dies
 * mid-flight, `transport.ts` has no client-side timeout — left `attempts` at
 * its PRE-send value forever, so a resend that lands on the server's Redis
 * replay-cache-miss path 409ed against its own already-landed row while
 * this function still read `attempts === 0`: misread as fresh, renegotiated,
 * duplicated. `sendOne` below now persists a marker to the store BEFORE
 * every physical send attempt, not only after a failure — but this function
 * keeps judging the value AS LOADED at the start of the CURRENT send
 * (`sendOne` normalises and hands it in explicitly), never the value that
 * call's own marker just wrote, so a genuinely first-ever send still reads
 * 0 here and still renegotiates (F2 stays fixed) while a resumed send reads
 * whatever an EARLIER call already marked.
 */
export function resolveConflict(
  event: Pick<PendingEvent, "type" | "payload" | "attempts">,
  slot: LedgerSlotEvent | null,
  identity: OwnIdentity,
  currentSeq: number | null,
): ConflictResolution {
  if (slot === null) return { kind: "indeterminate" };
  const isOurs =
    event.attempts > 0 &&
    slot.type === event.type &&
    deepEqual(slot.payload, event.payload) &&
    sameIdentityField(slot.recorded_by, identity.recordedBy) &&
    sameIdentityField(slot.device_link_id, identity.deviceLinkId);
  if (isOurs) return { kind: "already-applied" };
  if (currentSeq === null) return { kind: "indeterminate" };
  return { kind: "renegotiate", expectedSeq: currentSeq };
}

/** Optimistic-vs-server fold comparison — a pure function so it lives here,
 *  not reimplemented per-caller inside a future React hook. Generic over the
 *  module's own State type. */
export function reconcile<State>(optimistic: State, server: State): ReconcileResult<State> {
  return deepEqual(optimistic, server) ? { kind: "match", state: server } : { kind: "diverged", optimistic, server };
}

// ---------------------------------------------------------------------------
// The injection seam. A real adapter (a later pass) wraps `fetch`/`apiV1`
// and translates HTTP/ApiV1Error into this shape; tests hand in a scripted
// double instead, so none of this needs a server.
// ---------------------------------------------------------------------------

export interface AppendEventBody {
  expected_seq: number;
  type: string;
  payload: unknown;
  idempotency_key: string;
}

export type AppendCallResult =
  | { kind: "ok"; data: AppendSuccess }
  /** SEQ_CONFLICT. `currentSeq` is the 409 body's `current_seq` when the
   *  server sent one, else null (http.ts only adds it when the engine error
   *  carried a numeric actualSeq — see the pinned 409 body shape). */
  | { kind: "conflict"; currentSeq: number | null; message: string }
  /** Any other rejection (422-class: INVALID_EVENT, WRONG_PHASE, …) — the
   *  module deterministically refused this payload. Retrying it verbatim
   *  gets the same refusal, so this is permanent, not transient. */
  | { kind: "rejected"; code: string; message: string }
  /** 429. Transient by the server's own definition, so the tap is KEPT — but
   *  it is not a connectivity failure, and telling the scorer they are offline
   *  when the venue wifi is fine sends them to fix the wrong thing. The bucket
   *  is per FIXTURE (`server/usecases/scoring.ts`'s limiter), so a second
   *  device on the same match can cause this without the scorer doing anything
   *  at all.
   *
   *  `retryAfterMs` is the server's own instruction when it sent a usable
   *  `Retry-After` (transport.ts's `retryAfterMsOf`), else null — carried as a
   *  FIELD rather than folded into the message so `throttleBackoffMs` can obey
   *  it instead of guessing. */
  | { kind: "throttled"; message: string; retryAfterMs: number | null }
  /** fetch threw, timed out, or the response was some other non-2xx status
   *  (5xx/408/etc). Treated as transient by design: guessing a status this
   *  transport doesn't specifically recognise is "permanent" risks silently
   *  losing a scorer's action, which is worse than retrying a truly dead
   *  request later. */
  | { kind: "network-error"; message: string };

export interface ScoringTransport {
  appendEvent(fixtureId: string, body: AppendEventBody): Promise<AppendCallResult>;
  /** GET /api/v1/fixtures/{id}/events?since_seq=N — used ONLY to inspect the
   *  ledger slot after a 409. May reject; sendOne treats a rejection the
   *  same as a slot that came back empty: indeterminate. */
  listEventsSince(fixtureId: string, sinceSeq: number): Promise<LedgerSlotEvent[]>;
  /** GET /api/v1/fixtures/{id}/state, narrowed to last_seq — the "fresh
   *  state read" fallback the ruling names when a 409 body carries no
   *  current_seq. May reject; treated the same as "unavailable". */
  getLastSeq(fixtureId: string): Promise<number>;
}

function toRequestBody(
  event: Pick<PendingEvent, "type" | "payload" | "expectedSeq" | "idempotencyKey">,
): AppendEventBody {
  return {
    expected_seq: event.expectedSeq,
    type: event.type,
    payload: event.payload,
    idempotency_key: event.idempotencyKey,
  };
}

/** The new event's seq IF appendEvent accepts it — engine-db/append-event.ts
 *  assigns `expected_seq + 1`, never `expected_seq` itself. That is what
 *  makes "the row at this seq" a complete test of whether OUR write landed. */
function targetSeqFor(expectedSeq: number): number {
  return expectedSeq + 1;
}

async function findLedgerSlot(
  transport: ScoringTransport,
  fixtureId: string,
  expectedSeq: number,
): Promise<LedgerSlotEvent | null> {
  try {
    const rows = await transport.listEventsSince(fixtureId, expectedSeq);
    return rows.find((row) => row.seq === targetSeqFor(expectedSeq)) ?? null;
  } catch {
    return null; // unreadable — resolveConflict treats this like an absent slot
  }
}

async function resolveCurrentSeq(
  transport: ScoringTransport,
  fixtureId: string,
  bodyCurrentSeq: number | null,
): Promise<number | null> {
  if (bodyCurrentSeq !== null) return bodyCurrentSeq;
  try {
    return await transport.getLastSeq(fixtureId);
  } catch {
    return null;
  }
}

/**
 * How many drain passes an event may spend losing a seq race before the pad
 * stops treating it as a race at all.
 *
 * DERIVED, not chosen: `sendOne` permits exactly ONE renegotiation per call,
 * and renegotiation is warranted only when the ledger slot is FOREIGN —
 * another device won the seq. A second pass covers a second foreign writer
 * racing the same slot. Past that, the event is not losing a race; it is being
 * refused for a reason no expected_seq can address, and leaving it at the head
 * blocks every write behind it, silently.
 *
 * Applies to `conflict-again` ONLY. A network failure is never dead-lettered
 * at any count: an offline venue must queue indefinitely, which is the entire
 * purpose of the durable queue. `__tests__/pipeline.test.ts` pins that
 * exemption at BOTH the first send and the resend — the resend case is the one
 * that reaches this branch, so it is the one that can witness its loss.
 *
 * Counted by `PendingEvent.conflictPasses`, NEVER by `attempts`. Two guards,
 * and they are not covering for each other: the `second.kind === "conflict"`
 * test decides whether THIS pass was a race, and `conflictPasses` decides how
 * many races came before it. Reading `attempts` here — a marker incremented on
 * every physical send of every kind — armed the ceiling from dead venue wifi
 * and dead-lettered a scorer's point on its first genuine race.
 */
const CONFLICT_PASS_CEILING = 2;

/**
 * The shortest wait that can possibly clear the limiter — one whole window.
 *
 * DERIVED, not picked. `scoring.ts`'s `SCORING_LIMIT` is a FIXED window
 * (`{ max: 10, windowSeconds: 1 }`), so a retry sooner than one window lands
 * inside the same bucket that just refused it and can only be refused again,
 * spending a request to learn nothing. That module is `@/server/**`, banned
 * from this bundle by the pad's purity gate, so the value is restated here and
 * `__tests__/pipeline.test.ts` pins it against `SCORING_LIMIT`'s own text —
 * the same trick `refusal-copy.ts` uses for `http.ts`'s code map. Move the
 * server's window and that test moves this constant with it.
 */
export const THROTTLE_BASE_MS = 1000;

/**
 * The cap on that wait, as a multiple of the window rather than a second
 * unrelated number. Eight windows is the point past which a pad that looks
 * asleep costs the scorer more than the limiter does — and with a bucket of 10
 * writes per fixture per second, a real backlog drains long before then.
 */
export const THROTTLE_MAX_MS = THROTTLE_BASE_MS * 8;

/**
 * The separate, far more generous ceiling on a wait the SERVER asked for.
 *
 * Two ceilings, because they bound two different things (owner ruling,
 * 2026-09-21): we **guess conservatively and obey generously**. Clamping a
 * server instruction to our own 8-window guess meant overriding it in every
 * case where it disagreed — and a `Retry-After` under a minute is always a
 * more informed number than our exponential, because it comes from whatever
 * actually refused the write.
 *
 * It is still bounded, and the bound is not paranoia. Verified 2026-09-21:
 * NOTHING under `src/server/api-v1` sets `Retry-After`
 * (`__tests__/transport.test.ts`'s own note), so every value this branch can
 * ever receive today comes from an edge, proxy or WAF we do not configure in
 * this repo and cannot fix without an infrastructure change. Honouring such a
 * header without limit would let a number we do not own park a courtside
 * scorer's queue for as long as it likes — silently, behind a "Catching up"
 * chip. That is the same customer-visible wedge this wave exists to close,
 * reached through a different door.
 *
 * One minute is the trade: below it we obey exactly, so the override problem
 * is gone for every realistic instruction (our own bucket's window is ONE
 * second). Above it we spend a single request per minute to find out whether
 * the refusal is still real. One request a minute is cheap; a match scored
 * into a frozen queue is not.
 */
export const THROTTLE_SERVER_MAX_MS = 60_000;

/**
 * How long a throttled entry must wait before touching the limiter again.
 *
 * The server's own `Retry-After` wins when it sent one — it knows its bucket
 * and we do not — bounded by `THROTTLE_SERVER_MAX_MS` rather than by our own
 * guess, so we obey every realistic instruction exactly and still refuse to
 * let an unowned header park a scorer's queue. Otherwise: exponential from
 * one window, doubling per send already made, capped. No jitter, deliberately
 * — a fixed window means every client's wait lands on the same boundary
 * anyway, and threading an injectable random source through `sendOne` to keep
 * this testable would cost more than it buys.
 *
 * `sendsAlreadyMade` is `attempts`, and unlike the conflict ceiling this is a
 * SAFE place to read it: an `attempts` inflated by offline passes can only
 * lengthen a wait, bounded by the cap, and never drops anything.
 */
export function throttleBackoffMs(sendsAlreadyMade: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, THROTTLE_SERVER_MAX_MS);
  const doublings = Math.max(0, sendsAlreadyMade - 1);
  return Math.min(THROTTLE_BASE_MS * 2 ** doublings, THROTTLE_MAX_MS);
}

/**
 * Drive ONE pending event through the transport, applying the full
 * append/replay protocol, and leave the queue in the right state for
 * whatever happens. Never throws — every code path resolves to a
 * `SendOutcome`, so a caller (drainQueue, or eventually a hook) never needs
 * a try/catch around it.
 */
export async function sendOne(
  transport: ScoringTransport,
  store: QueueStore,
  fixtureId: string,
  event: PendingEvent,
  identity: OwnIdentity,
): Promise<SendOutcome> {
  const base = { localId: event.localId, idempotencyKey: event.idempotencyKey };

  // W1 (2026-09-21), spec §4.6 — the pacing gate, BEFORE the pre-send marker
  // and before any transport call: a throttled entry must not feed the limiter
  // it is waiting on. Returning here makes no physical send, so `attempts`
  // deliberately does not move — a backoff that counted its own refusals would
  // ratchet itself to the cap without the server ever saying so again.
  //
  // `stayed-queued` is the honest outcome and it keeps `drainQueue`'s existing
  // break semantics exactly as they are: the head is not sendable yet, and the
  // queue is strictly ordered, so nothing behind it may jump ahead.
  if (event.retryNotBefore !== undefined && Date.now() < event.retryNotBefore) {
    return { kind: "stayed-queued", ...base, reason: "throttled" };
  }

  // The value AS LOADED, at the very start of this call — captured into its
  // own variable BEFORE the pre-send marker write below touches the store,
  // so every use of it in this function (including the `resolveConflict`
  // call after a 409) reflects "how many sends this event has ever had
  // attempted, across every PROCESS, before this one" rather than anything
  // this call itself does. `?? 0` is defensive, not a real migration path:
  // `attempts` has been a required `PendingEvent` field since this
  // chassis's first commit (S10/#419), so no persisted record should ever
  // lack it — but a value that somehow reads `undefined` must still heal to
  // a real number (never `NaN`, which `undefined + 1` would otherwise
  // poison the store with forever) and must still fail on the SAFE side of
  // the gate below: NOT already-sent, same as a genuine attempts:0.
  const attemptsAsLoaded = event.attempts ?? 0;

  // W1 (2026-09-21) — the SEPARATE counter the conflict ceiling reads. Same
  // `?? 0` defensiveness and the same reasoning as `attempts` above, with one
  // extra edge that matters more here: a record persisted before this field
  // existed reads 0, which fails SAFE (more passes allowed, never fewer). An
  // event must never be dropped because its counter was missing.
  const conflictPassesAsLoaded = event.conflictPasses ?? 0;

  // Pre-send marker (Task 10 fix round 4, ruling R68, review finding C1) —
  // persisted to the store BEFORE the network call, unconditionally, on
  // EVERY physical send attempt, not only after an observed failure (which
  // is all round 3 did). This is the fix itself: it durably records "a send
  // of this event was attempted" even if the tab dies mid-flight and no
  // local failure is ever observed — see this file's header and
  // `resolveConflict`'s own doc for the exact gap this closes. Reusing
  // `attempts` (rather than a new field) means an old-shape persisted queue
  // needs no migration: the field, and this exact write path's callers,
  // already existed; only WHEN the first write happens has moved earlier.
  await recordAttempt(store, event.idempotencyKey, { attempts: attemptsAsLoaded + 1 });

  // The ORIGINAL expected_seq and idempotency_key, exactly as persisted —
  // never recomputed here. This is the replay ruling's load-bearing line.
  const first = await transport.appendEvent(fixtureId, toRequestBody(event));

  if (first.kind === "ok") {
    await markAcked(store, event.idempotencyKey);
    return { kind: "acked", ...base, result: first.data };
  }
  if (first.kind === "rejected") {
    await markDropped(store, event.idempotencyKey); // poison: not retried forever…
    return { kind: "rejected", ...base, code: first.code, message: first.message }; // …but surfaced here
  }
  if (first.kind === "throttled") {
    await recordAttempt(store, event.idempotencyKey, {
      attempts: attemptsAsLoaded + 1,
      lastError: first.message,
      retryNotBefore: Date.now() + throttleBackoffMs(attemptsAsLoaded + 1, first.retryAfterMs),
    });
    return { kind: "stayed-queued", ...base, reason: "throttled" };
  }
  if (first.kind === "network-error") {
    await recordAttempt(store, event.idempotencyKey, { attempts: attemptsAsLoaded + 1, lastError: first.message });
    return { kind: "stayed-queued", ...base, reason: "network" };
  }

  // first.kind === "conflict" — inspect the ledger slot before doing anything else.
  const slot = await findLedgerSlot(transport, fixtureId, event.expectedSeq);
  const currentSeq = await resolveCurrentSeq(transport, fixtureId, first.currentSeq);
  // `attemptsAsLoaded`, NEVER the value the marker write above just
  // persisted — see this function's own comment on that variable, and
  // resolveConflict's doc, for why judging the pre-call value is what keeps
  // F2 (a genuinely first-ever send) renegotiating instead of misreading
  // its own just-written marker as proof of a prior attempt.
  const resolution = resolveConflict({ ...event, attempts: attemptsAsLoaded }, slot, identity, currentSeq);

  if (resolution.kind === "already-applied") {
    await markDropped(store, event.idempotencyKey);
    return { kind: "already-applied", ...base };
  }
  if (resolution.kind === "indeterminate") {
    await recordAttempt(store, event.idempotencyKey, {
      attempts: attemptsAsLoaded + 1,
      lastError: "409 conflict: ledger slot unreadable or not yet present",
    });
    return { kind: "stayed-queued", ...base, reason: "indeterminate" };
  }

  // resolution.kind === "renegotiate" — persist FIRST (durable across a
  // second tab death), then resend exactly once.
  await renegotiateExpectedSeq(store, event.idempotencyKey, resolution.expectedSeq);
  const renegotiated = { ...event, expectedSeq: resolution.expectedSeq };
  const second = await transport.appendEvent(fixtureId, toRequestBody(renegotiated));

  if (second.kind === "ok") {
    await markAcked(store, event.idempotencyKey);
    return { kind: "acked", ...base, result: second.data };
  }
  if (second.kind === "rejected") {
    await markDropped(store, event.idempotencyKey);
    return { kind: "rejected", ...base, code: second.code, message: second.message };
  }
  // Conflicting AGAIN after a renegotiation, past the pass ceiling: this
  // event is no longer losing a race, and another pass would only re-block the
  // head. Dead-letter it down the proven drop-and-surface path (the same one a
  // 422 takes) rather than inventing a new outcome kind — `use-pad-pipeline`
  // already removes the optimistic envelope and records the rejection for the
  // UI. Reachable ONLY by a repeat conflict, and only on the strength of
  // earlier repeat conflicts: see CONFLICT_PASS_CEILING for why the counter is
  // `conflictPasses` and not `attempts`.
  if (second.kind === "conflict" && conflictPassesAsLoaded >= CONFLICT_PASS_CEILING) {
    await markDropped(store, event.idempotencyKey);
    return {
      kind: "rejected",
      ...base,
      code: "QUEUE_STALLED",
      message: "conflict again after renegotiation, past the pass ceiling",
    };
  }
  // Another conflict, or a network error, on the resend: stop here for this
  // call — "resent exactly once". The renegotiated expectedSeq is already
  // durably persisted, so the NEXT drain pass retries from there, never from
  // the stale original.
  await recordAttempt(store, event.idempotencyKey, {
    attempts: attemptsAsLoaded + 1,
    lastError: second.kind === "conflict" ? "conflict again after renegotiation" : second.message,
    // The ONLY place this counter moves: a renegotiated resend that conflicted
    // again is, by definition, one whole pass spent losing a seq race.
    ...(second.kind === "conflict" ? { conflictPasses: conflictPassesAsLoaded + 1 } : {}),
    // A 429 on the RESEND is paced exactly like one on the first send — the
    // limiter does not care which of the two calls reached it.
    ...(second.kind === "throttled"
      ? { retryNotBefore: Date.now() + throttleBackoffMs(attemptsAsLoaded + 1, second.retryAfterMs) }
      : {}),
  });
  // Named per KIND, never defaulted: a throttled resend relabelled "network"
  // is the same lie as a throttled first send, one branch deeper.
  const reason = second.kind === "conflict" ? "conflict-again" : second.kind === "throttled" ? "throttled" : "network";
  return { kind: "stayed-queued", ...base, reason };
}

export interface DrainReport {
  outcomes: SendOutcome[];
  /** True when the drain stopped before reaching the end of the queue
   *  because the front event stayed queued (network failure or an
   *  indeterminate 409) — the rest of the queue is untouched, in order,
   *  waiting for the next drain call. */
  stoppedEarly: boolean;
}

/**
 * Drain the queue strictly in order. Each event's `expectedSeq` was computed
 * assuming every event ahead of it already landed, so sending them out of
 * order (or concurrently) would misfire — this awaits one fully-resolved
 * outcome (acked, already-applied, or permanently rejected) before starting
 * the next, and stops the moment an event stays queued, leaving the rest of
 * the queue exactly where it was for a later call (reconnect, a timer, …).
 */
export async function drainQueue(
  transport: ScoringTransport,
  store: QueueStore,
  fixtureId: string,
  identity: OwnIdentity,
): Promise<DrainReport> {
  const outcomes: SendOutcome[] = [];
  for (const pending of await peekInOrder(store)) {
    const outcome = await sendOne(transport, store, fixtureId, pending, identity);
    outcomes.push(outcome);
    if (outcome.kind === "stayed-queued") {
      return { outcomes, stoppedEarly: true };
    }
  }
  return { outcomes, stoppedEarly: false };
}
