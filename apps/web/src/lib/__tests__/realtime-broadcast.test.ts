// Realtime push-nudges T0.1 — `broadcast()`, the one server-side transport
// (design §1). One POST per chunk of 100 messages, sequential, each with the
// 3 s timeout; the `REALTIME_PUBLISH=off` kill switch and a missing target
// send nothing; it never throws, and its warn line carries the label and the
// status alone — never a message body, never the service key.
//
// The chunk size (100) and the timeout (3 s) are written here as LITERALS from
// the design, never read back from the module: a test sized from
// `BROADCAST_CHUNK` would move with a wrong constant instead of catching it.
//
// Applies to another sport: N/A (no sport rules).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Msg = { topic: string; event: string; payload: unknown; private?: true };
/** `n` distinct messages; the payload carries a marker a warn line must never echo. */
const msgs = (n: number, tag = "m"): Msg[] =>
  Array.from({ length: n }, (_, i) => ({
    topic: `t:${tag}${i}`,
    event: "e",
    payload: { i, marker: "BODY-MARKER" },
    private: true as const,
  }));

const URL = "https://example.supabase.co/realtime/v1/api/broadcast";
const HEADERS = { "Content-Type": "application/json", Authorization: "Bearer service-role", apikey: "service-role" };

describe("broadcast()", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.REALTIME_PUBLISH;
  });

  const sentBodies = () =>
    fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as { messages: Msg[] });

  it("an empty list sends nothing", async () => {
    const { broadcast } = await import("../realtime");
    await expect(broadcast([], "test")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // [messages, the chunk sizes the design's 100-per-request rule gives]
  const CASES: [number, number[]][] = [
    [1, [1]],
    [100, [100]],
    [101, [100, 1]],
    [250, [100, 100, 50]],
  ];
  it.each(CASES)("%i messages go out as chunks of %j, in order, one POST each", async (n, sizes) => {
    const { broadcast } = await import("../realtime");
    const all = msgs(n);
    await broadcast(all, "test");
    expect(fetchMock).toHaveBeenCalledTimes(sizes.length);
    const bodies = sentBodies();
    expect(bodies.map((b) => b.messages.length)).toEqual(sizes);
    // Every message exactly once, in the order handed in, each one verbatim.
    expect(bodies.flatMap((b) => b.messages)).toEqual(all);
    for (const [url, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(url).toBe(URL);
      expect(init.method).toBe("POST");
      expect(init.headers).toStrictEqual(HEADERS);
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("chunks are sent one after another: the second POST waits for the first to answer", async () => {
    const { broadcast } = await import("../realtime");
    const answers: ((v: unknown) => void)[] = [];
    fetchMock.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const sent = broadcast(msgs(101), "test");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock, "the second chunk is held while the first is in flight").toHaveBeenCalledTimes(1);
    answers[0]!({ ok: true, status: 202 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    answers[1]!({ ok: true, status: 202 });
    await sent;
  });

  it("REALTIME_PUBLISH=off sends nothing, even for several chunks", async () => {
    process.env.REALTIME_PUBLISH = "off";
    const { broadcast } = await import("../realtime");
    await broadcast(msgs(250), "test");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no Supabase URL or key: no target, nothing sent", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const { broadcast } = await import("../realtime");
    await broadcast(msgs(3), "test");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a POST that never answers is aborted at 3 s, and broadcast resolves", async () => {
    vi.useFakeTimers();
    const { broadcast } = await import("../realtime");
    // AbortSignal.timeout runs on Node's internal timers, which fake timers do
    // not drive; stand it in with one on the (faked) setTimeout.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
      return c.signal;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    let settled = false;
    const sent = broadcast(msgs(1), "test").then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(timeout).toHaveBeenCalledWith(3_000);
    expect(settled, "still waiting at 2.999 s").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sent;
    expect(settled, "aborted and resolved at 3 s").toBe(true);
    expect(warn.mock.calls).toEqual([["[realtime] test broadcast failed (TimeoutError)"]]);
  });

  // Review m4: an endpoint that let one chunk time out will not answer the next
  // one either; waiting 3 s per remaining chunk would hold an awaiting caller
  // for 3 s × chunks. The rest are dropped and counted in ONE warn line.
  const hangingChunks = async (answering: number) => {
    vi.useFakeTimers();
    const { broadcast } = await import("../realtime");
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
      return c.signal;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      calls += 1;
      if (calls <= answering) return Promise.resolve({ ok: true, status: 202 });
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    });
    let settled = false;
    const sent = broadcast(msgs(250), "test").then(() => {
      settled = true;
    });
    return { sent, warn, settled: () => settled };
  };

  it("three chunks, the first hangs: ONE fetch, resolved at 3 s, the two left skipped and counted once", async () => {
    const { sent, warn, settled } = await hangingChunks(0);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled(), "still waiting at 2.999 s").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled(), "resolved at 3 s, not 9 s").toBe(true);
    await sent;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls).toEqual([["[realtime] test broadcast failed (TimeoutError), 2 later chunks skipped"]]);
  });

  it("three chunks, the second hangs: two fetches, and the one left is skipped", async () => {
    const { sent, warn, settled } = await hangingChunks(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(settled(), "resolved at 3 s, not 6 s").toBe(true);
    await sent;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls).toEqual([["[realtime] test broadcast failed (TimeoutError), 1 later chunk skipped"]]);
  });

  it("a 500 resolves, and the warn line is the label and the status — no body, no key", async () => {
    const { broadcast } = await import("../realtime");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "BODY-MARKER" });
    await expect(broadcast(msgs(2), "test")).resolves.toBeUndefined();
    expect(warn.mock.calls).toEqual([["[realtime] test broadcast failed (500)"]]);
    const logged = JSON.stringify(warn.mock.calls);
    for (const leak of ["BODY-MARKER", "t:m0", "service-role", "messages"]) expect(logged).not.toContain(leak);
  });

  it("a thrown fetch resolves, and the warn line names the error class alone — never its message", async () => {
    const { broadcast } = await import("../realtime");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError("fetch failed BODY-MARKER Bearer service-role"));
    await expect(broadcast(msgs(2), "test")).resolves.toBeUndefined();
    expect(warn.mock.calls).toEqual([["[realtime] test broadcast failed (TypeError)"]]);
    const logged = JSON.stringify(warn.mock.calls);
    for (const leak of ["BODY-MARKER", "service-role"]) expect(logged).not.toContain(leak);
  });

  it("a body that cannot be serialised resolves instead of throwing (never throws)", async () => {
    const { broadcast } = await import("../realtime");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      broadcast([{ topic: "t:x", event: "e", payload: { big: BigInt(1) }, private: true }], "test"),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([["[realtime] test broadcast failed (TypeError)"]]);
  });

  it("a failed chunk does not cost the next chunk its POST", async () => {
    const { broadcast } = await import("../realtime");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({ ok: true, status: 202 });
    await broadcast(msgs(101), "test");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBodies()[1]!.messages).toEqual(msgs(101).slice(100));
    expect(warn.mock.calls).toEqual([["[realtime] test broadcast failed (503)"]]);
  });

  it("a second call is an independent POST carrying only its own messages", async () => {
    const { broadcast } = await import("../realtime");
    await broadcast(msgs(2, "a"), "first");
    await broadcast(msgs(1, "b"), "second");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBodies().map((b) => b.messages)).toEqual([msgs(2, "a"), msgs(1, "b")]);
  });
});

