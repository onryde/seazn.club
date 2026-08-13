// Chassis-wide data types for the v2 scoring pad (S10/#419 W8, headless pass).
// Pure data — no functions, no React, no fetch. Deliberately NOT reusing
// fixture-console.tsx's LiveState/EventIn ("use client" component file):
// those mirror the same wire shapes but this tree must stay importable from
// a plain Node/test context with zero React in the graph. Shapes below are
// pinned against server/api-v1/schemas.ts, server/usecases/scoring.ts and
// server/usecases/fixtures.ts (see module-client.ts / pipeline.ts headers
// for the exact line refs measured on main @ ae22e299).

/**
 * One event queued for append, durable across tab death (queue-store.ts).
 * `idempotencyKey` and `expectedSeq` are captured ONCE at enqueue time and
 * must never be silently regenerated on replay — the S10 replay ruling: a
 * tab-death resend reuses the exact same idempotency_key and expected_seq
 * until the ledger itself proves expected_seq wrong (see pipeline.ts
 * `resolveConflict`). `expectedSeq` DOES change, but only via the explicit,
 * ledger-slot-proven renegotiation path (queue.ts `renegotiateExpectedSeq`)
 * — never recomputed speculatively.
 */
export interface PendingEvent {
  /** Client-generated identity for this queue slot — a stable handle for a
   *  future UI's list rendering. Distinct from `idempotencyKey`: this is
   *  local-only bookkeeping, never sent over the wire. */
  localId: string;
  /** Sent as AppendEventRequest.idempotency_key (schemas.ts:624-630). Never
   *  regenerated once the event is enqueued. */
  idempotencyKey: string;
  /** Envelope type string, e.g. "cricket.ball", "core.void". */
  type: string;
  payload: unknown;
  /** AppendEventRequest.expected_seq for THIS event. Replay must resend this
   *  exact value verbatim until a proven-foreign ledger slot renegotiates it. */
  expectedSeq: number;
  /** ISO instant this event was enqueued. */
  createdAt: string;
  /** Send attempts so far, including the original. */
  attempts: number;
  /** The most recent send failure, if any (network failure, or a 409 whose
   *  ledger slot could not be read/resolved). Absent once a send attempt has
   *  not yet failed. */
  lastError?: string;
}

/** Network reachability as the pipeline understands it. The pipeline still
 *  accepts new enqueues while offline — it just cannot drain. */
export type ConnectionStatus = "online" | "offline";

/** Derived, at-a-glance queue state for a future UI's "queue depth" /
 *  "offline — keep scoring" affordance (S10 scope item 2). Computed by
 *  `queue.ts` `queueStatus()`. */
export type QueueStatus = "empty" | "pending" | "blocked" | "offline";

/**
 * Whoever is about to append. Needed to tell "my event landed" from "a
 * foreign event took this slot" when inspecting the ledger on a 409:
 * `recorded_by` / `device_link_id` are stamped SERVER-side from the auth
 * context (scoring.ts:99-106), never sent by the client in the request body,
 * so the caller must hand the pipeline its own identity to compare the
 * fetched ledger row against.
 */
export interface OwnIdentity {
  recordedBy: string | null;
  deviceLinkId: string | null;
}

/**
 * One row of the ledger read back for 409 slot-inspection
 * (`GET /api/v1/fixtures/{id}/events?since_seq=N` —
 * server/usecases/fixtures.ts:182-192 `EventOut`), narrowed to exactly the
 * fields the replay ruling compares.
 */
export interface LedgerSlotEvent {
  seq: number;
  type: string;
  payload: unknown;
  recorded_by: string | null;
  device_link_id: string | null;
}

/** AppendEventResponse / ScoreOutcome (schemas.ts:644-648,
 *  server/usecases/scoring.ts `ScoreOutcome`) — the 201 success body. */
export interface AppendSuccess {
  seq: number;
  state_summary: unknown;
  outcome: unknown;
  status: string;
}

// ---------------------------------------------------------------------------
// Pipeline outcome unions — what one append/replay decision returns
// (pipeline.ts owns the functions; the shapes live here per the chassis
// contract: "types.ts — the outcome unions the pipeline returns").
// ---------------------------------------------------------------------------

/** The pure 409 ledger-slot verdict (pipeline.ts `resolveConflict`). */
export type ConflictResolution =
  | { kind: "already-applied" }
  | { kind: "renegotiate"; expectedSeq: number }
  | { kind: "indeterminate" };

/**
 * What happened to one queued event after pipeline.ts drove it through the
 * transport. Every branch of the append/replay protocol gets its own case —
 * a caller exhaustively switching on `kind` cannot forget the `rejected`
 * branch, which is what makes a 422 "surfaced, not silently dropped" a
 * type-level property rather than a documentation promise.
 */
export type SendOutcome =
  | { kind: "acked"; localId: string; idempotencyKey: string; result: AppendSuccess }
  | { kind: "already-applied"; localId: string; idempotencyKey: string }
  | { kind: "rejected"; localId: string; idempotencyKey: string; code: string; message: string }
  | {
      kind: "stayed-queued";
      localId: string;
      idempotencyKey: string;
      reason: "network" | "indeterminate" | "conflict-again";
    };

/** `reconcile()`'s verdict (pipeline.ts). Generic over the module's own
 *  State type so this stays engine-agnostic — no sport-specific shape here. */
export type ReconcileResult<State> =
  | { kind: "match"; state: State }
  | { kind: "diverged"; optimistic: State; server: State };
