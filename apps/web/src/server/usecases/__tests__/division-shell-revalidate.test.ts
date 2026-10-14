// stg, 2026-10-14 — a division created a moment ago 404s on the public site
// ("This link is no longer valid"), and the 404 is cached in turn.
//
// Every public division and fixture page finds its division by slug in the
// COMPETITION SHELL (`getPublicCompetition`, data.ts `pub-comp`), and that entry
// is tagged with the ORG tag and nothing else. So a write that adds a division
// to the shell, takes one out of it, or moves one to a new slug must expire the
// org tag inside its own request. Without it the shell keeps answering from
// before the write until the entry ages out — measured on stg at ~32 minutes,
// where a suspended machine's cache clock does not run.
//
// The competition writes owe the same: a delete, a create (a slug someone
// probed is cached as MISSING and must heal), and any move between public,
// unlisted, private and draft — the shell reads `public_competitions_v`
// (public | unlisted), so making an unlisted competition private must take its
// public pages down now, not when the entry ages out.
//
// Proven through Next's real per-request flush and tag manifest, the harness of
// `person-writes-public-page-revalidate.test.ts`: the real async-local storages,
// the real `revalidateTag`, the real `executeRevalidates` flush the instant the
// handler resolves, and FileSystemCache's real tag manifest. A tag fired after
// the use-case resolves never reaches the flush, so it fails here as it fails
// in production. The `unstable_cache` double below caches by key parts and
// arguments and treats an entry as Next does: one whose own tags have EXPIRED is
// a miss, one whose tags are STALE is served once and refreshed.
//
// One sport (`generic`) throughout, and one template: the shell's division list,
// and every write under test, are sport-blind — none of them branches on the
// sport key.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Next's node environment installs this before any server module loads;
  // without it Next's storages are a fake that throws on `run` (E504).
  const g = globalThis as { AsyncLocalStorage?: unknown };
  g.AsyncLocalStorage ??= process.getBuiltinModule("node:async_hooks").AsyncLocalStorage;
});

const probe = vi.hoisted(() => ({
  /** The data cache: key → the value as JSON, its own tags, when it was stored. */
  entries: new Map<string, { json: string; tags: string[]; cachedAt: number }>(),
  /** Background refreshes of stale entries, still running. */
  refreshing: [] as Promise<unknown>[],
  /** Make the org-slug read after a division write reject. */
  failOrgSlugRead: false,
  /** Every peer broadcast sent: its tags and its mode. */
  broadcasts: [] as Array<{ tags: string[]; mode: "swr" | "expire" }>,
}));

