// The pad's live pipeline hook (S10/#419 W8): submit -> optimistic fold ->
// durable enqueue -> drain in order -> reconcile against the server fold on
// every ack. Driven through the repo's node-only `_hook-harness` (no DOM, no
// jsdom in this workspace — apps/web/vitest.config.ts pins `environment:
// "node"`), via a tiny Probe component that reports the hook's live result
// object on every render — the established idiom for testing a standalone
// hook this way (see marketing/__tests__/use-start-on-view.test.tsx).
import { describe, expect, it } from "vitest";
import { defaultLineupPair } from "@seazn/engine/testkit";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { foldClient, resolveModuleClient } from "../module-client";
import type { AppendCallResult, AppendEventBody } from "../pipeline";
import type { LedgerSlotEvent, OwnIdentity } from "../types";
import type { FixtureStateResult, PadTransport } from "../transport";
import { usePadPipeline, type UsePadPipelineParams, type UsePadPipelineResult } from "../use-pad-pipeline";

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

function baseParams(overrides: Partial<UsePadPipelineParams> = {}): UsePadPipelineParams {
  const generic = resolveModuleClient("generic", "1.0.0");
  return {
    fixtureId: "fx-1",
    module: generic,
    cfg: { resultMode: "win_loss", allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    lineups: defaultLineupPair(generic.positions),
    identity: ME,
    transport: fakeTransport({ appendResults: [] }).transport,
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
  renderIsland(Probe, { params, onReady: (r) => (latest = r) });
  return {
    get current() {
      return latest;
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
