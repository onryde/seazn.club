// Spectator surface W2, Task 4 — the competition hub's Redis key drops on
// BOTH write paths.
//
// The hub document (`pub:v1:hub:{competitionId}`, usecases/public.ts) is
// competition-scoped and carries every division's live scores, kick-off times
// and venues. Two different writes make it stale and they live in two
// different files:
//
//   * a SCORE write        → `invalidatePublicCache` (usecases/scoring.ts)
//   * a SCHEDULE write     → `afterScheduleWrite`    (usecases/schedule.ts)
//
// The second is the one a first draft missed: the task's own file list named
// only the scoring path, so a reschedule would have left the hub advertising a
// kick-off that had moved — which costs a spectator the trip, and is exactly
// the class of gap a "cache is invalidated on write" claim hides.
//
// SUPERSET assertions, never an exact key set. Two later tasks in this wave add
// their own keys to `invalidatePublicCache`; pinning the exact set would red
// them for no reason (ruling R-E). What is asserted is that the keys THIS task
// owns are dropped, and that the ones it did not touch still are.
//
// R10 H4 — on the SCORING path the two LITERAL keys (`pub:v1:fixture:{id}`,
// `pub:v1:hub:{competitionId}`) go out in one direct DEL (`cacheDel`), and only
// the division's glob (`pub:v1:div:{id}:*`) is still a SCAN over the whole
// keyspace (`cacheDelPattern`). The realtime pushes wait on the DEL alone.
// Which door each key goes through is asserted as "no literal key through a
// SCAN, no glob through DEL", which keeps the key sets supersets (R-E).
//
// R10 I1 — the pushes wait for that DEL, but never longer than
// PUSH_AFTER_DELETE_BOUND_MS. ioredis has no command timeout, so a Redis that
// stops answering without dropping the connection would otherwise hold every
// push forever, and exactly once either way.
//
// R10c m1 — the SCHEDULE path gets the same shape. Its hub key is literal, so
// it goes out in one DEL, and only the division glob is still a SCAN. Its
// division push waits on that DEL, never longer than the bound, exactly once.
// Both paths send through ONE helper (`sendAfterDeleteOrBound`, lib/cache.ts),
// so the two describes below that pin the bound are two witnesses of it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Typed on the parameter so `patterns()` below reads `string`, not `unknown` —
// `void pattern` rather than an underscore prefix because this config's
// no-unused-vars has no `argsIgnorePattern`.
const cacheDelPattern = vi.hoisted(() =>
  vi.fn((pattern: string) => {
    void pattern;
  }),
);
const cacheDel = vi.hoisted(() =>
  vi.fn((...keys: string[]) => {
    void keys;
  }),
);
const fireDivisionRevalidate = vi.hoisted(() => vi.fn());
const fireScoreRevalidate = vi.hoisted(() => vi.fn());
const publishDivisionUpdate = vi.hoisted(() => vi.fn(async () => {}));
const publishFixtureUpdate = vi.hoisted(() =>
  vi.fn(async (fixtureId: string, reason: string) => {
    void fixtureId;
    void reason;
  }),
);
const withTenant = vi.hoisted(() => vi.fn());
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

// How every mocked Redis call settles: at once by default (rejecting when
// `failDel` / `failScan` is set), or, with `hold`, left pending in `held` until
// the test releases it. Production code always gets a FRESH promise, never the
// spy's own return value. A `vi.fn` attaches handlers to any promise it returns
// (to record `settledResults`), which marks a rejection HANDLED, so a test
// built on `mockRejectedValue` can never see an unhandled rejection.
const redis = vi.hoisted(() => {
  type Kind = "del" | "scan";
  const state = {
    hold: false,
    failDel: null as Error | null,
    failScan: null as Error | null,
    held: [] as Array<{ kind: Kind; target: string; resolve: () => void; reject: (err: unknown) => void }>,
    settle(kind: Kind, target: string): Promise<void> {
      if (state.hold) {
        return new Promise<void>((resolve, reject) => state.held.push({ kind, target, resolve, reject }));
      }
      const failure = kind === "del" ? state.failDel : state.failScan;
      return failure ? Promise.reject(failure) : Promise.resolve();
    },
  };
  return state;
});
vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheDelPattern: (pattern: string) => {
    cacheDelPattern(pattern);
    return redis.settle("scan", pattern);
  },
  cacheDel: (...keys: string[]) => {
    cacheDel(...keys);
    return redis.settle("del", keys.join(" "));
  },
}));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  withTenant,
}));
vi.mock("@/server/public-site/revalidate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/revalidate")>()),
  fireDivisionRevalidate,
  fireScoreRevalidate,
}));
vi.mock("@/lib/realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/realtime")>()),
  publishDivisionUpdate,
  publishFixtureUpdate,
}));

