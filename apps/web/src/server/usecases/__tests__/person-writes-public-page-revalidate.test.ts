// Spectator W2, Task 14 regression (e2e `player-accounts.spec.ts` "consent
// flip") — a person write reaches every cached page AND every cached data entry
// that shows that person, whichever way it turns their card and at whichever
// competition URL it is cached, and reaches nothing else.
//
// Three things are proven here through Next's real per-request flush and tag
// manifest:
//  - WHAT A CARD RENDER CARRIES. A refused card is cached too (the page's
//    `notFound()`). Task 14 moved the consent read out of the tagged card read
//    into `publicPlayerGate`, which runs first, so the gate itself must put the
//    competition tag and the PERSON tag on the render.
//  - WHAT A PERSON WRITE FIRES (`firePersonRevalidate`, awaited in the
//    request): the person's tag, and the division and competition tags of every
//    division they are rostered in. Never the org tag.
//  - THAT THE NAME IS GONE FROM THE DATA, not just the pages. Next checks a
//    data entry (`unstable_cache`) against its OWN tags only, so an expired page
//    that rebuilds from an unexpired `pub-div`, `pub-fixture` or
//    `pub-player-v17` entry bakes the revoked name back in. Firing the org tag
//    alone did exactly that.
//
// The `unstable_cache` double below behaves as Next's does for these reads
// (`incremental-cache/index.js`, the FETCH-entry branch; `unstable-cache.js`):
//  - it adds a top-level call's tags to the render in progress, hit or miss,
//    before reading — so a render's recorded tags are its page entry's;
//  - a call NESTED inside another cached call adds no tags and skips the cache
//    read, running its function directly — but still stores its result;
//  - it caches by key parts and arguments;
//  - an entry whose own tags have EXPIRED is a miss; one whose own tags are
//    STALE is served and refreshed in the background. This double serves it
//    for a single read and then refreshes; a real build keeps serving it until
//    the rebuild lands — measured after a consent OFF at 2.8–4.3s, 2–3 loads,
//    in a local prod build (`firePersonRevalidate`'s doc).
// Timers are ignored: every test runs well inside each entry's revalidate window.
//
// The write side is Next's own code, as in `score-revalidate-in-request.test.ts`:
// the real async-local storages, the real `revalidateTag`, the real
// `executeRevalidates` flush the moment the handler resolves, and the real tag
// manifest. Whether each writer AWAITS the step is witnessed without timing:
// the step hands back a thenable whose `then` only an `await` calls.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Next's node environment installs this before any server module loads;
  // without it Next's storages are a fake that throws on `run` (E504).
  const g = globalThis as { AsyncLocalStorage?: unknown };
  g.AsyncLocalStorage ??= process.getBuiltinModule("node:async_hooks").AsyncLocalStorage;
});

const probe = vi.hoisted(() => ({
  /** The render in progress's accumulated tags; null outside a render. */
  renderTags: null as string[] | null,
  /** The data cache: key → the value as JSON, its own tags, when it was stored. */
  entries: new Map<string, { json: string; tags: string[]; cachedAt: number }>(),
  /** Background refreshes of stale entries, still running. */
  refreshing: [] as Promise<unknown>[],
  redis: new Map<string, unknown>(),
  /** One record per `firePersonRevalidate` call: did the caller `await` it? */
  fires: [] as Array<{ awaited: boolean }>,
  /** Make the roster read inside `firePersonRevalidate` reject. */
  failRosterRead: false,
  /** Every peer broadcast the request sent: its tags and its mode. */
  broadcasts: [] as Array<{ tags: string[]; mode: "swr" | "expire" }>,
}));

