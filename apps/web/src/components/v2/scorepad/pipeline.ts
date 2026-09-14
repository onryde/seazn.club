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
 * `__tests__/pipeline.test.ts`'s "F2/R63" describe block. `attempts` (already
 * persisted on every `PendingEvent`, incremented only by `recordAttempt` on a
 * network-error or indeterminate 409 — see `sendOne` below) is exactly "this
 * SAME queued event was sent before with an UNKNOWN outcome", so gating on it
 * says "already-applied" only for an event's own recognized retry, never for
 * a fresh send that merely happens to look like something already on the
 * ledger. A fresh send whose content collides with an existing row now
 * renegotiates at the current seq (or stays indeterminate with no currentSeq)
 * — the SAME fallback an outright-foreign slot already used, so this changes
 * no other branch's behaviour.
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
  /** fetch threw, timed out, or the response was some other non-2xx status
   *  (5xx/429/etc). Treated as transient by design: guessing a status this
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
  if (first.kind === "network-error") {
    await recordAttempt(store, event.idempotencyKey, { attempts: event.attempts + 1, lastError: first.message });
    return { kind: "stayed-queued", ...base, reason: "network" };
  }

  // first.kind === "conflict" — inspect the ledger slot before doing anything else.
  const slot = await findLedgerSlot(transport, fixtureId, event.expectedSeq);
  const currentSeq = await resolveCurrentSeq(transport, fixtureId, first.currentSeq);
  const resolution = resolveConflict(event, slot, identity, currentSeq);

  if (resolution.kind === "already-applied") {
    await markDropped(store, event.idempotencyKey);
    return { kind: "already-applied", ...base };
  }
  if (resolution.kind === "indeterminate") {
    await recordAttempt(store, event.idempotencyKey, {
      attempts: event.attempts + 1,
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
  // Another conflict, or a network error, on the resend: stop here for this
  // call — "resent exactly once". The renegotiated expectedSeq is already
  // durably persisted, so the NEXT drain pass retries from there, never from
  // the stale original.
  await recordAttempt(store, event.idempotencyKey, {
    attempts: event.attempts + 1,
    lastError: second.kind === "conflict" ? "conflict again after renegotiation" : second.message,
  });
  return { kind: "stayed-queued", ...base, reason: second.kind === "conflict" ? "conflict-again" : "network" };
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
