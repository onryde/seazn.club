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
// SCOPE BOUNDARY (documented, not an oversight): on a genuine divergence —
// a concurrent second scorer, or an optimistic-fold guess that turns out
// wrong — this hook adopts the server's fold as-is (server wins) but does
// NOT reconstruct the true event list that produced it. The queue's own
// ledger read (`ScoringTransport.listEventsSince`) is deliberately narrowed
// (drops `id`/`recordedAt` — see its own JSDoc in pipeline.ts) and cannot
// rebuild a foldable `EventEnvelope[]`, so a real concurrent-write
// divergence displays the server's state correctly but this hook's
// bookkeeping only re-syncs fully on the next mount (fresh `initialEvents`).
// Detecting and displaying the winning state — which the acceptance
// criteria requires — is fully covered; long-run incremental consistency
// after a real concurrent write is not, and is out of this pass's stated
// scope (no renderer, no routes this pass).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EventEnvelope, LineupPair } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { foldClient } from "./module-client";
import { indexedDbQueueStore } from "./queue-store";
import { depth, enqueue, peekInOrder } from "./queue";
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
   *  `GET /events?since_seq=0`. Defaults to empty (a brand-new fixture). */
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
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
    const eventId = (payload as { event_id?: unknown } | null)?.event_id;
    if (typeof eventId === "string") return { payload: {}, voids: eventId };
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

  const foldedState = useMemo(() => {
    if (serverOverride !== undefined) return serverOverride;
    const events = [...ledgerEvents, ...pendingEnvelopes.values()];
    return foldClient(sportModule, cfg, lineups, events);
  }, [sportModule, cfg, lineups, ledgerEvents, pendingEnvelopes, serverOverride]);

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

  // Review finding 3: wires use-fixture-stream.ts in. `LedgerSlotEvent[]` is
  // deliberately narrow (see the SCOPE BOUNDARY comment at the top of this
  // file) and cannot be folded directly, so an inbound signal — realtime or
  // polling, `onEvents` does not distinguish — is treated as "go verify the
  // true state" rather than data to fold ourselves: it reuses the SAME
  // reconcileAfterAck a normal ack already uses, over the ledger events this
  // hook currently knows about (it has no better local list to offer). An
  // empty batch (every tick reports one, per use-fixture-stream.ts's own
  // `fetchOnce`) is a no-op, not a wasted fetchState round trip.
  const onStreamEvents = useCallback(
    (events: LedgerSlotEvent[]) => {
      if (events.length === 0) return;
      void reconcileAfterAck(ledgerEventsRef.current);
    },
    [reconcileAfterAck],
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
        const outcome = await sendOne(transport, store, fixtureId, next, identity);
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
          const withAck = [...ledgerEventsRef.current, pendingToEnvelope(fixtureId, identity, next, confirmedSeq)];
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
        for (const p of leftover) seeded.set(p.idempotencyKey, pendingToEnvelope(fixtureId, identity, p));
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
        setLastRejection(null);
        // Everything below is async.
        await enqueue(store, pending);
        await refreshDepth();
        await runDrain();
      } finally {
        submitInFlight.current = null;
      }
    },
    [store, fixtureId, identity, commitPendingEnvelopes, refreshDepth, runDrain],
  );

  return { state: foldedState, summary, queueDepth, offline, lastRejection, resyncing, submit };
}
