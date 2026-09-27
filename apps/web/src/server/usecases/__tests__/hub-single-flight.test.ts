// Public hub perf T2 (2026-09-24) — `publicCompetitionHub` under a stampede.
//
// A score write DELs `pub:v1:hub:{competitionId}` and pushes to every open
// tab; every tab refetches inside the same second. Before this task each of
// those refetches (a) looked the competition up in Postgres BEFORE touching
// Redis, and (b) on the miss, rebuilt the whole hub (~9 + 13 x divisions
// queries). Pinned here, through the real usecase with the lease primitives
// replaced by the in-memory fake (`lib/__tests__/_fake-lease-cache.ts`):
//
//   - after a write's DEL, 20 concurrent polls rebuild the hub ONCE, and none
//     of them asks Postgres for the competition (its slug lookup is cached);
//   - the rebuild that was in flight when a write landed is not cached, and
//     the next poll sees the write;
//   - the slug lookup never caches a REFUSAL, and a dropped lookup refuses a
//     competition that has gone private on the very next poll (both
//     directions — the real write paths are driven against Postgres + Redis
//     in `public-competition-ref.redis.test.ts`).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cache", async (importOriginal) => {
  const { fakeLeaseCache } = await import("@/lib/__tests__/_fake-lease-cache");
  return { ...(await importOriginal<typeof import("@/lib/cache")>()), ...fakeLeaseCache.module() };
});
const sql = vi.hoisted(() =>
  vi.fn(async (...args: unknown[]): Promise<unknown[]> => {
    void args;
    return [];
  }),
);
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  sql,
}));
const loadCompetitionHub = vi.hoisted(() => vi.fn());
vi.mock("@/server/public-site/competition-hub", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/competition-hub")>()),
  loadCompetitionHub,
}));
const reconcilePlayerStatsOnRead = vi.hoisted(() => vi.fn());
vi.mock("@/server/usecases/player-stats-refresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/player-stats-refresh")>()),
  reconcilePlayerStatsOnRead,
}));

import { fakeLeaseCache as redis } from "@/lib/__tests__/_fake-lease-cache";
import { validHubDoc } from "@/server/public-site/__tests__/_hub-doc";
import { publicHubCacheKey, publicHubStaleCacheKey } from "@/server/public-site/hub-doc-cache-keys";
import { dropPublicCompetitionRefs, publicCompetitionRefKey } from "@/server/public-site/public-ref-cache";
import { HUB_STALE_TTL_SECONDS, HUB_TTL_SECONDS, publicCompetitionHub } from "../public";
import { dropNamedPublicDocuments } from "@/server/public-site/revalidate";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";

const COMP = "c0ffee00-0000-4000-8000-000000000001";
const ORG = "c0ffee00-0000-4000-8000-0000000000aa";
const HUB = publicHubCacheKey(COMP);

/** The "database" the loader reads: a score moves `score`. */
let db = { score: 1 };
/** Park every rebuild until the test opens it. */
let hold: Promise<unknown> | null = null;

function docFor(score: number): CompetitionHubDocT {
  const doc = validHubDoc() as CompetitionHubDocT;
  return { ...doc, generatedAt: new Date(Date.UTC(2026, 8, 24, 12, 0, score)).toISOString() };
}
const scoreOf = (doc: CompetitionHubDocT) => new Date(doc.generatedAt).getUTCSeconds();

/** Every competition lookup (`findCompetitionRef`'s one query) goes through sql. */
const lookups = () => sql.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  redis.reset();
  db = { score: 1 };
  hold = null;
  sql.mockImplementation(async () => [{ id: COMP, org_id: ORG }]);
  loadCompetitionHub.mockImplementation(async () => {
    const score = db.score;
    if (hold) await hold;
    return docFor(score);
  });
});

describe("the hub under a stampede", () => {
  it("after a score's DEL, 20 concurrent polls rebuild ONCE and ask Postgres for the competition ZERO times", async () => {
    await publicCompetitionHub("riverside", "autumn-cup");
    expect(loadCompetitionHub).toHaveBeenCalledTimes(1);
    expect(lookups()).toBe(1);

    // The score: commit, then the writer's DEL of the hub key.
    db = { score: 2 };
    await redis.del(HUB);

    const docs = await Promise.all(
      Array.from({ length: 20 }, () => publicCompetitionHub("riverside", "autumn-cup")),
    );

    expect(loadCompetitionHub).toHaveBeenCalledTimes(2);
    expect(lookups()).toBe(1);
    expect(docs.map(scoreOf)).toEqual(Array(20).fill(2));
  });

  it("20 concurrent polls of a hub nobody has read yet still rebuild it only once", async () => {
    const docs = await Promise.all(
      Array.from({ length: 20 }, () => publicCompetitionHub("riverside", "autumn-cup")),
    );

    expect(loadCompetitionHub).toHaveBeenCalledTimes(1);
    expect(new Set(docs.map((d) => d.generatedAt)).size).toBe(1);
  });

  it("a warm poll touches neither the database nor the loader", async () => {
    await publicCompetitionHub("riverside", "autumn-cup");
    const before = { lookups: lookups(), builds: loadCompetitionHub.mock.calls.length };

    await publicCompetitionHub("riverside", "autumn-cup");

    expect(lookups()).toBe(before.lookups);
    expect(loadCompetitionHub.mock.calls.length).toBe(before.builds);
  });

  it("every rebuild also refreshes the last-known-good copy, with its longer TTL than the hub's", async () => {
    const doc = await publicCompetitionHub("riverside", "autumn-cup");

    expect(redis.peek(publicHubStaleCacheKey(COMP))).toEqual(doc);
    expect(HUB_STALE_TTL_SECONDS).toBeGreaterThan(HUB_TTL_SECONDS);
  });
});

