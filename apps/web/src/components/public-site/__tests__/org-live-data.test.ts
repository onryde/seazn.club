// Spectator W2, Task 15 — `fetchOrgLive`'s own URL/unwrap contract, split out
// from `org-live-chips.test.tsx` the way `competition-hub-data.test.ts` is from
// the hub hook's test: that island test mocks this module whole, so an
// assertion on fetch's call shape made inside it would pass with the URL
// spelled any way at all.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOrgLive } from "../org-live-data";

function stubFetch(payload: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, status, json: async () => payload })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchOrgLive", () => {
  it("GETs the org's live route and returns the payload itself, not a wrapper with a .data property", async () => {
    const data = { competitions: [{ id: "c1", status: "published", in_play: 1 }] };
    stubFetch({ ok: true, data });

    const res = await fetchOrgLive("riverside");

    expect(fetch).toHaveBeenCalledWith("/api/v1/public/orgs/riverside/live", expect.anything());
    expect(res).toEqual(data);
    expect(Object.hasOwn(res as object, "data")).toBe(false);
  });

  // R10 H1, for the hub's reason: the route answers the CDN's
  // `stale-while-revalidate`, which Chromium applies to its own cache too, so a
  // poll without `no-store` can be handed the count from before a match began.
  it("asks fetch for no-store, so a poll never reuses the browser's HTTP cache", async () => {
    stubFetch({ ok: true, data: { competitions: [] } });
    await fetchOrgLive("riverside");
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/public/orgs/riverside/live",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("throws on an error payload instead of resolving undefined", async () => {
    stubFetch({ ok: false, error: "organization not found" }, false, 404);
    await expect(fetchOrgLive("riverside")).rejects.toThrow("organization not found");
  });
});
