// Player stats refresh after a result (owner ruling 2026-09-16, option B): the
// ISR half of "clear the public caches again once the fold has committed".
//
// The refresh runs inside Next's `after()` (`lib/deferred.ts`). A tag fired
// there is flushed by `AfterContext.runCallbacks` → `withExecuteRevalidates`,
// which flushes only the tag+profile pairs the callbacks ADDED. Next never
// clears `workStore.pendingRevalidatedTags` after the request's own flush, and
// `revalidateTag` skips a pair already on that list. The score request has
// already fired `competition "max"` and `division {expire: 0}`, so a refresh
// that repeated those exact calls would fire, not throw, and land nothing: a
// hub document rebuilt between the score and the fold would keep the old
// leaders until its TTL.
//
// Every seam here is Next's own: the async-local storages, `after()`, the
// `AfterContext`, `executeRevalidates`, `FileSystemCache` and the tag manifest
// that `IncrementalCache.get` consults (`areTagsExpired` / `areTagsStale`).
// The response "closes" when the test says so, exactly where Next would call
// the `onClose` listener once the response has been sent.
//
// The harness control needs no database and always runs; the DB case drives a
// real deciding `scoreEvent` through the real `deferred` → `after()` chain.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

vi.hoisted(() => {
  // Next's node environment installs this global before any server module
  // loads; without it Next's storages are a fake that throws on `run` (E504).
  const g = globalThis as { AsyncLocalStorage?: unknown };
  g.AsyncLocalStorage ??= process.getBuiltinModule("node:async_hooks").AsyncLocalStorage;
});

const probe = vi.hoisted(() => ({
  folds: 0,
  divisionPushes: [] as Array<{ divisionId: string; reason: string }>,
  /** The realtime endpoint never answers. */
  hangPushes: false,
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

// Public Redis calls resolve at once: this file is about the ISR tags.
vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  return {
    ...actual,
    cacheDelPattern: (pattern: string) =>
      pattern.startsWith("pub:v1:") ? Promise.resolve() : actual.cacheDelPattern(pattern),
    cacheDel: (...keys: string[]) =>
      keys.length > 0 && keys.every((key) => key.startsWith("pub:v1:"))
        ? Promise.resolve()
        : actual.cacheDel(...keys),
  };
});
// Recorded, never sent.
vi.mock("@/lib/realtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/realtime")>();
  return {
    ...actual,
    publishFixtureUpdate: async () => {},
    publishDivisionUpdate: (divisionId: string, reason: string) => {
      probe.divisionPushes.push({ divisionId, reason });
      return probe.hangPushes ? new Promise<void>(() => {}) : Promise.resolve();
    },
  };
});
vi.mock("../player-stats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../player-stats")>();
  return {
    ...actual,
    recomputePlayerStats: async (...args: Parameters<typeof actual.recomputePlayerStats>) => {
      probe.folds += 1;
      return actual.recomputePlayerStats(...args);
    },
  };
});

import { after } from "next/server";
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
import { deferred } from "@/lib/deferred";
import { competitionTag, divisionTag } from "@/server/public-site/data";
import {
  fireScoreRevalidate,
  fireStatsRevalidate,
  STATS_REFRESH_COMPETITION_PROFILE,
} from "@/server/public-site/revalidate";
import { getPublicCompetitionHub } from "@/server/public-site/competition-hub";
import { schedulePlayerStatsRefresh } from "../player-stats-refresh";
import { publicCompetitionHub } from "../public";
import { scoreEvent } from "../scoring";
import { seedOrg, startedDivisionWithFixture } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

/** `"max"`'s expiry, read from Next's own defaults rather than typed in here. */
const MAX_EXPIRE = defaultConfig.cacheLife.max.expire;

type FlushCall = { tags: string[]; durations: { expire?: number } | undefined };

const CLEAR_REFUSED =
  "player-stats: the ISR tags could not be cleared from here (inside a cache scope); the next refresh clears them";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A timestamp strictly after every earlier tag write and strictly before the
 *  next one: an entry cached at it reads expired or stale only through a LATER
 *  write. */
async function cachedJustBefore(): Promise<number> {
  await sleep(3);
  const at = Date.now();
  await sleep(3);
  return at;
}