describe("the hub after a write that lands mid-rebuild", () => {
  it("the in-flight pre-write rebuild is not cached; the next poll serves the write", async () => {
    let open!: () => void;
    hold = new Promise<void>((r) => (open = r));
    const inFlight = publicCompetitionHub("riverside", "autumn-cup");
    await vi.waitFor(() => expect(loadCompetitionHub).toHaveBeenCalledTimes(1));

    db = { score: 2 };
    await redis.del(HUB);
    hold = null;
    open();
    const own = await inFlight;

    expect(scoreOf(own)).toBe(1); // its request came before the write
    expect(redis.peek(HUB)).toBeUndefined();
    const next = await publicCompetitionHub("riverside", "autumn-cup");
    expect(scoreOf(next)).toBe(2);
    expect(scoreOf(next)).not.toBe(scoreOf(own));
  });
});

describe("the competition lookup in front of the hub", () => {
  it("a refusal is never cached: a private competition is asked for on every poll, and served the poll after it goes public", async () => {
    sql.mockImplementation(async () => []);

    await expect(publicCompetitionHub("riverside", "autumn-cup")).rejects.toMatchObject({ status: 404 });
    await expect(publicCompetitionHub("riverside", "autumn-cup")).rejects.toMatchObject({ status: 404 });
    expect(lookups()).toBe(2);
    expect(redis.peek(publicCompetitionRefKey("riverside", "autumn-cup"))).toBeUndefined();

    sql.mockImplementation(async () => [{ id: COMP, org_id: ORG }]);
    await expect(publicCompetitionHub("riverside", "autumn-cup")).resolves.toBeDefined();
  });

  it("a public competition keeps being served from the cached lookup — until its lookup is dropped, then the next poll refuses it", async () => {
    await publicCompetitionHub("riverside", "autumn-cup");
    // It goes private in Postgres; the cached lookup has not been told yet.
    sql.mockImplementation(async () => []);
    await expect(publicCompetitionHub("riverside", "autumn-cup")).resolves.toBeDefined();

    // What every write path that can change visibility, slug or existence
    // calls after its commit.
    await dropPublicCompetitionRefs("riverside", "autumn-cup");

    await expect(publicCompetitionHub("riverside", "autumn-cup")).rejects.toMatchObject({ status: 404 });
  });

  it("the lookup is keyed by BOTH slugs: another org's competition of the same slug is looked up on its own", async () => {
    await publicCompetitionHub("riverside", "autumn-cup");
    const before = lookups();

    await publicCompetitionHub("hillside", "autumn-cup");

    expect(lookups()).toBe(before + 1);
  });

  it("the player-stats reconcile still runs on every poll, with the competition's org", async () => {
    await publicCompetitionHub("riverside", "autumn-cup");
    await publicCompetitionHub("riverside", "autumn-cup");

    expect(reconcilePlayerStatsOnRead).toHaveBeenCalledTimes(2);
    expect(reconcilePlayerStatsOnRead.mock.calls.every((c) => c[0] === ORG)).toBe(true);
  });
});

describe("the last-known-good copy and a withdrawn name", () => {
  it("a write that WITHDRAWS a name (dropNamedPublicDocuments) drops the copy with the document — a copy printing it would be a leak, not staleness", async () => {
    await publicCompetitionHub("riverside", "autumn-cup");
    expect(redis.peek(publicHubStaleCacheKey(COMP)), "premise: the rebuild wrote the copy").toBeDefined();

    dropNamedPublicDocuments({ competitionIds: [COMP], divisionIds: [], fixtureIds: [] }, { test: true });

    await vi.waitFor(() => expect(redis.count("del", publicHubStaleCacheKey(COMP))).toBeGreaterThan(0));
    expect(redis.peek(publicHubStaleCacheKey(COMP))).toBeUndefined();
    expect(redis.peek(HUB)).toBeUndefined();
  });

  it("…and another competition's copy is left alone", async () => {
    const OTHER = "c0ffee00-0000-4000-8000-000000000002";
    redis.seed(publicHubStaleCacheKey(OTHER), docFor(1));

    dropNamedPublicDocuments({ competitionIds: [COMP], divisionIds: [], fixtureIds: [] }, { test: true });

    await vi.waitFor(() => expect(redis.count("del", publicHubStaleCacheKey(COMP))).toBeGreaterThan(0));
    expect(redis.peek(publicHubStaleCacheKey(OTHER))).toBeDefined();
  });
});

describe("the hub's keys", () => {
  it("the document key is the literal every writer DELs", () => {
    expect(publicHubCacheKey(COMP)).toBe(`pub:v1:hub:${COMP}`);
  });

  it("the last-known-good copy lives under a key no writer's `pub:v1:hub:` DEL can hit by accident", () => {
    expect(publicHubStaleCacheKey(COMP).startsWith("pub:v1:hub:")).toBe(false);
    expect(publicHubStaleCacheKey(COMP)).toContain(COMP);
  });
});
