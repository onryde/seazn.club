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
// (pass F) again at ack, forever, since an ack WITHOUT `event_id` carries no
// row id (see the device-void-mine UPDATE below: an ack that names its row
// now stamps that id instead). So the row timeline.tsx renders for a
// pad-submitted event always carried the client-fabricated idempotencyKey as
// its `.id`, and
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
//
// SCOPE BOUNDARY, S12/#421 PASS H UPDATE (undo-before-reload, REOPENED by a
// reload — _INDEX.md decision log): pass G's own fix above holds only WITHIN
// one mount. `ownEventIds` is plain `useState`, reset empty on every fresh
// mount, and the mount-time "resume leftover queue" effect (below) re-marks
// own only the ids of entries STILL SITTING in the durable queue — a queued
// void's OWN idempotencyKey, never its TARGET's, since an already-acked
// target has by definition already left that queue. So: score an event
// online (acked — the client-fabricated id survives the ack merge forever,
// pass F above); go offline; undo it (the void enqueues, correctly deferred
// by pass G's own `unresolvable-transient` path); reload before it drains.
// The fresh mount's `ownEventIds` no longer recognises the target's id as
// this device's own, so `resolveVoidTargetId` took the `"same"` fast path
// and put the stale client id back on the wire — silently, forever, the
// exact failure pass G exists to close, reopened by a reload it never
// accounted for. Fixed by threading the target's SEQ through the durable
// queue itself (`PendingEvent.voidTargetSeq`, types.ts), captured once at
// void-SUBMIT time (`voidTargetSeqAtSubmit`, just above
// `resolveVoidTargetId`) — a live mount, `ownEventIds` fully warm, never
// subject to the reload gap. Whenever present it is authoritative and skips
// the ownEventIds gate entirely, which is what makes `ownEventIds` an
// OPTIMISATION from here on rather than a correctness dependency —
// `resolveVoidTargetId`'s own doc has the fallback it still keeps, for a
// pre-pass-H queued record (degrades to the old, same-mount-only behaviour,
// never throws) or a target not yet acked at void-submit time (self-resolves
// via FIFO ordering instead, exactly as before this pass).
//
// SCOPE BOUNDARY, S12/#421 PASS I UPDATE (undo-before-reload, LOCAL fold
// still wrong): pass H fixed the WIRE send across a reload but left the
// LOCAL optimistic fold broken, pinning it with an explicit assertion rather
// than fixing it (use-pad-pipeline.test.tsx's own pass H test carried the
// full original trace in a comment, since replaced by this update). Root
// cause: `pendingToEnvelope`'s core.void envelope always read its `voids`
// target off the ORIGINAL submitted payload, unconditionally. That is
// correct WITHIN one mount — pass F's ack-merge keeps a pad-submitted
// event's CLIENT-fabricated id in `ledgerEvents` forever (after an ack
// WITHOUT `event_id`), so the void's own `voids` field, naming that same
// client id, always found a match — but
// wrong the moment a reload re-seeds `ledgerEvents` from `initialEvents`
// (`ledgerSlotToEnvelope`'s own `id: row.id`): the LOCAL ledger then only
// knows the target under the SERVER's real id, so the void's untranslated
// `voids: <client id>` named an id `resolveVoids`
// (packages/engine/src/core/events.ts — unconditional, matches `voids`
// against `.id` in the SAME event list being folded) could never find,
// throwing INVALID_EVENT on every fold from that point on. `foldedState`'s
// own catch degrades that to the last good state and surfaces it via
// `lastRejection` (S3/#426 OWNER RULING 2) — so the scorer saw a rejection
// banner for an undo that, on the wire, had already succeeded: worse than no
// banner, since the correct response to a genuine rejection (retry
// differently) is the wrong response to a false one (re-undo something
// already undone). Fixed by a new, purely LOCAL and synchronous helper,
// `pendingWithLocalVoidTarget` — a `voidTargetSeq` lookup against
// `ledgerEvents` itself, no network call — applied everywhere a queued
// void's `PendingEvent` becomes a local fold envelope: `runDrain`'s own ack
// append, AND the mount-time leftover-queue resume effect's pre-send
// seeding (which throws transiently on its own, even before runDrain gets a
// chance to act, and nothing later clears the `lastRejection` that leaves
// behind — see that helper's own doc for the full reasoning, including why
// `submit()`'s own first-ever pre-send build provably never needs it).
// Deliberately NOT reusing `resolveVoidTargetId`'s own resolved id for this:
// that answers a genuinely different question (what the SERVER calls the
// row, needed only for the wire) and would make this hook's OWN fold
// consistency depend on a network read it does not otherwise need.
//
// SCOPE BOUNDARY, S12/#421 PASS J UPDATE (the wire's own confirmation never
// reached the local ledger): a review of passes H and I found one more gap
// in this same seam. `resolveVoidTargetId` performs a REAL network read to
// confirm a void's target under the server's real row id, and used to cache
// ONLY that id string, in `voidTargetServerIdRef` — nothing ever merged the
// CONFIRMED ROW into `ledgerEvents` itself. `pendingWithLocalVoidTarget`
// (pass I, above) only ever reads `ledgerEvents` — deliberately, per its own
// doc, so the LOCAL fold's consistency never depends on a network read it
// does not otherwise need. So whenever `ledgerEvents` had NOT also
// independently caught up to the target (via a poll tick or an
// `initialEvents` re-seed — neither guaranteed to happen before this void's
// own ack) by the moment `runDrain` built the ack's local envelope,
// `pendingWithLocalVoidTarget` correctly found nothing to retarget against
// (its own documented "no row at that seq yet" no-op) and the UNTRANSLATED
// client-fabricated `voids` id got baked into `ledgerEvents` forever at ack
// time — even though the WIRE send, a few lines earlier in the SAME
// iteration, had already used the correctly-resolved id. No later fixup
// existed: once baked, that stale id never appears in `ledgerEvents` again
// (it was never a real row), so the engine's own `resolveVoids`
// (packages/engine/src/core/events.ts) permanently fails to find the
// target and every fold from that point throws INVALID_EVENT — degrading to
// the last good state exactly like pass I's own original bug, just reached
// via a different path into the same symptom (a stale rejection banner over
// an undo that, on the wire, had already succeeded).
//
// THE INVARIANT, and why it composes with pass I's rather than competing:
// pass I's own invariant is "the LOCAL fold envelope references whatever id
// `ledgerEvents` ITSELF currently holds for the target" — this pass does not
// touch that read. It changes how fast `ledgerEvents` becomes correct: the
// moment `resolveVoidTargetId` confirms a target via a FRESH network read
// (never a cache hit — a cache hit never carries the row, only the id string
// a PRIOR fresh read already saved; see that function's own doc), the
// confirmed row is merged into `ledgerEvents` right there in `runDrain`,
// through the SAME `mergeEnvelopesIntoLedger` primitive every other ledger
// writer already uses (never a second, differently-shaped merge — this
// file's own recurring caution, first stated at pass C/pass F above).
// `pendingWithLocalVoidTarget` itself is completely unchanged; it simply now
// finds what it is looking for sooner, because `ledgerEvents` caught up via
// the wire confirmation itself rather than waiting on an unrelated poll that
// might never come. The merged row is always the REAL widened envelope
// `resolveVoidTargetId`'s own read just fetched (`ledgerSlotToEnvelope`),
// never a fabricated placeholder — this file has no concept of injecting a
// synthetic event into `ledgerEvents`, since anything merged there is folded
// as if it really happened.
//
// SCOPE BOUNDARY, R5 UPDATE (a FOREIGN core.void crashes the pad — passes
// G-J above only ever fixed THIS hook's OWN void submissions). Repro: the
// fixture console (a sibling component, its OWN independent write path)
// undoes a match-deciding event a live pad JUST scored. Passes F/G above
// already establish that a pad-submitted event keeps its CLIENT-fabricated
// idempotency key as `ledgerEvents`' id for it FOREVER within a mount —
// an ack WITHOUT `event_id` carries no row id at all. When the console's
// undo lands, a LATER `initialEvents` refresh (its own `router.refresh()`) or poll tick
// hands this hook the SAME event's REAL server id at the SAME seq — but
// `mergeEnvelopesIntoLedger`'s own "existing wins" default (below) discarded
// it outright, exactly the protection pass F's own ack-append comment
// documents for a DIFFERENT reason (never regress a richer local void with a
// bare polled copy). So `ledgerEvents` kept the target under the CLIENT id
// forever, while the console's void — built server-side, the only id the
// server ever knew — named the REAL id: unresolvable, forever, the moment it
// merged in. The engine's own `resolveVoids`
// (packages/engine/src/core/events.ts) threw INVALID_EVENT on every fold
// from that point on. Unlike passes G-J's own failure mode (a caught
// rejection banner — `foldedState`'s try/catch), this one can reach a
// genuinely UNGUARDED caller: a v3 skin computing a serve/rotation label
// (e.g. `setBasedServeContext`, `packages/engine/src/sports/setbased/
// kernel.ts`) reads `pipeline.events` — this hook's raw, unfolded list,
// `UsePadPipelineResult.events` below — directly, synchronously, during
// render, with no try/catch of its own; a render-phase throw there crashes
// straight into `ScoringErrorBoundary` rather than degrading.
//
// A SECOND, INDEPENDENT half of the same defect, found by running the fix
// above against a real pad (walkthrough/scorepad-v3-volleyball-match.spec.ts,
// 1 red in 3): the id merge only helps when the console's void reaches this
// hook through a fresh `initialEvents` batch, which carries a full envelope.
// Reached through a POLL instead, the void arrived with NO TARGET AT ALL —
// `LedgerSlotEvent` did not carry `voids_event_id` and the transport
// boundary parsed-then-DROPPED it, though the server has always sent it
// (`EventOut`, server/usecases/fixtures.ts; `ScoreEvent`,
// server/api-v1/schemas.ts). `resolveVoids` rejects a `core.void` naming
// nothing exactly as it rejects one naming an unknown id, so the pad froze
// behind a rejection banner on whichever of the two paths won the race —
// which is why the same walkthrough passed twice and failed once. This is
// NOT specific to the console: ANY void this device did not itself submit —
// a second referee's undo on a shared fixture — took the same path.
//
// Fixed in three places, one per hop of the same fact:
//  - transport.ts keeps `voids_event_id` instead of dropping it, and
//    types.ts's `LedgerSlotEvent` carries it (both nullable — only a
//    core.void ever has one).
//  - `ledgerSlotToEnvelope` below widens it into the envelope's `voids`.
//  - `mergeEnvelopesIntoLedger` below adopts the wire-sourced copy on a seq
//    collision whenever the two genuinely disagree on `.id` or `.voids`,
//    unless doing so would DROP a void target this hook already holds — the
//    one case the old blanket "existing wins" default really existed for.
//    See that function's own doc for why both halves are needed: correcting
//    an id under a seq without also allowing a void to be re-targeted just
//    moves the dangling reference to the other side.
// Scoped to the DEFAULT merge direction only: `runDrain`'s own
// `incomingWins: true` ack append (pass F) is untouched by this branch, so
// its own "the just-acked copy always wins outright" guarantee still holds
// byte-for-byte — see that call site's own comment.
//
// SCOPE BOUNDARY, device-void-mine UPDATE (owner-reported, 2026-09-23). R5's
// id heal above only works when the TARGET row is re-delivered, and on the
// poll path it never is: the read cursor is the COUNT and `listEvents` is
// strict, so once this pad has acked its own event, `seq > count` never asks
// for that seq again. The device chrome's "Void my last entry"
// (`device-score-pad.tsx`) names the server's row id — the only id it has —
// so only the void arrived, naming an id this ledger did not hold, and the
// pad froze on the undone score while the chrome's header was right. R5's own
// poll test missed it because its transport returned both rows for any
// cursor. Two owner-approved fixes, each sufficient on its own:
//  - Fix A: the ack now carries the row's id (`AppendSuccess.event_id`) and
//    `runDrain` stamps it, so the pad holds its own events under the server's
//    ids from the moment they land. The "AppendSuccess carries no row id"
//    premise in the passes above still describes an ack WITHOUT one (an older
//    server, an "already-applied" outcome), and every fallback they built for
//    it stays.
//  - Fix B: `onStreamEvents` re-reads the ledger ONCE for any void a batch
//    leaves dangling and merges just the rows it names — see
//    `danglingVoidTargets` for the reasoning.
// Review round 1 found what re-keying at the ack costs: a void this pad
// queued BEFORE its target's ack (an offline tap, then Undo; an amendment of
// a still-queued original) names the minted key and carries no
// `voidTargetSeq`, so once the ack re-keyed the target nothing in the ledger
// answered to the key, and `resolveVoidTargetId` dropped the undo as "never
// landed". The ack now records key -> server id (`voidTargetServerIdRef`)
// for both resolvers to consult, and moves any such still-pending void onto
// the new id in the same commit that retires the target from
// `pendingEnvelopes` — see `runDrain`'s ack branch.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EngineError, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { foldClient } from "./module-client";
import { indexedDbQueueStore } from "./queue-store";
import {
  boundTo,
  depth,
  dropHeld,
  enqueue,
  enqueueHeld,
  markDropped,
  peekInOrder,
  recordAttempt,
  releaseHeld,
} from "./queue";
import type { QueueStore } from "./queue-store";
import { deepEqual, reconcile, sendOne } from "./pipeline";
import type { LedgerSlotEvent, OwnIdentity, PendingEvent } from "./types";
import type { PadAuthMode, PadTransport } from "./transport";
import type { NextMatchRef } from "@/lib/next-match-started";
import { useFixtureStream, type RealtimeConnector } from "./use-fixture-stream";