vi.mock("next/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/cache")>();
  const { areTagsExpired, areTagsStale } = await import(
    "next/dist/server/lib/incremental-cache/tags-manifest.external"
  );
  // A call made inside another cached call's run is NESTED: it skips the cache
  // read and runs its function, but still writes its result (unstable-cache.js,
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
// The pooled `sql`, with ONE statement made to fail on request: the org-slug
// read a division write makes after its commit. Everything else passes through.
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const sql = new Proxy(actual.sql, {
    apply(target, thisArg, args: unknown[]) {
      const strings = args[0];
      if (
        probe.failOrgSlugRead &&
        Array.isArray(strings) &&
        strings.join("?").includes("select slug from organizations where id =")
      ) {
        return Promise.reject(new Error("simulated org slug read failure"));
      }
      return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
    },
  });
  return { ...actual, sql };
});
// The other machines learn of an expiry only through this broadcast.
vi.mock("@/lib/peer-revalidate", () => ({
  broadcastRevalidate: async (tags: string[], mode: "swr" | "expire") => {
    probe.broadcasts.push({ tags: [...tags], mode });
  },
}));
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
import { AfterContext } from "next/dist/server/after/after-context";
import { workAsyncStorage, type WorkStore } from "next/dist/server/app-render/work-async-storage.external";
import {
  workUnitAsyncStorage,
  type RequestStore,
} from "next/dist/server/app-render/work-unit-async-storage.external";
import { executeRevalidates } from "next/dist/server/revalidation-utils";
import { defaultConfig } from "next/dist/server/config-shared";
import FileSystemCache from "next/dist/server/lib/incremental-cache/file-system-cache";
import { areTagsExpired } from "next/dist/server/lib/incremental-cache/tags-manifest.external";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { getPublicCompetition, getPublicFixture, orgTag } from "@/server/public-site/data";
import { createCompetition, deleteCompetition, patchCompetition } from "../competitions";
import { archiveDivision, createDivision, deleteDivision, patchDivision, restoreDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const SLUG_READ_FAILED = "public pages: the org's competition shell could not be expired (the write stands)";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type FlushCall = { tags: string[]; durations: { expire?: number } | undefined };

/** One route-handler request, in the order app-route/module.js runs it: the
 *  handler inside both storages, then ONE flush as soon as it resolves, then the
 *  after-window. `calls` is what the REQUEST flushed, each handed on to the real
 *  tag manifest. Sleeps either side, so every entry cached before it is strictly
 *  older than the flush and every entry cached after it strictly newer. */
async function inRequest<T>(handler: () => Promise<T>): Promise<{ result: T; calls: FlushCall[] }> {
  await sleep(3);
  const calls: FlushCall[] = [];
  const fsCache = new FileSystemCache({} as ConstructorParameters<typeof FileSystemCache>[0]);
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
    route: "/api/v1/divisions/[id]",
    page: "/api/v1/divisions/[id]/route",
    incrementalCache: {
      revalidateTag: (fired: string | string[], durations?: { expire?: number }) => {
        const tags = typeof fired === "string" ? [fired] : [...fired];
        calls.push({ tags, durations });
        return fsCache.revalidateTag(tags, durations);
      },
    },
    cacheLifeProfiles: defaultConfig.cacheLife,
    afterContext,
  } as unknown as WorkStore;
  const requestStore = { type: "request", phase: "action" } as unknown as RequestStore;
  probe.broadcasts = [];
  const out = await workAsyncStorage.run(workStore, async () => {
    const result = await workUnitAsyncStorage.run(requestStore, handler);
    const flush = executeRevalidates(workStore);
    if (flush !== false) await flush;
    return { result, calls: [...calls] };
  });
  res.emit("close");
  await Promise.all(waitingOn);
  await sleep(3);
  return out;
}

const expired = (entry: { tags: string[]; cachedAt: number }) => areTagsExpired(entry.tags, entry.cachedAt);

