// The pad's live pipeline hook (S10/#419 W8): submit -> optimistic fold ->
// durable enqueue -> drain in order -> reconcile against the server fold on
// every ack. Driven through the repo's node-only `_hook-harness` (no DOM, no
// jsdom in this workspace — apps/web/vitest.config.ts pins `environment:
// "node"`), via a tiny Probe component that reports the hook's live result
// object on every render — the established idiom for testing a standalone
// hook this way (see marketing/__tests__/use-start-on-view.test.tsx).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope, LineupPair } from "@seazn/engine/core";
import { defaultLineupPair } from "@seazn/engine/testkit";
import type { CricketBallEv, CricketCfg, CricketState } from "@seazn/engine/sports/cricket";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { foldClient, resolveModuleClient } from "../module-client";
import type { AppendCallResult, AppendEventBody } from "../pipeline";
import { HOLD_MS, enqueue, enqueueHeld } from "../queue";
import type { LedgerSlotEvent, OwnIdentity, PendingEvent } from "../types";
import type { FixtureStateResult, PadTransport } from "../transport";
import type { RealtimeConnector } from "../use-fixture-stream";
import { indexedDbQueueStore, type QueueStore } from "../queue-store";
import {
  DOUBLE_SUBMIT_WINDOW_MS,
  pendingToEnvelope,
  usePadPipeline,
  type UsePadPipelineParams,
  type UsePadPipelineResult,
} from "../use-pad-pipeline";

// S12/#421 pass H test seam: this suite's vitest environment is Node, with
// no real `indexedDB` (queue-store.ts's own documented fallback — see the
// "store fallback" describe block below, which pins that precondition).
// `indexedDbQueueStore` therefore hands back a brand-new, ISOLATED
// `memoryQueueStore()` on EVERY call regardless of dbName — fine for every
// existing test here (one mount each), but it means "two separate
// usePadPipeline mounts sharing a dbName" can never be told apart from "two
// mounts that happen to use the same string" without this seam: a real
// reload keeps IndexedDB (keyed by dbName) intact, and proving a fix
// survives one needs that same persistence in a Node test. Caches by dbName
// so a second mount reusing the SAME dbName sees the first mount's queue —
// cleared in `beforeEach` below so this can never leak state into an
// UNRELATED test that happens to reuse the same default dbName
// (`baseParams()`'s "fx-1").
const queueStoreRegistry = vi.hoisted(() => new Map<string, QueueStore>());
vi.mock("../queue-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../queue-store")>();
  return {
    ...actual,
    indexedDbQueueStore: (dbName: string): QueueStore => {
      const existing = queueStoreRegistry.get(dbName);
      if (existing !== undefined) return existing;
      const fresh = actual.memoryQueueStore();
      queueStoreRegistry.set(dbName, fresh);
      return fresh;
    },
  };
});

beforeEach(() => {
  queueStoreRegistry.clear();
});

const ME: OwnIdentity = { recordedBy: "user-1", deviceLinkId: null };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A scripted PadTransport double. `appendScript` is a FIFO of canned
 *  responses (or a fixed function) keyed by call ORDER — this hook's own
 *  drain loop calls appendEvent strictly one at a time, in order, so call
 *  order is a reliable key (unlike pipeline.test.ts's own fakeTransport,
 *  which keys by idempotency_key because it drives sendOne directly).
 *  `fetchStateImpl` defaults to folding the SAME ledger the test handed in,
 *  so reconciliation reports "match" unless a test overrides it to prove a
 *  real divergence. */
function fakeTransport(opts: {
  appendResults: AppendCallResult[];
  fetchStateImpl?: (fixtureId: string) => Promise<FixtureStateResult>;
}) {
  const appendCalls: { fixtureId: string; body: AppendEventBody }[] = [];
  const fetchStateCalls: string[] = [];
  let cursor = 0;
  const transport: PadTransport = {
    async appendEvent(fixtureId, body) {
      appendCalls.push({ fixtureId, body });
      const next = opts.appendResults[cursor];
      cursor += 1;
      if (!next) throw new Error(`fakeTransport: no scripted appendEvent response left (call #${cursor})`);
      return next;
    },
    async listEventsSince(): Promise<LedgerSlotEvent[]> {
      return [];
    },
    async getLastSeq(): Promise<number> {
      throw new Error("fakeTransport: getLastSeq not used by use-pad-pipeline");
    },
    async fetchState(fixtureId): Promise<FixtureStateResult> {
      fetchStateCalls.push(fixtureId);
      if (opts.fetchStateImpl) return opts.fetchStateImpl(fixtureId);
      return { status: "in_play", last_seq: 0, state: null, summary: null, outcome: null };
    },
  };
  return { transport, appendCalls, fetchStateCalls };
}

const success = (seq: number): AppendCallResult => ({
  kind: "ok",
  data: { seq, state_summary: { seq }, outcome: null, status: "in_play" },
});

function fakeResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** review finding 3's default test double for the live-stream wiring: the
 *  token door resolves fast, and the connector confirms SYNCHRONOUSLY
 *  inside `.connect()` (before useFixtureStream's own safety-net
 *  `startPolling()` call runs) — so by default, mounting the pipeline in
 *  any test that doesn't care about streaming NEVER arms a real
 *  `setInterval` at all (matching use-fixture-stream.test.ts's own "a
 *  confirmed subscribe means NO polling timer starts" case). Tests that DO
 *  care about the stream override `streamConnector` with `neverConfirmConnector`. */
const defaultStreamFetchFn = (async () => fakeResponse(200, { ok: true, data: { token: "t", channel: "c" } })) as unknown as typeof fetch;

function autoConfirmConnector(): RealtimeConnector {
  return {
    connect(params) {
      params.onStatus(true);
      return { unsubscribe() {} };
    },
  };
}

/** Falls back to polling every time — `onStatus` is never called, so
 *  `realtimeConfirmed` never flips true and the safety-net `startPolling()`
 *  inside `attemptRealtime` is the one that sticks. */
function neverConfirmConnector(): RealtimeConnector {
  return {
    connect() {
      return { unsubscribe() {} };
    },
  };
}

function baseParams(overrides: Partial<UsePadPipelineParams> = {}): UsePadPipelineParams {
  const generic = resolveModuleClient("generic", "1.0.0");
  return {
    fixtureId: "fx-1",
    module: generic,
    cfg: { resultMode: "win_loss", allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    lineups: defaultLineupPair(generic.positions),
    identity: ME,
    transport: fakeTransport({ appendResults: [] }).transport,
    auth: { kind: "session" },
    streamFetchFn: defaultStreamFetchFn,
    streamConnector: autoConfirmConnector(),
    ...overrides,
  };
}

/** Probe: renders the hook and reports its LATEST result via `onReady` on
 *  every render (mount + every internal setState-driven re-render) — a
 *  plain call in the component body, not an effect, so the test always has
 *  the freshest object, including `submit` bound to the freshest closures. */
function mountPipeline(params: UsePadPipelineParams) {
  let latest!: UsePadPipelineResult;
  function Probe(props: { params: UsePadPipelineParams; onReady: (r: UsePadPipelineResult) => void }) {
    const result = usePadPipeline(props.params);
    props.onReady(result);
    return null;
  }
  const island = renderIsland(Probe, { params, onReady: (r) => (latest = r) });
  return {
    get current() {
      return latest;
    },
    /** Re-render with new params — the way a parent handing down a fresh
     *  `initialEvents` after a `router.refresh()` would (S12/#421 pass E:
     *  the console chrome's "Start match" round trip). Hook state (the
     *  queue, the ledger, refs) carries over across this, exactly as it
     *  would across a real React re-render of the same component instance. */
    rerender(nextParams: UsePadPipelineParams) {
      island.rerender({ params: nextParams, onReady: (r) => (latest = r) });
    },
    /** Tear this instance down the way a real page navigation/reload would
     *  (S12/#421 pass H) — runs every mount effect's cleanup once. A FRESH
     *  `mountPipeline(...)` call afterwards is a genuinely NEW hook instance
     *  — `renderIsland` allocates new cells/refs/effects per call — unlike
     *  `rerender` above, which keeps THIS instance (and its `ownEventIds`)
     *  alive. Pairing `unmount()` with a fresh `mountPipeline` is how this
     *  suite tells "survives a real reload" apart from "survives a
     *  re-render". */
    unmount() {
      island.unmount();
    },
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("usePadPipeline — mount", () => {
  it("folds initialEvents into the initial state+summary with an empty queue", () => {
    const params = baseParams({
      initialEvents: [
        {
          id: "e-1",
          fixtureId: "fx-1",
          seq: 1,
          type: "core.start",
          payload: {},
          recordedAt: "2026-08-12T00:00:00.000Z",
          recordedBy: "user-1",
        },
        {
          id: "e-2",
          fixtureId: "fx-1",
          seq: 2,
          type: "generic.score",
          payload: { by: "H", points: 3 },
          recordedAt: "2026-08-12T00:00:01.000Z",
          recordedBy: "user-1",
        },
      ],
    });
    const pad = mountPipeline(params);
    expect(pad.current.queueDepth).toBe(0);
    expect(pad.current.offline).toBe(false);
    expect(pad.current.lastRejection).toBeNull();
    // GenericState.running is OPTIONAL (undefined until the first score
    // event) — folding both initialEvents proves the hook actually replays
    // the whole ledger through the module's own fold, not just `init()`.
    expect((pad.current.state as { running: unknown }).running).toEqual({ home: 3, away: 0 });
  });
});

describe("usePadPipeline — optimistic fold", () => {
  it("shows the optimistic fold synchronously, before the network call resolves", async () => {
    const gate = deferred<AppendCallResult>();
    const transport: PadTransport = {
      async appendEvent() {
        return gate.promise;
      },
      async listEventsSince() {
        return [];
      },
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 0, state: null, summary: null, outcome: null };
      },
    };
    const pad = mountPipeline(baseParams({ transport }));

    // GenericState.running is OPTIONAL and unset before any score event.
    expect((pad.current.state as { running: unknown }).running).toBeUndefined();
    const submitPromise = pad.current.submit("generic.score", { by: "H", points: 3 });
    // No await yet — the optimistic fold must already be visible from the
    // SYNCHRONOUS portion of submit() (before its first network await).
    expect((pad.current.state as { running: { home: number; away: number } }).running).toEqual({ home: 3, away: 0 });

    gate.resolve(success(1));
    await submitPromise;
  });
});

describe("usePadPipeline — reconciliation on ack", () => {
  it("a matching server fold leaves the displayed state as the local fold computed it", async () => {
    const mod = resolveModuleClient("generic", "1.0.0");
    const cfg = { resultMode: "win_loss", allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false };
    const lineups = defaultLineupPair(mod.positions);
    // Independently computed via the SAME foldClient the hook uses — proves
    // the actual "match" branch of reconcile() fires (not merely that the
    // null-guard skipped comparison). Envelope metadata (id/seq/recordedAt)
    // differing from what the hook itself constructs is fine: GenericState
    // carries no per-event bookkeeping, only the resulting score.
    const matchingState = foldClient(mod, cfg, lineups, [
      {
        id: "independent",
        fixtureId: "fx-1",
        seq: 1,
        type: "generic.score",
        payload: { by: "H", points: 3 },
        recordedAt: "2026-08-12T00:00:00.000Z",
        recordedBy: "user-1",
      },
    ]);
    const { transport } = fakeTransport({
      appendResults: [success(1)],
      fetchStateImpl: async () => ({ status: "in_play", last_seq: 1, state: matchingState, summary: null, outcome: null }),
    });
    const pad = mountPipeline(baseParams({ module: mod, cfg, lineups, transport }));
    await pad.current.submit("generic.score", { by: "H", points: 3 });
    expect((pad.current.state as { running: { home: number; away: number } }).running).toEqual({ home: 3, away: 0 });
    expect(pad.current.state).toEqual(matchingState);
    expect(pad.current.resyncing).toBe(false);
  });

  it("MUTATION TARGET: a diverging server fold on ack WINS over the local optimistic one", async () => {
    const mod = resolveModuleClient("generic", "1.0.0");
    const cfg = { resultMode: "win_loss", allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false };
    const lineups = defaultLineupPair(mod.positions);
    // A REALISTIC diverged state — produced by the real fold (so
    // `.summary()` can actually process it, matching a real GET /state
    // response), just over events a CONCURRENT scorer would have added that
    // this hook's own optimistic fold has no way to know about: two score
    // events instead of the one this hook itself submitted.
    const divergedServerState = foldClient(mod, cfg, lineups, [
      {
        id: "concurrent-1",
        fixtureId: "fx-1",
        seq: 1,
        type: "generic.score",
        payload: { by: "H", points: 3 },
        recordedAt: "2026-08-12T00:00:00.000Z",
        recordedBy: "user-2",
      },
      {
        id: "concurrent-2",
        fixtureId: "fx-1",
        seq: 2,
        type: "generic.score",
        payload: { by: "A", points: 3 },
        recordedAt: "2026-08-12T00:00:01.000Z",
        recordedBy: "user-2",
      },
    ]);
    const { transport } = fakeTransport({
      appendResults: [success(1)],
      fetchStateImpl: async () => ({
        status: "in_play",
        last_seq: 1,
        state: divergedServerState,
        summary: null,
        outcome: null,
      }),
    });
    const pad = mountPipeline(baseParams({ module: mod, cfg, lineups, transport }));
    await pad.current.submit("generic.score", { by: "H", points: 3 });
    // reconcileAfterAck runs fire-and-forget alongside the drain loop (so a
    // slow reconciliation read never blocks the NEXT queued event) — give
    // its one `await transport.fetchState(...)` a tick to settle.
    await tick();
    // The LOCAL fold would compute {home:3, away:0} — the server's diverged
    // value must win instead.
    expect(pad.current.state).toEqual(divergedServerState);
  });

  it("resyncing is true while the post-ack fetchState read is in flight", async () => {
    const gate = deferred<FixtureStateResult>();
    const { transport } = fakeTransport({
      appendResults: [success(1)],
      fetchStateImpl: async () => gate.promise,
    });
    const pad = mountPipeline(baseParams({ transport }));
    await pad.current.submit("generic.score", { by: "H", points: 3 });
    await tick();
    expect(pad.current.resyncing).toBe(true);
    gate.resolve({ status: "in_play", last_seq: 1, state: (pad.current.state as object), summary: null, outcome: null });
    await tick();
    expect(pad.current.resyncing).toBe(false);
  });
});

describe("usePadPipeline — queue depth across a real multi-event drain", () => {
  it("is non-zero mid-drain (2 queued), shrinks to 1, then to 0 — not merely 0 at the end", async () => {
    const gate1 = deferred<AppendCallResult>();
    const gate2 = deferred<AppendCallResult>();
    let calls = 0;
    const transport: PadTransport = {
      async appendEvent() {
        calls += 1;
        return calls === 1 ? gate1.promise : gate2.promise;
      },
      async listEventsSince() {
        return [];
      },
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 0, state: null, summary: null, outcome: null };
      },
    };
    const pad = mountPipeline(baseParams({ transport }));

    const p1 = pad.current.submit("generic.score", { by: "H", points: 1 });
    await tick();
    expect(pad.current.queueDepth).toBe(1); // event 1 sent, not yet acked

    const p2 = pad.current.submit("generic.score", { by: "A", points: 1 });
    await tick();
    expect(pad.current.queueDepth).toBe(2); // BOTH queued — event 1 still stuck on gate1

    gate1.resolve(success(1));
    await tick();
    expect(pad.current.queueDepth).toBe(1); // shrank: event 1 acked, event 2 now in flight

    gate2.resolve(success(2));
    await Promise.all([p1, p2]);
    expect(pad.current.queueDepth).toBe(0);
  });
});

describe("usePadPipeline — offline flag", () => {
  it("is authoritative from the transport's own network failures, and clears on a subsequent success", async () => {
    let shouldFail = true;
    const transport: PadTransport = {
      async appendEvent() {
        if (shouldFail) return { kind: "network-error", message: "offline" };
        return success(1);
      },
      async listEventsSince() {
        return [];
      },
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 0, state: null, summary: null, outcome: null };
      },
    };
    const pad = mountPipeline(baseParams({ transport }));

    await pad.current.submit("generic.score", { by: "H", points: 1 });
    expect(pad.current.offline).toBe(true);
    expect(pad.current.queueDepth).toBe(1); // stayed queued, never dropped

    shouldFail = false;
    await pad.current.submit("generic.score", { by: "A", points: 1 }); // retries the whole queue
    expect(pad.current.offline).toBe(false);
    expect(pad.current.queueDepth).toBe(0);
  });
});

describe("usePadPipeline — lastRejection", () => {
  it("captures a 422-class permanent rejection and clears it on the next submit", async () => {
    const { transport } = fakeTransport({
      appendResults: [
        { kind: "rejected", code: "INVALID_EVENT", message: "unknown entrant" },
        success(1),
      ],
    });
    const pad = mountPipeline(baseParams({ transport }));

    await pad.current.submit("generic.score", { by: "H", points: 1 });
    expect(pad.current.lastRejection).toEqual({ code: "INVALID_EVENT", message: "unknown entrant" });
    expect(pad.current.queueDepth).toBe(0); // poison removed, not retried forever

    await pad.current.submit("generic.score", { by: "A", points: 1 });
    expect(pad.current.lastRejection).toBeNull();
  });
});

describe("usePadPipeline — core.void envelope translation", () => {
  it("promotes payload.event_id into the envelope's voids field for the optimistic fold, matching scoring.ts", async () => {
    const initialEvents = [
      {
        id: "e-1",
        fixtureId: "fx-1",
        seq: 1,
        type: "core.start",
        payload: {},
        recordedAt: "2026-08-12T00:00:00.000Z",
        recordedBy: "user-1",
      },
      {
        id: "e-2",
        fixtureId: "fx-1",
        seq: 2,
        type: "generic.score",
        payload: { by: "H", points: 3 },
        recordedAt: "2026-08-12T00:00:01.000Z",
        recordedBy: "user-1",
      },
    ];
    const { transport } = fakeTransport({ appendResults: [success(3)] });
    const pad = mountPipeline(baseParams({ transport, initialEvents }));
    expect((pad.current.state as { running: { home: number; away: number } }).running).toEqual({ home: 3, away: 0 });

    // Undoing e-2 must NOT throw (CoreVoid's engine schema is z.strictObject({})
    // — an unmapped `{event_id}` payload would violate it) and must actually
    // reverse the score, proving the fold received `voids: "e-2"`, not a
    // payload the module never recognises.
    await pad.current.submit("core.void", { event_id: "e-2" });
    // With the ONLY generic.score event now voided (skipped by fold), the
    // remaining stream (core.start + core.void) never sets `running` at
    // all — it reverts to unset, not a zeroed object (same optionality as
    // the pre-score state).
    expect((pad.current.state as { running: unknown }).running).toBeUndefined();
  });
});

describe("usePadPipeline — double-submit guard (review finding 2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an in-flight guard drops a SYNCHRONOUS second submit of the identical (type, payload)", async () => {
    const { transport, appendCalls } = fakeTransport({ appendResults: [success(1), success(2)] });
    const pad = mountPipeline(baseParams({ transport }));

    const p1 = pad.current.submit("generic.score", { by: "H", points: 1 });
    const p2 = pad.current.submit("generic.score", { by: "H", points: 1 }); // same tick, same action
    await Promise.all([p1, p2]);

    expect(appendCalls).toHaveLength(1); // the second call never reached the transport
    expect(pad.current.queueDepth).toBe(0);
  });

  it("a repeat of the identical (type, payload) within the window, AFTER the first fully resolves, is also suppressed", async () => {
    const { transport, appendCalls } = fakeTransport({ appendResults: [success(1), success(2)] });
    const pad = mountPipeline(baseParams({ transport }));

    await pad.current.submit("generic.score", { by: "H", points: 1 });
    expect(appendCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(DOUBLE_SUBMIT_WINDOW_MS - 100); // still inside the window
    await pad.current.submit("generic.score", { by: "H", points: 1 }); // same action, too soon

    expect(appendCalls).toHaveLength(1); // still just one
  });

  it("two DELIBERATELY identical actions separated by MORE than the window both record — a scorer entering two dot balls in a row must not lose the second", async () => {
    const { transport, appendCalls } = fakeTransport({ appendResults: [success(1), success(2)] });
    const pad = mountPipeline(baseParams({ transport }));

    await pad.current.submit("generic.score", { by: "H", points: 1 });
    await vi.advanceTimersByTimeAsync(DOUBLE_SUBMIT_WINDOW_MS + 100);
    await pad.current.submit("generic.score", { by: "H", points: 1 });

    expect(appendCalls).toHaveLength(2); // BOTH recorded
    expect((pad.current.state as { running: { home: number; away: number } }).running).toEqual({ home: 2, away: 0 });
  });

  it("two DIFFERENT actions submitted back to back are never suppressed by the guard", async () => {
    const { transport, appendCalls } = fakeTransport({ appendResults: [success(1), success(2)] });
    const pad = mountPipeline(baseParams({ transport }));

    const p1 = pad.current.submit("generic.score", { by: "H", points: 1 });
    const p2 = pad.current.submit("generic.score", { by: "A", points: 1 }); // different payload
    await Promise.all([p1, p2]);

    expect(appendCalls).toHaveLength(2);
  });
});