// Review finding 2: submit() minted a fresh idempotency key/expected_seq on
// EVERY call with no guard at all, so a courtside double-tap (or two bound
// handlers firing for one physical press) enqueued two genuinely distinct
// score events.
//
// R7-42/R7-30/R7-43 (owner ruling, `_INDEX.md`) — 600ms narrowed to 250ms,
// and the drop made VISIBLE (see the two call sites below). 600ms was not a
// debounce, it was a policy, and the wrong one: it silently ate a repeat of
// an identical (type, payload) up to 600ms apart with NO row, NO toast, NO
// error — and "identical payload, submitted twice in under 600ms" turned
// out to be ORDINARY, not an edge case (R7-43: reproduced live on carrom
// under load; badminton's own e2e comment names "a side that wins a whole
// game unanswered" — a run of same-side taps — as the everyday case it was
// paying a 750ms clearance for). A human cannot deliberately tap twice in
// under ~250ms, but two GENUINELY separate identical actions (e.g. two dot
// balls in a row) are realistically hundreds of milliseconds to seconds
// apart in live play — 250ms still catches one physical tap read twice
// (a double-fired handler, a bouncing courtside tap) without swallowing a
// scorer's fast but deliberate second entry.
export const DOUBLE_SUBMIT_WINDOW_MS = 250;

/**
 * The floor this guard must stay under: the fastest a SCORER can deliberately
 * repeat a tap on the same target and mean both.
 *
 * A claim about people, not about code, which is why it is a named constant
 * rather than a number inside one test. Sustained deliberate tapping tops out
 * around 5-8 taps/sec (125-200ms); 350ms leaves headroom above even the fast
 * end, so a window below this cannot be eating a tap anybody meant.
 *
 * It exists so `DOUBLE_SUBMIT_WINDOW_MS` can be held to it by a test. R7-46's
 * first attempt paced its e2e run at `DOUBLE_SUBMIT_WINDOW_MS + 100` — which
 * reads as careful (R7-19: derive the expected value from the source of truth)
 * and is in fact a TAUTOLOGY: raise the window to 600 and the pace follows to
 * 700, so the test passes at every possible value and can never witness the
 * regression it exists for. The relationship worth pinning is not "the pace
 * clears the window", it is "the window stays out of human range" — and that
 * one has a side it can fail on.
 */
export const HUMAN_FASTEST_REPEAT_MS = 350;