// The message and topic builders (design §1, the family table). Expected
// topics, events, reasons and shapes are written from the design and from
// today's publishers' bodies — never read back from the module.
describe("message and topic builders", () => {
  /** 2026-11-24T10:00:00.123Z */
  const FROZEN_MS = 1795514400123;
  const FROZEN_AT = "2026-11-24T10:00:00.123Z";
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_MS });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("topic builders give the design's topic names", async () => {
    const { captureTopic, matchDayTopic, divisionTopic } = await import("../realtime");
    expect(captureTopic("p-1")).toBe("capture:p-1");
    expect(matchDayTopic("c-1")).toBe("match-day:c-1");
    expect(divisionTopic("d-1")).toBe("division:d-1");
  });

  it("fixtureMessage is today's private state_changed on fixture:{id}", async () => {
    const { fixtureMessage } = await import("../realtime");
    expect(fixtureMessage("fx-1", "event")).toStrictEqual({
      topic: "fixture:fx-1",
      event: "state_changed",
      payload: { v: FROZEN_MS, reason: "event", at: FROZEN_AT },
      private: true,
    });
  });

  it("divisionMessages is the public message and its private twin: score → state_changed, every other reason → schedule_changed", async () => {
    const { divisionMessages } = await import("../realtime");
    // Every reason publishDivisionUpdate declares, with the event its body carries.
    const EXPECTED = [
      ["schedule", "schedule_changed"],
      ["publish", "schedule_changed"],
      ["start", "schedule_changed"],
      ["score", "state_changed"],
    ] as const;
    let checked = 0;
    for (const [reason, event] of EXPECTED) {
      const out = divisionMessages("dv-1", reason);
      const publicMessage = { topic: "division:dv-1", event, payload: { v: FROZEN_MS, reason, at: FROZEN_AT } };
      // The §4.3 dual-publish window (Task 14, D-a): the public message first, then its twin, `private: true`.
      expect(out, reason).toStrictEqual([publicMessage, { ...publicMessage, private: true }]);
      expect("private" in out[0]!, reason).toBe(false);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every division reason").toBe(4);
  });

  it("the nudge reasons are the design's, per family", async () => {
    const { CAPTURE_NUDGE_REASONS, MATCH_DAY_NUDGE_REASONS } = await import("../realtime");
    expect(CAPTURE_NUDGE_REASONS).toEqual(["go-live", "stop", "replaced", "over", "next-match"]);
    expect(MATCH_DAY_NUDGE_REASONS).toEqual(["score", "schedule", "call"]);
  });

  it("nudgeMessage is a PRIVATE ping {v, reason, at} on its topic — for every reason of both families", async () => {
    const { nudgeMessage, captureTopic, matchDayTopic, CAPTURE_NUDGE_REASONS, MATCH_DAY_NUDGE_REASONS } =
      await import("../realtime");
    let checked = 0;
    for (const reason of CAPTURE_NUDGE_REASONS) {
      expect(nudgeMessage(captureTopic("p-1"), reason), reason).toStrictEqual({
        topic: "capture:p-1",
        event: "nudge",
        payload: { v: FROZEN_MS, reason, at: FROZEN_AT },
        private: true,
      });
      checked += 1;
    }
    for (const reason of MATCH_DAY_NUDGE_REASONS) {
      expect(nudgeMessage(matchDayTopic("c-1"), reason), reason).toStrictEqual({
        topic: "match-day:c-1",
        event: "nudge",
        payload: { v: FROZEN_MS, reason, at: FROZEN_AT },
        private: true,
      });
      checked += 1;
    }
    expect(checked, "anti-vacuity: 5 capture + 3 Match Day reasons").toBe(8);
  });

  it("a second nudge later is a new ping: v and at move with the clock", async () => {
    const { nudgeMessage, captureTopic } = await import("../realtime");
    const first = nudgeMessage(captureTopic("p-1"), "go-live");
    vi.setSystemTime(FROZEN_MS + 1_000);
    const second = nudgeMessage(captureTopic("p-1"), "stop");
    expect(first.payload).toStrictEqual({ v: FROZEN_MS, reason: "go-live", at: FROZEN_AT });
    expect(second.payload).toStrictEqual({ v: FROZEN_MS + 1_000, reason: "stop", at: "2026-11-24T10:00:01.123Z" });
  });

  it("a reason from the other family does not type-check (compile-time guard)", async () => {
    const { nudgeMessage, captureTopic, matchDayTopic } = await import("../realtime");
    // @ts-expect-error — "score" is a Match Day reason, not a capture one.
    nudgeMessage(captureTopic("p-1"), "score");
    // @ts-expect-error — "go-live" is a capture reason, not a Match Day one.
    nudgeMessage(matchDayTopic("c-1"), "go-live");
    // @ts-expect-error — a division topic carries no nudge event.
    nudgeMessage("division:d-1", "score");
  });
});