vi.mock("next/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/cache")>();
  const { areTagsExpired, areTagsStale } = await import(
    "next/dist/server/lib/incremental-cache/tags-manifest.external"
  );
  // Next marks a cached function's own run with an `unstable-cache` work-unit
  // store; a call made inside it is NESTED: it adds no tags to the page and
  // skips the cache read, but still writes its result (unstable-cache.js,
  // `isNestedUnstableCache`, then `cacheNewResult`).
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const running = new AsyncLocalStorage<true>();
  return {
    ...actual,
    unstable_cache:
      <A extends unknown[], R>(fn: (...args: A) => Promise<R>, keyParts?: string[], options?: { tags?: string[] }) =>
      async (...args: A): Promise<R> => {
        const tags = options?.tags ?? [];
        const key = JSON.stringify([keyParts ?? [], args]);
        const store = (value: R) =>
          probe.entries.set(key, { json: JSON.stringify(value), tags, cachedAt: Date.now() });
        const run = () => running.run(true, () => fn(...args));
        if (running.getStore()) {
          const value = await run();
          store(value);
          return value;
        }
        if (probe.renderTags) {
          for (const tag of tags) if (!probe.renderTags.includes(tag)) probe.renderTags.push(tag);
        }
        const hit = probe.entries.get(key);
        if (hit && !areTagsExpired(hit.tags, hit.cachedAt)) {
          if (areTagsStale(hit.tags, hit.cachedAt)) probe.refreshing.push(run().then(store));
          return JSON.parse(hit.json) as R;
        }
        const value = await run();
        store(value);
        return value;
      },
  };
});
vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheGet: async (key: string) => (probe.redis.has(key) ? probe.redis.get(key) : null),
  cacheSet: async (key: string, value: unknown) => {
    probe.redis.set(key, value);
  },
  cacheDel: (...keys: string[]) => {
    for (const key of keys) probe.redis.delete(key);
    return Promise.resolve();
  },
  // A SCAN sweep of `prefix*`, over the in-memory keys (final review I2).
  cacheDelPattern: async (pattern: string) => {
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
    for (const key of [...probe.redis.keys()]) {
      if (pattern.endsWith("*") ? key.startsWith(prefix) : key === pattern) probe.redis.delete(key);
    }
  },
}));
// The pooled `sql`, with ONE query made to fail on request: the roster read in
// `firePersonRevalidate`. Every other query passes through untouched.
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const sql = new Proxy(actual.sql, {
    apply(target, thisArg, args: unknown[]) {
      const strings = args[0];
      if (
        probe.failRosterRead &&
        Array.isArray(strings) &&
        strings.join("?").includes("select distinct e.division_id, d.competition_id")
      ) {
        return Promise.reject(new Error("simulated roster read failure"));
      }
      return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
    },
  });
  return { ...actual, sql };
});
vi.mock("@/server/public-site/revalidate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/public-site/revalidate")>();
  return {
    ...actual,
    firePersonRevalidate: (...args: Parameters<typeof actual.firePersonRevalidate>) => {
      const record = { awaited: false };
      probe.fires.push(record);
      const real = actual.firePersonRevalidate(...args);
      // A thenable, not a Promise: `await` calls `then`, `void` never does.
      return {
        then: (onFulfilled?: (value: void) => unknown, onRejected?: (reason: unknown) => unknown) => {
          record.awaited = true;
          return real.then(onFulfilled, onRejected);
        },
      };
    },
  };
});
vi.mock("@/lib/peer-revalidate", () => ({
  broadcastRevalidate: async (tags: string[], mode: "swr" | "expire") => {
    probe.broadcasts.push({ tags: [...tags], mode });
  },
}));
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: () => ({
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  }),
}));
vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://cdn.example");
const logMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
}));
vi.mock("@/server/logger", () => ({ log: logMock }));

import { EventEmitter } from "node:events";
import { unstable_cache } from "next/cache";
import { AfterContext } from "next/dist/server/after/after-context";
import { workAsyncStorage, type WorkStore } from "next/dist/server/app-render/work-async-storage.external";
import {
  workUnitAsyncStorage,
  type RequestStore,
} from "next/dist/server/app-render/work-unit-async-storage.external";
import { executeRevalidates } from "next/dist/server/revalidation-utils";
import { defaultConfig } from "next/dist/server/config-shared";
import FileSystemCache from "next/dist/server/lib/incremental-cache/file-system-cache";
import {
  areTagsExpired,
  areTagsStale,
} from "next/dist/server/lib/incremental-cache/tags-manifest.external";
import { sql } from "@/lib/db";
import { maskDisplayName } from "@/lib/name-display";
import {
  competitionTag,
  divisionTag,
  getPublicDivision,
  getPublicFixture,
  getPublicPlayer,
  NEXT_CACHE_TAG_MAX_ITEMS,
  orgTag,
  personTag,
  playerCardTags,
} from "@/server/public-site/data";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { setMyConsent, setMyPersonPhoto } from "../me";
import { createPerson, patchPerson, setPersonPhoto } from "../persons";
import { mergePersons, reverseMerge } from "../person-merge";
import { scoreEvent } from "../scoring";
import { endSql, scene, type Scene } from "./_player-matches-writes-scene";

const HAS_DB = !!process.env.DATABASE_URL;
const FIRE_FAILED =
  "public pages: a person's rosters could not be read to revalidate the pages naming them (the write stands)";
const PLAYER_CARD_TAGS_CAPPED =
  "player card: the competition has more divisions than one cache entry can carry tags for; a score in a dropped division serves this card stale once";
const PNG = { contentType: "image/png", bytes: Buffer.from("png-bytes") };
const DIVISION_CONFIG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One route-handler request, in the order app-route/module.js runs it: the
 *  handler inside both storages, then ONE flush as soon as it resolves. Reports
 *  the tags the flush handed the cache (sorted, deduped), and whether each
 *  `firePersonRevalidate` call had been awaited by the time the handler
 *  resolved. Sleeps either side, so every entry cached before it is strictly
 *  older than the flush and every entry cached after it strictly newer. */
async function inRequest<T>(
  handler: () => Promise<T>,
  /** Runs after the handler has resolved and before its flush: a poll landing
   *  in the gap between a write's mid-request Redis drop and its tag expiry. */
  gap?: () => void,
): Promise<{ result: T; tags: string[]; fires: boolean[] }> {
  await sleep(3);
  const tags: string[] = [];
  const fsCache = new FileSystemCache({} as ConstructorParameters<typeof FileSystemCache>[0]);
  // The after-window, as Next runs it (`player-stats-refresh-after.test.ts`):
  // `after()` callbacks run only once the response's `close` fires, AFTER the
  // request's flush.
  const res = new EventEmitter();
  const waitingOn: Array<Promise<unknown>> = [];
  const afterContext = new AfterContext({
    waitUntil: (promise: Promise<unknown>) => {
      waitingOn.push(promise);
    },
    onClose: (listener: () => void) => {
      res.once("close", listener);
    },
    onTaskError: undefined,
  });
  const workStore = {
    route: "/api/v1/persons/[id]",
    page: "/api/v1/persons/[id]/route",
    incrementalCache: {
      revalidateTag: (fired: string | string[], durations?: { expire?: number }) => {
        const list = typeof fired === "string" ? [fired] : [...fired];
        tags.push(...list);
        return fsCache.revalidateTag(list, durations);
      },
    },
    cacheLifeProfiles: defaultConfig.cacheLife,
    afterContext,
  } as unknown as WorkStore;
  const requestStore = { type: "request", phase: "action" } as unknown as RequestStore;
  probe.fires = [];
  probe.broadcasts = [];
  const out = await workAsyncStorage.run(workStore, async () => {
    const result = await workUnitAsyncStorage.run(requestStore, handler);
    const fires = probe.fires.map((f) => f.awaited);
    gap?.();
    const flush = executeRevalidates(workStore);
    if (flush !== false) await flush;
    return { result, tags: [...new Set(tags)].sort(), fires };
  });
  res.emit("close");
  await Promise.all(waitingOn);
  await sleep(3);
  return out;
}

