// Spectator surface W2, Task 14 — `publicPlayerMatches`, the document the
// public player page polls while it is open (R10).
//
// What this file holds down:
//  1. A spectator who cannot see the PAGE cannot read its lines through the
//     API. The gate is `publicPlayerGate` — the refusal `getPublicPlayer` is
//     itself built on (consent view + the `dashboard.player_profiles`
//     entitlement), never a second copy of either. Its parity with the page
//     over real refusal seeds is proven in
//     `public-site/__tests__/public-player-matches.test.ts` ("GATE: …").
//  2. The lines come from the READER, ONCE per rebuild. Never from
//     `getPublicPlayer`: its `unstable_cache` entry is only
//     stale-while-revalidate on the competition tag (a poll that served it
//     would show the score a write ago), and calling it at all folds every
//     line a second time.
//  3. Redis cache-aside on
//     `pub:v1:player-matches:{competitionId}:{generation}:{personId}`, 15 s,
//     with a hit that does not parse treated as a miss (the hub's rule). The
//     generation is a token read from `pub:v1:player-matches-gen:{competitionId}`
//     and minted when absent, so a writer retires every person's document in
//     the competition with ONE literal DEL of that key — no keyspace SCAN.
//
// Mocked one layer down, the convention `hub-cache-poisoned-entry.test.ts`
// uses: `@/lib/cache` and `@/lib/db` by hand, the two public-site readers by
// module.
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import type { PlayerMatchLine } from "@/server/public-site/public-player-matches";
import type { PlayerMatchLineT } from "@/server/public-site/player-matches-schema";

const store = new Map<string, unknown>();
const cacheGet = vi.hoisted(() => vi.fn(async (key: string): Promise<unknown> => (void key, null)));
const cacheSet = vi.hoisted(() => vi.fn(async (key: string, value: unknown, ttl: number) => void [key, value, ttl]));
const sql = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => [{ id: "comp-1" }]));
const getPublicPlayer = vi.hoisted(() => vi.fn());
const publicPlayerGate = vi.hoisted(() => vi.fn());
const readPlayerMatchLines = vi.hoisted(() => vi.fn());

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
  getPublicPlayer,
  publicPlayerGate,
}));
vi.mock("@/server/public-site/public-player-matches", () => ({ readPlayerMatchLines }));

import { PLAYER_MATCHES_TTL_SECONDS, publicPlayerMatches } from "../public";

const PERSON = "11111111-2222-3333-4444-555555555555";
const GEN_KEY = "pub:v1:player-matches-gen:comp-1";
const keyAt = (generation: string) => `pub:v1:player-matches:comp-1:${generation}:${PERSON}`;
const KEY = keyAt("g1");

const line = (fixtureId: string, figures: string, over: Partial<PlayerMatchLine> = {}): PlayerMatchLine => ({
  fixtureId,
  href: `/shared/riverside/autumn-cup/premier/fixtures/${fixtureId}`,
  divisionName: "Premier",
  divisionSlug: "premier",
  scheduledAt: "2026-09-05T10:00:00.000Z",
  tz: "Europe/London",
  opponentName: "Queens",
  line: figures,
  result: "won",
  ...over,
});

/** What the gate hands a visible player. `default_locale` is Spanish on
 *  purpose: the lines must be built in the ORG's language, and a fixture in
 *  "en" could not tell that from a hardcoded default. */
const visiblePlayer = () => ({
  org: { id: "o1", slug: "riverside", name: "Riverside SC", default_locale: "es" },
  competition: { id: "comp-1", slug: "autumn-cup", name: "Autumn Cup" },
  player: { id: PERSON, name: "Ada Lovelace" },
});

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  sql.mockResolvedValue([{ id: "comp-1" }]);
  cacheGet.mockImplementation(async (key: string) => (store.has(key) ? store.get(key) : null));
  cacheSet.mockImplementation(async (key: string, value: unknown) => {
    store.set(key, value);
  });
  publicPlayerGate.mockResolvedValue(visiblePlayer());
  getPublicPlayer.mockRejectedValue(new Error("the usecase must not read the page"));
  readPlayerMatchLines.mockResolvedValue([line("f2", "54 (40)"), line("f1", "12 (9)")]);
});

