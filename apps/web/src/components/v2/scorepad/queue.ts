// Pure ordering/idempotency operations over a QueueStore. No network — the
// append/replay protocol that actually talks to a transport lives in
// pipeline.ts and calls these primitives, never the store directly.
//
// ScoringPad v3 R1 chassis soft-commit (spec §2.3, task 4, below the
// "queueStatus" section): the ONE exception to "no side effects beyond the
// store" in this file — enqueueHeld/releaseHeld/flushHeldBefore each arm or
// fire a plain `setTimeout`-based "release tick", never a transport call.
// OPT-IN ONLY, per the R1 ruling: the held path is entered SOLELY via
// enqueueHeld; `enqueue()` above is completely untouched by this section —
// it never reads or sets `heldUntil`, so its behaviour is byte-for-byte
// identical to before this section existed. No production caller invokes
// enqueueHeld this wave (all 11 sports still score through the plain
// `enqueue()` path) — these are dormant, store-level primitives a later
// task's Dock/Undo UI wires up, supplying its own `onDue` (in practice
// `() => void runDrain()`, use-pad-pipeline.ts) as the moment to actually
// drain. use-pad-pipeline.ts's own `runDrain` loop separately skips any
// entry whose `heldUntil` is still in the future — see its own comment.
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

// ---------------------------------------------------------------------------
// R1 chassis soft-commit (spec §2.3, task 4). See the file header for the
// scope ruling. `heldUntil` itself lives on PendingEvent (types.ts) — a
// plain, durable, JSON-serialisable field, so queue-store.ts needed no code
// change for it to survive a reload (put()/list() already persist whatever
// fields the event carries).
//
// The one thing that does NOT survive a reload is `onDue` — a live JS
// closure, same as any setTimeout handle — so it is kept OUT of the durable
// record entirely, in this small in-memory-only registry instead, scoped
// per QueueStore instance (a WeakMap so two unrelated stores, e.g. two
// mounted pads, can never cross-fire each other's ticks even in theory).
// Re-arming a tick for a held entry that survives a REAL reload (browser
// tab death, not this module's own reload-durability test) is out of this
// task's scope — see the header note on why nothing calls enqueueHeld yet.
// ---------------------------------------------------------------------------

/** The soft-commit hold window's SHIPPED value — a CHASSIS constant, not
 *  per-sport config (R1 ruling), which is why owner rulings move it for EVERY
 *  sport rather than for the two that raised it.
 *
 *  6000 -> 12000 (owner-ruled 2026-08-31, R6 W-4) — roster scan on a phone.
 *  12000 -> 5000 (owner-ruled 2026-09-13) — the stream overlay was a full
 *  soft-commit behind every six / goal / card; five seconds still covers a
 *  one-name pick, and taps with nothing to enrich skip the hold entirely
 *  (null / empty dock: period advance, plain cricket ball, etc.). The dock
 *  blocks nothing while it is open.
 *  5000 -> 10000 (PR #782 review, 2026-09-14) — the 5s cut landed under the
 *  6s the 12s ruling itself said was too short to read eleven names on a
 *  phone, for exactly the attribution case that ruling protected. 10s keeps
 *  the overlay-latency headroom the 5s cut was chasing while staying above
 *  that floor. e2e/walkthrough specs are unaffected: they always run under
 *  `NEXT_PUBLIC_SCOREPAD_HOLD_MS` (CI pins it to 3000), never this default.
 *
 *  This is the DEFAULT, and the floor test in soft-commit.test.ts pins THIS
 *  symbol rather than `HOLD_MS` — see `resolveHoldMs` immediately below for
 *  why that distinction is the whole point. */
export const HOLD_MS_DEFAULT = 10_000;

/** The env override's name, exported so a test names the same string the
 *  build-time substitution below does rather than a copy of it. */
export const HOLD_MS_ENV_VAR = "NEXT_PUBLIC_SCOREPAD_HOLD_MS";

/** Parse an override, falling back to `HOLD_MS_DEFAULT` for anything that is
 *  not a usable window.
 *
 *  Pure and exported for its own tests: `HOLD_MS` below is fixed at module
 *  eval, and in a client bundle the env read is substituted at BUILD time, so
 *  the resolved constant is the only thing a test could otherwise observe —
 *  and a test that can only see the resolved value cannot tell a rejected
 *  override from an absent one.
 *
 *  Rejects, in order: absent/blank, non-finite, and anything below
 *  `MIN_HOLD_MS`. The floor is not a style rule — a window shorter than a tap
 *  round-trip closes before the dock has finished animating in, so the
 *  attribution UI would flash and vanish rather than be usable. A too-LARGE
 *  value is deliberately NOT rejected: a long window is a product choice
 *  (someone scoring a sport with a 30-name squad), never a broken one. */