// A stable module-level fallback, not `params.auth ?? { kind: "session" }`
// inline at call time — the latter would allocate a NEW object every render
// whenever a caller omits `auth`, and useFixtureStream's own effect depends
// on `auth` by identity, so a fresh object each render would tear down and
// resubscribe (a new token fetch, a new realtime handshake) on every render
// instead of once per mount.
// EXPORTED (2026-09-22) because the hazard above is not the hook's alone: a
// CALLER passing `auth={{ kind: "session" }}` inline re-creates it on every
// render and gets the identical teardown-and-resubscribe, which is invisible
// from inside this file. `fixture-console.tsx` did exactly that. Callers that
// want plain session auth import this constant rather than writing the literal.
export const SESSION_AUTH: PadAuthMode = { kind: "session" };

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
  /** NEXT_MATCH_STARTED only: the match to void first (`refusal-copy.ts`
   *  names it). Absent on every other refusal. */
  nextMatch?: NextMatchRef;
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
  /** The server is rate-limiting this fixture (429). NOT a connectivity
   *  failure, and deliberately not folded into `offline`: the queue keeps the
   *  tap either way, but a scorer told "Offline" while the venue wifi is fine
   *  goes and fixes the wrong thing. The bucket is per FIXTURE, so a second
   *  device on the same match can raise this without this scorer doing
   *  anything at all. */
  throttled: boolean;
  /** The most recent permanent (422-class) refusal, if any. Cleared at the
   *  start of the next submit. */
  lastRejection: RejectionInfo | null;
  /** True while a post-ack `fetchState` reconciliation read is in flight. */
  resyncing: boolean;
  /** Submit one action: folds it in immediately, then durably enqueues and
   *  drains. Never throws — a permanent rejection surfaces via
   *  `lastRejection`, a network failure via `offline`. */
  /** R8/#675 — `opts.dropWith` binds this entry's life to a still-held
   *  entry's: `queue.ts`'s `dropHeld` cascade-deletes every entry carrying
   *  that id, and the marker is DURABLE (a `PendingEvent` field, not a
   *  callback), so a reload mid-hold resumes both. See `PendingEvent.dropWith`
   *  for why an amendment needs exactly those two properties together. */
  submit: (type: string, payload: unknown, opts?: { dropWith?: string }) => Promise<void>;
  /** Task 4 fix round 1 (controller review finding 2): a public trigger for
   *  a real drain pass, with no new enqueue attached — the SAME `runDrain`
   *  this hook already runs at mount, on `online`, and after every
   *  `submit()`, just exposed rather than kept a private closure. Exists so
   *  a caller holding a released-but-not-yet-sent event (queue.ts's
   *  `releaseHeld`/`dropHeld`/`flushHeldBefore` only clear `heldUntil` —
   *  they do not themselves talk to a transport) has something to call
   *  afterward: a future Dock's "send now" action wires `onDue` (the 4th
   *  `enqueueHeld` param) to THIS. Safe to call at any time, including with
   *  an empty queue (a no-op) or while a drain is already in flight
   *  (piggybacks on it — see runDrain's own doc). */
  retryDrain: () => Promise<void>;
  /** R2 (spec §2.3 soft-commit, v3 pad host): the SAME `QueueStore` instance
   *  this hook itself drains — exposed rather than re-opened, so a caller
   *  wiring `./v3/detail-dock.tsx`'s `makeDockStore(store)` (its chip
   *  mutations/dismiss) is provably touching the store this hook's own
   *  `runDrain`/`submitHeld`/`dropHeldSubmission` all read and write, not a
   *  second, independently-opened handle a caller would otherwise have to
   *  reconstruct by re-deriving this hook's own `dbName` default
   *  (`scorepad-queue-\${fixtureId}\`, or `queueDbName` when a caller passes
   *  one) — exactly the "second data path" this wave's own brief forbids.
   *  Stable across renders (the same `useMemo` `runDrain`/`submit` already
   *  key off). */
  queueStore: QueueStore;
  /** R2 (spec §2.3): the soft-commit entry point. Builds and optimistically
   *  folds a `PendingEvent` through the EXACT SAME machinery `submit` above
   *  does — the SAME `submitInFlight`/`lastAccepted` double-submit guard,
   *  the SAME `expectedSeq`/`voidTargetSeq` computation, the SAME
   *  `pendingEnvelopes` commit (so the fold "advances immediately", spec
   *  §2.3's own wording) and the SAME `markOwn` — but enqueues the built
   *  event HELD (`queue.ts`'s `enqueueHeld`, `holdMs`/`onDue` threaded
   *  straight through) instead of a plain `enqueue`, and deliberately never
   *  calls `runDrain` itself: transmission stays deferred until `onDue`
   *  fires (the hold's own release tick, or an explicit
   *  `releaseHeld`/`dropHeld`/`flushHeldBefore` against `queueStore` above)
   *  — "only the enqueue -> send moment moves" (spec §2.3's own framing;
   *  ack/seq handling downstream is untouched by this function). Returns
   *  `null` on the identical double-submit guard `submit` itself silently
   *  no-ops on (an indistinguishable repeat within `DOUBLE_SUBMIT_WINDOW_MS`,
   *  or the same tick) — nothing new was held, so a caller has no id to open
   *  a dock against. */
  submitHeld: (
    type: string,
    payload: unknown,
    holdMs: number,
    onDue: () => void,
  ) => Promise<{ heldId: string; heldUntil: number } | null>;
  /** R2 (spec §2.3): undo INSIDE a held tap's window. Drops the entry from
   *  the queue with no network call and no `core.void` (`queue.ts`'s
   *  `dropHeld` — the event never left this device) AND rolls back the
   *  `pendingEnvelopes` entry `submitHeld` added, so the optimistic fold
   *  reverts exactly as if the tap never happened — the ONE piece of this
   *  undo `dropHeld` alone cannot do, since `pendingEnvelopes` is this
   *  hook's own private state. Mirrors the same remove-from-
   *  `pendingEnvelopes`-then-`refreshDepth` shape `runDrain`'s own
   *  permanent-rejection branch already uses for an entry leaving the queue
   *  without an ack. Returns `false`, a no-op, if `id` no longer names a
   *  currently-held entry (already sent, or already dropped) — the caller's
   *  job in that case is `submit("core.void", {event_id: id})`, exactly as
   *  today (this function makes no attempt at that fallback itself). */
  dropHeldSubmission: (id: string) => Promise<boolean>;
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
 *  confirmed value there and needs no override.
 *
 *  `confirmedId` (device-void-mine, Fix A) is the same idea for the row's ID:
 *  the server's own `AppendSuccess.event_id`, passed on the "acked" branch.
 *  When given it WINS over the idempotency key, so the ledger holds the event
 *  under the id every other writer's void will name. Absent — a pre-ack
 *  optimistic build, an "already-applied" outcome (no ack body at all), or a
 *  server that predates the field — the key stays, exactly as before, and
 *  `resolveVoidTargetId` below still translates it for this pad's own voids. */
export function pendingToEnvelope(
  fixtureId: string,
  identity: OwnIdentity,
  pending: PendingEvent,
  confirmedSeq?: number,
  confirmedId?: string,
): EventEnvelope {
  const { payload, voids } = toEnvelopeFields(pending.type, pending.payload);
  return {
    id: confirmedId ?? pending.idempotencyKey,
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
 * widening, never a real server response.
 *
 * R5 — `voids` is now carried through, from `voids_event_id` (types.ts,
 * populated at the transport boundary since this same pass). It used to be
 * dropped here, which made every FOREIGN void — one this device did not
 * submit, so `pendingToEnvelope` never built it — arrive as a `core.void`
 * naming nothing: the engine's `resolveVoids` (packages/engine/src/core/
 * events.ts) then rejected every fold from that seq on, freezing the pad
 * behind a rejection banner. Set only when non-null, so a normal (non-void)
 * row still widens to an envelope with no `voids` key at all rather than an
 * explicit `undefined`.
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
    ...(row.voids_event_id ? { voids: row.voids_event_id } : {}),
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
 *
 * R5 — see the file header's own R5 UPDATE for the full trace. "Existing
 * wins" was never really about provenance; it was about not LOSING
 * information, and the only information a wire-sourced row could ever lack
 * was a void's target (`voids_event_id`, dropped at the transport boundary
 * until this same pass). So the rule is now stated as what it always meant:
 * on a seq collision where the two copies genuinely disagree — a different
 * `.id`, or a different `.voids` — the WIRE-sourced copy wins, unless
 * adopting it would drop a void target this hook already holds
 * (`existing.voids` set, `event.voids` absent). That single exception is
 * exactly the case the old default existed to protect: `runDrain`'s
 * `pendingToEnvelope` sets `voids` for a core.void THIS device recorded,
 * and a pre-R5 (or hand-rolled) row can still arrive without one.
 *
 * Both halves of the disagreement matter, and each fixes its own crash:
 *  - `.id` — a locally-scored event keeps its CLIENT-fabricated idempotency
 *    key as its ledger id for the life of the mount after an ack WITHOUT
 *    `event_id` (which carries no row id), so a void naming the SERVER's
 *    real id could never resolve against it. Adopting the wire id can never lose anything: this hook's
 *    fabricated ids never appear in wire-sourced data.
 *  - `.voids` — the corollary. Once an id can be corrected under a seq, a
 *    void baked earlier against the OLD id has to be correctable too, or the
 *    id fix simply moves the dangling reference from one side to the other.
 *
 * Scoped to the default direction only: `runDrain`'s own `incomingWins: true`
 * ack append is untouched (the branch below is gated on
 * `!opts?.incomingWins`), so its own "the just-acked copy always wins
 * outright" guarantee still holds byte-for-byte.
 */
function mergeEnvelopesIntoLedger(
  current: readonly EventEnvelope[],
  incoming: readonly EventEnvelope[],
  opts?: { incomingWins?: boolean; incomingIsLocal?: boolean },
): EventEnvelope[] {
  const first = opts?.incomingWins ? incoming : current;
  const second = opts?.incomingWins ? current : incoming;
  const bySeq = new Map<number, EventEnvelope>();
  for (const event of first) bySeq.set(event.seq, event);
  for (const event of second) {
    const existing = bySeq.get(event.seq);
    if (existing === undefined) {
      bySeq.set(event.seq, event);
      continue;
    }
    // R5 — the wire-sourced copy wins on a real disagreement UNLESS it is
    // strictly less informative (see this function's own R5 doc above).
    // `incomingIsLocal` marks the ONE caller whose `incoming` is this
    // device's own build rather than a server read (`runDrain`'s ack
    // append): there the existing wire copy is the authoritative one, so
    // this branch must not fire.
    if (!opts?.incomingWins && !opts?.incomingIsLocal && (existing.id !== event.id || existing.voids !== event.voids)) {
      const wouldLoseVoidTarget = existing.voids !== undefined && event.voids === undefined;
      if (!wouldLoseVoidTarget) bySeq.set(event.seq, event);
    }
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * The ledger's highest known seq — NOT `events.length`. This is the WRITE
 * cursor: both `expected_seq` sites below take it, and the poll's READ cursor
 * deliberately does not (see `useFixtureStream`'s `sinceSeq` below, which
 * explains why the two want opposite errors).
 *
 * `mergeEnvelopesIntoLedger` above keys by seq into a Map and returns the
 * values sorted ascending, so the ledger is legitimately SPARSE after a 409
 * renegotiation: our ack is merged at the server's own seq (`runDrain`'s
 * `confirmedSeq`) while the foreign row that caused the conflict was only
 * read inside `resolveConflict` and never committed. `{1,2,4}` then has
 * length 3 — and a write that claims `expected_seq` 3 is claiming a slot the
 * server already filled. It earns a 409 it did not need, renegotiates into
 * another gap, and the next write repeats it from a count that is now one
 * further behind. It compounds, and that compounding is the whole reason this
 * helper exists.
 *
 * On the READ side that same under-count is not a skip but an OVER-fetch, and
 * a useful one, so the poll keeps it. Fix round 1 had moved all three cursors
 * onto the tip together; the read cursor is corrected back at its call site.
 *
 * Reads the LAST element rather than scanning for a max: the sort order is
 * that function's contract, and duplicating a max() here would let the two
 * drift apart silently.
 *
 * That contract is only worth leaning on because EVERY writer into
 * `ledgerEvents` now reduces to `mergeEnvelopesIntoLedger` — the poll/realtime
 * path, the `initialEvents`-adoption effect, `runDrain`'s ack append, AND (fix
 * round 1) the mount-time `useState` seed, which used to be a raw spread that
 * preserved the caller's order. If a future writer is added that does not go
 * through it, this function is the thing that breaks, quietly.
 */