type PageEntry<T> = { result: T; tags: string[]; cachedAt: number };

/** Render a card and return the tags its cached PAGE entry would carry, with
 *  the instant it was cached. */
async function render<T>(read: () => Promise<T>): Promise<PageEntry<T>> {
  probe.renderTags = [];
  try {
    const result = await read();
    return { result, tags: probe.renderTags, cachedAt: Date.now() };
  } finally {
    probe.renderTags = null;
  }
}

const expired = (entry: { tags: string[]; cachedAt: number }) => areTagsExpired(entry.tags, entry.cachedAt);
const untouched = (entry: { tags: string[]; cachedAt: number }) =>
  !areTagsExpired(entry.tags, entry.cachedAt) && !areTagsStale(entry.tags, entry.cachedAt);

/** A stored DATA entry, by the key parts its `unstable_cache` call declares. */
function dataEntry(...keyParts: string[]) {
  const entry = probe.entries.get(JSON.stringify([keyParts, []]));
  expect(entry, `premise: the ${keyParts[0]} entry is cached`).toBeDefined();
  return entry!;
}

/** Let every stale entry's background refresh land, as the next rebuild would. */
async function refreshed(): Promise<void> {
  while (probe.refreshing.length > 0) await Promise.all(probe.refreshing.splice(0));
}

const card = (s: Scene, personId: string, compSlug = s.competition.slug) =>
  getPublicPlayer(s.orgSlug, compSlug, personId);

/** The tags a write about ONE person rostered in the scene's one division fires. */
const sceneTags = (s: Scene, personId: string) =>
  [personTag(personId), divisionTag(s.division.id), competitionTag(s.competition.id)].sort();

/** Every place the scene's cached DATA shows Ben's name to the public. */
async function benAsShown(s: Scene) {
  const division = await getPublicDivision(s.orgSlug, s.competition.slug, s.division.slug);
  const fixture = await getPublicFixture(s.orgSlug, s.competition.slug, s.division.slug, s.fixture.id);
  const adasCard = await card(s, s.ada.id);
  return {
    division: division!.entrants.map((e) => e.display_name).filter((name) => name.startsWith("Ben")),
    fixture: Object.values(fixture!.entrantNames).filter((name) => name.startsWith("Ben")),
    adasOpponent: adasCard!.matches.map((m) => m.opponentName),
  };
}

async function publicCompetition(s: Scene, name: string) {
  return createCompetition(s.owner, {
    ends_on: "2030-12-31",
    name: `${name} ${s.orgSlug}`,
    visibility: "public",
    branding: {},
  });
}

async function rosterIn(s: Scene, competitionId: string, personId: string, name: string) {
  const division = await createDivision(s.owner, competitionId, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: DIVISION_CONFIG,
  });
  await createEntrants(s.owner, division.id, [
    {
      kind: "individual" as const,
      display_name: name,
      seed: 1,
      members: [{ person_id: personId, squad_number: null, default_position_key: null, is_captain: false, roles: [] }],
    },
  ]);
  return division;
}

afterEach(() => {
  probe.renderTags = null;
  probe.entries.clear();
  probe.refreshing = [];
  probe.redis.clear();
  probe.fires = [];
  probe.failRosterRead = false;
  for (const fn of Object.values(logMock)) fn.mockClear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  await endSql();
});

describe("harness control — Next's real flush and tag manifest", () => {
  it("a tag fired inside the request makes an entry cached before it stale; an entry without that tag is untouched", async () => {
    const entry = { tags: [competitionTag("ctl-comp"), orgTag("ctl-org")], cachedAt: Date.now() };
    const other = { tags: [orgTag("ctl-org")], cachedAt: entry.cachedAt };

    const { tags } = await inRequest(async () => fireDivisionRevalidate("ctl-div", "ctl-comp"));

    expect(tags).toEqual([competitionTag("ctl-comp"), divisionTag("ctl-div")]);
    expect(areTagsStale(entry.tags, entry.cachedAt)).toBe(true);
    expect(untouched(other)).toBe(true);
  });

  it("a cached call NESTED inside another adds no tags to the render and skips the cache READ, but still WRITES its result; at top level it adds its tags and reads (as unstable-cache.js)", async () => {
    let innerRuns = 0;
    const inner = unstable_cache(async () => `inner-${++innerRuns}`, ["ctl-inner"], { tags: ["ctl:inner"] });
    const outer = unstable_cache(async () => inner(), ["ctl-outer"], { tags: ["ctl:outer"] });
    const innerKey = JSON.stringify([["ctl-inner"], []]);
    probe.entries.set(innerKey, { json: JSON.stringify("seeded"), tags: ["ctl:inner"], cachedAt: Date.now() });

    const nested = await render(() => outer());
    expect(nested.tags, "no nested tags on the page").toEqual(["ctl:outer"]);
    expect(nested.result, "the nested call ran instead of reading the fresh seeded entry").toBe("inner-1");
    expect(JSON.parse(probe.entries.get(innerKey)!.json), "and wrote its result").toBe("inner-1");

    const top = await render(() => inner());
    expect(top.tags).toEqual(["ctl:inner"]);
    expect(top.result, "a top-level call reads what the nested run wrote").toBe("inner-1");
    expect(innerRuns).toBe(1);
  });
});

