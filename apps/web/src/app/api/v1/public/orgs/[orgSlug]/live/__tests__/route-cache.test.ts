// Spectator W2, Task 15 — the org-live poll's Redis cache-aside, witnessed
// END TO END through the route (the hub route's `route-cache.test.ts` shape):
// the usecase's own dependencies are mocked one layer down, and `cacheGet` /
// `cacheSet` are a real in-memory Map, so the second request reads what the
// first one wrote.
//
// The KEY is pinned here on purpose. A scoring write deletes
// `pub:v1:org-live:{orgId}` (`invalidatePublicCache`, pinned in
// `usecases/__tests__/hub-cache-invalidation.test.ts`), and a delete of a key
// nobody writes is an inert seam — the chip would wait out the TTL after every
// score. Both halves use the same literal.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => {}) }));

const store = new Map<string, unknown>();
const cacheGet = vi.hoisted(() => vi.fn(async (key: string): Promise<unknown> => (void key, null)));
const cacheSet = vi.hoisted(() =>
  vi.fn(async (key: string, value: unknown, ttl: number) => {
    void key;
    void value;
    void ttl;
  }),
);
const listOrgHomeCompetitions = vi.hoisted(() => vi.fn());
// The org lookup, standing in for the tagged-template `sql`.
const sql = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => [{ id: "org-1" }]));

vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheGet,
  cacheSet,
}));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  sql,
}));
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  listOrgHomeCompetitions,
}));

import { GET } from "../route";
import { ORG_LIVE_TTL_SECONDS } from "@/server/usecases/public";

const ctx = { params: Promise.resolve({ orgSlug: "riverside" }) };
const req = () => new Request("http://x/api/v1/public/orgs/riverside/live");

/** A real uuid: the cached document is parsed on the way back out of Redis
 *  (`PublicOrgLive`), and a competition id that fails the schema would read as a
 *  poisoned entry on every hit. */
const C1 = "00000000-0000-4000-8000-0000000000c1";

/** A full row as the shared query returns it — the poll must strip it down. */
const row = {
  id: C1,
  org_id: "org-1",
  name: "Autumn Cup",
  slug: "autumn-cup",
  description: "Long prose the poll has no business carrying",
  starts_on: "2026-09-01",
  ends_on: "2026-09-13",
  branding: {},
  status: "published",
  visibility: "public",
  in_play: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  sql.mockResolvedValue([{ id: "org-1" }]);
  listOrgHomeCompetitions.mockResolvedValue([row]);
  cacheGet.mockImplementation(async (key: string) => (store.has(key) ? store.get(key) : null));
  cacheSet.mockImplementation(async (key: string, value: unknown) => {
    store.set(key, value);
  });
});

describe("GET .../orgs/{orgSlug}/live — the Redis cache-aside, witnessed through the route", () => {
  it("writes `pub:v1:org-live:{orgId}` for 15 s, keyed by the org's ID (not its slug)", async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(listOrgHomeCompetitions).toHaveBeenCalledWith("org-1");
    expect(cacheSet).toHaveBeenCalledTimes(1);
    expect(cacheSet.mock.calls[0]?.[0]).toBe("pub:v1:org-live:org-1");
    expect(cacheSet.mock.calls[0]?.[2]).toBe(15);
    expect(ORG_LIVE_TTL_SECONDS).toBe(15);
  });

  it("carries only {id, status, in_play} per competition — not the page's whole row", async () => {
    const res = await GET(req(), ctx);
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      competitions: [{ id: C1, status: "published", in_play: 2 }],
    });
  });

  it("a second request is served from cache: the query runs once, not twice, and both carry the public header", async () => {
    const first = await GET(req(), ctx);
    const second = await GET(req(), ctx);
    expect(listOrgHomeCompetitions).toHaveBeenCalledTimes(1);
    expect(((await second.json()) as { data: unknown }).data).toEqual(
      ((await first.json()) as { data: unknown }).data,
    );
    for (const res of [first, second]) {
      expect(res.headers.get("cache-control")).toBe("public, s-maxage=30, stale-while-revalidate=300");
    }
  });

  it.each([
    ["a document of another shape", { fixtures: [] }],
    ["a competition with no in_play", { competitions: [{ id: C1, status: "published" }] }],
    ["a negative count", { competitions: [{ id: C1, status: "published", in_play: -1 }] }],
    ["a string", "stale"],
  ])("a malformed Redis hit (%s) is a MISS: the query re-runs and the fresh document replaces it", async (_, junk) => {
    // `cacheGet<T>` is a cast, not a parse: an entry left by an older build
    // must not be served as this build's shape for the rest of its TTL.
    store.set("pub:v1:org-live:org-1", junk);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(listOrgHomeCompetitions).toHaveBeenCalledTimes(1);
    const fresh = { competitions: [{ id: C1, status: "published", in_play: 2 }] };
    expect(((await res.json()) as { data: unknown }).data).toEqual(fresh);
    expect(store.get("pub:v1:org-live:org-1")).toEqual(fresh);
  });

  it("a well-formed Redis hit is served as is (the positive pair: the check does not refuse everything)", async () => {
    const cached = { competitions: [{ id: "00000000-0000-4000-8000-000000000001", status: "live", in_play: 5 }] };
    store.set("pub:v1:org-live:org-1", cached);
    const res = await GET(req(), ctx);
    expect(listOrgHomeCompetitions).not.toHaveBeenCalled();
    expect(((await res.json()) as { data: unknown }).data).toEqual(cached);
  });

  it("an unknown org is a 404 BEFORE the cache is touched", async () => {
    sql.mockResolvedValue([]);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(cacheGet).not.toHaveBeenCalled();
    expect(listOrgHomeCompetitions).not.toHaveBeenCalled();
  });
});
