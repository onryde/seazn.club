// Public hub perf T2 review (R10): the Redis hub rebuild reads POSTGRES, never
// Next's data cache.
//
// The lease (lib/single-flight-cache.ts) only keeps a pre-write document out of
// `pub:v1:hub:{id}` if the build that fills it reads the database AFTER the
// write. `loadCompetitionHub` reads the competition shell and every division's
// fixtures and standings through `unstable_cache` (`getPublicCompetition`,
// `getPublicDivision`, data.ts), whose tags a score expires only on the machine
// that took the write (when its handler resolves) and on every OTHER machine
// only when `broadcastRevalidate` lands. The hub DEL and the realtime push do
// not wait for that. So a tab whose refetch lands on a peer takes the lease
// after the DEL, builds from the peer's pre-score data cache, fills it — and,
// single-flight, that one document is what every tab is handed for the TTL,
// with a `generatedAt` later than the push, so no client retries.
//
// This file IS that peer: `unstable_cache` is a memoising double that behaves
// like Next's (JSON body on a hit, the raw result on a miss, dropped only by
// its tag), and `revalidateTag` records the tag without dropping anything —
// the write's flush happened on another machine. Everything else is real: the
// usecase, the lease protocol (in-memory, `_fake-lease-cache.ts`), the loader
// and Postgres. The score is written straight to the tables the hub reads, as
// the write on the other machine left them.
//
// The ISR page is the other half: it must KEEP reading through the data cache
// (its own tag flush is what keeps it fresh), so the second describe pins the
// cached path still answering from the cache.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/cache", async (importOriginal) => {
  const { fakeLeaseCache } = await import("@/lib/__tests__/_fake-lease-cache");
  return { ...(await importOriginal<typeof import("@/lib/cache")>()), ...fakeLeaseCache.module() };
});

/** The peer's Next data cache. */
const dataCache = vi.hoisted(() => ({
  entries: new Map<string, { body: string; tags: string[] }>(),
  hits: [] as string[],
  flushedElsewhere: [] as string[],
}));
vi.mock("next/cache", () => ({
  unstable_cache:
    (fn: (...args: unknown[]) => Promise<unknown>, keyParts: string[] = [], options: { tags?: string[] } = {}) =>
    async (...args: unknown[]) => {
      const key = JSON.stringify([keyParts, args]);
      const hit = dataCache.entries.get(key);
      if (hit) {
        dataCache.hits.push(String(keyParts[0]));
        return JSON.parse(hit.body);
      }
      const result = await fn(...args);
      dataCache.entries.set(key, { body: JSON.stringify(result), tags: options.tags ?? [] });
      return result;
    },
  // The write's tag flush reached ANOTHER machine, not this one.
  revalidateTag: vi.fn((tag: string) => {
    dataCache.flushedElsewhere.push(tag);
  }),
  revalidatePath: vi.fn(),
}));
vi.mock("@/server/usecases/player-stats-refresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/player-stats-refresh")>()),
  reconcilePlayerStatsOnRead: vi.fn(),
}));

import { sql } from "@/lib/db";
import { fakeLeaseCache as redis } from "@/lib/__tests__/_fake-lease-cache";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { loadCompetitionHub } from "@/server/public-site/competition-hub";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";
import { getPublicDivision } from "@/server/public-site/data";
import { publicHubCacheKey, publicHubStaleCacheKey } from "@/server/public-site/hub-doc-cache-keys";
import { publicCompetitionHub } from "../public";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

interface Scene {
  orgSlug: string;
  compSlug: string;
  competitionId: string;
  divisionId: string;
  divisionSlug: string;
  stageId: string;
  fixtureId: string;
  entrantIds: string[];
}
let scene: Scene;