describe("publicPlayerMatches — who may read it", () => {
  it("a private or unknown competition is a 404 before the cache is touched", async () => {
    sql.mockResolvedValue([]);
    await expect(publicPlayerMatches("riverside", "secret-cup", PERSON)).rejects.toMatchObject({ status: 404 });
    expect(cacheGet).not.toHaveBeenCalled();
    expect(publicPlayerGate).not.toHaveBeenCalled();
  });

  // Each refusal the page makes reaches this usecase as the gate's null; which
  // seed produced it is the gate's business (proven over real rows in the
  // public-site suite). What this pins is that EVERY null is a 404 that reads
  // and caches nothing, for whatever id the caller sent.
  it.each([
    ["a malformed id", "not-a-uuid"],
    ["nobody (an unknown uuid)", "99999999-8888-7777-6666-555555555555"],
    ["a player who opted out", PERSON],
    ["another org's person", "22222222-3333-4444-5555-666666666666"],
    ["an org without dashboard.player_profiles", PERSON],
  ])("the gate refuses %s → 404, and nothing is read or cached", async (_seed, personId) => {
    publicPlayerGate.mockResolvedValue(null);
    const err = await publicPlayerMatches("riverside", "autumn-cup", personId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect(publicPlayerGate).toHaveBeenCalledWith("riverside", "autumn-cup", personId);
    expect(readPlayerMatchLines).not.toHaveBeenCalled();
    expect(getPublicPlayer).not.toHaveBeenCalled();
    // No DOCUMENT is cached. The generation may be minted first — it has to be
    // taken before the read it keys (see `playerMatchesGeneration`) — and it
    // carries nothing about this person.
    expect(cacheSet.mock.calls.map(([key]) => key).filter((key) => key !== GEN_KEY)).toEqual([]);
  });

  it("a visible person gets their lines, read for THIS competition in the ORG's locale", async () => {
    const doc = await publicPlayerMatches("riverside", "autumn-cup", PERSON);
    expect(doc.matches.map((m) => m.fixtureId)).toEqual(["f2", "f1"]);
    expect(Number.isFinite(Date.parse(doc.generatedAt))).toBe(true);
    expect(readPlayerMatchLines).toHaveBeenCalledWith(sql, {
      personId: PERSON,
      competitionId: "comp-1",
      orgSlug: "riverside",
      compSlug: "autumn-cup",
      locale: "es",
    });
  });
});

describe("publicPlayerMatches — ONE fold per rebuild, never the page's cached copy", () => {
  it("a rebuild reads the lines once, through the reader — the page's reader is never called", async () => {
    // `getPublicPlayer` would fold every line a second time, and hand back an
    // `unstable_cache` entry that is SWR on the competition tag: one read after
    // a score write it still answers the pre-write figures.
    readPlayerMatchLines.mockResolvedValue([line("f2", "54 (40)", { result: "live" })]);

    const doc = await publicPlayerMatches("riverside", "autumn-cup", PERSON);

    expect(doc.matches[0]!.line).toBe("54 (40)");
    expect(publicPlayerGate).toHaveBeenCalledTimes(1);
    expect(readPlayerMatchLines).toHaveBeenCalledTimes(1);
    expect(getPublicPlayer).not.toHaveBeenCalled();
  });
});

describe("publicPlayerMatches — Redis cache-aside", () => {
  it("writes the document under {competition}:{generation}:{person} for 15 s, and a second read skips the rebuild", async () => {
    store.set(GEN_KEY, "g1");
    await publicPlayerMatches("riverside", "autumn-cup", PERSON);
    expect(cacheSet).toHaveBeenCalledTimes(1);
    const [key, , ttl] = cacheSet.mock.calls[0]!;
    expect(key).toBe(KEY);
    expect(ttl).toBe(15);
    expect(PLAYER_MATCHES_TTL_SECONDS).toBe(15);

    await publicPlayerMatches("riverside", "autumn-cup", PERSON);
    expect(readPlayerMatchLines).toHaveBeenCalledTimes(1);
    expect(publicPlayerGate).toHaveBeenCalledTimes(1);
  });

  it("a warm poll costs two GETs — the generation, then the document — and writes nothing", async () => {
    store.set(GEN_KEY, "g1");
    await publicPlayerMatches("riverside", "autumn-cup", PERSON);
    cacheGet.mockClear();
    cacheSet.mockClear();
    await publicPlayerMatches("riverside", "autumn-cup", PERSON);
    expect(cacheGet.mock.calls.map(([key]) => key)).toEqual([GEN_KEY, KEY]);
    expect(cacheSet).not.toHaveBeenCalled();
  });
});

describe("publicPlayerMatches — the generation retires every person's document at once", () => {
  it("no generation yet: one is minted, stored for longer than a document lives, and the next read reuses it", async () => {
    await publicPlayerMatches("riverside", "autumn-cup", PERSON);
    const genWrites = cacheSet.mock.calls.filter(([key]) => key === GEN_KEY);
    expect(genWrites, "the minted generation is stored").toHaveLength(1);
    const [, token, genTtl] = genWrites[0]!;
    expect(typeof token === "string" && token.length > 0, "a non-empty token").toBe(true);
    expect(genTtl, "outlives every document keyed under it").toBeGreaterThan(PLAYER_MATCHES_TTL_SECONDS);
    expect(store.has(keyAt(token as string)), "the document is keyed by that token").toBe(true);

    await publicPlayerMatches("riverside", "autumn-cup", PERSON);
    expect(readPlayerMatchLines).toHaveBeenCalledTimes(1);
    expect(cacheSet.mock.calls.filter(([key]) => key === GEN_KEY), "not minted again").toHaveLength(1);
  });

  it("a writer DELETING the generation key makes the next read MISS, under a new token", async () => {
    await publicPlayerMatches("riverside", "autumn-cup", PERSON);
    const first = store.get(GEN_KEY);
    await publicPlayerMatches("riverside", "autumn-cup", PERSON);
    expect(readPlayerMatchLines, "cached before the delete").toHaveBeenCalledTimes(1);

    store.delete(GEN_KEY);
    await publicPlayerMatches("riverside", "autumn-cup", PERSON);

    expect(readPlayerMatchLines, "rebuilt after the delete").toHaveBeenCalledTimes(2);
    expect(store.get(GEN_KEY)).not.toBe(first);
  });

  it("a valid document under a RETIRED generation is never served", async () => {
    store.set(GEN_KEY, "current");
    store.set(keyAt("retired"), { matches: [line("f9", "99*")], generatedAt: "2026-09-05T12:00:00.000Z" });
    const doc = await publicPlayerMatches("riverside", "autumn-cup", PERSON);
    expect(readPlayerMatchLines).toHaveBeenCalledTimes(1);
    expect(doc.matches.map((m) => m.fixtureId)).toEqual(["f2", "f1"]);
  });
});

describe("publicPlayerMatches — a cached entry's shape", () => {
  it("an entry of the wrong shape is a miss: rebuilt, and replaced", async () => {
    store.set(GEN_KEY, "g1");
    store.set(KEY, { matches: "not a list" });
    const doc = await publicPlayerMatches("riverside", "autumn-cup", PERSON);
    expect(readPlayerMatchLines).toHaveBeenCalledTimes(1);
    expect(doc.matches).toHaveLength(2);
    expect(Array.isArray((store.get(KEY) as { matches: unknown }).matches)).toBe(true);
  });

  it("a valid entry is served as it is (the positive pair for the shape check)", async () => {
    const held = { matches: [line("f9", "99*")], generatedAt: "2026-09-05T12:00:00.000Z" };
    store.set(GEN_KEY, "g1");
    store.set(KEY, held);
    const doc = await publicPlayerMatches("riverside", "autumn-cup", PERSON);
    expect(doc).toEqual(held);
    expect(readPlayerMatchLines).not.toHaveBeenCalled();
  });
});

describe("the wire schema is the reader's own shape", () => {
  it("PlayerMatchLineT (zod, for the spec and the island) equals PlayerMatchLine (the reader)", () => {
    // Compile-time: tsc fails this file when either declaration moves alone.
    expectTypeOf<PlayerMatchLineT>().toEqualTypeOf<PlayerMatchLine>();
  });
});