const MIN_HOLD_MS = 500;
export function resolveHoldMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return HOLD_MS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_HOLD_MS) return HOLD_MS_DEFAULT;
  return parsed;
}

/** The window this build actually holds for.
 *
 *  Equal to `HOLD_MS_DEFAULT` in every shipped build; overridable ONLY through
 *  the env var above, which exists so e2e can run the same production bundle
 *  at a shorter window. The walkthrough specs tap a whole match — sixteen taps
 *  for badminton — and each tap waits out a full window before the ledger can
 *  be polled, so the shipped 10s puts those specs way past their 180s budget.
 *
 *  Written as a full `process.env.NEXT_PUBLIC_...` member expression on
 *  purpose: Next substitutes that TEXT at build time, so a dynamic read
 *  (`process.env[HOLD_MS_ENV_VAR]`) would compile to `undefined` in the client
 *  bundle and silently always take the default — the exact "green because it
 *  never ran" shape this knob exists inside of. On the Node side (the
 *  Playwright runner, which imports this module directly to derive its own
 *  waits) the same expression is a real env read, so one variable set at job
 *  level governs both the bundle and the specs that measure it. */
export const HOLD_MS = resolveHoldMs(process.env.NEXT_PUBLIC_SCOREPAD_HOLD_MS);

interface HeldTick {
  timer: ReturnType<typeof setTimeout>;
  onDue: () => void;
}

const ticksByStore = new WeakMap<QueueStore, Map<string, HeldTick>>();

function ticksFor(store: QueueStore): Map<string, HeldTick> {
  let map = ticksByStore.get(store);
  if (map === undefined) {
    map = new Map();
    ticksByStore.set(store, map);
  }
  return map;
}

/** Cancel and forget id's tick, if it has one — the shared guard against a
 *  natural release tick ALSO firing after an early releaseHeld/dropHeld/
 *  flushHeldBefore already resolved the same entry. */
function cancelTick(store: QueueStore, id: string): HeldTick | undefined {
  const map = ticksFor(store);
  const tick = map.get(id);
  if (tick !== undefined) {
    clearTimeout(tick.timer);
    map.delete(id);
  }
  return tick;
}

/** Clear `heldUntil` on a still-held entry (the actual "release" — the
 *  entry becomes an ordinary queued event, sendable on the next real drain
 *  pass). Returns false, a no-op, if `id` names no CURRENTLY held entry —
 *  already released/dropped/never held. Shared by enqueueHeld's own tick,
 *  releaseHeld, and flushHeldBefore, so "what counts as released" is
 *  defined in exactly one place. */
async function clearHeldFlag(store: QueueStore, id: string): Promise<boolean> {
  const found = (await store.list()).find((e) => e.idempotencyKey === id);
  if (found === undefined || found.heldUntil === undefined) return false;
  const { heldUntil, ...released } = found;
  void heldUntil;
  await store.put(released);
  return true;
}

/** Enqueue exactly like `enqueue()` above — same durable put, same
 *  immediate visibility to `peekInOrder`/a caller's optimistic fold — but
 *  stamps `heldUntil` `holdMs` out and arms a release tick that fires
 *  `onDue` once the window closes on its own. A new held tap always
 *  flushes whatever was held before it FIRST (`flushHeldBefore`), so at
 *  most one entry is ever held at a time — "a new tap releases the prior
 *  held event", the flushed entry's OWN `onDue` fires as part of that,
 *  synchronously within this call. Returns the id every other `*Held`
 *  function below takes: `event.idempotencyKey`, the same identity a
 *  caller already assigns before calling this (mirrors `enqueue`'s own
 *  contract — nothing here generates a fresh id). */
export async function enqueueHeld(
  store: QueueStore,
  event: PendingEvent,
  holdMs: number,
  onDue: () => void,
): Promise<string> {
  const now = Date.now();
  await flushHeldBefore(store, now);
  await store.put({ ...event, heldUntil: now + holdMs });
  const timer = setTimeout(() => {
    ticksFor(store).delete(event.idempotencyKey);
    void clearHeldFlag(store, event.idempotencyKey).then((cleared) => {
      if (cleared) onDue();
    });
  }, holdMs);
  ticksFor(store).set(event.idempotencyKey, { timer, onDue });
  return event.idempotencyKey;
}

/** Apply `fn` to a STILL-HELD entry in place — e.g. a future Dock UI
 *  letting a scorer correct a tap before it ever sends. Returns false, a
 *  no-op, if `id` names no currently-held entry (already released, dropped,
 *  or never held) — mutating it then would silently vanish. `fn` should
 *  change `type`/`payload` only: this does not re-arm or extend the
 *  release tick, so a `fn` that itself clears `heldUntil` bypasses the
 *  `onDue` notification entirely (use `releaseHeld` to change the
 *  lifecycle, `mutateHeld` only to correct what will be sent).
 *  TODO(task 4 fix round 1, Minor 2 — R2+ Dock): if a `fn` ever needs to
 *  touch `heldUntil` itself, route through `releaseHeld` first instead —
 *  today that silently drops the `onDue` call, not merely a stale value. */