/**
 * One request with an after-window, in the order Next runs it: the handler
 * inside both storages, ONE flush as soon as it resolves, and the `after()`
 * callbacks only once the response's `close` event fires `onClose`
 * (`app-page.js` / `app-route.js` hook `res.on("close")`). `requestCalls` is
 * what the request's flush wrote; `afterCalls` fills in when the callbacks run.
 *
 * Shapes:
 * - `route`: a route handler; `close()` sends the response.
 * - `isr-regeneration`: an ISR page regenerating in the background. Next has
 *   already sent the stale entry on this same response
 *   (`response-cache/index.js`), so `close` fired BEFORE the render and an
 *   `after()` registered during it never runs.
 * - `never-closes`: a response that never finishes (a machine stopped with the
 *   request in flight): its `after()` callbacks never run either.
 */
async function inRequestWithAfter<T>(
  handler: () => Promise<T>,
  shape: "route" | "isr-regeneration" | "never-closes" = "route",
) {
  const calls: FlushCall[] = [];
  const fsCache = new FileSystemCache({} as ConstructorParameters<typeof FileSystemCache>[0]);
  const res = new EventEmitter();
  if (shape === "isr-regeneration") res.emit("close");
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
    route: shape === "isr-regeneration" ? "/shared/[orgSlug]/[competitionSlug]" : "/api/v1/fixtures/[id]/events",
    page: shape === "isr-regeneration" ? "/shared/[orgSlug]/[competitionSlug]/page" : "/api/v1/fixtures/[id]/events/route",
    isStaticGeneration: shape === "isr-regeneration",
    incrementalCache: {
      revalidateTag: (tags: string | string[], durations?: { expire?: number }) => {
        const list = typeof tags === "string" ? [tags] : [...tags];
        calls.push({ tags: list, durations });
        return fsCache.revalidateTag(list, durations);
      },
      // `unstable_cache` always misses here: every read runs its callback.
      // Next 16.3 keys it through `generateSimpleCacheKey`; older releases
      // called `generateCacheKey`. Stub both so the harness tracks either.
      generateCacheKey: async (key: string) => key,
      generateSimpleCacheKey: async (key: string) => key,
      get: async () => null,
      set: async () => {},
    },
    cacheLifeProfiles: defaultConfig.cacheLife,
    afterContext,
  } as unknown as WorkStore;
  const workUnitStore = (
    shape === "isr-regeneration"
      ? { type: "prerender-legacy", phase: "render", revalidate: 30, tags: null, implicitTags: undefined }
      : { type: "request", phase: "action", url: { pathname: "/api/v1/probe", search: "" } }
  ) as unknown as RequestStore;
  const result = await workAsyncStorage.run(workStore, async () => {
    const value = await workUnitAsyncStorage.run(workUnitStore, handler);
    const flush = executeRevalidates(workStore);
    if (flush !== false) await flush;
    return value;
  });
  const requestCalls = [...calls];
  return {
    result,
    requestCalls,
    /** `after()` callbacks registered and not yet run. */
    pendingCallbacks: () => (afterContext as unknown as { callbackQueue: { size: number } }).callbackQueue.size,
    /** Send the response: Next runs the after-callbacks and flushes what they added. */
    close: async (): Promise<FlushCall[]> => {
      if (shape !== "route") throw new Error(`a ${shape} response never closes`);
      res.emit("close");
      await Promise.all(waitingOn);
      return calls.slice(requestCalls.length);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  probe.folds = 0;
  probe.divisionPushes.length = 0;
  probe.hangPushes = false;
  for (const fn of Object.values(logMock)) fn.mockClear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe("harness control — Next's real after-window flush", () => {
  it("repeating the score request's own tag calls inside after() lands NOTHING", async () => {
    const div = divisionTag("ctl-div");
    const comp = competitionTag("ctl-comp");
    const request = await inRequestWithAfter(async () => {
      fireScoreRevalidate("ctl-div", "ctl-comp");
      after(() => fireScoreRevalidate("ctl-div", "ctl-comp"));
      return 201;
    });
    // The request's own flush landed both tags.
    expect(request.requestCalls.flatMap((c) => c.tags).sort()).toEqual([comp, div].sort());

    const cachedAt = await cachedJustBefore();
    const afterCalls = await request.close();
    // Fired, did not throw, and never reached the cache.
    expect(afterCalls).toEqual([]);
    expect(areTagsExpired([div], cachedAt)).toBe(false);
    expect(areTagsStale([comp], cachedAt)).toBe(false);
  });

  it("fireStatsRevalidate inside after() expires the division and stales the competition", async () => {
    const div = divisionTag("stats-div");
    const comp = competitionTag("stats-comp");
    const request = await inRequestWithAfter(async () => {
      fireScoreRevalidate("stats-div", "stats-comp");
      deferred(() => fireStatsRevalidate("stats-div", "stats-comp"));
      return 201;
    });
    const cachedAt = await cachedJustBefore();
    const afterCalls = await request.close();

    expect(afterCalls).toContainEqual({ tags: [div], durations: { expire: 0 } });
    expect(afterCalls).toContainEqual({ tags: [comp], durations: { expire: MAX_EXPIRE } });
    expect(areTagsExpired([div], cachedAt), "a division entry cached before the fold is a miss").toBe(true);
    expect(areTagsExpired([comp], cachedAt)).toBe(false);
    expect(areTagsStale([comp], cachedAt)).toBe(true);
  });
});

describe("the stats profile is the app's own 'max' (review m7)", () => {
  it("STATS_REFRESH_COMPETITION_PROFILE expires with the cacheLife.max that next.config.js resolves to", async () => {
    // The app's RESOLVED config, not Next's defaults: a `cacheLife.max` override
    // in next.config.js would move "max" for the score path's
    // `revalidateTag(tag, "max")` and leave this constant behind.
    const { default: loadConfig } = await import("next/dist/server/config");
    const { PHASE_PRODUCTION_SERVER } = await import("next/constants");
    const appDir = fileURLToPath(new URL("../../../../", import.meta.url));
    const config = await loadConfig(PHASE_PRODUCTION_SERVER, appDir, { silent: true });
    expect(config.cacheLife?.max?.expire).toBeTypeOf("number");
    expect(STATS_REFRESH_COMPETITION_PROFILE.expire).toBe(config.cacheLife!.max!.expire);
  }, 60_000);
});

describe.skipIf(!HAS_DB)("a deciding score refreshes stats after the response, and its tags land", () => {
  /** A started generic division whose board already shows one row, so the
   *  refresh has something to change: `generic` credits results to entrants,
   *  and a board that is empty before and after clears nothing. */
  async function divisionWithABoard() {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const [row] = await sql<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, 'Old Leader') returning id`;
    await sql`
      insert into player_stat_snapshots (division_id, person_id, sport_key, stats, computed_through_seq)
      values (${divisionId}, ${person!.id}, 'generic', ${sql.json({ points: 1 })}, 0)`;
    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await sleep(20);
    probe.folds = 0;
    probe.divisionPushes.length = 0;
    return { auth, divisionId, fixtureId, competitionId: row!.competition_id };
  }

  it("a realtime endpoint that never answers does not hold the after-window: the tags still land", async () => {
    const { auth, divisionId, fixtureId, competitionId } = await divisionWithABoard();
    const request = await inRequestWithAfter(() =>
      scoreEvent(auth, fixtureId, {
        expected_seq: 1,
        type: "generic.result",
        payload: { p1Score: 3, p2Score: 1 },
      }),
    );
    probe.hangPushes = true;
    const pushesBeforeClose = probe.divisionPushes.length;
    const cachedAt = await cachedJustBefore();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const afterCalls = await Promise.race([
      request.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the after-window waited on the push")), 10_000);
      }),
    ]).finally(() => clearTimeout(timer));

    // The push was sent, and never answered.
    expect(probe.divisionPushes.slice(pushesBeforeClose)).toEqual([{ divisionId, reason: "score" }]);
    expect(afterCalls).toContainEqual({ tags: [divisionTag(divisionId)], durations: { expire: 0 } });
    expect(areTagsExpired([divisionTag(divisionId)], cachedAt)).toBe(true);
    expect(areTagsStale([competitionTag(competitionId)], cachedAt)).toBe(true);
  }, 60_000);

  it("scoreEvent returns with no fold; closing the response folds, lands the tags and pushes the division", async () => {
    const { auth, divisionId, fixtureId, competitionId } = await divisionWithABoard();
    const div = divisionTag(divisionId);
    const comp = competitionTag(competitionId);

    const request = await inRequestWithAfter(() =>
      scoreEvent(auth, fixtureId, {
        expected_seq: 1,
        type: "generic.result",
        payload: { p1Score: 3, p2Score: 1 },
      }),
    );
    expect(request.result.status).toBe("decided");
    // The response is ready and nothing has folded: the scorer did not wait.
    expect(probe.folds).toBe(0);
    await sleep(50);
    expect(probe.folds, "the fold waits for the response to close").toBe(0);
    const pushesBeforeClose = probe.divisionPushes.length;

    // A hub document rebuilt between the score and the fold.
    const cachedAt = await cachedJustBefore();
    const afterCalls = await request.close();

    expect(probe.folds).toBe(1);
    expect(afterCalls).toContainEqual({ tags: [div], durations: { expire: 0 } });
    expect(areTagsExpired([div], cachedAt), "the rebuilt hub entry is a miss after the fold").toBe(true);
    expect(areTagsStale([comp], cachedAt)).toBe(true);
    expect(probe.divisionPushes.slice(pushesBeforeClose)).toEqual([{ divisionId, reason: "score" }]);
    expect(logMock.warn).not.toHaveBeenCalled();
  }, 60_000);

  it("a refresh registered inside unstable_cache cannot clear the ISR tags there: it says so, and the next refresh clears them (final review m7)", async () => {
    const { auth, divisionId } = await divisionWithABoard();
    const div = divisionTag(divisionId);
    const inCache = await inRequestWithAfter(() =>
      unstable_cache(
        async () => {
          schedulePlayerStatsRefresh(auth.orgId, { divisionId });
          return 1;
        },
        ["stats-refresh-m7", divisionId],
      )(),
    );
    const refused = await inCache.close();
    expect(probe.folds).toBe(1);
    expect(refused, "revalidateTag threw E306 inside the cache scope: nothing landed").toEqual([]);
    expect(logMock.warn).toHaveBeenCalledWith(expect.objectContaining({ divisionId }), CLEAR_REFUSED);

    const cachedAt = await cachedJustBefore();
    const next = await inRequestWithAfter(async () => {
      schedulePlayerStatsRefresh(auth.orgId, { divisionId });
    });
    const afterCalls = await next.close();
    expect(probe.folds, "the snapshot is current: no second fold").toBe(1);
    expect(afterCalls, "the refused clearing is not remembered as done").toContainEqual({ tags: [div], durations: { expire: 0 } });
    expect(areTagsExpired([div], cachedAt)).toBe(true);

    const third = await inRequestWithAfter(async () => {
      schedulePlayerStatsRefresh(auth.orgId, { divisionId });
    });
    expect(await third.close(), "the owed clearing is paid once").toEqual([]);
  }, 60_000);
});

describe.skipIf(!HAS_DB)("the read-side stats check runs where after() is real (final review I1)", () => {
  /** A public generic division whose deciding result's refresh was lost: the
   *  scoring request's response never closed. */
  async function lostResult() {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const [row] = await sql<{ org_slug: string; comp_slug: string }[]>`
      select o.slug as org_slug, c.slug as comp_slug
      from divisions d join competitions c on c.id = d.competition_id join organizations o on o.id = c.org_id
      where d.id = ${divisionId}`;
    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await inRequestWithAfter(
      () => scoreEvent(auth, fixtureId, { expected_seq: 1, type: "generic.result", payload: { p1Score: 3, p2Score: 1 } }),
      "never-closes",
    );
    probe.folds = 0;
    return { divisionId, orgSlug: row!.org_slug, compSlug: row!.comp_slug };
  }
  const folded = async (divisionId: string) =>
    (await sql`select 1 from player_stat_folds where division_id = ${divisionId}`).length === 1;

  it("an ISR regeneration of the hub page registers no stats check, and the next hub poll heals the lost result", async () => {
    const s = await lostResult();
    const regen = await inRequestWithAfter(() => getPublicCompetitionHub(s.orgSlug, s.compSlug), "isr-regeneration");
    expect(regen.result, "the page's cached loader built the document").not.toBeNull();
    expect(regen.pendingCallbacks(), "nothing is registered in a render whose response already closed").toBe(0);

    const poll = await inRequestWithAfter(() => publicCompetitionHub(s.orgSlug, s.compSlug));
    await poll.close();
    expect(probe.folds, "the hub poll checked the division and queued the lost refresh").toBe(1);
    expect(await folded(s.divisionId)).toBe(true);
  }, 60_000);

  it("a check whose after() never runs frees its division once the interval has passed", async () => {
    const s = await lostResult();
    const dropped = await inRequestWithAfter(() => publicCompetitionHub(s.orgSlug, s.compSlug), "never-closes");
    expect(dropped.pendingCallbacks(), "the check was registered, and will never run").toBe(1);

    const soon = await inRequestWithAfter(() => publicCompetitionHub(s.orgSlug, s.compSlug));
    await soon.close();
    expect(probe.folds, "inside the interval the division is not checked again").toBe(0);

    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true, now: Date.now() + 61_000 });
    const later = await inRequestWithAfter(() => publicCompetitionHub(s.orgSlug, s.compSlug));
    await later.close();
    expect(probe.folds, "a minute on, the division is checked and the lost result folds").toBe(1);
    expect(await folded(s.divisionId)).toBe(true);
  }, 60_000);
});
