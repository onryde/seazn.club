"use client";
// The pad's live pipeline (S10/#419 W8, network-wiring pass): submit an
// action -> optimistic local fold (the module's own fold, via
// module-client.ts) -> durable enqueue (queue.ts/queue-store.ts) -> drain in
// order (pipeline.ts's sendOne — the append/replay protocol) -> reconcile
// the optimistic fold against the server's own fold on every ack.
//
// Reconciliation needs `transport.fetchState` (transport.ts's PadTransport,
// NOT ScoringTransport's own `getLastSeq`) because the POST ack
// (`AppendSuccess.state_summary`) is a `SportModule.summary()` projection,
// not the raw fold State — see transport.ts's header comment for the full
// reasoning.
//
// Drains via pipeline.ts's `sendOne()` in a hand-rolled loop rather than its
// `drainQueue()` convenience wrapper: `drainQueue` only returns once the
// whole queue has settled, which would make queue depth invisible mid-drain
// — this hook needs the scorer to see it shrink event by event (S10 brief
// acceptance: "assert it is non-zero mid-drain, not merely zero at the
// end"), so it calls the SAME `sendOne()` `drainQueue` itself calls, one
// event at a time, updating React state after each.
//
// SCOPE BOUNDARY, S12/#421 UPDATE: this used to read "a real concurrent-
// write divergence displays the server's state correctly but this hook's
// bookkeeping only re-syncs fully on the next mount" — true through S10/S11,
// false now for the traced defect that motivated this pass. The console
// chrome's own "Start match" button is a FOREIGN write from this pad's point
// of view (it lives outside the pad section in both dispatchers), so
// `core.start` landing on the server without ever reaching THIS hook's own
// ledger meant every optimistic fold after it still validated against
// `phase: "pre"` and threw — no sport was scoreable through the v2 console
// once a match started. Root cause was a TYPE: `LedgerSlotEvent` (types.ts)
// could not be widened into a foldable `EventEnvelope` (no `id`/
// `recordedAt`). Now that it can (types.ts, transport.ts), `onStreamEvents`
// below MERGES a poll/realtime batch into `ledgerEvents` by seq — deduped,
// ascending, `pendingEnvelopes` (the offline queue) never touched — and
// reconciles over the MERGED list, so `serverOverride` fires only on a
// GENUINE divergence rather than on this pad simply being behind.
//
// The boundary that remains: `LedgerSlotEvent` still drops
// `voids_event_id` (its own documented scope, transport.ts), so a FOREIGN
// core.void merges as an event `resolveVoids` cannot resolve (it requires
// `.voids`) and the fold throws on every replay from that point on.
// `foldedState` below never lets that escape into render (degrades to the
// last good state plus a surfaced `lastRejection`), but the void's actual
// effect will not display correctly until the next full reconciliation —
// out of this pass's traced scope (core.start/phase-class foreign events),
// not an oversight.
//
// A genuine optimistic-fold-guess-turns-out-wrong divergence (this hook's
// own guess wrong, not a foreign-event gap) still adopts the server's fold
// as-is without reconstructing the exact event list that produced it — nothing
// in this pass changes that half of the original boundary.
//
// SCOPE BOUNDARY, S12/#421 PASS G UPDATE (undo-before-reload — _INDEX.md
// decision log, "the pad's own undo silently does nothing for an event you
// just scored"): pendingToEnvelope (below) stamps `id: pending.idempotencyKey`
// on EVERY envelope this hook builds — pre-ack for the optimistic fold, and
// (pass F) again at ack, forever, since AppendSuccess carries no row id at
// all. So the row timeline.tsx renders for a pad-submitted event always
// carried the client-fabricated idempotencyKey as its `.id`, and
// append-event.ts always assigns a fresh server-random uuid as the REAL row
// id — the two never coincide. handleVoid (pad-renderer.tsx) submits
// `core.void {event_id: <that id>}` verbatim, so the request always named an
// id the server had never seen: `assertUndoTarget` (scoring.ts) 409s "Nothing
// to undo", `transport.ts` maps ANY 409 to a SEQ_CONFLICT-shaped `conflict`,
// and the ledger-slot read that follows finds nothing at that seq (the void
// never landed, so nothing occupies it) — `resolveConflict` calls that
// `indeterminate`, and `runDrain` leaves it `stayed-queued` forever with no
// `lastRejection` ever set. Silent by construction, not by omission.
// Fixed at the ONE seam every core.void send passes through — `runDrain`'s
// loop, just below — by resolving the target's LOCAL id to the server's REAL
// row id (by seq, via a targeted `listEventsSince`) before it is ever handed
// to `sendOne`, whenever the target is one THIS hook itself fabricated
// (`ownEventIds`). A row loaded from `initialEvents`/poll already carries the
// server's real id and needs no translation — see `resolveVoidTargetId`'s own
// doc for the full boundary, including the two ways resolution can fail and
// why they are handled differently (a target this hook has no record of at
// all vs. a read that merely didn't succeed yet).
//
// SCOPE BOUNDARY, S12/#421 PASS E UPDATE: pass C's fix above covers a
// FOREIGN write arriving via the POLL/realtime path. It left a second,
// narrower gap open: `ledgerEvents` seeds from `params.initialEvents` ONLY
// in the `useState` initializer below, which runs exactly once, at mount. A
// fixture that flips scheduled -> live WHILE this hook is already mounted —
// the console chrome's own "Start match" button (still outside the pad
// section in both dispatchers) triggers a `router.refresh()` that hands
// THIS hook a NEW `initialEvents` containing `core.start` — never reaches
// `ledgerEvents` at all, because React reconciles this component instead of
// remounting it. Every optimistic fold after that keeps validating a
// scoring event against a ledger missing `core.start` and throws (cricket:
// `ball in phase "pre"`), which `foldedState` below degrades to
// `lastGoodStateRef.current` — frozen at whatever the LAST successful fold
// was, typically the trivial empty one from mount. The ack path
// (`runDrain`) was never the bug: it already appends its own just-acked
// event onto `ledgerEventsRef.current` correctly — every fold built on it
// just kept lacking `core.start` underneath, so it kept throwing. Measured
// end to end in a real browser: exactly one scoring event could ever be
// recorded, on any sport (`_INDEX.md`'s decision log, "FOURTH defect").
// Fixed the same way as the poll path — merge, never overwrite, through the
// SAME shared primitive (`mergeEnvelopesIntoLedger`, which `mergeLedgerEvents`
// below now also delegates to, rather than two differently-shaped merges
// that can drift) — see the effect below the `useFixtureStream` wiring for
// the adoption itself.
//
// SCOPE BOUNDARY, S12/#421 PASS F UPDATE: the PASS E paragraph above ("The
// ack path (`runDrain`) was never the bug: it already appends its own
// just-acked event onto `ledgerEventsRef.current` correctly") was only true
// relative to THAT pass's own traced defect (the missing core.start) - not a
// general clean bill of health. A later review found the ack append
// independently broken: it built its result with a raw spread
// (`[...ledgerEventsRef.current, pendingToEnvelope(...)]`), never through
// `mergeEnvelopesIntoLedger` like the other two writers into `ledgerEvents`
// (`onStreamEvents`'s poll path, the `initialEvents`-adoption effect just
// below). If this device's own append response resolves AFTER a poll tick or
// an `initialEvents` re-seed has already merged the server's committed row
// for that SAME seq - realistic exactly because this file's comments (and
// scoring.ts's doc 08 par.4) treat flaky courtside wifi as the normal case,
// not an edge case - `ledgerEvents` ended up with TWO entries at one seq,
// permanently, and every fold after it double-counted that action. Fixed in
// `runDrain` below: the ack append now goes through `mergeEnvelopesIntoLedger`
// too, with `incomingWins: true` - the OPPOSITE of the other two callers'
// default. See that call site's own comment for why the precedence has to
// flip for this one caller (an `id`/`voids` argument, not an arbitrary
// choice).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EngineError, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { foldClient } from "./module-client";
import { indexedDbQueueStore } from "./queue-store";
import { depth, enqueue, markDropped, peekInOrder, recordAttempt } from "./queue";
import { deepEqual, reconcile, sendOne } from "./pipeline";
import type { LedgerSlotEvent, OwnIdentity, PendingEvent } from "./types";
import type { PadAuthMode, PadTransport } from "./transport";
import { useFixtureStream, type RealtimeConnector } from "./use-fixture-stream";