import { PUSH_AFTER_DELETE_BOUND_MS } from "@/lib/cache";
import { invalidatePublicCache } from "../scoring";
import { SCHEDULE_FIXTURE_PUSH_CAP, afterScheduleWrite } from "../schedule";

const ORG = "org-1";
const FIXTURE = "fx-1";
const DIVISION = "div-1";
const COMPETITION = "comp-1";
const FIXTURE_KEY = `pub:v1:fixture:${FIXTURE}`;
const HUB_KEY = `pub:v1:hub:${COMPETITION}`;
const DIVISION_GLOB = `pub:v1:div:${DIVISION}:*`;
/** Task 14 — the player page's match lines are keyed per PERSON under a
 *  per-competition generation token. Deleting the token retires every one of
 *  them, so a score write never has to SCAN for them. Spelled out here rather
 *  than imported, so a drift in the production spelling reds. */
const PLAYER_MATCHES_GEN_KEY = `pub:v1:player-matches-gen:${COMPETITION}`;
const SWEEP_FAILED = "scoring: a public Redis sweep failed (the write stands)";
const DELETE_FAILED = "scoring: a public Redis delete failed (the write stands)";
const SCHEDULE_SWEEP_FAILED = "schedule: a public Redis sweep failed (the write stands)";
const SCHEDULE_DELETE_FAILED = "schedule: a public Redis delete failed (the write stands)";

const patterns = () => cacheDelPattern.mock.calls.map(([pattern]) => pattern);
const deletedKeys = () => cacheDel.mock.calls.flat();

const macrotask = () => new Promise((resolve) => setTimeout(resolve, 20));

type Outcome = { resolve: true } | { reject: Error };

/** Settle every held call of one kind, synchronously. */
function settle(kind: "del" | "scan", outcome: Outcome): void {
  const settling = redis.held.filter((gate) => gate.kind === kind);
  redis.held = redis.held.filter((gate) => gate.kind !== kind);
  for (const gate of settling) {
    if ("reject" in outcome) gate.reject(outcome.reject);
    else gate.resolve();
  }
}

/** Settle every held call of one kind, then return only after a macrotask,
 *  so every microtask the settlement queues (a callback chained on it, Node's
 *  unhandled-rejection report) has already run. */
async function release(kind: "del" | "scan", outcome: Outcome): Promise<void> {
  settle(kind, outcome);
  await macrotask();
}

/** `release` for fake timers: settle the held calls of one kind, then flush
 *  every microtask that queues without moving the clock. */
async function settleHeld(kind: "del" | "scan", outcome: Outcome): Promise<void> {
  settle(kind, outcome);
  await vi.advanceTimersByTimeAsync(0);
}

/** Every unhandled rejection raised while `body` runs. */
async function watchingUnhandled(body: (unhandled: unknown[]) => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await body(unhandled);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  redis.hold = false;
  redis.failDel = null;
  redis.failScan = null;
  redis.held = [];
  withTenant.mockResolvedValue({
    division_id: DIVISION,
    competition_id: COMPETITION,
    org_id: ORG,
    discoverable: false,
  });
});

// Spectator W2, Task 15 — the org home's chip island polls
// `pub:v1:org-live:{orgId}` (usecases/public.ts `publicOrgLive`, 15 s). A score
// write is what moves a fixture into and out of `in_play`, so it is what makes
// that document stale. The key the reader WRITES is pinned through the route
// (`api/v1/public/orgs/[orgSlug]/live/__tests__/route-cache.test.ts`), with the
// same literal as here.
describe("invalidatePublicCache — the org home's live key (Task 15)", () => {
  const ORG_LIVE_KEY = `pub:v1:org-live:${ORG}`;

  it("drops the org-live key, keyed by the fixture's ORG, in the same one DEL as the literal keys", async () => {
    await invalidatePublicCache(ORG, FIXTURE);
    expect(deletedKeys()).toContain(ORG_LIVE_KEY);
    expect(cacheDel, "one round trip for every literal key").toHaveBeenCalledTimes(1);
    expect(patterns().filter((pattern) => pattern.startsWith("pub:v1:org-live:")), "a literal key sent through a SCAN").toEqual([]);
  });

  it("is keyed by nothing else: no competition- or division-keyed org-live key", async () => {
    await invalidatePublicCache(ORG, FIXTURE);
    expect(deletedKeys().filter((key) => key.startsWith("pub:v1:org-live:"))).toEqual([ORG_LIVE_KEY]);
  });

  it("a fixture with no row drops no org-live key (positive pair: the fixture key still goes)", async () => {
    withTenant.mockResolvedValue(null);
    await invalidatePublicCache(ORG, FIXTURE);
    expect(deletedKeys().filter((key) => key.startsWith("pub:v1:org-live:"))).toEqual([]);
    expect(deletedKeys()).toContain(FIXTURE_KEY);
  });
});