describe.skipIf(!HAS_DB)("a person write reaches every cached page and data entry showing that person, and nothing else (Task 14 regression)", () => {
  it("a REFUSED card's render carries its competition and PERSON tags; the player's own consent ON fires exactly the person's, division's and competition's tags (never the org's) and expires it; the allowed card carries them too", async () => {
    const s = await scene("card-own-on");
    await sql`update persons set consent = ${sql.json({ public_name: false })}, user_id = ${s.ownerId} where id = ${s.ben.id}`;

    const refused = await render(() => card(s, s.ben.id));
    expect(refused.result, "premise: the card is refused").toBeNull();
    expect(refused.tags).toEqual(expect.arrayContaining([competitionTag(s.competition.id), personTag(s.ben.id)]));

    const { tags, fires } = await inRequest(() => setMyConsent(s.ownerId, s.ben.id, { public_name: true }));
    expect(tags).toEqual(sceneTags(s, s.ben.id));
    expect(tags).not.toContain(orgTag(s.orgSlug));
    expect(fires).toEqual([true]);
    expect(expired(refused), "the cached 404 is expired").toBe(true);

    const allowed = await render(() => card(s, s.ben.id));
    expect(allowed.result, "premise: the card is served").not.toBeNull();
    expect(allowed.tags).toEqual(expect.arrayContaining([competitionTag(s.competition.id), personTag(s.ben.id)]));
  }, 120_000);

  it("a refusal before any competition is known (unknown competition) carries no competition or person tag", async () => {
    const s = await scene("card-unknown");
    const refused = await render(() => card(s, s.ben.id, `${s.competition.slug}-missing`));
    expect(refused.result).toBeNull();
    expect(refused.tags.filter((tag) => tag.startsWith("competition:") || tag.startsWith("pub-person:"))).toEqual([]);
  }, 120_000);

  it("the ENTITLEMENT refusal (player profiles off) carries the competition and person tags too", async () => {
    const s = await scene("card-ent-off");
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${s.orgId}, 'dashboard.player_profiles', false, 'test')
      on conflict (org_id, feature_key) do update set bool_value = false`;
    probe.redis.clear(); // the in-memory Redis holds the org's resolved entitlements

    const refused = await render(() => card(s, s.ben.id));
    expect(refused.result, "premise: consented, rostered, and refused by the entitlement alone").toBeNull();
    expect(refused.tags).toEqual(expect.arrayContaining([competitionTag(s.competition.id), personTag(s.ben.id)]));
  }, 120_000);

  it("the ORGANISER turning consent ON (patchPerson) fires the person's tags in the request, and the cached 404 expires", async () => {
    const s = await scene("card-org-on");
    await sql`update persons set consent = ${sql.json({ public_name: false })} where id = ${s.ben.id}`;
    const refused = await render(() => card(s, s.ben.id));
    expect(refused.result, "premise: the card is refused").toBeNull();

    const { tags, fires } = await inRequest(() => patchPerson(s.owner, s.ben.id, { consent: { public_name: true } }));

    expect(tags).toEqual(sceneTags(s, s.ben.id));
    expect(fires).toEqual([true]);
    expect(expired(refused)).toBe(true);
  }, 120_000);

  it.each([
    [
      "the player's own revoke (setMyConsent)",
      async (s: Scene) => {
        await sql`update persons set user_id = ${s.ownerId} where id = ${s.ben.id}`;
        return () => setMyConsent(s.ownerId, s.ben.id, { public_name: false });
      },
    ],
    [
      "the organiser's revoke (patchPerson)",
      async (s: Scene) => () => patchPerson(s.owner, s.ben.id, { consent: { public_name: false } }),
    ],
    [
      "a merge with an opted-out duplicate (mergePersons)",
      async (s: Scene) => {
        const dup = await createPerson(s.owner, { full_name: "Ben Stokes", consent: { public_name: false }, dob: null });
        return () => mergePersons(s.owner, s.ben.id, dup.id, { confirmedBy: s.ownerId });
      },
    ],
  ])("after %s, the rebuilt DIVISION data, FIXTURE data and ANOTHER player's card data all show the masked name", async (_writer, arrange) => {
    const s = await scene("card-data");
    const write = await arrange(s);
    const full = { division: ["Ben Stokes"], fixture: ["Ben Stokes"], adasOpponent: ["Ben Stokes"] };
    expect(await benAsShown(s), "premise: every entry names Ben in full, and is now cached").toEqual(full);

    await inRequest<unknown>(write);
    // Every one of these entries now EXPIRES on a person write (division tag),
    // so this read rebuilds; kept, with the refresh, so a regression back to a
    // stale tag is still read through to its rebuilt value.
    await benAsShown(s);
    await refreshed();

    const masked = maskDisplayName("Ben Stokes", "first_initial");
    expect(await benAsShown(s)).toEqual({ division: [masked], fixture: [masked], adasOpponent: [masked] });
  }, 120_000);

  it("a revoke expires the person's card at EVERY public competition URL — two rostered, one not — and touches neither another person's card there nor another org's", async () => {
    const s = await scene("card-fanout");
    const other = await scene("card-fanout-other");
    const second = await publicCompetition(s, "Second Cup");
    const secondDivision = await rosterIn(s, second.id, s.ada.id, s.ada.full_name);
    const third = await publicCompetition(s, "Third Cup");
    const cy = await createPerson(s.owner, { full_name: "Cy Twombly", consent: { public_name: true }, dob: null });
    await rosterIn(s, third.id, cy.id, cy.full_name);

    const adaPages: Array<[string, PageEntry<unknown>]> = [];
    for (const [label, slug] of [
      ["rostered, first", s.competition.slug],
      ["rostered, second", second.slug],
      ["not rostered", third.slug],
    ] as const) {
      const entry = await render(() => card(s, s.ada.id, slug));
      expect(entry.result, `premise: Ada's card renders at the ${label} competition's URL`).not.toBeNull();
      adaPages.push([label, entry]);
    }
    const cyPage = await render(() => card(s, cy.id, third.slug));
    expect(cyPage.result, "premise: Cy's card renders").not.toBeNull();
    const foreign = await render(() => card(other, other.ada.id));
    expect(foreign.result, "premise: the other org's card renders").not.toBeNull();

    const { tags, fires } = await inRequest(() => patchPerson(s.owner, s.ada.id, { consent: { public_name: false } }));

    expect(tags).toEqual(
      [
        personTag(s.ada.id),
        divisionTag(s.division.id),
        competitionTag(s.competition.id),
        divisionTag(secondDivision.id),
        competitionTag(second.id),
      ].sort(),
    );
    expect(tags).not.toContain(orgTag(s.orgSlug));
    expect(fires).toEqual([true]);
    for (const [label, entry] of adaPages) expect(expired(entry), `Ada's page, ${label}`).toBe(true);
    expect(expired(dataEntry("pub-player-v17", third.id, s.ada.id)), "Ada's card DATA where she is not rostered").toBe(
      true,
    );
    expect(untouched(cyPage), "Cy's page at the same URL").toBe(true);
    expect(untouched(dataEntry("pub-player-v17", third.id, cy.id)), "Cy's card data").toBe(true);
    expect(untouched(foreign), "another org's page").toBe(true);
    const after = await render(() => card(s, s.ada.id, third.slug));
    expect(after.result, "and the not-rostered URL now refuses").toBeNull();
  }, 180_000);

  it.each([
    ["full_name", { full_name: "Ada King" }],
    ["dob", { dob: "2012-05-05" }],
  ] as const)("patchPerson changing %s fires the person's tags, awaited, in the request", async (_field, patch) => {
    const s = await scene("card-identity");
    const { tags, fires } = await inRequest(() => patchPerson(s.owner, s.ada.id, patch));
    expect(tags).toEqual(sceneTags(s, s.ada.id));
    expect(fires).toEqual([true]);
  }, 120_000);

  it("patchPerson changing only fields no public page shows (gender, external_ref) fires nothing", async () => {
    const s = await scene("card-quiet");
    const { tags, fires } = await inRequest(() => patchPerson(s.owner, s.ada.id, { gender: "f", external_ref: "ref-7" }));
    expect(tags).toEqual([]);
    expect(fires).toEqual([]);
  }, 120_000);

  it("a MERGE fires both people's tags, awaited, and expires the survivor's served card; REVERSING it does the same for the refused card", async () => {
    const s = await scene("card-merge");
    const dup = await createPerson(s.owner, { full_name: "Ben Stokes", consent: { public_name: false }, dob: null });
    const both = [...sceneTags(s, s.ben.id), personTag(dup.id)].sort();
    const allowed = await render(() => card(s, s.ben.id));
    expect(allowed.result, "premise: the card is served").not.toBeNull();

    const merged = await inRequest(() => mergePersons(s.owner, s.ben.id, dup.id, { confirmedBy: s.ownerId }));
    expect(merged.tags).toEqual(both);
    expect(merged.fires, "mergePersons awaited the step").toEqual([true]);
    expect(expired(allowed), "after the merge").toBe(true);

    const refused = await render(() => card(s, s.ben.id));
    expect(refused.result, "premise: stricter consent wins, so the card is refused").toBeNull();

    const reversed = await inRequest(() => reverseMerge(s.owner, merged.result.merge_id, { confirmedBy: s.ownerId }));
    expect(reversed.tags).toEqual(both);
    expect(reversed.fires, "reverseMerge awaited the step").toEqual([true]);
    expect(expired(refused), "after the reversal").toBe(true);
  }, 120_000);

  it("a photo change, by the ORGANISER (setPersonPhoto) or the player (setMyPersonPhoto), fires the person's tags in the request and expires the served card", async () => {
    const s = await scene("card-photo");
    await sql`update persons set user_id = ${s.ownerId} where id = ${s.ben.id}`;

    const adaCard = await render(() => card(s, s.ada.id));
    expect(adaCard.result, "premise: Ada's card is served").not.toBeNull();
    const organiser = await inRequest(() => setPersonPhoto(s.owner, s.ada.id, PNG));
    expect(organiser.tags).toEqual(sceneTags(s, s.ada.id));
    expect(organiser.fires, "setPersonPhoto awaited the step").toEqual([true]);
    expect(expired(adaCard)).toBe(true);

    const benCard = await render(() => card(s, s.ben.id));
    expect(benCard.result, "premise: Ben's card is served").not.toBeNull();
    const player = await inRequest(() => setMyPersonPhoto(s.ownerId, s.ben.id, null));
    expect(player.tags).toEqual(sceneTags(s, s.ben.id));
    expect(player.fires, "setMyPersonPhoto awaited the step").toEqual([true]);
    expect(expired(benCard)).toBe(true);
  }, 120_000);

  it("when the step's roster read FAILS, every person writer still resolves, still fires the person tags, still retires the Redis poll documents, and logs an error", async () => {
    const s = await scene("card-fail");
    await sql`update persons set user_id = ${s.ownerId} where id = ${s.ben.id}`;
    const dup = await createPerson(s.owner, { full_name: "Ben Stokes", consent: { public_name: true }, dob: null });
    probe.failRosterRead = true;
    const logged = () => logMock.error.mock.calls.filter((call) => call[1] === FIRE_FAILED).length;

    let mergeId = "";
    const retiring: Array<[string, () => Promise<unknown>, string[]]> = [
      ["patchPerson", () => patchPerson(s.owner, s.ada.id, { consent: { public_name: false } }), [personTag(s.ada.id)]],
      ["setMyConsent", () => setMyConsent(s.ownerId, s.ben.id, { public_name: false }), [personTag(s.ben.id)]],
      [
        "mergePersons",
        async () => {
          mergeId = (await mergePersons(s.owner, s.ben.id, dup.id, { confirmedBy: s.ownerId })).merge_id;
        },
        [personTag(s.ben.id), personTag(dup.id)].sort(),
      ],
      ["reverseMerge", () => reverseMerge(s.owner, mergeId, { confirmedBy: s.ownerId }), [personTag(s.ben.id), personTag(dup.id)].sort()],
    ];
    let expected = 0;
    for (const [writer, write, personTags] of retiring) {
      probe.redis.set(s.genKey, "live-generation");
      const { tags, fires } = await inRequest(write);
      expected += 1;
      expect(fires, `${writer} still awaited the step`).toEqual([true]);
      expect(tags, `${writer} still fired the person tags`).toEqual(personTags);
      expect(probe.redis.has(s.genKey), `${writer} still retired the generation`).toBe(false);
      expect(logged(), `${writer} logged the failure`).toBe(expected);
    }
    const photos: Array<[string, () => Promise<unknown>, string]> = [
      ["setPersonPhoto", () => setPersonPhoto(s.owner, s.ada.id, PNG), personTag(s.ada.id)],
      ["setMyPersonPhoto", () => setMyPersonPhoto(s.ownerId, s.ben.id, PNG), personTag(s.ben.id)],
    ];
    for (const [writer, write, tag] of photos) {
      const { tags } = await inRequest(write);
      expected += 1;
      expect(tags, `${writer} still fired the person tag`).toEqual([tag]);
      expect(logged(), `${writer} logged the failure`).toBe(expected);
    }
    expect(logMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ personIds: [s.ada.id], person: s.ada.id }),
      FIRE_FAILED,
    );
  }, 180_000);
});