// Review finding 2: submit() minted a fresh idempotency key/expected_seq on
// EVERY call with no guard at all, so a courtside double-tap (or two bound
// handlers firing for one physical press) enqueued two genuinely distinct
// score events. A courtside double-tap lands well under a second; two
// GENUINELY separate identical actions (e.g. two dot balls in a row) are
// realistically seconds apart in live play, not milliseconds — 600ms
// comfortably separates the two without risking dropping a scorer's fast
// but deliberate second entry.
export const DOUBLE_SUBMIT_WINDOW_MS = 600;

// A stable module-level fallback, not `params.auth ?? { kind: "session" }`
// inline at call time — the latter would allocate a NEW object every render
// whenever a caller omits `auth`, and useFixtureStream's own effect depends
// on `auth` by identity, so a fresh object each render would tear down and
// resubscribe (a new token fetch, a new realtime handshake) on every render
// instead of once per mount.
const SESSION_AUTH: PadAuthMode = { kind: "session" };

export interface UsePadPipelineParams {
  fixtureId: string;
  module: AnySportModule;
  cfg: unknown;
  lineups: LineupPair;
  identity: OwnIdentity;
  transport: PadTransport;
  /** The ledger so far, oldest first — e.g. a server bootstrap's
   *  `GET /events?since_seq=0`. Defaults to empty (a brand-new fixture).
   *  Seeds `ledgerEvents` at mount AND is re-adopted (merged, never
   *  overwritten — a still-queued local write always survives) on every
   *  later render where this changes — S12/#421 pass E: a fixture that
   *  flips scheduled -> live while this hook is already mounted hands down
   *  a NEW value here (the console chrome's own "Start match" triggers a
   *  `router.refresh()`), and a `useState` initializer alone only ever
   *  reads the first one. */
  initialEvents?: readonly EventEnvelope[];
  /** IndexedDB store name. Defaults to one name per fixture so two fixtures
   *  never share a queue. `indexedDbQueueStore` already degrades to an
   *  in-memory store when `indexedDB` is undefined (queue-store.ts) — this
   *  hook does not re-implement that fallback. */
  queueDbName?: string;
  // Review finding 3: use-fixture-stream.ts existed but was never wired to
  // this hook, so "polling does not stampede an in-flight drain" and "a
  // realtime signal reaches the fold" were both unprovable. `auth` is
  // needed here (in ADDITION to `transport`, which already bakes its own
  // auth into request headers) because useFixtureStream's realtime-token
  // door is a SEPARATE authed endpoint it calls directly — see transport.ts
  // for why appendEvent/listEventsSince don't need this raw value at all.
  // Optional and defaults to session auth so no existing caller breaks.
  auth?: PadAuthMode;
  /** Test-only overrides, forwarded verbatim to useFixtureStream. Omit in
   *  production to get its own real defaults (the global `fetch`, the real
   *  Supabase connector). */
  streamFetchFn?: typeof fetch;
  streamConnector?: RealtimeConnector;
  streamPollMs?: number;
}

export interface RejectionInfo {
  code: string;
  message: string;
}