async function seed(): Promise<Scene> {
  const suffix = randomUUID().slice(0, 8);
  const orgSlug = `hub-peer-${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Hub Peer " + suffix}, ${orgSlug}) returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Peer Cup " + suffix,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: DIVISION_CONFIG,
  });
  await createEntrants(auth, division.id, [
    { kind: "team", display_name: "Blue Blazers", seed: 1, members: [] },
    { kind: "team", display_name: "Red Rockets", seed: 2, members: [] },
  ]);
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const entrants = await sql<{ id: string }[]>`
    select id from entrants where division_id = ${division.id} order by seed`;
  await sql`
    insert into standings_snapshots (stage_id, pool_id, rows, computed_through_seq)
    values (${stage!.id}, null, ${sql.json(
      entrants.map((e, i) => ({ entrantId: e.id, played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {}, rank: i + 1 })),
    )}, 0)`;
  return {
    orgSlug,
    compSlug: competition.slug,
    competitionId: competition.id,
    divisionId: division.id,
    divisionSlug: division.slug,
    stageId: stage!.id,
    fixtureId: fixtures[0]!.id,
    entrantIds: entrants.map((e) => e.id),
  };
}

/** The score, as the write on the OTHER machine left the database: the match
 *  under way, the table moved, the division active. No tag is expired here. */
async function scoreBehindTheDataCache(s: Scene): Promise<void> {
  const [home, away] = s.entrantIds;
  await sql`update fixtures set status = 'in_play' where id = ${s.fixtureId}`;
  await sql`
    update standings_snapshots
       set rows = ${sql.json([
         { entrantId: home, played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: {}, rank: 1 },
         { entrantId: away, played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: {}, rank: 2 },
       ])},
           computed_through_seq = 1
     where stage_id = ${s.stageId}`;
  await sql`update divisions set status = 'active' where id = ${s.divisionId}`;
}

/** The parts of the document the score moves. */
const scored = (doc: CompetitionHubDocT) => ({
  tables: doc.tables,
  match: doc.matches.find((m) => m.fixtureId === scene.fixtureId)?.bucket,
  divisionStatus: doc.divisions.find((d) => d.id === scene.divisionId)?.status,
});

/** Every tag expired: what a machine whose flush DID land reads. */
async function truth(): Promise<CompetitionHubDocT> {
  dataCache.entries.clear();
  return (await loadCompetitionHub(scene.orgSlug, scene.compSlug))!;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  scene = await seed();
}, 60_000);

beforeEach(() => {
  redis.reset();
  dataCache.entries.clear();
  dataCache.hits.length = 0;
  dataCache.flushedElsewhere.length = 0;
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("the Redis hub rebuild on a machine whose data cache still holds the pre-score division", () => {
  it("after the score and its DEL, the rebuilt hub — and the copy every other tab is handed — shows the score", async () => {
    const before = await publicCompetitionHub(scene.orgSlug, scene.compSlug);
    // This machine's pages have rendered the competition (the ISR path), so
    // its data cache holds the shell and the division: a read through it is a
    // HIT.
    await loadCompetitionHub(scene.orgSlug, scene.compSlug);
    await getPublicDivision(scene.orgSlug, scene.compSlug, scene.divisionSlug);
    expect(dataCache.hits, "premise: this machine holds the division in its data cache").toContain("pub-div-v4");

    await scoreBehindTheDataCache(scene);
    // Premise: the data cache is still serving the pre-score division here.
    const cachedDivision = (await getPublicDivision(scene.orgSlug, scene.compSlug, scene.divisionSlug))!;
    expect(cachedDivision.fixtures.find((f) => f.id === scene.fixtureId)?.status).toBe("scheduled");

    // The writer's DEL, then every open tab's refetch.
    await redis.del(publicHubCacheKey(scene.competitionId));
    const after = await publicCompetitionHub(scene.orgSlug, scene.compSlug);

    const expected = scored(await truth());
    expect(expected, "premise: the score moves the witness").not.toEqual(scored(before));
    expect(scored(after)).toEqual(expected);
    expect(scored(redis.peek(publicHubCacheKey(scene.competitionId)) as CompetitionHubDocT)).toEqual(expected);
    expect(scored(redis.peek(publicHubStaleCacheKey(scene.competitionId)) as CompetitionHubDocT)).toEqual(expected);
  });
});

describe.skipIf(!HAS_DB)("the ISR page path keeps reading through the data cache", () => {
  it("loadCompetitionHub's default path answers the division and the shell from the cache, not Postgres", async () => {
    const bucket = (doc: CompetitionHubDocT) => doc.matches.find((m) => m.fixtureId === scene.fixtureId)?.bucket;
    await sql`update fixtures set status = 'in_play' where id = ${scene.fixtureId}`;
    const warmed = (await loadCompetitionHub(scene.orgSlug, scene.compSlug))!;
    dataCache.hits.length = 0;

    await sql`update fixtures set status = 'scheduled' where id = ${scene.fixtureId}`;
    const again = (await loadCompetitionHub(scene.orgSlug, scene.compSlug))!;

    expect(dataCache.hits).toContain("pub-comp");
    expect(dataCache.hits).toContain("pub-div-v4");
    expect(bucket(again)).toBe(bucket(warmed));
    // …where Postgres now says otherwise, so "the same answer" means "the
    // cached answer".
    expect(bucket(await truth())).not.toBe(bucket(warmed));
  });
});
