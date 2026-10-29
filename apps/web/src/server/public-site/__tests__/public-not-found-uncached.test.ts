// Public pages never cache a NOT-FOUND (owner ruling 2026-10-14).
//
// stg, 2026-10-14: a division created a moment ago 404'd on the public site,
// and the 404 was cached. #954 heals the known writes by expiring the org tag
// in their own request. This file proves the other half, which needs no write
// to cooperate: a public read that finds NOTHING stores nothing, so the very
// next read after the thing appears serves it — with no revalidate at all.
// `next/cache`'s revalidate functions are stubbed to no-ops below, and every
// heal asserts that no tag of the org reached Next's tag manifest, so a heal
// here cannot have come from an expiry.
//
// Through Next's REAL `unstable_cache` and a real `IncrementalCache` over
// `FileSystemCache` (memory only), inside the real async-local storages, in
// the two contexts a public read runs in:
//   - "request": a dynamic render or route handler. A stale entry is served
//     and refreshed in the background.
//   - "isr": an ISR page's static generation. A stale entry's refresh is
//     AWAITED — and if that refresh throws, Next swallows the error and hands
//     back the STALE value (unstable-cache.js). That is why a bare "throw on
//     not-found" is not enough on its own, and the stale tests below exist.
//
// One sport (`generic`) throughout: every read under test finds rows by slug
// or id and none of them branches on the sport key.
import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Next's node environment installs this before any server module loads;
  // without it Next's storages are a fake that throws on `run` (E504).
  const g = globalThis as { AsyncLocalStorage?: unknown };
  g.AsyncLocalStorage ??= process.getBuiltinModule("node:async_hooks").AsyncLocalStorage;
});

const probe = vi.hoisted(() => ({
  /** Tagged-template statements sent to Postgres. */
  statements: 0,
  /** Make the next statement whose text contains `match` reject with `error`. */
  failNext: null as null | { match: string; error: Error },
}));

// No revalidate may take effect in this file: a heal must come from the read.
vi.mock("next/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/cache")>();
  return { ...actual, revalidateTag: vi.fn(), revalidatePath: vi.fn(), updateTag: vi.fn() };
});
vi.mock("@/lib/peer-revalidate", () => ({ broadcastRevalidate: vi.fn(async () => {}) }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const sql = new Proxy(actual.sql, {
    apply(target, thisArg, args: unknown[]) {
      const strings = args[0];
      if (Array.isArray(strings)) {
        probe.statements += 1;
        const failing = probe.failNext;
        if (failing && strings.join("?").includes(failing.match)) {
          probe.failNext = null;
          return Promise.reject(failing.error);
        }
      }
      return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
    },
  });
  return { ...actual, sql };
});

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { workAsyncStorage, type WorkStore } from "next/dist/server/app-render/work-async-storage.external";
import {
  workUnitAsyncStorage,
  type WorkUnitStore,
} from "next/dist/server/app-render/work-unit-async-storage.external";
import { defaultConfig } from "next/dist/server/config-shared";
import { IncrementalCache } from "next/dist/server/lib/incremental-cache";
import FileSystemCache from "next/dist/server/lib/incremental-cache/file-system-cache";
import { tagsManifest } from "next/dist/server/lib/incremental-cache/tags-manifest.external";
import { nodeFs } from "next/dist/server/lib/node-fs-methods";
import type * as TS from "typescript";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  getPublicCompetition,
  getPublicDivision,
  getPublicFixture,
  getPublicOrg,
  readPublicCompetitionShell,
} from "@/server/public-site/data";
// The tag helpers live in the leaf `cache-tags` on this branch (data.ts imports them and no longer re-exports them),
// so the import cycle through revalidate.ts stays cut (usecases/external-play/__tests__/no-import-cycle.test.ts).
import { competitionTag, divisionTag, orgTag } from "@/server/public-site/cache-tags";
import { getPublicCompetitionHub } from "@/server/public-site/competition-hub";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ── The data cache: Next's own, memory only ─────────────────────────────────
const incrementalCache = new IncrementalCache({
  fs: nodeFs,
  dev: false,
  flushToDisk: false,
  minimalMode: false,
  serverDistDir: path.join(os.tmpdir(), `public-not-found-uncached-${randomUUID()}`, "server"),
  requestHeaders: {},
  maxMemoryCacheSize: 50 * 1024 * 1024,
  getPrerenderManifest: () =>
    ({
      version: 4,
      routes: {},
      dynamicRoutes: {},
      notFoundRoutes: [],
      preview: { previewModeId: "t", previewModeSigningKey: "t", previewModeEncryptionKey: "t" },
    }) as unknown as ReturnType<ConstructorParameters<typeof IncrementalCache>[0]["getPrerenderManifest"]>,
  fetchCacheKeyPrefix: "",
  CurCacheHandler: FileSystemCache,
  allowedRevalidateHeaderKeys: [],
});
/** Every data-cache body Next wrote, as the JSON it stored. */
const stored: string[] = [];
const realSet = incrementalCache.set.bind(incrementalCache) as (...args: unknown[]) => Promise<void>;
incrementalCache.set = (async (...args: unknown[]) => {
  const data = args[1] as { kind?: string; data?: { body?: unknown } } | null;
  if (data?.kind === "FETCH" && typeof data.data?.body === "string") stored.push(data.data.body);
  return realSet(...args);
}) as typeof incrementalCache.set;
/** How many stored bodies are a refusal. A not-found reads `null` in every loader below. */
const refusalsStored = () => stored.filter((body) => body === "null").length;

