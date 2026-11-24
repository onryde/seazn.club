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
