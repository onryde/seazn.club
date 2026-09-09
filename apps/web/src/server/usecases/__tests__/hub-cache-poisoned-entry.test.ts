// Spectator surface W2, Task 4 fix round 2 — a Redis hit is a CAST, not a parse.
//
// `cacheGet<T>` types its return and checks nothing. The hub document is
// written under `pub:v1:hub:{competitionId}` with a 15-second TTL by whatever
// build was serving when it landed, so two ordinary events put a document of
// the wrong shape under a key this build reads as current: a schema change
// deployed mid-rollout, and an older instance still serving behind the same
// Redis. Without a check, that document is handed to the page as if it had
// been validated, and the failure surfaces as a render crash or — worse — a
// section that silently renders empty.
//
// The rule this file pins: a hit that does not parse is treated as a MISS and
// rebuilt, never thrown. A poisoned entry must not be able to take the page
// down for the remainder of its TTL.
import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheGet = vi.hoisted(() => vi.fn(async (key: string) => {
  void key;
  return null as unknown;
}));
const cacheSet = vi.hoisted(() => vi.fn(async () => {}));
const loadCompetitionHub = vi.hoisted(() => vi.fn());
const sql = vi.hoisted(() => vi.fn(async () => [{ id: "comp-1" }]));

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

import { publicCompetitionHub } from "../public";
import { validHubDoc } from "@/server/public-site/__tests__/_hub-doc";

const KEY = "pub:v1:hub:comp-1";

beforeEach(() => {
  vi.clearAllMocks();
  sql.mockResolvedValue([{ id: "comp-1" }]);
  loadCompetitionHub.mockResolvedValue(validHubDoc());
});

describe("publicCompetitionHub — what comes back from Redis is checked", () => {
  it("a valid entry is served from cache, and the loader never runs", async () => {
    // The positive control for the two cases below: without it, a validator
    // that rejected EVERY hit would pass them both while making the cache
    // useless.
    const cached = validHubDoc();
    cacheGet.mockResolvedValue(cached);

    const doc = await publicCompetitionHub("riverside", "autumn-cup");

    expect(doc).toEqual(cached);
    expect(loadCompetitionHub).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("an entry of the WRONG SHAPE is treated as a miss and rebuilt", async () => {
    // The shape an older build would have written: recognisably the hub
    // document, missing a field this build requires.
    const stale = { ...(validHubDoc() as Record<string, unknown>) };
    delete stale.realtime;
    cacheGet.mockResolvedValue(stale);

    const doc = await publicCompetitionHub("riverside", "autumn-cup");

    expect(loadCompetitionHub).toHaveBeenCalledTimes(1);
    expect(doc).not.toEqual(stale);
    expect((doc as { realtime: unknown }).realtime).toBeDefined();
  });

  it("the rebuilt document REPLACES the poisoned entry, so the next read is clean", async () => {
    // Rebuilding without writing back would re-poison on every request for the
    // rest of the TTL: every reader would pay a full rebuild and the bad entry
    // would sit there until it expired.
    cacheGet.mockResolvedValue({ competitionId: "comp-1", tabs: [] });

    await publicCompetitionHub("riverside", "autumn-cup");

    expect(cacheSet).toHaveBeenCalledTimes(1);
    const [key, value, ttl] = cacheSet.mock.calls[0] as unknown as [string, unknown, number];
    expect(key).toBe(KEY);
    expect(ttl).toBe(15);
    expect((value as { realtime: unknown }).realtime).toBeDefined();
  });

  it("a poisoned entry does not throw — the page renders from a rebuild", async () => {
    // `.parse` here would reject the entry by raising, which is the failure
    // this file exists to prevent: one bad write would 500 the public page for
    // fifteen seconds.
    cacheGet.mockResolvedValue("not a document at all");

    await expect(publicCompetitionHub("riverside", "autumn-cup")).resolves.toBeDefined();
  });

  it("an empty cache still loads and stores, as it did before the check", async () => {
    cacheGet.mockResolvedValue(null);

    await publicCompetitionHub("riverside", "autumn-cup");

    expect(loadCompetitionHub).toHaveBeenCalledTimes(1);
    expect(cacheSet).toHaveBeenCalledTimes(1);
  });
});
