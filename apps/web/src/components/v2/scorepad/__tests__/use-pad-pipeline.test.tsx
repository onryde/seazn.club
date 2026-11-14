// The pad's live pipeline hook (S10/#419 W8): submit -> optimistic fold ->
// durable enqueue -> drain in order -> reconcile against the server fold on
// every ack. Driven through the repo's node-only `_hook-harness` (no DOM, no
// jsdom in this workspace — apps/web/vitest.config.ts pins `environment:
// "node"`), via a tiny Probe component that reports the hook's live result
// object on every render — the established idiom for testing a standalone
// hook this way (see marketing/__tests__/use-start-on-view.test.tsx).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initSquads, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import { defaultLineupPair } from "@seazn/engine/testkit";
import { resolvePositions } from "@seazn/engine/sport";
import type { CricketBallEv, CricketCfg, CricketState } from "@seazn/engine/sports/cricket";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { foldClient, resolveModuleClient } from "../module-client";
import type { AppendCallResult, AppendEventBody } from "../pipeline";
import { HOLD_MS, enqueue, enqueueHeld, releaseHeld } from "../queue";
import type { LedgerSlotEvent, OwnIdentity, PendingEvent } from "../types";
import type { FixtureStateResult, PadTransport } from "../transport";
import type { RealtimeConnector } from "../use-fixture-stream";
import { indexedDbQueueStore, memoryQueueStore, type QueueStore } from "../queue-store";
import {
  DOUBLE_SUBMIT_WINDOW_MS,
  HUMAN_FASTEST_REPEAT_MS,
  pendingToEnvelope,
  usePadPipeline,
  type UsePadPipelineParams,
  type UsePadPipelineResult,
} from "../use-pad-pipeline";
import { decideUndo, dockFor, endingPlanOf, endingPromptOf, runAmend, runEnding, softCommitPlan } from "../v3/pad-host";
import { makeDockStore } from "../v3/detail-dock";
import { footballSkinV3, resolvePhase } from "../v3/skins/football";
import type { PadHostView } from "../v3/types";
import { builtinModules } from "@seazn/engine/sports";
import { makeEnvelope } from "@seazn/engine/testkit";

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
  /** W3 task 1 fix round 1 — the rows the SERVER holds. When given,
   *  `listEventsSince` answers the way the real endpoint does: every row
   *  STRICTLY after the cursor it was handed. Absent, it keeps its old
   *  behaviour of always answering with an empty batch.
   *
   *  Filtering for real (rather than returning a canned batch) is what lets a
   *  test tell "the pad asked for the right cursor" apart from "the pad was
   *  handed the right rows regardless of what it asked for" — a canned batch
   *  answers identically to `seq > 3` and `seq > 4`, so it cannot witness the
   *  defect this suite exists for. */
  serverLedger?: readonly LedgerSlotEvent[];
}) {
  const appendCalls: { fixtureId: string; body: AppendEventBody }[] = [];
  const fetchStateCalls: string[] = [];
  // W3 task 1 — the two CURSORS this pad hands the server. Recorded at the
  // wire rather than read out of the hook's own state on purpose: the
  // defect is about what the SERVER is told, so only the argument that
  // actually crossed this boundary witnesses it. `listEventsSince` answers
  // from `serverLedger` when one is given and with an empty batch when it is
  // not — see that option's own doc just above.
  const listEventsSinceCalls: { fixtureId: string; sinceSeq: number }[] = [];
  let cursor = 0;
  const transport: PadTransport = {
    async appendEvent(fixtureId, body) {
      appendCalls.push({ fixtureId, body });
      const next = opts.appendResults[cursor];
      cursor += 1;
      if (!next) throw new Error(`fakeTransport: no scripted appendEvent response left (call #${cursor})`);
      return next;
    },
    async listEventsSince(fixtureId, sinceSeq): Promise<LedgerSlotEvent[]> {
      listEventsSinceCalls.push({ fixtureId, sinceSeq });
      return (opts.serverLedger ?? []).filter((row) => row.seq > sinceSeq);
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
  return {
    transport,
    appendCalls,
    fetchStateCalls,
    listEventsSinceCalls,
    /** The `sinceSeq` this transport was last asked for — i.e. where the pad
     *  believes its ledger ends. `undefined` until a poll tick or a realtime
     *  signal has actually fired.
     *
     *  CAUTION: the live stream is not the only caller. `pipeline.ts`'s
     *  `findLedgerSlot` also reads `listEventsSince` (at `event.expectedSeq`)
     *  while resolving a 409, so a test that drives a conflict must force a
     *  FRESH poll tick after the drain has finished before reading this, or
     *  it will be reading the conflict probe's cursor instead. */
    lastSinceSeq: (): number | undefined => listEventsSinceCalls.at(-1)?.sinceSeq,
    /** The `expected_seq` on the last body this pad actually submitted — i.e.
     *  the slot the pad claims is free. `undefined` before the first append. */
    lastSubmittedExpectedSeq: (): number | undefined => appendCalls.at(-1)?.body.expected_seq,
  };
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

describe("usePadPipeline — W2b PF-1: the headline of a withdrawal over a held level result", () => {
  // single-sport: football — a bracket's level result (0-0 FT) and a credited forfeit score (FB-WO-1:
  // `awardScore.goals`–0 at 0-0) that differs from the draw, so the pad's headline can witness the overlay.
  const env = (seq: number, type: string, payload: unknown): EventEnvelope => ({
    id: `e-${seq}`,
    fixtureId: "fx-1",
    seq,
    type,
    payload,
    recordedAt: `2026-08-12T00:00:0${seq}.000Z`,
    recordedBy: "user-1",
  });
  const footballParams = (withdrawal: boolean) => {
    const football = resolveModuleClient("football", "1.0.0");
    const cfg = football.configSchema.parse({}) as { awardScore: { goals: number } };
    const lineups = defaultLineupPair(resolvePositions(football, cfg));
    const events = [env(1, "core.start", {}), env(2, "football.period", { phase: "HT" }), env(3, "football.period", { phase: "FT" })];
    if (withdrawal) events.push(env(4, "core.forfeit", { by: lineups.away.entrantId, reason: "withdrew" }));
    return { params: baseParams({ module: football, cfg, lineups, initialEvents: events }), goals: cfg.awardScore.goals, football };
  };
  it("the away side withdrew: the summary reads the award's credited score while the module state still reads the draw", () => {
    const { params, goals, football } = footballParams(true);
    const pad = mountPipeline(params);
    expect(football.outcome(pad.current.state as never)?.kind, "rig: the module itself still holds the draw").toBe("draw");
    expect((pad.current.summary as { headline: string }).headline).toBe(`${goals} — 0`);
  });
  it("the negative pair: the held draw with no withdrawal reads 0 — 0", () => {
    const pad = mountPipeline(footballParams(false).params);
    expect((pad.current.summary as { headline: string }).headline).toBe("0 — 0");
  });
});

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

// W1 (2026-09-21). The seam between the new `throttled` reason and the chip
// that reads it. Without this, both ends are tested and the wire between them
// is not: `sendOne` returns the reason, `queueStatusText` renders it, and the
// hook in between could set nothing at all and stay green.
describe("usePadPipeline — throttled flag", () => {
  it("a 429 raises throttled and NOT offline, keeps the tap, paces the retry, and clears once the wait is out", async () => {
    let limited = true;
    let appendCalls = 0;
    const transport: PadTransport = {
      async appendEvent() {
        appendCalls++;
        if (limited) return { kind: "throttled", message: "Too many requests", retryAfterMs: null };
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
    expect(pad.current.throttled).toBe(true);
    // THE assertion this describe exists for: the venue wifi is fine, and the
    // scorer must not be sent to go and fix it.
    expect(pad.current.offline).toBe(false);
    expect(pad.current.queueDepth).toBe(1); // stayed queued, never dropped
    expect(pad.current.lastRejection).toBeNull(); // throttled, not a refusal
    const callsAfterThrottle = appendCalls;

    // Spec §4.6's pacing, driven through the real hook: the limiter has freed
    // up, but the entry is still inside its computed wait, so a drain must NOT
    // spend a request on it. A retry that feeds the limiter it is waiting on is
    // the defect this backoff exists to prevent.
    limited = false;
    await pad.current.retryDrain();
    expect(appendCalls).toBe(callsAfterThrottle); // the limiter was not touched
    expect(pad.current.throttled).toBe(true);
    expect(pad.current.queueDepth).toBe(1);

    // Now let the wait elapse — in the store, the way the clock would, rather
    // than by sleeping a whole limiter window inside a unit test.
    const queued = await pad.current.queueStore.list();
    await pad.current.queueStore.put({ ...queued[0]!, retryNotBefore: Date.now() - 1 });

    await pad.current.retryDrain();
    expect(appendCalls).toBeGreaterThan(callsAfterThrottle); // …and now it sends
    expect(pad.current.throttled).toBe(false); // latched chips lie the other way
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

  it("keeps the next match's ref on a NEXT_MATCH_STARTED refusal, so the pad can name it", async () => {
    const nextMatch = { fixture_id: "fx-final", round: 2, seq: 1 };
    const { transport } = fakeTransport({
      appendResults: [{ kind: "rejected", code: "NEXT_MATCH_STARTED", message: "started", nextMatch }],
    });
    const pad = mountPipeline(baseParams({ transport }));

    await pad.current.submit("generic.score", { by: "H", points: 1 });
    expect(pad.current.lastRejection).toEqual({ code: "NEXT_MATCH_STARTED", message: "started", nextMatch });
  });

  it("M-1: keeps a LEVEL_RESULT_IN_BRACKET refusal's reason, so the pad's copy can tell a finalize from a generic draw", async () => {
    const { transport } = fakeTransport({
      appendResults: [{ kind: "rejected", code: "LEVEL_RESULT_IN_BRACKET", message: "level", reason: "finalize_unsettled" }],
    });
    const pad = mountPipeline(baseParams({ transport }));

    await pad.current.submit("generic.score", { by: "H", points: 1 });
    expect(pad.current.lastRejection).toEqual({ code: "LEVEL_RESULT_IN_BRACKET", message: "level", reason: "finalize_unsettled" });
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

  it("the 250ms window refuses a SYNCHRONOUS second submit of the identical (type, payload) — one press read twice — and says so", async () => {
    const { transport, appendCalls } = fakeTransport({ appendResults: [success(1), success(2)] });
    const pad = mountPipeline(baseParams({ transport }));

    const p1 = pad.current.submit("generic.score", { by: "H", points: 1 });
    const p2 = pad.current.submit("generic.score", { by: "H", points: 1 }); // same tick, same action
    await Promise.all([p1, p2]);

    expect(appendCalls).toHaveLength(1); // the second call never reached the transport
    expect(pad.current.queueDepth).toBe(0);
    expect(pad.current.lastRejection?.code, "refused visibly, not swallowed").toBe("DOUBLE_SUBMIT");
  });

  it("a deliberate repeat past the window, while the first tap is still being WRITTEN to a slow store, is recorded — the window alone decides", async () => {
    // A phone's IndexedDB can take longer than the window to commit one put. A
    // guard held until the write finished refused a deliberate second tap for
    // exactly as long as the store was slow. Puts stay ordered, as IndexedDB's are.
    const DB = "pad-tap-slow-store";
    const inner = memoryQueueStore();
    const firstPutCommits = deferred<void>();
    let writes: Promise<void> = firstPutCommits.promise;
    const slow: QueueStore = {
      list: () => inner.list(),
      put: (event) => (writes = writes.then(() => inner.put(event))),
      delete: (key) => inner.delete(key),
      clear: () => inner.clear(),
    };
    queueStoreRegistry.set(DB, slow);
    const { transport, appendCalls } = fakeTransport({ appendResults: [success(1), success(2)] });
    const pad = mountPipeline(baseParams({ transport, queueDbName: DB }));
    await vi.advanceTimersByTimeAsync(0);

    const p1 = pad.current.submit("generic.score", { by: "H", points: 1 });
    await vi.advanceTimersByTimeAsync(HUMAN_FASTEST_REPEAT_MS + 50); // past the window; the first put has not committed
    const p2 = pad.current.submit("generic.score", { by: "H", points: 1 });
    expect(pad.current.lastRejection, "a deliberate second tap is not refused").toBeNull();

    firstPutCommits.resolve();
    await Promise.all([p1, p2]);

    expect(appendCalls.map((c) => c.body.expected_seq), "two taps, consecutive slots").toEqual([0, 1]);
    expect(new Set(appendCalls.map((c) => c.body.idempotency_key)).size).toBe(2);
    expect(pad.current.queueDepth).toBe(0);
    expect((pad.current.state as { running: { home: number; away: number } }).running).toEqual({ home: 2, away: 0 });
  });

  it("a repeat of the identical (type, payload) within the window, AFTER the first fully resolves, is also suppressed — AND the refusal is now VISIBLE, not silent", async () => {
    const { transport, appendCalls } = fakeTransport({ appendResults: [success(1), success(2)] });
    const pad = mountPipeline(baseParams({ transport }));

    await pad.current.submit("generic.score", { by: "H", points: 1 });
    expect(appendCalls).toHaveLength(1);
    expect(pad.current.lastRejection).toBeNull(); // the first, accepted submit clears any prior rejection

    await vi.advanceTimersByTimeAsync(DOUBLE_SUBMIT_WINDOW_MS - 100); // still inside the window
    await pad.current.submit("generic.score", { by: "H", points: 1 }); // same action, too soon

    expect(appendCalls).toHaveLength(1); // still just one — the repeat is still refused
    // R7-42/R7-30: refused is no longer synonymous with silent. The scorer
    // must be able to tell the tap was not taken, via the SAME
    // `lastRejection` surface a server-side 422 already uses (rendered
    // through `rejectionText`/`refusalText`, pad-host.tsx/refusal-copy.ts).
    expect(pad.current.lastRejection).not.toBeNull();
    expect(pad.current.lastRejection?.code).toBe("DOUBLE_SUBMIT");
  });

  it("a repeat at 400ms — inside the OLD 600ms window, outside the new 250ms one — now RECORDS: the customer-facing behaviour change", async () => {
    const { transport, appendCalls } = fakeTransport({ appendResults: [success(1), success(2)] });
    const pad = mountPipeline(baseParams({ transport }));

    await pad.current.submit("generic.score", { by: "H", points: 1 });
    expect(appendCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(400); // past the new 250ms window, still inside the old 600ms one
    await pad.current.submit("generic.score", { by: "H", points: 1 });

    expect(appendCalls).toHaveLength(2); // BOTH recorded — this would have been swallowed at the old window
    expect(pad.current.lastRejection).toBeNull(); // a genuinely-accepted second submit, nothing to refuse
    expect((pad.current.state as { running: { home: number; away: number } }).running).toEqual({ home: 2, away: 0 });
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

// fix/pad-second-tap-in-flight — a scorer taps the same side twice over a slow
// connection. `submit()` held its same-tick guard (`submitInFlight`) across the
// network drain, so a deliberate repeat seconds later, while the first POST was
// still on the wire, was refused as DOUBLE_SUBMIT and the second point was
// lost. The guard's own contract was "two calls landing in the SAME tick"; the
// 250ms window (`lastAccepted`) is what catches one physical tap read twice —
// and, since review m-1 removed that latch, the only double-submit guard left.
//
// Every case here drives a transport whose POSTs answer only when the test
// says so, because a POST that answers at once (fakeTransport's default) lets
// the first submit fully resolve before the second starts — exactly how the
// suite above stayed green over this defect.
//
// Single sport (generic) on purpose: the guard compares (type, payload) and
// the drain sends whatever is queued; neither ever reads the sport module.
describe("usePadPipeline — a repeat tap while the previous POST is still in flight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A transport whose every appendEvent call waits on its own gate. Gates
   *  are created on demand, so `answer(i, …)` may run before or after call i
   *  arrives. Every other read answers empty. */
  function slowTransport() {
    const bodies: AppendEventBody[] = [];
    const gates: ReturnType<typeof deferred<AppendCallResult>>[] = [];
    const gate = (i: number) => (gates[i] ??= deferred<AppendCallResult>());
    const transport: PadTransport = {
      async appendEvent(_fixtureId, body) {
        bodies.push(body);
        return gate(bodies.length - 1).promise;
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
    return { transport, bodies, answer: (i: number, result: AppendCallResult) => gate(i).resolve(result) };
  }

  const flush = () => vi.advanceTimersByTimeAsync(0);
  const homeScore = (pad: { current: UsePadPipelineResult }) =>
    (pad.current.state as { running: { home: number; away: number } }).running.home;
  const TAP = ["generic.score", { by: "H", points: 1 }] as const;

  it("a second identical tap past the window, while the first POST is pending, is RECORDED and sent next with the following expected_seq", async () => {
    const { transport, bodies, answer } = slowTransport();
    const pad = mountPipeline(baseParams({ transport }));

    const p1 = pad.current.submit(...TAP);
    await flush();
    expect(bodies, "the first tap's POST is on the wire and unanswered").toHaveLength(1);

    // Deliberately past the double-tap window and beyond HUMAN_FASTEST_REPEAT_MS: a
    // second, deliberate tap — not one press read twice.
    await vi.advanceTimersByTimeAsync(Math.max(DOUBLE_SUBMIT_WINDOW_MS, HUMAN_FASTEST_REPEAT_MS) + 50);
    const p2 = pad.current.submit(...TAP);
    await flush();

    expect(pad.current.lastRejection, "the second tap must not be refused").toBeNull();
    expect(pad.current.queueDepth, "both taps held durably while the first POST is pending").toBe(2);
    expect(homeScore(pad), "the pad shows both points at once").toBe(2);
    expect(bodies, "FIFO: the second is not sent past the first's unanswered POST").toHaveLength(1);

    answer(0, success(1));
    await flush();
    expect(bodies, "the second tap goes out as soon as the first is answered").toHaveLength(2);
    answer(1, success(2));
    await Promise.all([p1, p2]);

    expect(bodies.map((b) => b.type)).toEqual([TAP[0], TAP[0]]);
    expect(bodies[1]!.expected_seq, "consecutive slots, the second claiming the one after the first").toBe(bodies[0]!.expected_seq + 1);
    expect(new Set(bodies.map((b) => b.idempotency_key)).size, "two distinct events, not one sent twice").toBe(2);
    expect(pad.current.queueDepth).toBe(0);
    expect(homeScore(pad)).toBe(2);
  });

  it("a second submit JOINS the drain already running: it settles only once its own POST is answered, not when it is queued", async () => {
    const { transport, answer } = slowTransport();
    const pad = mountPipeline(baseParams({ transport }));
    const settled = { first: false, second: false };

    const p1 = pad.current.submit(...TAP).then(() => void (settled.first = true));
    await flush();
    await vi.advanceTimersByTimeAsync(HUMAN_FASTEST_REPEAT_MS + 50);
    const p2 = pad.current.submit(...TAP).then(() => void (settled.second = true));
    await flush();
    expect(pad.current.queueDepth, "the second tap is durably queued").toBe(2);
    expect(settled.second, "queued is not sent: the second submit waits on the running drain").toBe(false);

    answer(0, success(1));
    await flush();
    expect(settled.second, "the first POST answered; the second's own POST is still on the wire").toBe(false);

    answer(1, success(2));
    await Promise.all([p1, p2]);
    expect(settled).toEqual({ first: true, second: true });
    expect(pad.current.queueDepth).toBe(0);
  });

  it("a second identical tap INSIDE the window is still refused while the first POST is pending — the double-tap guard is intact", async () => {
    const { transport, bodies, answer } = slowTransport();
    const pad = mountPipeline(baseParams({ transport }));

    const p1 = pad.current.submit(...TAP);
    await flush();
    await vi.advanceTimersByTimeAsync(DOUBLE_SUBMIT_WINDOW_MS - 100); // one press read twice
    await pad.current.submit(...TAP);

    expect(pad.current.lastRejection?.code).toBe("DOUBLE_SUBMIT");
    expect(pad.current.queueDepth, "only the first tap is held").toBe(1);
    expect(homeScore(pad)).toBe(1);

    answer(0, success(1));
    await p1;
    expect(bodies, "the refused repeat never reaches the transport").toHaveLength(1);
    expect(homeScore(pad)).toBe(1);
  });

  it("three deliberate taps behind a slow POST all land in order; a network failure mid-way neither loses nor duplicates the later tap", async () => {
    const { transport, bodies, answer } = slowTransport();
    const pad = mountPipeline(baseParams({ transport }));
    const SPACING = HUMAN_FASTEST_REPEAT_MS + 50;

    const pA = pad.current.submit(...TAP);
    await flush();
    await vi.advanceTimersByTimeAsync(SPACING);
    const pB = pad.current.submit(...TAP);
    await flush();
    await vi.advanceTimersByTimeAsync(SPACING);
    const pC = pad.current.submit(...TAP);
    await flush();

    expect(pad.current.lastRejection).toBeNull();
    expect(pad.current.queueDepth, "all three held while A's POST is pending").toBe(3);
    expect(homeScore(pad)).toBe(3);
    expect(bodies).toHaveLength(1);

    answer(0, success(1)); // A lands
    await flush();
    expect(bodies, "B goes out next, alone").toHaveLength(2);
    answer(1, { kind: "network-error", message: "connection dropped" }); // B's POST fails
    await Promise.all([pA, pB, pC]);

    expect(pad.current.offline).toBe(true);
    expect(bodies, "the drain stops at B: C is never sent past an undelivered B").toHaveLength(2);
    expect(pad.current.queueDepth, "B and C both still held — neither lost").toBe(2);
    expect(homeScore(pad), "the pad still shows all three").toBe(3);

    answer(2, success(2)); // B's retry
    answer(3, success(3)); // C
    await pad.current.retryDrain();

    const [a, b, bRetry, c] = bodies;
    expect(bodies).toHaveLength(4);
    expect(bRetry!.idempotency_key, "B is retried under its OWN key — the server can dedupe it").toBe(b!.idempotency_key);
    expect(bRetry!.expected_seq, "…and its ORIGINAL slot — a retry is a replay, never a recomputed claim").toBe(b!.expected_seq);
    expect(new Set([a!, b!, c!].map((x) => x.idempotency_key)).size, "three distinct events").toBe(3);
    expect([a!, b!, c!].map((x) => x.expected_seq), "one slot each, in tap order").toEqual([
      a!.expected_seq,
      a!.expected_seq + 1,
      a!.expected_seq + 2,
    ]);
    expect(pad.current.offline).toBe(false);
    expect(pad.current.queueDepth).toBe(0);
    expect(homeScore(pad), "exactly three points — none lost, none doubled").toBe(3);
  });
});

// fix/pad-second-tap-in-flight review I-1/I-2 (m-4). Every queued tap is
// stamped with the slot it will claim, on the assumption that each tap ahead of
// it lands exactly one slot further on. Two ways that assumption breaks, both
// reproduced from the reviewer's probes:
//   I-1 — the tap ahead loses a race and lands a slot LATE, so the tap behind
//         it meets that tap's own byte-identical row at its stamped slot; a
//         retry used to read it as its own landed write and drop itself.
//   I-2 — the tap ahead is REFUSED and never lands, so every tap behind it
//         claims a slot the ledger never reaches: a 409 with no row to inspect,
//         queued forever, with its point still on screen.
//
// The server here is not a script: it answers the way scoring.ts and
// append-event.ts do, so the expected wire is the protocol's, never a copy of
// the hook's own arithmetic. Single sport (generic) on purpose: the queue
// sends whatever is queued and never reads the sport module.
describe("usePadPipeline — a queued tap survives a conflict or a refused tap ahead of it", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const RECORDED_AT = "2026-11-14T00:00:00.000Z";

  /**
   * A POST is written only at `expected_seq === tip` and lands at tip + 1; a
   * stale one is a 409 naming the real tip; a key the ledger already holds is
   * answered from the ledger (W2's durable idempotency), never written twice.
   * Every POST waits for `open()`, so a test can queue taps behind a pending
   * one. `faults[i]` answers call #i itself without reaching the ledger — a
   * lost request (network error) or a module refusal (422). `foreignWrite()`
   * is another device scoring now, unseen by this pad until it reads the ledger.
   * `seed` is the ledger before this pad's first write; `holdCall[i]` keeps
   * call #i unanswered past `open()` until that promise settles.
   */
  function ledgerServer(
    opts: { faults?: Record<number, AppendCallResult>; seed?: readonly LedgerSlotEvent[]; holdCall?: Record<number, Promise<void>> } = {},
  ) {
    const rows: LedgerSlotEvent[] = [...(opts.seed ?? [])];
    const keyAt = new Map<number, string>();
    const bodies: AppendEventBody[] = [];
    const door = deferred<void>();
    const tip = () => rows.length;
    const transport: PadTransport = {
      async appendEvent(_fixtureId, body) {
        const call = bodies.push(body) - 1;
        await door.promise;
        await opts.holdCall?.[call];
        const fault = opts.faults?.[call];
        if (fault !== undefined) return fault;
        const landedAt = [...keyAt].find(([, key]) => key === body.idempotency_key)?.[0];
        if (landedAt !== undefined) return success(landedAt);
        if (body.expected_seq !== tip()) {
          return { kind: "conflict", currentSeq: tip(), message: `expected seq ${body.expected_seq}, ledger at ${tip()}` };
        }
        const seq = tip() + 1;
        rows.push({
          id: `row-${seq}`,
          seq,
          type: body.type,
          payload: body.payload,
          recorded_at: RECORDED_AT,
          recorded_by: ME.recordedBy,
          device_link_id: ME.deviceLinkId,
        });
        keyAt.set(seq, body.idempotency_key);
        return success(seq);
      },
      async listEventsSince(_fixtureId, sinceSeq) {
        return rows.filter((r) => r.seq > sinceSeq);
      },
      async getLastSeq() {
        return tip();
      },
      async fetchState() {
        return { status: "in_play", last_seq: tip(), state: null, summary: null, outcome: null };
      },
    };
    return {
      transport,
      bodies,
      rows,
      /** The idempotency keys this pad's own rows were written under, in seq order. */
      ownKeys: () => rows.filter((r) => r.recorded_by === ME.recordedBy).map((r) => keyAt.get(r.seq)),
      foreignWrite: () => {
        const seq = tip() + 1;
        rows.push({
          id: `row-${seq}`,
          seq,
          type: "generic.score",
          payload: { by: "A", points: 1 },
          recorded_at: RECORDED_AT,
          recorded_by: "user-2",
          device_link_id: null,
        });
      },
      open: () => door.resolve(),
    };
  }

  const flush = () => vi.advanceTimersByTimeAsync(0);
  const running = (pad: { current: UsePadPipelineResult }) =>
    (pad.current.state as { running?: { home: number; away: number } }).running;
  const TAP = ["generic.score", { by: "H", points: 1 }] as const;
  const REFUSED: AppendCallResult = { kind: "rejected", code: "INVALID_EVENT", message: "refused" };
  const LOST: AppendCallResult = { kind: "network-error", message: "connection dropped" };

  it("I-1: two identical taps; the first loses a race and lands a slot late, the second's first POST is lost — BOTH land, once each", async () => {
    // Call #2 is B's first POST.
    const server = ledgerServer({ faults: { 2: LOST } });
    const pad = mountPipeline(baseParams({ transport: server.transport }));

    const pA = pad.current.submit(...TAP);
    await flush();
    await vi.advanceTimersByTimeAsync(HUMAN_FASTEST_REPEAT_MS + 50); // a deliberate second tap
    const pB = pad.current.submit(...TAP);
    await flush();
    expect(pad.current.queueDepth).toBe(2);

    server.foreignWrite(); // another device takes seq 1 while A's POST is on the wire
    server.open();
    await Promise.all([pA, pB]);
    expect(pad.current.queueDepth, "B is held after its lost POST").toBe(1);
    expect(
      server.bodies.map((b) => b.expected_seq),
      "A stamped 0, renegotiated to 1 and landed at seq 2 — the slot B was stamped for; B's POST at 1 was lost",
    ).toEqual([0, 1, 1]);

    await pad.current.retryDrain();

    const keys = server.ownKeys();
    expect(keys, "two taps, two rows on the server").toHaveLength(2);
    expect(new Set(keys).size, "two distinct events, neither written twice").toBe(2);
    expect(server.bodies.at(-1)!.idempotency_key, "the last write is B's own").toBe(keys[1]);
    expect(pad.current.queueDepth).toBe(0);
    expect(pad.current.lastRejection).toBeNull();
    expect(running(pad)?.home, "the pad shows both points, as the server holds them").toBe(2);
  });

  it("I-2: the head is refused with an identical tap queued behind it — the follower claims the freed slot and lands; no stale point stays on screen", async () => {
    const server = ledgerServer({ faults: { 0: REFUSED } });
    const pad = mountPipeline(baseParams({ transport: server.transport }));

    const pA = pad.current.submit(...TAP);
    await flush();
    await vi.advanceTimersByTimeAsync(HUMAN_FASTEST_REPEAT_MS + 50);
    const pB = pad.current.submit(...TAP);
    await flush();

    server.open();
    await Promise.all([pA, pB]);

    expect(pad.current.lastRejection?.code, "A's refusal is still said out loud").toBe("INVALID_EVENT");
    expect(server.bodies.map((b) => b.expected_seq), "B claims the slot A never took, not the one after it").toEqual([0, 0]);
    expect(pad.current.queueDepth).toBe(0);
    expect(server.ownKeys(), "exactly one row, and it is B's").toEqual([server.bodies[1]!.idempotency_key]);
    expect(running(pad)?.home, "the one point on screen is the one the server holds").toBe(1);
  });

  it("I-2, then a lost POST: the re-aimed follower keeps its NEW slot — on screen, in the queue, and on the retry", async () => {
    const server = ledgerServer({ faults: { 0: REFUSED, 1: LOST } });
    const pad = mountPipeline(baseParams({ transport: server.transport }));

    const pA = pad.current.submit(...TAP);
    await flush();
    await vi.advanceTimersByTimeAsync(HUMAN_FASTEST_REPEAT_MS + 50);
    const pB = pad.current.submit(...TAP);
    await flush();
    server.open();
    await Promise.all([pA, pB]);

    const [held] = await pad.current.queueStore.list();
    expect(held?.expectedSeq, "durably re-aimed at the freed slot").toBe(0);
    expect(
      pad.current.events.map((e) => e.seq),
      "the optimistic row moved with it: the slot it will land at, not the one after A",
    ).toEqual([held!.expectedSeq + 1]);

    await pad.current.retryDrain();

    expect(server.bodies.map((b) => b.expected_seq), "refused, lost, retried — the retry replays the re-aimed slot").toEqual([0, 0, 0]);
    expect(pad.current.queueDepth).toBe(0);
    expect(server.ownKeys()).toHaveLength(1);
    expect(running(pad)?.home).toBe(1);
  });

  it("I-2 after a reload: the refused head takes the tap bound to it (dropWith) along, and the tap behind BOTH moves down two slots", async () => {
    const DB = "pad-tap-i2-bound";
    const store = indexedDbQueueStore(DB);
    const queued = (key: string, expectedSeq: number, by: "H" | "A", extra: Partial<PendingEvent> = {}): PendingEvent => ({
      localId: `local-${key}`,
      idempotencyKey: key,
      type: "generic.score",
      payload: { by, points: 1 },
      expectedSeq,
      createdAt: RECORDED_AT,
      attempts: 0,
      ...extra,
    });
    await enqueue(store, queued("a", 0, "H"));
    await enqueue(store, queued("v", 1, "A", { dropWith: "a" }));
    await enqueue(store, queued("c", 2, "H"));
    const server = ledgerServer({ faults: { 0: REFUSED } });

    const pad = mountPipeline(baseParams({ transport: server.transport, queueDbName: DB }));
    await flush();
    server.open();
    await pad.current.retryDrain();

    expect(
      server.bodies.map((b) => [b.idempotency_key, b.expected_seq]),
      "the bound tap is never sent; the last one claims the first free slot",
    ).toEqual([
      ["a", 0],
      ["c", 0],
    ]);
    expect(pad.current.queueDepth).toBe(0);
    expect(server.ownKeys()).toEqual(["c"]);
    expect(running(pad)).toEqual({ home: 1, away: 0 });
  });

  it("I-2 through the undo path: an undo of the refused tap leaves too (its target never landed), and the tap behind both takes the first free slot", async () => {
    const server = ledgerServer({ faults: { 0: REFUSED } });
    const pad = mountPipeline(baseParams({ transport: server.transport }));

    const pA = pad.current.submit(...TAP);
    await flush();
    const aKey = pad.current.events.at(-1)!.id; // a still-queued tap's row carries its idempotency key
    const pV = pad.current.submit("core.void", { event_id: aKey });
    await flush();
    const pC = pad.current.submit("generic.score", { by: "A", points: 1 });
    await flush();
    expect(pad.current.queueDepth).toBe(3);

    server.open();
    await Promise.all([pA, pV, pC]);

    expect(
      server.bodies.map((b) => [b.type, b.expected_seq]),
      "the undo of a tap that never landed is never sent; the tap behind both claims slot 0",
    ).toEqual([
      ["generic.score", 0],
      ["generic.score", 0],
    ]);
    expect(pad.current.lastRejection?.code).toBe("VOID_TARGET_UNKNOWN");
    expect(pad.current.queueDepth).toBe(0);
    expect(server.ownKeys()).toEqual([server.bodies[1]!.idempotency_key]);
    expect(running(pad)).toEqual({ home: 0, away: 1 });
  });

  it("an already-SENT tap behind a refused head is resent at its own slot, never re-aimed — e.g. a second tab sharing this queue already moved and sent it", async () => {
    const DB = "pad-tap-i2-sent";
    const store = indexedDbQueueStore(DB);
    const base = { type: "generic.score", payload: { by: "H", points: 1 }, createdAt: RECORDED_AT };
    await enqueue(store, { ...base, localId: "local-a", idempotencyKey: "a", expectedSeq: 0, attempts: 0 });
    // Already re-aimed to the freed slot and on the wire once (its answer was lost).
    await enqueue(store, { ...base, localId: "local-b", idempotencyKey: "b", expectedSeq: 0, attempts: 1 });
    const server = ledgerServer({ faults: { 0: REFUSED } });

    const pad = mountPipeline(baseParams({ transport: server.transport, queueDbName: DB }));
    await flush();
    server.open();
    await pad.current.retryDrain();

    expect(server.bodies.map((b) => [b.idempotency_key, b.expected_seq])).toEqual([
      ["a", 0],
      ["b", 0],
    ]);
    expect(pad.current.queueDepth).toBe(0);
    expect(server.ownKeys()).toEqual(["b"]);
  });

  /**
   * The pad's queue store, registered under `dbName` as the hook finds it, with
   * the `k`-th gate after `arm(k)` held until `release()`. Each call has two:
   * before it runs, and after it ran with its answer not yet back (a read that
   * misses a tap made meanwhile — IndexedDB answers late). Every await in the
   * drain that touches the queue is one of these calls, so sweeping `k` puts a
   * tap at each point where a drop's handling can yield.
   *
   * `inOrder`: the calls also run one at a time, in the order they were made,
   * each answered on a later task — as IndexedDB runs the requests on one
   * object store. A read asked for after a write sees it; one asked for before
   * the write was even issued does not, however long the write then waits. The
   * later task is a timer, and a 0ms timer set while the fake clock is ticking
   * is due 1ms on, so drive this queue by advancing the clock, not by `flush`.
   */
  function gatedQueue(dbName: string, opts: { inOrder?: boolean } = {}) {
    const inner = memoryQueueStore();
    let target = 0;
    let calls = 0;
    let hit = false;
    const gate = deferred<void>();
    const step = async () => {
      if (target === 0) return;
      calls += 1;
      if (calls !== target) return;
      hit = true;
      await gate.promise;
    };
    let lane: Promise<unknown> = Promise.resolve();
    const gated =
      <T,>(op: () => Promise<T>) =>
      async (): Promise<T> => {
        const run = async () => {
          await step();
          const answer = await op();
          await step();
          return answer;
        };
        if (opts.inOrder !== true) return run();
        const turn = lane.then(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          return run();
        });
        lane = turn.then(
          () => undefined,
          () => undefined,
        );
        return turn;
      };
    queueStoreRegistry.set(dbName, {
      list: () => gated(() => inner.list())(),
      put: (event) => gated(() => inner.put(event))(),
      delete: (key) => gated(() => inner.delete(key))(),
      clear: () => gated(() => inner.clear())(),
    });
    return { arm: (k: number) => (target = k), hit: () => hit, release: () => gate.resolve() };
  }
  const settle = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await flush();
  };
  /** `settle`, but each step advances the clock 1ms: the in-order queue answers on timers (`gatedQueue`). */
  const drive = async (done: () => boolean, steps = 400) => {
    for (let i = 0; i < steps && !done(); i++) await vi.advanceTimersByTimeAsync(1);
  };
  const settled = async <T,>(p: Promise<T>, what: string): Promise<T> => {
    let done = false;
    void p.then(
      () => (done = true),
      () => (done = true),
    );
    await drive(() => done);
    expect(done, `rig: ${what} settled`).toBe(true);
    return p;
  };
  const wire = (b: AppendEventBody) => [b.type, b.payload, b.expected_seq];
  const rowsOf = (events: readonly { type: string; payload: unknown; seq: number }[]) => events.map((e) => [e.type, e.payload, e.seq]);

  // Review I-A. A tap made while a drop is being handled must be stamped for
  // the queue as it will be, and keep its row on screen. Two ways it went
  // wrong: a tap stamped while the dropped tap's row was still on screen
  // (counting it) but left out of the re-aim; and the re-aim committing a copy
  // of the rows taken before the tap, wiping its row. Swept over every queue
  // call from the server's answer to the drain going idle, for both drop paths
  // (a refusal, and an undo whose target never landed) and for a refusal that
  // takes a bound tap (`dropWith`) with it. Generic: the window is in the queue,
  // which never reads the sport (the dock sport is the take-back describe below).
  const DROPPED_WITH_THE_REFUSED_TAP = [
    { name: "nothing else", floor: 8, queue: () => undefined },
    {
      name: "an undo of it, dead-lettered",
      floor: 12,
      queue: (pad: ReturnType<typeof mountPipeline>, refusedKey: string) => pad.current.submit("core.void", { event_id: refusedKey }),
    },
    {
      name: "a tap bound to it (dropWith) queued while it was on the wire",
      floor: 8,
      queue: (pad: ReturnType<typeof mountPipeline>, refusedKey: string) =>
        pad.current.submit("generic.score", { by: "A", points: 2 }, { dropWith: refusedKey }),
    },
  ] as const;
  for (const [index, scenario] of DROPPED_WITH_THE_REFUSED_TAP.entries()) {
    it(`a tap made at ANY queue call while the drain gives back a refused tap's slot, taking ${scenario.name} with it, lands at the next free slot, its row on screen until it is answered`, async () => {
      let windows = 0;
      let stampedCountingTheDrop = 0;
      let stampedAfterTheDrop = 0;
      for (let k = 1; k < 120; k++) {
        const DB = `pad-tap-ia-${index}-${k}`;
        const queue = gatedQueue(DB);
        const tAnswer = deferred<void>();
        // #0 the refused tap, #1 the tap behind it, #2 the tap made at the gate (whatever goes with the refused one is never sent).
        const server = ledgerServer({ faults: { 0: REFUSED }, holdCall: { 2: tAnswer.promise } });
        const pad = mountPipeline(baseParams({ transport: server.transport, queueDbName: DB }));
        await flush();
        const taps = [pad.current.submit(...TAP)];
        await flush();
        const alsoDropped = scenario.queue(pad, pad.current.events.at(-1)!.id);
        if (alsoDropped !== undefined) taps.push(alsoDropped);
        await flush();
        taps.push(pad.current.submit("generic.score", { by: "A", points: 1 }));
        await flush();

        queue.arm(k);
        server.open();
        await settle(queue.hit);
        if (!queue.hit()) {
          await Promise.all(taps); // the drain went idle before its k-th queue call: every window is covered
          break;
        }
        windows += 1;
        taps.push(pad.current.submit(...TAP)); // a different action from the one before it, so never a double
        if (pad.current.events.at(-1)!.seq > 2) stampedCountingTheDrop += 1;
        else stampedAfterTheDrop += 1;
        await flush();
        queue.release();
        await settle(() => server.bodies.length === 3);
        const tKey = server.bodies[2]?.idempotency_key;
        const rowOnTheWire = pad.current.events.find((e) => e.id === tKey);
        tAnswer.resolve();
        await Promise.all(taps);

        expect(
          server.bodies.map((b) => [b.payload, b.expected_seq]),
          `k=${k}: refused at 0; the tap behind it and the new tap take slots 0 and 1`,
        ).toEqual([
          [{ by: "H", points: 1 }, 0],
          [{ by: "A", points: 1 }, 0],
          [{ by: "H", points: 1 }, 1],
        ]);
        expect(rowOnTheWire?.seq, `k=${k}: the new tap's row stays on screen, at the seq it lands at`).toBe(2);
        expect(server.ownKeys(), `k=${k}`).toEqual([server.bodies[1]!.idempotency_key, tKey]);
        expect(pad.current.queueDepth, `k=${k}`).toBe(0);
        expect(running(pad), `k=${k}: the two points the server holds`).toEqual({ home: 1, away: 1 });
      }
      expect(windows, "queue calls a tap was made at").toBeGreaterThanOrEqual(scenario.floor);
      expect(stampedCountingTheDrop, "taps stamped while a dropped row was still on screen (re-aimed)").toBeGreaterThan(0);
      expect(stampedAfterTheDrop, "taps stamped after it left (never re-aimed)").toBeGreaterThan(0);
    });
  }

  // Review I-B, the same sweep through the take-back of a HELD tap. Generic: the
  // window is in the queue, which never reads the sport (the dock sport is the
  // describe below).
  it("a tap made at ANY queue call while a held tap is taken back lands at the next free slot, its row on screen until it is answered", async () => {
    let windows = 0;
    let stampedCountingTheDrop = 0;
    let stampedAfterTheDrop = 0;
    for (let k = 1; k < 120; k++) {
      const DB = `pad-tap-ib-${k}`;
      const queue = gatedQueue(DB);
      const tAnswer = deferred<void>();
      const server = ledgerServer({ holdCall: { 1: tAnswer.promise } });
      server.open();
      const pad = mountPipeline(baseParams({ transport: server.transport, queueDbName: DB }));
      await flush();
      const held = await pad.current.submitHeld(...TAP, HOLD_MS, vi.fn());
      const taps = [pad.current.submit("generic.score", { by: "A", points: 1 })]; // queued behind the held tap
      await flush();
      expect(server.bodies, "rig: nothing passes the held tap").toHaveLength(0);

      queue.arm(k);
      const drop = pad.current.dropHeldSubmission(held!.heldId);
      await settle(queue.hit);
      if (!queue.hit()) {
        expect(await drop).toBe(true);
        await Promise.all(taps);
        break;
      }
      windows += 1;
      taps.push(pad.current.submit(...TAP));
      if (pad.current.events.at(-1)!.seq > 2) stampedCountingTheDrop += 1;
      else stampedAfterTheDrop += 1;
      await flush();
      queue.release();
      expect(await drop, `k=${k}`).toBe(true);
      await settle(() => server.bodies.length === 2);
      const tKey = server.bodies[1]?.idempotency_key;
      const rowOnTheWire = pad.current.events.find((e) => e.id === tKey);
      tAnswer.resolve();
      await Promise.all(taps);
      await flush();

      expect(server.bodies.map((b) => [b.payload, b.expected_seq]), `k=${k}`).toEqual([
        [{ by: "A", points: 1 }, 0],
        [{ by: "H", points: 1 }, 1],
      ]);
      expect(rowOnTheWire?.seq, `k=${k}: on screen while on the wire`).toBe(2);
      expect(pad.current.queueDepth, `k=${k}`).toBe(0);
      expect(running(pad), `k=${k}: the taken-back tap is gone, the other two are there`).toEqual({ home: 1, away: 1 });
    }
    expect(windows, "queue calls a tap was made at").toBeGreaterThanOrEqual(8);
    expect(stampedCountingTheDrop, "taps stamped while the held row was still on screen (re-aimed)").toBeGreaterThan(0);
    expect(stampedAfterTheDrop, "taps stamped after it left (never re-aimed)").toBeGreaterThan(0);
  });

  // Review C1. `submitHeld` — the path every real v3 tap takes — puts its row on
  // screen at once, but asks the queue to write it only once `flushHeldBefore`'s
  // read has answered. Against a queue that answers in order (IndexedDB does), a
  // held tap made while a refused tap's slot is given back could be in the
  // re-aim's order with its write still behind the re-aim's read of it: skipped,
  // it was written stamped past the refused tap — a 409 against a slot the ledger
  // never reaches, on every retry, its point on screen and never recorded.
  // Swept over every queue call from the refusal to the drain going idle, with
  // 1–4 taps ahead of the held one (the refused tap, then 0–3 queued behind it).
  // Generic and football (the sport whose goal is a held tap); the queue never
  // reads the sport, so two stand for the registry. Then a second held tap.
  //
  // Review rr4: and with the taps ahead made the way a v3 pad makes them too
  // (`submitHeld`, each one releasing the one before it), so the last of them is
  // still HELD when the drain re-aims it, and the held tap made at the gate
  // releases it (`flushHeldBefore`) — two writes to one entry, racing. A lone
  // held tap ahead is put on the wire by its own hold ending.
  describe("a held tap made while the drain gives back a refused tap's slot, against a queue that answers in order (review C1)", () => {
    const football = resolveModuleClient("football", "1.0.0");
    const footballCfg = football.configSchema.parse({});
    const footballLineups = defaultLineupPair(resolvePositions(football, footballCfg));
    const footballStart = { id: "fb-1", seq: 1, type: "core.start", payload: {} };
    const SPORTS: readonly {
      name: string;
      params: Partial<UsePadPipelineParams>;
      seed: LedgerSlotEvent[];
      /** A scoring tap for side 0 (home) or 1 (away). */
      tap: (side: number) => [string, Record<string, unknown>];
    }[] = [
      { name: "generic", params: {}, seed: [], tap: (side) => ["generic.score", { by: side === 0 ? "H" : "A", points: 1 }] },
      {
        name: "football",
        params: {
          module: football,
          cfg: footballCfg,
          lineups: footballLineups,
          initialEvents: [{ ...footballStart, fixtureId: "fx-1", recordedAt: RECORDED_AT, recordedBy: "console-user" }],
        },
        seed: [{ ...footballStart, recorded_at: RECORDED_AT, recorded_by: "console-user", device_link_id: null }],
        tap: (side) => ["football.goal", { by: side === 0 ? footballLineups.home.entrantId : footballLineups.away.entrantId }],
      },
    ];

    for (const sport of SPORTS) {
      for (const [aheadHeld, ahead] of [false, true].flatMap((held) => [1, 2, 3, 4].map((n) => [held, n] as const))) {
        it(`${sport.name}, ${ahead} ${aheadHeld ? "held " : ""}tap(s) ahead: a held tap made at ANY queue call lands at the next free slot, and so does a second one after it`, async () => {
          const base = sport.seed.length;
          // Consecutive taps are for alternate sides, so none is ever a double of the one before it.
          const aheadTaps = Array.from({ length: ahead }, (_, i) => sport.tap(i % 2));
          const [heldType, heldPayload] = sport.tap(ahead % 2);
          const [secondType, secondPayload] = sport.tap((ahead + 1) % 2);
          let windows = 0;
          let stampedCountingTheDrop = 0;
          let stampedAfterTheDrop = 0;
          for (let k = 1; k < 200; k++) {
            const DB = `pad-tap-c1-${sport.name}-${ahead}-${k}`;
            const queue = gatedQueue(DB, { inOrder: true });
            const heldAnswer = deferred<void>();
            // #0 the refused tap, #1..#ahead-1 the taps queued behind it, #ahead the held tap made at the gate.
            const server = ledgerServer({ seed: sport.seed, faults: { 0: REFUSED }, holdCall: { [ahead]: heldAnswer.promise } });
            const pad = mountPipeline(baseParams({ ...sport.params, transport: server.transport, queueDbName: DB }));
            await drive(() => false, 30);
            const onDue = () => void pad.current.retryDrain();
            const taps: Promise<unknown>[] = [];
            for (const [type, payload] of aheadTaps) {
              taps.push(aheadHeld ? pad.current.submitHeld(type, payload, HOLD_MS, onDue) : pad.current.submit(type, payload));
              await drive(() => false, 30);
            }
            if (aheadHeld && ahead === 1) await vi.advanceTimersByTimeAsync(HOLD_MS); // the lone held tap's hold ends and sends it
            expect([pad.current.queueDepth, server.bodies.length], "rig: every tap queued, the first on the wire").toEqual([ahead, 1]);
            if (aheadHeld && ahead > 1) {
              const [last] = (await settled(pad.current.queueStore.list(), "rig: the queue read")).slice(-1);
              expect(last?.heldUntil, "rig: the last tap ahead is still held").toBeDefined();
            }

            queue.arm(k);
            server.open();
            await drive(queue.hit);
            if (!queue.hit()) {
              await settled(Promise.all(taps), `k=${k}: the taps ahead`); // the drain went idle before its k-th queue call: every window is covered
              break;
            }
            windows += 1;
            const held = pad.current.submitHeld(heldType, heldPayload, HOLD_MS, onDue);
            if (pad.current.events.at(-1)!.seq > base + ahead) stampedCountingTheDrop += 1;
            else stampedAfterTheDrop += 1;
            await flush();
            queue.release();
            expect(await settled(held, `k=${k}: the held tap's queue write`), `k=${k}`).not.toBeNull();
            await settled(Promise.all(taps), `k=${k}: the taps ahead`);
            await vi.advanceTimersByTimeAsync(HOLD_MS); // its hold ends and its own tick sends it
            await drive(() => server.bodies.length === ahead + 1);
            const heldKey = server.bodies[ahead]?.idempotency_key;
            const rowOnTheWire = pad.current.events.find((e) => e.id === heldKey);
            heldAnswer.resolve();
            await drive(() => pad.current.queueDepth === 0);

            expect(server.bodies.map(wire), `k=${k}: the refused tap takes no slot; every tap after it takes the next free one`).toEqual([
              [aheadTaps[0]![0], aheadTaps[0]![1], base],
              ...aheadTaps.slice(1).map(([type, payload], i) => [type, payload, base + i]),
              [heldType, heldPayload, base + ahead - 1],
            ]);
            expect(rowOnTheWire?.seq, `k=${k}: the held tap's row stays on screen, at the seq it lands at`).toBe(base + ahead);
            expect(pad.current.queueDepth, `k=${k}: nothing left queued`).toBe(0);
            expect(server.ownKeys(), `k=${k}: each tap written once, the refused one never`).toEqual(
              server.bodies.slice(1).map((b) => b.idempotency_key),
            );
            expect(rowsOf(pad.current.events), `k=${k}: the pad shows what the server holds`).toEqual(rowsOf(server.rows));

            // A second call: the next held tap is stamped from the settled ledger and lands at the next slot.
            const second = settled(pad.current.submitHeld(secondType, secondPayload, HOLD_MS, onDue), `k=${k}: the second held tap`);
            expect(await second, `k=${k}`).not.toBeNull();
            await vi.advanceTimersByTimeAsync(HOLD_MS);
            await drive(() => server.bodies.length === ahead + 2 && pad.current.queueDepth === 0);
            expect(server.bodies.slice(ahead + 1).map(wire), `k=${k}: the second held tap, at the slot after the first`).toEqual([
              [secondType, secondPayload, base + ahead],
            ]);
            expect(pad.current.queueDepth, `k=${k}`).toBe(0);
            expect(rowsOf(pad.current.events), `k=${k}: after the second held tap`).toEqual(rowsOf(server.rows));
            expect(server.rows, `k=${k}`).toHaveLength(base + ahead + 1);
          }
          // Each tap ahead that is sent adds the queue calls of its own send and re-aim. Held taps ahead: the last one
          // waits, held, for the tap made at the gate to release it (a lone one was sent by its own hold ending).
          const sentAhead = aheadHeld && ahead > 1 ? ahead - 1 : ahead;
          expect(windows, "queue calls a held tap was made at").toBeGreaterThanOrEqual(8 * sentAhead);
          expect(stampedCountingTheDrop, "held taps stamped while the refused row was still on screen (re-aimed)").toBeGreaterThan(0);
          expect(stampedAfterTheDrop, "held taps stamped after it left (never re-aimed)").toBeGreaterThan(0);
        });
      }
    }
  });

  // Review rr4. A held tap's own queue writes — its hold ending, a dock pick, a
  // take-back — each read the entry and write it back whole, and so does the
  // re-aim that moves it. Against a queue that answers in order, two of them on
  // one entry could both read before either wrote, and the second write undid
  // the first: the hold ending wrote the tap's old stamp back over the re-aim
  // (a 409 against a slot the ledger never reaches, forever: the queue blocked,
  // the point on screen and never recorded); a pick lost, or the re-aim lost; a
  // taken-back tap written back by its own hold ending and recorded anyway.
  // Generic: the race is in the queue, which never reads the sport (the C1 sweep
  // above runs football too).
  describe("a held tap's own queue writes racing the writes that move or remove it, against a queue that answers in order (review rr4)", () => {
    /** `gatedQueue(…, { inOrder: true })`, also logging each write as it is answered, on the fake clock. */
    function loggedQueue(dbName: string) {
      const gate = gatedQueue(dbName, { inOrder: true });
      const gated = queueStoreRegistry.get(dbName)!;
      const log: { at: number; op: "put" | "delete"; key: string; expectedSeq?: number; held?: boolean }[] = [];
      queueStoreRegistry.set(dbName, {
        list: () => gated.list(),
        put: (e) =>
          gated.put(e).then(() => void log.push({ at: Date.now(), op: "put", key: e.idempotencyKey, expectedSeq: e.expectedSeq, held: e.heldUntil !== undefined })),
        delete: (key) => gated.delete(key).then(() => void log.push({ at: Date.now(), op: "delete", key })),
        clear: () => gated.clear(),
      });
      /** When `key`'s hold ends on its own: its release tick is armed `HOLD_MS` out as its held write is answered —
       *  a few ms after the `heldUntil` `submitHeld` reports, which is taken before that write is even asked for. */
      const tickAt = (key: string) => {
        const write = log.find((w) => w.op === "put" && w.key === key && w.held === true);
        expect(write, `rig: ${key}'s held write is logged`).toBeDefined();
        return write!.at + HOLD_MS;
      };
      return { ...gate, log, tickAt };
    }
    const HOME = ["generic.score", { by: "H", points: 1 }] as const;
    const AWAY = ["generic.score", { by: "A", points: 1 }] as const;

    /** A refused tap on the wire and a HELD tap queued behind it, stamped one past it. */
    async function heldBehindARefusal(dbName: string) {
      const queue = loggedQueue(dbName);
      const server = ledgerServer({ faults: { 0: REFUSED } });
      const pad = mountPipeline(baseParams({ transport: server.transport, queueDbName: dbName }));
      await drive(() => false, 20);
      const head = pad.current.submit(...HOME);
      await drive(() => false, 20);
      const onDue = () => void pad.current.retryDrain();
      const held = (await settled(pad.current.submitHeld(...AWAY, HOLD_MS, onDue), "rig: the held tap's queue write"))!;
      expect([server.bodies.length, pad.current.queueDepth], "rig: the head on the wire, the held tap queued").toEqual([1, 2]);
      const headKey = server.bodies[0]!.idempotency_key;
      /** Between the refused tap leaving the queue and the re-aim writing the held tap down into its slot. */
      const reaiming = (at: number) => {
        const gone = queue.log.find((w) => w.op === "delete" && w.key === headKey)?.at;
        const moved = queue.log.find((w) => w.op === "put" && w.key === held.heldId && w.expectedSeq === 0)?.at;
        return gone !== undefined && gone <= at && (moved === undefined || at <= moved);
      };
      return { queue, server, pad, head, held, reaiming };
    }

    it("a held tap behind a refused tap whose hold ends at ANY moment around the re-aim lands at the freed slot, once, and the queue drains", async () => {
      let leads = 0;
      let endedWhileReaiming = 0;
      for (let lead = -2; lead <= 16; lead++) {
        const { queue, server, pad, head, held, reaiming } = await heldBehindARefusal(`pad-tap-rr4-tick-${lead}`);
        const tick = queue.tickAt(held.heldId);
        // The refusal is answered `lead` ms before the held tap's own hold ends.
        await vi.advanceTimersByTimeAsync(tick - Date.now() - lead);
        server.open();
        await settled(head, `lead=${lead}: the refused tap`);
        await drive(() => pad.current.queueDepth === 0 && server.rows.length === 1);
        leads += 1;
        if (reaiming(tick)) endedWhileReaiming += 1;

        expect(server.bodies.map(wire), `lead=${lead}: refused at 0; the held tap takes the slot it freed`).toEqual([
          [HOME[0], HOME[1], 0],
          [AWAY[0], AWAY[1], 0],
        ]);
        expect(server.ownKeys(), `lead=${lead}: written once`).toEqual([held.heldId]);
        expect(pad.current.queueDepth, `lead=${lead}: nothing left queued`).toBe(0);
        expect(pad.current.lastRejection?.code, `lead=${lead}: the refusal is still said`).toBe("INVALID_EVENT");
        expect(rowsOf(pad.current.events), `lead=${lead}: the pad shows what the server holds`).toEqual(rowsOf(server.rows));
      }
      expect(leads, "moments checked").toBe(19);
      expect(endedWhileReaiming, "holds that ended while the re-aim was moving the held tap").toBeGreaterThan(0);
    });

    it("a dock pick on a held tap behind a refused tap, made at ANY queue call, keeps the pick AND the freed slot", async () => {
      const PICKED = { ...AWAY[1], scorer: "p9" };
      let windows = 0;
      let pickedWhileReaiming = 0;
      for (let k = 1; k < 200; k++) {
        const { queue, server, pad, head, held, reaiming } = await heldBehindARefusal(`pad-tap-rr4-pick-${k}`);
        queue.arm(k);
        server.open();
        await drive(queue.hit);
        if (!queue.hit()) {
          await settled(head, `k=${k}: the refused tap`); // the drain went idle before its k-th queue call: every window is covered
          break;
        }
        windows += 1;
        if (reaiming(Date.now())) pickedWhileReaiming += 1;
        // The dock's own store over the pad's queue, as pad-host builds it.
        const pick = makeDockStore(pad.current.queueStore).mutateHeld(held.heldId, (p) => ({ ...p, scorer: "p9" }));
        await flush();
        queue.release();
        expect(await settled(pick, `k=${k}: the pick`), `k=${k}: the pick found the tap still held`).toBe(true);
        await settled(head, `k=${k}: the refused tap`);
        await vi.advanceTimersByTimeAsync(HOLD_MS); // its hold ends and its own tick sends it
        await drive(() => pad.current.queueDepth === 0 && server.rows.length === 1);

        expect(server.bodies.map(wire), `k=${k}: the picked tap, at the slot the refused one freed`).toEqual([
          [HOME[0], HOME[1], 0],
          [AWAY[0], PICKED, 0],
        ]);
        expect(server.ownKeys(), `k=${k}: written once`).toEqual([held.heldId]);
        expect(pad.current.queueDepth, `k=${k}: nothing left queued`).toBe(0);
        expect(rowsOf(pad.current.events), `k=${k}: the pad shows what the server holds`).toEqual(rowsOf(server.rows));
      }
      expect(windows, "queue calls a pick was made at").toBeGreaterThanOrEqual(8);
      expect(pickedWhileReaiming, "picks made while the re-aim was moving the held tap").toBeGreaterThan(0);
    });

    it("a take-back made at ANY moment around the held tap's own hold ending is taken back and never recorded, or refused and recorded once — never both", async () => {
      const outcomes = { takenBack: 0, refused: 0 };
      let askedAsTheHoldEnded = 0;
      for (let lead = -4; lead <= 14; lead++) {
        const DB = `pad-tap-rr4-takeback-${lead}`;
        const queue = loggedQueue(DB);
        const server = ledgerServer();
        server.open();
        const pad = mountPipeline(baseParams({ transport: server.transport, queueDbName: DB }));
        await drive(() => false, 20);
        const onDue = () => void pad.current.retryDrain();
        const held = (await settled(pad.current.submitHeld(...HOME, HOLD_MS, onDue), "rig: the held tap's queue write"))!;
        const behind = pad.current.submit(...AWAY); // sent at once, so it waits behind the held tap
        await drive(() => false, 40);
        expect([server.bodies.length, pad.current.queueDepth], "rig: nothing passes the held tap").toEqual([0, 2]);

        // The take-back is asked for `lead` ms before the hold ends on its own (after it, for a negative lead).
        const tick = queue.tickAt(held.heldId);
        await vi.advanceTimersByTimeAsync(tick - Date.now() - lead);
        const askedAt = Date.now();
        const dropped = await settled(pad.current.dropHeldSubmission(held.heldId), `lead=${lead}: the take-back`);
        if (askedAt < tick && tick <= Date.now()) askedAsTheHoldEnded += 1;
        await settled(behind, `lead=${lead}: the tap behind`);
        await drive(() => pad.current.queueDepth === 0 && server.rows.some((r) => (r.payload as { by?: string }).by === "A"));

        const by = (side: string) => server.rows.filter((r) => (r.payload as { by?: string }).by === side);
        if (dropped) {
          outcomes.takenBack += 1;
          expect(by("H"), `lead=${lead}: taken back, so never recorded`).toEqual([]);
          expect(
            server.bodies.filter((b) => b.idempotency_key === held.heldId),
            `lead=${lead}: and never sent`,
          ).toEqual([]);
        } else {
          outcomes.refused += 1;
          expect(by("H"), `lead=${lead}: refused (its hold had ended), so recorded once`).toHaveLength(1);
        }
        expect(by("A"), `lead=${lead}: the tap behind, recorded once`).toHaveLength(1);
        expect(pad.current.queueDepth, `lead=${lead}: nothing left queued`).toBe(0);
        expect(rowsOf(pad.current.events), `lead=${lead}: the pad shows what the server holds`).toEqual(rowsOf(server.rows));
      }
      expect(outcomes.takenBack, "take-backs that took the tap back").toBeGreaterThan(0);
      expect(outcomes.refused, "take-backs refused because the hold had ended").toBeGreaterThan(0);
      expect(askedAsTheHoldEnded, "take-backs still being decided when the hold ended on its own").toBeGreaterThan(0);
    });

    // The second call. A take-back decides "still held, so re-aim the taps behind
    // it" — two of the same tap at once (a double press) both decided it, and the
    // tap behind moved down twice for one tap taken back: stamped below the
    // ledger, a 409 forever. Once writes stopped losing each other this surfaced;
    // before, one of the two shifts was lost and both take-backs answered true.
    it("two take-backs of one held tap at once, the second asked at ANY queue call of the first: one takes it back, the other is refused, and the tap behind lands at the freed slot", async () => {
      let windows = 0;
      for (let k = 1; k < 200; k++) {
        const DB = `pad-tap-rr4-twice-${k}`;
        const queue = gatedQueue(DB, { inOrder: true });
        const server = ledgerServer();
        server.open();
        const pad = mountPipeline(baseParams({ transport: server.transport, queueDbName: DB }));
        await drive(() => false, 20);
        const held = (await settled(pad.current.submitHeld(...HOME, HOLD_MS, vi.fn()), "rig: the held tap's queue write"))!;
        const behind = pad.current.submit(...AWAY);
        await drive(() => false, 40);
        expect([server.bodies.length, pad.current.queueDepth], "rig: nothing passes the held tap").toEqual([0, 2]);

        queue.arm(k);
        const first = pad.current.dropHeldSubmission(held.heldId);
        await drive(queue.hit);
        if (!queue.hit()) {
          expect(await settled(first, `k=${k}: the take-back`)).toBe(true); // it went idle before its k-th queue call: every window is covered
          await settled(behind, `k=${k}: the tap behind`);
          break;
        }
        windows += 1;
        const second = pad.current.dropHeldSubmission(held.heldId);
        await flush();
        queue.release();
        const answers = [await settled(first, `k=${k}: the first take-back`), await settled(second, `k=${k}: the second`)];
        await settled(behind, `k=${k}: the tap behind`);
        await drive(() => pad.current.queueDepth === 0 && server.rows.length === 1);

        expect(answers.filter((taken) => taken), `k=${k}: taken back once (answers ${JSON.stringify(answers)})`).toHaveLength(1);
        expect(server.bodies.map(wire), `k=${k}: only the tap behind is sent, at the slot the taken-back tap freed`).toEqual([
          [AWAY[0], AWAY[1], 0],
        ]);
        expect(pad.current.queueDepth, `k=${k}: nothing left queued`).toBe(0);
        expect(rowsOf(pad.current.events), `k=${k}: the pad shows what the server holds`).toEqual(rowsOf(server.rows));
      }
      expect(windows, "queue calls the second take-back was asked at").toBeGreaterThanOrEqual(4);
    });
  });

  // Review I-B. A take-back inside the hold window removes the held tap without
  // sending it, so every tap queued behind it was stamped one slot too far: the
  // slot the held tap would have taken. Football, because a held tap is what a
  // dock sport's goal is (`softCommitPlan` says so below); the period advance and
  // the undo behind it are sent at once. The queue arithmetic is sport-independent.
  describe("taps queued behind a held tap that is taken back (review I-B)", () => {
    const football = resolveModuleClient("football", "1.0.0");
    const cfg = football.configSchema.parse({});
    const lineups = defaultLineupPair(resolvePositions(football, cfg));
    const skin = footballSkinV3((key) => key);
    const AT = "2026-11-14T00:00:00.000Z";
    const ledger = [
      { id: "fb-1", seq: 1, type: "core.start", payload: {} },
      { id: "fb-2", seq: 2, type: "football.goal", payload: { by: lineups.home.entrantId } },
    ];
    /** The ledger's first `n` rows, as the server holds them and as the page hands them to the pad. */
    const seeded = (n: number) => ({
      rows: ledger.slice(0, n).map((r): LedgerSlotEvent => ({ ...r, recorded_at: AT, recorded_by: "console-user", device_link_id: null })),
      envelopes: ledger.slice(0, n).map((r): EventEnvelope => ({ ...r, fixtureId: "fx-1", recordedAt: AT, recordedBy: "console-user" })),
    });
    /** What pad-host does with a tap: `softCommitPlan` over the dock the skin offers on the live fold. */
    const planOf = (state: unknown, type: string, payload: Record<string, unknown>) => {
      const view: PadHostView = {
        cfg,
        state,
        summary: {},
        phase: resolvePhase({ state }),
        band: 3,
        entitlements: {},
        personNames: {},
        squads: initSquads(lineups) as PadHostView["squads"],
        events: [],
        contextOverrides: {},
        stageKind: null,
        canOrganise: true,
        entrantNames: {},
      };
      return softCommitPlan(dockFor(skin, type, view, payload), payload);
    };

    /** A server holding the first `n` ledger rows, answering every POST at once, and a pad mounted on them. */
    async function mountOn(n: number) {
      const { rows, envelopes } = seeded(n);
      const server = ledgerServer({ seed: rows });
      server.open();
      const pad = mountPipeline(baseParams({ module: football, cfg, lineups, transport: server.transport, initialEvents: envelopes }));
      await flush();
      return { server, pad };
    }

    /** Hold a goal, queue `type`/`payload` behind it (sent at once by pad-host), then take the goal back. */
    async function takeBackHeldGoalWith(pad: ReturnType<typeof mountPipeline>, type: string, payload: Record<string, unknown>) {
      const goal = { by: lineups.away.entrantId };
      expect(planOf(pad.current.state, "football.goal", goal), "rig: a goal is held for its dock").toBe("hold");
      const held = await pad.current.submitHeld("football.goal", goal, HOLD_MS, vi.fn());
      await pad.current.submit(type, payload);
      expect(pad.current.queueDepth, "rig: the tap waits behind the held goal").toBe(2);
      const decision = decideUndo(held!.heldId, held!.heldId);
      expect(decision.kind, "rig: inside the window, take-back drops rather than voids").toBe("drop");
      expect(await pad.current.dropHeldSubmission(held!.heldId)).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
    }

    it("a period advance queued behind the held goal is sent at the goal's slot once the goal is taken back — no second tap needed", async () => {
      const { server, pad } = await mountOn(1);
      const halfTime = { phase: "HT" };
      expect(planOf(pad.current.state, "football.period", halfTime), "rig: a period advance is sent at once").toBe("send");

      await takeBackHeldGoalWith(pad, "football.period", halfTime);

      expect(server.bodies.map((b) => [b.type, b.expected_seq]), "the slot after the ledger's last row").toEqual([["football.period", 1]]);
      expect(pad.current.queueDepth).toBe(0);
      expect(server.rows.map((r) => [r.type, r.seq])).toEqual([
        ["core.start", 1],
        ["football.period", 2],
      ]);
      expect(pad.current.events.map((e) => [e.type, e.seq]), "no row left for the goal, none twice for the period").toEqual([
        ["core.start", 1],
        ["football.period", 2],
      ]);
    });

    it("a take-back that arrives after the goal's hold ended changes nothing: refused, the goal stays on screen and the tap behind it keeps its slot", async () => {
      const { server, pad } = await mountOn(1);
      const goal = { by: lineups.away.entrantId };
      const held = await pad.current.submitHeld("football.goal", goal, HOLD_MS, vi.fn()); // the tick only ends the hold
      await pad.current.submit("football.period", { phase: "HT" });
      await vi.advanceTimersByTimeAsync(HOLD_MS);
      expect((await pad.current.queueStore.list())[0]?.heldUntil, "rig: the hold has ended").toBeUndefined();

      expect(await pad.current.dropHeldSubmission(held!.heldId), "too late to take back: it will be sent").toBe(false);

      expect(pad.current.events.map((e) => [e.type, e.seq])).toEqual([
        ["core.start", 1],
        ["football.goal", 2],
        ["football.period", 3],
      ]);
      expect((await pad.current.queueStore.list()).map((e) => e.expectedSeq)).toEqual([1, 2]);
      await pad.current.retryDrain();
      expect(server.rows.map((r) => [r.type, r.seq])).toEqual([
        ["core.start", 1],
        ["football.goal", 2],
        ["football.period", 3],
      ]);
      expect(server.bodies.map((b) => b.expected_seq), "each at its own slot, first time").toEqual([1, 2]);
    });

    it("an undo of an earlier goal queued behind the held goal is sent at the goal's slot once the goal is taken back", async () => {
      const { server, pad } = await mountOn(2);

      await takeBackHeldGoalWith(pad, "core.void", { event_id: "fb-2" });

      expect(server.bodies.map((b) => [b.type, b.expected_seq])).toEqual([["core.void", 2]]);
      expect(pad.current.queueDepth).toBe(0);
      expect(pad.current.events.map((e) => [e.type, e.seq])).toEqual([
        ["core.start", 1],
        ["football.goal", 2],
        ["core.void", 3],
      ]);
      expect((pad.current.summary as { headline: string }).headline, "the held goal never counted, the voided one no longer does").toBe(
        "0 — 0",
      );
    });
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
    // Whatever the stream's catch-up on subscribe did at mount is settled by
    // now; only reads from here on are the ticks this test is about. (Here
    // the catch-up comes due before the drain is out, so it has already read;
    // the case where it comes due DURING a drain is the test below.)
    const readsAtRest = listEventsSince.mock.calls.length;

    await vi.advanceTimersByTimeAsync(1_000); // a poll tick is due WHILE the drain is still in flight
    expect(listEventsSince).toHaveBeenCalledTimes(readsAtRest); // suppressed by writeInFlight

    gate.resolve(success(1));
    await submitPromise;

    await vi.advanceTimersByTimeAsync(1_000); // drain finished — the NEXT tick may fetch
    expect(listEventsSince).toHaveBeenCalledTimes(readsAtRest + 1);
  });

  // A pad that reopens with a leftover queue drains it at mount — the same
  // moment the stream's catch-up comes due. A tick may skip a drain (the next
  // tick comes round); the catch-up runs once, so it waits the drain out.
  it("a leftover queue drained at mount does not swallow the stream's catch-up — the read goes out once the drain settles", async () => {
    const DB_NAME = "catch-up-after-mount-drain";
    const tokenDoor = deferred<void>();
    const ack = deferred<AppendCallResult>();
    const appendCalls: AppendEventBody[] = [];
    const listEventsSince = vi.fn(async (): Promise<LedgerSlotEvent[]> => []);
    const transport: PadTransport = {
      async appendEvent(_fixtureId, body) {
        appendCalls.push(body);
        return ack.promise;
      },
      listEventsSince,
      async getLastSeq() {
        return 0;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 0, state: null, summary: null, outcome: null };
      },
    };
    await enqueue(indexedDbQueueStore(DB_NAME), {
      localId: "local-leftover-1",
      idempotencyKey: "idem-leftover-1",
      type: "generic.score",
      payload: { by: "H", points: 1 },
      expectedSeq: 0,
      createdAt: "2026-09-25T00:00:00.000Z",
      attempts: 0,
    });
    const pad = mountPipeline(
      baseParams({
        transport,
        queueDbName: DB_NAME,
        // The token door answers only once the drain is out, so the catch-up
        // comes due DURING it.
        streamFetchFn: (async () => {
          await tokenDoor.promise;
          return fakeResponse(200, { ok: true, data: { token: "t", channel: "c" } });
        }) as unknown as typeof fetch,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(appendCalls, "the leftover is on the wire").toHaveLength(1);
    tokenDoor.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(listEventsSince, "no read while the drain is out").not.toHaveBeenCalled();

    ack.resolve(success(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(pad.current.queueDepth).toBe(0);
    expect(listEventsSince.mock.calls, "the catch-up, once the drain has settled").toEqual([["fx-1", 1]]);
  });

  // A realtime pad reads twice as it subscribes — as the channel is requested
  // and again as it joins — and the second read can go out before the first
  // one's rows have moved the cursor. Both then carry the same rows; the merge
  // keys them by seq, so they land once.
  it("the catch-up and the join read can both carry the same row — it lands in the ledger once", async () => {
    let join!: () => void;
    const joinsLater: RealtimeConnector = {
      connect(params) {
        join = () => params.onStatus(true);
        return { unsubscribe() {} };
      },
    };
    const joinWindowRow: LedgerSlotEvent = {
      id: "foreign-join-window-1",
      seq: 1,
      type: "core.note",
      payload: { text: "written while the channel joined" },
      recorded_at: "2026-09-25T00:00:00.000Z",
      recorded_by: "user-2",
      device_link_id: null,
    };
    // Answers every read with the row, whatever the cursor: the two reads
    // overlap by construction, not by timing.
    const listEventsSince = vi.fn(async (): Promise<LedgerSlotEvent[]> => [joinWindowRow]);
    const transport: PadTransport = {
      async appendEvent() {
        throw new Error("not used by this test");
      },
      listEventsSince,
      async getLastSeq() {
        return 0;
      },
      // `state: null` is reconcileAfterAck's no-op, so only the merge shapes
      // the ledger below.
      async fetchState() {
        return { status: "in_play", last_seq: 1, state: null, summary: null, outcome: null };
      },
    };
    const pad = mountPipeline(baseParams({ transport, streamConnector: joinsLater }));
    await vi.advanceTimersByTimeAsync(0);
    expect(listEventsSince, "the catch-up, as the channel is requested").toHaveBeenCalledTimes(1);
    expect(pad.current.events.map((e) => e.id)).toEqual(["foreign-join-window-1"]);

    join();
    await vi.advanceTimersByTimeAsync(0);
    expect(listEventsSince, "the join's read").toHaveBeenCalledTimes(2);
    expect(pad.current.events.map((e) => e.id)).toEqual(["foreign-join-window-1"]);
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
    // `drainInFlight`), so `writeInFlight` does NOT suppress this poll tick.
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
    await tick(); // the stream's catch-up on subscribe lands before the tap

    await pad.current.submit("core.void", { event_id: "e-2" });
    await tick();

    expect(appendCalls[0]?.payload).toEqual({ event_id: "e-2" });
    // The ONE read is the stream's catch-up, from the seed's own count (2) —
    // no resolution round trip joined it.
    expect(listEventsSince.mock.calls).toEqual([["fx-1", 2]]);
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
    // A match already under way, as a reload finds it — and a seed that is
    // not empty keeps the stream's catch-up off cursor 0, so the read below
    // can be pinned exactly rather than excused.
    const initialEvents = [
      { id: "srv-start-1", fixtureId: "fx-1", seq: 1, type: "core.start", payload: {}, recordedAt: "2026-08-13T00:00:00.000Z", recordedBy: "user-1" },
      { id: "srv-score-2", fixtureId: "fx-1", seq: 2, type: "generic.score", payload: { by: "H", points: 1 }, recordedAt: "2026-08-13T00:00:01.000Z", recordedBy: "user-1" },
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
        return 2;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 3, state: null, summary: null, outcome: null };
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
      expectedSeq: 2,
      createdAt: "2026-08-13T00:00:02.000Z",
      attempts: 0,
      // voidTargetSeq deliberately absent — the exact shape under test.
    };
    await enqueue(store, legacyVoid);

    // A genuinely fresh mount — ownEventIds starts empty exactly like a real
    // reload, and nothing here ever calls submit(), so voidTargetSeq is never
    // set any other way either.
    const pad = mountPipeline(baseParams({ transport, queueDbName: DB_NAME, initialEvents }));
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
    // throw today. So the one read is the stream's catch-up on subscribe, and
    // nothing else.
    expect(listEventsSince.mock.calls).toEqual([["fx-1", 2]]);
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

// ScoringPad v3 R1 chassis soft-commit — task 4 FIX ROUND 1 (controller
// review, both Important findings independently confirming concerns raised
// in the original task-4-report.md).
//
// Finding 1: the mount resume effect (above, the "Resume a leftover queue
// from a previous session" effect) re-seeds a leftover held entry into
// `pendingEnvelopes` and correctly lets runDrain's own guard skip it, but
// armed no tick for it — queue.ts's release-tick registry is in-memory only
// by design (a live JS closure cannot survive a reload), so the entry's
// PRE-reload tick died with the tab. Nothing else in this file would ever
// call runDrain again on its behalf (no interval/poll anywhere — the only
// triggers are this mount effect once, the `online` listener, and submit()).
// Fixed by re-arming a fresh tick for the REMAINING window in that same loop.
//
// Finding 2: `UsePadPipelineResult` had no drain trigger at all — `runDrain`
// was a private useCallback. Controller ruling: widen the hook now rather
// than leave Task 7's Dock to guess. Fixed by exposing the SAME `runDrain`
// callback as `retryDrain` — no reshaping needed, exactly the "expose the
// existing callback" the controller asked for.
describe("usePadPipeline — task 4 fix round 1 (controller review findings 1 & 2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("finding 2: retryDrain is a public trigger for a real drain pass, with no submit() involved", async () => {
    const { transport, appendCalls } = fakeTransport({ appendResults: [success(1)] });
    const pad = mountPipeline(baseParams({ transport }));
    await vi.advanceTimersByTimeAsync(0); // let the mount-time resume/drain effect settle first

    // Seeded directly, bypassing submit() — same pattern as the describe
    // block above and the pass-J backward-compat test: proves retryDrain
    // itself does the draining, not some side effect of how the event
    // arrived in the store.
    const store = indexedDbQueueStore("scorepad-queue-fx-1");
    await enqueue(store, {
      localId: "direct-1",
      idempotencyKey: "direct-1",
      type: "generic.score",
      payload: { by: "H", points: 7 },
      expectedSeq: 0,
      createdAt: new Date().toISOString(),
      attempts: 0,
    });
    expect(appendCalls).toHaveLength(0); // nothing has triggered a drain yet

    await pad.current.retryDrain();

    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.body.payload).toEqual({ by: "H", points: 7 });
    expect(pad.current.queueDepth).toBe(0);
  });

  it("finding 1: a leftover held entry re-arms its own tick on resume and sends once its REMAINING window closes, with no further trigger", async () => {
    const { transport, appendCalls } = fakeTransport({ appendResults: [success(1)] });
    const DB_NAME = "soft-commit-resume-rearm";
    const store = indexedDbQueueStore(DB_NAME);

    // Simulate a tap that happened, then the tab died 2s into its 6s hold —
    // enqueueHeld's own in-memory tick died with it (queue.ts's registry is
    // not durable by design); only the durable `heldUntil` survives, same
    // shape reload durability already proves at the queue.ts level in
    // soft-commit.test.ts.
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
      () => {}, // belongs to the pre-"reload" instance — irrelevant to this test
    );
    await vi.advanceTimersByTimeAsync(2000); // 2s elapsed pre-"reload"; HOLD_MS-2000 of the window remains

    // A genuinely fresh mount — matching a real reload (ownEventIds starts
    // empty, exactly like the pass-J backward-compat test above).
    const pad = mountPipeline(baseParams({ transport, queueDbName: DB_NAME }));
    await vi.advanceTimersByTimeAsync(0); // let the resume effect's async IIFE settle

    expect(appendCalls).toHaveLength(0); // still held — must not send early
    expect(pad.current.queueDepth).toBe(1);

    // Expressed in HOLD_MS, not the literal it used to be: 2000ms of the
    // window elapsed before the "reload", so this lands 1ms short of it.
    await vi.advanceTimersByTimeAsync(HOLD_MS - 2000 - 1);
    expect(appendCalls).toHaveLength(0);

    // t=HOLD_MS since the ORIGINAL enqueue: the REMAINING window (not a fresh
    // HOLD_MS from mount time, which would land later) closes. No
    // submit()/online event anywhere in this test — only the resume
    // effect's own re-armed tick can be responsible for what happens next.
    await vi.advanceTimersByTimeAsync(1);
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.body.payload).toEqual({ by: "H", points: 1 });
    expect(pad.current.queueDepth).toBe(0);
  });
});

// R2 (spec §2.3, task B — v3 pad host): the soft-commit entry point the
// dock's held path actually calls. `submit()` above is UNTOUCHED — same
// enqueue()+runDrain() behaviour it always had — this is a SEPARATE method
// sharing its double-submit guard/expectedSeq/optimistic-commit machinery
// (same refs, same closure) but enqueuing HELD (queue.ts's `enqueueHeld`)
// and never calling `runDrain` itself: "only the enqueue -> send moment
// moves" (spec §2.3's own framing). `dropHeldSubmission` is the undo-INSIDE-
// the-window half: queue.ts's `dropHeld` (no network, no core.void) PLUS the
// matching `pendingEnvelopes` rollback `dropHeld` alone cannot reach, since
// that map is this hook's own private state.
describe("usePadPipeline — R2 soft-commit entry point (submitHeld / dropHeldSubmission)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances the optimistic fold immediately but defers the send until onDue fires and a drain is triggered", async () => {
    const { transport, appendCalls } = fakeTransport({ appendResults: [success(1)] });
    const pad = mountPipeline(baseParams({ transport }));
    await vi.advanceTimersByTimeAsync(0); // let the mount-time resume/drain effect settle first

    const onDue = vi.fn();
    const held = await pad.current.submitHeld("generic.score", { by: "H", points: 3 }, HOLD_MS, onDue);

    expect(held).not.toBeNull();
    expect((pad.current.state as { running: { home: number; away: number } }).running).toEqual({ home: 3, away: 0 });
    expect(appendCalls).toHaveLength(0); // durably queued, not sent
    expect(pad.current.queueDepth).toBe(1);

    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(onDue).toHaveBeenCalledTimes(1); // the hold's own release tick fired
    expect(appendCalls).toHaveLength(0); // firing onDue is not itself a send — nothing here calls retryDrain

    // The dock's real onDue is `() => void pipeline.retryDrain()` — proved
    // directly, not assumed: calling it now is what actually sends.
    await pad.current.retryDrain();
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.body.payload).toEqual({ by: "H", points: 3 });
    expect(pad.current.queueDepth).toBe(0);
  });

  it("releasing early (Dock 'send now') sends without waiting out the rest of the window", async () => {
    const { transport, appendCalls } = fakeTransport({ appendResults: [success(1)] });
    const pad = mountPipeline(baseParams({ transport }));
    await vi.advanceTimersByTimeAsync(0);

    const onDue = vi.fn(() => {
      void pad.current.retryDrain();
    });
    const held = await pad.current.submitHeld("generic.score", { by: "A", points: 2 }, HOLD_MS, onDue);
    expect(held).not.toBeNull();

    await releaseHeld(pad.current.queueStore, held!.heldId); // the SAME store retryDrain/enqueueHeld share
    await vi.advanceTimersByTimeAsync(0);

    expect(onDue).toHaveBeenCalledTimes(1);
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.body.payload).toEqual({ by: "A", points: 2 });

    // The now-cancelled natural tick must never ALSO fire a second send.
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(appendCalls).toHaveLength(1);
  });

  it("shares submit()'s double-submit guard: an identical action within the window holds nothing new — AND the refusal is VISIBLE (R7-42/R7-30, this is the copy every real v3 tap calls)", async () => {
    const { transport } = fakeTransport({ appendResults: [] });
    const pad = mountPipeline(baseParams({ transport }));
    await vi.advanceTimersByTimeAsync(0);

    const first = await pad.current.submitHeld("generic.score", { by: "H", points: 1 }, HOLD_MS, vi.fn());
    const second = await pad.current.submitHeld("generic.score", { by: "H", points: 1 }, HOLD_MS, vi.fn());

    expect(first).not.toBeNull();
    expect(second).toBeNull(); // identical action, accepted too recently — same DOUBLE_SUBMIT_WINDOW_MS submit() uses
    expect(pad.current.queueDepth).toBe(1); // only one entry was ever held
    expect(pad.current.lastRejection?.code).toBe("DOUBLE_SUBMIT"); // no longer a silent no-op
  });

  it("the same window refuses a SAME-TICK identical submitHeld (one press read twice, two bound handlers) — visibly, holding one entry", async () => {
    const { transport } = fakeTransport({ appendResults: [] });
    const pad = mountPipeline(baseParams({ transport }));
    await vi.advanceTimersByTimeAsync(0);

    const [first, second] = await Promise.all([
      pad.current.submitHeld("generic.score", { by: "H", points: 1 }, HOLD_MS, vi.fn()),
      pad.current.submitHeld("generic.score", { by: "H", points: 1 }, HOLD_MS, vi.fn()),
    ]);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(pad.current.queueDepth).toBe(1);
    expect(pad.current.lastRejection?.code).toBe("DOUBLE_SUBMIT");
  });

  it("dropHeldSubmission undoes a still-held tap with no network call, no core.void, and reverts the optimistic fold", async () => {
    const { transport, appendCalls } = fakeTransport({ appendResults: [] });
    const pad = mountPipeline(baseParams({ transport }));
    await vi.advanceTimersByTimeAsync(0);

    const held = await pad.current.submitHeld("generic.score", { by: "H", points: 5 }, HOLD_MS, vi.fn());
    expect(held).not.toBeNull();
    expect((pad.current.state as { running: { home: number; away: number } }).running).toEqual({ home: 5, away: 0 });

    const dropped = await pad.current.dropHeldSubmission(held!.heldId);
    expect(dropped).toBe(true);
    // Reverted — exactly as if the tap never happened (`ledgerEvents` alone,
    // matching the "optimistic fold" describe block's own pre-tap assertion).
    expect((pad.current.state as { running: unknown }).running).toBeUndefined();
    expect(pad.current.queueDepth).toBe(0);

    await vi.advanceTimersByTimeAsync(HOLD_MS); // the (cancelled) release tick must never fire a send either
    expect(appendCalls).toHaveLength(0);
    expect(appendCalls.some((c) => c.body.type === "core.void")).toBe(false);
  });

  it("dropHeldSubmission is a no-op for an id that names no currently-held entry (already sent, or never held)", async () => {
    const { transport } = fakeTransport({ appendResults: [] });
    const pad = mountPipeline(baseParams({ transport }));
    await vi.advanceTimersByTimeAsync(0);

    expect(await pad.current.dropHeldSubmission("ghost")).toBe(false);
  });

  it("queueStore is the SAME store submit()'s own plain enqueue path drains — a plain submit still sends normally", async () => {
    const { transport, appendCalls } = fakeTransport({ appendResults: [success(1)] });
    const pad = mountPipeline(baseParams({ transport }));
    await vi.advanceTimersByTimeAsync(0);

    // Seeded directly against the exposed store, bypassing submit()/
    // submitHeld() entirely — proves `queueStore` is genuinely the hook's
    // own live store (same pattern the R1 fix-round-1 tests above use via
    // `indexedDbQueueStore("scorepad-queue-fx-1")`), not a disconnected copy.
    await enqueue(pad.current.queueStore, {
      localId: "direct-2",
      idempotencyKey: "direct-2",
      type: "generic.score",
      payload: { by: "A", points: 9 },
      expectedSeq: 0,
      createdAt: new Date().toISOString(),
      attempts: 0,
    });
    await pad.current.retryDrain();

    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.body.payload).toEqual({ by: "A", points: 9 });
  });
});

// R5 (file header, "SCOPE BOUNDARY, R5 UPDATE" — a FOREIGN core.void crashes
// the pad): passes G-J above only ever fixed a void THIS hook itself
// submitted. This is the other direction — a THIRD PARTY (the fixture
// console) undoes an event THIS pad just scored, live, and that undo arrives
// back as a foreign write: a fresh `initialEvents` batch, exactly what a
// console `router.refresh()` hands this hook after its own "Undo last". The
// console always names the SERVER's real row id (it never fabricates one) —
// but `ledgerEvents` had kept the SAME event under the CLIENT-fabricated
// idempotency key `pendingToEnvelope` stamps on it at ack time (pass F), and
// `mergeEnvelopesIntoLedger`'s own "existing wins" default silently
// discarded the fresher, correctly-id'd copy the SAME batch carried for it —
// so the void's target was never resolvable. Reproduced here entirely
// through this hook's own public surface: no cricket, no skin needed —
// `generic.score`/`core.void` are enough.
describe("usePadPipeline — a foreign console-driven void resolves against a locally-scored event (R5)", () => {
  it("MUTATION TARGET: a fresh initialEvents batch carrying BOTH the real id for a locally-scored event AND a void naming it reconciles cleanly — no rejection, the score genuinely reverts", async () => {
    const REAL_SERVER_ID = "server-real-score-id-r5";
    const { transport } = fakeTransport({ appendResults: [success(1)] });
    const pad = mountPipeline(baseParams({ transport }));

    // Scored LIVE, through this pad, and acked — `ledgerEvents` now holds it
    // under the CLIENT-fabricated idempotency key forever within this mount
    // (pass F's own documented behaviour: AppendSuccess carries no row id).
    await pad.current.submit("generic.score", { by: "H", points: 2 });
    const scoredClientId = pad.current.events.find((e) => e.type === "generic.score")!.id;
    expect(pad.current.ownEventIds.has(scoredClientId)).toBe(true);
    expect((pad.current.state as { running: { home: number; away: number } }).running).toEqual({
      home: 2,
      away: 0,
    });

    // The console's own undo round trip: a fresh `initialEvents` batch, built
    // server-side (`eventOutToEnvelope`, wire.ts), containing the SERVER's
    // canonical copy of the SAME scored event (same seq, REAL id — never the
    // client-fabricated one) AND the console's own core.void, naming that
    // real id — exactly what a real `router.refresh()` after
    // fixture-console.tsx's "Undo last" hands this hook.
    const serverScoreRow: EventEnvelope = {
      id: REAL_SERVER_ID,
      fixtureId: "fx-1",
      seq: 1,
      type: "generic.score",
      payload: { by: "H", points: 2 },
      recordedAt: "2026-08-28T00:00:00.000Z",
      recordedBy: "user-1",
    };
    const consoleVoid: EventEnvelope = {
      id: "console-void-1",
      fixtureId: "fx-1",
      seq: 2,
      type: "core.void",
      payload: {},
      recordedAt: "2026-08-28T00:00:05.000Z",
      recordedBy: "console-user",
      voids: REAL_SERVER_ID,
    };
    pad.rerender(baseParams({ transport, initialEvents: [serverScoreRow, consoleVoid] }));

    // THE regression: without the fix, resolveVoids (packages/engine/src/
    // core/events.ts) can never find `REAL_SERVER_ID` in the folded list —
    // ledgerEvents still only knows the scored event under the CLIENT id —
    // and throws INVALID_EVENT on every fold from here on, degrading to the
    // frozen pre-undo state (S3/#426 OWNER RULING 2) instead of reflecting
    // the undo. Fixed: the seq-1 collision now adopts the wire-sourced id.
    expect(pad.current.lastRejection).toBeNull();
    expect((pad.current.state as { running: unknown }).running).toBeUndefined();

    // And directly, on the reconciliation itself: the scored event's id in
    // this hook's own ledger must have been corrected to the server's real
    // one, not merely have the crash suppressed over a still-broken fold.
    const scoredInLedger = pad.current.events.find((e) => e.seq === 1);
    expect(scoredInLedger?.id).toBe(REAL_SERVER_ID);
    expect(scoredInLedger?.id).not.toBe(scoredClientId);
  });
});

// R5, the OTHER half of the same defect (file header, "A SECOND, INDEPENDENT
// half"): the test above routes the console's undo through a fresh
// `initialEvents` batch, which carries a full envelope. Reached through a
// POLL instead — the path ANY void this device did not itself submit takes,
// a second referee's as much as the console's — the void used to arrive with
// no target at all, because `LedgerSlotEvent` did not carry
// `voids_event_id` and the transport boundary parsed-then-DROPPED it. The
// engine rejects a `core.void` naming nothing exactly as it rejects one
// naming an unknown id, so the pad froze behind a rejection banner on
// whichever of the two paths won the race — which is why the volleyball
// walkthrough passed twice and failed once against the id fix alone.
describe("usePadPipeline — a foreign void arriving by POLL still names its target (R5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("MUTATION TARGET: a polled core.void carrying voids_event_id reverts the locally-scored event it names — no rejection", async () => {
    const REAL_SERVER_ID = "server-real-score-id-poll-r5";
    // The SERVER's own copy of the event this pad scored (same seq, REAL id)
    // followed by the foreign void naming it — one poll batch, which is what a
    // real `/events?since_seq=` read returns after someone else's undo lands.
    const undoneBatch: LedgerSlotEvent[] = [
      {
        id: REAL_SERVER_ID,
        seq: 1,
        type: "generic.score",
        payload: { by: "H", points: 2 },
        recorded_at: "2026-08-28T00:00:00.000Z",
        recorded_by: "user-1",
        device_link_id: null,
        voids_event_id: null,
      },
      {
        id: "poll-void-1",
        seq: 2,
        type: "core.void",
        payload: {},
        recorded_at: "2026-08-28T00:00:05.000Z",
        recorded_by: "console-user",
        device_link_id: null,
        voids_event_id: REAL_SERVER_ID,
      },
    ];
    // Neither row exists until this pad has scored: the stream's catch-up on
    // subscribe reads at mount, and a batch served then would describe a
    // score nobody had made yet.
    let scored = false;
    const listEventsSince = vi.fn(async (): Promise<LedgerSlotEvent[]> => (scored ? undoneBatch : []));
    const transport: PadTransport = {
      async appendEvent() {
        scored = true;
        return success(1);
      },
      listEventsSince,
      async getLastSeq() {
        return 2;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 2, state: null, summary: null, outcome: null };
      },
    };
    const pad = mountPipeline(
      baseParams({ transport, streamConnector: neverConfirmConnector(), streamPollMs: 1_000 }),
    );
    await vi.advanceTimersByTimeAsync(0); // the stream subscribes; its catch-up finds nothing yet

    await pad.current.submit("generic.score", { by: "H", points: 2 });
    expect((pad.current.state as { running: { home: number; away: number } }).running).toEqual({
      home: 2,
      away: 0,
    });

    await vi.advanceTimersByTimeAsync(0); // settle into polling
    await vi.advanceTimersByTimeAsync(1_000); // the poll delivers the foreign undo
    await vi.advanceTimersByTimeAsync(0); // let the follow-up fetchState resolve

    // Without voids_event_id crossing the wire boundary this void names
    // nothing, resolveVoids throws INVALID_EVENT, and the pad degrades to the
    // frozen pre-undo state behind a rejection banner instead of reverting.
    expect(pad.current.lastRejection).toBeNull();
    const polledVoid = pad.current.events.find((e) => e.seq === 2);
    expect(polledVoid?.voids).toBe(REAL_SERVER_ID);
    expect((pad.current.state as { running: unknown }).running).toBeUndefined();
  });
});

// R5 — the third and final shape of the same walkthrough red, and the one
// neither fix above touches. A tap's POST is ABORTED client-side by a page
// reload that lands mid-flight, but the SERVER had already committed the row:
// the pad only ever saw a network error, so the entry stays in the durable
// queue. After the reload the ledger has moved on (someone undid that very
// row from the console), and the resumed entry's `expectedSeq` now points
// BEHIND the ledger head. Reproduced from the real trace of
// walkthrough/scorepad-v3-volleyball-match.spec.ts: `POST -1` (aborted),
// then on resume `409 {"code":"SEQ_CONFLICT","message":"expected seq 9 but
// ledger is at 11"}`. This is why that walkthrough was red ~2 runs in 3 with
// both merge fixes in place — whether the reload catches the POST in flight
// is a race, decided differently run to run.
describe("usePadPipeline — a queued event the server already applied, resumed after a reload (R5)", () => {
  it("MUTATION TARGET: the resumed duplicate reconciles silently — no rejection banner, and the board shows the server's post-undo fold", async () => {
    const REAL_SERVER_ID = "server-real-scored-id-abort-r5";
    const DB_NAME = "r5-aborted-post-repro";
    let appendMode: "ok" | "fail" | "conflict" = "ok";
    const appendCalls: AppendEventBody[] = [];
    const ledgerRows: LedgerSlotEvent[] = [
      {
        id: REAL_SERVER_ID,
        seq: 1,
        type: "generic.score",
        payload: { by: "H", points: 2 },
        recorded_at: "2026-08-29T23:03:00.000Z",
        recorded_by: "user-1",
        device_link_id: null,
        voids_event_id: null,
      },
      {
        id: "console-void-abort-r5",
        seq: 2,
        type: "core.void",
        payload: { event_id: REAL_SERVER_ID },
        recorded_at: "2026-08-29T23:04:00.000Z",
        recorded_by: "user-1",
        device_link_id: null,
        voids_event_id: REAL_SERVER_ID,
      },
    ];
    const transport: PadTransport = {
      async appendEvent(_fixtureId, body) {
        appendCalls.push(body);
        if (appendMode === "fail") return { kind: "network-error", message: "aborted by navigation" };
        if (appendMode === "conflict") return { kind: "conflict", currentSeq: 2, message: "expected seq 0 but ledger is at 2" };
        return success(1);
      },
      async listEventsSince(_fixtureId, sinceSeq): Promise<LedgerSlotEvent[]> {
        return ledgerRows.filter((r) => r.seq > sinceSeq);
      },
      async getLastSeq() {
        return 2;
      },
      async fetchState() {
        return { status: "in_play", last_seq: 2, state: null, summary: null, outcome: null };
      },
    };

    // Mount 1: the tap goes out and the response never arrives — the reload
    // killed it. The row IS on the server; this pad has no way to know.
    appendMode = "fail";
    const pad1 = mountPipeline(baseParams({ transport, queueDbName: DB_NAME }));
    await pad1.current.submit("generic.score", { by: "H", points: 2 });
    expect(pad1.current.queueDepth).toBe(1); // queued, exactly as an abort leaves it
    pad1.unmount();

    // Mount 2: the reload. `initialEvents` is the server's own list — the
    // committed row AND the console's void of it — and the resumed queue
    // entry still carries the now-stale expectedSeq.
    appendMode = "conflict";
    const pad2 = mountPipeline(
      baseParams({
        transport,
        queueDbName: DB_NAME,
        initialEvents: ledgerRows.map((r) => ({
          id: r.id!,
          fixtureId: "fx-1",
          seq: r.seq,
          type: r.type,
          payload: r.payload,
          recordedAt: r.recorded_at!,
          recordedBy: r.recorded_by,
          ...(r.voids_event_id ? { voids: r.voids_event_id } : {}),
        })),
      }),
    );
    for (let i = 0; i < 8; i += 1) {
      await tick();
    }

    // The 409's own ledger-slot inspection proves the row is already there
    // and is ours, so the entry must be dropped silently. Before the fix the
    // resumed duplicate sat in `pendingEnvelopes` and the optimistic fold
    // folded it ON TOP of the void, which throws — the pad then degraded to
    // its last good state (the PRE-undo board) behind a rejection banner,
    // which is exactly what the walkthrough screenshot showed.
    expect(pad2.current.lastRejection).toBeNull();
    expect(pad2.current.queueDepth).toBe(0);
    expect((pad2.current.state as { running: unknown }).running).toBeUndefined();
    // Directly on the mechanism, not just the symptom: the ledger's copy of
    // the scored event must still be the SERVER's row, under the id the
    // console's void actually names.
    expect(pad2.current.events.find((e) => e.seq === 1)?.id).toBe(REAL_SERVER_ID);
    // And "is this mine" must follow the surviving copy, or the undo-own
    // affordance silently disowns an event this device really did record.
    expect(pad2.current.ownEventIds.has(REAL_SERVER_ID)).toBe(true);
  });
});

// R7-46 — the constant's own guard, and the cheapest possible statement of the
// rule the walkthrough proves the expensive way.
//
// R7-30/R7-43 was not "the window was 600" in the abstract. It was that 600ms
// reached into the range where a scorer taps DELIBERATELY — a player on a run
// produces byte-identical payloads back to back — so the pad silently recorded
// less than the scorer did. The repair is not a magic number, it is the
// relationship: the guard must stay clear of human range.
//
// This is asserted here rather than only in
// `e2e/walkthrough/scorepad-v3-honest-recording.spec.ts` because a constant
// creeping back up should red in milliseconds, not after a browser boots. And
// it is asserted as an INEQUALITY against a separately-named floor rather than
// as `toBe(250)`: pinning the literal would make every deliberate retune a
// test edit, which is how a guard becomes something people delete.
describe("R7-46: the double-submit window must stay out of human tapping range", () => {
  it("is strictly below the fastest a scorer can deliberately repeat a tap", () => {
    expect(
      DOUBLE_SUBMIT_WINDOW_MS,
      "a window at or above HUMAN_FASTEST_REPEAT_MS eats deliberate taps — this is R7-30, which shipped at 600ms",
    ).toBeLessThan(HUMAN_FASTEST_REPEAT_MS);
  });

  it("and the floor itself is a real human bound, not a value tuned to make the line above pass", () => {
    // Sustained deliberate tapping tops out around 5-8 taps/sec. A floor that
    // drifted below ~200ms would no longer describe a person, and the
    // inequality above would start passing for the wrong reason.
    expect(HUMAN_FASTEST_REPEAT_MS).toBeGreaterThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// R8/#675 — an amendment must survive a reload taken mid-hold
// ---------------------------------------------------------------------------
//
// WHY THIS LIVES HERE AND NOT BESIDE `runAmend`'s own tests. Those drive the
// real `queue.ts` primitives, but through a hand-written mirror of this file's
// wiring — and a mirror is structurally incapable of reaching the RESUME path,
// which is the one place this defect lives. This suite owns the seam that can:
// `queueStoreRegistry` (top of file) keeps a dbName's queue alive across an
// `unmount()` + fresh `mountPipeline()`, which is exactly what a reload is.
//
// THE DEFECT THIS PINS, and it is a mirror image of the one the round before it
// fixed. Round 1 enqueued the void as a durable SIBLING of the held
// replacement: it survived a reload, but nothing could cancel it, so a
// take-back stranded it and DELETED a scored event. Round 2 moved the void into
// the held entry's release CLOSURE: cancellable, but a closure does not survive
// a reload. `ticksByStore` (queue.ts) is a module-level WeakMap keyed on the
// store OBJECT and registered only by `enqueueHeld`; the resume path calls
// `releaseHeld` on a FRESH store whose tick map is empty, so `tick?.onDue()` is
// a no-op — use-pad-pipeline.ts says exactly that in its own comment. The
// replacement still sends. The void never does. Both events fold and the point
// DOUBLES, silently and durably, until a scorer notices.
//
// Neither half is the whole answer: the linkage has to be durable AND
// cancellable. Do not "simplify" this back to a closure.
describe("R8/#675 — a reload inside the amendment's hold window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("still sends the void behind the resumed replacement, so the corrected point is not counted twice", async () => {
    const DB_NAME = "amend-reload-fx";
    const REAL_SERVER_ID = "server-row-for-the-original";
    let ackSeq = 1;
    const appendCalls: AppendEventBody[] = [];
    // A transport that actually SERVES the ledger back, modelled on the pass-J
    // reload test above. It matters here for the same reason it does there: a
    // reload discards `ownEventIds`, so a queued void resolves its target
    // through the DURABLE `voidTargetSeq` plus a `listEventsSince` read. A
    // double that returns `[]` makes that read look like a transient network
    // failure, and the void then sits queued forever — which would have let
    // this test "fail" for a reason that has nothing to do with the binding.
    const transport: PadTransport = {
      async appendEvent(_fixtureId, body) {
        appendCalls.push(body);
        const seq = ackSeq;
        ackSeq += 1;
        return success(seq);
      },
      async listEventsSince(): Promise<LedgerSlotEvent[]> {
        return [
          {
            id: REAL_SERVER_ID,
            seq: 1,
            type: "generic.score",
            payload: { by: "H", points: 1 },
            recorded_at: "2026-09-02T00:00:01.000Z",
            recorded_by: "user-1",
            device_link_id: null,
          },
        ];
      },
      async getLastSeq() {
        return 0;
      },
      async fetchState(): Promise<FixtureStateResult> {
        return { status: "in_play", last_seq: 1, state: null, summary: null, outcome: null };
      },
    };

    // Mount 1: a scored, ACKED event — the one an amendment will correct.
    const pad1 = mountPipeline(baseParams({ transport, queueDbName: DB_NAME }));
    await vi.advanceTimersByTimeAsync(0);
    await pad1.current.submit("generic.score", { by: "H", points: 1 });
    const originalId = pad1.current.events.find((e) => e.type === "generic.score")!.id;
    expect(appendCalls).toHaveLength(1);

    // Clear the double-submit window: the amendment re-appends the SAME
    // (type, payload), which inside 250ms is refused by design.
    await vi.advanceTimersByTimeAsync(DOUBLE_SUBMIT_WINDOW_MS + 50);

    // THE AMENDMENT, through the real `runAmend` over the real pipeline.
    const heldId = await runAmend(
      { voidId: originalId, type: "generic.score", payload: { by: "H", points: 1 } },
      {
        submitHeld: (type, payload) => pad1.current.submitHeld(type, payload, HOLD_MS, () => {}),
        submit: (type, payload, opts) => pad1.current.submit(type, payload, opts),
      },
    );
    expect(heldId).not.toBeNull();
    expect(appendCalls, "the replacement is still held — nothing has drained").toHaveLength(1);

    // THE RELOAD. A real one: every mount effect's cleanup runs, and the fresh
    // instance gets a brand-new store object (hence a brand-new, EMPTY tick
    // map) over the same durable queue.
    pad1.unmount();
    const pad2 = mountPipeline(baseParams({ transport, queueDbName: DB_NAME }));
    await vi.advanceTimersByTimeAsync(0);
    // The resumed hold's remaining window, then its drain.
    await vi.advanceTimersByTimeAsync(HOLD_MS + 100);
    await vi.advanceTimersByTimeAsync(0);

    expect(
      appendCalls.map((c) => c.type),
      "the resumed replacement must be followed by the void that retires the original",
    ).toEqual(["generic.score", "generic.score", "core.void"]);
    expect(appendCalls[2]!.payload, "and it must name the original row, not the replacement").toEqual({
      event_id: REAL_SERVER_ID,
    });
    expect(await pad2.current.queueStore.list(), "nothing may be left queued").toEqual([]);
  });

  it("clears the bound void from the OPTIMISTIC fold too, not only from the queue", async () => {
    // Found in a browser, and it is its own defect rather than a lesser version
    // of the Critical: with the cascade in `dropHeld` alone, take-back left the
    // durable queue clean while `pendingEnvelopes` still held the void, so the
    // optimistic fold went on retiring the original. The ledger read perfectly
    // and the pad showed a scored event struck through with nothing in its
    // place — the same symptom as the Critical, one layer up.
    const DB_NAME = "amend-cancel-optimistic";
    const { transport, appendCalls } = fakeTransport({ appendResults: [success(1)] });
    const pad = mountPipeline(baseParams({ transport, queueDbName: DB_NAME }));
    await vi.advanceTimersByTimeAsync(0);
    await pad.current.submit("generic.score", { by: "H", points: 1 });
    const originalId = pad.current.events.find((e) => e.type === "generic.score")!.id;
    await vi.advanceTimersByTimeAsync(DOUBLE_SUBMIT_WINDOW_MS + 50);

    const heldId = await runAmend(
      { voidId: originalId, type: "generic.score", payload: { by: "H", points: 1 } },
      {
        submitHeld: (type, payload) => pad.current.submitHeld(type, payload, HOLD_MS, () => {}),
        submit: (type, payload, opts) => pad.current.submit(type, payload, opts),
      },
    );
    expect(pad.current.events.filter((e) => e.type === "core.void")).toHaveLength(1);

    // Take-back, exactly as `handleUndo`'s drop branch performs it.
    expect(await pad.current.dropHeldSubmission(heldId as string)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(await pad.current.queueStore.list(), "the queue is clean").toEqual([]);
    expect(
      pad.current.events.filter((e) => e.type === "core.void"),
      "and so is the optimistic fold — a void left here retires the original on screen",
    ).toEqual([]);
    expect(
      pad.current.events.filter((e) => e.type === "generic.score"),
      "the original event stands, exactly once",
    ).toHaveLength(1);
    expect(appendCalls, "and nothing further was ever sent").toHaveLength(1);
  });

  it("a REFUSED replacement takes its bound void with it, so the void cannot drain alone and delete the scored event (W2e T30 fix round 1, M-1)", async () => {
    // The mirror of the take-back case above, for the other way a held replacement dies: the server refuses it. Before the
    // reject-cascade in `runDrain` the bound void stayed in the durable queue, drained next, and retired an original that
    // nothing had replaced — the same silent loss as the amendment's "round 1", reached through a refusal instead of a
    // take-back.
    const { transport, appendCalls } = fakeTransport({
      appendResults: [success(1), { kind: "rejected", code: "INVALID_EVENT", message: "refused" }],
    });
    const pad = mountPipeline(baseParams({ transport, queueDbName: "amend-refused-replacement" }));
    await vi.advanceTimersByTimeAsync(0);
    await pad.current.submit("generic.score", { by: "H", points: 1 });
    const originalId = pad.current.events.find((e) => e.type === "generic.score")!.id;
    await vi.advanceTimersByTimeAsync(DOUBLE_SUBMIT_WINDOW_MS + 50);

    const heldId = await runAmend(
      { voidId: originalId, type: "generic.score", payload: { by: "H", points: 1 } },
      {
        // The release closure is the host's own (`handleAmend`): once the hold is up, drain.
        submitHeld: (type, payload) =>
          pad.current.submitHeld(type, payload, HOLD_MS, () => {
            void pad.current.retryDrain();
          }),
        submit: (type, payload, opts) => pad.current.submit(type, payload, opts),
      },
    );
    expect(heldId).not.toBeNull();
    // Before the refusal: the replacement and the void are both in the queue and the optimistic ledger.
    expect(await pad.current.queueStore.list(), "the pair is queued behind the hold").toHaveLength(2);
    expect(pad.current.events.filter((e) => e.type === "core.void")).toHaveLength(1);

    // The hold releases; the replacement is refused.
    await vi.advanceTimersByTimeAsync(HOLD_MS + 100);
    await vi.advanceTimersByTimeAsync(0);

    expect(
      appendCalls.map((c) => c.body.type),
      "the original and the refused replacement were sent; the bound void was NOT",
    ).toEqual(["generic.score", "generic.score"]);
    expect(await pad.current.queueStore.list(), "nothing is left queued to drain behind the refusal").toEqual([]);
    expect(
      pad.current.events.filter((e) => e.type === "core.void"),
      "and the optimistic fold no longer retires the original",
    ).toEqual([]);
    expect(
      pad.current.events.filter((e) => e.type === "generic.score"),
      "the original stands, exactly once: the refused replacement is gone",
    ).toHaveLength(1);
    expect(pad.current.lastRejection, "the refusal is reported to the scorer").not.toBeNull();
    // Nothing further drains later either.
    await vi.advanceTimersByTimeAsync(HOLD_MS * 3);
    expect(appendCalls, "no late send").toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// W2e Task 30 (D3, D13) — a disqualifying sanction and its ending, over the REAL pipeline
// ---------------------------------------------------------------------------
//
// Same reasoning as the amendment block above: `runEnding` binds the forfeit to the held sanction with the durable
// `dropWith` field, and only this suite can reach the places that binding matters — take-back (the optimistic mirror as
// well as the queue), a reload taken inside the hold (the resume path), a refused second append (the ledger the pad is
// left holding), and a refused FIRST append (the follower must not drain alone). Swept over every sport whose module
// declares an end level (`sanctionEnding.endLevels`), read from the engine, with the count asserted.
describe("W2e T30 — the sanction-and-ending pair over the real pipeline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const DECLARING = builtinModules.filter((m) => (m.sanctionEnding?.endLevels.length ?? 0) > 0);
  const rigFor = (key: string) => {
    const mod = DECLARING.find((m) => m.key === key)!;
    const client = resolveModuleClient(mod.key, mod.version);
    const cfg = client.configSchema.parse({});
    const lineups = defaultLineupPair(resolvePositions(client, cfg));
    const start = makeEnvelope(1, { type: "core.start", payload: {} } as never);
    const decl = mod.sanctionEnding!;
    const plan = endingPlanOf(mod, decl.eventType, { by: lineups.home.entrantId, level: decl.endLevels[0] })!;
    const promptOf = (pad: { events: readonly EventEnvelope[]; state: unknown }) =>
      endingPromptOf({
        module: mod,
        rows: pad.events.map((e) => ({ id: e.id, seq: e.seq, type: e.type, payload: e.payload, voids: e.voids ?? null })),
        state: pad.state,
        canOrganise: true,
        ownEventIds: new Set(),
        deviceLinkId: null,
        lineups,
      });
    return { mod, client, cfg, lineups, start, decl, plan, promptOf };
  };
  const io = (pad: { current: UsePadPipelineResult }) => ({
    submitHeld: (type: string, payload: unknown) =>
      pad.current.submitHeld(type, payload, HOLD_MS, () => {
        void pad.current.retryDrain();
      }),
    submit: (type: string, payload: unknown, opts?: { dropWith?: string }) => pad.current.submit(type, payload, opts),
  });

  it("the engine declares an end level for at least badminton and tennis (anti-vacuity)", () => {
    expect(DECLARING.map((m) => m.key)).toEqual(expect.arrayContaining(["badminton", "tennis"]));
  });

  it("take back during the hold drops both events — from the queue AND from the optimistic fold", async () => {
    let swept = 0;
    for (const { key } of DECLARING.map((m) => ({ key: m.key }))) {
      const r = rigFor(key);
      const { transport, appendCalls } = fakeTransport({ appendResults: [] });
      const pad = mountPipeline(
        baseParams({ module: r.client, cfg: r.cfg, lineups: r.lineups, transport, initialEvents: [r.start], queueDbName: `end-takeback-${key}` }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const heldId = await runEnding(r.plan, io(pad));
      expect(heldId, key).not.toBeNull();
      // Both are in the optimistic ledger, so the match reads decided and the prompt is not shown.
      expect(pad.current.events.map((e) => e.type).slice(1), key).toEqual([r.decl.eventType, "core.forfeit"]);
      expect(r.promptOf(pad.current), `${key}: decided optimistically, no prompt`).toBeNull();

      expect(await pad.current.dropHeldSubmission(heldId as string), key).toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(await pad.current.queueStore.list(), `${key}: the queue is clean`).toEqual([]);
      expect(pad.current.events.map((e) => e.type), `${key}: and so is the optimistic fold`).toEqual(["core.start"]);
      expect(r.promptOf(pad.current), `${key}: nothing is pending after the take-back`).toBeNull();
      await vi.advanceTimersByTimeAsync(HOLD_MS + 100);
      expect(appendCalls, `${key}: nothing was ever sent — the forfeit did not drain alone`).toHaveLength(0);
      pad.unmount();
      swept++;
    }
    expect(swept).toBe(DECLARING.length);
  });

  it("a reload inside the hold resumes BOTH events, the sanction first", async () => {
    let swept = 0;
    for (const { key } of DECLARING.map((m) => ({ key: m.key }))) {
      const r = rigFor(key);
      const DB_NAME = `end-reload-${key}`;
      const { transport, appendCalls } = fakeTransport({ appendResults: [success(2), success(3)] });
      const pad1 = mountPipeline(
        baseParams({ module: r.client, cfg: r.cfg, lineups: r.lineups, transport, initialEvents: [r.start], queueDbName: DB_NAME }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(await runEnding(r.plan, io(pad1))).not.toBeNull();
      expect(appendCalls, `${key}: still held`).toHaveLength(0);

      pad1.unmount(); // the reload: a fresh mount over the same durable queue, with a fresh (empty) tick map
      const pad2 = mountPipeline(
        baseParams({ module: r.client, cfg: r.cfg, lineups: r.lineups, transport, initialEvents: [r.start], queueDbName: DB_NAME }),
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(HOLD_MS + 100);
      await vi.advanceTimersByTimeAsync(0);

      expect(appendCalls.map((c) => c.body.type), `${key}: the resumed sanction is followed by its ending`).toEqual([
        r.decl.eventType,
        "core.forfeit",
      ]);
      expect(appendCalls[1]!.body.payload, key).toEqual({ by: r.lineups.home.entrantId, reason: "disqualified" });
      expect(await pad2.current.queueStore.list(), `${key}: nothing left queued`).toEqual([]);
      expect(r.promptOf(pad2.current), `${key}: decided, no prompt`).toBeNull();
      pad2.unmount();
      swept++;
    }
    expect(swept).toBe(DECLARING.length);
  });

  it("a failed second append leaves the prompt on reload", async () => {
    let swept = 0;
    for (const { key } of DECLARING.map((m) => ({ key: m.key }))) {
      const r = rigFor(key);
      // The sanction is acknowledged; the forfeit behind it is refused (a legacy 403, a network fault turned permanent...).
      const { transport } = fakeTransport({
        appendResults: [success(2), { kind: "rejected", code: "FORBIDDEN", message: "refused" }],
      });
      const pad = mountPipeline(
        baseParams({ module: r.client, cfg: r.cfg, lineups: r.lineups, transport, initialEvents: [r.start], queueDbName: `end-fail2-${key}` }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(await runEnding(r.plan, io(pad))).not.toBeNull();
      await vi.advanceTimersByTimeAsync(HOLD_MS + 100);
      await vi.advanceTimersByTimeAsync(0);

      expect(pad.current.lastRejection, `${key}: the refusal is reported`).not.toBeNull();
      expect(pad.current.events.map((e) => e.type), `${key}: the sanction stands, the forfeit does not`).toEqual([
        "core.start",
        r.decl.eventType,
      ]);
      const prompt = r.promptOf(pad.current);
      expect(prompt, `${key}: the pad is left on the ending prompt`).not.toBeNull();
      expect(prompt!.by).toBe(r.lineups.home.entrantId);

      // A RELOAD from the server's ledger: the same prompt, from the rows alone.
      const ledger = pad.current.events;
      pad.unmount();
      const pad2 = mountPipeline(
        baseParams({ module: r.client, cfg: r.cfg, lineups: r.lineups, transport: fakeTransport({ appendResults: [] }).transport, initialEvents: ledger, queueDbName: `end-fail2-reload-${key}` }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(r.promptOf(pad2.current), `${key}: still on the prompt after a reload`).not.toBeNull();
      pad2.unmount();
      swept++;
    }
    expect(swept).toBe(DECLARING.length);
  });

  it("a refused FIRST append takes its bound ending with it (the forfeit must not drain alone)", async () => {
    let swept = 0;
    for (const { key } of DECLARING.map((m) => ({ key: m.key }))) {
      const r = rigFor(key);
      const { transport, appendCalls } = fakeTransport({
        appendResults: [{ kind: "rejected", code: "INVALID_EVENT", message: "refused" }],
      });
      const pad = mountPipeline(
        baseParams({ module: r.client, cfg: r.cfg, lineups: r.lineups, transport, initialEvents: [r.start], queueDbName: `end-fail1-${key}` }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(await runEnding(r.plan, io(pad))).not.toBeNull();
      await vi.advanceTimersByTimeAsync(HOLD_MS + 100);
      await vi.advanceTimersByTimeAsync(0);

      expect(appendCalls.map((c) => c.body.type), `${key}: only the sanction was ever sent`).toEqual([r.decl.eventType]);
      expect(await pad.current.queueStore.list(), `${key}: and nothing is left to drain`).toEqual([]);
      expect(pad.current.events.map((e) => e.type), `${key}: the optimistic fold carries neither`).toEqual(["core.start"]);
      expect(pad.current.lastRejection, key).not.toBeNull();
      pad.unmount();
      swept++;
    }
    expect(swept).toBe(DECLARING.length);
  });
});

// W3 task 1 (device-link scoring gaps, §5) — the pad's own ledger cursor.
describe("usePadPipeline — a sparse ledger after a 409 renegotiation (W3 task 1)", () => {
  // THE DEFECT: `expectedSeq` read the ARRAY LENGTH as if it were the ledger
  // tip. That is true only while the ledger is gapless. A 409 renegotiation
  // makes it sparse: our ack is merged at the SERVER's seq (`runDrain`'s
  // `confirmedSeq`) while the foreign row that caused the conflict is read
  // inside `resolveConflict` and never committed. Length 3 over {1,2,4} then
  // claims `expected_seq` 3 — a slot the server already filled — and earns
  // another 409, another renegotiation and another gap. It compounds.
  //
  // FIX ROUND 1 CORRECTION: the POLL cursor is a different question and gets
  // the opposite answer. `listEvents` is strict (`seq > since_seq`), so a
  // count cursor asks for a strict SUPERSET of what a tip cursor asks for —
  // it over-fetches rather than skipping, and that over-fetch recovers any
  // row the ledger is missing above the count. Round 1 moved all three
  // cursors onto the tip together and removed that heal; `sinceSeq` is the
  // count again and the two `expected_seq` sites keep the tip.
  //
  // Read the fixtures before the assertions. Most cases here SEED a sparse
  // ledger and pin what the CURSOR does with it; one case
  // ("a REAL 409 renegotiation produces the sparse ledger") drives the
  // PRODUCER and pins that a 409 actually strands the foreign row. Those are
  // two different claims and the suite needs both — a seeded fixture on its
  // own proves the fixture.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const POLL_MS = 1_000;

  /** One committed ledger row at `seq`. Only the seq matters to these tests;
   *  the type/payload just have to fold through the generic module. */
  const slotEvent = (seq: number): EventEnvelope => ({
    id: `e-${seq}`,
    fixtureId: "fx-1",
    seq,
    type: "generic.score",
    payload: { by: "H", points: 1 },
    recordedAt: new Date(Date.UTC(2026, 8, 22, 0, 0, seq)).toISOString(),
    recordedBy: "user-1",
  });

  /** A row some OTHER writer (the organiser console) committed, as the server
   *  would hand it back. Deliberately carries `id` AND `recorded_at`, the two
   *  fields `ledgerSlotToEnvelope` refuses a row without — so if this pad ever
   *  ASKED for it, it would widen and land. Whether it is ever asked for is
   *  the whole question. */
  const foreignRow = (seq: number): LedgerSlotEvent => ({
    id: `console-${seq}`,
    seq,
    type: "generic.score",
    payload: { by: "A", points: 9 },
    recorded_at: new Date(Date.UTC(2026, 8, 22, 0, 1, seq)).toISOString(),
    recorded_by: "console-user",
    device_link_id: null,
  });

  /** The deliberately-sparse fixture. The gap is TWO wide, not one, and that
   *  is the point: over `{1,2,4}` the tip (4) happens to equal `length + 1`,
   *  so the three sparse cases below could not tell "tip" apart from "count +
   *  1" and only the gapless/empty controls killed that mutant. Over
   *  `{1,2,5}` the three candidate answers are all different — tip 5, count 3,
   *  count + 1 = 4 — so the differential sits INSIDE the case under test. A
   *  two-wide gap is reachable by the same mechanism: the organiser commits
   *  twice while this pad is mid-write. */
  const sparseLedger = () => [slotEvent(1), slotEvent(2), slotEvent(5)];

  /** Thin wrapper over this suite's own `mountPipeline`/`fakeTransport` — not
   *  a second rig. It only does the two settling steps every case here needs:
   *  `neverConfirmConnector` so a REAL poll interval is armed (the suite's
   *  default `autoConfirmConnector` confirms synchronously and never polls, so
   *  `listEventsSince` would be called only once, by the stream's catch-up on
   *  subscribe), then one poll tick so a cursor taken AFTER that read has
   *  crossed the wire too. */
  async function renderPipeline(
    initialEvents: EventEnvelope[],
    opts: { appendResults?: AppendCallResult[]; serverLedger?: LedgerSlotEvent[] } = {},
  ) {
    const rig = fakeTransport({ appendResults: opts.appendResults ?? [], serverLedger: opts.serverLedger });
    const pad = mountPipeline(
      baseParams({
        transport: rig.transport,
        initialEvents,
        streamConnector: neverConfirmConnector(),
        streamPollMs: POLL_MS,
      }),
    );
    await vi.advanceTimersByTimeAsync(0); // token door resolves, startPolling arms the interval
    await vi.advanceTimersByTimeAsync(POLL_MS); // one tick: `sinceSeq` crosses the seam
    await vi.advanceTimersByTimeAsync(0); // let that tick's own reconcileAfterAck resolve
    return { pad, ...rig };
  }

  it("asks the poll from the COUNT, not the tip — the read cursor under-shoots on purpose", async () => {
    // CORRECTED in fix round 1. This case originally pinned the poll cursor at
    // the TIP (5), on the reading that a count "skips" rows. It does the
    // opposite: `listEvents` is strict (`seq > since_seq`), so the LOWER
    // cursor asks for a strict superset. The tip was the right answer for the
    // two `expected_seq` sites and the wrong one here, and pinning 5 froze
    // that regression as the expected value. The case below that holds a
    // populated `serverLedger` is what actually witnesses the difference.
    const rig = await renderPipeline(sparseLedger());

    // Over `{1,2,5}` the three candidates are all different — count 3,
    // `count + 1` 4, tip 5 — so this number distinguishes them inside the case
    // under test rather than relying on the gapless control.
    expect(rig.lastSinceSeq()).toBe(3);
  });

  it("RECOVERS a row that sits above the count — the poll under-shoot is a self-heal", async () => {
    // GAP 5 (fix round 1). Every other sparse case in this describe runs
    // against an EMPTY `serverLedger`, so they can only witness what the pad
    // ASKS for — never what it FETCHES. This one holds the rows the pad is
    // missing, which is the only way the difference is observable.
    //
    // The endpoint is STRICT (`seq > since_seq`,
    // `server/usecases/fixtures.ts` `listEvents`), so a LOWER cursor asks for
    // a strict SUPERSET. Over `{1,2,5}` the count is 3 and the tip is 5: the
    // count asks `> 3` and seq 4 comes home, the tip asks `> 5` and seq 4 is
    // stranded for the rest of the match. Each stranded row is a rally the
    // pad's fold never applies and nothing on screen says so.
    const rig = await renderPipeline(sparseLedger(), { serverLedger: [foreignRow(3), foreignRow(4)] });

    // The CONSEQUENCE first — it is the assertion that matters, and reading it
    // first means a regression reds on the rally that went missing rather than
    // on a number.
    expect(
      rig.pad.current.events.map((e) => e.seq),
      "seq 4 sits above the count and at-or-below the tip — the under-shoot is what brings it back",
    ).toEqual([1, 2, 4, 5]);
    // The read that brought it home is the FIRST one — the stream's catch-up on
    // subscribe, asked from the mount-time count. Every later read asks from
    // the count as it stands after seq 4 landed.
    expect(
      rig.listEventsSinceCalls[0]?.sinceSeq,
      "the read cursor under-shoots the tip while the ledger is sparse",
    ).toBe(3);
  });

  it("derives the next expectedSeq from the TIP, not the count", async () => {
    const rig = await renderPipeline(sparseLedger(), { appendResults: [success(6)] });

    await rig.pad.current.submit("generic.score", { by: "A", points: 1 });

    // With a count the pad claims expected_seq 3 — a seq the server already
    // filled — and takes a 409 it did not need, which renegotiates into
    // another gap. It compounds.
    expect(rig.lastSubmittedExpectedSeq()).toBe(5);
  });

  it("derives submitHeld's expectedSeq from the TIP too — the copy every real v3 tap calls", async () => {
    // NOT in the task brief, and load-bearing: `submitHeld` carries its own
    // copy of the same `length + pending.size` line (use-pad-pipeline.ts's
    // soft-commit entry point), and `createSkinDispatch`'s `heldSubmit` is
    // what every v3 pad tap actually routes through. Fixing `submit()` alone
    // would have left the compounding-409 half live on the ONLY path a
    // scorer ever hits — the same trap that function's own R7-42 comment
    // already records once.
    const rig = await renderPipeline(sparseLedger(), { appendResults: [success(6)] });

    const onDue = vi.fn(() => {
      void rig.pad.current.retryDrain();
    });
    const held = await rig.pad.current.submitHeld("generic.score", { by: "A", points: 1 }, HOLD_MS, onDue);
    expect(held).not.toBeNull();

    await releaseHeld(rig.pad.current.queueStore, held!.heldId); // "send now", the Dock's own path
    await vi.advanceTimersByTimeAsync(0);

    expect(rig.lastSubmittedExpectedSeq()).toBe(5);
  });

  it("takes the tip from an UNSORTED initialEvents — the mount seed is a ledger writer like any other", async () => {
    // `.length` was order-insensitive; a tip is not. The mount seed used to be
    // a raw spread, the ONE writer into `ledgerEvents` that never went through
    // `mergeEnvelopesIntoLedger` — so the tip rested on an ascending order
    // that came from `listEvents`' own `order by seq`, two layers away, and
    // `v3/pad-host.tsx` takes `initialEvents` from any caller. Not live today;
    // an unguarded invariant all the same.
    //
    // CORRECTED in fix round 1: the order-sensitivity is now read off the
    // `expected_seq` the pad SUBMITS, because that is the cursor that still
    // takes the tip. The poll cursor is the count again, and a count is
    // order-insensitive — asserting on it here would be a tautology that a raw
    // spread passes just as happily, i.e. a test that had stopped killing the
    // mutant it was written for.
    const rig = await renderPipeline([slotEvent(5), slotEvent(1), slotEvent(2)], { appendResults: [success(6)] });

    expect(rig.pad.current.events.map((e) => e.seq)).toEqual([1, 2, 5]); // seeded THROUGH the merge

    await rig.pad.current.submit("generic.score", { by: "A", points: 1 });
    // A raw-spread seed leaves seq 2 last, so the tip reads 2 and the write
    // claims a slot three behind the server's.
    expect(rig.lastSubmittedExpectedSeq()).toBe(5);
  });

  it("a REAL 409 renegotiation produces the sparse ledger — it is not merely seeded that way", async () => {
    // GAP 3. Every other case here SEEDS `{1,2,5}` and proves what the cursor
    // does given a sparse ledger. This one drives the PRODUCER the plan
    // blames: `sendOne`'s conflict path reads the foreign slot through
    // `findLedgerSlot` to DECIDE the conflict, and those rows never reach the
    // hook — so `runDrain` merges our ack at the server's own `confirmedSeq`
    // and the foreign row is left behind.
    const serverLedger: LedgerSlotEvent[] = [];
    const rig = await renderPipeline([slotEvent(1), slotEvent(2)], {
      // 1st append (expected_seq 2): the organiser already took seq 3 -> 409.
      // 2nd append (renegotiated to expected_seq 3): lands at seq 4.
      appendResults: [{ kind: "conflict", currentSeq: 3, message: "seq conflict" }, success(4)],
      serverLedger,
    });
    expect(rig.pad.current.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(rig.lastSinceSeq()).toBe(2);

    // The organiser console commits seq 3, now — AFTER this pad's last poll and
    // BEFORE its own write lands. That ordering is the race, and seeding the
    // row up front instead would have let the first poll tick deliver it.
    serverLedger.push(foreignRow(3));

    await rig.pad.current.submit("generic.score", { by: "H", points: 1 });

    // The protocol did renegotiate: original expected_seq, then the 409 body's
    // own current_seq. Same event, one resend.
    expect(rig.appendCalls.map((c) => c.body.expected_seq)).toEqual([2, 3]);

    // …and THIS is the finding the plan only reasoned about. The ledger is
    // genuinely sparse — produced, not seeded. Seq 3 was read by
    // `resolveConflict` and never committed.
    expect(rig.pad.current.events.map((e) => e.seq)).toEqual([1, 2, 4]);

    // The next poll therefore asks from 3, the count — and seq 3 is lost
    // anyway, because `> 3` excludes 3 itself. That is the residual: the read
    // cursor's under-shoot heals every row ABOVE the count, never the oldest
    // missing one. Only an `initialEvents` re-seed closes that, and the write
    // cursor's tip is what stops the NEXT gap from opening.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(rig.lastSinceSeq()).toBe(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.pad.current.events.map((e) => e.seq), "seq 3 stays stranded — prevention, not healing").toEqual([
      1, 2, 4,
    ]);
  });

  it("the cursor FOLLOWS the ledger — a later poll asks from the NEW tip, not the mount-time one", async () => {
    // GAP 4. Every case above reads the cursor as it stood at MOUNT, so a
    // frozen `sinceRef` inside use-fixture-stream.ts would satisfy all of
    // them. The whole claim is that the cursor TRACKS the ledger; this is the
    // only test that pins it.
    const rig = await renderPipeline([slotEvent(1), slotEvent(2)], {
      serverLedger: [foreignRow(3), foreignRow(4)],
    });

    // The mount-time cursor, as asked by the first read (the stream's catch-up
    // on subscribe)…
    expect(rig.listEventsSinceCalls[0]?.sinceSeq).toBe(2);
    expect(rig.pad.current.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]); // …which delivered both rows
    // …and the tick after it already asks from the NEW count.
    expect(rig.lastSinceSeq()).toBe(4);

    await vi.advanceTimersByTimeAsync(POLL_MS); // and so does the next one
    expect(rig.lastSinceSeq()).toBe(4);
  });

  it("is unchanged for a gapless ledger — the normal case", async () => {
    // The POSITIVE pair. A "fix" that always returned `length + 1` would
    // satisfy every assertion above and break every ordinary pad; this is the
    // case that catches it.
    const rig = await renderPipeline([slotEvent(1), slotEvent(2), slotEvent(3)], { appendResults: [success(4)] });

    expect(rig.lastSinceSeq()).toBe(3);
    await rig.pad.current.submit("generic.score", { by: "A", points: 1 });
    expect(rig.lastSubmittedExpectedSeq()).toBe(3);
  });

  it("asks from 0 on an empty ledger", async () => {
    // The boundary a tip helper is most likely to get wrong: `events[len - 1]`
    // on an empty array is `undefined`, and `undefined.seq` throws where the
    // old `length` quietly answered 0.
    const rig = await renderPipeline([]);
    expect(rig.lastSinceSeq()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// "Void my last entry" — a FOREIGN void that names the SERVER's id of an event
// THIS pad scored, delivered by a poll that honours its own cursor.
//
// The device-link chrome (`device-score-pad.tsx`) and its inner pad are two
// writers on one fixture. The chrome's `device-void-mine` sends
// `core.void {event_id}` naming the row id it read from the SERVER — the only
// id it has ever seen. The inner pad learns of that void only through its
// stream, and until this fix it held the target under the CLIENT-fabricated
// idempotency key it stamped at ack time (`AppendSuccess` carried no row id).
//
// R5's poll test (above) already covers a foreign void — but its transport
// hands back BOTH rows on every call, whatever cursor it was given. A real
// `/events?since_seq=` is strict (`seq > since_seq`) and the pad's read cursor
// is the ledger COUNT, so after this pad's own ack the target's seq is never
// asked for again: only the void arrives, naming an id the ledger does not
// hold, and `resolveVoids` rejects every fold from there on. The pad froze on
// the pre-void score behind a rejection banner while the chrome's header,
// which re-reads the whole ledger, showed the right one. These cases use the
// cursor-honest `serverLedger` for exactly that reason.
//
// Two owner-approved fixes, each with its own witness here:
//  - Fix A: the POST ack carries the new row's id (`event_id`), and the ack
//    stamps it — so the target's id is right from the moment it lands.
//  - Fix B: when a streamed batch leaves a void naming an id the ledger does
//    not hold, the pipeline re-reads the ledger ONCE for that void and merges
//    the target row (the default merge direction adopts the wire id).
// ---------------------------------------------------------------------------
describe("usePadPipeline — a foreign void naming the SERVER id of a pad-scored event (device-void-mine)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const REAL_ID = "server-real-id-device-void-mine";
  const POLL = 1_000;

  const scoredRow = (id: string): LedgerSlotEvent => ({
    id,
    seq: 1,
    type: "generic.score",
    payload: { by: "H", points: 2 },
    recorded_at: "2026-09-23T10:00:00.000Z",
    recorded_by: "user-1",
    device_link_id: null,
    voids_event_id: null,
  });
  const voidRow = (seq: number, target: string): LedgerSlotEvent => ({
    id: `chrome-void-${seq}`,
    seq,
    type: "core.void",
    payload: {},
    recorded_at: "2026-09-23T10:00:05.000Z",
    recorded_by: "user-1",
    device_link_id: null,
    voids_event_id: target,
  });
  const laterRow = (seq: number): LedgerSlotEvent => ({
    id: `later-${seq}`,
    seq,
    type: "generic.score",
    payload: { by: "A", points: 1 },
    recorded_at: "2026-09-23T10:00:09.000Z",
    recorded_by: "someone-else",
    device_link_id: null,
    voids_event_id: null,
  });
  /** An ack exactly as the pre-fix server wrote it: no row id at all. */
  const ackWithoutId = (seq: number): AppendCallResult => ({
    kind: "ok",
    data: { seq, state_summary: { seq }, outcome: null, status: "in_play" },
  });
  /** Fix A's ack: the server names the row it just wrote. */
  const ackWithId = (seq: number, eventId: string): AppendCallResult => ({
    kind: "ok",
    data: { seq, state_summary: { seq }, outcome: null, status: "in_play", event_id: eventId },
  });

  const running = (pad: { current: UsePadPipelineResult }) =>
    (pad.current.state as { running?: { home: number; away: number } }).running;

  /** Every case here mounts on an EMPTY seed, so the stream's catch-up on
   *  subscribe asks from 0 — the same cursor as Fix B's whole-ledger heal read.
   *  The catch-up runs at mount, against a server that holds nothing yet
   *  (`settleSubscribe` pins that); the heal runs once the server holds the
   *  void. A transport double that fails or holds "the heal read" keys on
   *  this, not on the cursor alone. */
  const isHealRead = (sinceSeq: number, serverLedger: readonly LedgerSlotEvent[]) =>
    sinceSeq === 0 && serverLedger.length > 0;

  /** Let the stream subscribe before the first tap. Its catch-up read lands
   *  against the still-empty server — pinned here, then cleared from the
   *  record, so each case's call list starts with the reads its OWN story
   *  makes. */
  async function settleSubscribe(rig: { listEventsSinceCalls: { sinceSeq: number }[] }) {
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.listEventsSinceCalls.map((c) => c.sinceSeq), "the stream's catch-up on subscribe").toEqual([0]);
    rig.listEventsSinceCalls.length = 0;
  }

  /** Score one event through the pad, then publish the server's truth. */
  async function scoreThenServer(opts: {
    ack: AppendCallResult;
    serverLedger: LedgerSlotEvent[];
    serverRows: LedgerSlotEvent[];
    transport?: (base: PadTransport) => PadTransport;
  }) {
    const rig = fakeTransport({ appendResults: [opts.ack], serverLedger: opts.serverLedger });
    const transport = opts.transport ? opts.transport(rig.transport) : rig.transport;
    const pad = mountPipeline(
      baseParams({ transport, streamConnector: neverConfirmConnector(), streamPollMs: POLL }),
    );
    await settleSubscribe(rig);
    await pad.current.submit("generic.score", { by: "H", points: 2 });
    expect(running(pad), "the pad's own score must fold before anything is undone").toEqual({ home: 2, away: 0 });
    // The server's own ledger from here on: the row this pad scored under its
    // REAL id, and whatever else the test says landed.
    opts.serverLedger.push(...opts.serverRows);
    await vi.advanceTimersByTimeAsync(0); // settle into polling
    return { rig, pad };
  }

  async function nextTick() {
    await vi.advanceTimersByTimeAsync(POLL);
    await vi.advanceTimersByTimeAsync(0);
  }

  it("REPRODUCTION + MUTATION TARGET (Fix B): an ack with NO id, then a poll that delivers ONLY the void — the pad re-reads once and the fold reverts, no rejection", async () => {
    const serverLedger: LedgerSlotEvent[] = [];
    const { rig, pad } = await scoreThenServer({
      ack: ackWithoutId(1),
      serverLedger,
      serverRows: [scoredRow(REAL_ID), voidRow(2, REAL_ID)],
    });
    // The precondition that makes this the defect: the pad holds seq 1 under
    // an id the server never assigned (acks without an id keep the fabricated
    // fallback).
    expect(pad.current.events.find((e) => e.seq === 1)?.id).not.toBe(REAL_ID);

    await nextTick();

    // What the scorer sees: the undo took, and no false refusal.
    expect(pad.current.lastRejection).toBeNull();
    expect(running(pad), "the inner pad still shows the pre-void score").toBeUndefined();
    expect(pad.current.events.find((e) => e.seq === 1)?.id).toBe(REAL_ID);
    // The stream asked from the COUNT (1), so it could never re-deliver the
    // target; exactly ONE whole-ledger read (0) healed it.
    expect(rig.listEventsSinceCalls.map((c) => c.sinceSeq)).toEqual([1, 0]);
  });

  it("MUTATION TARGET (Fix A): an ack that names its row stamps the server's id at ack time — the void then resolves with no heal read at all", async () => {
    const serverLedger: LedgerSlotEvent[] = [];
    const { rig, pad } = await scoreThenServer({
      ack: ackWithId(1, REAL_ID),
      serverLedger,
      serverRows: [scoredRow(REAL_ID), voidRow(2, REAL_ID)],
    });
    // Before any stream read: the ack itself carried the id.
    expect(pad.current.events.find((e) => e.seq === 1)?.id).toBe(REAL_ID);
    // "Is this mine" follows the id the ledger actually holds.
    expect(pad.current.ownEventIds.has(REAL_ID)).toBe(true);

    await nextTick();

    expect(pad.current.lastRejection).toBeNull();
    expect(running(pad)).toBeUndefined();
    // Nothing was dangling, so Fix B never fired: the only read is the poll.
    expect(rig.listEventsSinceCalls.map((c) => c.sinceSeq)).toEqual([1]);
  });

  it("MUTATION TARGET (Fix B, no loop): a void whose target the server read does NOT hold is re-read exactly once, never again on later batches", async () => {
    const serverLedger: LedgerSlotEvent[] = [];
    const { rig, pad } = await scoreThenServer({
      ack: ackWithoutId(1),
      serverLedger,
      serverRows: [scoredRow(REAL_ID), voidRow(2, "ghost-id-no-row-has")],
    });

    await nextTick(); // delivers the void; one heal read finds nothing to adopt
    serverLedger.push(laterRow(3));
    await nextTick(); // a later batch still carries the dangling void in the ledger
    await nextTick(); // and an empty tick

    expect(rig.listEventsSinceCalls.map((c) => c.sinceSeq)).toEqual([1, 0, 2, 3]);
    // Honest, not hidden: a void naming nothing real is still refused.
    expect(pad.current.lastRejection).not.toBeNull();
  });

  it("MUTATION TARGET (Fix B, retry): a heal read that FAILS is retried on the next batch that arrives — not given up on, and not looped", async () => {
    const serverLedger: LedgerSlotEvent[] = [];
    let healFailures = 0;
    const { rig, pad } = await scoreThenServer({
      ack: ackWithoutId(1),
      serverLedger,
      serverRows: [scoredRow(REAL_ID), voidRow(2, REAL_ID)],
      transport: (base) => ({
        ...base,
        async listEventsSince(fixtureId, sinceSeq) {
          const rows = await base.listEventsSince(fixtureId, sinceSeq);
          if (isHealRead(sinceSeq, serverLedger) && healFailures === 0) {
            healFailures += 1;
            throw new Error("courtside wifi dropped the heal read");
          }
          return rows;
        },
      }),
    });

    await nextTick(); // the void lands; the heal read fails
    expect(running(pad), "a failed read cannot heal anything").toEqual({ home: 2, away: 0 });
    serverLedger.push(laterRow(3));
    await nextTick(); // the next batch retries the heal, and it succeeds

    expect(healFailures).toBe(1);
    expect(rig.listEventsSinceCalls.map((c) => c.sinceSeq)).toEqual([1, 0, 2, 0]);
    expect(pad.current.events.find((e) => e.seq === 1)?.id).toBe(REAL_ID);
    // Home's 2 is undone; only the later away point stands.
    expect(running(pad)).toEqual({ home: 0, away: 1 });
    // The failed read committed the dangling void, so the fold refused it and
    // raised a banner. A heal that fixes the score must take that banner down
    // too, or the scorer reads "refused" over a board that is right.
    expect(pad.current.lastRejection, "a healed void must not leave its refusal on screen").toBeNull();
  });

  it("MUTATION TARGET (Fix B, retry on an EMPTY tick): a failed heal read is retried on the next poll even when that poll brings nothing — once, and then never again", async () => {
    // Review round 1: the retry used to ride on the next NON-empty batch. On a
    // quiet court there may not be one for minutes, and the pad sat on the
    // undone score behind a refusal banner the whole time.
    const serverLedger: LedgerSlotEvent[] = [];
    let healFailures = 0;
    const { rig, pad } = await scoreThenServer({
      ack: ackWithoutId(1),
      serverLedger,
      serverRows: [scoredRow(REAL_ID), voidRow(2, REAL_ID)],
      transport: (base) => ({
        ...base,
        async listEventsSince(fixtureId, sinceSeq) {
          const rows = await base.listEventsSince(fixtureId, sinceSeq);
          if (isHealRead(sinceSeq, serverLedger) && healFailures === 0) {
            healFailures += 1;
            throw new Error("courtside wifi dropped the heal read");
          }
          return rows;
        },
      }),
    });

    await nextTick(); // the void lands; the heal read fails
    expect(running(pad), "a failed read cannot heal anything").toEqual({ home: 2, away: 0 });
    await nextTick(); // an EMPTY poll: nothing new, but the void is still dangling — retry
    await nextTick(); // healed: empty polls from here on read nothing extra
    await nextTick();

    expect(healFailures).toBe(1);
    expect(rig.listEventsSinceCalls.map((c) => c.sinceSeq)).toEqual([1, 0, 2, 0, 2, 2]);
    expect(pad.current.events.find((e) => e.seq === 1)?.id).toBe(REAL_ID);
    expect(running(pad)).toBeUndefined();
    expect(pad.current.lastRejection, "a healed void must not leave its refusal on screen").toBeNull();
  });

  it("MUTATION TARGET (Fix B, one read per tick): empty ticks that arrive while a retry read is out are dropped, not queued behind it — and a failed retry commits nothing", async () => {
    // Queued behind the read, those ticks would all replay the moment it
    // failed: a burst of reads on exactly the connection that just dropped
    // one, instead of the next tick's single try.
    const serverLedger: LedgerSlotEvent[] = [];
    let healReads = 0;
    const secondRead = deferred<void>();
    const { rig, pad } = await scoreThenServer({
      ack: ackWithoutId(1),
      serverLedger,
      serverRows: [scoredRow(REAL_ID), voidRow(2, REAL_ID)],
      transport: (base) => ({
        ...base,
        async listEventsSince(fixtureId, sinceSeq) {
          const rows = await base.listEventsSince(fixtureId, sinceSeq);
          if (isHealRead(sinceSeq, serverLedger)) {
            healReads += 1;
            if (healReads === 1) throw new Error("dropped");
            if (healReads === 2) {
              await secondRead.promise;
              throw new Error("dropped again");
            }
          }
          return rows;
        },
      }),
    });

    await nextTick(); // the void lands; read #1 fails; the batch is committed
    await nextTick(); // an empty tick retries: read #2 hangs
    await nextTick(); // two more empty ticks while it is out
    await nextTick();
    const reconcilesBefore = rig.fetchStateCalls.length;
    secondRead.resolve(); // read #2 fails
    await vi.advanceTimersByTimeAsync(0);

    expect(rig.listEventsSinceCalls.map((c) => c.sinceSeq), "nothing replays when the read fails").toEqual([
      1, 0, 2, 0, 2, 2,
    ]);
    expect(rig.fetchStateCalls.length, "a failed retry off an empty tick has nothing to commit or reconcile").toBe(
      reconcilesBefore,
    );

    await nextTick(); // the next tick's single retry succeeds
    expect(rig.listEventsSinceCalls.map((c) => c.sinceSeq)).toEqual([1, 0, 2, 0, 2, 2, 2, 0]);
    expect(running(pad)).toBeUndefined();
    expect(pad.current.lastRejection).toBeNull();
  });

  it("MUTATION TARGET (Fix B, refusal scope): a heal takes down ONLY the refusal its dangling void raised — a server's refusal of the scorer's own tap stays up", async () => {
    const serverLedger: LedgerSlotEvent[] = [];
    const rig = fakeTransport({
      appendResults: [ackWithoutId(1), { kind: "rejected", code: "WRONG_PHASE", message: "not now" }],
      serverLedger,
    });
    const pad = mountPipeline(
      baseParams({ transport: rig.transport, streamConnector: neverConfirmConnector(), streamPollMs: POLL }),
    );
    await settleSubscribe(rig);
    await pad.current.submit("generic.score", { by: "H", points: 2 });
    await pad.current.submit("generic.score", { by: "A", points: 1 });
    expect(pad.current.lastRejection?.code, "the server refused the second tap").toBe("WRONG_PHASE");
    serverLedger.push(scoredRow(REAL_ID), voidRow(2, REAL_ID));
    await vi.advanceTimersByTimeAsync(0);

    await nextTick(); // the void lands and the heal adopts its target

    expect(rig.listEventsSinceCalls.map((c) => c.sinceSeq)).toEqual([1, 0]);
    expect(running(pad), "the heal itself worked").toBeUndefined();
    expect(pad.current.lastRejection?.code, "and the scorer's own refusal is still on screen").toBe("WRONG_PHASE");
  });

  it("MUTATION TARGET (Fix B, ordering): a batch that arrives WHILE the heal read is in flight waits for it — it never commits the dangling void on its own", async () => {
    const serverLedger: LedgerSlotEvent[] = [];
    const heal = deferred<void>();
    const { rig, pad } = await scoreThenServer({
      ack: ackWithoutId(1),
      serverLedger,
      serverRows: [scoredRow(REAL_ID), voidRow(2, REAL_ID)],
      transport: (base) => ({
        ...base,
        async listEventsSince(fixtureId, sinceSeq) {
          // Recorded first, THEN held — so the call list shows the heal
          // read was made even while it hangs.
          const rows = await base.listEventsSince(fixtureId, sinceSeq);
          if (isHealRead(sinceSeq, serverLedger)) await heal.promise;
          return rows;
        },
      }),
    });

    await nextTick(); // the void lands; the heal read hangs
    await nextTick(); // a second tick re-delivers the void from the same cursor
    expect(rig.listEventsSinceCalls.map((c) => c.sinceSeq)).toEqual([1, 0, 1]);
    // Neither batch has committed the dangling void: no false refusal yet.
    expect(pad.current.lastRejection).toBeNull();

    heal.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(pad.current.lastRejection).toBeNull();
    expect(running(pad)).toBeUndefined();
    expect(pad.current.events.map((e) => e.seq)).toEqual([1, 2]);
  });
  it("MUTATION TARGET (Fix B, fresh base): a tap acked WHILE the heal read is out survives the heal's commit", async () => {
    const serverLedger: LedgerSlotEvent[] = [];
    const heal = deferred<void>();
    const rig = fakeTransport({ appendResults: [ackWithoutId(1), ackWithoutId(3)], serverLedger });
    const transport: PadTransport = {
      ...rig.transport,
      async listEventsSince(fixtureId, sinceSeq) {
        const rows = await rig.transport.listEventsSince(fixtureId, sinceSeq);
        if (isHealRead(sinceSeq, serverLedger)) await heal.promise;
        return rows;
      },
    };
    const pad = mountPipeline(baseParams({ transport, streamConnector: neverConfirmConnector(), streamPollMs: POLL }));
    await settleSubscribe(rig);
    await pad.current.submit("generic.score", { by: "H", points: 2 });
    serverLedger.push(scoredRow(REAL_ID), voidRow(2, REAL_ID));
    await vi.advanceTimersByTimeAsync(0);

    await nextTick(); // the void lands; the heal read hangs
    // The scorer taps again while it is out, and that tap is acked.
    await pad.current.submit("generic.score", { by: "A", points: 1 });
    expect(pad.current.events.map((e) => e.seq)).toEqual([1, 3]);

    heal.resolve();
    await vi.advanceTimersByTimeAsync(0);

    // Healed over the ledger as it stands NOW, not the one the read started
    // from — which would silently drop the tap acked in between.
    expect(pad.current.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(running(pad)).toEqual({ home: 0, away: 1 });
  });
  it("MUTATION TARGET (Fix B, narrow): the heal adopts ONLY the row the void names — the pad's other events keep the id it knows them as mine by", async () => {
    // Why narrow: on a device link "is this mine" is `ownEventIds.has(id)`
    // (`v3/activity.tsx`), and `ownEventIds` holds the ids this pad minted.
    // Adopting the wire id for EVERY row the read returned would relabel the
    // pad's other own events and quietly take their undo/amend away.
    const serverLedger: LedgerSlotEvent[] = [];
    const rig = fakeTransport({ appendResults: [ackWithoutId(1), ackWithoutId(2)], serverLedger });
    const pad = mountPipeline(
      baseParams({ transport: rig.transport, streamConnector: neverConfirmConnector(), streamPollMs: POLL }),
    );
    await settleSubscribe(rig);
    await pad.current.submit("generic.score", { by: "H", points: 2 });
    await pad.current.submit("generic.score", { by: "A", points: 1 });
    const firstMinted = pad.current.events.find((e) => e.seq === 1)!.id;
    expect(pad.current.ownEventIds.has(firstMinted)).toBe(true);
    serverLedger.push(
      scoredRow("server-real-id-first"),
      { ...laterRow(2), id: "server-real-id-second", recorded_by: "user-1" },
      voidRow(3, "server-real-id-second"),
    );
    await vi.advanceTimersByTimeAsync(0);

    await nextTick();

    expect(rig.listEventsSinceCalls.map((c) => c.sinceSeq)).toEqual([2, 0]);
    expect(pad.current.events.find((e) => e.seq === 2)?.id).toBe("server-real-id-second");
    // The row nobody voided is untouched, and still the pad's own.
    expect(pad.current.events.find((e) => e.seq === 1)?.id).toBe(firstMinted);
    expect(pad.current.ownEventIds.has(firstMinted)).toBe(true);
    expect(running(pad)).toEqual({ home: 2, away: 0 });
  });

  // -------------------------------------------------------------------------
  // Review round 1, CRITICAL — Fix A re-keys an acked event to the server's
  // id. A void this pad queued BEFORE that ack names the event by the key it
  // minted, and has no `voidTargetSeq` (the target was not in the ledger yet
  // when it was submitted). So at its turn nothing in the ledger carries the
  // key any more, while `ownEventIds` still says the key is ours — and the
  // old verdict for that shape was "never landed": dropped, undo lost, and
  // the server kept the rally. These tests read what crossed the WIRE and
  // what the SERVER ended up holding, not the pad's opinion of itself.
  // -------------------------------------------------------------------------

  /** A server that keeps a real ledger: it assigns its OWN row ids
   *  (`srv-<seq>`), names them in the ack (Fix A), refuses a void naming a row
   *  it does not hold (as `assertUndoTarget` does), and is offline until the
   *  test says otherwise. */
  function ledgerServer() {
    const rows: LedgerSlotEvent[] = [];
    const appendCalls: AppendEventBody[] = [];
    const seqMismatches: AppendEventBody[] = [];
    let online = false;
    let voidGate: Promise<void> | null = null;
    let voidInFlight = false;
    const transport: PadTransport = {
      async appendEvent(_fixtureId, body) {
        appendCalls.push(body);
        if (!online) return { kind: "network-error", message: "offline" };
        const target = body.type === "core.void" ? ((body.payload as { event_id?: string }).event_id ?? null) : null;
        if (body.type === "core.void") {
          voidInFlight = true;
          if (voidGate !== null) await voidGate;
        }
        if (body.expected_seq !== rows.length) {
          seqMismatches.push(body);
          return { kind: "rejected", code: "TEST_SEQ_MISMATCH", message: "" };
        }
        if (body.type === "core.void" && !rows.some((r) => r.id === target)) {
          return { kind: "rejected", code: "NOTHING_TO_UNDO", message: "no such row" };
        }
        const seq = rows.length + 1;
        const id = `srv-${seq}`;
        rows.push({
          id,
          seq,
          type: body.type,
          payload: target === null ? body.payload : {},
          recorded_at: "2026-09-23T10:00:00.000Z",
          recorded_by: "user-1",
          device_link_id: null,
          voids_event_id: target,
        });
        return { kind: "ok", data: { seq, state_summary: { seq }, outcome: null, status: "in_play", event_id: id } };
      },
      async listEventsSince(_fixtureId, sinceSeq) {
        return rows.filter((r) => r.seq > sinceSeq);
      },
      async getLastSeq() {
        return rows.length;
      },
      async fetchState(): Promise<FixtureStateResult> {
        return { status: "in_play", last_seq: rows.length, state: null, summary: null, outcome: null };
      },
    };
    return {
      rows,
      appendCalls,
      seqMismatches,
      transport,
      goOnline() {
        online = true;
      },
      holdVoids() {
        const gate = deferred<void>();
        voidGate = gate.promise;
        return gate;
      },
      voidInFlight: () => voidInFlight,
    };
  }

  it("MUTATION TARGET (Fix A, undo before ack): a void queued behind its not-yet-acked target names the SERVER's id on the wire, and the server ends with the rally undone", async () => {
    const server = ledgerServer();
    const pad = mountPipeline(baseParams({ transport: server.transport }));
    await vi.advanceTimersByTimeAsync(0);

    // Offline: the tap queues, and the scorer undoes it before it ever sends.
    await pad.current.submit("generic.score", { by: "H", points: 2 });
    const mintedKey = pad.current.events.find((e) => e.type === "generic.score")!.id;
    await pad.current.submit("core.void", { event_id: mintedKey });
    expect(pad.current.queueDepth, "both wait for the network").toBe(2);
    expect(running(pad), "the optimistic fold already shows the undo").toBeUndefined();

    // Back online. The void's own send is held open, so the moment BETWEEN
    // the target's ack (which re-keys it to `srv-1`) and the void's ack can
    // be read: the still-pending void must follow the re-key.
    server.goOnline();
    const gate = server.holdVoids();
    const drained = pad.current.retryDrain();
    for (let i = 0; i < 20 && !server.voidInFlight(); i += 1) await vi.advanceTimersByTimeAsync(0);
    expect(server.voidInFlight(), "the void must reach the wire at all").toBe(true);
    expect(pad.current.events.find((e) => e.type === "generic.score")?.id).toBe("srv-1");
    expect(pad.current.lastRejection, "the pending void must not dangle once its target is re-keyed").toBeNull();
    expect(running(pad)).toBeUndefined();

    gate.resolve();
    await drained;

    const voidCalls = server.appendCalls.filter((c) => c.type === "core.void");
    expect(voidCalls.map((c) => c.payload), "the wire must name the row the server wrote").toEqual([
      { event_id: "srv-1" },
    ]);
    expect(server.seqMismatches).toEqual([]);
    expect(
      server.rows.map((r) => [r.type, r.voids_event_id]),
      "the SERVER's ledger: the rally, then a void of it",
    ).toEqual([
      ["generic.score", null],
      ["core.void", "srv-1"],
    ]);
    expect(pad.current.queueDepth).toBe(0);
    expect(pad.current.lastRejection).toBeNull();
    expect(running(pad)).toBeUndefined();
  });

  it("MUTATION TARGET (Fix A, amend a queued original): the amendment's void retires the original by its SERVER id — the corrected point is counted once", async () => {
    const server = ledgerServer();
    const pad = mountPipeline(baseParams({ transport: server.transport }));
    await vi.advanceTimersByTimeAsync(0);

    await pad.current.submit("generic.score", { by: "H", points: 2 });
    const originalKey = pad.current.events.find((e) => e.type === "generic.score")!.id;

    // The amendment, through the real `runAmend` over the real pipeline, while
    // the original is still queued behind a dead network.
    const heldId = await runAmend(
      { voidId: originalKey, type: "generic.score", payload: { by: "H", points: 3 } },
      {
        submitHeld: (type, payload) =>
          pad.current.submitHeld(type, payload, HOLD_MS, () => void pad.current.retryDrain()),
        submit: (type, payload, opts) => pad.current.submit(type, payload, opts),
      },
    );
    expect(heldId).not.toBeNull();
    expect(pad.current.queueDepth).toBe(3);

    server.goOnline();
    await vi.advanceTimersByTimeAsync(HOLD_MS + 100); // the hold runs out and drains everything
    await vi.advanceTimersByTimeAsync(0);

    expect(server.seqMismatches).toEqual([]);
    expect(server.appendCalls.filter((c) => c.type === "core.void").at(-1)?.payload).toEqual({ event_id: "srv-1" });
    expect(
      server.rows.map((r) => [r.type, r.voids_event_id]),
      "the original, its replacement, and a void of the ORIGINAL",
    ).toEqual([
      ["generic.score", null],
      ["generic.score", null],
      ["core.void", "srv-1"],
    ]);
    expect(pad.current.queueDepth).toBe(0);
    expect(pad.current.lastRejection).toBeNull();
    expect(running(pad), "the replacement stands alone — not 2 + 3").toEqual({ home: 3, away: 0 });
  });
});