describe("usePadPipeline — live stream wiring (review finding 3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a drain in flight suppresses a due poll tick — no listEventsSince call while sendOne is still awaiting", async () => {
    const gate = deferred<AppendCallResult>();
    const listEventsSince = vi.fn(async (): Promise<LedgerSlotEvent[]> => []);
    const transport: PadTransport = {
      async appendEvent() {
        return gate.promise;
      },
      listEventsSince,
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 0, state: null, summary: null, outcome: null };
      },
    };
    const pad = mountPipeline(
      baseParams({ transport, streamConnector: neverConfirmConnector(), streamPollMs: 1_000 }),
    );

    const submitPromise = pad.current.submit("generic.score", { by: "H", points: 1 }); // drain starts, gated
    await vi.advanceTimersByTimeAsync(0); // let attemptRealtime settle into polling mode

    await vi.advanceTimersByTimeAsync(1_000); // a poll tick is due WHILE the drain is still in flight
    expect(listEventsSince).not.toHaveBeenCalled(); // suppressed by skipPollWhile

    gate.resolve(success(1));
    await submitPromise;

    await vi.advanceTimersByTimeAsync(1_000); // drain finished — the NEXT tick may fetch
    expect(listEventsSince).toHaveBeenCalled();
  });

  it("an inbound stream event moves the folded state to the server's own fold", async () => {
    const mod = resolveModuleClient("generic", "1.0.0");
    const cfg = { resultMode: "win_loss", allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false };
    const lineups = defaultLineupPair(mod.positions);
    // A REAL fold over an event a CONCURRENT scorer recorded — this hook's
    // own ledger has never heard of it (matches the SCOPE BOUNDARY comment
    // at the top of this file: adopt the server's fold as-is on divergence).
    const remoteState = foldClient(mod, cfg, lineups, [
      {
        id: "concurrent-1",
        fixtureId: "fx-1",
        seq: 1,
        type: "generic.score",
        payload: { by: "A", points: 7 },
        recordedAt: "2026-08-12T00:00:00.000Z",
        recordedBy: "user-2",
      },
    ]);
    const listEventsSince = vi.fn(
      async (): Promise<LedgerSlotEvent[]> => [
        { seq: 1, type: "generic.score", payload: { by: "A", points: 7 }, recorded_by: "user-2", device_link_id: null },
      ],
    );
    const transport: PadTransport = {
      async appendEvent() {
        throw new Error("not used by this test");
      },
      listEventsSince,
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 1, state: remoteState, summary: null, outcome: null };
      },
    };
    const pad = mountPipeline(
      baseParams({ module: mod, cfg, lineups, transport, streamConnector: neverConfirmConnector(), streamPollMs: 1_000 }),
    );
    expect((pad.current.state as { running: unknown }).running).toBeUndefined(); // nothing known locally yet

    await vi.advanceTimersByTimeAsync(0); // settle into polling
    await vi.advanceTimersByTimeAsync(1_000); // first poll tick reports the remote event
    await vi.advanceTimersByTimeAsync(0); // let reconcileAfterAck's own fetchState resolve

    expect(pad.current.state).toEqual(remoteState);
  });
});

describe("pendingToEnvelope — confirmed seq override (review finding 4)", () => {
  const pending: PendingEvent = {
    localId: "local-a",
    idempotencyKey: "a",
    type: "core.note",
    payload: { text: "hi" },
    expectedSeq: 0,
    createdAt: "2026-08-12T00:00:00.000Z",
    attempts: 0,
  };

  it("defaults to expectedSeq + 1 with no override — the pre-ack optimistic guess", () => {
    expect(pendingToEnvelope("fx-1", ME, pending).seq).toBe(1);
  });

  it("MUTATION TARGET: uses the CONFIRMED seq when given one, never expectedSeq + 1 — the renegotiated-resend case", () => {
    // runDrain captures `next` (this `pending`) BEFORE calling sendOne — if
    // sendOne renegotiates (a 409 whose ledger slot is foreign) and the
    // resend succeeds, the server's ACTUAL assigned seq is whatever the
    // renegotiated expected_seq + 1 was, which has nothing to do with this
    // pending event's ORIGINAL expectedSeq (0 here). Passing the confirmed
    // seq explicitly is the only way to get it right regardless of how many
    // renegotiations happened.
    expect(pendingToEnvelope("fx-1", ME, pending, 99).seq).toBe(99);
  });
});

describe("usePadPipeline — 409 renegotiation through submit() (review finding 4)", () => {
  it("a foreign ledger slot renegotiates and resends exactly once, completing the drain — NO coverage of this path existed before", async () => {
    const appendCalls: AppendEventBody[] = [];
    let appendCallCount = 0;
    const transport: PadTransport = {
      async appendEvent(_fixtureId, body) {
        appendCalls.push(body);
        appendCallCount += 1;
        if (appendCallCount === 1) {
          return { kind: "conflict", currentSeq: 5, message: "seq conflict" };
        }
        return success(6);
      },
      async listEventsSince(): Promise<LedgerSlotEvent[]> {
        // The slot at expectedSeq(0)+1 = 1 holds a FOREIGN event — proves
        // renegotiate, not already-applied (pipeline.test.ts's own
        // "409 whose slot holds a FOREIGN event" case, driven here through
        // the HOOK instead of sendOne directly).
        return [
          { seq: 1, type: "generic.score", payload: { by: "A", points: 9 }, recorded_by: "user-2", device_link_id: null },
        ];
      },
      async getLastSeq() {
        throw new Error("not used: the conflict body already carries current_seq");
      },
      async fetchState() {
        return { status: "in_play", last_seq: 6, state: null, summary: null, outcome: null };
      },
    };
    const pad = mountPipeline(baseParams({ transport }));

    await pad.current.submit("generic.score", { by: "H", points: 1 });

    expect(appendCalls).toHaveLength(2); // original + exactly one resend
    expect(appendCalls[0]?.expected_seq).toBe(0); // original, never recomputed before sending
    expect(appendCalls[1]?.expected_seq).toBe(5); // renegotiated to the 409 body's current_seq
    expect(appendCalls[1]?.idempotency_key).toBe(appendCalls[0]?.idempotency_key); // same key, never regenerated
    expect(pad.current.queueDepth).toBe(0); // resolved, not stuck
    expect(pad.current.offline).toBe(false);
    expect(pad.current.lastRejection).toBeNull();
  });
});

describe("usePadPipeline — store fallback", () => {
  it("operates correctly under vitest's node environment, which has no indexedDB (queue-store.ts's own documented fallback)", async () => {
    expect(typeof indexedDB).toBe("undefined"); // pins the precondition this test needs
    const { transport } = fakeTransport({ appendResults: [success(1)] });
    const pad = mountPipeline(baseParams({ transport, queueDbName: "test-fallback-pipeline" }));
    await pad.current.submit("generic.score", { by: "H", points: 1 });
    expect(pad.current.queueDepth).toBe(0);
    expect((pad.current.state as { running: { home: number; away: number } }).running).toEqual({ home: 1, away: 0 });
  });
});

// S12/#421 — the timeline seam. `events` and `ownEventIds` are what
// pad-renderer.tsx now feeds `<Timeline/>` by default; wiring that render is
// pad-renderer.test.tsx's job, this file proves the HOOK's own two new
// fields are correct in isolation, including across the pending -> ledger
// transition (the case a naive "only currently-pending" marker would miss).
describe("usePadPipeline — events exposure (S12/#421 timeline seam)", () => {
  it("exposes initialEvents verbatim, oldest first, before any submit", () => {
    const params = baseParams({
      initialEvents: [
        { id: "e-1", fixtureId: "fx-1", seq: 1, type: "core.start", payload: {}, recordedAt: "2026-08-13T00:00:00.000Z", recordedBy: "user-1" },
        { id: "e-2", fixtureId: "fx-1", seq: 2, type: "generic.score", payload: { by: "H", points: 3 }, recordedAt: "2026-08-13T00:00:01.000Z", recordedBy: "user-1" },
      ],
    });
    const pad = mountPipeline(params);
    expect(pad.current.events.map((e) => e.id)).toEqual(["e-1", "e-2"]);
  });

  it("a freshly submitted, still-queued event appears in events immediately (before the network call resolves)", () => {
    const gate = deferred<AppendCallResult>();
    const transport: PadTransport = {
      async appendEvent() {
        return gate.promise;
      },
      async listEventsSince() {
        return [];
      },
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 0, state: null, summary: null, outcome: null };
      },
    };
    const pad = mountPipeline(baseParams({ transport }));
    void pad.current.submit("generic.score", { by: "H", points: 3 });
    expect(pad.current.events.some((e) => e.type === "generic.score")).toBe(true);
    gate.resolve(success(1));
  });

  it("an acked event stays in events, exactly once, after moving from pending to the durable ledger", async () => {
    const { transport } = fakeTransport({ appendResults: [success(1)] });
    const pad = mountPipeline(baseParams({ transport }));
    await pad.current.submit("generic.score", { by: "H", points: 3 });
    const matches = pad.current.events.filter((e) => e.type === "generic.score");
    expect(matches.length).toBe(1);
  });
});

