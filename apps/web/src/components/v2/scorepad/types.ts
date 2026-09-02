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
  /** S12/#421 pass H — for a `core.void` ONLY: the target's seq, as resolved
   *  from `ledgerEvents` at the moment this void was submitted (see
   *  use-pad-pipeline.ts `voidTargetSeqAtSubmit`). Durable so a still-queued
   *  void's target can be translated from its real client-fabricated id to
   *  the server's row id from this record ALONE, independent of
   *  `ownEventIds` (in-memory, reset empty on every fresh mount — the exact
   *  state a reload discards before a queued void gets a chance to drain).
   *  Absent for every non-void event, for a void whose target was not yet
   *  acked at submit time (falls back to the pre-existing ownEventIds/FIFO
   *  resolution instead — see use-pad-pipeline.ts `resolveVoidTargetId`),
   *  and for any record persisted by a build predating this field — reading
   *  it as `undefined` must never throw, only degrade to that older,
   *  same-mount-only behaviour. */
  voidTargetSeq?: number;
  /** ScoringPad v3 R1 chassis soft-commit (spec §2.3, task 4) — epoch-ms
   *  deadline before which this entry, though already durably enqueued and
   *  already folded into the optimistic state, must NOT be sent. Set only
   *  by queue.ts's `enqueueHeld`; cleared by `releaseHeld`/`flushHeldBefore`/
   *  the natural release tick `enqueueHeld` itself arms — never touched by
   *  `enqueue()`. Absent for every event enqueued through the plain
   *  `enqueue()` path (today's exact behaviour, byte for byte unchanged)
   *  and for any record persisted by a build predating this field. An
   *  ABSOLUTE deadline, not a relative duration, so "remaining window" is
   *  automatically correct after a reload: queue-store.ts needed no code
   *  change for this field to survive one — put()/list() already persist
   *  whatever fields PendingEvent carries, generically. */
  heldUntil?: number;
  /**
   * R8/#675 — this entry's LIFE IS BOUND TO another still-held entry's:
   * `dropWith` names that entry's `idempotencyKey`, and `queue.ts`'s
   * `dropHeld` cascade-deletes every entry carrying its id.
   *
   * The one user of it today is an amendment (`v3/pad-host.tsx`'s `runAmend`),
   * which is a `core.void` of the original event plus a re-append of it
   * carrying the detail the hold window cut short. Those two must live or die
   * together, and the two obvious ways to arrange that each fail in exactly one
   * direction — both were shipped and both were caught in review:
   *
   *  - enqueue the void as an ordinary SIBLING: durable across a reload, but
   *    nothing can cancel it, so a take-back inside the hold window drops the
   *    replacement and strands the void, which then drains alone and DELETES a
   *    scored event;
   *  - fire the void from the held entry's release CLOSURE: cancellable,
   *    because a drop never calls it — but `ticksByStore` (queue.ts) is an
   *    in-memory WeakMap keyed on the store OBJECT, so a reload mid-hold
   *    resumes the replacement, sends it, and NEVER sends the void, DOUBLING
   *    the point.
   *
   * A durable FIELD is the only shape that is both, and it is both for a reason
   * worth stating: it is written to IndexedDB alongside the entry it binds (so
   * a reload resumes both, in order), and it is a value `dropHeld` can read
   * without any live callback (so a cancel reaches it). Absent on every other
   * entry, and on any record persisted by a build predating this field —
   * reading it as `undefined` must degrade to "not bound to anything", never
   * throw.
   */
  dropWith?: string;
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
 * server/usecases/fixtures.ts:182-192 `EventOut`), narrowed to the fields
 * the replay ruling compares PLUS (S12/#421) the two fields that let a row
 * be widened into a foldable `EventEnvelope`: use-fixture-stream.ts's
 * poll/realtime path hands rows straight to this same type, and
 * use-pad-pipeline.ts now merges them into its own ledger (previously it
 * discarded them outright — the root cause of a foreign `core.start` never
 * reaching the pad's own optimistic fold).
 *
 * `id`/`recorded_at` are OPTIONAL here, deliberately, even though
 * score_events.id/.recorded_at are both NOT NULL columns (db/migration/
 * v2-engine/tables/V216__score_events.sql) and transport.ts's
 * `ledgerSlotEventSchema` always requires and populates them from a real
 * server response. Making them required on this TYPE would also force
 * every hand-rolled `LedgerSlotEvent` test double across the tree — several
 * pre-date this addition and only ever exercised the 409-slot path above,
 * which never needed either field — to grow two throwaway values for zero
 * behavioural gain in those suites. use-pad-pipeline.ts's own
 * `ledgerSlotToEnvelope` treats an ABSENT id/recorded_at as "cannot fold
 * this row" and skips it (falling back to its pre-existing
 * reconcile-and-override behaviour), the same non-guessing posture
 * `recorded_by`/`device_link_id` below already keep at the wire boundary.
 */
export interface LedgerSlotEvent {
  /** score_events.id (uuid primary key) — see the class doc above for why
   *  this is optional on the TYPE despite never being null on a real row. */
  id?: string;
  seq: number;
  type: string;
  payload: unknown;
  /** score_events.recorded_at (timestamptz not null default now()) — same
   *  optionality reasoning as `id` above. */
  recorded_at?: string;
  recorded_by: string | null;
  device_link_id: string | null;
  /** score_events.voids_event_id — the row this event undoes, non-null ONLY
   *  on a core.void. R5: carried through the poll/realtime path so a void
   *  THIS device did not submit still names its target. Before that this
   *  field was parsed at the transport boundary and thrown away, and every
   *  foreign undo (a second referee's, or the fixture console's) reached
   *  use-pad-pipeline.ts as a `core.void` targeting nothing — the engine's
   *  `resolveVoids` then rejected every fold from that seq onward. Optional
   *  on the TYPE for the same compile-time reason as `id`/`recorded_at`
   *  above: the hand-rolled doubles across this tree predate it. */
  voids_event_id?: string | null;
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
