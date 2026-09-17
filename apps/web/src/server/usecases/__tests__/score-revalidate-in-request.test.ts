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
  // One entry per public Redis CALL: a literal-key DEL carries every key it was
  // handed, a SCAN sweep carries its one pattern (R10 H4).
  sweeps: [] as Array<{ kind: "del" | "scan"; targets: string[]; pendingAtCall: string[] }>,
  gates: [] as Array<{
    kind: "del" | "scan";
    targets: string[];
    resolve: () => void;
    reject: (err: unknown) => void;
  }>,
  fixturePushes: [] as Array<{ fixtureId: string; reason: string }>,
  divisionPushes: [] as Array<{ divisionId: string; reason: string }>,
  failScoreTag: false,
  failOnDecided: null as Error | null,
  // R10 M3: `scoreEvent` calls scoring.ts's own `onDecided` binding, which no
  // module mock reaches. Its standings recompute (engine-db) is the dependency
  // made to throw instead, so the real `onDecided` throws inside scoreEvent.
  failStandings: null as Error | null,
  standingsAttempts: 0,
  slowImportLookupMs: 0,
}));

// The logger, replaced whole (a spy on the pino singleton keeps its call
// history across tests). Nothing in `src` calls `log.child`.
const logMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
}));
vi.mock("@/server/logger", () => ({ log: logMock }));

// The public Redis calls are recorded, with the tags already pending in the
// request at the moment each one STARTED, and held open until the test
// releases them. That covers every literal-key DEL (`cacheDel`) and every SCAN
// sweep (`cacheDelPattern`). A use-case that waits on one therefore never
// resolves, and `unblocked` below reports that as a failure instead of a hang.
vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  const hold = (kind: "del" | "scan", targets: string[]) => {
    probe.sweeps.push({
      kind,
      targets,
      pendingAtCall: (probe.store?.pendingRevalidatedTags ?? []).map((t) => t.tag),
    });
    return new Promise<void>((resolve, reject) => probe.gates.push({ kind, targets, resolve, reject }));
  };
  return {
    ...actual,
    cacheDelPattern: (pattern: string) =>
      pattern.startsWith("pub:v1:") ? hold("scan", [pattern]) : actual.cacheDelPattern(pattern),
    cacheDel: (...keys: string[]) =>
      keys.length > 0 && keys.every((key) => key.startsWith("pub:v1:"))
        ? hold("del", keys)
        : actual.cacheDel(...keys),
  };
});
vi.mock("@/lib/realtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/realtime")>();
  return {
    ...actual,
    publishFixtureUpdate: (
      fixtureId: string,
      reason: Parameters<typeof actual.publishFixtureUpdate>[1],
    ) => {
      probe.fixturePushes.push({ fixtureId, reason });
      return actual.publishFixtureUpdate(fixtureId, reason);
    },
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
vi.mock("@/server/engine-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/engine-db")>();
  return {
    ...actual,
    recomputeStandings: async (...args: Parameters<typeof actual.recomputeStandings>) => {
      if (probe.failStandings) {
        probe.standingsAttempts += 1;
        throw probe.failStandings;
      }
      return actual.recomputeStandings(...args);
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
    // The importer's FIRST post-commit hook, made to throw on request (F3).
    onDecided: async (...args: Parameters<typeof actual.onDecided>) => {
      if (probe.failOnDecided) throw probe.failOnDecided;
      return actual.onDecided(...args);
    },
  };
});

import { workAsyncStorage, type WorkStore } from "next/dist/server/app-render/work-async-storage.external";
import {
  workUnitAsyncStorage,
  type RequestStore,
} from "next/dist/server/app-render/work-unit-async-storage.external";
import { AfterContext } from "next/dist/server/after/after-context";
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
    // A real route handler always has an after-window. Without one, `after()`
    // throws and `lib/deferred.ts` runs the task inline, so the player-stats
    // refresh a deciding write schedules would fire its own tags into THIS
    // request's flush. The response never closes here, so after-work never runs:
    // `player-stats-refresh-after.test.ts` covers what it lands.
    afterContext: new AfterContext({ waitUntil: () => {}, onClose: () => {}, onTaskError: undefined }),
  } as unknown as WorkStore;
  const requestStore = { type: "request", phase: "action" } as unknown as RequestStore;
  probe.store = workStore;
  // Sweeps a PREVIOUS write left held (the rig's own `startDivision` runs
  // `afterScheduleWrite`) are not this request's: let them finish.
  for (const gate of probe.gates.splice(0)) gate.resolve();
  // R10c m1: that schedule write's division push waits on its hub DEL, so it
  // goes out only once the release above has run through its chain. Let it
  // land before the recorders are cleared, or it reads as this request's push.
  await sleep(20);
  probe.sweeps.length = 0;
  probe.fixturePushes.length = 0;
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