describe("usePadPipeline — ownEventIds (S12/#421 timeline seam: device-link 'undo only mine')", () => {
  it("marks an event submitted through THIS hook instance as own, while still pending", () => {
    const gate = deferred<AppendCallResult>();
    const transport: PadTransport = {
      async appendEvent() {
        return gate.promise;
      },
      async listEventsSince() {
        return [];
      },
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 0, state: null, summary: null, outcome: null };
      },
    };
    const pad = mountPipeline(baseParams({ identity: { recordedBy: "user-1", deviceLinkId: "dev-1" }, transport }));
    void pad.current.submit("generic.score", { by: "H", points: 3 });
    const pendingId = pad.current.events.find((e) => e.type === "generic.score")!.id;
    expect(pad.current.ownEventIds.has(pendingId)).toBe(true);
    gate.resolve(success(1));
  });

  it("stays marked own AFTER the pending -> ledger transition (ack), under the SAME id", async () => {
    const { transport } = fakeTransport({ appendResults: [success(1)] });
    const pad = mountPipeline(baseParams({ identity: { recordedBy: "user-1", deviceLinkId: "dev-1" }, transport }));
    await pad.current.submit("generic.score", { by: "H", points: 3 });
    const ackedId = pad.current.events.find((e) => e.type === "generic.score")!.id;
    expect(pad.current.ownEventIds.has(ackedId)).toBe(true);
  });

  it("an event loaded from initialEvents (server history, not submitted by this hook instance) is NOT own", () => {
    const params = baseParams({
      initialEvents: [
        { id: "e-1", fixtureId: "fx-1", seq: 1, type: "core.start", payload: {}, recordedAt: "2026-08-13T00:00:00.000Z", recordedBy: "user-1" },
      ],
    });
    const pad = mountPipeline(params);
    expect(pad.current.ownEventIds.has("e-1")).toBe(false);
  });
});

// S12/#421 — the traced console-integration defect: the console chrome's own
// "Start match" button lives OUTSIDE the pad section in both dispatchers, so
// `core.start` is a FOREIGN write from this hook's point of view. Before this
// fix, onStreamEvents (above) discarded the polled/realtime batch outright
// and only re-verified the DISPLAY via reconcileAfterAck's serverOverride —
// so the fold BASE (what a subsequent submit() validates against) never
// learned about it, and the first scoring tap after a real match start threw
// `EngineError: ball in phase "pre"` out of the client fold. No sport was
// scoreable through the v2 console once a match started.
describe("usePadPipeline — foreign events merge into the fold base (S12/#421)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("MUTATION TARGET: a FOREIGN core.start delivered by a poll tick enters ledgerEvents/events and the OPTIMISTIC fold, not merely the display", async () => {
    const foreignRow: LedgerSlotEvent = {
      id: "foreign-start-1",
      seq: 1,
      type: "core.start",
      payload: {},
      recorded_at: "2026-08-13T00:00:00.000Z",
      recorded_by: "console-chrome-user", // the OTHER writer — never this hook's own submit()
      device_link_id: null,
    };
    const listEventsSince = vi.fn(async (): Promise<LedgerSlotEvent[]> => [foreignRow]);
    const transport: PadTransport = {
      async appendEvent() {
        throw new Error("not used by this test");
      },
      listEventsSince,
      async getLastSeq() {
        return 0;
      },
      // `state: null` — reconcileAfterAck's own documented no-op guard — so
      // `serverOverride` can NEVER fire in this test. Any `state.phase`
      // observed below is therefore necessarily the OPTIMISTIC fold's own
      // computation over ledgerEvents — proof the fold BASE changed, not
      // merely what a display-only override shows (the bug's own "the
      // DISPLAY becomes correct" description, which was already true
      // pre-fix and is deliberately NOT what this test exercises).
      async fetchState() {
        return { status: "in_play", last_seq: 1, state: null, summary: null, outcome: null };
      },
    };
    const pad = mountPipeline(
      baseParams({ transport, streamConnector: neverConfirmConnector(), streamPollMs: 1_000 }),
    );
    expect(pad.current.events).toHaveLength(0); // nothing known yet
    expect((pad.current.state as { phase: string }).phase).toBe("pre");

    await vi.advanceTimersByTimeAsync(0); // settle into polling
    await vi.advanceTimersByTimeAsync(1_000); // first poll tick reports the foreign core.start
    await vi.advanceTimersByTimeAsync(0); // let onStreamEvents' own reconcileAfterAck resolve

    expect(pad.current.events.map((e) => e.id)).toEqual(["foreign-start-1"]); // entered the fold base
    expect((pad.current.state as { phase: string }).phase).toBe("live"); // …and the OPTIMISTIC fold reflects it
  });
});

describe("usePadPipeline — offline queue survives a poll merge (S12/#421)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a still-queued LOCAL event is untouched — never dropped, never reordered — by a poll tick that merges a foreign ledger row", async () => {
    let appendShouldFail = true;
    let ackSeq = 1;
    const listEventsSince = vi.fn(
      async (): Promise<LedgerSlotEvent[]> => [
        {
          id: "foreign-1",
          seq: 1,
          type: "core.note",
          payload: { text: "concurrent" },
          recorded_at: "2026-08-13T00:00:00.000Z",
          recorded_by: "user-2",
          device_link_id: null,
        },
      ],
    );
    const transport: PadTransport = {
      async appendEvent() {
        if (appendShouldFail) return { kind: "network-error", message: "offline" };
        const seq = ackSeq;
        ackSeq += 1;
        return success(seq);
      },
      listEventsSince,
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 0, state: null, summary: null, outcome: null };
      },
    };
    const pad = mountPipeline(baseParams({ transport, streamConnector: neverConfirmConnector(), streamPollMs: 1_000 }));

    await pad.current.submit("generic.score", { by: "H", points: 1 }); // stays queued — network error
    expect(pad.current.queueDepth).toBe(1);
    const pendingIdBefore = pad.current.events.find((e) => e.type === "generic.score")!.id;

    // The drain already STOPPED (a network error, not an in-flight send —
    // sendOne returns "stayed-queued" and runDrain's own `.finally` clears
    // `drainInFlight`), so skipPollWhile does NOT suppress this poll tick.
    await vi.advanceTimersByTimeAsync(0); // settle into polling
    await vi.advanceTimersByTimeAsync(1_000); // a poll tick merges the foreign core.note
    await vi.advanceTimersByTimeAsync(0);

    expect(listEventsSince).toHaveBeenCalled(); // the merge actually ran
    expect(pad.current.queueDepth).toBe(1); // still queued — untouched by the merge
    // ledgerEvents (the merged foreign row) first, then the still-pending
    // local write, under the SAME id — never dropped, never reordered.
    expect(pad.current.events.map((e) => e.id)).toEqual(["foreign-1", pendingIdBefore]);

    appendShouldFail = false;
    await pad.current.submit("generic.score", { by: "A", points: 1 }); // retries the whole queue
    expect(pad.current.queueDepth).toBe(0);
    expect((pad.current.state as { running: { home: number; away: number } }).running).toEqual({ home: 1, away: 1 });
  });
});

describe("usePadPipeline — a throwing optimistic fold degrades instead of crashing (S12/#421)", () => {
  it("MUTATION TARGET: submit() of an action the local fold rejects surfaces lastRejection and resolves normally — never a crashed pad", async () => {
    const { transport } = fakeTransport({
      appendResults: [
        { kind: "rejected", code: "WRONG_PHASE", message: "not decided" }, // what a real server says too
        success(1),
      ],
    });
    const pad = mountPipeline(baseParams({ transport })); // fresh mount, phase "pre", no initialEvents

    // core.finalize requires phase === "done" (generic.ts) — throws
    // WRONG_PHASE on a fresh match. Without the fix, this throw escapes
    // foldedState's useMemo during the SYNCHRONOUS render
    // commitPendingEnvelopes triggers inside submit() (before its first
    // await) — propagating out of submit() as a REJECTED promise instead of
    // a resolved one, and permanently wedging the pad (the poisoned pending
    // event never leaves state, so every later render re-throws too).
    await expect(pad.current.submit("core.finalize", {})).resolves.toBeUndefined();

    expect(pad.current.lastRejection).toEqual({ code: "WRONG_PHASE", message: "not decided" });
    expect((pad.current.state as { phase: string }).phase).toBe("pre"); // degraded to the last good state
    expect(pad.current.queueDepth).toBe(0); // resolved (dropped as a permanent rejection), not stuck

    // Not bricked: a legitimate action submitted right after still works.
    await pad.current.submit("generic.score", { by: "H", points: 2 });
    expect((pad.current.state as { running: { home: number; away: number } }).running).toEqual({ home: 2, away: 0 });
    expect(pad.current.lastRejection).toBeNull(); // cleared by the fresh submit
  });
});