export interface UsePadPipelineResult {
  /** The module's own fold over every known event (confirmed + still-queued
   *  local ones), reconciled against the server's fold on every ack. */
  state: unknown;
  /** `module.summary(state)` — display-ready, recomputed alongside `state`. */
  summary: unknown;
  /** How many events are still queued (not yet acked/dropped). */
  queueDepth: number;
  /** Authoritative from the transport's OWN network failures, never from
   *  `navigator.onLine` — a captive portal reports `onLine: true` while
   *  every real request keeps failing, so that signal is a HINT only (used
   *  to opportunistically retry, below), never the source of truth here. */
  offline: boolean;
  /** The most recent permanent (422-class) refusal, if any. Cleared at the
   *  start of the next submit. */
  lastRejection: RejectionInfo | null;
  /** True while a post-ack `fetchState` reconciliation read is in flight. */
  resyncing: boolean;
  /** Submit one action: folds it in immediately, then durably enqueues and
   *  drains. Never throws — a permanent rejection surfaces via
   *  `lastRejection`, a network failure via `offline`. */
  submit: (type: string, payload: unknown) => Promise<void>;
  /** S12/#421 — every known event (durable ledger + still-queued local
   *  ones), oldest first: the raw list `state` above was folded FROM, for a
   *  persistent activity feed (timeline.tsx). Same combination `foldedState`
   *  folds, exposed directly rather than re-derived by a caller. */
  events: readonly EventEnvelope[];
  /** S12/#421 — ids of events THIS hook instance is itself responsible for:
   *  submitted via `submit()` this mount, or resumed from this device's own
   *  leftover IndexedDB queue on mount. Survives the pending -> ledger
   *  transition, unlike `pendingEnvelopes` itself (a purely internal, never
   *  exposed, implementation detail). `EventEnvelope` (the engine's own core
   *  type) carries no device-link field at all — it is sport/auth-agnostic —
   *  so this is the only way a consumer can tell "I recorded this" for an
   *  event that has already moved into the durable ledger, which is exactly
   *  what timeline.tsx's own "a device link may only void its own events"
   *  rule needs in order to be reachable rather than vacuous for anything
   *  beyond the instant an event is still mid-flight. An event loaded from
   *  `initialEvents` (server history predating this mount) is never in this
   *  set — honestly "unknown", never a guess. */
  ownEventIds: ReadonlySet<string>;
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** `core.void`'s payload shape is `{event_id: string}` at every seam that
 *  reads it — the optimistic-fold translation below AND (S12/#421 pass G)
 *  the wire-target resolution in `runDrain`. One extractor so both parse the
 *  identical shape rather than two copies that can drift. */
function extractVoidEventId(payload: unknown): string | null {
  const eventId = (payload as { event_id?: unknown } | null)?.event_id;
  return typeof eventId === "string" ? eventId : null;
}

/** The one seam where a submitted action's WIRE payload can differ from the
 *  ENGINE envelope it folds as. Today that is exactly `core.void`:
 *  server/usecases/scoring.ts's own `scoreEvent()` extracts
 *  `payload.event_id` into the persisted envelope's `voids` field and
 *  stores an EMPTY payload (matching `CoreVoid`'s `z.strictObject({})`), so
 *  an optimistic fold that fed `{event_id}` straight through as `payload`
 *  would violate the engine's own schema. Mirrors that exact conditional so
 *  the optimistic fold and the server construct the same envelope shape
 *  from the same submitted action. */
function toEnvelopeFields(type: string, payload: unknown): { payload: unknown; voids?: string } {
  if (type === "core.void") {
    const eventId = extractVoidEventId(payload);
    if (eventId !== null) return { payload: {}, voids: eventId };
  }
  return { payload };
}

/** Exported for direct testing (review finding 4) — mirrors pipeline.ts's
 *  own precedent of exporting its pure decision helpers rather than only
 *  exercising them indirectly.
 *
 *  `confirmedSeq`, when given, WINS over `pending.expectedSeq + 1`. Review
 *  finding 4: runDrain captures its `next` pending event BEFORE calling
 *  sendOne; if sendOne renegotiates (a 409 whose ledger slot proves
 *  foreign) and the resend succeeds, the server's real assigned seq is
 *  `renegotiatedExpectedSeq + 1` — unrelated to this event's ORIGINAL
 *  `expectedSeq`. The caller passes `outcome.result.seq` (the server's own
 *  AppendSuccess.seq) on the "acked" branch so this is correct regardless
 *  of how many renegotiations happened; the "already-applied" branch never
 *  renegotiates within its own call (pipeline.ts's resolveConflict decides
 *  it BEFORE any resend), so `pending.expectedSeq + 1` already is the
 *  confirmed value there and needs no override. */
export function pendingToEnvelope(
  fixtureId: string,
  identity: OwnIdentity,
  pending: PendingEvent,
  confirmedSeq?: number,
): EventEnvelope {
  const { payload, voids } = toEnvelopeFields(pending.type, pending.payload);
  return {
    id: pending.idempotencyKey,
    fixtureId,
    // append-event.ts: the accepted row lands at expected_seq + 1 — the best
    // guess pre-ack, and still correct post-ack UNLESS a renegotiation
    // moved the seq that actually landed (see confirmedSeq above).
    seq: confirmedSeq ?? pending.expectedSeq + 1,
    type: pending.type,
    payload,
    recordedAt: pending.createdAt,
    recordedBy: identity.recordedBy,
    ...(voids === undefined ? {} : { voids }),
  };
}

/**
 * S12/#421 — widen a polled/realtime ledger ROW into a foldable
 * `EventEnvelope`, now that `LedgerSlotEvent` carries `id`/`recorded_at`
 * (types.ts). Returns `null` — never a guessed id — for a row missing
 * either: types.ts's own JSDoc explains why they are optional on that
 * TYPE despite the real transport always populating them, so an absent
 * value here can only be a hand-rolled test double that predates this
 * widening, never a real server response. Still drops `voids_event_id`
 * (LedgerSlotEvent does not carry it) — see the SCOPE BOUNDARY comment at
 * the top of this file for what that means for a foreign `core.void`.
 */
function ledgerSlotToEnvelope(fixtureId: string, row: LedgerSlotEvent): EventEnvelope | null {
  if (row.id === undefined || row.recorded_at === undefined) return null;
  return {
    id: row.id,
    fixtureId,
    seq: row.seq,
    type: row.type,
    payload: row.payload,
    recordedAt: row.recorded_at,
    recordedBy: row.recorded_by,
  };
}

/**
 * Merge a batch of already-widened envelopes into the known ledger, by seq,
 * deduplicated, kept ascending — the ONE primitive `mergeLedgerEvents` (the
 * poll/realtime path, S12/#421 pass C), the `initialEvents`-adoption effect
 * below (pass E), AND `runDrain`'s own ack append (pass F) all reduce to,
 * rather than differently-shaped merges that can drift (this repo has a
 * recorded bug from exactly that shape: two parallel lookup paths). Touches
 * only the ledger list; `pendingEnvelopes` (the offline queue) is untouched
 * by construction, so no caller can ever drop or reorder a still-queued
 * local write.
 *
 * On a seq collision, `current` wins UNLESS `opts.incomingWins` is set.
 * Default (`current` wins) is what `mergeLedgerEvents` and the
 * `initialEvents` effect need: a batch may overlap what this hook already
 * knows (a previous poll's rows, or a previous `initialEvents`), and the
 * EXISTING entry must win so this can never regress a richer envelope this
 * hook already built or fetched itself — `runDrain`'s own `pendingToEnvelope`
 * sets `voids` for a core.void THIS device recorded, which a bare polled
 * ledger row can never reconstruct. `runDrain`'s ack append (pass F) needs
 * the OPPOSITE precedence — see that call site's own comment for the
 * `id`/`voids` argument for why.
 */
function mergeEnvelopesIntoLedger(
  current: readonly EventEnvelope[],
  incoming: readonly EventEnvelope[],
  opts?: { incomingWins?: boolean },
): EventEnvelope[] {
  const first = opts?.incomingWins ? incoming : current;
  const second = opts?.incomingWins ? current : incoming;
  const bySeq = new Map<number, EventEnvelope>();
  for (const event of first) bySeq.set(event.seq, event);
  for (const event of second) {
    if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Merge a polled/realtime batch of ledger ROWS into the known ledger —
 * S12/#421 pass C. Widens each row first (dropping any this hook cannot
 * reconstruct — a row missing `id`/`recorded_at`, per `ledgerSlotToEnvelope`
 * above), then delegates to `mergeEnvelopesIntoLedger` for the actual
 * by-seq merge; see that function's own doc for the "existing wins" rule
 * and the `pendingEnvelopes` guarantee.
 */
function mergeLedgerEvents(
  fixtureId: string,
  current: readonly EventEnvelope[],
  incoming: readonly LedgerSlotEvent[],
): EventEnvelope[] {
  const widened: EventEnvelope[] = [];
  for (const row of incoming) {
    const envelope = ledgerSlotToEnvelope(fixtureId, row);
    if (envelope !== null) widened.push(envelope);
  }
  return mergeEnvelopesIntoLedger(current, widened);
}

/** S12/#421 pass G — see the file header's own PASS G UPDATE for the full
 *  trace this fixes. Every `core.void` a caller ever submits names its
 *  target by whatever `.id` the timeline showed it, and that id came from
 *  exactly one of two places:
 *   - `initialEvents`/a poll (`ledgerSlotToEnvelope`) — already the server's
 *     real row id, so `event_id` needs no translation at all.
 *   - THIS hook's own `pendingToEnvelope` — the client-fabricated
 *     idempotency key, which append-event.ts NEVER assigns as a persisted
 *     row's id (that is always a fresh `randomUUID()`, and scoring.ts never
 *     forwards the client's own id — see the pass F comment on `runDrain`'s
 *     ack branch for the same fact, found independently while fixing a
 *     different bug). Submitting that id verbatim can never resolve.
 *  `ownEventIds` is exactly that boundary: populated ONLY by `markOwn`, for
 *  an id THIS hook instance itself minted (`submit()`, or a resumed leftover
 *  queue entry) — never for a row adopted from `initialEvents`/a poll (see
 *  `UsePadPipelineResult.ownEventIds`'s own JSDoc). So a target NOT in
 *  `ownEventIds` needs no lookup at all (`kind: "same"`) — the fast, common
 *  path, unchanged from before this pass.
 *
 *  For an own target, resolution is by SEQ, never a second guess at the id:
 *  once the target's own envelope sits in `ledgerEvents` (acked, or merged
 *  in from elsewhere), its `.seq` IS the server's row position, and
 *  `listEventsSince(seq - 1)` reads that exact row back with its real id —
 *  the SAME read a 409 ledger-slot inspection already trusts in pipeline.ts's
 *  `findLedgerSlot`. Cached by `cache` (owned by the caller, one per hook
 *  instance) so a retried/renegotiated resend of the SAME void keeps sending
 *  an IDENTICAL payload — required for `sendOne`'s own 409 "already-applied"
 *  comparison (pipeline.ts `resolveConflict`: `deepEqual` on `payload`) to
 *  ever be able to match a prior attempt.
 *
 *  `ledgerEvents` is checked, never `pendingEnvelopes`: `runDrain`'s queue is
 *  strict FIFO — one event is fully resolved (acked/already-applied/
 *  permanently rejected) before the next one's send is even attempted
 *  (pipeline.ts `drainQueue`'s own documented contract, mirrored by this
 *  hook's hand-rolled loop below) — and a void can only ever be enqueued
 *  AFTER its target (nothing to undo before it exists). So by the time
 *  THIS event's own turn in the loop comes, the target has necessarily
 *  reached a final state: acked (now in `ledgerEvents`) or permanently
 *  rejected (removed from both `pendingEnvelopes` and `ledgerEvents` — never
 *  "still pending"). A target absent from `ledgerEvents` at this point is
 *  not a timing accident worth retrying; it never landed and never will —
 *  `kind: "unresolvable-permanent"`. A target genuinely present but whose
 *  OWN read just failed (a thrown `listEventsSince`, or an empty/non-
 *  matching result — indistinguishable from here, and this repo's own stated
 *  posture is that flaky courtside wifi is the normal case, not an edge
 *  case) gets another attempt on the next drain — `kind:
 *  "unresolvable-transient"`, deliberately NOT treated as permanent so a
 *  genuinely valid undo is never killed by one bad read. */
export type VoidTargetResolution =
  | { kind: "same"; eventId: string }
  | { kind: "resolved"; eventId: string }
  | { kind: "unresolvable-permanent" }
  | { kind: "unresolvable-transient" };

export async function resolveVoidTargetId(
  transport: Pick<PadTransport, "listEventsSince">,
  fixtureId: string,
  targetId: string,
  ownEventIds: ReadonlySet<string>,
  ledgerEvents: readonly EventEnvelope[],
  cache: Map<string, string>,
): Promise<VoidTargetResolution> {
  if (!ownEventIds.has(targetId)) return { kind: "same", eventId: targetId };
  const cached = cache.get(targetId);
  if (cached !== undefined) return { kind: "resolved", eventId: cached };
  const target = ledgerEvents.find((e) => e.id === targetId);
  if (target === undefined) return { kind: "unresolvable-permanent" };
  try {
    const rows = await transport.listEventsSince(fixtureId, target.seq - 1);
    const row = rows.find((r) => r.seq === target.seq);
    if (row === undefined || row.id === undefined) return { kind: "unresolvable-transient" };
    cache.set(targetId, row.id);
    return { kind: "resolved", eventId: row.id };
  } catch {
    return { kind: "unresolvable-transient" };
  }
}

export function usePadPipeline(params: UsePadPipelineParams): UsePadPipelineResult {
  const { fixtureId, module: sportModule, cfg, lineups, identity, transport } = params;
  const dbName = params.queueDbName ?? `scorepad-queue-${fixtureId}`;

  const store = useMemo(() => indexedDbQueueStore(dbName), [dbName]);

  const [ledgerEvents, setLedgerEvents] = useState<EventEnvelope[]>(() => [...(params.initialEvents ?? [])]);
  // Mirrors `ledgerEvents` for synchronous reads inside `runDrain`/`submit`
  // (stable useCallbacks that must see the LATEST ledger without churning
  // their own identity on every ack — see the file header for why a plain
  // functional setState update does not fit here: the same "latest ledger"
  // value is also needed OUTSIDE the updater, for reconcileAfterAck).
  const ledgerEventsRef = useRef(ledgerEvents);
  const commitLedgerEvents = useCallback((next: EventEnvelope[]) => {
    ledgerEventsRef.current = next;
    setLedgerEvents(next);
  }, []);

  // Not-yet-resolved local events, keyed by idempotencyKey — the OPTIMISTIC
  // portion of the fold. Populated at submit time (before any network
  // call), cleared as each one resolves. Same ref-mirror need as
  // `ledgerEvents` above: `submit()` must read the CURRENT size
  // synchronously (to compute a new event's `expectedSeq` correctly against
  // however many are already in flight) without depending on its own
  // identity churning on every ack.
  const [pendingEnvelopes, setPendingEnvelopes] = useState<Map<string, EventEnvelope>>(() => new Map());
  const pendingEnvelopesRef = useRef(pendingEnvelopes);
  const commitPendingEnvelopes = useCallback((next: Map<string, EventEnvelope>) => {
    pendingEnvelopesRef.current = next;
    setPendingEnvelopes(next);
  }, []);

  // S12/#421 — see UsePadPipelineResult.ownEventIds's own JSDoc for why this
  // exists. State (not ONLY a ref): a caller's own `useMemo` keyed on
  // `pipeline.ownEventIds` must see a NEW Set identity whenever membership
  // actually changes, which a mutated-in-place ref would defeat.
  // S12/#421 pass G — ALSO mirrored into a ref: `runDrain` (below) needs a
  // synchronous read of the LATEST membership to decide whether a
  // `core.void`'s target needs id resolution at all, and it is a stable
  // `useCallback` that must not be recreated (and thereby churn `submit`'s
  // own identity) on every `markOwn` call — same reasoning as
  // `ledgerEventsRef`/`pendingEnvelopesRef` above.
  const [ownEventIds, setOwnEventIds] = useState<ReadonlySet<string>>(() => new Set());
  const ownEventIdsRef = useRef(ownEventIds);
  const markOwn = useCallback((id: string) => {
    setOwnEventIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev).add(id);
      ownEventIdsRef.current = next;
      return next;
    });
  }, []);