export async function mutateHeld(
  store: QueueStore,
  id: string,
  fn: (event: PendingEvent) => PendingEvent,
): Promise<boolean> {
  const found = (await store.list()).find((e) => e.idempotencyKey === id);
  if (found === undefined || found.heldUntil === undefined) return false;
  await store.put(fn(found));
  return true;
}

/** Release a held entry's window immediately — "send now": cancels its
 *  timer (so the natural tick can never ALSO fire later) and, if it was
 *  genuinely still held, clears `heldUntil` and calls the SAME `onDue`
 *  `enqueueHeld` was given, exactly once either way (natural tick XOR this).
 *  A no-op if `id` names no currently-held entry. */
export async function releaseHeld(store: QueueStore, id: string): Promise<void> {
  const tick = cancelTick(store, id);
  const cleared = await clearHeldFlag(store, id);
  if (cleared) tick?.onDue();
}

/** Undo a still-held tap: remove it entirely, before it was ever sent — no
 *  `core.void` (there is nothing on the server to void; the event never
 *  left this device). Cancels the release tick first, so a natural timeout
 *  can never fire against an entry that no longer exists. Returns false,
 *  a no-op, if `id` names no currently-held entry. */
/**
 * R8/#675 — every entry whose life is bound to `id`'s (`PendingEvent.dropWith`).
 *
 * THE ONE definition of that rule, deliberately. It has two consumers that must
 * never disagree: `dropHeld` below, which removes them from the durable QUEUE,
 * and `use-pad-pipeline`'s `dropHeldSubmission`, which must remove the same set
 * from the in-memory `pendingEnvelopes` mirror. Cancelling in one layer only is
 * not a partial fix but a NEW defect — the queue goes clean while the optimistic
 * fold still applies the void, so the pad shows a corrected event as retired
 * with nothing replacing it. Found in a browser: the ledger read clean and the
 * serve context stayed refused.
 *
 * Takes a snapshot rather than the store so both callers can read the entries
 * BEFORE the deletes, and so this stays pure.
 */
export function boundTo(all: readonly PendingEvent[], id: string): string[] {
  return all.filter((e) => e.dropWith === id).map((e) => e.idempotencyKey);
}

export async function dropHeld(store: QueueStore, id: string): Promise<boolean> {
  const all = await store.list();
  const found = all.find((e) => e.idempotencyKey === id);
  if (found === undefined || found.heldUntil === undefined) return false;
  cancelTick(store, id);
  await store.delete(id);
  // R8/#675 — CASCADE. An entry whose `dropWith` names this one exists only to
  // follow it (`PendingEvent.dropWith` carries the full reasoning): an
  // amendment queues a `core.void` of the original behind the held re-append,
  // and if the re-append is taken back the void must go with it or it drains
  // ALONE and deletes a scored event the scorer never asked to lose.
  //
  // This line is the CANCELLABLE half of that binding; the durable half is that
  // `dropWith` is a persisted field rather than a live callback, so a reload
  // resumes both entries instead of losing the follower. Both halves are
  // required and neither substitutes for the other — see `dropWith`'s own doc
  // for the two one-sided designs this replaced.
  //
  // Read from the SAME `list()` snapshot taken above, so a follower enqueued
  // concurrently cannot be missed by a second read racing the delete.
  for (const boundId of boundTo(all, id)) {
    cancelTick(store, boundId);
    await store.delete(boundId);
  }
  return true;
}

/** A new tap releases whatever was held before it, unconditionally —
 *  called automatically by enqueueHeld (so callers get this for free), and
 *  exposed so a caller can flush without immediately enqueueing a new held
 *  event too. `nextTapAt` is accepted for the caller's own explicit-time
 *  purity (mirrors resolveConflict/reconcile's style elsewhere in this
 *  tree: take "now" as a parameter rather than reading the clock
 *  ambiently) — every currently-held entry is released regardless of how
 *  much of its own window remains, since a new tap always wins; there is
 *  nothing in the comparison for this timestamp to gate. */
export async function flushHeldBefore(store: QueueStore, nextTapAt: number): Promise<void> {
  void nextTapAt;
  const held = (await store.list()).filter((e) => e.heldUntil !== undefined);
  for (const entry of held) {
    const tick = cancelTick(store, entry.idempotencyKey);
    const cleared = await clearHeldFlag(store, entry.idempotencyKey);
    if (cleared) tick?.onDue();
  }
}