// W2 final review I1 — owner rule: results are never stale. A score write
// EXPIRES the division tag (`fireScoreRevalidate`) and only makes the
// competition tag stale. The player card bakes each match's result, score line
// and `lastSeq` into `pub-player-v17`, so the card's page and data entries must
// carry the division tag of every division its matches come from, or the next
// loads serve the old result while a background rebuild runs, exactly as the
// fixture page no longer does.
describe.skipIf(!HAS_DB)("a SCORE write expires the player card like the fixture page (final review I1)", () => {
  it("scoreEvent on a match the card lists: the card's page entry and its pub-player-v17 data entry EXPIRE, not stale; the same player's card at a competition with no score is untouched", async () => {
    const s = await scene("card-score");
    const second = await publicCompetition(s, "Second Cup");
    await rosterIn(s, second.id, s.ada.id, s.ada.full_name);

    const cardPage = await render(() => card(s, s.ada.id));
    expect(cardPage.result, "premise: Ada's card is served").not.toBeNull();
    expect(
      cardPage.result!.matches.map((m) => m.fixtureId),
      "premise: the card lists the match the score lands on",
    ).toContain(s.fixture.id);
    const fixturePage = await render(() =>
      getPublicFixture(s.orgSlug, s.competition.slug, s.division.slug, s.fixture.id),
    );
    const elsewhere = await render(() => card(s, s.ada.id, second.slug));
    expect(elsewhere.result, "premise: Ada's card at the second competition is served").not.toBeNull();

    await inRequest(() =>
      scoreEvent(s.owner, s.fixture.id, {
        expected_seq: 1,
        type: "generic.score",
        payload: { by: s.fixture.home_entrant_id, points: 1 },
      }),
    );

    // The positive control: the fixture page has always expired on a score.
    expect(expired(fixturePage), "the fixture page").toBe(true);
    expect(expired(cardPage), "the card PAGE entry").toBe(true);
    expect(expired(dataEntry("pub-player-v17", s.competition.id, s.ada.id)), "the card DATA entry").toBe(true);
    // The negative pair: the card at a competition the score is not in.
    expect(untouched(elsewhere), "Ada's card page at the second competition").toBe(true);
    expect(untouched(dataEntry("pub-player-v17", second.id, s.ada.id)), "its data entry").toBe(true);
  }, 120_000);

  it("a competition with more divisions than an entry can carry tags for: the card keeps the tags of the person's OWN divisions (roster and lineup) first, the rest by id, and drops the overflow with a warning (review r2-m3)", async () => {
    const s = await scene("card-cap");
    // A division Ada is seated in by a LINEUP only.
    const cy = await createPerson(s.owner, { full_name: "Cy Twombly", consent: { public_name: true }, dob: null });
    const lineupDivision = await rosterIn(s, s.competition.id, cy.id, cy.full_name);
    const dee = await createPerson(s.owner, { full_name: "Dee Dash", consent: { public_name: true }, dob: null });
    const [deeEntrant] = await createEntrants(s.owner, lineupDivision.id, [
      {
        kind: "individual" as const,
        display_name: dee.full_name,
        seed: 2,
        members: [{ person_id: dee.id, squad_number: null, default_position_key: null, is_captain: false, roles: [] }],
      },
    ]);
    const [stage] = await createStages(s.owner, lineupDivision.id, { seq: 1, kind: "league", name: "L", config: {} });
    const { fixtures } = await generateStageFixtures(s.owner, stage!.id);
    await sql`
      insert into lineups (fixture_id, entrant_id, person_id, org_id, slot, position_key, order_no, roles)
      values (${fixtures[0]!.id}, ${deeEntrant!.id}, ${s.ada.id}, ${s.orgId}, 'starting', null, 1, ${sql.json([])})`;
    // Enough empty divisions to pass the cap by one. Straight into the table:
    // the plan's per-competition quota is not what is under test.
    const room = NEXT_CACHE_TAG_MAX_ITEMS - 3;
    await sql`
      insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version, youth)
      select d.competition_id, 'Extra ' || g, 'extra-' || g, d.sport_key, d.variant_key, d.config, d.module_version, d.youth
      from divisions d, generate_series(1, ${room - 1}) g
      where d.id = ${s.division.id}`;
    const all = await sql<{ id: string }[]>`select id from divisions where competition_id = ${s.competition.id}`;
    expect(all, "premise: one division more than the entry has room for").toHaveLength(room + 1);

    const own = [s.division.id, lineupDivision.id].sort();
    const rest = all.map((d) => d.id).filter((id) => !own.includes(id)).sort();
    expect(rest[0]! < own[1]!, "premise: id order alone would not put Ada's divisions first").toBe(true);

    logMock.warn.mockClear();
    await card(s, s.ada.id);
    const { tags } = dataEntry("pub-player-v17", s.competition.id, s.ada.id);
    expect(tags).toHaveLength(NEXT_CACHE_TAG_MAX_ITEMS);
    expect(tags).toEqual([
      competitionTag(s.competition.id),
      personTag(s.ada.id),
      orgTag(s.orgSlug),
      ...[...own, ...rest].slice(0, room).map(divisionTag),
    ]);
    expect(tags, "the overflow: the last division by id that Ada plays no match in").not.toContain(divisionTag(rest.at(-1)!));
    expect(logMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ competitionId: s.competition.id, personId: s.ada.id, divisions: room + 1, kept: room }),
      PLAYER_CARD_TAGS_CAPPED,
    );
  }, 180_000);
});