  // S12/#421 pass G — local id -> server id, for a core.void whose target is
  // one of THIS hook's own submissions. See resolveVoidTargetId's own doc.
  // A plain ref: purely internal bookkeeping, never read by a caller, and a
  // cache write must never itself trigger a render.
  const voidTargetServerIdRef = useRef<Map<string, string>>(new Map());

  const [queueDepth, setQueueDepth] = useState(0);
  const [offline, setOffline] = useState(false);
  const [lastRejection, setLastRejection] = useState<RejectionInfo | null>(null);
  const [resyncing, setResyncing] = useState(false);
  // Server-wins override — set only when reconciliation finds a REAL
  // divergence; cleared as soon as the next ack's reconciliation matches
  // again (a fresh optimistic fold from `ledgerEvents` is then correct).
  const [serverOverride, setServerOverride] = useState<unknown>(undefined);

  // The in-flight drain, shared by every caller. NOT a boolean guard that
  // makes a concurrent caller no-op: `submit()` always awaits the actual
  // queue-empty outcome, including one started by the mount-time resume
  // attempt below. A boolean-only guard would let `submit()`'s own
  // `runDrain()` call return immediately as a no-op whenever the mount
  // effect's fire-and-forget drain got there microtasks earlier — which
  // measurably happens (the mount effect's `peekInOrder` and `submit`'s own
  // `enqueue` race, and either can settle first) — so `submit()` could
  // resolve BEFORE its own event was actually sent, showing a stale fold.
  const drainInFlight = useRef<Promise<void> | null>(null);

