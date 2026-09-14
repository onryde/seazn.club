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
// SCAN, no glob through DEL", which keeps the key sets supersets (R-E). The
// schedule path is unchanged: both of its keys still go through SCAN.
//
// R10 I1 — the pushes wait for that DEL, but never longer than
// PUSH_AFTER_DELETE_BOUND_MS. ioredis has no command timeout, so a Redis that
// stops answering without dropping the connection would otherwise hold every
// push forever, and exactly once either way.
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
}));

import { invalidatePublicCache, PUSH_AFTER_DELETE_BOUND_MS } from "../scoring";
import { afterScheduleWrite } from "../schedule";

const ORG = "org-1";
const FIXTURE = "fx-1";
const DIVISION = "div-1";
const COMPETITION = "comp-1";
const FIXTURE_KEY = `pub:v1:fixture:${FIXTURE}`;
const HUB_KEY = `pub:v1:hub:${COMPETITION}`;
const DIVISION_GLOB = `pub:v1:div:${DIVISION}:*`;
const SWEEP_FAILED = "scoring: a public Redis sweep failed (the write stands)";
const DELETE_FAILED = "scoring: a public Redis delete failed (the write stands)";

const patterns = () => cacheDelPattern.mock.calls.map(([pattern]) => pattern);
const deletedKeys = () => cacheDel.mock.calls.flat();

const macrotask = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Settle every held call of one kind, then return only after a macrotask,
 *  so every microtask the settlement queues (a callback chained on it, Node's
 *  unhandled-rejection report) has already run. */
async function release(kind: "del" | "scan", outcome: { resolve: true } | { reject: Error }): Promise<void> {
  const settling = redis.held.filter((gate) => gate.kind === kind);
  redis.held = redis.held.filter((gate) => gate.kind !== kind);
  for (const gate of settling) {
    if ("reject" in outcome) gate.reject(outcome.reject);
    else gate.resolve();
  }
  await macrotask();
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
    discoverable: false,
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
  it("both literal keys go out in ONE direct DEL; no literal key goes through a SCAN, and no glob through DEL", async () => {
    await invalidatePublicCache(ORG, FIXTURE);
    expect(cacheDel, "one round trip for every literal key").toHaveBeenCalledTimes(1);
    expect(deletedKeys()).toEqual(expect.arrayContaining([FIXTURE_KEY, HUB_KEY]));
    expect(patterns()).toContain(DIVISION_GLOB);
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

  /** `release` for fake timers: settle the held calls of one kind, then flush
   *  every microtask that queues without moving the clock. */
  async function settleHeld(kind: "del" | "scan", outcome: { resolve: true } | { reject: Error }): Promise<void> {
    const settling = redis.held.filter((gate) => gate.kind === kind);
    redis.held = redis.held.filter((gate) => gate.kind !== kind);
    for (const gate of settling) {
      if ("reject" in outcome) gate.reject(outcome.reject);
      else gate.resolve();
    }
    await vi.advanceTimersByTimeAsync(0);
  }

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

  it("a DEL that settles AT the bound's own instant: still exactly once", async () => {
    redis.hold = true;
    const after = vi.fn();
    await invalidatePublicCache(ORG, FIXTURE, false, after);

    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS);
    await settleHeld("del", { resolve: true });
    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("with no callback, nothing is armed", async () => {
    redis.hold = true;
    await invalidatePublicCache(ORG, FIXTURE);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("afterScheduleWrite — a schedule write", () => {
  it.each(["schedule", "publish", "start"] as const)(
    "drops the hub key on a %s write",
    (reason) => {
      afterScheduleWrite(DIVISION, COMPETITION, reason);
      expect(patterns()).toContain(HUB_KEY);
    },
  );

  it("still drops the division key and fires the ISR tag", () => {
    afterScheduleWrite(DIVISION, COMPETITION, "schedule");
    expect(patterns()).toContain(DIVISION_GLOB);
    expect(fireDivisionRevalidate).toHaveBeenCalledWith(DIVISION, COMPETITION);
    expect(publishDivisionUpdate).toHaveBeenCalledWith(DIVISION, "schedule");
  });

  it("uses the SAME key the scoring path does — one document, one key", async () => {
    afterScheduleWrite(DIVISION, COMPETITION, "schedule");
    const fromSchedule = patterns().filter((p) => p.startsWith("pub:v1:hub:"));
    cacheDelPattern.mockClear();
    await invalidatePublicCache(ORG, FIXTURE);
    // The scoring path deletes it directly now (H4); the key is the same string.
    const fromScoring = deletedKeys().filter((key) => key.startsWith("pub:v1:hub:"));
    expect(fromSchedule).toEqual(fromScoring);
    expect(fromSchedule).toEqual([HUB_KEY]);
  });
});

// F4 (P1 round 2) — `cacheDelPattern` fails open inside its own try, but its
// `client()` call sits OUTSIDE it (cache.ts), and ioredis's constructor throws
// synchronously on a REDIS_URL it cannot parse (`new URL`: "redis://host:99999"
// is `TypeError: Invalid URL`). Every call would then reject, and a voided
// sweep with no handler is an unhandled rejection on every schedule write.
describe("afterScheduleWrite — a Redis sweep that REJECTS", () => {
  it("is logged per sweep and never left as an unhandled rejection", async () => {
    const failure = new Error("simulated Redis failure");
    redis.failScan = failure;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      afterScheduleWrite(DIVISION, COMPETITION, "schedule");
      // Node reports an unhandled rejection once the microtask queue drains.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled, "a voided sweep rejected with no handler").toEqual([]);
      for (const pattern of [DIVISION_GLOB, HUB_KEY]) {
        expect(logMock.error, pattern).toHaveBeenCalledWith(
          { err: failure, pattern },
          "schedule: a public Redis sweep failed (the write stands)",
        );
      }
      // The write's other effects still happened.
      expect(fireDivisionRevalidate).toHaveBeenCalledWith(DIVISION, COMPETITION);
      expect(publishDivisionUpdate).toHaveBeenCalledWith(DIVISION, "schedule");
    } finally {
      redis.failScan = null;
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a sweep that succeeds logs nothing (the quiet twin)", async () => {
    afterScheduleWrite(DIVISION, COMPETITION, "schedule");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(patterns()).toEqual([DIVISION_GLOB, HUB_KEY]);
    expect(logMock.error).not.toHaveBeenCalled();
  });
});