describe("invalidatePublicCache — a scoring write", () => {
  it("drops the hub key, keyed by COMPETITION", async () => {
    await invalidatePublicCache(ORG, FIXTURE);
    expect(deletedKeys()).toContain(HUB_KEY);
  });

  it("still drops the fixture and division keys it dropped before", async () => {
    await invalidatePublicCache(ORG, FIXTURE);
    expect(deletedKeys()).toContain(FIXTURE_KEY);
    expect(patterns()).toContain(DIVISION_GLOB);
    // And the ISR side is untouched by this change (P1 renamed the helper a
    // score write fires: `fireScoreRevalidate`, revalidate.ts).
    expect(fireScoreRevalidate).toHaveBeenCalledWith(DIVISION, COMPETITION);
  });

  // W2 Task 14 (R10). Without this the player page's poll kept reading the
  // pre-score lines for the rest of their 15 s TTL. A glob sweep would reach
  // them too, but it is a second keyspace SCAN on EVERY score write, billed per
  // page; the generation key is one more name in the DEL that already goes out.
  it("retires every player's match lines in the COMPETITION by deleting its generation key — never by a SCAN", async () => {
    await invalidatePublicCache(ORG, FIXTURE);
    expect(deletedKeys()).toContain(PLAYER_MATCHES_GEN_KEY);
    expect(deletedKeys(), "keyed by division, not competition").not.toContain(`pub:v1:player-matches-gen:${DIVISION}`);
    expect(patterns().filter((pattern) => pattern.startsWith("pub:v1:player-matches")), "a player-matches SCAN").toEqual([]);
  });

  it("is NOT keyed by division — one hub document spans the whole competition", async () => {
    // A division-keyed hub key would leave every OTHER competition-wide reader
    // stale, and would not be the key `publicCompetitionHub` reads.
    await invalidatePublicCache(ORG, FIXTURE);
    expect([...deletedKeys(), ...patterns()]).not.toContain(`pub:v1:hub:${DIVISION}`);
  });

  it("a fixture with no row (deleted mid-write) drops the fixture key and no hub key", async () => {
    withTenant.mockResolvedValue(null);
    await invalidatePublicCache(ORG, FIXTURE);
    expect(deletedKeys()).toEqual([FIXTURE_KEY]);
    expect(patterns()).toEqual([]);
  });
});