  // Review finding 2's double-submit guard. Two separate mechanisms, both
  // keyed on (type, payload) via pipeline.ts's own deepEqual (structural,
  // not reference — a fresh object literal per render must still compare
  // equal): `submitInFlight` catches two calls landing in the SAME tick
  // (two bound handlers firing for one press, or a synchronous double
  // invocation) before either has had a chance to update `lastAccepted`;
  // `lastAccepted` catches a repeat that arrives AFTER the first fully
  // resolved, within DOUBLE_SUBMIT_WINDOW_MS. Neither fires for two
  // DIFFERENT actions, and the window is short enough that two genuinely
  // separate identical actions (two dot balls in a row) both still land.
  const submitInFlight = useRef<{ type: string; payload: unknown } | null>(null);
  const lastAccepted = useRef<{ type: string; payload: unknown; at: number } | null>(null);

  // S12/#421 — the last successfully computed fold, the "last good state" a
  // violating optimistic guess degrades to below rather than ever throwing
  // into render. `undefined` only until the very first fold ever succeeds
  // (or forever, if even THAT throws — see the `??` fallback below).
  const lastGoodStateRef = useRef<unknown>(undefined);

  const foldedState = useMemo(() => {
    if (serverOverride !== undefined) return serverOverride;
    const events = [...ledgerEvents, ...pendingEnvelopes.values()];
    try {
      const state = foldClient(sportModule, cfg, lineups, events);
      lastGoodStateRef.current = state;
      return state;
    } catch (err) {
      // A violating OPTIMISTIC guess — e.g. this hook's own local knowledge
      // is momentarily stale (the exact S12/#421 class: a foreign event not
      // yet merged makes this hook's OWN next action look illegal), or a
      // genuinely invalid action. Either way the real server round trip
      // (already in flight via runDrain, or about to be) is the actual
      // authority and will correct this either way — S3/#426 OWNER RULING
      // 2: "a violating re-entry returns a rejection, never throws — a
      // cfg-derived throw inside a fold permanently bricks recorded
      // fixtures." Never let this crash the pad over its own best guess
      // being wrong: degrade to the last good state and surface the
      // rejection instead.
      //
      // A RENDER-PHASE state update (React's own sanctioned "adjust state
      // during render" pattern — see components/__tests__/_hook-harness.tsx
      // for the equivalent test-harness mechanics) — guarded so it fires
      // ONLY when the rejection's content actually changed, or a poisoned
      // event that never resolves (e.g. still sitting in `pendingEnvelopes`
      // because the real ack/reject is still in flight) would re-set an
      // equal-content object every render forever and never converge.
      const code = err instanceof EngineError ? err.code : "UNKNOWN";
      const message = err instanceof Error ? err.message : "optimistic fold failed";
      if (lastRejection === null || lastRejection.code !== code || lastRejection.message !== message) {
        setLastRejection({ code, message });
      }
      return lastGoodStateRef.current ?? sportModule.init(cfg, lineups);
    }
  }, [sportModule, cfg, lineups, ledgerEvents, pendingEnvelopes, serverOverride, lastRejection]);