afterEach(() => {
  probe.entries.clear();
  probe.refreshing = [];
  probe.failOrgSlugRead = false;
  probe.broadcasts = [];
  for (const fn of Object.values(logMock)) fn.mockClear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("a division write that changes the competition shell expires the org tag in its own request", () => {
  let auth: AuthCtx;
  let orgSlug: string;
  let competitionId: string;
  let compSlug: string;

  const division = (name: string) =>
    createDivision(auth, competitionId, { name, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });

  /** The slugs a public read of the shell lists right now (caching it on a miss). */
  const shellSlugs = async () => (await getPublicCompetition(orgSlug, compSlug))!.divisions.map((d) => d.slug);

  /** The shell's stored data entry, by the key parts its `unstable_cache` call declares. */
  const shellEntry = () => {
    const entry = probe.entries.get(JSON.stringify([["pub-comp", orgSlug, compSlug], []]));
    expect(entry, "premise: the competition shell is cached").toBeDefined();
    return entry!;
  };

  const orgFires = (calls: FlushCall[]) => calls.filter((c) => c.tags.includes(orgTag(orgSlug)));
  const orgBroadcasts = () => probe.broadcasts.filter((b) => b.tags.includes(orgTag(orgSlug)));

  beforeAll(async () => {
    ({ auth } = await seedOrg("pro"));
    [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Shell Revalidate Cup",
      visibility: "public",
      branding: {},
    });
    competitionId = comp.id;
    compSlug = comp.slug;
  });

  // Each write runs against a shell cached AFTER `arrange` and BEFORE the write:
  // the public page someone had open, or the hub the organiser just looked at.
  // `gone` is the slug the write must take out of the shell, `arrived` the one
  // it must put in — read off the row the write returns, never typed here.
  const SHELL_WRITES: Array<{
    site: string;
    arrange: () => Promise<{
      write: () => Promise<unknown>;
      gone?: string;
      arrived?: (result: unknown) => string;
    }>;
  }> = [
    {
      site: "createDivision",
      arrange: async () => ({
        write: () => division("Created Late"),
        arrived: (row) => (row as { slug: string }).slug,
      }),
    },
    {
      site: "deleteDivision",
      arrange: async () => {
        const d = await division("Deleted Setup");
        return { write: () => deleteDivision(auth, d.id), gone: d.slug };
      },
    },
    {
      site: "archiveDivision",
      arrange: async () => {
        const d = await division("Archived Live");
        return { write: () => archiveDivision(auth, d.id), gone: d.slug };
      },
    },
    {
      site: "restoreDivision",
      arrange: async () => {
        const d = await division("Restored Archived");
        await archiveDivision(auth, d.id);
        return { write: () => restoreDivision(auth, d.id), arrived: () => d.slug };
      },
    },
    {
      site: "patchDivision (rename)",
      arrange: async () => {
        const d = await division("Before Rename");
        return {
          write: () => patchDivision(auth, d.id, { name: "After Rename" }),
          gone: d.slug,
          arrived: (row) => (row as { slug: string }).slug,
        };
      },
    },
  ];

  const covered: string[] = [];

  for (const w of SHELL_WRITES) {
    it(`${w.site}: the request expires the org tag, and the next public read of the shell shows the change`, async () => {
      const { write, gone, arrived } = await w.arrange();
      const before = await shellSlugs();
      const entry = shellEntry();
      if (gone) expect(before, "premise: listed before the write").toContain(gone);

      const { result, calls } = await inRequest(write);

      const arrivedSlug = arrived?.(result);
      expect(gone ?? arrivedSlug, "premise: the write moves a slug in or out of the shell").toBeDefined();
      if (arrivedSlug) expect(before, "premise: not listed before the write").not.toContain(arrivedSlug);
      if (gone && arrivedSlug) expect(arrivedSlug, "premise: the rename moved the slug").not.toBe(gone);
      expect(
        orgFires(calls).map((c) => c.durations),
        "the org tag, EXPIRED (read-your-own-writes), exactly once",
      ).toEqual([{ expire: 0 }]);
      expect(orgBroadcasts(), "the other machines, told to expire it, once").toEqual([
        { tags: [orgTag(orgSlug)], mode: "expire" },
      ]);
      expect(expired(entry), "the shell cached before the write").toBe(true);
      const after = await shellSlugs();
      if (gone) expect(after, "a slug the write took out").not.toContain(gone);
      if (arrivedSlug) expect(after, "a slug the write put in").toContain(arrivedSlug);
      covered.push(w.site);
    });
  }

  it("the sweep reached every division write that changes the shell (zero is a failure)", () => {
    expect(covered.length).toBeGreaterThan(0);
    expect(covered).toEqual(SHELL_WRITES.map((w) => w.site));
    expect(covered).toHaveLength(5);
  });

  it("harness control: the SAME create made outside a request scope expires nothing, so the shell cached before it still omits the division", async () => {
    await shellSlugs();
    const entry = shellEntry();
    const d = await division("Outside Any Request");
    expect(expired(entry)).toBe(false);
    expect(await shellSlugs(), "a cached shell served from before the write").not.toContain(d.slug);
  });

  it("a fixture in a division created after the hub was cached is served, not refused (stg 2026-10-14)", async () => {
    await shellSlugs();
    const { result: late } = await inRequest(() => division("Late Entry Open"));
    await createEntrants(
      auth,
      late.id,
      ["Asha Rao", "Bea Lim"].map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })),
    );
    const [stage] = await createStages(auth, late.id, { seq: 1, kind: "league", name: "League", config: {} });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    expect(fixtures.length, "premise: the new division has a fixture").toBeGreaterThan(0);

    const page = await getPublicFixture(orgSlug, compSlug, late.slug, fixtures[0]!.id);

    expect(page, "the public fixture page's read").not.toBeNull();
    expect(page!.division.id).toBe(late.id);
  });

  it("a second archive of an archived division, and a restore of a live one, change nothing and fire nothing", async () => {
    const d = await division("Archived Twice");
    await archiveDivision(auth, d.id);
    const again = await inRequest(() => archiveDivision(auth, d.id));
    expect(again.result.archived_at, "premise: still archived").not.toBeNull();
    expect(again.calls).toEqual([]);
    expect(orgBroadcasts()).toEqual([]);

    const live = await division("Restored While Live");
    const restore = await inRequest(() => restoreDivision(auth, live.id));
    expect(restore.result.archived_at, "premise: still live").toBeNull();
    expect(restore.calls).toEqual([]);
    expect(orgBroadcasts()).toEqual([]);
  });

  it("a rename that re-sends the stored name fires nothing (the settings form re-sends it on every Save)", async () => {
    const d = await division("Same Name");
    const { result, calls } = await inRequest(() => patchDivision(auth, d.id, { name: "Same Name" }));
    expect(result.slug, "premise: the slug did not move").toBe(d.slug);
    expect(calls).toEqual([]);
    expect(orgBroadcasts()).toEqual([]);
  });

  it("a rename and a name-policy change in ONE patch expire the org tag once, here and on the other machines", async () => {
    const d = await division("Rename With Policy");
    const { result, calls } = await inRequest(() =>
      patchDivision(auth, d.id, { name: "Renamed With Policy", player_name_display: "first_initial" }),
    );
    expect(result.slug, "premise: the slug moved").not.toBe(d.slug);
    expect(result.player_name_display, "premise: the policy changed").toBe("first_initial");
    expect(orgFires(calls).map((c) => c.durations)).toEqual([{ expire: 0 }]);
    expect(orgBroadcasts()).toEqual([{ tags: [orgTag(orgSlug)], mode: "expire" }]);
  });

  it("purging a division archived 30+ days ago fires nothing: it left the shell when it was archived", async () => {
    const d = await division("Purged Archive");
    await archiveDivision(auth, d.id);
    await sql`update divisions set archived_at = now() - interval '31 days' where id = ${d.id}`;
    const { calls } = await inRequest(() => deleteDivision(auth, d.id));
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from divisions where id = ${d.id}`;
    expect(n, "premise: the purge deleted the row").toBe(0);
    expect(calls).toEqual([]);
    expect(orgBroadcasts()).toEqual([]);
  });

  it("a refused create (the explicit slug is taken) fires nothing", async () => {
    const taken = await division("Slug Taken");
    let refused: unknown;
    const { calls } = await inRequest(() =>
      createDivision(auth, competitionId, {
        name: "Another",
        slug: taken.slug,
        sport_key: "generic",
        variant_key: "score",
        config: GENERIC_CONFIG,
      }).catch((err: unknown) => {
        refused = err;
      }),
    );
    expect((refused as { status?: number } | undefined)?.status, "premise: the create was refused").toBe(409);
    expect(calls).toEqual([]);
    expect(orgBroadcasts()).toEqual([]);
  });

  it("the org slug read failing: the created division stands, the failure is logged, and nothing is fired", async () => {
    probe.failOrgSlugRead = true;
    const { result, calls } = await inRequest(() => division("Slug Read Fails"));
    probe.failOrgSlugRead = false;
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from divisions where id = ${result.id}`;
    expect(n, "the committed division").toBe(1);
    expect(calls).toEqual([]);
    expect(orgBroadcasts()).toEqual([]);
    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(logMock.error.mock.calls[0]![1]).toBe(SLUG_READ_FAILED);
  });
});

