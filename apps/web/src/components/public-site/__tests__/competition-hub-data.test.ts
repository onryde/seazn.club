// Spectator surface W2, Task 7 — `fetchCompetitionHub`'s own payload-unwrap
// contract, split out from `use-live-competition.test.tsx` (dispatch ruling
// 3): that hook test mocks this module entirely, so an assertion on fetch's
// call shape made INSIDE it would pass with the URL spelled any way at all.
// Same regression this pattern guards against for W1's own
// `live-score-data.test.ts`: the public endpoints respond `{ ok, data }` and
// `api()` (`lib/client.ts:6`) unwraps `.data` once — the old code once
// unwrapped it a second time, so every poll replaced the document with
// `undefined`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCompetitionHub } from "../competition-hub-data";

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

describe("fetchCompetitionHub", () => {
  it("GETs the org/competition hub route and returns the document itself, not a wrapper with a .data property", async () => {
    const doc = { competitionId: "c1", name: "Autumn Cup" };
    stubFetch({ ok: true, data: doc });

    const res = await fetchCompetitionHub("riverside", "autumn-cup");

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/public/orgs/riverside/competitions/autumn-cup/hub",
      expect.anything(),
    );
    expect(res).toEqual(doc);
    // `Object.hasOwn`, not `toHaveProperty`. Same idiom rule the sibling
    // dictionary suite records: `toHaveProperty` path-traverses on dots, and
    // letting the traversal idiom spread through these files is how a flat
    // dotted key ends up asserted as a nested path. Single segment here, so
    // the two agree today — the point is that they stop agreeing silently.
    expect(Object.hasOwn(res as object, "data")).toBe(false);
  });

  // R10 H1. The hub route answers `Cache-Control: public, s-maxage=30,
  // stale-while-revalidate=300` for the CDN (usecases/public.ts), and Chromium
  // applies stale-while-revalidate to its OWN cache too. Measured on spectw2: a
  // push-triggered refetch came back with a `generatedAt` from BEFORE the
  // score, and the Knockout tab never moved. With the browser cache disabled
  // over CDP, the same run updated in 462ms. This goes through the real `api()`,
  // so the option has to survive its RequestInit spread to reach `fetch`.
  it("asks fetch for no-store, so the live refetch never reuses the browser's HTTP cache", async () => {
    stubFetch({ ok: true, data: { competitionId: "c1" } });

    await fetchCompetitionHub("riverside", "autumn-cup");

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/public/orgs/riverside/competitions/autumn-cup/hub",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("throws on error payloads instead of resolving undefined", async () => {
    stubFetch({ ok: false, error: "not found" }, false, 404);
    await expect(fetchCompetitionHub("riverside", "autumn-cup")).rejects.toThrow("not found");
  });
});