  const summary = useMemo(() => sportModule.summary(foldedState), [sportModule, foldedState]);

  const refreshDepth = useCallback(async () => {
    setQueueDepth(await depth(store));
  }, [store]);

  const reconcileAfterAck = useCallback(
    async (nextLedgerEvents: EventEnvelope[]) => {
      setResyncing(true);
      try {
        const server = await transport.fetchState(fixtureId);
        // `state: null` means "no match_states row at all" (getFixtureState:
        // `row.state ?? null`) — a real absence, never a fold to prefer over
        // one this hook already computed. Comparing against it would make
        // every ack on a fresh fixture "diverge" to null and blank the pad.
        if (server.state === null) return;
        const localFold = foldClient(sportModule, cfg, lineups, nextLedgerEvents);
        const verdict = reconcile<unknown>(localFold, server.state);
        setServerOverride(verdict.kind === "diverged" ? verdict.server : undefined);
      } catch {
        // A failed reconciliation read leaves the optimistic fold on screen
        // — best-effort, never crashes the pad over one flaky read.
      } finally {
        setResyncing(false);
      }
    },
    [transport, fixtureId, sportModule, cfg, lineups],
  );

  // Review finding 3, S12/#421 UPDATE: wires use-fixture-stream.ts in. An
  // inbound signal — realtime or polling, `onEvents` does not distinguish —
  // used to be treated as "go verify the true state" rather than data to
  // fold ourselves, because `LedgerSlotEvent[]` could not be widened into a
  // foldable `EventEnvelope[]` (see the SCOPE BOUNDARY comment at the top
  // of this file for the traced defect that came from exactly that gap).
  // Now that it can, this MERGES the batch into `ledgerEvents` (by seq,
  // deduplicated, ascending — `mergeLedgerEvents` above; `pendingEnvelopes`,
  // the offline queue, is never touched) and reconciles over the MERGED
  // list, not the stale pre-merge one — so `serverOverride` fires only on a
  // GENUINE divergence rather than on this pad simply having been behind.
  // An empty batch (every tick reports one, per use-fixture-stream.ts's own
  // `fetchOnce`) is still a no-op, not a wasted merge/fetchState round trip.
  const onStreamEvents = useCallback(
    (events: LedgerSlotEvent[]) => {
      if (events.length === 0) return;
      const merged = mergeLedgerEvents(fixtureId, ledgerEventsRef.current, events);
      commitLedgerEvents(merged);
      void reconcileAfterAck(merged);
    },
    [fixtureId, commitLedgerEvents, reconcileAfterAck],
  );
  const skipPollWhileDraining = useCallback(() => drainInFlight.current !== null, []);
  useFixtureStream({
    fixtureId,
    auth: params.auth ?? SESSION_AUTH,
    sinceSeq: ledgerEvents.length,
    listEventsSince: transport.listEventsSince,
    onEvents: onStreamEvents,
    skipPollWhile: skipPollWhileDraining,
    fetchFn: params.streamFetchFn,
    connector: params.streamConnector,
    pollMs: params.streamPollMs,
  });

  // S12/#421 pass E — adopt a CHANGED `initialEvents` prop after mount (file
  // header, PASS E UPDATE, has the full trace: the FOURTH defect). The
  // `useState` initializer above only ever reads `params.initialEvents`
  // once, at mount; this effect is what a fixture flipping scheduled -> live
  // UNDER an already-mounted pad actually needs. Reuses
  // `mergeEnvelopesIntoLedger` — the SAME primitive `onStreamEvents` above
  // uses — rather than a second, differently-shaped merge: `initialEvents`
  // is already `EventEnvelope[]` (a server bootstrap fetch), so no widening
  // step is needed here, unlike the poll path's raw `LedgerSlotEvent[]`.
  //
  // Guarded on the merge actually adding something new: a parent server
  // component re-rendering for an unrelated reason routinely hands down a
  // content-identical but reference-NEW `initialEvents` array (server
  // components do not memoise their return value), and this effect's own
  // dependency is that reference — committing a same-length array and
  // kicking off a reconciliation read on every such render would be pure
  // waste. `pendingEnvelopes` (the offline queue) is never touched, by
  // construction of `mergeEnvelopesIntoLedger` itself — a still-queued local
  // write survives an `initialEvents` change underneath it.
  //
  // Deliberately makes `ledgerEvents` itself the authoritative fix, not
  // `serverOverride`: a bare `setServerOverride` call here would repair the
  // DISPLAY while leaving the fold BASE exactly as broken as pass C found it
  // — the mirror of this very defect. `reconcileAfterAck` is still called
  // afterwards, same as `onStreamEvents` above, to catch any GENUINE
  // divergence from the server's own fold beyond what merely adopting the
  // new events already fixes.
  useEffect(() => {
    const incoming = params.initialEvents;
    if (incoming === undefined || incoming.length === 0) return;
    const merged = mergeEnvelopesIntoLedger(ledgerEventsRef.current, incoming);
    if (merged.length === ledgerEventsRef.current.length) return; // nothing new
    commitLedgerEvents(merged);
    void reconcileAfterAck(merged);
  }, [params.initialEvents, commitLedgerEvents, reconcileAfterAck]);