// S12/#421 pass E, FOURTH defect (_INDEX.md decision log, 2026-08-13): the
// console chrome's own "Start match" button lives OUTSIDE the pad section in
// both dispatchers (registry.tsx's `<ScorePad/>` only mounts the pad; the
// chrome owns the button). Measured live: `<ScorePad/>` mounts while the
// fixture is still "scheduled" (`initialEvents: []`), "Start match" appends
// `core.start` server-side, and the chrome's own `router.refresh()` hands
// THIS hook a NEW `initialEvents` prop containing it — but `ledgerEvents`
// seeds from `params.initialEvents` only in the `useState` initializer,
// which runs exactly once, at mount. React reconciles this component rather
// than remounting it, so the new prop was silently dropped: every fold after
// that validated a scoring event against a ledger missing `core.start` and
// threw, degrading to the mount-time empty fold forever. Real network trace:
// exactly one scoring event could ever be recorded, on any sport.
//
// Cricket (not generic) below on purpose for the three-submit test: its
// `cricket.ball` payload carries `over`/`ballInOver`, fields a real skin
// computes FROM the current folded state (`buildBallPayload`,
// skins/cricket-skin.tsx — not imported here, out of this session's file
// set; this test reconstructs the same state-derived shape independently so
// it does not depend on that file). A frozen fold reads back the SAME
// `ballInOver` every time, which is the real bug's own observed signature
// (`_INDEX.md`: "ballInOver is 1 on every ball"). `generic.score`'s payload
// never depends on state, so it cannot exercise this half of the defect —
// only cricket's own ball grammar can.
describe("usePadPipeline — initialEvents re-adopted after a later render, not just at mount (S12/#421 pass E)", () => {
  const FIXTURE_ID = "fx-cricket-1";
  const cricketModule = resolveModuleClient("cricket", "1.0.0");
  const cricketCfg = cricketModule.configSchema.parse(cricketModule.variants.t20) as CricketCfg;
  const bpo = cricketCfg.ballsPerOver;

  function cricketLineup(prefix: string): LineupPair["home"] {
    return {
      entrantId: prefix,
      slots: Array.from({ length: 11 }, (_, i) => ({
        personId: `${prefix}-${i + 1}`,
        slot: "starting" as const,
        orderNo: i + 1,
        ...(i === 0 ? { roles: ["captain"] } : i === 1 ? { roles: ["wicketkeeper"] } : {}),
      })),
    };
  }
  const cricketLineups: LineupPair = { home: cricketLineup("H"), away: cricketLineup("A") };

  // The console chrome's OWN write — `recordedBy` deliberately differs from
  // `ME` (the pad's own identity, defined at the top of this file) so this
  // is unambiguously a FOREIGN event, exactly like the real trace.
  const coreStart: EventEnvelope = {
    id: "console-core-start",
    fixtureId: FIXTURE_ID,
    seq: 1,
    type: "core.start",
    payload: {},
    recordedAt: "2026-08-13T00:00:00.000Z",
    recordedBy: "console-user",
  };

  /** Mirrors what a skin reads off the live fold to build the NEXT ball's
   *  payload — over/ballInOver derived from `legalBalls`, the same
   *  expression cricket.ts's own position projection uses
   *  (`(legalBalls % ballsPerOver) + 1`). Striker/nonStriker/bowler and a
   *  dot ball (`bat: 0`) throughout: no boundary, no wicket, no strike
   *  rotation, so nothing else about the ball needs to be recomputed. */
  function nextBallPayload(state: unknown): CricketBallEv {
    const innings = (state as CricketState).innings as ReadonlyArray<{ legalBalls: number }> | undefined;
    const current = innings && innings.length > 0 ? innings[innings.length - 1] : undefined;
    const legalBalls = current?.legalBalls ?? 0;
    return {
      over: Math.floor(legalBalls / bpo),
      ballInOver: (legalBalls % bpo) + 1,
      striker: "H-1",
      nonStriker: "H-2",
      bowler: "A-11",
      runs: { bat: 0 },
    };
  }

  it("MUTATION TARGET: three consecutive scoring submits each build on the fold the PREVIOUS one produced", async () => {
    const { transport, appendCalls } = fakeTransport({ appendResults: [success(2), success(3), success(4)] });
    // Mounts exactly like <ScorePad/> does while a fixture is still
    // "scheduled" — NOT pre-seeded with core.start.
    const pad = mountPipeline(
      baseParams({ fixtureId: FIXTURE_ID, module: cricketModule, cfg: cricketCfg, lineups: cricketLineups, transport }),
    );
    expect((pad.current.state as CricketState).phase).toBe("pre");

    // The console chrome's "Start match" round trip: router.refresh() hands
    // THIS hook a NEW initialEvents prop containing core.start. Nothing else
    // about the mount changes.
    pad.rerender(
      baseParams({
        fixtureId: FIXTURE_ID,
        module: cricketModule,
        cfg: cricketCfg,
        lineups: cricketLineups,
        transport,
        initialEvents: [coreStart],
      }),
    );
    expect((pad.current.state as CricketState).phase).toBe("live"); // adopted into the FOLD BASE, not merely displayed

    const first = nextBallPayload(pad.current.state);
    await pad.current.submit("cricket.ball", first);

    const second = nextBallPayload(pad.current.state);
    await pad.current.submit("cricket.ball", second);

    const third = nextBallPayload(pad.current.state);
    await pad.current.submit("cricket.ball", third);

    expect(appendCalls).toHaveLength(3);
    // The real bug's own signature: without the fix, every submit reads the
    // SAME frozen pre-first-ball state, so ballInOver is 1 every time.
    expect(third.ballInOver).not.toBe(first.ballInOver);
    expect([first.ballInOver, second.ballInOver, third.ballInOver]).toEqual([1, 2, 3]);
  });

  it("MUTATION TARGET: an acked own-event advances expected_seq for the NEXT submit — 2, not 1, after core.start + one ball", async () => {
    const appendCalls: AppendEventBody[] = [];
    let cursor = 0;
    const transport: PadTransport = {
      async appendEvent(_fixtureId, body) {
        appendCalls.push(body);
        cursor += 1;
        return success(cursor + 1); // core.start already occupies seq 1
      },
      async listEventsSince() {
        return [];
      },
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 0, state: null, summary: null, outcome: null };
      },
    };
    // Fresh generic mount, no core.start yet — matches a fixture still
    // "scheduled" at the moment <ScorePad/> first mounts.
    const pad = mountPipeline(baseParams({ transport }));
    pad.rerender(baseParams({ transport, initialEvents: [coreStart] }));

    await pad.current.submit("generic.score", { by: "H", points: 1 });
    // core.start must already be in the fold base for the FIRST submit too.
    expect(appendCalls[0]?.expected_seq).toBe(1);

    await pad.current.submit("generic.score", { by: "A", points: 1 });
    // NOT 1 — the acked ball above must have entered the fold base alongside core.start.
    expect(appendCalls[1]?.expected_seq).toBe(2);
  });
});

describe("usePadPipeline — offline queue survives an initialEvents change underneath it (S12/#421 pass E)", () => {
  it("a still-queued LOCAL event is untouched — never dropped, never reordered — when initialEvents changes underneath it", async () => {
    let appendShouldFail = true;
    let ackSeq = 3; // seq 1/2 already occupied by core.start/the foreign note below
    const transport: PadTransport = {
      async appendEvent() {
        if (appendShouldFail) return { kind: "network-error", message: "offline" };
        const seq = ackSeq;
        ackSeq += 1;
        return success(seq);
      },
      async listEventsSince() {
        return [];
      },
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 0, state: null, summary: null, outcome: null };
      },
    };
    const coreStart: EventEnvelope = {
      id: "console-core-start",
      fixtureId: "fx-1",
      seq: 1,
      type: "core.start",
      payload: {},
      recordedAt: "2026-08-13T00:00:00.000Z",
      recordedBy: "console-user",
    };
    const pad = mountPipeline(baseParams({ transport, initialEvents: [coreStart] }));

    await pad.current.submit("generic.score", { by: "H", points: 1 }); // stays queued — network error
    expect(pad.current.queueDepth).toBe(1);
    const pendingIdBefore = pad.current.events.find((e) => e.type === "generic.score")!.id;

    // A parent re-render hands down a NEW initialEvents reference carrying a
    // second, foreign event (a concurrent scorer's note) — a router.refresh()
    // landing WHILE this device is offline with work still queued. Must
    // merge the foreign event in, and must NOT touch the still-queued local
    // write.
    const foreignNote: EventEnvelope = {
      id: "foreign-note-1",
      fixtureId: "fx-1",
      seq: 2,
      type: "core.note",
      payload: { text: "concurrent" },
      recordedAt: "2026-08-13T00:00:05.000Z",
      recordedBy: "user-2",
    };
    pad.rerender(baseParams({ transport, initialEvents: [coreStart, foreignNote] }));

    expect(pad.current.queueDepth).toBe(1); // untouched by the merge
    expect(pad.current.events.map((e) => e.id)).toEqual(["console-core-start", "foreign-note-1", pendingIdBefore]);

    appendShouldFail = false;
    await pad.current.submit("generic.score", { by: "A", points: 1 }); // retries the whole queue
    expect(pad.current.queueDepth).toBe(0);
    expect((pad.current.state as { running: { home: number; away: number } }).running).toEqual({ home: 1, away: 1 });
  });
});