describe.skipIf(!HAS_DB)("deleteCompetition expires the org tag in its own request", () => {
  it("the request expires the org tag, and the next public read of the deleted competition's shell is refused", async () => {
    const { auth } = await seedOrg("pro");
    const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Deleted Shell Cup",
      visibility: "public",
      branding: {},
    });
    await createDivision(auth, comp.id, { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
    expect(await getPublicCompetition(orgSlug, comp.slug), "premise: the shell is public and cached").not.toBeNull();
    const entry = probe.entries.get(JSON.stringify([["pub-comp", orgSlug, comp.slug], []]))!;
    expect(entry, "premise: the shell entry").toBeDefined();

    const { calls } = await inRequest(() => deleteCompetition(auth, comp.id));

    expect(
      calls.filter((c) => c.tags.includes(orgTag(orgSlug))).map((c) => c.durations),
      "the org tag, EXPIRED, exactly once",
    ).toEqual([{ expire: 0 }]);
    expect(expired(entry), "the shell cached before the delete").toBe(true);
    expect(await getPublicCompetition(orgSlug, comp.slug), "a deleted competition's shell").toBeNull();
  });
});

/** The shell's stored data entry for one competition URL, by its declared key parts. */
const shellEntryOf = (orgSlug: string, compSlug: string) =>
  probe.entries.get(JSON.stringify([["pub-comp", orgSlug, compSlug], []]));

