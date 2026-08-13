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
import type { LedgerSlotEvent, OwnIdentity, PendingEvent } from "../types";
import type { FixtureStateResult, PadTransport } from "../transport";
import type { RealtimeConnector } from "../use-fixture-stream";
import {
  DOUBLE_SUBMIT_WINDOW_MS,
  pendingToEnvelope,
  usePadPipeline,
  type UsePadPipelineParams,
  type UsePadPipelineResult,
} from "../use-pad-pipeline";

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