describe("playerCardTags: never more tags than Next keeps on one entry (review r2-m3)", () => {
  const fixed = ["competition:c", "pub-person:p", "org-public:o"];
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `d${String(n - i).padStart(3, "0")}`);

  it("the cap is Next's own", async () => {
    const next = await import("next/dist/lib/constants");
    expect(NEXT_CACHE_TAG_MAX_ITEMS).toBe(next.NEXT_CACHE_TAG_MAX_ITEMS);
  });

  it("up to the room left by the fixed tags: every division, in the order given, and no warning", () => {
    logMock.warn.mockClear();
    const given = ids(NEXT_CACHE_TAG_MAX_ITEMS - fixed.length);
    expect(playerCardTags(fixed, given, { competitionId: "c", personId: "p" })).toEqual([
      ...fixed,
      ...given.map(divisionTag),
    ]);
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it("one past it: the fixed tags and the FIRST divisions in the order given, the last dropped, and a warning", () => {
    logMock.warn.mockClear();
    const given = ids(NEXT_CACHE_TAG_MAX_ITEMS - fixed.length + 1);
    const tags = playerCardTags(fixed, given, { competitionId: "c", personId: "p" });
    expect(tags).toHaveLength(NEXT_CACHE_TAG_MAX_ITEMS);
    expect(tags).toEqual([...fixed, ...given.slice(0, -1).map(divisionTag)]);
    expect(logMock.warn).toHaveBeenCalledWith(
      { competitionId: "c", personId: "p", divisions: given.length, kept: given.length - 1 },
      PLAYER_CARD_TAGS_CAPPED,
    );
  });
});

// W2 final review I2 — the public REDIS documents printing a person's name (the
// hub, a division's schedule, standings and entrants, a fixture's match-centre
// document) are reached by no tag. They served the old name to every poll for
// up to their 15–30s TTL after a consent OFF. The keys are pinned as literals,
// as the score and schedule invalidation suites pin them, so a reader and this
// writer cannot drift apart.
describe.skipIf(!HAS_DB)("a person write drops the public Redis documents naming that person (final review I2)", () => {
  /** Ben's scene, plus a competition he is NOT rostered in whose one fixture
   *  seats him in a LINEUP only (a lineup can outlive its membership). */
  async function docsScene(tag: string) {
    const s = await scene(tag);
    const other = await publicCompetition(s, "Other Cup");
    const cy = await createPerson(s.owner, { full_name: "Cy Twombly", consent: { public_name: true }, dob: null });
    const otherDivision = await rosterIn(s, other.id, cy.id, cy.full_name);
    const deePerson = await createPerson(s.owner, { full_name: "Dee Dash", consent: { public_name: true }, dob: null });
    const [dee] = await createEntrants(s.owner, otherDivision.id, [
      {
        kind: "individual" as const,
        display_name: deePerson.full_name,
        seed: 2,
        members: [{ person_id: deePerson.id, squad_number: null, default_position_key: null, is_captain: false, roles: [] }],
      },
    ]);
    const [stage] = await createStages(s.owner, otherDivision.id, { seq: 1, kind: "league", name: "L", config: {} });
    const { fixtures } = await generateStageFixtures(s.owner, stage!.id);
    const lineupFixture = fixtures[0]!;
    await sql`
      insert into lineups (fixture_id, entrant_id, person_id, org_id, slot, position_key, order_no, roles)
      values (${lineupFixture.id}, ${dee!.id}, ${s.ben.id}, ${s.orgId}, 'starting', null, 1, ${sql.json([])})`;
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from entrant_members em join entrants e on e.id = em.entrant_id
      where e.division_id = ${otherDivision.id} and em.person_id = ${s.ben.id}`;
    expect(n, "premise: Ben is on no roster of the other division, only in its lineup").toBe(0);
    const named = [
      `pub:v1:hub:${s.competition.id}`,
      `pub:v1:div:${s.division.id}:entrants-v2`,
      `pub:v1:div:${s.division.id}:standings`,
      `pub:v1:div:${s.division.id}:schedule`,
      `pub:v1:fixture:v2:${s.fixture.id}`,
      `pub:v1:fixture:v2:${lineupFixture.id}`,
    ];
    const unrelated = [`pub:v1:hub:${other.id}`, `pub:v1:div:${otherDivision.id}:entrants-v2`];
    return { s, other, otherDivision, named, unrelated };
  }

  it("consent OFF: the rostered competition's hub, the division's documents, the match-centre documents of his fixture AND of a lineup-only fixture are gone; another competition's are kept; peers are told to EXPIRE the division", async () => {
    const { s, other, otherDivision, named, unrelated } = await docsScene("docs-consent");
    for (const key of [...named, ...unrelated]) probe.redis.set(key, { cached: "with Ben Stokes" });
    // The hub document is rebuilt THROUGH `getPublicDivision`'s `pub-div-v3`
    // entry. Were that entry only stale, the first rebuild after the drop would
    // be served the old names and bake them back into the hub for its TTL.
    expect((await getPublicDivision(s.orgSlug, s.competition.slug, s.division.slug))!.entrants.map((e) => e.display_name))
      .toContain("Ben Stokes");
    expect(await getPublicDivision(s.orgSlug, other.slug, otherDivision.slug), "premise: the other division is served").not.toBeNull();

    await inRequest(() => patchPerson(s.owner, s.ben.id, { consent: { public_name: false } }));

    expect(named.filter((key) => probe.redis.has(key)), "documents still naming Ben").toEqual([]);
    expect(unrelated.filter((key) => probe.redis.has(key)), "documents of a competition Ben is not in").toEqual(unrelated);
    expect(expired(dataEntry("pub-div-v3", s.division.id)), "Ben's division data entry EXPIRES, not stale").toBe(true);
    expect(untouched(dataEntry("pub-div-v3", otherDivision.id)), "a division Ben is not in").toBe(true);
    const rebuilt = await getPublicDivision(s.orgSlug, s.competition.slug, s.division.slug);
    expect(rebuilt!.entrants.map((e) => e.display_name), "the first rebuild after the drop").not.toContain("Ben Stokes");

    // Every OTHER machine: the division tag goes out as EXPIRE, never as SWR,
    // or a peer's hub rebuild reads its stale `pub-div-v3` (review r2-m2 Y6).
    const div = divisionTag(s.division.id);
    const comp = competitionTag(s.competition.id);
    const modesOf = (tag: string) => probe.broadcasts.filter((b) => b.tags.includes(tag)).map((b) => b.mode);
    expect(modesOf(div), "the division tag's broadcasts").toEqual(["expire"]);
    expect(modesOf(personTag(s.ben.id)), "the person tag's broadcasts").toEqual(["expire"]);
    expect(modesOf(comp), "the competition tag's broadcasts").toEqual(["swr"]);
  }, 120_000);

  it("a poll that re-bakes a document between the write's Redis drop and its tag flush: the document is dropped AGAIN in the after-window (review r2-m1)", async () => {
    const { s, named } = await docsScene("docs-rebake");
    for (const key of named) probe.redis.set(key, { cached: "with Ben Stokes" });

    let droppedMidRequest: string[] | null = null;
    await inRequest(
      () => patchPerson(s.owner, s.ben.id, { consent: { public_name: false } }),
      () => {
        // The handler has resolved; the tags have not flushed yet.
        droppedMidRequest = named.filter((key) => !probe.redis.has(key));
        for (const key of named) probe.redis.set(key, { cached: "re-baked with Ben Stokes" });
      },
    );

    expect(droppedMidRequest, "premise: the first drop ran inside the request").toEqual(named);
    expect(named.filter((key) => probe.redis.has(key)), "documents re-baked in the gap and never dropped again").toEqual([]);
  }, 120_000);
});
