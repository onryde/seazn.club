// P1 (spectator surface): a score must show on the very next public read.
//
// Next flushes a route handler's revalidations ONCE, the moment the handler's
// promise resolves (app-route/module.js: `await workUnitAsyncStorage.run(
// requestStore, handler)`, then `executeRevalidates(workStore)`). A
// `revalidateTag` that arrives after that flush is pushed onto a list nothing
// reads again: no throw, no tag-manifest update. `scoreEvent` did exactly that
// (`void invalidatePublicCache(...)`, which awaited a DB lookup before firing
// the tag), so the hub JSON, the competition page and the division page kept
// serving the pre-score document until their 30s TTL ran out.
//
// Every seam below is Next's own code: the real async-local storages, the real
// `revalidateTag` (reached through revalidate.ts's production `next/cache`
// import), the real `executeRevalidates`, and the real tag manifest that
// `IncrementalCache.get` consults on the next read (`areTagsExpired` /
// `areTagsStale`). The incremental cache's writer is Next's `FileSystemCache`,
// wrapped only to record what the flush handed it; `@/lib/cache`,
// `@/lib/realtime` and revalidate.ts are passthroughs that record (one case
// makes the score's tag call throw). There is no `vi.waitFor`
// anywhere: the flush runs the instant the use-case resolves, and so do the
// assertions — that timing IS the property under test.
//
// Real Postgres required; the DB cases skip without DATABASE_URL. The harness
// control needs no database and always runs, so a red below cannot be a harness
// that never reached Next's storages.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Next's node environment installs this global before any server module
  // loads; without it Next's storages are a fake that throws on `run` (E504).
  const g = globalThis as { AsyncLocalStorage?: unknown };
  g.AsyncLocalStorage ??= process.getBuiltinModule("node:async_hooks").AsyncLocalStorage;
});

const probe = vi.hoisted(() => ({
  store: null as { pendingRevalidatedTags?: Array<{ tag: string }> } | null,
  sweeps: [] as Array<{ pattern: string; pendingAtCall: string[] }>,
  gates: [] as Array<() => void>,
  divisionPushes: [] as Array<{ divisionId: string; reason: string }>,
  failScoreTag: false,
  slowImportLookupMs: 0,
}));

// The public Redis sweeps are recorded, with the tags already pending in the
// request at the moment each sweep STARTED, and held open until the test
// releases them. A use-case that waits on a sweep therefore never resolves,
// and `unblocked` below reports that as a failure instead of a hang.
vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  return {
    ...actual,
    cacheDelPattern: (pattern: string) => {
      if (!pattern.startsWith("pub:v1:")) return actual.cacheDelPattern(pattern);
      probe.sweeps.push({
        pattern,
        pendingAtCall: (probe.store?.pendingRevalidatedTags ?? []).map((t) => t.tag),
      });
      return new Promise<void>((resolve) => probe.gates.push(resolve));
    },
  };
});
vi.mock("@/lib/realtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/realtime")>();
  return {
    ...actual,
    publishDivisionUpdate: (
      divisionId: string,
      reason: Parameters<typeof actual.publishDivisionUpdate>[1],
    ) => {
      probe.divisionPushes.push({ divisionId, reason });
      return actual.publishDivisionUpdate(divisionId, reason);
    },
  };
});
vi.mock("@/server/public-site/revalidate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/public-site/revalidate")>();
  return {
    ...actual,
    fireScoreRevalidate: (divisionId: string, competitionId: string) => {
      if (probe.failScoreTag) throw new Error("simulated invalidation failure");
      return actual.fireScoreRevalidate(divisionId, competitionId);
    },
  };
});
// The importer's lookup, slowed on request. `importEvents` still awaits a lock
// release after a stream's side effects, so a voided invalidation usually loses
// that race and sometimes wins it: with `void` put back the import case went
// red in 2 runs of 3. A slow lookup — the shape P1 takes under load — makes
// "did the importer wait for it" deterministic. `scoreEvent` calls scoring.ts's
// own binding, so only the importer's call goes through this wrapper.
vi.mock("../scoring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scoring")>();
  return {
    ...actual,
    invalidatePublicCache: async (...args: Parameters<typeof actual.invalidatePublicCache>) => {
      if (probe.slowImportLookupMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, probe.slowImportLookupMs));
      }
      return actual.invalidatePublicCache(...args);
    },
  };
});

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
import { competitionTag, divisionTag } from "@/server/public-site/data";
import { fireDivisionRevalidate, fireScoreRevalidate } from "@/server/public-site/revalidate";
import { scoreEvent } from "../scoring";
import { importEvents } from "../event-import";
import { decidingStream, seedOrg, startedDivisionWithFixture } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

