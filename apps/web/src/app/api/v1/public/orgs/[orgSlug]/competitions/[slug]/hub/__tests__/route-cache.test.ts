// Spectator W2, Task 5 — witnesses Task 4's Redis cache-aside (`pub:v1:hub:
// {competitionId}`, TTL 15 s, usecases/public.ts) END TO END through THIS
// route, not just through `publicCompetitionHub` in isolation
// (hub-cache-poisoned-entry.test.ts / hub-cache-invalidation.test.ts own
// that). `route.test.ts` in this same directory mocks `publicCompetitionHub`
// outright, so it cannot see the cache at all — this file mocks one layer
// lower, the usecase's own dependencies (`@/lib/cache`, `@/lib/db`,
// `@/server/public-site/competition-hub`), the same convention
// hub-cache-poisoned-entry.test.ts uses, and calls the real `GET` twice.
//
// `cacheGet`/`cacheSet` are backed by a real in-memory Map so the second
// request actually reads what the first one wrote — a stateless pair of
// `vi.fn()`s would prove nothing about whether the SECOND call skips the
// loader, only that each call was made with some arguments.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => {}) }));

const store = new Map<string, unknown>();
const cacheGet = vi.hoisted(() =>
  vi.fn(async (key: string) => {
    void key;
    return null as unknown;
  }),
);
const cacheSet = vi.hoisted(() =>
  vi.fn(async (key: string, value: unknown, ttl: number) => {
    void key;
    void value;
    void ttl;
  }),
);
const loadCompetitionHub = vi.hoisted(() => vi.fn());
// `findCompetition` (usecases/public.ts) runs before the cache is touched —
// a bare `vi.fn()` standing in for the tagged-template `sql`, same shape
// hub-cache-poisoned-entry.test.ts uses one layer down.
const sql = vi.hoisted(() => vi.fn(async () => [{ id: "c1" }]));

vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheGet,
  cacheSet,
}));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  sql,
}));
vi.mock("@/server/public-site/competition-hub", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/competition-hub")>()),
  loadCompetitionHub,
}));

import { GET } from "../route";
import { validHubDoc } from "@/server/public-site/__tests__/_hub-doc";

const ctx = { params: Promise.resolve({ orgSlug: "riverside", slug: "autumn-cup" }) };
const req = () => new Request("http://x/api/v1/public/orgs/riverside/competitions/autumn-cup/hub");

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  sql.mockResolvedValue([{ id: "c1" }]);
  loadCompetitionHub.mockResolvedValue(validHubDoc());
  cacheGet.mockImplementation(async (key: string) => (store.has(key) ? store.get(key) : null));
  cacheSet.mockImplementation(async (key: string, value: unknown) => {
    store.set(key, value);
  });
});

describe("GET .../hub — the Redis cache-aside, witnessed through the route", () => {
  it("a second request is served from cache: the loader runs once, not twice", async () => {
    const first = await GET(req(), ctx);
    expect(first.status).toBe(200);
    expect(loadCompetitionHub).toHaveBeenCalledTimes(1);
    expect(cacheSet).toHaveBeenCalledTimes(1);

    const second = await GET(req(), ctx);
    expect(second.status).toBe(200);
    // The loader must NOT have run again — the second read was served by
    // Redis, populated by the first request's cacheSet.
    expect(loadCompetitionHub).toHaveBeenCalledTimes(1);

    const firstBody = (await first.json()) as { data: unknown };
    const secondBody = (await second.json()) as { data: unknown };
    expect(secondBody.data).toEqual(firstBody.data);
  });

  it("both the cache-miss response and the cache-hit response carry the public cache header", async () => {
    const first = await GET(req(), ctx);
    expect(first.headers.get("cache-control")).toBe(
      "public, s-maxage=30, stale-while-revalidate=300",
    );
    const second = await GET(req(), ctx);
    expect(second.headers.get("cache-control")).toBe(
      "public, s-maxage=30, stale-while-revalidate=300",
    );
  });
});
