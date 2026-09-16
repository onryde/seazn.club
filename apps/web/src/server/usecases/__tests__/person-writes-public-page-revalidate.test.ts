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
//    `pub-player-v16` entry bakes the revoked name back in. Firing the org tag
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
//    STALE is served once and refreshed in the background.
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
  cacheDelPattern: async () => {},
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

import { unstable_cache } from "next/cache";
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
  orgTag,
  personTag,
} from "@/server/public-site/data";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { setMyConsent, setMyPersonPhoto } from "../me";
import { createPerson, patchPerson, setPersonPhoto } from "../persons";
import { mergePersons, reverseMerge } from "../person-merge";
import { endSql, scene, type Scene } from "./_player-matches-writes-scene";

const HAS_DB = !!process.env.DATABASE_URL;
const FIRE_FAILED =
  "public pages: a person's rosters could not be read to revalidate the pages naming them (the write stands)";
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
): Promise<{ result: T; tags: string[]; fires: boolean[] }> {
  await sleep(3);
  const tags: string[] = [];
  const fsCache = new FileSystemCache({} as ConstructorParameters<typeof FileSystemCache>[0]);
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
  } as unknown as WorkStore;
  const requestStore = { type: "request", phase: "action" } as unknown as RequestStore;
  probe.fires = [];
  const out = await workAsyncStorage.run(workStore, async () => {
    const result = await workUnitAsyncStorage.run(requestStore, handler);
    const fires = probe.fires.map((f) => f.awaited);
    const flush = executeRevalidates(workStore);
    if (flush !== false) await flush;
    return { result, tags: [...new Set(tags)].sort(), fires };
  });
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
    await benAsShown(s); // the one stale read a stale-while-revalidate tag allows
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
    expect(expired(dataEntry("pub-player-v16", third.id, s.ada.id)), "Ada's card DATA where she is not rostered").toBe(
      true,
    );
    expect(untouched(cyPage), "Cy's page at the same URL").toBe(true);
    expect(untouched(dataEntry("pub-player-v16", third.id, cy.id)), "Cy's card data").toBe(true);
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