type Kind = "request" | "isr";
const KINDS: Kind[] = ["request", "isr"];

/** One render of `kind`, the way Next runs a page: the read inside both
 *  storages, then every pending cache write and background refresh awaited
 *  (Next awaits `pendingRevalidates` once the render resolves). */
async function render<T>(kind: Kind, read: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/shared/[orgSlug]/[competitionSlug]",
    page: "/shared/[orgSlug]/[competitionSlug]/page",
    incrementalCache,
    isStaticGeneration: kind === "isr",
    isOnDemandRevalidate: false,
    isDraftMode: false,
    nextFetchId: 1,
    cacheLifeProfiles: defaultConfig.cacheLife,
  } as unknown as WorkStore & { pendingRevalidates?: Record<string, Promise<unknown>> };
  const unitStore = (
    kind === "request"
      ? { type: "request", phase: "render", url: { pathname: "/shared/probe", search: "" } }
      : { type: "prerender-legacy", phase: "render", revalidate: 30, tags: null }
  ) as unknown as WorkUnitStore;
  return workAsyncStorage.run(workStore, () =>
    workUnitAsyncStorage.run(unitStore, async () => {
      const out = await read();
      await Promise.all(Object.values(workStore.pendingRevalidates ?? {}));
      return out;
    }),
  );
}

/** Statements one call sends to Postgres. */
async function statementsOf(call: () => Promise<unknown>): Promise<number> {
  const before = probe.statements;
  await call();
  return probe.statements - before;
}

/** Stamp `tags` stale exactly as `revalidateTag(tag, "max")` does (Next's own
 *  `max` profile): stale now, expired a profile's `expire` from now. */
async function staleLikeMax(tags: string[]): Promise<void> {
  await sleep(3);
  await new FileSystemCache({} as ConstructorParameters<typeof FileSystemCache>[0]).revalidateTag(tags, {
    expire: defaultConfig.cacheLife.max!.expire,
  });
  await sleep(3);
}

interface World {
  auth: AuthCtx;
  orgSlug: string;
  compId: string;
  compSlug: string;
  divId: string;
  divSlug: string;
  otherDivSlug: string;
  fixtureId: string;
}

