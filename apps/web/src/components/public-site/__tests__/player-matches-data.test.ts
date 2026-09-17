// Spectator surface W2, Task 14 — `fetchPlayerMatches`'s own contract, through
// the REAL `api()` (the island's test mocks this module, so the URL and the
// cache mode can only be witnessed here). Same two regressions
// `competition-hub-data.test.ts` pins for the hub: `api()` unwraps `{ ok, data }`
// once and a second unwrap turns every poll into `undefined`; and without
// `no-store` Chromium answers a live refetch from its own HTTP cache, because
// the route's `stale-while-revalidate` applies to the browser as well.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fetchPlayerMatches } from "../player-matches-data";

const PERSON = "11111111-2222-3333-4444-555555555555";
const URL = `/api/v1/public/orgs/riverside/competitions/autumn-cup/players/${PERSON}/matches`;

function stubFetch(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchPlayerMatches", () => {
  it("GETs the player's matches route and returns the document itself, not the envelope", async () => {
    const body = { matches: [], generatedAt: "2026-09-05T12:00:00.000Z" };
    stubFetch({ ok: true, data: body });

    const res = await fetchPlayerMatches("riverside", "autumn-cup", PERSON);

    expect(fetch).toHaveBeenCalledWith(URL, expect.anything());
    expect(res).toEqual(body);
    expect(Object.hasOwn(res as object, "data")).toBe(false);
  });

  // The seam between the island and the endpoint, checked from the island's
  // side: the URL this module asks for is a route handler that EXISTS. Both
  // halves are unit-green on their own with the path spelled differently —
  // the route test calls its own `GET`, and the fetch above is a stub.
  it("the URL it fetches is served by a route handler on disk", async () => {
    stubFetch({ ok: true, data: { matches: [], generatedAt: "2026-09-05T12:00:00.000Z" } });
    await fetchPlayerMatches("ORG", "COMP", "PERSON");
    const requested = vi.mocked(fetch).mock.calls[0]![0] as string;
    const segments = requested
      .replace("/ORG/", "/[orgSlug]/")
      .replace("/COMP/", "/[slug]/")
      .replace("/PERSON/", "/[personId]/");
    const file = join(process.cwd(), "src/app", segments, "route.ts");
    expect(existsSync(file), file).toBe(true);
  });

  it("asks fetch for no-store, so a live refetch never reuses the browser's HTTP cache", async () => {
    stubFetch({ ok: true, data: { matches: [], generatedAt: "2026-09-05T12:00:00.000Z" } });
    await fetchPlayerMatches("riverside", "autumn-cup", PERSON);
    expect(fetch).toHaveBeenCalledWith(URL, expect.objectContaining({ cache: "no-store" }));
  });
});