/** `"max"`'s expiry, read from Next's own defaults rather than typed in here. */
const MAX_EXPIRE = defaultConfig.cacheLife.max.expire;

/** Far above one write's cost, well inside the 30s test timeout. */
const SWEEP_BUDGET_MS = 15_000;

type Durations = { expire?: number } | undefined;
type FlushCall = { tags: string[]; durations: Durations };

/** One route-handler request, in the order app-route/module.js runs it: the
 *  handler inside both storages, then ONE flush as soon as it resolves. */
async function inRequest<T>(handler: () => Promise<T>): Promise<{ result: T; calls: FlushCall[] }> {
  const calls: FlushCall[] = [];
  const fsCache = new FileSystemCache({} as ConstructorParameters<typeof FileSystemCache>[0]);
  const workStore = {
    route: "/api/v1/fixtures/[id]/events",
    page: "/api/v1/fixtures/[id]/events/route",
    incrementalCache: {
      revalidateTag: (tags: string | string[], durations?: { expire?: number }) => {
        const list = typeof tags === "string" ? [tags] : [...tags];
        calls.push({ tags: list, durations });
        return fsCache.revalidateTag(list, durations);
      },
    },
    cacheLifeProfiles: defaultConfig.cacheLife,
  } as unknown as WorkStore;
  const requestStore = { type: "request", phase: "action" } as unknown as RequestStore;
  probe.store = workStore;
  probe.sweeps.length = 0;
  probe.divisionPushes.length = 0;
  return workAsyncStorage.run(workStore, async () => {
    const result = await workUnitAsyncStorage.run(requestStore, handler);
    const flush = executeRevalidates(workStore);
    if (flush !== false) await flush;
    return { result, calls };
  });
}

async function unblocked<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const blocked = new Promise<"blocked">((resolve) => {
    timer = setTimeout(() => resolve("blocked"), SWEEP_BUDGET_MS);
  });
  const outcome = await Promise.race([work, blocked]);
  clearTimeout(timer);
  expect(outcome, "the use-case waited on a public Redis sweep").not.toBe("blocked");
  return outcome as T;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A timestamp strictly before the next flush and strictly after every earlier
 *  one, so only THIS request's tag write can make an entry cached at it read
 *  as expired or stale. */
async function cachedJustBefore(): Promise<number> {
  await sleep(3);
  const at = Date.now();
  await sleep(3);
  return at;
}

