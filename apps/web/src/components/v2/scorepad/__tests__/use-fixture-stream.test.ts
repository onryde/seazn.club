// Live-update transport pair (S10/#419 W8): Supabase realtime where
// entitled, 15s polling fallback otherwise — no renderer needed for this
// hook's own contract, so it is driven directly (not through the
// _hook-harness) using fake timers and injected doubles for both the token
// fetch and the realtime connector. `listEventsSince` is injected too,
// mirroring how a real caller would pass `transport.listEventsSince` bound
// (transport.ts) rather than this hook re-deriving a second authed GET.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import type { LedgerSlotEvent } from "../types";
import type { RealtimeConnector, RealtimeSubscription, UseFixtureStreamParams, UseFixtureStreamResult } from "../use-fixture-stream";
import { useFixtureStream } from "../use-fixture-stream";

function fakeResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url);
  }) as typeof fetch;
  return { fn, calls };
}

/** A connector double whose `connect()` calls are inspectable and whose
 *  status/signal can be fired manually from the test. */
function fakeConnector() {
  const connectCalls: { token: string; channel: string }[] = [];
  const unsubscribes: number[] = [];
  let onSignal: (() => void) | null = null;
  let onStatus: ((subscribed: boolean) => void) | null = null;
  const connector: RealtimeConnector = {
    connect(params) {
      connectCalls.push({ token: params.token, channel: params.channel });
      onSignal = params.onSignal;
      onStatus = params.onStatus;
      const sub: RealtimeSubscription = {
        unsubscribe() {
          unsubscribes.push(1);
        },
      };
      return sub;
    },
  };
  return {
    connector,
    connectCalls,
    unsubscribes,
    fireSignal: () => onSignal?.(),
    fireStatus: (subscribed: boolean) => onStatus?.(subscribed),
  };
}

function mountStream(params: UseFixtureStreamParams) {
  let latest!: UseFixtureStreamResult;
  function Probe(props: { params: UseFixtureStreamParams; onReady: (r: UseFixtureStreamResult) => void }) {
    const result = useFixtureStream(props.params);
    props.onReady(result);
    return null;
  }
  const island = renderIsland(Probe, { params, onReady: (r) => (latest = r) });
  return {
    get current() {
      return latest;
    },
    unmount: () => island.unmount(),
  };
}

const rows: LedgerSlotEvent[] = [
  { seq: 5, type: "core.note", payload: {}, recorded_by: "u1", device_link_id: null },
];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useFixtureStream — realtime path", () => {
  it("on a 200 token, attempts realtime with the right token/channel; a confirmed subscribe means NO polling timer starts", async () => {
    const { fn } = fakeFetch(() => fakeResponse(200, { ok: true, data: { token: "tok-abc", channel: "fixture:fx-1" } }));
    const listEventsSince = vi.fn(async () => []);
    const { connector, connectCalls, fireStatus } = fakeConnector();
    const stream = mountStream({
      fixtureId: "fx-1",
      auth: { kind: "session" },
      sinceSeq: 0,
      onEvents: () => {},
      fetchFn: fn,
      connector,
      listEventsSince,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(connectCalls).toEqual([{ token: "tok-abc", channel: "fixture:fx-1" }]);

    fireStatus(true); // the connector confirms synchronously, as this double can
    expect(stream.current.mode).toBe("realtime");

    // No fallback polling should have been armed once realtime confirmed —
    // advancing well past pollMs must not call listEventsSince from a timer.
    // The one read already made is the catch-up on subscribe (its own
    // describe block, below).
    expect(listEventsSince).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listEventsSince).toHaveBeenCalledTimes(1);
  });

  it("a realtime broadcast signal triggers the SAME listEventsSince fetch a poll tick would", async () => {
    const { fn } = fakeFetch(() => fakeResponse(200, { ok: true, data: { token: "tok-abc", channel: "fixture:fx-1" } }));
    const onEvents = vi.fn();
    const listEventsSince = vi.fn(async () => rows);
    const { connector, fireStatus, fireSignal } = fakeConnector();
    mountStream({
      fixtureId: "fx-1",
      auth: { kind: "session" },
      sinceSeq: 4,
      onEvents,
      fetchFn: fn,
      connector,
      listEventsSince,
    });
    await vi.advanceTimersByTimeAsync(0);
    fireStatus(true);
    // The catch-up on subscribe has already read once; measured from here so
    // that read cannot stand in for the signal's.
    const readsBefore = listEventsSince.mock.calls.length;
    const deliveriesBefore = onEvents.mock.calls.length;

    fireSignal();
    await vi.advanceTimersByTimeAsync(0);
    expect(listEventsSince.mock.calls.slice(readsBefore)).toEqual([["fx-1", 4]]);
    expect(onEvents.mock.calls.slice(deliveriesBefore)).toEqual([[rows]]);
  });
});

