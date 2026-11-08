// Regression: the public fixture endpoints respond `{ ok, data: ... }` and
// api() unwraps `.data` once. The old LiveScore code unwrapped twice, so
// polling replaced the scoreboard with `undefined` and the realtime-token
// flow threw "Cannot read properties of undefined (reading 'token')".
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchLiveFixture,
  fetchOverlayFixture,
  fetchPublicRealtimeToken,
  OVERLAY_REALTIME_PURPOSE,
  sampleServerOffset,
} from "../live-score-data";
import { createServerOffset } from "@/components/v2/scorepad/server-offset";
import { OVERLAY_KEY_PARAM, REALTIME_PURPOSE_PARAM } from "@/lib/realtime-purpose";

function stubFetch(payload: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status,
      json: async () => payload,
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchLiveFixture", () => {
  it("returns the fixture itself, not a wrapper with a .data property", async () => {
    const fixture = { status: "in_play", summary: { headline: "1 — 0" }, outcome: null };
    stubFetch({ ok: true, data: fixture });
    const res = await fetchLiveFixture("fx-1");
    expect(res.status).toBe("in_play");
    expect(res).not.toHaveProperty("data");
  });

  it("throws on error payloads instead of resolving undefined", async () => {
    stubFetch({ ok: false, error: "not found" }, false, 404);
    await expect(fetchLiveFixture("fx-1")).rejects.toThrow("not found");
  });
});

describe("fetchPublicRealtimeToken", () => {
  it("returns token + channel directly", async () => {
    stubFetch({ ok: true, data: { token: "jwt", channel: "fixture:fx-1" } });
    const res = await fetchPublicRealtimeToken("fx-1");
    expect(res.token).toBe("jwt");
    expect(res.channel).toBe("fixture:fx-1");
  });

  it("RT: a declared purpose and its signed key travel on the request's query string, under the route's own names; without them the URL is unchanged", async () => {
    stubFetch({ ok: true, data: { token: "jwt", channel: "fixture:fx-1" } });
    await fetchPublicRealtimeToken("fx-1", OVERLAY_REALTIME_PURPOSE, "k_-9Z");
    await fetchPublicRealtimeToken("fx-1");
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(urls).toHaveLength(2);
    const keyed = new URL(urls[0]!, "http://x.test");
    expect(keyed.pathname).toBe("/api/v1/public/fixtures/fx-1/realtime-token");
    expect(keyed.searchParams.get(REALTIME_PURPOSE_PARAM)).toBe(OVERLAY_REALTIME_PURPOSE);
    expect(keyed.searchParams.get(OVERLAY_KEY_PARAM), "the key survives the query string byte for byte").toBe("k_-9Z");
    expect(urls[1]).toMatch(/\/api\/v1\/public\/fixtures\/fx-1\/realtime-token$/);
  });

  it("throws when the org is not entitled (403)", async () => {
    stubFetch({ ok: false, error: "payment required" }, false, 403);
    await expect(fetchPublicRealtimeToken("fx-1")).rejects.toThrow("payment required");
  });
});

// S2-5 ruling 110: the overlay's football clock reads the server's time, measured off the overlay's own polls by the
// pad's rule (server-offset.ts): the `Date` header's second plus 500 ms, against the request's local midpoint. Every
// expected offset is worked by hand.
describe("the overlay poll measures the server's time (S2-5 ruling 110)", () => {
  const DATE = "Thu, 01 Jan 2026 00:00:10 GMT";
  const D = Date.parse(DATE);
  const answer = (headers: Record<string, string>) => ({
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => ({ ok: true, data: { status: "in_play" } }),
  });

  it("fetchOverlayFixture samples its answer's Date header into the page's offset", async () => {
    // The page's window is module state that nothing in production ever clears, and other tests in this file poll
    // through `fetchOverlayFixture` too. A fresh module registry gives this test its own window whatever ran before.
    vi.resetModules();
    const { fetchOverlayFixture } = await import("../live-score-data");
    const { overlayServerOffsetMs } = await import("../overlay-server-offset");
    expect(overlayServerOffsetMs(), "nothing measured before the first poll").toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => answer({ date: DATE })));
    // A machine five minutes fast: sent at D + 300 000, answered 200 ms later. Midpoint D + 300 100; the server's
    // second plus half of it, D + 500; the offset D + 500 − (D + 300 100) = −299 600.
    vi.spyOn(Date, "now").mockReturnValueOnce(D + 300_000).mockReturnValueOnce(D + 300_200);
    const data = await fetchOverlayFixture("fx-1");
    expect(data.status, "the poll's answer is untouched").toBe("in_play");
    expect(overlayServerOffsetMs()).toBe(-299_600);
  });

  it("an answer a shared cache served (Age above 0) is not sampled; Age 0 is", () => {
    const cached = createServerOffset();
    sampleServerOffset(cached, answer({ date: DATE, age: "1" }) as unknown as Response, D, D + 200);
    expect(cached.offsetMs(), "a stored answer's Date is when it was stored").toBeNull();
    const fresh = createServerOffset();
    sampleServerOffset(fresh, answer({ date: DATE, age: "0" }) as unknown as Response, D, D + 200);
    expect(fresh.offsetMs(), "D + 500 − (D + 100)").toBe(400);
  });

  it("a round trip over 5 s says too little and is dropped (the pad's rule)", () => {
    const offset = createServerOffset();
    sampleServerOffset(offset, answer({ date: DATE }) as unknown as Response, D, D + 5_001);
    expect(offset.offsetMs()).toBeNull();
  });

  it("an answer whose headers cannot be read is still the poll's answer", async () => {
    stubFetch({ ok: true, data: { status: "in_play" } }); // no `headers` at all
    await expect(fetchOverlayFixture("fx-2")).resolves.toEqual({ status: "in_play" });
  });
});