// S12/#421 pass F: runDrain's ack branch built its ledger append with a raw
// spread ([...ledgerEventsRef.current, pendingToEnvelope(...)]), never
// through mergeEnvelopesIntoLedger like the other two writers into
// ledgerEvents (onStreamEvents' poll path above, the initialEvents-adoption
// effect above that). If this device's own append response resolves AFTER a
// poll tick or an initialEvents re-seed has already merged the server's
// committed row for that SAME seq, the raw spread never checked for the
// collision, so BOTH entries survived at one seq, permanently, and every
// fold after it double-counted the event. Reproduced here via the
// initialEvents path (interchangeable with the poll path per the file
// header's PASS F note - both funnel through mergeEnvelopesIntoLedger).
describe("usePadPipeline — the ack append shares the ledger merge primitive (S12/#421 pass F)", () => {
  it("MUTATION TARGET: a server row for this same event merged in first (initialEvents re-seed) leaves exactly one entry at that seq once the ack resolves, and the fold does not double-count it", async () => {
    const gate = deferred<AppendCallResult>();
    const transport: PadTransport = {
      async appendEvent() {
        return gate.promise;
      },
      async listEventsSince() {
        return [];
      },
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        // state: null - reconcileAfterAck's own documented no-op guard, so
        // serverOverride can never mask what ledgerEvents/the optimistic
        // fold itself computed below (the actual thing under test).
        return { status: "in_play", last_seq: 1, state: null, summary: null, outcome: null };
      },
    };
    const pad = mountPipeline(baseParams({ transport }));

    const submitPromise = pad.current.submit("generic.score", { by: "H", points: 3 });
    await tick(); // drain reaches sendOne -> transport.appendEvent, now gated on the deferred promise

    // A poll tick or an initialEvents re-seed observes the server's
    // ALREADY-COMMITTED row for this exact event, at the seq this pending
    // submit will itself be confirmed at (seq 1: the first event on a fresh
    // fixture), before this device's own append response makes it back. Its
    // id is a fresh server-random uuid, deliberately NOT the pending event's
    // idempotencyKey - exactly what a real ledgerSlotToEnvelope widening
    // produces (append-event.ts: the persisted row's id is
    // `input.id ?? randomUUID()`, and scoring.ts never forwards the
    // client's idempotency key as that id).
    const serverRow: EventEnvelope = {
      id: "server-row-1",
      fixtureId: "fx-1",
      seq: 1,
      type: "generic.score",
      payload: { by: "H", points: 3 },
      recordedAt: "2026-08-13T00:00:05.000Z",
      recordedBy: "user-1",
    };
    pad.rerender(baseParams({ transport, initialEvents: [serverRow] }));

    // This device's OWN append response finally arrives, for the SAME event.
    gate.resolve(success(1));
    await submitPromise;

    const atSeq1 = pad.current.events.filter((e) => e.seq === 1);
    expect(atSeq1).toHaveLength(1); // never two entries at one seq
    // Not double-counted - a surviving duplicate would fold generic.score
    // twice: {home: 6, away: 0}, not {home: 3, away: 0}.
    expect((pad.current.state as { running: { home: number; away: number } }).running).toEqual({ home: 3, away: 0 });
    // The LOCAL copy must be the survivor, not the foreign-sourced one - it
    // is the only copy ownEventIds (markOwn's own id) recognises as "mine".
    expect(atSeq1[0]!.id).not.toBe("server-row-1");
    expect(pad.current.ownEventIds.has(atSeq1[0]!.id)).toBe(true);
  });

  it("MUTATION TARGET: the locally-acked envelope wins the collision - a core.void's voids field survives even though a foreign-sourced copy of the same seq has none", async () => {
    const initialEvents: EventEnvelope[] = [
      {
        id: "e-1",
        fixtureId: "fx-1",
        seq: 1,
        type: "core.start",
        payload: {},
        recordedAt: "2026-08-13T00:00:00.000Z",
        recordedBy: "user-1",
      },
      {
        id: "e-2",
        fixtureId: "fx-1",
        seq: 2,
        type: "generic.score",
        payload: { by: "H", points: 3 },
        recordedAt: "2026-08-13T00:00:01.000Z",
        recordedBy: "user-1",
      },
    ];
    const gate = deferred<AppendCallResult>();
    const transport: PadTransport = {
      async appendEvent() {
        return gate.promise;
      },
      async listEventsSince() {
        return [];
      },
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 2, state: null, summary: null, outcome: null };
      },
    };
    const pad = mountPipeline(baseParams({ transport, initialEvents }));
    expect((pad.current.state as { running: { home: number; away: number } }).running).toEqual({ home: 3, away: 0 });

    const submitPromise = pad.current.submit("core.void", { event_id: "e-2" });
    await tick();

    // A foreign-sourced widening of THIS SAME void (a poll row, or a fresh
    // initialEvents bootstrap fetched by another render) can never carry
    // `voids` - LedgerSlotEvent has no such field (types.ts) - so it folds as
    // a no-op core.void if it is allowed to be the surviving copy at this seq.
    const foreignVoidRow: EventEnvelope = {
      id: "server-void-row",
      fixtureId: "fx-1",
      seq: 3,
      type: "core.void",
      payload: {},
      recordedAt: "2026-08-13T00:00:05.000Z",
      recordedBy: "user-1",
    };
    pad.rerender(baseParams({ transport, initialEvents: [...initialEvents, foreignVoidRow] }));

    gate.resolve(success(3));
    await submitPromise;

    expect(pad.current.events.filter((e) => e.seq === 3)).toHaveLength(1);
    // If the foreign (voids-less) copy had won instead of the local one,
    // this would still read {home: 3, away: 0} - the void would have folded
    // as a no-op instead of reversing e-2.
    expect((pad.current.state as { running: unknown }).running).toBeUndefined();
  });
});

// S12/#421 pass G — undo-before-reload (_INDEX.md decision log, "the pad's
// own undo silently does nothing for an event you just scored"). A row THIS
// hook submitted keeps the client-fabricated idempotencyKey as its `id`
// forever (pendingToEnvelope, even after ack — AppendSuccess carries no row
// id at all, types.ts), and the server never recognises that string as a
// real row (append-event.ts: a persisted row's id is always randomUUID(),
// scoring.ts never forwards the client's own id — see pass F's own comment
// above for the same fact, found while fixing a different bug). Submitting
// it verbatim as core.void's event_id can therefore never resolve. Fixed by
// translating the target's LOCAL id to the server's REAL row id — by seq,
// via a targeted listEventsSince — before the void ever reaches the wire.
describe("usePadPipeline — undo a pad-submitted event with no reload (S12/#421 pass G)", () => {
  it("MUTATION TARGET: a void of a PAD-SUBMITTED event's own id resolves to the server's real row id before it hits the wire", async () => {
    const REAL_SERVER_ID = "server-real-goal-id";
    const appendCalls: AppendEventBody[] = [];
    const listEventsSinceCalls: number[] = [];
    const transport: PadTransport = {
      async appendEvent(_fixtureId, body) {
        appendCalls.push(body);
        return success(appendCalls.length);
      },
      async listEventsSince(_fixtureId, sinceSeq): Promise<LedgerSlotEvent[]> {
        listEventsSinceCalls.push(sinceSeq);
        return [
          {
            id: REAL_SERVER_ID,
            seq: 1,
            type: "generic.score",
            payload: { by: "H", points: 3 },
            recorded_at: "2026-08-13T00:00:01.000Z",
            recorded_by: "user-1",
            device_link_id: null,
          },
        ];
      },
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 1, state: null, summary: null, outcome: null };
      },
    };
    const pad = mountPipeline(baseParams({ transport }));

    await pad.current.submit("generic.score", { by: "H", points: 3 });
    const submittedId = pad.current.events.find((e) => e.type === "generic.score")!.id;
    // Pins the bug's own precondition — without the fix this IS the id
    // handleVoid would submit verbatim: the client's own idempotency key,
    // which the server has never seen as a row id.
    expect(pad.current.ownEventIds.has(submittedId)).toBe(true);

    await pad.current.submit("core.void", { event_id: submittedId });

    const voidCall = appendCalls.find((c) => c.type === "core.void");
    expect(voidCall, "the undo must reach the transport, not vanish silently").toBeTruthy();
    // THE regression: the wire payload must carry the server's real row id,
    // never the client-fabricated one the timeline happens to expose.
    expect(voidCall!.payload).toEqual({ event_id: REAL_SERVER_ID });
    expect(voidCall!.payload).not.toEqual({ event_id: submittedId });
    expect(listEventsSinceCalls.length).toBeGreaterThan(0);

    // And the fold actually reflects it — not just a well-formed but inert
    // wire call.
    expect((pad.current.state as { running: unknown }).running).toBeUndefined();
    expect(pad.current.lastRejection).toBeNull();
    expect(pad.current.queueDepth).toBe(0);
  });

  it("a void targeting a SERVER-KNOWN event (loaded from initialEvents) needs no resolution and is unaffected", async () => {
    // Guards the pre-existing 'core.void envelope translation' test's own
    // case: a foreign/history id must go straight to the wire exactly as it
    // always has, with no extra listEventsSince round trip.
    const initialEvents = [
      { id: "e-1", fixtureId: "fx-1", seq: 1, type: "core.start", payload: {}, recordedAt: "2026-08-13T00:00:00.000Z", recordedBy: "user-1" },
      { id: "e-2", fixtureId: "fx-1", seq: 2, type: "generic.score", payload: { by: "H", points: 3 }, recordedAt: "2026-08-13T00:00:01.000Z", recordedBy: "user-1" },
    ];
    const listEventsSince = vi.fn(async (): Promise<LedgerSlotEvent[]> => []);
    const appendCalls: AppendEventBody[] = [];
    const transport: PadTransport = {
      async appendEvent(_fixtureId, body) {
        appendCalls.push(body);
        return success(3);
      },
      listEventsSince,
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 2, state: null, summary: null, outcome: null };
      },
    };
    const pad = mountPipeline(baseParams({ transport, initialEvents }));

    await pad.current.submit("core.void", { event_id: "e-2" });

    expect(appendCalls[0]?.payload).toEqual({ event_id: "e-2" });
    expect(listEventsSince).not.toHaveBeenCalled();
  });

  it("MUTATION TARGET: a void whose target was never durably recorded (permanently rejected) surfaces via lastRejection instead of vanishing", async () => {
    const { transport, appendCalls } = fakeTransport({
      appendResults: [{ kind: "rejected", code: "WRONG_PHASE", message: "not decided" }],
    });
    const pad = mountPipeline(baseParams({ transport })); // core.finalize rejects on a fresh "pre" fold

    const submitPromise = pad.current.submit("core.finalize", {});
    // Synchronous optimistic id, before the network settles — the ONLY
    // window in which this id is still readable at all.
    const rejectedId = pad.current.events.find((e) => e.type === "core.finalize")!.id;
    await submitPromise;
    expect(pad.current.events.some((e) => e.id === rejectedId)).toBe(false); // dropped, never landed
    expect(pad.current.ownEventIds.has(rejectedId)).toBe(true); // but still "ours" forever

    await pad.current.submit("core.void", { event_id: rejectedId });

    expect(pad.current.lastRejection).not.toBeNull();
    expect(pad.current.queueDepth).toBe(0); // dropped, not stuck retrying forever
    expect(appendCalls.filter((c) => c.body.type === "core.void")).toHaveLength(0); // never reached the wire
  });

  it("undo still queues while OFFLINE and drains correctly once back online", async () => {
    const REAL_SERVER_ID = "server-real-goal-id-2";
    let appendMode: "ok" | "fail" = "ok";
    let listMode: "ok" | "fail" = "ok";
    let ackSeq = 1;
    const appendCalls: AppendEventBody[] = [];
    const transport: PadTransport = {
      async appendEvent(_fixtureId, body) {
        appendCalls.push(body);
        if (appendMode === "fail") return { kind: "network-error", message: "offline" };
        const seq = ackSeq;
        ackSeq += 1;
        return success(seq);
      },
      async listEventsSince(): Promise<LedgerSlotEvent[]> {
        if (listMode === "fail") throw new Error("offline");
        return [
          {
            id: REAL_SERVER_ID,
            seq: 1,
            type: "generic.score",
            payload: { by: "H", points: 3 },
            recorded_at: "2026-08-13T00:00:01.000Z",
            recorded_by: "user-1",
            device_link_id: null,
          },
        ];
      },
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 1, state: null, summary: null, outcome: null };
      },
    };
    const pad = mountPipeline(baseParams({ transport }));

    // Score ONLINE first, so there is a real, already-acked target to undo.
    await pad.current.submit("generic.score", { by: "H", points: 3 });
    const scoredId = pad.current.events.find((e) => e.type === "generic.score")!.id;
    expect(pad.current.queueDepth).toBe(0);

    // Go offline — both the send AND the resolution read fail, matching a
    // real "no network at all" state.
    appendMode = "fail";
    listMode = "fail";

    await pad.current.submit("core.void", { event_id: scoredId });
    expect(pad.current.queueDepth).toBe(1); // queued, not silently dropped
    expect(pad.current.offline).toBe(true);
    expect(pad.current.lastRejection).toBeNull(); // offline, not a permanent refusal
    expect(appendCalls.some((c) => c.type === "core.void")).toBe(false); // never even attempted the wire

    // Back online — a harmless follow-up submit retries the whole queue,
    // matching this file's own established "offline flag" test idiom (no
    // real timers/online event in this node-only harness).
    appendMode = "ok";
    listMode = "ok";
    await pad.current.submit("generic.score", { by: "A", points: 1 });

    expect(pad.current.queueDepth).toBe(0);
    expect(pad.current.offline).toBe(false);
    const voidCall = appendCalls.find((c) => c.type === "core.void");
    expect(voidCall, "the queued void must eventually drain, not stay stuck forever").toBeTruthy();
    expect(voidCall!.payload).toEqual({ event_id: REAL_SERVER_ID });
  });
});