describe("invalidatePublicCache — literal keys by one DEL, only the glob by SCAN (R10 H4)", () => {
  it("every literal key goes out in ONE direct DEL; no literal key goes through a SCAN, and no glob through DEL", async () => {
    await invalidatePublicCache(ORG, FIXTURE);
    expect(cacheDel, "one round trip for every literal key").toHaveBeenCalledTimes(1);
    expect(deletedKeys()).toEqual(expect.arrayContaining([FIXTURE_KEY, HUB_KEY, PLAYER_MATCHES_GEN_KEY]));
    // The SCAN set is EXACT, unlike the DEL superset: a sweep walks the whole
    // keyspace and is billed per page, so a new one must be seen here.
    expect(patterns()).toEqual([DIVISION_GLOB]);
    expect(patterns().filter((pattern) => !pattern.endsWith("*")), "a literal key sent through a SCAN").toEqual([]);
    expect(deletedKeys().filter((key) => key.includes("*")), "a glob sent through DEL").toEqual([]);
  });

  it("the callback waits for the DEL: nothing while the DEL is in flight, nothing when only the SCAN has settled", async () => {
    redis.hold = true;
    const after = vi.fn();
    await invalidatePublicCache(ORG, FIXTURE, false, after);
    expect(redis.held.map((gate) => gate.kind).sort()).toEqual(["del", "scan"]);

    await macrotask();
    expect(after, "called before the DEL settled").not.toHaveBeenCalled();
    await release("scan", { resolve: true });
    expect(after, "released by the SCAN").not.toHaveBeenCalled();

    await release("del", { resolve: true });
    expect(after).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith({ divisionId: DIVISION, competitionId: COMPETITION });
  });

  it("…and never for the SCAN: it runs as soon as the DEL settles, with the SCAN still going", async () => {
    redis.hold = true;
    const after = vi.fn();
    await invalidatePublicCache(ORG, FIXTURE, false, after);

    await release("del", { resolve: true });
    expect(redis.held.map((gate) => gate.kind), "the SCAN is still in flight").toEqual(["scan"]);
    expect(after, "waited on the SCAN").toHaveBeenCalledTimes(1);

    await release("scan", { resolve: true });
    expect(after, "called again once the SCAN settled").toHaveBeenCalledTimes(1);
  });

  it("a DEL that REJECTS is logged, never left unhandled, and still runs the callback", async () => {
    await watchingUnhandled(async (unhandled) => {
      redis.hold = true;
      const after = vi.fn();
      const failure = new Error("simulated Redis failure");
      await invalidatePublicCache(ORG, FIXTURE, false, after);

      await release("del", { reject: failure });
      // Checked first, the moment the DEL has failed.
      expect(unhandled, "a DEL rejected with no handler").toEqual([]);
      expect(logMock.error).toHaveBeenCalledWith(
        { err: failure, fixture: FIXTURE, keys: expect.arrayContaining([FIXTURE_KEY, HUB_KEY]) },
        DELETE_FAILED,
      );
      expect(after, "a failed DEL swallowed the callback").toHaveBeenCalledTimes(1);

      await release("scan", { resolve: true });
      expect(logMock.error).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    });
  });

  it("a SCAN that REJECTS is logged and never left unhandled; the callback still waits on the DEL alone", async () => {
    await watchingUnhandled(async (unhandled) => {
      redis.hold = true;
      const after = vi.fn();
      const failure = new Error("simulated Redis failure");
      await invalidatePublicCache(ORG, FIXTURE, false, after);

      await release("scan", { reject: failure });
      expect(unhandled, "a voided SCAN rejected with no handler").toEqual([]);
      expect(logMock.error).toHaveBeenCalledWith(
        { err: failure, fixture: FIXTURE, pattern: DIVISION_GLOB },
        SWEEP_FAILED,
      );
      expect(after, "released by a failed SCAN").not.toHaveBeenCalled();

      await release("del", { resolve: true });
      expect(after).toHaveBeenCalledTimes(1);
      expect(logMock.error).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    });
  });

  it("the quiet twin: a DEL and a SCAN that succeed log nothing", async () => {
    const after = vi.fn();
    await invalidatePublicCache(ORG, FIXTURE, false, after);
    await macrotask();
    expect(after).toHaveBeenCalledTimes(1);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it("no row: the DEL carries the fixture key alone, and the callback is handed null", async () => {
    withTenant.mockResolvedValue(null);
    const after = vi.fn();
    await invalidatePublicCache(ORG, FIXTURE, false, after);
    await macrotask();
    expect(deletedKeys()).toEqual([FIXTURE_KEY]);
    expect(after).toHaveBeenCalledWith(null);
  });
});

describe("invalidatePublicCache — the pushes wait for the DEL, never longer than the bound, and go out ONCE (R10 I1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const SCOPE = { divisionId: DIVISION, competitionId: COMPETITION };

  it("the bound is the ruling's: 1500ms", () => {
    expect(PUSH_AFTER_DELETE_BOUND_MS).toBe(1_500);
  });

  it("a DEL that NEVER settles: the pushes go out at the bound, once, and a late settle sends nothing more", async () => {
    redis.hold = true;
    const after = vi.fn();
    await invalidatePublicCache(ORG, FIXTURE, false, after);

    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS - 1);
    expect(after, "sent before the DEL settled and before the bound").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(after, "a DEL that never answers held the pushes past the bound").toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith(SCOPE);

    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS * 4);
    expect(after, "the bound fired more than once").toHaveBeenCalledTimes(1);
    await settleHeld("del", { resolve: true });
    await settleHeld("scan", { resolve: true });
    expect(after, "the late DEL sent the pushes a second time").toHaveBeenCalledTimes(1);
  });

  it("a DEL that settles at 200ms: the pushes go out then, once, and the bound's timer is cleared", async () => {
    redis.hold = true;
    const after = vi.fn();
    await invalidatePublicCache(ORG, FIXTURE, false, after);

    await vi.advanceTimersByTimeAsync(200);
    expect(after, "sent before the DEL settled").not.toHaveBeenCalled();
    expect(vi.getTimerCount(), "the bound is armed while the DEL is in flight").toBe(1);

    await settleHeld("del", { resolve: true });
    expect(after, "waited for the bound instead of the DEL").toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith(SCOPE);
    expect(vi.getTimerCount(), "the bound's timer outlived the DEL").toBe(0);

    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS * 2);
    expect(after, "the bound sent the pushes a second time").toHaveBeenCalledTimes(1);
  });

  it("a DEL that REJECTS: the pushes go out once, and the bound sends nothing more", async () => {
    redis.hold = true;
    const after = vi.fn();
    const failure = new Error("simulated Redis failure");
    await invalidatePublicCache(ORG, FIXTURE, false, after);

    await settleHeld("del", { reject: failure });
    expect(logMock.error).toHaveBeenCalledWith(
      { err: failure, fixture: FIXTURE, keys: expect.arrayContaining([FIXTURE_KEY, HUB_KEY]) },
      DELETE_FAILED,
    );
    expect(after, "a failed DEL swallowed the pushes").toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS * 2);
    expect(after, "the bound sent the pushes a second time").toHaveBeenCalledTimes(1);
  });

  // R10c m6: a genuine same-instant race. The DEL's resolve is itself a fake
  // timer due at exactly the bound, and ONE advance runs both. Two timers due
  // at the same instant fire in the order they were armed, and the async
  // advance drains microtasks between them, so each order is built by arming
  // the resolve before or after the bound. What `after` had seen when the
  // resolve ran proves which order actually happened.
  it.each([
    ["the bound's timer fires first, the DEL settles in the same tick", "after", 1],
    ["the DEL settles first, the bound's timer is due in the same tick", "before", 0],
  ] as const)("a DEL that settles AT the bound's own instant (%s): exactly once", async (_label, armResolve, sentAtResolve) => {
    redis.hold = true;
    const after = vi.fn();
    let seenAtResolve: number | undefined;
    const resolveAtBound = () =>
      setTimeout(() => {
        seenAtResolve = after.mock.calls.length;
        settle("del", { resolve: true });
      }, PUSH_AFTER_DELETE_BOUND_MS);

    if (armResolve === "before") resolveAtBound();
    await invalidatePublicCache(ORG, FIXTURE, false, after);
    if (armResolve === "after") resolveAtBound();
    expect(vi.getTimerCount(), "the bound and the resolve are both armed").toBe(2);

    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(seenAtResolve, "the race ran in the other order").toBe(sentAtResolve);
    expect(after, "sent by both the bound and the DEL").toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith(SCOPE);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("with no callback, nothing is armed", async () => {
    redis.hold = true;
    await invalidatePublicCache(ORG, FIXTURE);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("afterScheduleWrite — a schedule write", () => {
  it.each(["schedule", "publish", "start"] as const)(
    "drops the hub key on a %s write, and pushes that reason",
    async (reason) => {
      afterScheduleWrite(DIVISION, COMPETITION, reason, [FIXTURE]);
      await macrotask();
      expect(deletedKeys()).toContain(HUB_KEY);
      expect(publishDivisionUpdate).toHaveBeenCalledWith(DIVISION, reason);
    },
  );

  it("still drops the division key and fires the ISR tag", () => {
    afterScheduleWrite(DIVISION, COMPETITION, "schedule", [FIXTURE]);
    expect(patterns()).toContain(DIVISION_GLOB);
    expect(fireDivisionRevalidate).toHaveBeenCalledWith(DIVISION, COMPETITION);
  });

  it("uses the SAME key the scoring path does — one document, one key", async () => {
    afterScheduleWrite(DIVISION, COMPETITION, "schedule", [FIXTURE]);
    const fromSchedule = deletedKeys().filter((key) => key.startsWith("pub:v1:hub:"));
    cacheDel.mockClear();
    await invalidatePublicCache(ORG, FIXTURE);
    const fromScoring = deletedKeys().filter((key) => key.startsWith("pub:v1:hub:"));
    expect(fromSchedule).toEqual(fromScoring);
    expect(fromSchedule).toEqual([HUB_KEY]);
  });
});

describe("afterScheduleWrite — the hub key by one DEL, only the division glob by SCAN (R10c m1)", () => {
  it("the hub key goes out in ONE direct DEL; no literal key goes through a SCAN, and no glob through DEL", () => {
    afterScheduleWrite(DIVISION, COMPETITION, "schedule", [FIXTURE]);
    expect(cacheDel, "one round trip for the literal key").toHaveBeenCalledTimes(1);
    expect(deletedKeys()).toContain(HUB_KEY);
    expect(patterns()).toContain(DIVISION_GLOB);
    expect(patterns().filter((pattern) => !pattern.endsWith("*")), "a literal key sent through a SCAN").toEqual([]);
    expect(deletedKeys().filter((key) => key.includes("*")), "a glob sent through DEL").toEqual([]);
  });

  it("the push waits for the DEL: nothing while it is in flight, nothing when only the SCAN has settled", async () => {
    redis.hold = true;
    afterScheduleWrite(DIVISION, COMPETITION, "schedule", [FIXTURE]);
    expect(redis.held.map((gate) => gate.kind).sort()).toEqual(["del", "scan"]);

    await macrotask();
    expect(publishDivisionUpdate, "pushed before the DEL settled").not.toHaveBeenCalled();
    await release("scan", { resolve: true });
    expect(publishDivisionUpdate, "released by the SCAN").not.toHaveBeenCalled();

    await release("del", { resolve: true });
    expect(publishDivisionUpdate).toHaveBeenCalledTimes(1);
    expect(publishDivisionUpdate).toHaveBeenCalledWith(DIVISION, "schedule");
  });
});

// F4 (P1 round 2) — `cacheDelPattern` and `cacheDel` fail open inside their own
// try, but their `client()` call sits OUTSIDE it (cache.ts), and ioredis's
// constructor throws synchronously on a REDIS_URL it cannot parse (`new URL`:
// "redis://host:99999" is `TypeError: Invalid URL`). Every call would then
// reject, and a voided call with no handler is an unhandled rejection on every
// schedule write.
describe("afterScheduleWrite — a Redis call that REJECTS", () => {
  it("a SCAN that rejects is logged and never left unhandled; the push still goes out", async () => {
    await watchingUnhandled(async (unhandled) => {
      const failure = new Error("simulated Redis failure");
      redis.failScan = failure;
      afterScheduleWrite(DIVISION, COMPETITION, "schedule", [FIXTURE]);
      // Node reports an unhandled rejection once the microtask queue drains.
      await macrotask();
      expect(unhandled, "a voided SCAN rejected with no handler").toEqual([]);
      expect(logMock.error).toHaveBeenCalledWith({ err: failure, pattern: DIVISION_GLOB }, SCHEDULE_SWEEP_FAILED);
      expect(logMock.error).toHaveBeenCalledTimes(1);
      // The write's other effects still happened.
      expect(fireDivisionRevalidate).toHaveBeenCalledWith(DIVISION, COMPETITION);
      expect(publishDivisionUpdate).toHaveBeenCalledTimes(1);
      expect(publishDivisionUpdate).toHaveBeenCalledWith(DIVISION, "schedule");
    });
  });

  it("a DEL that rejects is logged and never left unhandled; the push still goes out", async () => {
    await watchingUnhandled(async (unhandled) => {
      const failure = new Error("simulated Redis failure");
      redis.failDel = failure;
      afterScheduleWrite(DIVISION, COMPETITION, "schedule", [FIXTURE]);
      await macrotask();
      expect(unhandled, "a DEL rejected with no handler").toEqual([]);
      expect(logMock.error).toHaveBeenCalledWith({ err: failure, keys: [HUB_KEY, FIXTURE_KEY] }, SCHEDULE_DELETE_FAILED);
      expect(logMock.error).toHaveBeenCalledTimes(1);
      expect(publishDivisionUpdate, "a failed DEL swallowed the push").toHaveBeenCalledTimes(1);
      expect(publishDivisionUpdate).toHaveBeenCalledWith(DIVISION, "schedule");
      expect(publishFixtureUpdate.mock.calls, "a failed DEL swallowed the fixture push").toEqual([[FIXTURE, "schedule"]]);
    });
  });

  it("the quiet twin: a DEL and a SCAN that succeed log nothing", async () => {
    afterScheduleWrite(DIVISION, COMPETITION, "schedule", [FIXTURE]);
    await macrotask();
    expect(cacheDel.mock.calls).toEqual([[HUB_KEY, FIXTURE_KEY]]);
    expect(patterns()).toEqual([DIVISION_GLOB]);
    expect(publishDivisionUpdate).toHaveBeenCalledTimes(1);
    expect(logMock.error).not.toHaveBeenCalled();
  });
});

describe("afterScheduleWrite — the push waits for the DEL, never longer than the bound, and goes out ONCE (R10c m1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a DEL that settles first (at 200ms): the push goes out then, once, and the bound's timer is cleared", async () => {
    redis.hold = true;
    afterScheduleWrite(DIVISION, COMPETITION, "publish", [FIXTURE]);

    await vi.advanceTimersByTimeAsync(200);
    expect(publishDivisionUpdate, "pushed before the DEL settled").not.toHaveBeenCalled();
    expect(vi.getTimerCount(), "the bound is armed while the DEL is in flight").toBe(1);

    await settleHeld("del", { resolve: true });
    expect(publishDivisionUpdate, "waited for the bound instead of the DEL").toHaveBeenCalledTimes(1);
    expect(publishDivisionUpdate).toHaveBeenCalledWith(DIVISION, "publish");
    expect(vi.getTimerCount(), "the bound's timer outlived the DEL").toBe(0);

    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS * 2);
    expect(publishDivisionUpdate, "the bound pushed a second time").toHaveBeenCalledTimes(1);
  });

  it("a DEL that NEVER settles: the push goes out at the bound, once, and a late settle sends nothing more", async () => {
    redis.hold = true;
    afterScheduleWrite(DIVISION, COMPETITION, "start", [FIXTURE]);

    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS - 1);
    expect(publishDivisionUpdate, "pushed before the DEL settled and before the bound").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(publishDivisionUpdate, "a DEL that never answers held the push past the bound").toHaveBeenCalledTimes(1);
    expect(publishDivisionUpdate).toHaveBeenCalledWith(DIVISION, "start");

    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS * 4);
    expect(publishDivisionUpdate, "the bound fired more than once").toHaveBeenCalledTimes(1);
    await settleHeld("del", { resolve: true });
    await settleHeld("scan", { resolve: true });
    expect(publishDivisionUpdate, "the late DEL pushed a second time").toHaveBeenCalledTimes(1);
  });

  it("a DEL that REJECTS: the push goes out once, and the bound sends nothing more", async () => {
    redis.hold = true;
    const failure = new Error("simulated Redis failure");
    afterScheduleWrite(DIVISION, COMPETITION, "schedule", [FIXTURE]);

    await settleHeld("del", { reject: failure });
    expect(logMock.error).toHaveBeenCalledWith({ err: failure, keys: [HUB_KEY, FIXTURE_KEY] }, SCHEDULE_DELETE_FAILED);
    expect(publishDivisionUpdate, "a failed DEL swallowed the push").toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS * 2);
    expect(publishDivisionUpdate, "the bound pushed a second time").toHaveBeenCalledTimes(1);
  });

  // The same two-order race as scoring's (R10c m6), on this path.
  it.each([
    ["the bound's timer fires first, the DEL settles in the same tick", "after", 1],
    ["the DEL settles first, the bound's timer is due in the same tick", "before", 0],
  ] as const)("a DEL that settles AT the bound's own instant (%s): exactly one push", async (_label, armResolve, sentAtResolve) => {
    redis.hold = true;
    let seenAtResolve: number | undefined;
    const resolveAtBound = () =>
      setTimeout(() => {
        seenAtResolve = publishDivisionUpdate.mock.calls.length;
        settle("del", { resolve: true });
      }, PUSH_AFTER_DELETE_BOUND_MS);

    if (armResolve === "before") resolveAtBound();
    afterScheduleWrite(DIVISION, COMPETITION, "schedule", [FIXTURE]);
    if (armResolve === "after") resolveAtBound();
    expect(vi.getTimerCount(), "the bound and the resolve are both armed").toBe(2);

    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(seenAtResolve, "the race ran in the other order").toBe(sentAtResolve);
    expect(publishDivisionUpdate, "pushed by both the bound and the DEL").toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// R10d n2 — the match centre and the overlay read `pub:v1:fixture:{id}`
// (`publicFixture`, usecases/public.ts), which caches a fixture's kick-off,
// venue and court for 30s. A schedule write used to drop the hub key alone, so
// a moved fixture showed its NEW slot on the hub and its OLD one on the match
// centre and the overlay. The fixture keys of every fixture the write changed
// now go out in the hub key's ONE DEL, and each of those fixtures gets its
// `fixture:{id}` push after that DEL, through the same bounded once-only
// helper, so an open match centre refetches now instead of at its 60s poll.
describe("afterScheduleWrite — the documents of the fixtures the write changed (R10d n2)", () => {
  const keyOf = (id: string) => `pub:v1:fixture:${id}`;
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `fx-moved-${i}`);

  it("the per-fixture push cap is the ruling's: 50", () => {
    expect(SCHEDULE_FIXTURE_PUSH_CAP).toBe(50);
  });

  it("a reschedule of ONE fixture: its key rides the hub key's one DEL, and its push waits for that DEL", async () => {
    redis.hold = true;
    afterScheduleWrite(DIVISION, COMPETITION, "schedule", [FIXTURE]);
    expect(cacheDel.mock.calls, "one DEL carrying the hub key and the moved fixture's key").toEqual([[HUB_KEY, FIXTURE_KEY]]);
    expect(patterns().filter((pattern) => pattern.startsWith("pub:v1:fixture:")), "a fixture key sent through a SCAN").toEqual([]);

    await macrotask();
    expect(publishFixtureUpdate, "fixture push before the DEL settled").not.toHaveBeenCalled();
    await release("scan", { resolve: true });
    expect(publishFixtureUpdate, "fixture push released by the SCAN").not.toHaveBeenCalled();

    await release("del", { resolve: true });
    expect(publishFixtureUpdate.mock.calls).toEqual([[FIXTURE, "schedule"]]);
    expect(publishDivisionUpdate.mock.calls).toEqual([[DIVISION, "schedule"]]);
  });

  it("every fixture the write changed: every key in that one DEL, and one push each, all after it", async () => {
    const moved = ids(3);
    redis.hold = true;
    afterScheduleWrite(DIVISION, COMPETITION, "publish", moved);
    expect(cacheDel.mock.calls).toEqual([[HUB_KEY, ...moved.map(keyOf)]]);

    await macrotask();
    expect(publishFixtureUpdate, "fixture push before the DEL settled").not.toHaveBeenCalled();
    await release("del", { resolve: true });
    expect(publishFixtureUpdate.mock.calls).toEqual(moved.map((id) => [id, "schedule"]));
  });

  it("EXACTLY 50 fixtures still pushes every one of them", async () => {
    const moved = ids(SCHEDULE_FIXTURE_PUSH_CAP);
    afterScheduleWrite(DIVISION, COMPETITION, "schedule", moved);
    await macrotask();
    expect(publishFixtureUpdate.mock.calls).toEqual(moved.map((id) => [id, "schedule"]));
  });

  it("MORE than 50 fixtures: every key still goes in the one DEL and the division push goes out, but no fixture push", async () => {
    const moved = ids(SCHEDULE_FIXTURE_PUSH_CAP + 1);
    redis.hold = true;
    afterScheduleWrite(DIVISION, COMPETITION, "start", moved);
    expect(cacheDel.mock.calls, "the cap must not skip the DEL").toEqual([[HUB_KEY, ...moved.map(keyOf)]]);

    await release("del", { resolve: true });
    expect(publishDivisionUpdate.mock.calls).toEqual([[DIVISION, "start"]]);
    expect(publishFixtureUpdate, "a 51-fixture write fanned out per-fixture pushes").not.toHaveBeenCalled();
  });

  it("a write that changed no fixture: the hub key alone, and no fixture push", async () => {
    afterScheduleWrite(DIVISION, COMPETITION, "publish", []);
    await macrotask();
    expect(cacheDel.mock.calls).toEqual([[HUB_KEY]]);
    expect(publishDivisionUpdate).toHaveBeenCalledTimes(1);
    expect(publishFixtureUpdate).not.toHaveBeenCalled();
  });
});

describe("afterScheduleWrite — the fixture pushes wait for the DEL, never longer than the bound (R10d n2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a DEL that NEVER settles: the moved fixture's push goes out at the bound, once, and a late settle sends nothing more", async () => {
    redis.hold = true;
    afterScheduleWrite(DIVISION, COMPETITION, "schedule", [FIXTURE]);

    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS - 1);
    expect(publishFixtureUpdate, "fixture push before the DEL settled and before the bound").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(publishFixtureUpdate.mock.calls, "a DEL that never answers held the fixture push past the bound").toEqual([
      [FIXTURE, "schedule"],
    ]);

    await settleHeld("del", { resolve: true });
    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS * 2);
    expect(publishFixtureUpdate, "the late DEL pushed the fixture a second time").toHaveBeenCalledTimes(1);
  });
});