describe("useFixtureStream — polling fallback", () => {
  it("a 403 (or any failure) on the token fetch falls back to 15s polling, with NO thrown error and NO realtime attempt", async () => {
    const { fn } = fakeFetch(() => fakeResponse(403, { ok: false, error: { code: "FORBIDDEN", message: "not entitled" } }));
    const onEvents = vi.fn();
    const listEventsSince = vi.fn(async () => rows);
    const { connector, connectCalls } = fakeConnector();
    const stream = mountStream({
      fixtureId: "fx-1",
      auth: { kind: "session" },
      sinceSeq: 4,
      onEvents,
      fetchFn: fn,
      connector,
      listEventsSince,
      pollMs: 15_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(connectCalls).toEqual([]); // never attempted realtime
    expect(stream.current.mode).toBe("polling");
    // Only the catch-up on subscribe so far — the interval hasn't fired.
    expect(listEventsSince).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(listEventsSince).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(listEventsSince).toHaveBeenCalledTimes(2);
    expect(listEventsSince).toHaveBeenLastCalledWith("fx-1", 4);
    expect(onEvents).toHaveBeenCalledWith(rows);
  });

  it("a thrown fetch on the token request ALSO falls back to polling without throwing", async () => {
    const fn = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const listEventsSince = vi.fn(async () => []);
    const { connector } = fakeConnector();
    const stream = mountStream({
      fixtureId: "fx-1",
      auth: { kind: "session" },
      sinceSeq: 0,
      onEvents: () => {},
      fetchFn: fn,
      connector,
      listEventsSince,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.current.mode).toBe("polling");
  });

  it("does not stampede: a slow in-flight poll fetch is never joined by a second overlapping call", async () => {
    const { fn } = fakeFetch(() => fakeResponse(403, { ok: false, error: { code: "FORBIDDEN", message: "no" } }));
    let resolveFetch!: (rows: LedgerSlotEvent[]) => void;
    const listEventsSince = vi.fn(
      () =>
        new Promise<LedgerSlotEvent[]>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const { connector } = fakeConnector();
    mountStream({
      fixtureId: "fx-1",
      auth: { kind: "session" },
      sinceSeq: 0,
      onEvents: () => {},
      fetchFn: fn,
      connector,
      listEventsSince,
      pollMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0); // token fails, polling starts, the catch-up read goes out (never resolved yet)
    expect(listEventsSince).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000); // first tick due WHILE that read is still in flight
    expect(listEventsSince).toHaveBeenCalledTimes(1); // no overlap
    await vi.advanceTimersByTimeAsync(1_000); // and the second
    expect(listEventsSince).toHaveBeenCalledTimes(1);

    resolveFetch([]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000); // now a fresh tick may fetch again
    expect(listEventsSince).toHaveBeenCalledTimes(2);
  });

  it("skipPollWhile suppresses a due tick without stopping the interval", async () => {
    const { fn } = fakeFetch(() => fakeResponse(403, { ok: false, error: { code: "FORBIDDEN", message: "no" } }));
    const listEventsSince = vi.fn(async () => []);
    const { connector } = fakeConnector();
    let skip = true;
    mountStream({
      fixtureId: "fx-1",
      auth: { kind: "session" },
      sinceSeq: 0,
      onEvents: () => {},
      fetchFn: fn,
      connector,
      listEventsSince,
      pollMs: 1_000,
      skipPollWhile: () => skip,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listEventsSince).not.toHaveBeenCalled(); // suppressed

    skip = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listEventsSince).toHaveBeenCalledTimes(1); // resumes on the next tick
  });

  it("a rejecting listEventsSince during a poll tick does not crash — the NEXT tick still fires (no user-visible error state)", async () => {
    const { fn } = fakeFetch(() => fakeResponse(403, { ok: false, error: { code: "FORBIDDEN", message: "no" } }));
    const listEventsSince = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(rows);
    const onEvents = vi.fn();
    const { connector } = fakeConnector();
    mountStream({
      fixtureId: "fx-1",
      auth: { kind: "session" },
      sinceSeq: 0,
      onEvents,
      fetchFn: fn,
      connector,
      listEventsSince,
      pollMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0); // the catch-up read is the one that rejects
    expect(listEventsSince).toHaveBeenCalledTimes(1);
    expect(onEvents).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(listEventsSince).toHaveBeenCalledTimes(2);
    expect(onEvents).toHaveBeenCalledWith(rows);
  });
});

// The seed a pad mounts with can be older than the page. Browser Back/Forward
// re-uses the router's cached RSC payload, so the console remounts on the
// ledger it had when the scorer left — and neither transport ever re-reads
// what was written in between: a realtime channel only signals FUTURE
// writes, and the first poll tick is `pollMs` away. So the stream reads once
// as it subscribes. On a fresh page that read returns nothing new (the cursor
// is the seed's own count), which the pipeline treats as a no-op.
describe("useFixtureStream — catch-up on subscribe", () => {
  it("realtime: reads once from the seed's cursor as it subscribes, and hands the rows over", async () => {
    const { fn } = fakeFetch(() => fakeResponse(200, { ok: true, data: { token: "t", channel: "c" } }));
    const onEvents = vi.fn();
    const listEventsSince = vi.fn(async () => rows);
    const { connector, fireStatus } = fakeConnector();
    mountStream({ fixtureId: "fx-1", auth: { kind: "session" }, sinceSeq: 4, onEvents, fetchFn: fn, connector, listEventsSince });
    await vi.advanceTimersByTimeAsync(0);
    fireStatus(true);
    expect(listEventsSince.mock.calls).toEqual([["fx-1", 4]]);
    expect(onEvents).toHaveBeenCalledWith(rows);

    // ONE read, not a loop: a confirmed channel arms no timer.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listEventsSince).toHaveBeenCalledTimes(1);
  });

  it("polling fallback: reads once as it subscribes, BEFORE the first tick is due", async () => {
    const { fn } = fakeFetch(() => fakeResponse(403, { ok: false, error: { code: "FORBIDDEN", message: "no" } }));
    const onEvents = vi.fn();
    const listEventsSince = vi.fn(async () => rows);
    const { connector } = fakeConnector();
    mountStream({
      fixtureId: "fx-1",
      auth: { kind: "session" },
      sinceSeq: 4,
      onEvents,
      fetchFn: fn,
      connector,
      listEventsSince,
      pollMs: 15_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(listEventsSince.mock.calls).toEqual([["fx-1", 4]]);
    expect(onEvents).toHaveBeenCalledWith(rows);
  });

  it("a thrown token door still catches up", async () => {
    const fn = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const listEventsSince = vi.fn(async () => []);
    const { connector } = fakeConnector();
    mountStream({ fixtureId: "fx-1", auth: { kind: "session" }, sinceSeq: 2, onEvents: () => {}, fetchFn: fn, connector, listEventsSince });
    await vi.advanceTimersByTimeAsync(0);
    expect(listEventsSince.mock.calls).toEqual([["fx-1", 2]]);
  });

  it("an unmount before the token door answers makes no catch-up read", async () => {
    let answer!: (res: Response) => void;
    const fn = (() =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      })) as typeof fetch;
    const listEventsSince = vi.fn(async () => []);
    const { connector } = fakeConnector();
    const stream = mountStream({ fixtureId: "fx-1", auth: { kind: "session" }, sinceSeq: 0, onEvents: () => {}, fetchFn: fn, connector, listEventsSince });
    await vi.advanceTimersByTimeAsync(0);
    stream.unmount();
    answer(fakeResponse(200, { ok: true, data: { token: "t", channel: "c" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(listEventsSince).not.toHaveBeenCalled();
  });
});

describe("useFixtureStream — auth modes", () => {
  it("device_link mode sends the Bearer dl_ token on the realtime-token request — the bypass path route.ts implements", async () => {
    const { fn, calls } = fakeFetch(() => fakeResponse(200, { ok: true, data: { token: "t", channel: "c" } }));
    const { connector } = fakeConnector();
    mountStream({
      fixtureId: "fx-1",
      auth: { kind: "device_link", token: "dl_xyz" },
      sinceSeq: 0,
      onEvents: () => {},
      fetchFn: fn,
      connector,
      listEventsSince: vi.fn(async () => []),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]!.url).toBe("/api/v1/public/fixtures/fx-1/realtime-token");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer dl_xyz");
  });

  it("session mode sends NO Authorization header — relies on the browser's own cookie", async () => {
    const { fn, calls } = fakeFetch(() => fakeResponse(200, { ok: true, data: { token: "t", channel: "c" } }));
    const { connector } = fakeConnector();
    mountStream({
      fixtureId: "fx-1",
      auth: { kind: "session" },
      sinceSeq: 0,
      onEvents: () => {},
      fetchFn: fn,
      connector,
      listEventsSince: vi.fn(async () => []),
    });
    await vi.advanceTimersByTimeAsync(0);
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("useFixtureStream — unmount", () => {
  it("stops the polling interval and unsubscribes the realtime connector on unmount", async () => {
    const { fn } = fakeFetch(() => fakeResponse(200, { ok: true, data: { token: "t", channel: "c" } }));
    const listEventsSince = vi.fn(async () => []);
    const { connector, fireStatus, unsubscribes } = fakeConnector();
    const stream = mountStream({
      fixtureId: "fx-1",
      auth: { kind: "session" },
      sinceSeq: 0,
      onEvents: () => {},
      fetchFn: fn,
      connector,
      listEventsSince,
      pollMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    fireStatus(false); // never confirmed — stays on polling
    expect(listEventsSince).toHaveBeenCalledTimes(1); // the catch-up on subscribe

    stream.unmount();
    expect(unsubscribes.length).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(listEventsSince).toHaveBeenCalledTimes(1); // interval cleared, no further ticks
  });
});
