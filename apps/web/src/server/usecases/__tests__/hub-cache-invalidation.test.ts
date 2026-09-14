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
import { beforeEach, describe, expect, it, vi } from "vitest";

// Typed on the parameter so `patterns()` below reads `string`, not `unknown` —
// `void pattern` rather than an underscore prefix because this config's
// no-unused-vars has no `argsIgnorePattern`.
const cacheDelPattern = vi.hoisted(() =>
  vi.fn(async (pattern: string) => {
    void pattern;
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

// Set to make every sweep REJECT. The rejection is a fresh `Promise.reject`
// handed straight to production code, never the spy's own return value: a
// `vi.fn` attaches handlers to any promise it returns (to record
// `settledResults`), which marks a rejection HANDLED — a test built on
// `mockRejectedValue` cannot see an unhandled rejection at all.
const sweepFailure = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheDelPattern: (pattern: string) => {
    const recorded = cacheDelPattern(pattern);
    return sweepFailure.error ? Promise.reject(sweepFailure.error) : recorded;
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

import { invalidatePublicCache } from "../scoring";
import { afterScheduleWrite } from "../schedule";

const ORG = "org-1";
const FIXTURE = "fx-1";
const DIVISION = "div-1";
const COMPETITION = "comp-1";

const patterns = () => cacheDelPattern.mock.calls.map(([pattern]) => pattern);

beforeEach(() => {
  vi.clearAllMocks();
  withTenant.mockResolvedValue({
    division_id: DIVISION,
    competition_id: COMPETITION,
    discoverable: false,
  });
});

describe("invalidatePublicCache — a scoring write", () => {
  it("drops the hub key, keyed by COMPETITION", async () => {
    await invalidatePublicCache(ORG, FIXTURE);
    expect(patterns()).toContain(`pub:v1:hub:${COMPETITION}`);
  });

  it("still drops the fixture and division keys it dropped before", async () => {
    await invalidatePublicCache(ORG, FIXTURE);
    expect(patterns()).toEqual(
      expect.arrayContaining([`pub:v1:fixture:${FIXTURE}`, `pub:v1:div:${DIVISION}:*`]),
    );
    // And the ISR side is untouched by this change (P1 renamed the helper a
    // score write fires: `fireScoreRevalidate`, revalidate.ts).
    expect(fireScoreRevalidate).toHaveBeenCalledWith(DIVISION, COMPETITION);
  });

  it("is NOT keyed by division — one hub document spans the whole competition", async () => {
    // A division-keyed hub key would leave every OTHER competition-wide reader
    // stale, and would not be the key `publicCompetitionHub` reads.
    await invalidatePublicCache(ORG, FIXTURE);
    expect(patterns()).not.toContain(`pub:v1:hub:${DIVISION}`);
  });

  it("a fixture with no row (deleted mid-write) drops the fixture key and no hub key", async () => {
    withTenant.mockResolvedValue(null);
    await invalidatePublicCache(ORG, FIXTURE);
    expect(patterns()).toEqual([`pub:v1:fixture:${FIXTURE}`]);
  });
});

describe("afterScheduleWrite — a schedule write", () => {
  it.each(["schedule", "publish", "start"] as const)(
    "drops the hub key on a %s write",
    (reason) => {
      afterScheduleWrite(DIVISION, COMPETITION, reason);
      expect(patterns()).toContain(`pub:v1:hub:${COMPETITION}`);
    },
  );

  it("still drops the division key and fires the ISR tag", () => {
    afterScheduleWrite(DIVISION, COMPETITION, "schedule");
    expect(patterns()).toContain(`pub:v1:div:${DIVISION}:*`);
    expect(fireDivisionRevalidate).toHaveBeenCalledWith(DIVISION, COMPETITION);
    expect(publishDivisionUpdate).toHaveBeenCalledWith(DIVISION, "schedule");
  });

  it("uses the SAME key shape the scoring path does — one document, one key", async () => {
    afterScheduleWrite(DIVISION, COMPETITION, "schedule");
    const fromSchedule = patterns().filter((p) => p.startsWith("pub:v1:hub:"));
    cacheDelPattern.mockClear();
    await invalidatePublicCache(ORG, FIXTURE);
    const fromScoring = patterns().filter((p) => p.startsWith("pub:v1:hub:"));
    expect(fromSchedule).toEqual(fromScoring);
    expect(fromSchedule).toEqual([`pub:v1:hub:${COMPETITION}`]);
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
    sweepFailure.error = failure;
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
      for (const pattern of [`pub:v1:div:${DIVISION}:*`, `pub:v1:hub:${COMPETITION}`]) {
        expect(logMock.error, pattern).toHaveBeenCalledWith(
          { err: failure, pattern },
          "schedule: a public Redis sweep failed (the write stands)",
        );
      }
      // The write's other effects still happened.
      expect(fireDivisionRevalidate).toHaveBeenCalledWith(DIVISION, COMPETITION);
      expect(publishDivisionUpdate).toHaveBeenCalledWith(DIVISION, "schedule");
    } finally {
      sweepFailure.error = null;
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a sweep that succeeds logs nothing (the quiet twin)", async () => {
    afterScheduleWrite(DIVISION, COMPETITION, "schedule");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(patterns()).toEqual([`pub:v1:div:${DIVISION}:*`, `pub:v1:hub:${COMPETITION}`]);
    expect(logMock.error).not.toHaveBeenCalled();
  });
});