async function competitionOf(divisionId: string): Promise<string> {
  const [row] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`;
  return row!.competition_id;
}

afterEach(() => {
  for (const release of probe.gates.splice(0)) release();
  probe.store = null;
  probe.failScoreTag = false;
  probe.slowImportLookupMs = 0;
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe("harness control — this is Next's real per-request flush", () => {
  it("a tag fired before the handler resolves reaches the flush; the same tag fired after it is dropped", async () => {
    const inside = await inRequest(async () => {
      fireDivisionRevalidate("div-in", "comp-in");
      return 201;
    });
    expect(inside.calls).toEqual([
      { tags: [divisionTag("div-in"), competitionTag("comp-in")], durations: { expire: MAX_EXPIRE } },
    ]);

    let landed: Promise<void> = Promise.resolve();
    const late = await inRequest(async () => {
      landed = (async () => {
        await sleep(5);
        fireDivisionRevalidate("div-late", "comp-late");
      })();
      return 201;
    });
    await landed;
    // Fired, did not throw, and never reached the cache: the defect's shape.
    expect(late.calls).toEqual([]);
    expect(areTagsStale([divisionTag("div-late")], 0)).toBe(false);
  });
});

describe("fireScoreRevalidate through Next's real flush and tag manifest", () => {
  // A score request can also fire the stale-while-revalidate helper for its
  // OWN division: `completeStage` (reached from scoreEvent's auto-advance)
  // voids `fireStageRevalidate`, whose lookup may land before or after the
  // score's own tag. A flush groups tags by profile in first-seen order and the
  // tag manifest is last-write-wins, so both orders are enumerated here.
  it.each([
    ["the score's expiry first, a 'max' for the same division after it", "after"],
    ["a 'max' for the same division first, the score's expiry after it", "before"],
  ] as const)("%s: the division entry is still a miss", async (_label, maxLands) => {
    const id = `order-${maxLands}`;
    const div = divisionTag(`div-${id}`);
    const comp = competitionTag(`comp-${id}`);
    const cachedAt = await cachedJustBefore();
    await inRequest(async () => {
      if (maxLands === "before") fireDivisionRevalidate(`div-${id}`, `comp-${id}`);
      fireScoreRevalidate(`div-${id}`, `comp-${id}`);
      if (maxLands === "after") fireDivisionRevalidate(`div-${id}`, `comp-${id}`);
      return 201;
    });
    expect(areTagsExpired([div], cachedAt), "division entry is a miss").toBe(true);
    expect(areTagsExpired([comp], cachedAt)).toBe(false);
    expect(areTagsStale([comp], cachedAt)).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("a score lands its public-cache tags inside the request (P1)", () => {
  it("scoreEvent: the division tag EXPIRES and the competition tag goes stale, on the start AND the deciding write", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const competitionId = await competitionOf(divisionId);
    const div = divisionTag(divisionId);
    const comp = competitionTag(competitionId);

    const writes = [
      { expected_seq: 0, type: "core.start", payload: {} },
      { expected_seq: 1, type: "generic.result", payload: { p1Score: 3, p2Score: 1 } },
    ];
    for (const write of writes) {
      // An entry the hub / division page cached just before this write.
      const cachedAt = await cachedJustBefore();
      const { result, calls } = await unblocked(inRequest(() => scoreEvent(auth, fixtureId, write)));
      expect(result.seq, write.type).toBe(write.expected_seq + 1);

      // What the flush handed the incremental cache.
      expect(calls, write.type).toContainEqual({ tags: [div], durations: { expire: 0 } });
      expect(calls.flatMap((c) => c.tags), write.type).toContain(comp);
      expect(
        calls.filter((c) => c.tags.includes(comp)).map((c) => c.durations),
        write.type,
      ).toEqual([{ expire: MAX_EXPIRE }]);

      // What the NEXT public read sees. `pub-div` / `pub-hub-v2` carry the
      // division tag, so an expired tag makes them a miss rebuilt with the
      // score — not one more stale read. The competition tag keeps SWR.
      expect(areTagsExpired([div], cachedAt), `${write.type}: division entry is a miss`).toBe(true);
      expect(areTagsExpired([comp, div], cachedAt), write.type).toBe(true);
      expect(areTagsExpired([comp], cachedAt), write.type).toBe(false);
      expect(areTagsStale([comp], cachedAt), write.type).toBe(true);

      // The Redis sweeps still run, and each one started only AFTER the tag
      // was pending — a sweep first lets a hub rebuild re-cache the stale doc.
      expect(probe.sweeps.map((s) => s.pattern), write.type).toEqual(
        expect.arrayContaining([
          `pub:v1:fixture:${fixtureId}`,
          `pub:v1:div:${divisionId}:*`,
          `pub:v1:hub:${competitionId}`,
        ]),
      );
      for (const sweep of probe.sweeps) {
        expect(sweep.pendingAtCall, `${write.type}: ${sweep.pattern}`).toContain(div);
      }

      // The division realtime push is addressed from the invalidation's own
      // lookup (one query where there were two) and has gone out, exactly
      // once, by the time scoreEvent resolves.
      expect(
        probe.divisionPushes.filter((p) => p.reason === "score"),
        write.type,
      ).toEqual([{ divisionId, reason: "score" }]);
    }
  });

  it("importEvents: an imported stream lands the same tags inside the import request", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const competitionId = await competitionOf(divisionId);
    const div = divisionTag(divisionId);
    const comp = competitionTag(competitionId);

    const cachedAt = await cachedJustBefore();
    probe.slowImportLookupMs = 250;
    const { result, calls } = await unblocked(
      inRequest(() =>
        importEvents(auth, divisionId, {
          import_id: "imp-p1-in-request",
          streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
        }),
      ),
    );
    expect(result.results[0]!.status).toBe("imported");

    expect(calls).toContainEqual({ tags: [div], durations: { expire: 0 } });
    expect(areTagsExpired([div], cachedAt), "division entry is a miss").toBe(true);
    expect(areTagsExpired([comp], cachedAt)).toBe(false);
    expect(areTagsStale([comp], cachedAt)).toBe(true);
    for (const sweep of probe.sweeps) {
      expect(sweep.pendingAtCall, sweep.pattern).toContain(div);
    }
  });

  it("a failed invalidation is logged, never thrown: the committed score still resolves", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    probe.failScoreTag = true;

    const { result } = await unblocked(
      inRequest(() => scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} })),
    );
    expect(result.seq).toBe(1);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(n).toBe(1);
  });
});