function ledgerTipSeq(events: readonly EventEnvelope[]): number {
  return events.length === 0 ? 0 : (events[events.length - 1]?.seq ?? 0);
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

/**
 * device-void-mine, Fix B — the targets named by a `core.void` in `ledger` that
 * no row in `ledger` holds. Each is a void the engine's `resolveVoids` will
 * refuse, freezing the fold on the last good state.
 *
 * Two ways one arises, and the stream can heal neither by itself: this pad
 * holds the target under an id the server never assigned (an ack with no
 * `event_id`, see the file header), or it never held the target row at all
 * (the oldest row of a gap, which `> count` never asks for). The poll will
 * not help, because the cursor is past the target by construction; the fix is
 * one whole-ledger read. From 0, not from the target's seq: the only thing a
 * dangling void says about its target is an id this ledger does not hold, so
 * its position is exactly what is unknown.
 *
 * Only a `voids` this hook actually carries is judged — a void with no target
 * at all is a different defect (R5's wire half) with nothing to look up.
 */
function danglingVoidTargets(ledger: readonly EventEnvelope[]): string[] {
  const held = new Set(ledger.map((e) => e.id));
  const dangling = new Set<string>();
  for (const e of ledger) {
    if (e.type === "core.void" && e.voids !== undefined && !held.has(e.voids)) dangling.add(e.voids);
  }
  return [...dangling];
}

/** S12/#421 pass G — see the file header's own PASS G UPDATE for the full
 *  trace this fixes. Every `core.void` a caller ever submits names its
 *  target by whatever `.id` the timeline showed it, and that id came from
 *  exactly one of two places:
 *   - `initialEvents`/a poll (`ledgerSlotToEnvelope`) — already the server's
 *     real row id, so `event_id` needs no translation at all.
 *   - THIS hook's own `pendingToEnvelope` — the client-fabricated
 *     idempotency key (pre-ack, or after an ack WITHOUT `event_id`; an ack
 *     that names its row stamps the server's id instead — Fix A), which
 *     append-event.ts NEVER assigns as a persisted row's id (that is always a fresh `randomUUID()`, and scoring.ts never
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
 *  genuinely valid undo is never killed by one bad read.
 *
 *  S12/#421 PASS H UPDATE — the `ownEventIds`-gated path described above
 *  holds only WITHIN the mount that submitted the void; see the file
 *  header's PASS H UPDATE for the reload-shaped gap that reopened. `seq`
 *  below now prefers the DURABLE `voidTargetSeq` (captured once, at
 *  void-submit time, by `voidTargetSeqAtSubmit` just below — a live mount,
 *  never subject to that gap) over the in-memory `ownEventIds` lookup,
 *  which survives only as a fallback for a void queued before this field
 *  existed, or one whose target had not yet been acked at submit time.
 *
 *  S12/#421 PASS I — this function's own `eventId` answers the WIRE
 *  question only (what the SERVER calls the row) and is never read for the
 *  LOCAL optimistic fold's own `voids` field — see `pendingWithLocalVoidTarget`
 *  (just below `voidTargetSeqAtSubmit`) for that separate, purely-local
 *  question and why it needs an independent answer.
 *
 *  S12/#421 PASS J — `"resolved"` now ALSO carries the widened row it just
 *  fetched, as `envelope`, whenever the resolution came from a FRESH network
 *  read (never a cache hit — see the `cache.get` branch below, which never
 *  has the row itself, only the id string it already saved). This is NOT a
 *  second way to answer `pendingWithLocalVoidTarget`'s own question — the
 *  caller (`runDrain`) merges `envelope` into `ledgerEvents` itself, through
 *  the SAME `mergeEnvelopesIntoLedger` every other ledger writer already
 *  uses, so `pendingWithLocalVoidTarget` keeps reading ONLY `ledgerEvents`,
 *  unchanged, and simply finds the answer sooner. See the file header's PASS
 *  J UPDATE for the full trace and why this composes with pass I's
 *  invariant rather than competing with it. */
export type VoidTargetResolution =
  | { kind: "same"; eventId: string }
  | { kind: "resolved"; eventId: string; envelope?: EventEnvelope }
  | { kind: "unresolvable-permanent" }
  | { kind: "unresolvable-transient" };

export async function resolveVoidTargetId(
  transport: Pick<PadTransport, "listEventsSince">,
  fixtureId: string,
  targetId: string,
  voidTargetSeq: number | undefined,
  ownEventIds: ReadonlySet<string>,
  ledgerEvents: readonly EventEnvelope[],
  cache: Map<string, string>,
): Promise<VoidTargetResolution> {
  // The durable seq wins whenever present — it is what makes this correct
  // across a reload (see the file header's PASS H UPDATE). Falls back to
  // the original ownEventIds+id lookup only for a void that never had one
  // captured — see `voidTargetSeqAtSubmit`'s own doc for the two reasons
  // that happens, neither of which is "translation was actually needed and
  // we lost track of it".
  const seq =
    voidTargetSeq ?? (ownEventIds.has(targetId) ? ledgerEvents.find((e) => e.id === targetId)?.seq : undefined);
  if (seq === undefined) {
    // No durable hint, and this mount does not recognise the target as its
    // own either — the fast, common path: a target loaded from
    // initialEvents/a poll never needed translation in the first place, and
    // costs no network round trip to confirm that.
    if (!ownEventIds.has(targetId)) return { kind: "same", eventId: targetId };
    // device-void-mine, review round 1 — own, and nothing in the ledger
    // carries this key any more: the usual reason now is that the target WAS
    // acked, and its ack named the row (Fix A), so the ledger re-keyed it to
    // the server's id. `runDrain` records that key -> id pair in `cache` at
    // the ack, and it is the answer. A void queued BEFORE its target's ack
    // (offline tap, then Undo; an amendment of a still-queued original) has
    // no `voidTargetSeq` and reaches exactly this line — it used to be
    // dropped here, losing the undo while the server kept the event.
    const acked = cache.get(targetId);
    if (acked !== undefined) return { kind: "resolved", eventId: acked };
    // Claimed as own (by this mount, or durably by a prior one) but no seq
    // anywhere to resolve from, and no ack ever named it — genuinely never
    // landed.
    return { kind: "unresolvable-permanent" };
  }
  const cached = cache.get(targetId);
  // A cache hit answers the WIRE question only (the id string, saved on a
  // PRIOR fresh resolution) — it never carries the row, so it cannot widen
  // an `envelope` here. That is fine: the prior resolution that populated
  // this cache entry already merged its own `envelope` into `ledgerEvents`
  // (runDrain, below) if one was available, and `ledgerEvents` only ever
  // grows/merges from there, so a later cache hit has nothing new to add.
  if (cached !== undefined) return { kind: "resolved", eventId: cached };
  try {
    const rows = await transport.listEventsSince(fixtureId, seq - 1);
    const row = rows.find((r) => r.seq === seq);
    if (row === undefined || row.id === undefined) return { kind: "unresolvable-transient" };
    cache.set(targetId, row.id);
    // S12/#421 pass J — widen the SAME row this read just fetched into a
    // real, foldable envelope (never a fabricated placeholder — see the file
    // header's PASS J UPDATE for why that distinction matters), so the
    // caller can merge it into `ledgerEvents`. `null` here means a hand-
    // rolled test double missing `recorded_at` (ledgerSlotToEnvelope's own
    // doc) — degrades to the pre-pass-J behavior for that caller, never a
    // guess.
    const envelope = ledgerSlotToEnvelope(fixtureId, row);
    return envelope === null ? { kind: "resolved", eventId: row.id } : { kind: "resolved", eventId: row.id, envelope };
  } catch {
    return { kind: "unresolvable-transient" };
  }
}

/** S12/#421 pass H — the target's seq, captured ONCE, at void-SUBMIT time
 *  (`submit()`, below), from whatever `ledgerEvents` shows for the target
 *  RIGHT THEN. Persisted on the queued `PendingEvent` (types.ts) so
 *  `resolveVoidTargetId` above can translate a still-queued void's target id
 *  from the durable record alone, independent of `ownEventIds` — which a
 *  reload resets empty before a queued void gets a chance to drain (file
 *  header, PASS H UPDATE).
 *
 *  Gated on `ownEventIds.has(targetId)`, deliberately mirroring
 *  `resolveVoidTargetId`'s own original gate: at SUBMIT time this mount's
 *  `ownEventIds` is always warm (never subject to the reload gap — that only
 *  bites LATER, at drain time), so this is the one moment a correct verdict
 *  is cheap to get for free. Capturing a seq REGARDLESS of ownEventIds would
 *  wrongly mark a foreign/history target (loaded from initialEvents, never
 *  needing translation at all) as needing one too — turning the fast `same`
 *  path into a needless network round trip for the common case of undoing
 *  something nobody ever fabricated an id for.
 *
 *  Returns `undefined` — never a guess — when: `type` is not `core.void`;
 *  the payload's own `event_id` cannot be read at all; the target is not
 *  (yet, or ever) one of THIS mount's own submissions; or the target IS own
 *  but has not been acked yet (still sitting in `pendingEnvelopes`, not
 *  `ledgerEvents`, at this exact instant). That last case does not regress:
 *  nothing enqueues a void before its target exists, and `runDrain`'s strict
 *  FIFO order guarantees the target settles (acked into `ledgerEvents`, or
 *  permanently rejected) before this void's own turn ever comes up, whether
 *  that happens in this same drain pass or a later one after a reload — see
 *  `resolveVoidTargetId`'s own ownEventIds fallback for that path. */
function voidTargetSeqAtSubmit(
  type: string,
  payload: unknown,
  ownEventIds: ReadonlySet<string>,
  ledgerEvents: readonly EventEnvelope[],
): number | undefined {
  if (type !== "core.void") return undefined;
  const targetId = extractVoidEventId(payload);
  if (targetId === null || !ownEventIds.has(targetId)) return undefined;
  return ledgerEvents.find((e) => e.id === targetId)?.seq;
}

/** S12/#421 pass I — retarget a core.void `PendingEvent`'s payload so its
 *  LOCAL optimistic-fold envelope (built by `pendingToEnvelope`) references
 *  whatever id `ledgerEvents` ITSELF currently holds for the durably
 *  recorded target seq, rather than whatever id the caller originally
 *  queued it under. See the file header's PASS I UPDATE for the full trace
 *  this closes.
 *
 *  A DIFFERENT question from `resolveVoidTargetId`'s own `eventId`, despite
 *  both existing to retarget the same void: that function answers "what id
 *  does the SERVER use for this row" (a network read, needed because the
 *  wire request must name a row the server itself recognises). This
 *  function answers "what id does THIS HOOK'S OWN `ledgerEvents` use for it
 *  right now" — the engine's own `resolveVoids`
 *  (packages/engine/src/core/events.ts) matches a void's `voids` field
 *  against `.id` in the SAME list being folded and has no concept of a
 *  server truth beyond whatever this hook has already merged in. The two
 *  answers usually coincide (a foreign/history target's `ledgerEvents` id
 *  IS the server id) but diverge for exactly the case this pass fixes: a
 *  target THIS hook itself submitted and acked WITHOUT an `event_id` keeps
 *  its CLIENT-fabricated id in `ledgerEvents` forever, within the mount that
 *  acked it (pass F's `incomingWins: true`), and only starts showing the server id once a
 *  reload re-seeds `ledgerEvents` from `initialEvents`
 *  (`ledgerSlotToEnvelope`'s own `id: row.id`).
 *
 *  Purely local and synchronous — a `voidTargetSeq` lookup against
 *  `ledgerEvents`, no network call — so it is safe to call from the
 *  mount-time leftover-queue resume effect too, BEFORE `runDrain`'s own
 *  async wire resolution has even started; that matters because the resume
 *  effect builds its OWN pre-send optimistic entry independently (never
 *  reused by runDrain's later ack), and an untranslated entry there throws
 *  transiently for however many renders it takes the drain to actually
 *  resolve and re-ack — long enough to set `lastRejection` via
 *  `foldedState`'s own catch and leave it stuck there, since nothing clears
 *  it on a later SUCCESSFUL fold (only a fresh `submit()` call does), even
 *  once the wire and the ledger both end up correct.
 *
 *  A no-op (returns `pending` unchanged) whenever: not a core.void; no
 *  durable `voidTargetSeq` (pre-pass-H record, or a target not yet acked at
 *  submit time — the pre-existing `ownEventIds`-only fallback territory,
 *  unaffected by this pass); `ledgerEvents` has no row at that seq yet
 *  (nothing to retarget to — S12/#421 pass J now merges a wire-confirmed row
 *  into `ledgerEvents` as SOON as `resolveVoidTargetId` fetches it, so this
 *  case no longer survives all the way to `runDrain`'s own ack build; it can
 *  still be hit TRANSIENTLY, e.g. the mount-time resume effect's seed step
 *  below, which runs before that resolution has even started); or the row
 *  already sits under the SAME id the payload already names (the common
 *  case — this only ever changes anything post-reload). NOT applied at
 *  `submit()`'s own first-ever pre-send build: `voidTargetSeqAtSubmit` above
 *  only ever sets `voidTargetSeq` by finding the target in `ledgerEvents` BY
 *  THAT EXACT `targetId` in the first place, so at that one call site this
 *  would provably always be a no-op — see that call site's own comment
 *  (Q8) for why this is an assumption tied to `voidTargetSeqAtSubmit`'s
 *  CURRENT implementation, not a standing guarantee.
 *
 *  device-void-mine, review round 1 — `serverIds` (the hook's key -> server
 *  id map, `voidTargetServerIdRef`) answers first, for the one void the seq
 *  lookup cannot: one queued BEFORE its target's ack, so it carries no
 *  `voidTargetSeq`, whose target the ack then re-keyed (Fix A). Taken only
 *  when the ledger really holds a row under the mapped id — the map is also
 *  fed by `resolveVoidTargetId`'s network reads, and those name the server's
 *  row whether or not this ledger has adopted that id yet. */
function pendingWithLocalVoidTarget(
  pending: PendingEvent,
  ledgerEvents: readonly EventEnvelope[],
  serverIds: ReadonlyMap<string, string>,
): PendingEvent {
  if (pending.type !== "core.void") return pending;
  const targetId = extractVoidEventId(pending.payload);
  if (targetId === null) return pending;
  const mapped = serverIds.get(targetId);
  if (mapped !== undefined && mapped !== targetId && ledgerEvents.some((e) => e.id === mapped)) {
    return { ...pending, payload: { event_id: mapped } };
  }
  if (pending.voidTargetSeq === undefined) return pending;
  const localRow = ledgerEvents.find((e) => e.seq === pending.voidTargetSeq);
  if (localRow === undefined || localRow.id === targetId) return pending;
  return { ...pending, payload: { event_id: localRow.id } };
}

export function usePadPipeline(params: UsePadPipelineParams): UsePadPipelineResult {
  const { fixtureId, module: sportModule, cfg, lineups, identity, transport } = params;
  const dbName = params.queueDbName ?? `scorepad-queue-${fixtureId}`;

  const store = useMemo(() => indexedDbQueueStore(dbName), [dbName]);

  // W3 task 1 fix round 1 — seeded THROUGH `mergeEnvelopesIntoLedger`, not by
  // a raw spread. This was the one writer into `ledgerEvents` that bypassed
  // that primitive, and a raw spread preserves whatever order the caller
  // handed down. `.length` did not care; `ledgerTipSeq` does — it reads the
  // LAST element on the strength of that function's ascending-sort contract,
  // so a seed that never touched it left the tip resting on an invariant
  // nothing enforced. Both real loaders order by seq
  // (`server/usecases/fixtures.ts` `listEvents`), so this is not live today —
  // but `v3/pad-host.tsx` takes `initialEvents` from any caller, and an
  // unsorted batch would have made the tip silently wrong rather than loudly.
  // Seeding through the primitive closes it at the source, which is better
  // than a max() fallback inside `ledgerTipSeq`: a second max here is exactly
  // the duplicated-sort-logic drift that helper's own doc warns against.
  const [ledgerEvents, setLedgerEvents] = useState<EventEnvelope[]>(() =>
    mergeEnvelopesIntoLedger([], params.initialEvents ?? []),
  );
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
  // Filled two ways: a resolution's network read, and (device-void-mine,
  // review round 1) `runDrain`'s ack whenever the ledger re-keys the event.
  // A plain ref: purely internal bookkeeping, never read by a caller, and a
  // cache write must never itself trigger a render.
  const voidTargetServerIdRef = useRef<Map<string, string>>(new Map());

  const [queueDepth, setQueueDepth] = useState(0);
  const [offline, setOffline] = useState(false);
  // Separate from `offline` on purpose — see the field's own JSDoc.
  const [throttled, setThrottled] = useState(false);
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
  //
  // device-void-mine, Fix B — a batch that leaves a void dangling
  // (`danglingVoidTargets`) is NOT committed as-is. The ledger is re-read from
  // 0, the rows the void names are merged in by the SAME default-direction
  // merge (which adopts the wire's id for a row this pad holds under its own
  // key — R5), and only then is anything committed. Committing first would
  // flash a refusal: `foldedState` would throw on the dangling void and set a
  // `lastRejection` that nothing clears but the scorer's next tap.
  //
  // ONCE per dangling target (`healAttemptedRef`), never a loop: a void naming
  // a row the server does not hold stays refused, and later batches do not
  // re-read for it. A read that FAILS un-marks its targets, so the next tick
  // retries — courtside wifi is the normal case here, and giving up on one
  // dropped read would strand the pad until a reload. A failed read still
  // commits the batch: holding it back would stall every later row.
  //
  // Review round 1: "the next tick" includes an EMPTY one. The retry used to
  // ride on the next non-empty batch, and a quiet court may not produce one
  // for minutes — the pad sat on the undone score behind a refusal banner
  // the whole time. An empty tick now checks the ledger it already holds for
  // an un-attempted dangling void (a cheap in-memory scan) and retries the
  // read if it finds one: at most one read per tick, since a tick that
  // arrives while a read is out is dropped rather than queued behind it. On
  // realtime there are no empty ticks, so the retry there still waits for the
  // next signal.
  //
  // Non-empty batches that arrive while a heal read is in flight wait for it
  // (`healInFlightRef`), in order. Merged ahead of it they would commit the
  // same dangling void the heal is about to fix.
  //
  // A heal that adopts a target also takes down the refusal that target's
  // dangling void raised (a failed first read committed it, and the fold
  // threw) — see `clearHealedRefusal`. Nothing else would: `lastRejection`
  // is otherwise cleared only by the scorer's next tap.
  const healAttemptedRef = useRef<Set<string>>(new Set());
  const healInFlightRef = useRef<Promise<void> | null>(null);
  /** A dangling void's refusal names its target in the engine's own words
   *  (`resolveVoids`: `core.void targets unknown or non-prior event "<id>"`).
   *  Only a refusal naming a target a heal just ADOPTED is cleared — any other
   *  (a server's rejection of the scorer's own tap, a void whose target the
   *  server does not hold either) stays up. Should the healed fold still
   *  throw, `foldedState` raises it again on the next render. */
  const clearHealedRefusal = useCallback((healedIds: readonly string[]) => {
    setLastRejection((prev) =>
      prev !== null && prev.code === "INVALID_EVENT" && healedIds.some((id) => prev.message.includes(`"${id}"`))
        ? null
        : prev,
    );
  }, []);
  const onStreamEvents = useCallback(
    (events: LedgerSlotEvent[]) => {
      const apply = (batch: LedgerSlotEvent[]): void => {
        const inFlight = healInFlightRef.current;
        if (inFlight !== null) {
          if (batch.length > 0) void inFlight.then(() => apply(batch));
          return;
        }
        const merged = batch.length === 0 ? ledgerEventsRef.current : mergeLedgerEvents(fixtureId, ledgerEventsRef.current, batch);
        const dangling = danglingVoidTargets(merged).filter((id) => !healAttemptedRef.current.has(id));
        if (dangling.length === 0) {
          // An empty tick with nothing to heal is still a no-op.
          if (batch.length === 0) return;
          commitLedgerEvents(merged);
          void reconcileAfterAck(merged);
          return;
        }
        for (const id of dangling) healAttemptedRef.current.add(id);
        healInFlightRef.current = (async () => {
          let targets: LedgerSlotEvent[] = [];
          try {
            const wanted = new Set(dangling);
            const rows = await transport.listEventsSince(fixtureId, 0);
            targets = rows.filter((row) => row.id !== undefined && wanted.has(row.id));
          } catch {
            for (const id of dangling) healAttemptedRef.current.delete(id);
          }
          // A failed retry off an empty tick has nothing to commit.
          if (batch.length === 0 && targets.length === 0) return;
          // Over the CURRENT ledger, not `merged`: an ack may have landed
          // while the read was out.
          const healed = mergeLedgerEvents(
            fixtureId,
            mergeLedgerEvents(fixtureId, ledgerEventsRef.current, batch),
            targets,
          );
          commitLedgerEvents(healed);
          if (targets.length > 0) clearHealedRefusal(targets.map((row) => row.id as string));
          void reconcileAfterAck(healed);
        })().finally(() => {
          healInFlightRef.current = null;
        });
      };
      apply(events);
    },
    [fixtureId, transport, commitLedgerEvents, reconcileAfterAck, clearHealedRefusal],
  );
  const drainNow = useCallback(() => drainInFlight.current, []);
  useFixtureStream({
    fixtureId,
    auth: params.auth ?? SESSION_AUTH,
    // W3 task 1, fix round 1 — the COUNT here, on purpose, where both
    // `expected_seq` sites below take the TIP. A read cursor and a write
    // cursor want OPPOSITE errors, and reading this line as an oversight is
    // how round 1 got it wrong.
    //
    // `listEvents` is strict — `seq > since_seq`
    // (`server/usecases/fixtures.ts`) — and over a ledger of distinct
    // ascending positive seqs `tip >= length` ALWAYS, with equality only while
    // it is gapless from 1. So a count cursor asks for a strict SUPERSET of
    // what a tip cursor asks for: it under-shoots by exactly the width of the
    // gaps, re-requests the window `(length, tip]` on every tick, and any row
    // this pad is missing inside that window comes home. Over `{1,2,5}` it
    // asks `> 3` and recovers the organiser's seq 4. A tip cursor asks `> 5`
    // and strands seq 4 for the rest of the match — a rally the pad's fold
    // never applies, with nothing on screen to say so.
    //
    // What the under-shoot costs: while the ledger is sparse, every tick
    // re-fetches that window and runs one `reconcileAfterAck` round trip.
    // Bounded by the gap's own width, and it stops the moment the gap closes.
    //
    // What it does NOT do: heal the OLDEST missing row. `> length` still
    // excludes seq `length` itself, so a hole's first row needs an
    // `initialEvents` re-seed. Polling from `firstMissingSeq - 1` would close
    // that too; that is a separate design and deliberately not taken here.
    sinceSeq: ledgerEvents.length,
    listEventsSince: transport.listEventsSince,
    onEvents: onStreamEvents,
    writeInFlight: drainNow,
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

        // ScoringPad v3 R1 chassis soft-commit (spec §2.3, task 4): a
        // still-held entry (queue.ts's enqueueHeld) must not be sent before
        // its own release tick, or an explicit releaseHeld/flushHeldBefore,
        // clears `heldUntil` — treated exactly like an empty queue for THIS
        // drain pass, never skipped past to a later entry (expectedSeq
        // assumes strict FIFO order, so sending something behind a still-
        // held entry out of turn is not safe in general). `heldUntil` is
        // `undefined` for every event enqueued via the plain `enqueue()`
        // path — today's exact behaviour — so this is a provable no-op for
        // every existing caller; no production skin calls enqueueHeld yet
        // this wave (R1 ruling: all 11 sports still score through the plain
        // path), so this guard is presently dormant too.
        // TODO(task 4 fix round 1, Minor 2 — R2+): this guard assumes AT
        // MOST ONE held entry (flushHeldBefore's own invariant) ever sits at
        // the front — if a future wave allows more than one concurrently
        // held entry, this front-only stop needs to become a scan past the
        // held PREFIX, not just index [0].
        if (next.heldUntil !== undefined && next.heldUntil > Date.now()) break;

        // S12/#421 pass G — undo-before-reload (file header PASS G UPDATE,
        // _INDEX.md decision log). `next` itself is NEVER reassigned below —
        // `eventToSend` is the WIRE-BOUND copy, translated (if at all) to
        // whatever id `resolveVoidTargetId` proves the SERVER uses for the
        // target. S12/#421 pass I: the LOCAL fold envelope built further
        // down (the acked branch) needs a genuinely DIFFERENT answer —
        // whatever id THIS HOOK'S OWN ledgerEvents uses for the target right
        // now, which is the same as the wire id only sometimes — see
        // `pendingWithLocalVoidTarget`'s own doc for why they diverge after
        // a reload, and the file header's PASS I UPDATE for the full trace.
        let eventToSend = next;
        if (next.type === "core.void") {
          const targetId = extractVoidEventId(next.payload);
          if (targetId !== null) {
            const resolution = await resolveVoidTargetId(
              transport,
              fixtureId,
              targetId,
              next.voidTargetSeq,
              ownEventIdsRef.current,
              ledgerEventsRef.current,
              voidTargetServerIdRef.current,
            );
            // S12/#421 pass J — see the file header's PASS J UPDATE and
            // resolveVoidTargetId's own doc for the full trace: a FRESH
            // network resolution (never a cache hit) just confirmed a real
            // row for real, so merge it into `ledgerEvents` NOW, through the
            // SAME `mergeEnvelopesIntoLedger` primitive every other ledger
            // writer already uses — rather than waiting on an independent
            // poll/initialEvents catch-up that might never land before this
            // void's own ack builds its local fold envelope, below.
            // `pendingWithLocalVoidTarget` is UNCHANGED by this: it still
            // reads ONLY `ledgerEvents` (pass I's own invariant), so this
            // merely lets it find what it is looking for in THIS same drain
            // pass instead of never at all. Default "existing wins"
            // precedence (mergeEnvelopesIntoLedger's own doc) is correct
            // here too: if `ledgerEvents` already somehow holds a richer
            // entry at this seq, that entry must not be clobbered by this
            // bare polled-style row.
            if (resolution.kind === "resolved" && resolution.envelope !== undefined) {
              const withTarget = mergeEnvelopesIntoLedger(ledgerEventsRef.current, [resolution.envelope]);
              if (withTarget.length !== ledgerEventsRef.current.length) commitLedgerEvents(withTarget);
            }
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
          setThrottled(false);
          // device-void-mine, review round 1 — the event leaves
          // `pendingEnvelopes` AFTER it lands in `ledgerEvents` (below), no
          // longer before. Removed first, a void queued behind it folds for a
          // moment against a ledger with no target at all; the engine throws,
          // and the refusal that sets outlives the moment. React batches the
          // two commits into one render, but the fold must not depend on it.
          // review finding 4: "acked" may have followed a mid-flight 409
          // renegotiation (sendOne resent with a NEW expected_seq) — the
          // server's own AppendSuccess.seq is the only value guaranteed
          // correct either way. "already-applied" never renegotiates within
          // its own call (resolveConflict decides that BEFORE any resend),
          // so pendingToEnvelope's own expectedSeq+1 default is already
          // right there and needs no override.
          const confirmedSeq = outcome.kind === "acked" ? outcome.result.seq : undefined;
          // device-void-mine, Fix A — the row's REAL id, from the same ack. A
          // void written elsewhere (the device chrome's "Void my last entry",
          // the console) names the server's id and nothing else, and this
          // pad's stream never re-reads a row it already holds (its cursor is
          // the COUNT, and `listEvents` is strict), so the ack is the one
          // moment this pad can learn it. See `pendingToEnvelope`.
          const confirmedId = outcome.kind === "acked" ? outcome.result.event_id : undefined;
          // S12/#421 pass I — `next` itself still never reassigned (pass G's
          // own invariant, unchanged); pendingWithLocalVoidTarget hands
          // pendingToEnvelope a COPY with only `payload` possibly rewritten,
          // exactly like `eventToSend` above does for the wire, but answering
          // the LOCAL question instead (see that helper's own doc, and the
          // file header's PASS I UPDATE, for why the two can differ).
          const acked = pendingToEnvelope(
            fixtureId,
            identity,
            pendingWithLocalVoidTarget(next, ledgerEventsRef.current, voidTargetServerIdRef.current),
            confirmedSeq,
            confirmedId,
          );
          // S12/#421 pass F — was a raw spread
          // (`[...ledgerEventsRef.current, acked]`), never routed through
          // mergeEnvelopesIntoLedger like the other writers into
          // ledgerEvents (the poll path, the initialEvents effect, and — since
          // W3 task 1 fix round 1 — the mount seed too).
          // ledgerEventsRef.current can ALREADY hold an entry
          // at acked.seq if a poll tick (onStreamEvents) or an initialEvents
          // re-seed observed the server's committed row for this SAME event
          // before this append's own HTTP response made it back -
          // `writeInFlight: drainNow` only blocks a NEW poll from starting, not
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
          //
          // R5 — `incomingWins` is now `false` for ALREADY-APPLIED, and the
          // reasoning above survives intact for a genuine ack only. An
          // already-applied outcome means `sendOne`'s own 409 inspection
          // just PROVED the server's row for this event exists (that is the
          // only way `resolveConflict` returns it), so the ledger's copy —
          // if a poll or an `initialEvents` re-seed has already merged it —
          // is the SERVER's, under the real row id, and this locally-rebuilt
          // copy adds nothing but a client-fabricated id. Letting the local
          // copy win there is what broke the volleyball walkthrough: a tap
          // whose POST the page reload aborted MID-FLIGHT (committed
          // server-side, never acked to the client) resumed from the durable
          // queue after the reload, resolved as already-applied, and
          // overwrote the server row's id — so the console's void, naming
          // that real id, targeted nothing and every fold from there on
          // threw INVALID_EVENT. The second leg of the argument above is
          // also gone as of R5: a wire-sourced copy of a core.void now DOES
          // carry `voids` (transport.ts / `ledgerSlotToEnvelope`), so it can
          // no longer fold as a silent no-op. The FIRST leg — `ownEventIds`
          // attribution — is preserved explicitly below instead of by
          // forcing the local copy to win.
          const withAck = mergeEnvelopesIntoLedger(ledgerEventsRef.current, [acked], {
            incomingWins: outcome.kind === "acked",
            incomingIsLocal: true,
          });
          // Whichever copy survived at this seq is the one every later
          // reader sees, so "is this mine" must follow it. Cheap and
          // idempotent — `markOwn` is a set insert.
          const survivor = withAck.find((e) => e.seq === acked.seq);
          if (survivor !== undefined) markOwn(survivor.id);
          commitLedgerEvents(withAck);
          // device-void-mine, review round 1 — when the ledger now holds this
          // event under an id other than the key it was queued under (Fix A's
          // `event_id`, or R5's already-applied adopting the server's copy),
          // a void queued BEFORE this ack still names the key. Record the pair
          // where `resolveVoidTargetId` (the wire) and
          // `pendingWithLocalVoidTarget` (the local fold) both look, and move
          // any such void's optimistic envelope onto the new id in the SAME
          // commit that retires this event from `pendingEnvelopes` — so no
          // fold ever sees the re-keyed target beside a void still naming the
          // key.
          const rekeyedTo = survivor !== undefined && survivor.id !== next.idempotencyKey ? survivor.id : null;
          if (rekeyedTo !== null) voidTargetServerIdRef.current.set(next.idempotencyKey, rekeyedTo);
          const remaining = new Map(pendingEnvelopesRef.current);
          remaining.delete(next.idempotencyKey);
          if (rekeyedTo !== null) {
            for (const [key, env] of remaining) {
              if (env.type === "core.void" && env.voids === next.idempotencyKey) remaining.set(key, { ...env, voids: rekeyedTo });
            }
          }
          commitPendingEnvelopes(remaining);
          void reconcileAfterAck(withAck);
        } else if (outcome.kind === "rejected") {
          setOffline(false);
          // Cleared on every resolved outcome, exactly like `offline` — a
          // chip that latches "Catching up" forever lies the other way.
          setThrottled(false);
          setLastRejection(
            outcome.nextMatch
              ? { code: outcome.code, message: outcome.message, nextMatch: outcome.nextMatch }
              : { code: outcome.code, message: outcome.message },
          );
          const remaining = new Map(pendingEnvelopesRef.current);
          remaining.delete(next.idempotencyKey);
          commitPendingEnvelopes(remaining);
        } else {
          // stayed-queued: network failure, throttling, or an indeterminate
          // 409 — stop here, in order, exactly like pipeline.ts's drainQueue.
          setOffline(outcome.reason === "network");
          setThrottled(outcome.reason === "throttled");
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
    // Task 4 fix round 1 (controller review finding 1): timers re-armed
    // below for a leftover HELD entry, so unmounting before one fires can
    // clear it rather than leave it referencing a stale closure.
    const rearmedHoldTimers: ReturnType<typeof setTimeout>[] = [];
    void (async () => {
      const leftover = await peekInOrder(store);
      if (cancelled) return;
      if (leftover.length > 0) {
        const seeded = new Map(pendingEnvelopesRef.current);
        for (const p of leftover) {
          // S12/#421 pass I — retarget a RESUMED void's pre-send optimistic
          // entry too, not just runDrain's later ack: see
          // pendingWithLocalVoidTarget's own doc for why an untranslated
          // entry here throws transiently and leaves a stale lastRejection,
          // even though the drain below eventually resolves and acks it
          // correctly.
          seeded.set(p.idempotencyKey, pendingToEnvelope(fixtureId, identity, pendingWithLocalVoidTarget(p, ledgerEventsRef.current, voidTargetServerIdRef.current)));
          // S12/#421 — this device's own leftover queue (IndexedDB is
          // browser/device-local), so it was unquestionably submitted under
          // THIS `identity`, exactly like a fresh submit() below.
          markOwn(p.idempotencyKey);
          // Task 4 fix round 1 (controller review finding 1): a leftover
          // entry can carry `heldUntil` from a BEFORE-reload enqueueHeld —
          // its original release tick was a live JS closure (queue.ts's
          // ticksByStore registry, in-memory only by design) that died with
          // the tab. Without this, runDrain below correctly SKIPS it as
          // still-held (the guard a few lines up in this file), but nothing
          // would ever call runDrain again on its behalf — no interval/poll
          // exists anywhere in this hook, only this mount effect once, the
          // `online` listener, and submit(). Left alone, a scorer who taps,
          // reloads mid-window, and leaves the tab open+online would have
          // that event sit unsent indefinitely, not merely late. Re-arm a
          // FRESH tick for its REMAINING window (never a new full holdMs —
          // `heldUntil` is an absolute deadline, unaffected by the reload).
          // `releaseHeld` clears `heldUntil` (idempotent no-op if something
          // else — e.g. a fast concurrent flushHeldBefore from a new tap —
          // already resolved it first); the explicit `runDrain()` after it
          // is what actually sends, since releaseHeld itself has no live
          // `onDue` to call for a tick it never registered.
          if (p.heldUntil !== undefined) {
            const remaining = Math.max(0, p.heldUntil - Date.now());
            const timer = setTimeout(() => {
              if (cancelled) return;
              void releaseHeld(store, p.idempotencyKey).then(() => runDrain());
            }, remaining);
            rearmedHoldTimers.push(timer);
          }
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
      for (const timer of rearmedHoldTimers) clearTimeout(timer);
    };
    // Deliberately mount-only: `runDrain`/`refreshDepth` read fresh state via
    // refs/the store itself, so re-subscribing on every identity change would
    // only add churn, not correctness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = useCallback(
    async (type: string, payload: unknown, opts?: { dropWith?: string }) => {
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
        // R7-46 — visible for the same reason the window guard below is; see
        // `submitHeld`'s copy of this guard for the full note. Both guards in
        // BOTH functions now refuse through `lastRejection`, so there is no
        // remaining path by which the pipeline drops a tap in silence.
        setLastRejection({ code: "DOUBLE_SUBMIT", message: "" });
        return; // identical action already mid-flight this same tick — no-op
      }
      const now = Date.now();
      const last = lastAccepted.current;
      // `last !== null` first, so it narrows `last` for BOTH the isSameAction
      // call and the `.at` read that follows — `isSameAction`'s own null
      // check is a plain boolean return, not a type predicate, so it cannot
      // narrow `last` for TypeScript on its own.
      if (last !== null && isSameAction(last) && now - last.at < DOUBLE_SUBMIT_WINDOW_MS) {
        // R7-42/R7-30 — still refused, but no longer SILENTLY: "the pad
        // silently records less than the scorer did" was the exact defect
        // this guard shipped as. Client-only code, no ENGINE_ERROR_KEY/
        // REFUSAL_KEY entry (same posture as VOID_TARGET_UNKNOWN below) —
        // `refusalText` (refusal-copy.ts) falls through to the localized
        // generic fallback rather than showing raw English, and the scorer
        // sees SOMETHING rather than a tap that silently did nothing.
        setLastRejection({ code: "DOUBLE_SUBMIT", message: "" });
        return; // identical action accepted too recently — likely one physical tap read twice
      }
      submitInFlight.current = { type, payload };
      lastAccepted.current = { type, payload, at: now };
      try {
        // W3 task 1 — the TIP plus what is already in flight, never the
        // count. See `ledgerTipSeq` above: over a sparse {1,2,4} the count
        // claims seq 3, a slot the server already filled, and earns a 409
        // this write did not need — which renegotiates into another gap.
        const nextExpectedSeq = ledgerTipSeq(ledgerEventsRef.current) + pendingEnvelopesRef.current.size;
        // S12/#421 pass H — captured HERE, not derived later at drain time,
        // so it is correct even if this exact void is still sitting in the
        // queue after a reload wipes ownEventIds. See voidTargetSeqAtSubmit's
        // own doc for why this read is safe to trust unconditionally.
        const voidTargetSeq = voidTargetSeqAtSubmit(type, payload, ownEventIdsRef.current, ledgerEventsRef.current);
        const pending: PendingEvent = {
          localId: newId(),
          idempotencyKey: newId(),
          type,
          payload,
          expectedSeq: nextExpectedSeq,
          createdAt: new Date().toISOString(),
          attempts: 0,
          ...(voidTargetSeq === undefined ? {} : { voidTargetSeq }),
          ...(opts?.dropWith === undefined ? {} : { dropWith: opts.dropWith }),
        };
        // Review Q8 (S12/#421 pass J): deliberately NOT wrapped in
        // `pendingWithLocalVoidTarget`, unlike every OTHER place a
        // `PendingEvent` becomes a local fold envelope (runDrain's ack,
        // AND the mount-time leftover-queue resume effect's own seed step).
        // That is provably correct TODAY, not merely an oversight:
        // `voidTargetSeqAtSubmit` (just above) only ever sets
        // `pending.voidTargetSeq` by finding the target in `ledgerEvents` BY
        // THAT EXACT `targetId` in the first place, so IF `pending` is a
        // core.void with a `voidTargetSeq` here, `ledgerEvents` necessarily
        // already holds an entry at that seq under `targetId` verbatim —
        // `pendingWithLocalVoidTarget`'s own "already the same id" guard
        // would always fire, a guaranteed no-op. This is an ASSUMPTION tied
        // to `voidTargetSeqAtSubmit`'s CURRENT implementation, not an
        // inherent property of `submit()` itself — a future edit that
        // resolves `voidTargetSeq` from some OTHER source (e.g. an async
        // lookup, or a value threaded in from a caller) could quietly
        // invalidate it, and nothing here would fail loudly: this optimistic
        // pending build would just start showing a momentarily-untranslated
        // void locally, the same transient throw pendingWithLocalVoidTarget's
        // own doc already describes for the resume-effect seed step. If you
        // are changing how `voidTargetSeq` gets attached to a fresh
        // `PendingEvent`, re-verify this no-op still holds before trusting
        // it — do not just assume "everywhere else wraps it, so here should
        // too" without re-checking WHY here doesn't.
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

  // R2 (spec §2.3) — see UsePadPipelineResult.submitHeld's own doc. Mirrors
  // `submit` above almost line for line (same guard refs, same
  // expectedSeq/voidTargetSeq/pendingToEnvelope/markOwn calls) rather than
  // refactoring `submit` itself to share a helper: `submit` is this hook's
  // most heavily reviewed/tested path (26 describe blocks in this file's own
  // test suite), and this function's whole job is to be provably
  // BYTE-IDENTICAL up to the one seam that actually changes (enqueueHeld
  // instead of enqueue, no trailing runDrain) — a shared-helper refactor
  // would touch code the rest of this file depends on staying exactly as it
  // is.
  const submitHeld = useCallback(
    async (
      type: string,
      payload: unknown,
      holdMs: number,
      onDue: () => void,
    ): Promise<{ heldId: string; heldUntil: number } | null> => {
      const isSameAction = (o: { type: string; payload: unknown } | null): boolean =>
        o !== null && o.type === type && deepEqual(o.payload, payload);
      if (isSameAction(submitInFlight.current)) {
        // R7-46 — this drop is VISIBLE too, for the same reason the window
        // guard below is. There are two guards here, not one, and the R7-42
        // fix only reached the second: a same-TICK repeat (two handlers bound
        // to one physical press, a `dblclick`-shaped pair, a re-render that
        // re-invokes the dispatch) never reaches the window check at all, so
        // until now the single most literal case of "one tap read twice" was
        // still swallowed with no row, no toast and no error — the exact
        // silence R7-30 was filed about. Refusing through the same
        // `lastRejection` channel means every drop the pipeline performs is
        // one the scorer can see.
        setLastRejection({ code: "DOUBLE_SUBMIT", message: "" });
        return null; // identical action already mid-flight this same tick — no-op, same as submit()
      }
      const now = Date.now();
      const last = lastAccepted.current;
      if (last !== null && isSameAction(last) && now - last.at < DOUBLE_SUBMIT_WINDOW_MS) {
        // R7-42/R7-30 — the SAME visible-refusal fix as submit() above.
        // `submitHeld` is the copy every real v3 tap actually calls
        // (createSkinDispatch's `heldSubmit`, pad-host.tsx), so a fix that
        // only touched submit() would fix nothing a scorer ever hits.
        setLastRejection({ code: "DOUBLE_SUBMIT", message: "" });
        return null; // identical action accepted too recently — same guard submit() uses
      }
      submitInFlight.current = { type, payload };
      lastAccepted.current = { type, payload, at: now };
      try {
        // W3 task 1 — the SECOND `expected_seq` copy of this cursor, and the
        // one that matters most: `submitHeld` is what `createSkinDispatch`'s
        // `heldSubmit` routes every real v3 tap through (see the R7-42 note
        // on the guard just above, which records the same trap once already),
        // so a fix that reached only `submit()` would fix nothing a scorer
        // ever hits. Same reasoning as there — see `ledgerTipSeq` above.
        const nextExpectedSeq = ledgerTipSeq(ledgerEventsRef.current) + pendingEnvelopesRef.current.size;
        const voidTargetSeq = voidTargetSeqAtSubmit(type, payload, ownEventIdsRef.current, ledgerEventsRef.current);
        const pending: PendingEvent = {
          localId: newId(),
          idempotencyKey: newId(),
          type,
          payload,
          expectedSeq: nextExpectedSeq,
          createdAt: new Date().toISOString(),
          attempts: 0,
          ...(voidTargetSeq === undefined ? {} : { voidTargetSeq }),
        };
        const withPending = new Map(pendingEnvelopesRef.current);
        withPending.set(pending.idempotencyKey, pendingToEnvelope(fixtureId, identity, pending));
        commitPendingEnvelopes(withPending); // optimistic fold shows immediately, same as submit()
        markOwn(pending.idempotencyKey);
        setLastRejection(null);
        const heldUntil = Date.now() + holdMs;
        // Everything below is async. Deliberately NO runDrain() call here —
        // see this function's own doc: transmission stays deferred until
        // `onDue` fires.
        await enqueueHeld(store, pending, holdMs, onDue);
        await refreshDepth();
        return { heldId: pending.idempotencyKey, heldUntil };
      } finally {
        submitInFlight.current = null;
      }
    },
    [store, fixtureId, identity, commitPendingEnvelopes, markOwn, refreshDepth],
  );

  // R2 (spec §2.3) — see UsePadPipelineResult.dropHeldSubmission's own doc.
  const dropHeldSubmission = useCallback(
    async (id: string): Promise<boolean> => {
      // R8/#675 — read the bound set BEFORE the drop, because `dropHeld`
      // cascade-deletes it from the queue and it is gone afterwards. Same
      // `boundTo` rule both layers use, never a second copy of it: clearing the
      // queue while leaving the optimistic mirror holding the void is not a
      // partial fix but its own defect — the pad then shows the corrected event
      // retired with nothing in its place, which is exactly what a browser run
      // caught here.
      const boundIds = boundTo(await store.list(), id);
      const dropped = await dropHeld(store, id);
      if (!dropped) return false;
      const remaining = new Map(pendingEnvelopesRef.current);
      remaining.delete(id);
      for (const boundId of boundIds) remaining.delete(boundId);
      commitPendingEnvelopes(remaining);
      await refreshDepth();
      return true;
    },
    [store, commitPendingEnvelopes, refreshDepth],
  );

  // S12/#421 — the raw list `foldedState` above was folded from, exposed for
  // a persistent activity feed. Same combination as `foldedState`'s own
  // `events` local above, kept as a SEPARATE memo (not reused verbatim) so a
  // `serverOverride` never hides ledger events a caller's timeline still
  // needs to display, even while the FOLD is showing the server's override.
  const events = useMemo(() => [...ledgerEvents, ...pendingEnvelopes.values()], [ledgerEvents, pendingEnvelopes]);

  return {
    state: foldedState,
    summary,
    queueDepth,
    offline,
    throttled,
    lastRejection,
    resyncing,
    submit,
    events,
    ownEventIds,
    retryDrain: runDrain,
    queueStore: store,
    submitHeld,
    dropHeldSubmission,
  };
}