const orgSlugOf = async (auth: AuthCtx) =>
  (await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`)[0]!.slug;

// The four ways a competition faces the public, as the patch that puts it
// there. Private has no shell at all; a public DRAFT is readable by link and
// not listed (`competitionIsListed`).
const EXPOSURES = {
  P: { visibility: "public", status: "published" },
  U: { visibility: "unlisted", status: "published" },
  X: { visibility: "private", status: "published" },
  D: { visibility: "public", status: "draft" },
} as const;
type Exposure = keyof typeof EXPOSURES;
// Every ordered pair of the four exactly once (an Euler circuit of the complete
// directed graph on them), from a new competition's own state, a public draft,
// back to it.
const EXPOSURE_WALK: Exposure[] = ["D", "P", "U", "X", "D", "X", "U", "D", "U", "P", "X", "P", "D"];

describe.skipIf(!HAS_DB)("patchCompetition: any move between public, unlisted, private and draft expires the org tag in its own request", () => {
  it("all 12 transitions: the org tag EXPIRES here and on the other machines, and the next public read serves the new state (private: refused)", async () => {
    const { auth } = await seedOrg("pro");
    const orgSlug = await orgSlugOf(auth);
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Exposure Walk Cup",
      visibility: "public",
      branding: {},
    });
    expect({ visibility: comp.visibility, status: comp.status }, "premise: a new competition is a public draft").toEqual(
      EXPOSURES.D,
    );
    const served = (e: Exposure) =>
      e === "X" ? "refused" : `${EXPOSURES[e].visibility}/${EXPOSURES[e].status}`;

    const walked: Array<{ step: string; org: unknown[]; peers: string[]; shellExpired: boolean; served: string }> = [];
    for (let i = 1; i < EXPOSURE_WALK.length; i++) {
      const to = EXPOSURE_WALK[i]!;
      await getPublicCompetition(orgSlug, comp.slug);
      const entry = shellEntryOf(orgSlug, comp.slug);
      expect(entry, "premise: the shell (or its refusal) is cached").toBeDefined();
      const { calls } = await inRequest(() => patchCompetition(auth, comp.id, { ...EXPOSURES[to] }));
      const after = await getPublicCompetition(orgSlug, comp.slug);
      walked.push({
        step: `${EXPOSURE_WALK[i - 1]}→${to}`,
        org: calls.filter((c) => c.tags.includes(orgTag(orgSlug))).map((c) => c.durations),
        peers: probe.broadcasts.filter((b) => b.tags.includes(orgTag(orgSlug))).map((b) => b.mode),
        shellExpired: expired(entry!),
        served: after === null ? "refused" : `${after.competition.visibility}/${after.competition.status}`,
      });
    }

    const everyPair = (Object.keys(EXPOSURES) as Exposure[]).flatMap((a) =>
      (Object.keys(EXPOSURES) as Exposure[]).filter((b) => b !== a).map((b) => `${a}→${b}`),
    );
    expect(walked.length, "transitions walked (zero is a failure)").toBe(12);
    expect(walked.map((w) => w.step).sort(), "every ordered pair, once").toEqual(everyPair.sort());
    const owed = walked.map((w) => ({
      step: w.step,
      org: [{ expire: 0 }],
      peers: ["expire"],
      shellExpired: true,
      served: served(w.step.split("→")[1] as Exposure),
    }));
    expect(
      walked.filter((w, i) => JSON.stringify(w) !== JSON.stringify(owed[i])).map((w) => `${w.step} served ${w.served}`),
      "transitions that left the shell stale",
    ).toEqual([]);
    expect(walked).toEqual(owed);
  });

  it("a patch that moves neither visibility nor draft fires no org expiry: published → live, a description edit, a re-sent visibility", async () => {
    const { auth } = await seedOrg("pro");
    const orgSlug = await orgSlugOf(auth);
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Steady Exposure Cup",
      visibility: "public",
      branding: {},
    });
    await patchCompetition(auth, comp.id, { status: "published" });
    const patches = [{ status: "live" as const }, { description: "Now with a description" }, { visibility: "public" as const }];
    const fired: unknown[][] = [];
    for (const patch of patches) {
      const { calls } = await inRequest(() => patchCompetition(auth, comp.id, patch));
      fired.push([
        ...calls.filter((c) => c.tags.includes(orgTag(orgSlug))),
        ...probe.broadcasts.filter((b) => b.tags.includes(orgTag(orgSlug))),
      ]);
    }
    expect(fired, "per patch: org expiries flushed and broadcast").toEqual(patches.map(() => []));
  });
});
