// Pure ordering/idempotency operations over a QueueStore. No network — the
// append/replay protocol that actually talks to a transport lives in
// pipeline.ts and calls these primitives, never the store directly.
import type { PendingEvent, ConnectionStatus, QueueStatus } from "./types";
import type { QueueStore } from "./queue-store";

/** Add a pending event. Idempotent on `idempotencyKey`: enqueuing the same
 *  key twice (e.g. re-enqueuing a recovered pending event on resume) replaces
 *  rather than duplicates, per QueueStore.put's contract. */
export async function enqueue(store: QueueStore, event: PendingEvent): Promise<void> {
  await store.put(event);
}

/** Every still-pending event, oldest first — the order pipeline.ts's drain
 *  must process in. */
export async function peekInOrder(store: QueueStore): Promise<PendingEvent[]> {
  return store.list();
}

/** The event was successfully appended — remove it, nothing more to send. */
export async function markAcked(store: QueueStore, idempotencyKey: string): Promise<void> {
  await store.delete(idempotencyKey);
}

/** The event is resolved WITHOUT a fresh append landing — either the ledger
 *  already held it (a 409 "already applied" verdict) or it was permanently
 *  rejected (422: poison, must not be retried forever). Same store effect as
 *  markAcked; kept as a separate name so a caller reading pipeline.ts can
 *  tell "delivered" from "resolved without delivering" at the call site. */
export async function markDropped(store: QueueStore, idempotencyKey: string): Promise<void> {
  await store.delete(idempotencyKey);
}

/** How many events are still queued. */
export async function depth(store: QueueStore): Promise<number> {
  return (await store.list()).length;
}

async function patch(
  store: QueueStore,
  idempotencyKey: string,
  fn: (event: PendingEvent) => PendingEvent,
): Promise<void> {
  const found = (await store.list()).find((e) => e.idempotencyKey === idempotencyKey);
  if (!found) return; // already resolved/removed elsewhere — nothing to update
  await store.put(fn(found));
}

/** Record a failed send attempt (network failure, or a 409 whose ledger slot
 *  came back unreadable/absent) — the event STAYS queued, `attempts` and
 *  `lastError` update in place. Needed because `PendingEvent.attempts` /
 *  `lastError` are part of the chassis contract (types.ts) and QueueStore
 *  only exposes put-as-replace, not a partial update. */
export async function recordAttempt(
  store: QueueStore,
  idempotencyKey: string,
  fields: { attempts: number; lastError?: string },
): Promise<void> {
  await patch(store, idempotencyKey, (event) => ({ ...event, ...fields }));
}

/** Persist a renegotiated expected_seq for a still-queued event — the ONLY
 *  legitimate way expectedSeq changes after enqueue, per the S10 replay
 *  ruling: only once a 409's ledger slot proves FOREIGN, never speculatively.
 *  Must be durable (not just an in-memory variable in pipeline.ts): if the
 *  tab dies again between renegotiating and the resend's ack, the NEXT
 *  replay must resend the renegotiated value, not the original one, or it
 *  loops on the same foreign slot forever. */
export async function renegotiateExpectedSeq(
  store: QueueStore,
  idempotencyKey: string,
  expectedSeq: number,
): Promise<void> {
  await patch(store, idempotencyKey, (event) => ({ ...event, expectedSeq }));
}

/** Derive an at-a-glance queue state for a future UI's "queue depth" /
 *  "offline — keep scoring" affordance (S10 scope item 2). `blocked` means
 *  the event at the front of the queue could not be resolved on the last
 *  drain pass (network failure, or an indeterminate 409) — see pipeline.ts
 *  `drainQueue`'s `stoppedEarly`. */
export function queueStatus(params: {
  depth: number;
  connection: ConnectionStatus;
  blocked: boolean;
}): QueueStatus {
  if (params.connection === "offline") return "offline";
  if (params.depth === 0) return "empty";
  if (params.blocked) return "blocked";
  return "pending";
}
