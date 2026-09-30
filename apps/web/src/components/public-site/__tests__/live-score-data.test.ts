// Regression: the public fixture endpoints respond `{ ok, data: ... }` and
// api() unwraps `.data` once. The old LiveScore code unwrapped twice, so
// polling replaced the scoreboard with `undefined` and the realtime-token
// flow threw "Cannot read properties of undefined (reading 'token')".
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLiveFixture, fetchPublicRealtimeToken, OVERLAY_REALTIME_PURPOSE } from "../live-score-data";
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

afterEach(() => vi.unstubAllGlobals());

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