/** A public competition with two divisions; the first has a league of two and its fixture. */
async function world(): Promise<World> {
  const { auth } = await seedOrg("pro");
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Not Found Cup",
    visibility: "public",
    branding: {},
  });
  const div = await createDivision(auth, comp.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const other = await createDivision(auth, comp.id, {
    name: "Other",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    div.id,
    ["Asha Rao", "Bea Lim"].map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, div.id, { seq: 1, kind: "league", name: "League", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  expect(fixtures.length, "premise: the league has a fixture").toBeGreaterThan(0);
  return {
    auth,
    orgSlug,
    compId: comp.id,
    compSlug: comp.slug,
    divId: div.id,
    divSlug: div.slug,
    otherDivSlug: other.slug,
    fixtureId: fixtures[0]!.id,
  };
}

/** The tags a heal could have come from. None may reach the manifest here. */
const expiriesFor = (w: World, extra: string[] = []) =>
  [orgTag(w.orgSlug), competitionTag(w.compId), divisionTag(w.divId), ...extra]
    .map((tag) => [tag, tagsManifest.get(tag)] as const)
    .filter(([, entry]) => entry !== undefined);

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

// Every cached public read that can answer "not found", as the thing going
// missing and then existing — each by a write that fires NO revalidate.
// `served` is read off what the loader returns; `owed` off the write.
const MISSING_THEN_PRESENT: Array<{
  site: string;
  run: (kind: Kind, w: World) => Promise<{ missing: unknown; served: unknown; owed: unknown; extraTags?: string[] }>;
}> = [
  {
    site: "getPublicOrg (pub-org-v2): an org slug, then an org takes it",
    run: async (kind, w) => {
      const slug = `late-org-${randomUUID().slice(0, 8)}`;
      const missing = await render(kind, () => getPublicOrg(slug));
      await sql`update organizations set slug = ${slug} where id = ${w.auth.orgId}`;
      const served = (await render(kind, () => getPublicOrg(slug)))?.org.slug ?? null;
      return { missing, served, owed: slug, extraTags: [orgTag(slug)] };
    },
  },
  {
    site: "getPublicCompetition (pub-comp): a competition slug, then createCompetition takes it",
    run: async (kind, w) => {
      const slug = `late-cup-${randomUUID().slice(0, 8)}`;
      const missing = await render(kind, () => getPublicCompetition(w.orgSlug, slug));
      const comp = await createCompetition(w.auth, { ends_on: "2030-12-31", name: "Late Cup", slug, visibility: "public", branding: {} });
      const served = (await render(kind, () => getPublicCompetition(w.orgSlug, slug)))?.competition.slug ?? null;
      return { missing, served, owed: comp.slug };
    },
  },
  {
    site: "getPublicCompetitionHub (pub-hub-v5): the competition goes private under a cached shell, then public again",
    run: async (kind, w) => {
      await render(kind, () => getPublicCompetition(w.orgSlug, w.compSlug));
      await sql`update competitions set visibility = 'private' where id = ${w.compId}`;
      const missing = await render(kind, () => getPublicCompetitionHub(w.orgSlug, w.compSlug));
      await sql`update competitions set visibility = 'public' where id = ${w.compId}`;
      const served = (await render(kind, () => getPublicCompetitionHub(w.orgSlug, w.compSlug)))?.competitionId ?? null;
      return { missing, served, owed: w.compId };
    },
  },
  {
    site: "getPublicDivision (the cached shell): a division slug, then createDivision takes it",
    run: async (kind, w) => {
      await render(kind, () => getPublicDivision(w.orgSlug, w.compSlug, w.divSlug));
      const name = `Late ${randomUUID().slice(0, 8)}`;
      const slug = name.toLowerCase().replace(/\s+/g, "-");
      const missing = await render(kind, () => getPublicDivision(w.orgSlug, w.compSlug, slug));
      const div = await createDivision(w.auth, w.compId, { name, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
      expect(div.slug, "premise: the division took the slug the probe asked for").toBe(slug);
      const served = (await render(kind, () => getPublicDivision(w.orgSlug, w.compSlug, slug)))?.division.slug ?? null;
      return { missing, served, owed: div.slug, extraTags: [divisionTag(div.id)] };
    },
  },
  {
    site: "getPublicFixture (pub-fixture-v10): a fixture asked for under ANOTHER division's URL, then under its own",
    run: async (kind, w) => {
      const missing = await render(kind, () => getPublicFixture(w.orgSlug, w.compSlug, w.otherDivSlug, w.fixtureId));
      const served = (await render(kind, () => getPublicFixture(w.orgSlug, w.compSlug, w.divSlug, w.fixtureId)))?.fixture.id ?? null;
      return { missing, served, owed: w.fixtureId };
    },
  },
];

describe.skipIf(!HAS_DB)("a public read that finds nothing stores nothing: the next read serves what appears, with no revalidate", () => {
  const covered: string[] = [];

  for (const kind of KINDS) {
    for (const s of MISSING_THEN_PRESENT) {
      it(`${kind}: ${s.site}`, async () => {
        const w = await world();
        const refusalsBefore = refusalsStored();
        const { missing, served, owed, extraTags = [] } = await s.run(kind, w);
        expect(missing, "premise: the read refuses while it is missing").toBeNull();
        expect(refusalsStored() - refusalsBefore, "refusals stored by the data cache").toBe(0);
        expect(expiriesFor(w, extraTags), "tag expiries that could have healed it (must be none)").toEqual([]);
        expect(served, "the very next read").toBe(owed);
        covered.push(`${kind}: ${s.site}`);
      });
    }
  }

  it("the sweep reached every site in both render contexts (zero is a failure)", () => {
    expect(covered.length).toBeGreaterThan(0);
    expect(covered).toEqual(KINDS.flatMap((kind) => MISSING_THEN_PRESENT.map((s) => `${kind}: ${s.site}`)));
    expect(covered).toHaveLength(10);
  });
});

describe.skipIf(!HAS_DB)("the read that heals a refusal loads once, and caches what it found", () => {
  for (const kind of KINDS) {
    it(`${kind}: a competition created after a refused read costs one shell load to serve, then none`, async () => {
      const w = await world();
      const slug = `once-cup-${randomUUID().slice(0, 8)}`;
      expect(await render(kind, () => getPublicCompetition(w.orgSlug, slug)), "premise: refused").toBeNull();
      await createCompetition(w.auth, { ends_on: "2030-12-31", name: "Once Cup", slug, visibility: "public", branding: {} });
      // One load of the shell, measured off the loader itself rather than typed here.
      const oneLoad = await statementsOf(() => readPublicCompetitionShell(w.orgSlug, slug));
      let served: string | null = null;
      const heal = await statementsOf(async () => {
        served = (await render(kind, () => getPublicCompetition(w.orgSlug, slug)))?.competition.slug ?? null;
      });
      const next = await statementsOf(() => render(kind, () => getPublicCompetition(w.orgSlug, slug)));
      expect(oneLoad, "premise: a shell load reaches Postgres").toBeGreaterThan(0);
      expect({ served, heal, next }).toEqual({ served: slug, heal: oneLoad, next: 0 });
    });
  }
});

describe.skipIf(!HAS_DB)("a FOUND answer is still cached exactly as before", () => {
  const READS: Array<{ site: string; read: (w: World) => Promise<unknown> }> = [
    { site: "getPublicOrg", read: (w) => getPublicOrg(w.orgSlug) },
    { site: "getPublicCompetition", read: (w) => getPublicCompetition(w.orgSlug, w.compSlug) },
    { site: "getPublicDivision", read: (w) => getPublicDivision(w.orgSlug, w.compSlug, w.divSlug) },
    { site: "getPublicFixture", read: (w) => getPublicFixture(w.orgSlug, w.compSlug, w.divSlug, w.fixtureId) },
    // Last: the hub's own build reads the division details through their cache.
    { site: "getPublicCompetitionHub", read: (w) => getPublicCompetitionHub(w.orgSlug, w.compSlug) },
  ];

  for (const kind of KINDS) {
    it(`${kind}: the second read of each found page makes no database read`, async () => {
      const w = await world();
      const checked: Array<{ site: string; found: boolean; first: number; second: number }> = [];
      for (const r of READS) {
        let found = false;
        const first = await statementsOf(async () => {
          found = (await render(kind, () => r.read(w))) !== null;
        });
        const second = await statementsOf(() => render(kind, () => r.read(w)));
        checked.push({ site: r.site, found, first, second });
      }
      expect(checked.length, "reads checked (zero is a failure)").toBe(READS.length);
      expect(checked.map((c) => [c.site, c.found, c.first > 0, c.second])).toEqual(
        READS.map((r) => [r.site, true, true, 0]),
      );
    });
  }
});

describe.skipIf(!HAS_DB)("a database error is neither cached nor turned into a not-found", () => {
  const FAILS: Array<{ site: string; match: string; read: (w: World) => Promise<unknown> }> = [
    { site: "getPublicOrg", match: "from organizations o where o.slug =", read: (w) => getPublicOrg(w.orgSlug) },
    { site: "getPublicCompetition", match: "from public_competitions_v", read: (w) => getPublicCompetition(w.orgSlug, w.compSlug) },
    {
      site: "getPublicFixture",
      match: "from public_fixtures_v v",
      read: (w) => getPublicFixture(w.orgSlug, w.compSlug, w.divSlug, w.fixtureId),
    },
  ];

  for (const kind of KINDS) {
    it(`${kind}: the failing read rejects with the database's error, and the next read reaches Postgres and serves`, async () => {
      const w = await world();
      const checked: Array<{ site: string; rejected: string; nextReads: boolean; nextServes: boolean }> = [];
      for (const f of FAILS) {
        const error = new Error(`simulated outage in ${f.site}`);
        probe.failNext = { match: f.match, error };
        const rejected = await render(kind, () => f.read(w)).then(
          (value) => `resolved ${JSON.stringify(value === null ? null : "a value")}`,
          (e: unknown) => (e === error ? "the database's error" : String(e)),
        );
        expect(probe.failNext, `premise: ${f.site} sent the failing statement`).toBeNull();
        let nextServes = false;
        const nextReads = await statementsOf(async () => {
          nextServes = (await render(kind, () => f.read(w))) !== null;
        });
        checked.push({ site: f.site, rejected, nextReads: nextReads > 0, nextServes });
      }
      expect(checked.length, "reads checked (zero is a failure)").toBe(FAILS.length);
      expect(checked).toEqual(FAILS.map((f) => ({ site: f.site, rejected: "the database's error", nextReads: true, nextServes: true })));
    });
  }
});

describe.skipIf(!HAS_DB)("found → missing under a STALE entry: refused, never served from the stale entry, and served again when it returns", () => {
  it("isr: a competition gone private under a stale shell is refused at once, and served at once when public again", async () => {
    const w = await world();
    const refusalsBefore = refusalsStored();
    expect(await render("isr", () => getPublicCompetition(w.orgSlug, w.compSlug)), "premise: cached found").not.toBeNull();
    await sql`update competitions set visibility = 'private' where id = ${w.compId}`;
    await staleLikeMax([orgTag(w.orgSlug)]);

    const gone = await render("isr", () => getPublicCompetition(w.orgSlug, w.compSlug));
    await sql`update competitions set visibility = 'public' where id = ${w.compId}`;
    const back = await render("isr", () => getPublicCompetition(w.orgSlug, w.compSlug));

    expect(gone, "an ISR render after the refresh found it gone").toBeNull();
    expect(back?.competition.id, "the next ISR render once it is public again").toBe(w.compId);
    expect(refusalsStored() - refusalsBefore, "refusals stored").toBe(0);
  });

  it("request: Next serves the stale entry once while it refreshes in the background; every read after is refused", async () => {
    const w = await world();
    const refusalsBefore = refusalsStored();
    expect(await render("request", () => getPublicCompetition(w.orgSlug, w.compSlug)), "premise: cached found").not.toBeNull();
    await sql`update competitions set visibility = 'private' where id = ${w.compId}`;
    await staleLikeMax([orgTag(w.orgSlug)]);

    const whileRefreshing = await render("request", () => getPublicCompetition(w.orgSlug, w.compSlug));
    const after = [];
    for (let i = 0; i < 3; i++) after.push(await render("request", () => getPublicCompetition(w.orgSlug, w.compSlug)));

    expect(whileRefreshing?.competition.id, "premise: Next's own stale-while-revalidate serve").toBe(w.compId);
    expect(after.length, "reads checked").toBe(3);
    expect(after, "every read once the refresh found it gone").toEqual([null, null, null]);
    expect(refusalsStored() - refusalsBefore, "refusals stored").toBe(0);
  });

  for (const kind of KINDS) {
    it(`${kind}: a deleted fixture under a division tag fired 'max' (the product's own delete path) is refused`, async () => {
      const w = await world();
      const refusalsBefore = refusalsStored();
      const read = () => getPublicFixture(w.orgSlug, w.compSlug, w.divSlug, w.fixtureId);
      expect((await render(kind, read))?.fixture.id, "premise: cached found").toBe(w.fixtureId);
      await sql`delete from fixtures where id = ${w.fixtureId}`;
      await staleLikeMax([divisionTag(w.divId)]);

      const reads = [];
      for (let i = 0; i < 3; i++) reads.push((await render(kind, read))?.fixture.id ?? null);

      // A dynamic render serves the stale entry once while it refreshes (Next's
      // stale-while-revalidate, unchanged); an ISR render awaits the refresh.
      const owed = kind === "request" ? [w.fixtureId, null, null] : [null, null, null];
      expect(reads, "three reads after the delete").toEqual(owed);
      expect(refusalsStored() - refusalsBefore, "refusals stored").toBe(0);
    });
  }
});

// Every `unstable_cache` call under src/, and every call routed through the
// not-found guard, by its cache key. A new cached read must be classified here:
// routed through `cachedIfFound`, or direct with the reason it can never answer
// "not found". Parsed with the TypeScript compiler, not a regex: a key array
// can sit 200 lines below its `unstable_cache(`.
// `typescript` through require, not import: vite's import analysis chokes on its CJS bundle.
const ts: typeof TS = createRequire(import.meta.url)("typescript");
const SRC = new URL("../../../", import.meta.url).pathname; // apps/web/src/

const CACHE_SITES: Record<string, { via: "cachedIfFound" | "unstable_cache"; file: string; why: string }> = {
  "pub-org-v2": { via: "cachedIfFound", file: "server/public-site/data.ts", why: "an org slug may not exist" },
  "pub-comp": { via: "cachedIfFound", file: "server/public-site/data.ts", why: "a competition slug may not exist or be private" },
  "pub-fixture-v10": { via: "cachedIfFound", file: "server/public-site/data.ts", why: "a fixture id may not exist in this division" },
  "pub-hub-v5": { via: "cachedIfFound", file: "server/public-site/competition-hub.ts", why: "the hub refuses when its shell does" },
  "<keyParts>": { via: "unstable_cache", file: "server/public-site/cache-found.ts", why: "the guard itself: throws instead of storing a miss" },
  "pub-div-v5": { via: "unstable_cache", file: "server/public-site/data.ts", why: "the detail of a division already found; never null" },
  "pub-player-gate-tag": { via: "unstable_cache", file: "server/public-site/data.ts", why: "stores `true` — holds tags, never an answer" },
  "pub-player-v17": { via: "unstable_cache", file: "server/public-site/data.ts", why: "behind publicPlayerGate, read uncached; never null" },
  "pub-player-figures-v2": {
    via: "unstable_cache",
    file: "server/public-site/public-player-matches.ts",
    why: "null = no figures for a fixture already found; the key moves with last_seq",
  },
  SITEMAP_ENTRIES_CACHE_KEY: { via: "unstable_cache", file: "server/public-site/sitemap-cache.ts", why: "a list; empty is a real state" },
  "discovery-live": { via: "unstable_cache", file: "server/public-site/discovery.ts", why: "a list; empty is a real state" },
  "discovery-live-all": { via: "unstable_cache", file: "server/public-site/discovery.ts", why: "a list; empty is a real state" },
  "discovery-week": { via: "unstable_cache", file: "server/public-site/discovery.ts", why: "a list; empty is a real state" },
  "discovery-dir": { via: "unstable_cache", file: "server/public-site/discovery.ts", why: "a list; empty is a real state" },
  "discovery-sports": { via: "unstable_cache", file: "server/public-site/discovery.ts", why: "a list; empty is a real state" },
  "overlay-fold-v4": {
    via: "unstable_cache",
    file: "server/overlay/load.ts",
    why: "folded after the fixture is found, keyed on its last_seq; a null fold = no events yet",
  },
  "overlay-fold-relay-v4": {
    via: "unstable_cache",
    file: "server/overlay/load.ts",
    why: "R2005: the relay door's own fold namespace, behind relayPageAccess; the same never-null fold as overlay-fold-v4",
  },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("every cached read under src/ is classified: routed through the not-found guard, or a reason it never refuses", () => {
  it("each call's cache key is in the ledger with its route, and every ledger row was found (zero is a failure)", () => {
    const found: Array<{ key: string; via: string; file: string }> = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("unstable_cache(") && !text.includes("cachedIfFound(")) continue;
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: TS.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const via = node.expression.text;
          if (via === "unstable_cache" || via === "cachedIfFound") {
            const keyArg = node.arguments[1];
            const key =
              keyArg && ts.isArrayLiteralExpression(keyArg) && keyArg.elements[0] && ts.isStringLiteral(keyArg.elements[0])
                ? keyArg.elements[0].text
                : keyArg && ts.isIdentifier(keyArg)
                  ? keyArg.text === "keyParts"
                    ? "<keyParts>"
                    : keyArg.text
                  : `<unreadable at ${path.relative(SRC, file)}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}>`;
            found.push({ key, via, file: path.relative(SRC, file) });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(found.length, "cached reads found (zero is a failure)").toBeGreaterThan(0);
    const byKey = (rows: Array<{ key: string; via: string; file: string }>) =>
      [...rows].sort((a, b) => a.key.localeCompare(b.key));
    expect(byKey(found)).toEqual(
      byKey(Object.entries(CACHE_SITES).map(([key, { via, file }]) => ({ key, via, file }))),
    );
    expect(found).toHaveLength(17);
  });
});