// S12/#421 pass H — undo-before-reload, REOPENED. Pass G (above) fixed
// resolveVoidTargetId WITHIN one mount; a review found the fix held only
// there — `ownEventIds` is plain useState, reset empty on every fresh mount,
// and the mount-time "resume leftover queue" effect only re-marks a queued
// void's OWN id, never its TARGET's (an already-acked target has already
// left the queue by definition, so it is never among the "leftover" entries
// that effect iterates). So a void queued offline that survives to a
// genuine reload before it drains used to put the stale client-fabricated
// id back on the wire all over again — silently, forever. Fixed by
// persisting the target's seq on the queued PendingEvent itself
// (types.ts `voidTargetSeq`) — see use-pad-pipeline.ts's own PASS H UPDATE
// (file header and `resolveVoidTargetId`/`voidTargetSeqAtSubmit`) for the
// full trace. S12/#421 pass I extends this SAME test below: the WIRE send
// was already correct here from pass H onward (proven by the assertions
// on voidCall!.payload), but the LOCAL optimistic fold was not — see
// pendingWithLocalVoidTarget (use-pad-pipeline.ts) and the file header's
// PASS I UPDATE.
describe("usePadPipeline — undo a pad-submitted event ACROSS a reload (S12/#421 pass H)", () => {
  it("MUTATION TARGET: a queued void's target resolves to the SERVER id after a genuine unmount+remount, not the stale client-fabricated one", async () => {
    const REAL_SERVER_ID = "server-real-goal-id-reload";
    const DB_NAME = "pass-h-reload-repro";
    let appendMode: "ok" | "fail" = "ok";
    let listMode: "ok" | "fail" = "ok";
    let ackSeq = 1;
    const appendCalls: AppendEventBody[] = [];
    const listEventsSinceCalls: number[] = [];
    const transport: PadTransport = {
      async appendEvent(_fixtureId, body) {
        appendCalls.push(body);
        if (appendMode === "fail") return { kind: "network-error", message: "offline" };
        const seq = ackSeq;
        ackSeq += 1;
        return success(seq);
      },
      async listEventsSince(_fixtureId, sinceSeq): Promise<LedgerSlotEvent[]> {
        listEventsSinceCalls.push(sinceSeq);
        if (listMode === "fail") throw new Error("offline");
        return [
          {
            id: REAL_SERVER_ID,
            seq: 1,
            type: "generic.score",
            payload: { by: "H", points: 3 },
            recorded_at: "2026-08-13T00:00:01.000Z",
            recorded_by: "user-1",
            device_link_id: null,
          },
        ];
      },
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 1, state: null, summary: null, outcome: null };
      },
    };

    // Mount 1: score ONLINE (a real, already-acked target to undo — same
    // precondition as the "undo still queues while OFFLINE" test above),
    // then go offline and undo it. The void enqueues but cannot drain.
    const pad1 = mountPipeline(baseParams({ transport, queueDbName: DB_NAME }));
    await pad1.current.submit("generic.score", { by: "H", points: 3 });
    const scoredId = pad1.current.events.find((e) => e.type === "generic.score")!.id;
    // Pins the bug's own precondition — this IS the id handleVoid submits
    // verbatim: the client's own idempotency key, never a real row id.
    expect(pad1.current.ownEventIds.has(scoredId)).toBe(true);
    expect(pad1.current.queueDepth).toBe(0);

    appendMode = "fail";
    listMode = "fail";
    await pad1.current.submit("core.void", { event_id: scoredId });
    expect(pad1.current.queueDepth).toBe(1); // queued, not dropped
    expect(appendCalls.some((c) => c.type === "core.void")).toBe(false); // never reached the wire yet

    // Genuinely tear this instance down — a real page reload, not a
    // same-mount rerender (pass E's own idiom just above, and deliberately
    // NOT what this test needs: rerender keeps ownEventIds alive, which is
    // exactly the in-memory state a real reload discards).
    pad1.unmount();

    // Back online, and mount a BRAND NEW hook instance sharing the SAME
    // durable queue (this file's queueStoreRegistry mock, above) — a fresh
    // ownEventIds (empty), fresh ledgerEvents seeded from initialEvents the
    // way a real bootstrap fetch would hand back the ALREADY-ACKED scored
    // event: under its REAL server id, never the client-fabricated one.
    appendMode = "ok";
    listMode = "ok";
    const serverRow: EventEnvelope = {
      id: REAL_SERVER_ID,
      fixtureId: "fx-1",
      seq: 1,
      type: "generic.score",
      payload: { by: "H", points: 3 },
      recordedAt: "2026-08-13T00:00:01.000Z",
      recordedBy: "user-1",
    };
    const pad2 = mountPipeline(baseParams({ transport, queueDbName: DB_NAME, initialEvents: [serverRow] }));
    // The bug's own precondition, reproduced: a fresh mount never rebuilds
    // this — not immediately, and (unlike the void's OWN id) not ever, since
    // the resume effect below only re-marks leftover QUEUE entries, and the
    // already-acked target is not one.
    expect(pad2.current.ownEventIds.has(scoredId)).toBe(false);

    // The mount-time "resume leftover queue" effect drains fire-and-forget;
    // give its microtask chain room to settle. No fake timers in this
    // describe block, and nothing in this chain arms a real setTimeout —
    // streamConnector defaults to autoConfirmConnector() (baseParams()),
    // matching this file's own established "never arms setInterval" idiom
    // (see the "live stream wiring" describe block's own comment above) — so
    // a handful of real ticks is enough regardless of how deep the chain is.
    for (let i = 0; i < 5; i += 1) {
      await tick();
    }

    const voidCall = appendCalls.find((c) => c.type === "core.void");
    expect(voidCall, "the queued void must actually drain after the remount, not stay stuck forever").toBeTruthy();
    // THE regression, and the actual point of this test: the WIRE payload
    // must carry the server's real row id, resolved from the durably-
    // persisted seq — never the client-fabricated one ownEventIds alone can
    // no longer vouch for after a reload.
    expect(voidCall!.payload).toEqual({ event_id: REAL_SERVER_ID });
    expect(voidCall!.payload).not.toEqual({ event_id: scoredId });
    expect(listEventsSinceCalls.length).toBeGreaterThan(0);
    expect(pad2.current.queueDepth).toBe(0);
    // S12/#421 pass I — this is where the gap USED TO be pinned: the LOCAL
    // optimistic fold's own `voids` field kept the ORIGINAL client-fabricated
    // id even though this reload's initialEvents replaced ledgerEvents' own
    // entry for the target with the SERVER id, so the engine's own
    // resolveVoids (packages/engine/src/core/events.ts, matches `voids`
    // against `.id` in the SAME list being folded) could never find it and
    // threw INVALID_EVENT — degrading to the last good state (S3/#426 OWNER
    // RULING 2) and surfacing a rejection banner for an undo that, on the
    // wire (proven above), had already succeeded. Fixed by
    // pendingWithLocalVoidTarget (use-pad-pipeline.ts): the local fold now
    // agrees with the wire, so no rejection survives to be shown.
    expect(pad2.current.lastRejection).toBeNull();
    // And the fold actually reflects the undo — not merely a suppressed
    // banner over a still-broken fold: the scored event must be genuinely
    // reversed, exactly like the no-reload case (the "undo a pad-submitted
    // event with no reload" describe block above).
    expect((pad2.current.state as { running: unknown }).running).toBeUndefined();
  });
});