  const runDrain = useCallback(async () => {
    // Piggyback on an already-running drain rather than no-op'ing: whatever
    // it is currently draining necessarily includes anything queued before
    // THIS call started (the store is FIFO and nothing removes an entry
    // except a resolved send), so waiting for it is equivalent to running a
    // fresh pass, without two loops touching the store at once.
    if (drainInFlight.current) {
      await drainInFlight.current;
      return;
    }
    const run = (async () => {
      for (;;) {
        const queued = await peekInOrder(store);
        if (queued.length === 0) break;
        const next = queued[0]!;

        // S12/#421 pass G — undo-before-reload (file header PASS G UPDATE,
        // _INDEX.md decision log). `next` itself is NEVER reassigned below:
        // pendingToEnvelope's LOCAL fold envelope (the acked branch, further
        // down) must keep reading the LOCAL target id, consistent with
        // ledgerEvents' own `.id` fields — only the WIRE-BOUND copy
        // (`eventToSend`) carries the translated one, if any.
        let eventToSend = next;
        if (next.type === "core.void") {
          const targetId = extractVoidEventId(next.payload);
          if (targetId !== null) {
            const resolution = await resolveVoidTargetId(
              transport,
              fixtureId,
              targetId,
              ownEventIdsRef.current,
              ledgerEventsRef.current,
              voidTargetServerIdRef.current,
            );
            if (resolution.kind === "unresolvable-permanent") {
              // Never silently dropped — the exact defect this pass fixes.
              // Surfaced exactly like any other permanent rejection, and
              // removed so it is not retried forever against a target that
              // will never exist.
              await markDropped(store, next.idempotencyKey);
              const remaining = new Map(pendingEnvelopesRef.current);
              remaining.delete(next.idempotencyKey);
              commitPendingEnvelopes(remaining);
              await refreshDepth();
              // No specific ENGINE_ERROR_KEY entry exists for a client-only
              // code like this — an empty message lets scoringErrorText
              // (scoring-vocab.ts) fall back to its own already-localized
              // `scorepad.rejection.fallback` copy rather than showing raw,
              // untranslated English.
              setLastRejection({ code: "VOID_TARGET_UNKNOWN", message: "" });
              continue;
            }
            if (resolution.kind === "unresolvable-transient") {
              // A READ failure, not a write failure — handled the same as
              // any other network hiccup: stays queued, retried whole on the
              // next drain (the target's own row does not move in the
              // meantime, so nothing here can go stale).
              await recordAttempt(store, next.idempotencyKey, {
                attempts: next.attempts + 1,
                lastError: "could not resolve the undo target's server id",
              });
              await refreshDepth();
              setOffline(true);
              break;
            }
            if (resolution.eventId !== targetId) {
              eventToSend = { ...next, payload: { event_id: resolution.eventId } };
            }
          }
        }

        const outcome = await sendOne(transport, store, fixtureId, eventToSend, identity);
        await refreshDepth();

        if (outcome.kind === "acked" || outcome.kind === "already-applied") {
          setOffline(false);
          const remaining = new Map(pendingEnvelopesRef.current);
          remaining.delete(next.idempotencyKey);
          commitPendingEnvelopes(remaining);
          // review finding 4: "acked" may have followed a mid-flight 409
          // renegotiation (sendOne resent with a NEW expected_seq) — the
          // server's own AppendSuccess.seq is the only value guaranteed
          // correct either way. "already-applied" never renegotiates within
          // its own call (resolveConflict decides that BEFORE any resend),
          // so pendingToEnvelope's own expectedSeq+1 default is already
          // right there and needs no override.
          const confirmedSeq = outcome.kind === "acked" ? outcome.result.seq : undefined;
          const acked = pendingToEnvelope(fixtureId, identity, next, confirmedSeq);
          // S12/#421 pass F — was a raw spread
          // (`[...ledgerEventsRef.current, acked]`), never routed through
          // mergeEnvelopesIntoLedger like the other two writers into
          // ledgerEvents. ledgerEventsRef.current can ALREADY hold an entry
          // at acked.seq if a poll tick (onStreamEvents) or an initialEvents
          // re-seed observed the server's committed row for this SAME event
          // before this append's own HTTP response made it back -
          // skipPollWhileDraining only blocks a NEW poll from starting, not
          // an initialEvents prop change (no such guard on that effect) or a
          // poll already in flight when the drain began. The raw spread
          // never checked for that, so both entries survived - permanent for
          // the life of the mount, double-counting this event in every fold
          // after it.
          //
          // Seq is server-assigned and unique per fixture (the entire point
          // of expected_seq optimistic concurrency - append-event.ts), so a
          // collision here is PROVABLY the same event, never a different
          // foreign one: safe to let one side win outright.
          //
          // incomingWins: true - the OPPOSITE of the other two callers'
          // default, deliberately. Confirmed against
          // server/engine-db/append-event.ts: the persisted row's id is
          // `input.id ?? randomUUID()`, and scoring.ts never passes
          // input.id - so a poll/initialEvents widening of this same event
          // always carries a FRESH server-random id, never this pending
          // event's idempotencyKey. If the existing ledger entry won here
          // instead, the surviving copy's id would no longer match what
          // markOwn recorded in ownEventIds for this event - silently
          // breaking "is this mine" attribution for exactly the race this
          // fix closes. Worse for a core.void: ledgerSlotToEnvelope never
          // carries voids (LedgerSlotEvent has no such field, types.ts), so
          // a foreign-sourced copy of THIS device's own void would fold as a
          // no-op and silently fail to reverse the event it targeted.
          // `acked` (built fresh, this call, from this hook's own identity)
          // is always the richer, correctly-attributed copy, so it must win
          // outright, not merely survive alongside the other one.
          const withAck = mergeEnvelopesIntoLedger(ledgerEventsRef.current, [acked], { incomingWins: true });
          commitLedgerEvents(withAck);
          void reconcileAfterAck(withAck);
        } else if (outcome.kind === "rejected") {
          setOffline(false);
          setLastRejection({ code: outcome.code, message: outcome.message });
          const remaining = new Map(pendingEnvelopesRef.current);
          remaining.delete(next.idempotencyKey);
          commitPendingEnvelopes(remaining);
        } else {
          // stayed-queued: network failure or an indeterminate 409 — stop
          // here, in order, exactly like pipeline.ts's own drainQueue.
          setOffline(outcome.reason === "network");
          break;
        }
      }
    })().finally(() => {
      drainInFlight.current = null;
    });
    drainInFlight.current = run;
    await run;
  }, [store, transport, fixtureId, identity, refreshDepth, commitLedgerEvents, commitPendingEnvelopes, reconcileAfterAck]);