/** Settle the held public Redis calls: all of them, or only one kind (`"del"`
 *  for the literal-key DEL, `"scan"` for the glob sweep). Control comes back
 *  only after a macrotask, so every microtask the settlement queues (a push
 *  chained on it, Node's unhandled-rejection report) has already run. */
async function settleSweeps(
  outcome: { resolve: true } | { reject: Error },
  only?: "del" | "scan",
): Promise<void> {
  const settling = probe.gates.filter((g) => only === undefined || g.kind === only);
  probe.gates = probe.gates.filter((g) => !settling.includes(g));
  for (const gate of settling) {
    if ("reject" in outcome) gate.reject(outcome.reject);
    else gate.resolve();
  }
  await sleep(20);
}

const SWEEP_FAILED = "scoring: a public Redis sweep failed (the write stands)";
const DELETE_FAILED = "scoring: a public Redis delete failed (the write stands)";

/** Every target the recorded public Redis calls of one kind were handed. */
const targetsOf = (kind: "del" | "scan") =>
  probe.sweeps.filter((sweep) => sweep.kind === kind).flatMap((sweep) => sweep.targets);

/** Every `log.error` message so far — for the quiet-twin checks. */
const errorMessages = () => logMock.error.mock.calls.map((call) => call[1]);

afterEach(() => {
  for (const gate of probe.gates.splice(0)) gate.resolve();
  probe.store = null;
  probe.failScoreTag = false;
  probe.failOnDecided = null;
  probe.failStandings = null;
  probe.standingsAttempts = 0;
  probe.slowImportLookupMs = 0;
  for (const fn of Object.values(logMock)) fn.mockClear();
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

      // The public Redis deletes still run, and each one started only AFTER
      // the tag was pending: a delete first lets a hub rebuild re-cache the
      // stale doc. R10 H4: the two LITERAL keys go out in one direct DEL, and
      // only the division glob is a SCAN.
      expect(targetsOf("del"), write.type).toEqual(
        expect.arrayContaining([`pub:v1:fixture:${fixtureId}`, `pub:v1:hub:${competitionId}`]),
      );
      expect(targetsOf("scan"), write.type).toEqual(expect.arrayContaining([`pub:v1:div:${divisionId}:*`]));
      expect(
        targetsOf("scan").filter((pattern) => !pattern.endsWith("*")),
        `${write.type}: a literal key sent through a SCAN`,
      ).toEqual([]);
      for (const sweep of probe.sweeps) {
        expect(sweep.pendingAtCall, `${write.type}: ${sweep.kind} ${sweep.targets.join(" ")}`).toContain(div);
      }

      // F2 (P1 round 2): scoreEvent has resolved while the DEL and the SCAN
      // are both still held (`unblocked` above), and NO realtime push has gone
      // out. A spectator page refetches on a push, and a refetch that beats the
      // delete reads the old Redis copy. Both channels have public receivers:
      // `fixture:{id}` feeds the match centre (`pub:v1:fixture:{id}`), and
      // `division:{id}` feeds the hub (`pub:v1:hub:{competitionId}`).
      expect(probe.gates.map((g) => g.kind).sort(), `${write.type}: DEL and SCAN still held`).toEqual([
        "del",
        "scan",
      ]);
      expect(probe.fixturePushes, `${write.type}: fixture push before the DEL settled`).toEqual([]);
      expect(probe.divisionPushes, `${write.type}: division push before the DEL settled`).toEqual([]);

      // R10 H4: the pushes wait on the DEL alone. It settles while the SCAN is
      // still walking the keyspace, and both pushes go out now, each exactly
      // once. The division push is addressed from the invalidation's own lookup
      // (one query where there were two).
      await settleSweeps({ resolve: true }, "del");
      expect(probe.gates.map((g) => g.kind), `${write.type}: the SCAN is still held`).toEqual(["scan"]);
      expect(probe.fixturePushes, write.type).toEqual([{ fixtureId, reason: "event" }]);
      expect(probe.divisionPushes, write.type).toEqual([{ divisionId, reason: "score" }]);

      await settleSweeps({ resolve: true }, "scan");
      expect(probe.fixturePushes, `${write.type}: pushed again once the SCAN settled`).toHaveLength(1);
      expect(probe.divisionPushes, `${write.type}: pushed again once the SCAN settled`).toHaveLength(1);
      expect(errorMessages(), write.type).not.toContain(SWEEP_FAILED);
      expect(errorMessages(), write.type).not.toContain(DELETE_FAILED);
    }
  });

  it("a public Redis SCAN and DEL that both REJECT: the pushes wait for the DEL alone and still go out; both failures are logged and nothing is left unhandled", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const competitionId = await competitionOf(divisionId);
    const fixtureKey = `pub:v1:fixture:${fixtureId}`;
    const hubKey = `pub:v1:hub:${competitionId}`;
    const divisionGlob = `pub:v1:div:${divisionId}:*`;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await unblocked(
        inRequest(() => scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} })),
      );
      expect(probe.gates.map((g) => g.kind).sort()).toEqual(["del", "scan"]);
      expect(targetsOf("del").sort()).toEqual([fixtureKey, hubKey].sort());
      expect(targetsOf("scan")).toEqual([divisionGlob]);

      // The SCAN fails first, while the DEL is still in flight.
      const failure = new Error("simulated Redis failure");
      await settleSweeps({ reject: failure }, "scan");
      // F4: checked first, the moment the SCAN has failed. Handled, and logged.
      expect(unhandled, "a voided SCAN rejected with no handler").toEqual([]);
      expect(logMock.error).toHaveBeenCalledWith(
        { err: failure, fixture: fixtureId, pattern: divisionGlob },
        SWEEP_FAILED,
      );
      // And it releases nothing: a push now would send a hub spectator to the
      // hub key, which is not gone yet.
      expect(probe.fixturePushes, "fixture push before the DEL settled").toEqual([]);
      expect(probe.divisionPushes, "division push before the DEL settled").toEqual([]);

      // Then the DEL fails too.
      await settleSweeps({ reject: failure }, "del");
      expect(unhandled, "a DEL rejected with no handler").toEqual([]);
      expect(logMock.error).toHaveBeenCalledWith(
        { err: failure, fixture: fixtureId, keys: expect.arrayContaining([fixtureKey, hubKey]) },
        DELETE_FAILED,
      );
      // A failed DEL does not swallow the pushes.
      expect(probe.fixturePushes).toEqual([{ fixtureId, reason: "event" }]);
      expect(probe.divisionPushes).toEqual([{ divisionId, reason: "score" }]);
      expect(errorMessages().filter((m) => m === SWEEP_FAILED)).toHaveLength(1);
      expect(errorMessages().filter((m) => m === DELETE_FAILED)).toHaveLength(1);
      expect(unhandled, "a voided rejection with no handler").toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
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
      expect(sweep.pendingAtCall, `${sweep.kind} ${sweep.targets.join(" ")}`).toContain(div);
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
    expect(logMock.error).toHaveBeenCalledWith(
      { err: new Error("simulated invalidation failure"), fixture: fixtureId },
      "scoring: public cache invalidation failed (the score stands)",
    );
    // It failed before any sweep started, so there is nothing to wait for:
    // the scorer's other devices (which read the ledger, not Redis) still get
    // their ping at once. No division push — the lookup is what addresses it.
    expect(probe.gates).toEqual([]);
    expect(probe.fixturePushes).toEqual([{ fixtureId, reason: "event" }]);
    expect(probe.divisionPushes).toEqual([]);
  });

  // R10 M3. `onDecided` / `refreshDiscipline` / `refreshNews` run after the
  // event has COMMITTED. A throw there used to skip the invalidation and both
  // pushes, so the public pages kept serving a score that already stood: the
  // shape F3 fixed in event-import.ts.
  /** A deciding write whose standings recompute throws, run the way the route
   *  handler runs it: a thrown error becomes the response and the handler still
   *  RESOLVES, so Next's flush runs either way. `result` is what the caller got. */
  async function decidingWriteWithAThrowingHook(auth: Parameters<typeof scoreEvent>[0], fixtureId: string) {
    // The start decides nothing, so it runs no hook; its own deletes are released.
    await unblocked(
      inRequest(() => scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} })),
    );
    await settleSweeps({ resolve: true });
    const hookFailure = new Error("simulated standings failure");
    probe.failStandings = hookFailure;
    const cachedAt = await cachedJustBefore();
    const run = await unblocked(
      inRequest(async () => {
        try {
          return await scoreEvent(auth, fixtureId, {
            expected_seq: 1,
            type: "generic.result",
            payload: { p1Score: 3, p2Score: 1 },
          });
        } catch (err) {
          return err;
        }
      }),
    );
    return { ...run, hookFailure, cachedAt };
  }

  it("scoreEvent: a post-commit hook that THROWS still lands the tags inside the request and still sends both pushes; the caller receives the hook's own error (R10 M3)", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const competitionId = await competitionOf(divisionId);
    const div = divisionTag(divisionId);
    const comp = competitionTag(competitionId);

    const { result, calls, hookFailure, cachedAt } = await decidingWriteWithAThrowingHook(auth, fixtureId);

    // The premise: the hook really ran and really threw, and the error reached
    // the caller unchanged.
    expect(probe.standingsAttempts, "the standings recompute never ran").toBe(1);
    expect(result, "the caller did not receive the hook's own error").toBe(hookFailure);
    // The score stands.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(n).toBe(2);

    // The invalidation ran anyway, in time for the flush.
    expect(calls, "a throwing hook skipped the tag").toContainEqual({ tags: [div], durations: { expire: 0 } });
    expect(areTagsExpired([div], cachedAt), "division entry is a miss").toBe(true);
    expect(areTagsStale([comp], cachedAt)).toBe(true);
    expect(targetsOf("del")).toEqual(
      expect.arrayContaining([`pub:v1:fixture:${fixtureId}`, `pub:v1:hub:${competitionId}`]),
    );

    // And the pushes still wait for the DEL, then go out once each.
    expect(probe.fixturePushes, "fixture push before the DEL settled").toEqual([]);
    await settleSweeps({ resolve: true }, "del");
    expect(probe.fixturePushes, "a throwing hook skipped the fixture push").toEqual([{ fixtureId, reason: "event" }]);
    expect(probe.divisionPushes, "a throwing hook skipped the division push").toEqual([
      { divisionId, reason: "score" },
    ]);
    expect(errorMessages()).not.toContain("scoring: public cache invalidation failed (the score stands)");
  });

  it("scoreEvent: when the hook throws AND the invalidation fails, the caller still receives the HOOK's error, and the invalidation failure is only logged (R10 M3)", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    probe.failScoreTag = true;

    const { result, hookFailure } = await decidingWriteWithAThrowingHook(auth, fixtureId);

    expect(probe.standingsAttempts).toBe(1);
    expect(result, "the invalidation failure replaced the hook's error").toBe(hookFailure);
    expect(logMock.error).toHaveBeenCalledWith(
      { err: new Error("simulated invalidation failure"), fixture: fixtureId },
      "scoring: public cache invalidation failed (the score stands)",
    );
    expect(probe.fixturePushes).toEqual([{ fixtureId, reason: "event" }]);
  });

  // F3 (P1 round 2). The invalidation used to run after the post-commit try
  // unconditionally; round 1 moved it last INSIDE the try, so a throwing hook
  // skipped it and the public pages stayed on pre-import content for their TTL.
  it("importEvents: a post-commit hook that THROWS still lands the tags inside the request, and its error still reaches the importer's own catch", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const competitionId = await competitionOf(divisionId);
    const div = divisionTag(divisionId);
    const comp = competitionTag(competitionId);
    const hookFailure = new Error("simulated onDecided failure");

    const cachedAt = await cachedJustBefore();
    probe.slowImportLookupMs = 250;
    probe.failOnDecided = hookFailure;
    const { result, calls } = await unblocked(
      inRequest(() =>
        importEvents(auth, divisionId, {
          import_id: "imp-p1-hook-throws",
          streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
        }),
      ),
    );

    // The hook's error takes exactly the path it took before: logged by the
    // post-commit catch, and the committed stream still reports `imported`.
    expect(logMock.error).toHaveBeenCalledWith(
      { err: hookFailure, fixture: fixtureId },
      "event-import: a post-commit side effect failed (the import itself stands)",
    );
    expect(result.results[0]!.status).toBe("imported");

    // And the invalidation ran anyway, in time for the flush.
    expect(calls).toContainEqual({ tags: [div], durations: { expire: 0 } });
    expect(areTagsExpired([div], cachedAt), "division entry is a miss").toBe(true);
    expect(areTagsStale([comp], cachedAt)).toBe(true);
    expect(targetsOf("del")).toContain(`pub:v1:hub:${competitionId}`);
  });

  it("importEvents: a failed invalidation is logged by its OWN catch and the imported stream still reports imported", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    probe.failScoreTag = true;

    const { result } = await unblocked(
      inRequest(() =>
        importEvents(auth, divisionId, {
          import_id: "imp-p1-invalidation-throws",
          streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
        }),
      ),
    );
    expect(result.results[0]!.status).toBe("imported");
    expect(logMock.error).toHaveBeenCalledWith(
      { err: new Error("simulated invalidation failure"), fixture: fixtureId },
      "event-import: public cache invalidation failed (the import itself stands)",
    );
    // The hooks did not fail, so the post-commit catch has nothing to say.
    expect(errorMessages()).not.toContain(
      "event-import: a post-commit side effect failed (the import itself stands)",
    );
  });
});