// S12/#421 pass J — the WIRE's own confirmation never reached the LOCAL
// ledger (a review of passes H and I found this residual open). Passes G/H
// made the WIRE send correct across a reload; pass I made the LOCAL
// optimistic fold agree with the wire WHEN `ledgerEvents` already happened to
// know the target (via `initialEvents` — same as the pass H/I test above,
// which seeds `initialEvents` with the target row from the very first
// render). This describe block covers the gap that left open:
// `resolveVoidTargetId` can confirm a target over the wire via its own
// network read while `ledgerEvents` has NOT independently caught up to that
// same target at all (no poll tick landed it, the bootstrap did not include
// it) — `pendingWithLocalVoidTarget` correctly no-ops on its own documented
// "nothing to retarget to" case, and nothing used to correct that
// afterward, so the untranslated client-fabricated id got baked into
// `ledgerEvents` forever at ack time. See use-pad-pipeline.ts's file header,
// PASS J UPDATE, for the full trace and the invariant that composes with
// pass I's rather than competing with it.
describe("usePadPipeline — the wire's confirmed target id reaches the local ledger too (S12/#421 pass J)", () => {
  it("MUTATION TARGET: a queued void's target resolves LOCALLY to the server id even when ledgerEvents never independently caught up", async () => {
    const REAL_SERVER_ID = "server-real-goal-id-pass-j";
    const DB_NAME = "pass-j-ledger-lag-repro";
    let appendMode: "ok" | "fail" = "ok";
    let listMode: "ok" | "fail" = "ok";
    let ackSeq = 1;
    const appendCalls: AppendEventBody[] = [];
    const listEventsSinceCalls: number[] = [];
    const transport: PadTransport = {
      async appendEvent(_fixtureId, body) {
        appendCalls.push(body);
        if (appendMode === "fail") return { kind: "network-error", message: "offline" };
        const seq = ackSeq;
        ackSeq += 1;
        return success(seq);
      },
      async listEventsSince(_fixtureId, sinceSeq): Promise<LedgerSlotEvent[]> {
        listEventsSinceCalls.push(sinceSeq);
        if (listMode === "fail") throw new Error("offline");
        return [
          {
            id: REAL_SERVER_ID,
            seq: 1,
            type: "generic.score",
            payload: { by: "H", points: 3 },
            recorded_at: "2026-08-13T00:00:01.000Z",
            recorded_by: "user-1",
            device_link_id: null,
          },
        ];
      },
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 1, state: null, summary: null, outcome: null };
      },
    };

    // Mount 1: score ONLINE, then go offline and undo it — identical setup to
    // the pass H/I reload test above (a real, already-acked target; the void
    // enqueues with a durable voidTargetSeq but cannot drain yet).
    const pad1 = mountPipeline(baseParams({ transport, queueDbName: DB_NAME }));
    await pad1.current.submit("generic.score", { by: "H", points: 3 });
    const scoredId = pad1.current.events.find((e) => e.type === "generic.score")!.id;
    expect(pad1.current.queueDepth).toBe(0);

    appendMode = "fail";
    listMode = "fail";
    await pad1.current.submit("core.void", { event_id: scoredId });
    expect(pad1.current.queueDepth).toBe(1); // queued, not dropped
    expect(appendCalls.some((c) => c.type === "core.void")).toBe(false); // never reached the wire yet
    pad1.unmount();

    // Mount 2 — a genuine reload, back online. THE DIFFERENCE from the pass
    // H/I test above: `initialEvents` is deliberately EMPTY. That test's
    // bootstrap conveniently included the target row, which is exactly why
    // pendingWithLocalVoidTarget could already translate it; this test
    // reproduces the case the review found still open — the bootstrap (or a
    // poll) has NOT caught up to the target at all, only the DURABLE
    // voidTargetSeq survived the reload.
    appendMode = "ok";
    listMode = "ok";
    const pad2 = mountPipeline(baseParams({ transport, queueDbName: DB_NAME, initialEvents: [] }));
    expect(pad2.current.ownEventIds.has(scoredId)).toBe(false); // fresh mount, as pass H already established

    for (let i = 0; i < 5; i += 1) {
      await tick();
    }

    // The wire was already correct from pass H onward — sanity-check it
    // still is, then assert the actual point of this test.
    const voidCall = appendCalls.find((c) => c.type === "core.void");
    expect(voidCall, "the queued void must still drain after the remount").toBeTruthy();
    expect(voidCall!.payload).toEqual({ event_id: REAL_SERVER_ID });
    expect(listEventsSinceCalls.length).toBeGreaterThan(0);
    expect(pad2.current.queueDepth).toBe(0);

    // THE regression: the wire-confirmed row must also have been merged into
    // this hook's OWN ledgerEvents — proving `ledgerEvents` actually caught
    // up, not merely that the wire call happened to carry the right id.
    const targetInLedger = pad2.current.events.find((e) => e.id === REAL_SERVER_ID);
    expect(targetInLedger, "the wire-confirmed target row must reach the local ledger, not just the wire").toBeTruthy();

    // And the LOCAL void envelope's own `voids` field must have been
    // translated too — the ledger must never end up holding the untranslated
    // client-fabricated id once the wire has confirmed the real one.
    const voidEnvelope = pad2.current.events.find((e) => e.type === "core.void");
    expect(voidEnvelope).toBeTruthy();
    expect(voidEnvelope!.voids).toBe(REAL_SERVER_ID);
    expect(voidEnvelope!.voids).not.toBe(scoredId);
  });
});

// S12/#421 pass J — backward compatibility for a PendingEvent already
// sitting in a real user's IndexedDB from BEFORE pass H shipped, which never
// wrote `voidTargetSeq` at all (types.ts's own field doc: "for any record
// persisted by a build predating this field — reading it as `undefined` must
// never throw, only degrade"). A review traced that this degrades cleanly
// (pendingWithLocalVoidTarget's own first guard no-ops on the missing field;
// queue.ts/queue-store.ts apply no schema validation, so an old record
// round-trips exactly as written) but nothing exercised it end to end. This
// hand-builds exactly that record — bypassing submit(), which always sets
// the field today and so cannot produce this shape — and drains it through a
// genuine fresh mount, matching a real reload.
describe("usePadPipeline — a pre-pass-H PendingEvent (no voidTargetSeq) still degrades cleanly (S12/#421 pass J backward-compat)", () => {
  it("a hand-built legacy void resolves via pass G's own ownEventIds fallback rather than crashing", async () => {
    const DB_NAME = "pass-j-legacy-pending-event";
    const STALE_ID = "client-fabricated-pre-pass-h-id";
    const listEventsSince = vi.fn(async (): Promise<LedgerSlotEvent[]> => []);
    const appendCalls: AppendEventBody[] = [];
    const transport: PadTransport = {
      async appendEvent(_fixtureId, body) {
        appendCalls.push(body);
        return success(1);
      },
      listEventsSince,
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 0, state: null, summary: null, outcome: null };
      },
    };

    // Seed the durable queue DIRECTLY — the one way to construct a record a
    // real pre-pass-H build would have left behind (submit() always sets
    // voidTargetSeq today, so it cannot produce this shape). `dbName` matches
    // this mount's own `queueDbName` below via the module-level
    // queueStoreRegistry mock (file header), so this is the SAME store the
    // hook's own resume effect will read from.
    const store = indexedDbQueueStore(DB_NAME);
    const legacyVoid: PendingEvent = {
      localId: "local-legacy-1",
      idempotencyKey: "void-idem-legacy-1",
      type: "core.void",
      payload: { event_id: STALE_ID },
      expectedSeq: 0,
      createdAt: "2026-08-13T00:00:00.000Z",
      attempts: 0,
      // voidTargetSeq deliberately absent — the exact shape under test.
    };
    await enqueue(store, legacyVoid);

    // A genuinely fresh mount — ownEventIds starts empty exactly like a real
    // reload, and nothing here ever calls submit(), so voidTargetSeq is never
    // set any other way either.
    const pad = mountPipeline(baseParams({ transport, queueDbName: DB_NAME }));
    for (let i = 0; i < 5; i += 1) {
      await tick();
    }

    const voidCall = appendCalls.find((c) => c.type === "core.void");
    expect(voidCall, "a legacy queued void must still reach the wire, not vanish or crash the mount").toBeTruthy();
    // Pass G's own fallback for a target this fresh mount does not recognise
    // as its own (empty ownEventIds, no durable seq either): the "same" fast
    // path, sent verbatim — exactly what this record would have received had
    // pass H's field never existed. A mangled payload here (e.g. `undefined`
    // or a NaN-derived one) is exactly what "degrades cleanly" rules out.
    expect(voidCall!.payload).toEqual({ event_id: STALE_ID });
    // The "same" fast path never attempts a network resolution at all —
    // proves this took the SAME branch as any id this mount has never heard
    // of, not some voidTargetSeq-shaped code path that merely happens not to
    // throw today.
    expect(listEventsSince).not.toHaveBeenCalled();
    expect(pad.current.queueDepth).toBe(0);
    // pendingWithLocalVoidTarget's OWN no-op, directly: the LOCAL fold
    // envelope must still carry the ORIGINAL, unmodified `voids` id — proof
    // its "voidTargetSeq === undefined -> return pending unchanged" guard
    // ran to completion rather than throwing while building either the
    // resume effect's pre-send entry or runDrain's ack.
    const localVoidEnvelope = pad.current.events.find((e) => e.type === "core.void");
    expect(localVoidEnvelope, "the legacy void must still fold locally too, not vanish from the ledger").toBeTruthy();
    expect(localVoidEnvelope!.voids).toBe(STALE_ID);
  });
});

// ScoringPad v3 R1 chassis soft-commit (spec §2.3, task 4) — the ONE
// production-code change outside queue.ts: runDrain's own front-of-queue
// guard for a still-held entry (`heldUntil`). queue.ts's own
// __tests__/soft-commit.test.ts proves enqueueHeld/mutateHeld/releaseHeld/
// dropHeld/flushHeldBefore thoroughly at the store level; THIS test proves
// the one line spliced into THIS file's runDrain actually defers a real
// drain the way those store-level tests assume a caller will. No production
// skin calls enqueueHeld yet this wave (R1 ruling), so this seeds the
// durable queue directly — the same bypass-submit() pattern the pass-J
// backward-compat test above already uses, for the same reason (submit()
// itself is untouched and has no held-path today).
describe("usePadPipeline — R1 chassis soft-commit: runDrain defers a still-held entry (task 4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a held entry blocks the WHOLE FIFO drain until its window closes, then a later trigger sends everything in order", async () => {
    const { transport, appendCalls } = fakeTransport({ appendResults: [success(1), success(2), success(3)] });
    const pad = mountPipeline(baseParams({ transport }));
    await vi.advanceTimersByTimeAsync(0); // let the mount-time resume/drain effect settle first

    // Same instance the hook itself uses — use-pad-pipeline.ts:738's default
    // dbName is `scorepad-queue-${fixtureId}`, and baseParams()'s fixtureId
    // is "fx-1" (module header's queueStoreRegistry mock hands back the
    // SAME memoryQueueStore() for a repeated dbName).
    const store = indexedDbQueueStore("scorepad-queue-fx-1");
    await enqueueHeld(
      store,
      {
        localId: "held-1",
        idempotencyKey: "held-1",
        type: "generic.score",
        payload: { by: "H", points: 1 },
        expectedSeq: 0,
        createdAt: new Date().toISOString(),
        attempts: 0,
      },
      HOLD_MS,
      () => {}, // no production caller wires this to runDrain yet this wave — see file note above
    );

    await pad.current.submit("generic.score", { by: "A", points: 2 }); // queued BEHIND the still-held entry

    expect(appendCalls).toHaveLength(0); // neither sent — the held entry blocks the whole FIFO drain, not just itself
    expect(pad.current.queueDepth).toBe(2); // still durably queued and counted — "ribbon renders it" either way

    await vi.advanceTimersByTimeAsync(HOLD_MS); // held-1's own window closes; its heldUntil clears itself
    await pad.current.submit("generic.score", { by: "H", points: 99 }); // ANY later drain trigger re-drains

    expect(appendCalls.map((c) => c.body.payload)).toEqual([
      { by: "H", points: 1 }, // held-1 — sent first, in its original queue position
      { by: "A", points: 2 },
      { by: "H", points: 99 },
    ]);
    expect(pad.current.queueDepth).toBe(0);
  });
});