  // Resume a leftover queue from a previous session (tab death/reload) —
  // seeding `pendingEnvelopes` from whatever the durable store already held
  // BEFORE draining means the pad shows "N actions still pending" the
  // instant it mounts, not only once the drain gets around to each one, and
  // keeps `pendingEnvelopesRef.current.size` (submit()'s own expectedSeq
  // arithmetic) accurate from the very first render. Also opportunistically
  // retries when the browser THINKS connectivity returned — `navigator
  // .onLine` is a HINT ONLY here, never authoritative, see `offline`'s own
  // JSDoc above for why.
  //
  // Effect-only on purpose (IndexedDB/store reads are inherently
  // post-mount, and the SSR render must not try them) — one sequential
  // async IIFE: seed leftover pending events, THEN refresh the depth
  // reading (so it reflects them), THEN attempt the drain.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const leftover = await peekInOrder(store);
      if (cancelled) return;
      if (leftover.length > 0) {
        const seeded = new Map(pendingEnvelopesRef.current);
        for (const p of leftover) {
          seeded.set(p.idempotencyKey, pendingToEnvelope(fixtureId, identity, p));
          // S12/#421 — this device's own leftover queue (IndexedDB is
          // browser/device-local), so it was unquestionably submitted under
          // THIS `identity`, exactly like a fresh submit() below.
          markOwn(p.idempotencyKey);
        }
        commitPendingEnvelopes(seeded);
      }
      await refreshDepth();
      if (cancelled) return;
      await runDrain();
    })();
    if (typeof window === "undefined") return;
    const onOnline = () => void runDrain();
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
    };
    // Deliberately mount-only: `runDrain`/`refreshDepth` read fresh state via
    // refs/the store itself, so re-subscribing on every identity change would
    // only add churn, not correctness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = useCallback(
    async (type: string, payload: unknown) => {
      // Synchronous section — no `await` above this point (see below for
      // why that matters to the in-flight guard too). `expectedSeq` assumes
      // every event ahead (confirmed + already queued) lands, per the
      // append/replay protocol's own documented assumption (pipeline.ts's
      // drainQueue); a rare double-submit race that mis-assigns a slot
      // self-heals via the SAME 409-renegotiation path the protocol already
      // has, so this reads refs rather than awaiting the store.
      const isSameAction = (o: { type: string; payload: unknown } | null): boolean =>
        o !== null && o.type === type && deepEqual(o.payload, payload);
      if (isSameAction(submitInFlight.current)) {
        return; // identical action already mid-flight this same tick — no-op
      }
      const now = Date.now();
      const last = lastAccepted.current;
      // `last !== null` first, so it narrows `last` for BOTH the isSameAction
      // call and the `.at` read that follows — `isSameAction`'s own null
      // check is a plain boolean return, not a type predicate, so it cannot
      // narrow `last` for TypeScript on its own.
      if (last !== null && isSameAction(last) && now - last.at < DOUBLE_SUBMIT_WINDOW_MS) {
        return; // identical action accepted too recently — likely one physical tap read twice
      }
      submitInFlight.current = { type, payload };
      lastAccepted.current = { type, payload, at: now };
      try {
        const nextExpectedSeq = ledgerEventsRef.current.length + pendingEnvelopesRef.current.size;
        const pending: PendingEvent = {
          localId: newId(),
          idempotencyKey: newId(),
          type,
          payload,
          expectedSeq: nextExpectedSeq,
          createdAt: new Date().toISOString(),
          attempts: 0,
        };
        const withPending = new Map(pendingEnvelopesRef.current);
        withPending.set(pending.idempotencyKey, pendingToEnvelope(fixtureId, identity, pending));
        commitPendingEnvelopes(withPending); // optimistic fold shows immediately
        markOwn(pending.idempotencyKey); // S12/#421 — this call submitted it, under THIS identity
        setLastRejection(null);
        // Everything below is async.
        await enqueue(store, pending);
        await refreshDepth();
        await runDrain();
      } finally {
        submitInFlight.current = null;
      }
    },
    [store, fixtureId, identity, commitPendingEnvelopes, markOwn, refreshDepth, runDrain],
  );

  // S12/#421 — the raw list `foldedState` above was folded from, exposed for
  // a persistent activity feed. Same combination as `foldedState`'s own
  // `events` local above, kept as a SEPARATE memo (not reused verbatim) so a
  // `serverOverride` never hides ledger events a caller's timeline still
  // needs to display, even while the FOLD is showing the server's override.
  const events = useMemo(() => [...ledgerEvents, ...pendingEnvelopes.values()], [ledgerEvents, pendingEnvelopes]);

  return { state: foldedState, summary, queueDepth, offline, lastRejection, resyncing, submit, events, ownEventIds };
}
