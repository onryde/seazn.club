// Player stats refresh after a result (owner ruling 2026-09-16, option B), in
// real Postgres, through the real `scoreEvent`, `importEvents`, history undo,
// stage delete, config re-snapshot, `mergePersons` and `reverseMerge`.
//
// The defect: `player_stat_snapshots` was only written when someone READ stats
// (a console panel, the public stats route, a merge, an opt-in auto-post). So
// after real matches the public hub had no Stats tab, and once a read had
// filled the table the leaders froze.
//
// What the fix promises, and where each promise is pinned:
//   - the scorer's request never waits on the fold: `deferred` is recorded
//     here instead of run, so each test decides when "after the response" is;
//   - one refresh transaction at a time per process, and repeat requests for a
//     division join the queued one;
//   - finishes in one division collapse across processes, and none is lost,
//     including a finish that lands mid-fold, a deleted scored fixture and a
//     config re-snapshot;
//   - a busy lock that never frees still clears the caches;
//   - public caches are cleared and the division pushed only once the fold
//     has COMMITTED, and only once per fold;
//   - a failed fold is logged and goes no further;
//   - a person merge or unmerge never deadlocks against a refresh, whichever
//     of the two gets the division first.
// The ISR half of "clears the caches" needs Next's real AfterContext and has
// its own file (`player-stats-refresh-after.test.ts`).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const probe = vi.hoisted(() => ({
  /** Every `deferred(fn)` call, in order, NOT run. */
  tasks: [] as Array<() => unknown>,
  folds: 0,
  activeFolds: 0,
  maxActiveFolds: 0,
  tryLocks: 0,
  /** Division lineup loads: one per fold, in memory or written. */
  lineupLoads: 0,
  order: [] as string[],
  /** Hold the NEXT fold, before it takes the lock or reads anything. */
  holdNextFold: null as null | { entered: () => void; release: Promise<void> },
  /** Hold the next fold AFTER its ledger read (inside `recomputePlayerStats`). */
  holdAfterLedgerRead: null as null | { entered: () => void; release: Promise<void> },
  failFold: null as Error | null,
  /** Thrown by the next read-side checks (`playerStatsOwed`). */
  failCheck: null as Error | null,
  /** Seconds of `pg_sleep` inside the next folds, in their own transaction. */
  slowFoldSeconds: 0,
  /** Resolve every sport as declaring no player stats. */
  withoutPlayerStats: false,
  /** Read-side checks (`playerStatsOwed` from the refresh module): running now,
   *  the most at once, and every division checked, in order. */
  activeChecks: 0,
  maxActiveChecks: 0,
  checked: [] as string[],
  /** Hold every read-side check open until released. */
  holdChecks: null as null | Promise<void>,
  /** Runs before every `lockPlayerStatsDivisions`, on its own connection. */
  beforeStatsLocks: null as null | ((divisionIds: readonly string[]) => Promise<void>),
  /** Read Ada's snapshot goals at the moment the hub key is deleted. */
  watch: null as null | { divisionId: string; personId: string },
  goalsAtHubDelete: [] as Array<number | null>,
  divisionPushes: [] as string[],
  statsTags: [] as string[],
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

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/server/engine-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/engine-db")>();
  return {
    ...actual,
    resolveModule: (...args: Parameters<typeof actual.resolveModule>) => {
      const resolved = actual.resolveModule(...args);
      return probe.withoutPlayerStats ? { ...resolved, playerStats: undefined } : resolved;
    },
  };
});

vi.mock("@/lib/deferred", () => ({
  deferred: (fn: () => unknown) => {
    probe.tasks.push(fn);
  },
}));

// Never a live vendor call from a test: both pushes are recorded, not sent.
vi.mock("@/lib/realtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/realtime")>();
  return {
    ...actual,
    publishFixtureUpdate: async () => {},
    publishDivisionUpdate: async (divisionId: string, reason: string) => {
      probe.order.push(`push:${reason}`);
      probe.divisionPushes.push(`${divisionId}:${reason}`);
    },
  };
});

vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  const { sql: db } = await import("@/lib/db");
  return {
    ...actual,
    cacheDel: async (...keys: string[]) => {
      const hub = keys.find((k) => k.startsWith("pub:v1:hub:"));
      if (hub !== undefined) {
        probe.order.push("del:hub");
        if (probe.watch !== null) {
          // A SEPARATE pooled connection: it sees only what has committed.
          const [row] = await db<{ goals: number | null }[]>`
            select (stats->>'goals')::int as goals from player_stat_snapshots
            where division_id = ${probe.watch.divisionId} and person_id = ${probe.watch.personId}`;
          probe.goalsAtHubDelete.push(row?.goals ?? null);
        }
      }
      return actual.cacheDel(...keys);
    },
  };
});

vi.mock("@/server/public-site/revalidate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/public-site/revalidate")>();
  return {
    ...actual,
    fireStatsRevalidate: (divisionId: string, competitionId: string) => {
      probe.order.push("tags");
      probe.statsTags.push(divisionId);
      return actual.fireStatsRevalidate(divisionId, competitionId);
    },
  };
});

vi.mock("@/server/engine-db/lineups", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/engine-db/lineups")>();
  return {
    ...actual,
    // The first thing `recomputePlayerStats` does after its ledger select.
    loadLineupPairsForDivision: async (...args: Parameters<typeof actual.loadLineupPairsForDivision>) => {
      probe.lineupLoads += 1;
      const hold = probe.holdAfterLedgerRead;
      if (hold !== null) {
        probe.holdAfterLedgerRead = null;
        hold.entered();
        await hold.release;
      }
      return actual.loadLineupPairsForDivision(...args);
    },
  };
});

vi.mock("../player-stats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../player-stats")>();
  return {
    ...actual,
    tryLockPlayerStats: async (...args: Parameters<typeof actual.tryLockPlayerStats>) => {
      probe.tryLocks += 1;
      return actual.tryLockPlayerStats(...args);
    },
    lockPlayerStatsDivisions: async (...args: Parameters<typeof actual.lockPlayerStatsDivisions>) => {
      if (probe.beforeStatsLocks !== null) await probe.beforeStatsLocks(args[1]);
      return actual.lockPlayerStatsDivisions(...args);
    },
    playerStatsOwed: async (...args: Parameters<typeof actual.playerStatsOwed>) => {
      probe.activeChecks += 1;
      probe.maxActiveChecks = Math.max(probe.maxActiveChecks, probe.activeChecks);
      probe.checked.push(args[1]);
      try {
        if (probe.holdChecks !== null) await probe.holdChecks;
        if (probe.failCheck !== null) throw probe.failCheck;
        return await actual.playerStatsOwed(...args);
      } finally {
        probe.activeChecks -= 1;
      }
    },
    recomputePlayerStats: async (...args: Parameters<typeof actual.recomputePlayerStats>) => {
      probe.folds += 1;
      probe.order.push("fold:start");
      if (probe.failFold !== null) throw probe.failFold;
      if (probe.slowFoldSeconds > 0) await args[0]`select pg_sleep(${probe.slowFoldSeconds})`;
      const hold = probe.holdNextFold;
      if (hold !== null) {
        probe.holdNextFold = null;
        hold.entered();
        await hold.release;
      }
      probe.activeFolds += 1;
      probe.maxActiveFolds = Math.max(probe.maxActiveFolds, probe.activeFolds);
      try {
        const out = await actual.recomputePlayerStats(...args);
        probe.order.push("fold:end");
        return out;
      } finally {
        probe.activeFolds -= 1;
      }
    },
  };
});

import { sql, withTenant } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { resnapshotFixtureConfig } from "../admin-fixture-config";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { importEvents } from "../event-import";
import { putLineup } from "../fixtures";
import { redoDivision, undoDivision } from "../history";
import { mergePersons, reverseMerge } from "../person-merge";
import { startDivision } from "../schedule";
import {
  computePlayerStats,
  divisionPlayerStats,
  lockPlayerStats,
  personStats,
  playerStatsCoverage,
  publicDivisionStats,
  recomputePlayerStats,
} from "../player-stats";
import {
  assembleRecapEnrichment,
  assembleResultEnrichment,
  loadDivisionHeadlines,
  type ActiveDivision,
  type FixtureCtx,
} from "../org-posts";
import { REFRESH_TIMING, reconcileCheckCap, refreshDivisionPlayerStats } from "../player-stats-refresh";
import { publicCompetitionHub } from "../public";
import { finalizeFixture, scoreEvent } from "../scoring";
import { createStages, deleteStage, generateStageFixtures } from "../stages";
import { football } from "@seazn/engine/sports/football";
import { seedFootballCatalog, seedOrg } from "./_seed";
import { seedOrg as seedGenericOrg, startedDivisionWithFixture } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

const REFRESH_FAILED = "player-stats: refresh failed (the result stands)";
const CHECK_FAILED = "player-stats: the read-side stats check failed (the read was served)";
const GAVE_UP =
  "player-stats: refresh gave up waiting for the division's stats lock; clearing the caches anyway (the result stands)";
const MERGE_RESTARTED = "persons: merge restarting, a roster changed under it";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Every gate a test opened: released after each test, so a red test cannot
 *  leave a transaction holding the stats lock for the tests after it. */
const openGates: Array<() => void> = [];

function gate(): { entered: () => void; release: () => void; hold: { entered: () => void; release: Promise<void> }; wasEntered: Promise<void> } {
  let entered!: () => void;
  const wasEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  openGates.push(release);
  return { entered, release, hold: { entered, release: released }, wasEntered };
}

async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(check: () => Promise<boolean> | boolean, what: string, ms = 10_000): Promise<void> {
  await within(
    (async () => {
      while (!(await check())) await sleep(20);
    })(),
    ms,
    what,
  );
}

/** Wait until the task under test has been refused the lock twice: it is
 *  backing off, not queued, and not finished. */
async function retriedTwice(task: Promise<unknown>): Promise<void> {
  let done = false;
  void task.finally(() => {
    done = true;
  });
  await until(() => {
    if (done) throw new Error("the task finished without being refused the lock");
    return probe.tryLocks >= 2;
  }, "the task retried");
}

/** Run every recorded after-response task, the way `after()` would once the
 *  response has gone. */
async function runAfterResponse(): Promise<void> {
  const tasks = probe.tasks.splice(0);
  await Promise.all(tasks.map((task) => task()));
}

/** Another process's transaction holding the division's stats lock, until the
 *  gate opens. */
function holdStatsLockElsewhere(orgId: string, divisionId: string, then?: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<unknown>) {
  const g = gate();
  const done = withTenant(orgId, async (tx) => {
    await lockPlayerStats(tx, divisionId);
    g.entered();
    await g.hold.release;
    if (then) await then(tx);
  });
  return { ...g, done };
}

interface Scene {
  auth: AuthCtx;
  orgSlug: string;
  compSlug: string;
  competitionId: string;
  divisionId: string;
  stageId: string;
  reds: string;
  ada: string;
  bea: string;
  /** Reds v Blues, Reds v Greens, Blues v Greens — by name. */
  fixture: (a: string, b: string) => { id: string; home: string; away: string };
  entrantOf: (name: string) => string;
}

async function person(orgId: string, fullName: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, consent)
    values (${orgId}, ${fullName}, ${sql.json({ public_name: true } as never)})
    returning id`;
  return row!.id;
}

async function scene(extraReds: string[] = []): Promise<Scene> {
  // Pro: the hub reads leaders only for an org holding `stats.player`.
  const { auth } = await seedOrg("pro");
  await seedFootballCatalog();
  const suffix = randomUUID().slice(0, 8);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Stats Refresh Cup " + suffix,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    sport_key: "football",
    variant_key: "default",
    config: {},
  });
  const ada = await person(auth.orgId, "Ada Striker");
  const bea = await person(auth.orgId, "Bea Winger");
  const extras = await Promise.all(extraReds.map((n) => person(auth.orgId, n)));
  const cy = await person(auth.orgId, "Cy Keeper");
  const fay = await person(auth.orgId, "Fay Green");
  const rosters: Record<string, string[]> = { Reds: [ada, bea, ...extras], Blues: [cy], Greens: [fay] };
  const roster = (ids: string[]) =>
    ids.map((person_id, i) => ({ person_id, squad_number: i + 1, is_captain: i === 0, roles: [], default_position_key: null }));
  const entrants = await createEntrants(auth, division.id, [
    { kind: "team", display_name: "Reds", seed: 1, members: roster(rosters.Reds!) },
    { kind: "team", display_name: "Blues", seed: 2, members: roster(rosters.Blues!) },
    { kind: "team", display_name: "Greens", seed: 3, members: roster(rosters.Greens!) },
  ]);
  const nameOf = new Map(entrants.map((e) => [e.id, e.display_name]));
  const idOf = new Map(entrants.map((e) => [e.display_name, e.id]));
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);
  for (const f of fixtures) {
    for (const eid of [f.home_entrant_id, f.away_entrant_id]) {
      if (!eid) continue;
      await putLineup(auth, f.id, eid, {
        slots: rosters[nameOf.get(eid)!]!.map((person_id, i) => ({
          person_id,
          slot: "starting" as const,
          position_key: null,
          order_no: i + 1,
          roles: [],
        })),
      });
    }
  }
  const [org] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
  // Setup work is not under test: the schedule write's own tasks, and the
  // lineup warnings (a two-player football side is short of eleven).
  probe.tasks.length = 0;
  for (const fn of Object.values(logMock)) fn.mockClear();
  return {
    auth,
    orgSlug: org!.slug,
    compSlug: comp.slug as string,
    competitionId: comp.id,
    divisionId: division.id,
    stageId: stage!.id,
    reds: idOf.get("Reds")!,
    ada,
    bea,
    entrantOf: (name) => idOf.get(name)!,
    fixture: (a, b) => {
      const want = new Set([idOf.get(a), idOf.get(b)]);
      const f = fixtures.find((x) => want.has(x.home_entrant_id!) && want.has(x.away_entrant_id!))!;
      return { id: f.id, home: f.home_entrant_id!, away: f.away_entrant_id! };
    },
  };
}

/** A match driven through the real scoring door, one write at a time. */
function match(s: Scene, fixtureId: string) {
  let seq = 0;
  /** Ids of the events still standing, oldest first: what "undo" takes back. */
  const standing: string[] = [];
  const write = async (type: string, payload: Record<string, unknown>) => {
    const out = await scoreEvent(s.auth, fixtureId, { expected_seq: seq, type, payload });
    seq = out.seq;
    return out;
  };
  const record = async (type: string, payload: Record<string, unknown>) => {
    const out = await write(type, payload);
    const [row] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${fixtureId} and seq = ${out.seq}`;
    standing.push(row!.id);
  };
  return {
    start: () => record("core.start", {}),
    goal: (scorer: string, by: string) => record("football.goal", { by, scorer }),
    half: () => record("football.period", { phase: "HT" }),
    fullTime: () => record("football.period", { phase: "FT" }),
    abandon: () => record("core.abandon", { reason: "rain" }),
    undoLast: () => write("core.void", { event_id: standing.pop()! }),
    finalize: () => finalizeFixture(s.auth, fixtureId, seq),
  };
}

async function goalsOf(divisionId: string, personId: string): Promise<number | null> {
  const [row] = await sql<{ goals: number | null }[]>`
    select (stats->>'goals')::int as goals from player_stat_snapshots
    where division_id = ${divisionId} and person_id = ${personId}`;
  return row?.goals ?? null;
}

async function snapshotRows(divisionId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from player_stat_snapshots where division_id = ${divisionId}`;
  return row!.n;
}

/** What a spectator's hub shows: its tabs and the goals board. */
type PublicRows = { name: string; stats: Record<string, number> }[];

/** The anonymous public stats route for the scene's division. */
async function publicRead(s: Scene): Promise<{ rows: PublicRows }> {
  const [division] = await sql<{ slug: string }[]>`select slug from divisions where id = ${s.divisionId}`;
  return publicDivisionStats(s.orgSlug, s.compSlug, division!.slug);
}

/** The hub document as the page's poll reads it: the route-level usecase, which
 *  is where the read-side stats check runs (final review I1). */
async function hub(s: Scene) {
  const doc = await publicCompetitionHub(s.orgSlug, s.compSlug);
  const goals = (doc?.leaders ?? []).find((b) => b.key === "goals");
  return {
    tabs: doc?.tabs ?? [],
    // By person id: the name a spectator sees is the consent policy's business.
    goals: (goals?.rows ?? []).map((r) => `${r.person.personId}=${r.value}`),
  };
}

/** Lock waiters blocked by `pid` right now. */
async function waitersBlockedBy(pid: number): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_locks
    where not granted and ${pid} = any(pg_blocking_pids(pid))`;
  return row!.n;
}

async function holderPid(divisionId: string): Promise<number> {
  const [row] = await sql<{ pid: number }[]>`
    select l.pid from pg_locks l
    where l.locktype = 'advisory' and l.granted
      and l.objid::bigint = (hashtext(${"player-stats:" + divisionId})::bigint & 4294967295)`;
  return row!.pid;
}

beforeEach(() => {
  probe.tasks.length = 0;
  probe.folds = 0;
  probe.activeFolds = 0;
  probe.maxActiveFolds = 0;
  probe.tryLocks = 0;
  probe.lineupLoads = 0;
  probe.order.length = 0;
  probe.holdNextFold = null;
  probe.holdAfterLedgerRead = null;
  probe.failFold = null;
  probe.failCheck = null;
  probe.slowFoldSeconds = 0;
  probe.withoutPlayerStats = false;
  probe.beforeStatsLocks = null;
  probe.watch = null;
  probe.goalsAtHubDelete.length = 0;
  probe.divisionPushes.length = 0;
  probe.statsTags.length = 0;
  probe.activeChecks = 0;
  probe.maxActiveChecks = 0;
  probe.checked.length = 0;
  probe.holdChecks = null;
  for (const fn of Object.values(logMock)) fn.mockClear();
});

/** Move the wall clock on (Date only; timers stay real). The read-side check
 *  runs at most once a minute per division, and backs off after a failure. */
function later(ms: number): void {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true, now: Date.now() + ms });
}
const A_MINUTE_ON = 61_000;
const TWO_MINUTES = 120_000;
const SIX_HOURS = 6 * 60 * 60_000;

afterEach(() => {
  vi.useRealTimers();
  for (const release of openGates.splice(0)) release();
  probe.holdNextFold = null;
  probe.holdAfterLedgerRead = null;
  probe.failFold = null;
  probe.beforeStatsLocks = null;
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("a result refreshes player stats after the response", () => {
  it("the full-time write returns before any fold, and its after-response task puts Ada on a new Stats tab", async () => {
    const s = await scene();
    const f = s.fixture("Reds", "Blues");
    const m = match(s, f.id);
    await m.start();
    await m.goal(s.ada, s.reds);
    await m.half();
    // Writes during play schedule nothing.
    expect(probe.tasks).toHaveLength(0);

    await m.fullTime();
    // The scorer's request is over, and nothing has folded yet.
    expect(probe.folds).toBe(0);
    expect(await snapshotRows(s.divisionId)).toBe(0);
    expect(probe.tasks).toHaveLength(1);
    expect((await hub(s)).tabs).not.toContain("stats");
    // The hub read found the division behind its result and queued its own
    // check (m8); it joins the result's refresh rather than folding again.
    expect(probe.tasks).toHaveLength(2);

    await runAfterResponse();
    const after = await hub(s);
    expect(after.tabs).toContain("stats");
    expect(after.goals).toEqual([`${s.ada}=1`]);
    expect(probe.folds).toBe(1);
    expect(logMock.warn).not.toHaveBeenCalled();
  }, 60_000);

  it("a second result moves Ada to 2 — the leaders do not freeze at the first read", async () => {
    const s = await scene();
    const first = match(s, s.fixture("Reds", "Blues").id);
    await first.start();
    await first.goal(s.ada, s.reds);
    await first.half();
    await first.fullTime();
    await runAfterResponse();
    expect((await hub(s)).goals).toEqual([`${s.ada}=1`]);

    const second = match(s, s.fixture("Reds", "Greens").id);
    await second.start();
    await second.goal(s.ada, s.reds);
    await second.half();
    await second.fullTime();
    await runAfterResponse();
    expect((await hub(s)).goals).toEqual([`${s.ada}=2`]);
  }, 60_000);

  it("undoing a finished match back past its goal takes the goal off the leaders", async () => {
    const s = await scene();
    const first = match(s, s.fixture("Reds", "Blues").id);
    await first.start();
    await first.goal(s.ada, s.reds);
    await first.half();
    await first.fullTime();
    const second = match(s, s.fixture("Reds", "Greens").id);
    await second.start();
    await second.goal(s.ada, s.reds);
    await second.half();
    await second.fullTime();
    await runAfterResponse();
    expect(await goalsOf(s.divisionId, s.ada)).toBe(2);

    // Undo last, three times: full time, half time, the goal. Every undo
    // schedules, and the fixture is no longer decided after the first.
    await second.undoLast();
    await second.undoLast();
    await second.undoLast();
    expect(probe.tasks).toHaveLength(3);
    const [status] = await sql<{ status: string }[]>`select status from fixtures where id = ${s.fixture("Reds", "Greens").id}`;
    expect(status!.status).not.toBe("decided");
    await runAfterResponse();
    expect(await goalsOf(s.divisionId, s.ada)).toBe(1);
    expect((await hub(s)).goals).toEqual([`${s.ada}=1`]);
  }, 60_000);

  it("an undo during play of an event no fold has read costs no fold and clears nothing", async () => {
    const s = await scene();
    const first = match(s, s.fixture("Reds", "Blues").id);
    await first.start();
    await first.goal(s.ada, s.reds);
    await first.half();
    await first.fullTime();
    await runAfterResponse();
    expect(probe.folds).toBe(1);

    const live = match(s, s.fixture("Reds", "Greens").id);
    await live.start();
    await live.goal(s.bea, s.reds);
    await live.undoLast();
    expect(probe.tasks).toHaveLength(1);
    probe.folds = 0;
    probe.divisionPushes.length = 0;
    await runAfterResponse();
    expect(probe.folds).toBe(0);
    expect(probe.divisionPushes).toEqual([]);
    expect(await goalsOf(s.divisionId, s.bea)).toBeNull();
    expect(await goalsOf(s.divisionId, s.ada)).toBe(1);
  }, 60_000);

  it("an undo of the very last event a fold read is NOT unseen: the refresh folds it away", async () => {
    const s = await scene();
    const fixtureId = s.fixture("Reds", "Blues").id;
    const live = match(s, fixtureId);
    await live.start();
    await live.goal(s.bea, s.reds);
    // A stats read folds the ledger with the goal as the last event it read.
    await withTenant(s.auth.orgId, (tx) => recomputePlayerStats(tx, s.divisionId));
    const [read] = await sql<{ max: number }[]>`
      select (ledger->(${fixtureId}::text)->>1)::int as max from player_stat_folds where division_id = ${s.divisionId}`;
    const [goal] = await sql<{ seq: number }[]>`
      select seq from score_events where fixture_id = ${fixtureId} and type = 'football.goal'`;
    expect(read!.max, "the fold read exactly through the goal").toBe(Number(goal!.seq));
    expect(await goalsOf(s.divisionId, s.bea)).toBe(1);

    await live.undoLast();
    expect(probe.tasks).toHaveLength(1);
    probe.folds = 0;
    await runAfterResponse();
    expect(probe.folds).toBe(1);
    expect(await goalsOf(s.divisionId, s.bea)).toBeNull();
  }, 60_000);

  it("finalizing a decided match schedules no second fold of the division", async () => {
    const s = await scene();
    const m = match(s, s.fixture("Reds", "Blues").id);
    await m.start();
    await m.goal(s.ada, s.reds);
    await m.half();
    await m.fullTime();
    expect(probe.tasks).toHaveLength(1);
    await runAfterResponse();

    await m.finalize();
    expect(probe.tasks).toHaveLength(0);
  }, 60_000);

  it("an import schedules ONE refresh for the division, after its last stream", async () => {
    const s = await scene();
    const stream = (fixture: { id: string }, scorer: string) => ({
      fixture: { id: fixture.id },
      events: [
        { type: "core.start", payload: {} },
        { type: "football.goal", payload: { by: s.reds, scorer } },
        { type: "football.period", payload: { phase: "HT" } },
        { type: "football.period", payload: { phase: "FT" } },
      ],
    });
    const report = await importEvents(s.auth, s.divisionId, {
      import_id: "stats-" + randomUUID().slice(0, 8),
      streams: [stream(s.fixture("Reds", "Blues"), s.ada), stream(s.fixture("Reds", "Greens"), s.ada)],
    });
    expect(report.totals.imported).toBe(2);
    expect(probe.folds).toBe(0);
    expect(probe.tasks).toHaveLength(1);

    await runAfterResponse();
    expect(await goalsOf(s.divisionId, s.ada)).toBe(2);
    expect(probe.folds).toBe(1);
  }, 60_000);

  it("clears the public caches and pushes the division only once the fold has committed", async () => {
    const s = await scene();
    const m = match(s, s.fixture("Reds", "Blues").id);
    await m.start();
    await m.goal(s.ada, s.reds);
    await m.half();
    await m.fullTime();
    probe.order.length = 0;
    probe.divisionPushes.length = 0;
    probe.watch = { divisionId: s.divisionId, personId: s.ada };

    await runAfterResponse();

    // The hub DEL read Ada's COMMITTED row from another connection.
    expect(probe.goalsAtHubDelete).toEqual([1]);
    expect(probe.order).toEqual(["fold:start", "fold:end", "tags", "del:hub", "push:score"]);
    expect(probe.statsTags).toEqual([s.divisionId]);
    expect(probe.divisionPushes).toEqual([`${s.divisionId}:score`]);
  }, 60_000);

  it("a refresh that finds the snapshot current clears nothing when this process already cleared it for that fold", async () => {
    const s = await scene();
    const m = match(s, s.fixture("Reds", "Blues").id);
    await m.start();
    await m.goal(s.ada, s.reds);
    await m.half();
    await m.fullTime();
    probe.divisionPushes.length = 0;
    await runAfterResponse();
    expect(probe.divisionPushes).toEqual([`${s.divisionId}:score`]);

    probe.divisionPushes.length = 0;
    probe.statsTags.length = 0;
    expect(await refreshDivisionPlayerStats(s.auth.orgId, s.divisionId)).toBe("covered");
    expect(probe.divisionPushes).toEqual([]);
    expect(probe.statsTags).toEqual([]);
  }, 60_000);

  it("a division whose board has no rows before or after the fold clears nothing", async () => {
    // `generic` credits results to entrants, never to a person.
    const { auth } = await seedGenericOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    probe.tasks.length = 0;
    await scoreEvent(auth, fixtureId, { expected_seq: 1, type: "generic.result", payload: { p1Score: 3, p2Score: 1 } });
    expect(probe.tasks).toHaveLength(1);
    probe.divisionPushes.length = 0;
    await runAfterResponse();
    expect(probe.folds).toBe(1);
    expect(await snapshotRows(divisionId)).toBe(0);
    expect(probe.divisionPushes).toEqual([]);
    expect(probe.statsTags).toEqual([]);
  }, 60_000);

  it("a failed fold is logged with the division id; the result stands and nothing is pushed", async () => {
    const s = await scene();
    const f = s.fixture("Reds", "Blues");
    const m = match(s, f.id);
    await m.start();
    await m.goal(s.ada, s.reds);
    await m.half();
    probe.failFold = new Error("simulated fold failure");
    await m.fullTime();
    // Only what the after-response task does is under test: the score request
    // pushed the division itself.
    probe.divisionPushes.length = 0;
    await runAfterResponse();

    expect(logMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ divisionId: s.divisionId, err: probe.failFold }),
      REFRESH_FAILED,
    );
    const [row] = await sql<{ status: string }[]>`select status from fixtures where id = ${f.id}`;
    expect(row!.status).toBe("decided");
    expect(probe.divisionPushes).toEqual([]);
    expect(probe.statsTags).toEqual([]);
  }, 60_000);
});

describe.skipIf(!HAS_DB)("writes that change a fold's input without a result (review m3/m4)", () => {
  it("a history undo that deletes a scored fixture queues a refresh that takes its goals off", async () => {
    const s = await scene();
    const live = match(s, s.fixture("Reds", "Blues").id);
    await live.start();
    await live.goal(s.ada, s.reds);
    // A stats read folded the live goal in.
    await withTenant(s.auth.orgId, (tx) => recomputePlayerStats(tx, s.divisionId));
    expect(await goalsOf(s.divisionId, s.ada)).toBe(1);

    const out = await undoDivision(s.auth, s.divisionId);
    expect(out.applied.type).toBe("fixtures_cleared");
    expect(probe.tasks).toHaveLength(1);
    await runAfterResponse();
    expect(await goalsOf(s.divisionId, s.ada)).toBeNull();
  }, 60_000);

  it("a history undo that deletes only fixtures with no events queues nothing", async () => {
    const s = await scene();
    const out = await undoDivision(s.auth, s.divisionId);
    expect(out.applied.type).toBe("fixtures_cleared");
    expect(probe.tasks).toHaveLength(0);
  }, 60_000);

  it("a scored fixture deleted and as many events recorded elsewhere is NOT current: the refresh folds", async () => {
    const s = await scene();
    const live = match(s, s.fixture("Reds", "Blues").id);
    await live.start();
    await live.goal(s.ada, s.reds);
    await live.half();
    // A stats read folded three events, Ada's goal among them.
    await withTenant(s.auth.orgId, (tx) => recomputePlayerStats(tx, s.divisionId));
    expect(await goalsOf(s.divisionId, s.ada)).toBe(1);

    // The deletion's own refresh never runs (a machine stopped, say).
    await undoDivision(s.auth, s.divisionId);
    probe.tasks.length = 0;
    await redoDivision(s.auth, s.divisionId);
    probe.tasks.length = 0;

    // Three new events on another fixture: the ledger holds three again. The
    // redo regenerated the board, so the fixture is looked up afresh.
    const [regenerated] = await sql<{ id: string }[]>`
      select id from fixtures
      where division_id = ${s.divisionId}
        and home_entrant_id in ${sql([s.entrantOf("Blues"), s.entrantOf("Greens")])}
        and away_entrant_id in ${sql([s.entrantOf("Blues"), s.entrantOf("Greens")])}`;
    const other = match(s, regenerated!.id);
    await other.start();
    await other.half();
    await other.fullTime();
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events se join fixtures f on f.id = se.fixture_id
      where f.division_id = ${s.divisionId}`;
    expect(n, "the ledger is back to the count the last fold read").toBe(3);
    probe.folds = 0;
    await runAfterResponse();
    expect(probe.folds).toBe(1);
    expect(await goalsOf(s.divisionId, s.ada)).toBeNull();
  }, 60_000);

  /** The fixtures the division's last fold record says it read. */
  async function foldedFixtures(divisionId: string): Promise<string[] | null> {
    const [row] = await sql<{ ledger: Record<string, unknown> }[]>`
      select ledger from player_stat_folds where division_id = ${divisionId}`;
    return row ? Object.keys(row.ledger) : null;
  }

  it("deleting a stage whose abandoned fixture carried events queues a refresh that refolds without it", async () => {
    const s = await scene();
    const abandoned = s.fixture("Reds", "Blues").id;
    const m = match(s, abandoned);
    await m.start();
    await m.goal(s.ada, s.reds);
    await m.abandon();
    await runAfterResponse();
    // A stats read folded the abandoned match's events in.
    await withTenant(s.auth.orgId, (tx) => recomputePlayerStats(tx, s.divisionId));
    expect(await foldedFixtures(s.divisionId)).toEqual([abandoned]);

    await deleteStage(s.auth, s.stageId);
    expect(probe.tasks).toHaveLength(1);
    probe.folds = 0;
    await runAfterResponse();
    expect(probe.folds).toBe(1);
    expect(await foldedFixtures(s.divisionId)).toEqual([]);
  }, 60_000);

  it("deleting a stage none of whose fixtures carried events queues nothing", async () => {
    const s = await scene();
    await deleteStage(s.auth, s.stageId);
    expect(probe.tasks).toHaveLength(0);
  }, 60_000);

  it("a config re-snapshot, which appends no event, queues a refresh that folds", async () => {
    const s = await scene();
    const m = match(s, s.fixture("Reds", "Blues").id);
    await m.start();
    await m.goal(s.ada, s.reds);
    await m.half();
    await m.fullTime();
    await runAfterResponse();

    // The organiser corrects the division config, and a stats read folds it
    // in: only the fixture's frozen config is now out of step.
    await sql`update divisions set config = ${sql.json(football.configSchema.parse({ halfMinutes: 40 }) as never)} where id = ${s.divisionId}`;
    await withTenant(s.auth.orgId, (tx) => recomputePlayerStats(tx, s.divisionId));
    const [{ id: staff }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, is_staff, staff_role)
      values (${`staff-${randomUUID().slice(0, 8)}@example.test`}, 'Staff', true, 'superadmin')
      returning id`;
    probe.tasks.length = 0;
    probe.folds = 0;
    await resnapshotFixtureConfig(staff, s.fixture("Reds", "Blues").id, "half length was wrong");
    expect(probe.tasks).toHaveLength(1);
    await runAfterResponse();
    expect(probe.folds).toBe(1);
  }, 60_000);
});

describe.skipIf(!HAS_DB)("one refresh transaction at a time per process (review I3)", () => {
  it("another division's refresh waits for the running fold, and repeat requests join the queued one", async () => {
    const one = await scene();
    const two = await scene();
    for (const s of [one, two]) {
      const m = match(s, s.fixture("Reds", "Blues").id);
      await m.start();
      await m.goal(s.ada, s.reds);
      await m.half();
      await m.fullTime();
    }
    const [taskOne, taskTwo] = probe.tasks.splice(0);
    // Only the refreshes' pushes are under test, not the score requests' own.
    probe.divisionPushes.length = 0;

    const g = gate();
    probe.holdAfterLedgerRead = g.hold;
    probe.tryLocks = 0;
    const first = taskOne!() as Promise<unknown>;
    await within(g.wasEntered, 10_000, "division one's fold read its ledger");
    const second = taskTwo!() as Promise<unknown>;
    const repeats = [
      refreshDivisionPlayerStats(two.auth.orgId, two.divisionId),
      refreshDivisionPlayerStats(two.auth.orgId, two.divisionId),
    ];
    await sleep(300);
    expect(probe.folds, "division two has not started").toBe(1);
    expect(probe.tryLocks).toBe(1);

    g.release();
    await within(Promise.all([first, second, ...repeats]), 20_000, "every refresh finished");
    expect(probe.maxActiveFolds).toBe(1);
    // Three requests for division two, one transaction.
    expect(probe.tryLocks).toBe(2);
    expect(probe.folds).toBe(2);
    expect(await goalsOf(two.divisionId, two.ada)).toBe(1);
    expect(probe.divisionPushes.filter((p) => p.startsWith(two.divisionId))).toEqual([`${two.divisionId}:score`]);
  }, 90_000);
});

describe.skipIf(!HAS_DB)("read paths inside a request never wait on another transaction's fold (review I3)", () => {
  async function finishedButNotRefreshed(s: Scene, a: string, b: string, scorer: string) {
    const m = match(s, s.fixture(a, b).id);
    await m.start();
    await m.goal(scorer, s.reds);
    await m.half();
    await m.fullTime();
    probe.tasks.length = 0;
  }

  it("the public stats route folds nothing and never touches the lock: it serves the snapshot as it stands", async () => {
    const s = await scene();
    await finishedButNotRefreshed(s, "Reds", "Blues", s.ada);
    await withTenant(s.auth.orgId, (tx) => recomputePlayerStats(tx, s.divisionId));
    await finishedButNotRefreshed(s, "Reds", "Greens", s.ada);
    const read = () => publicRead(s);
    const adaGoals = (rows: PublicRows) => rows.find((r) => r.name === "Ada Striker")?.stats.goals;

    const holder = holdStatsLockElsewhere(s.auth.orgId, s.divisionId);
    await within(holder.wasEntered, 10_000, "the other process took the lock");
    probe.folds = 0;
    probe.tryLocks = 0;
    const busy = await within(read(), 5_000, "the public read did not wait on the lock");
    expect(adaGoals(busy.rows), "the snapshot as it stands").toBe(1);
    holder.release();
    await holder.done;

    const free = await read();
    expect(adaGoals(free.rows), "still the snapshot: the read never folds").toBe(1);
    expect(probe.folds).toBe(0);
    expect(probe.tryLocks).toBe(0);
  }, 60_000);

  function recapCtx(s: Scene): FixtureCtx {
    return {
      division_id: s.divisionId,
      sport_key: "football",
      module_version: football.version,
    } as FixtureCtx;
  }

  it("an auto-post draft folds in memory when the lock is held and the snapshot is behind, writing nothing", async () => {
    const s = await scene();
    await finishedButNotRefreshed(s, "Reds", "Blues", s.ada);
    const holder = holdStatsLockElsewhere(s.auth.orgId, s.divisionId);
    await within(holder.wasEntered, 10_000, "the other process took the lock");

    const out = await within(
      withTenant(s.auth.orgId, (tx) => assembleRecapEnrichment(tx, recapCtx(s), [])),
      5_000,
      "the draft did not wait on the lock",
    );
    expect(out.leaders).toMatchObject([{ personName: "Ada Striker", value: 1 }]);
    expect(await snapshotRows(s.divisionId)).toBe(0);
    holder.release();
    await holder.done;
  }, 60_000);

  it("a result draft's leaderboard moves never wait on the lock either", async () => {
    const s = await scene();
    const fixtureId = s.fixture("Reds", "Blues").id;
    await finishedButNotRefreshed(s, "Reds", "Blues", s.ada);
    const holder = holdStatsLockElsewhere(s.auth.orgId, s.divisionId);
    await within(holder.wasEntered, 10_000, "the other process took the lock");
    probe.lineupLoads = 0;

    const ctx = { ...recapCtx(s), fixture_id: fixtureId, stage_id: s.stageId, stage_kind: "league" } as FixtureCtx;
    await within(
      withTenant(s.auth.orgId, (tx) =>
        assembleResultEnrichment(tx, ctx, [{ name: "Ada Striker", count: 1, personId: s.ada }]),
      ),
      5_000,
      "the draft did not wait on the lock",
    );
    expect(probe.lineupLoads, "the moves were folded in memory").toBe(1);
    expect(await snapshotRows(s.divisionId)).toBe(0);
    holder.release();
    await holder.done;
  }, 60_000);

  it("an auto-post draft serves the snapshot when the lock is held and the snapshot is current", async () => {
    const s = await scene();
    await finishedButNotRefreshed(s, "Reds", "Blues", s.ada);
    await withTenant(s.auth.orgId, (tx) => recomputePlayerStats(tx, s.divisionId));
    const holder = holdStatsLockElsewhere(s.auth.orgId, s.divisionId);
    await within(holder.wasEntered, 10_000, "the other process took the lock");
    probe.lineupLoads = 0;

    const out = await within(
      withTenant(s.auth.orgId, (tx) => assembleRecapEnrichment(tx, recapCtx(s), [])),
      5_000,
      "the draft did not wait on the lock",
    );
    expect(out.leaders).toMatchObject([{ personName: "Ada Striker", value: 1 }]);
    expect(probe.lineupLoads, "no fold ran, in memory or otherwise").toBe(0);
    holder.release();
    await holder.done;
  }, 60_000);
});

describe.skipIf(!HAS_DB)("the console, the player card and the digest fold only when behind, and never wait on the lock (review n3)", () => {
  /** Ada scores in a finished match whose refresh never ran. */
  async function adaScoresIn(s: Scene, a: string, b: string) {
    const m = match(s, s.fixture(a, b).id);
    await m.start();
    await m.goal(s.ada, s.reds);
    await m.half();
    await m.fullTime();
    probe.tasks.length = 0;
  }
  const foldedAt = async (divisionId: string) => {
    const [row] = await sql<{ at: string }[]>`
      select folded_at::text as at from player_stat_folds where division_id = ${divisionId}`;
    return row?.at ?? null;
  };
  const fold = (s: Scene) => withTenant(s.auth.orgId, (tx) => recomputePlayerStats(tx, s.divisionId));

  const READS: ReadonlyArray<{ what: string; adaGoals: (s: Scene) => Promise<number | null> }> = [
    {
      what: "the console leaderboard",
      adaGoals: async (s) =>
        (await divisionPlayerStats(s.auth, s.divisionId, {})).rows.find((r) => r.person_id === s.ada)?.stats.goals ?? null,
    },
    {
      what: "the player card",
      adaGoals: async (s) =>
        (await personStats(s.auth, s.ada)).divisions.find((d) => d.division_id === s.divisionId)?.stats.goals ?? null,
    },
    {
      what: "the digest headlines",
      adaGoals: async (s) => {
        const division: ActiveDivision = {
          division_id: s.divisionId,
          division_name: "Open",
          sport_key: "football",
          module_version: football.version,
        };
        const out = await withTenant(s.auth.orgId, (tx) => loadDivisionHeadlines(tx, [division]));
        return out.get(s.divisionId)?.rows.find((r) => r.personId === s.ada)?.stats.goals ?? null;
      },
    },
  ];

  describe.each(READS)("$what", ({ adaGoals }) => {
    it("serves a current snapshot as it stands: no fold, and the fold record is untouched", async () => {
      const s = await scene();
      await adaScoresIn(s, "Reds", "Blues");
      await fold(s);
      const before = await foldedAt(s.divisionId);
      probe.lineupLoads = 0;
      expect(await adaGoals(s)).toBe(1);
      expect(probe.lineupLoads, "no fold ran").toBe(0);
      expect(await foldedAt(s.divisionId)).toBe(before);
    }, 60_000);

    it("refolds and writes a snapshot behind a result when the lock is free", async () => {
      const s = await scene();
      await adaScoresIn(s, "Reds", "Blues");
      await fold(s);
      await adaScoresIn(s, "Reds", "Greens");
      expect(await adaGoals(s)).toBe(2);
      expect(await goalsOf(s.divisionId, s.ada), "the refold was written").toBe(2);
    }, 60_000);

    it("folds a snapshot behind only a match in play, and queues no refresh for it", async () => {
      const s = await scene();
      await adaScoresIn(s, "Reds", "Blues");
      await fold(s);
      const live = match(s, s.fixture("Reds", "Greens").id);
      await live.start();
      await live.goal(s.ada, s.reds);
      probe.tasks.length = 0;
      expect(await adaGoals(s), "the match in play is folded in").toBe(2);
      expect(probe.tasks, "no refresh: nothing a scheduling write owed").toHaveLength(0);
    }, 60_000);

    it("never waits on a lock held elsewhere: behind, it folds in memory and writes nothing; current, it serves the snapshot", async () => {
      const s = await scene();
      await adaScoresIn(s, "Reds", "Blues");
      await fold(s);
      await adaScoresIn(s, "Reds", "Greens");
      const busy = holdStatsLockElsewhere(s.auth.orgId, s.divisionId);
      await within(busy.wasEntered, 10_000, "the other process took the lock");
      expect(await within(adaGoals(s), 5_000, "the read did not wait on the lock"), "folded in memory").toBe(2);
      expect(await goalsOf(s.divisionId, s.ada), "nothing written").toBe(1);
      busy.release();
      await busy.done;

      await fold(s);
      const current = holdStatsLockElsewhere(s.auth.orgId, s.divisionId);
      await within(current.wasEntered, 10_000, "the other process took the lock");
      probe.lineupLoads = 0;
      expect(await within(adaGoals(s), 5_000, "the read did not wait on the lock")).toBe(2);
      expect(probe.lineupLoads, "no fold ran").toBe(0);
      current.release();
      await current.done;
    }, 60_000);
  });
});

describe.skipIf(!HAS_DB)("a refresh lost to a restart heals on the next stats read (owner ruling 2026-09-17, m8)", () => {
  const QUEUED = "player-stats: a read found the snapshot behind a result; refresh queued";
  const adaGoals = (rows: PublicRows) => rows.find((r) => r.name === "Ada Striker")?.stats.goals ?? null;

  /** A result whose after-response refresh never ran: the process stopped with
   *  it queued. The database keeps the result; the in-memory queue is gone. */
  async function lostResult(s: Scene, a: string, b: string, scorer: string) {
    const m = match(s, s.fixture(a, b).id);
    await m.start();
    await m.goal(scorer, s.reds);
    await m.half();
    await m.fullTime();
    probe.tasks.length = 0;
  }

  const queuedFor = (divisionId: string) =>
    logMock.info.mock.calls.filter(([ctx, text]) => text === QUEUED && (ctx as { divisionId?: string }).divisionId === divisionId);

  it("the public stats route serves what it has, and its check after the response queues the lost refresh", async () => {
    const s = await scene();
    await lostResult(s, "Reds", "Blues", s.ada);
    probe.folds = 0;
    const before = await publicRead(s);
    expect(adaGoals(before.rows), "the read serves what it has").toBeNull();
    expect(probe.folds, "no fold on the read path").toBe(0);
    expect(probe.tasks).toHaveLength(1);

    probe.order.length = 0;
    await runAfterResponse();
    expect(queuedFor(s.divisionId)).toHaveLength(1);
    expect(probe.folds).toBe(1);
    expect(probe.order).toEqual(["fold:start", "fold:end", "tags", "del:hub", "push:score"]);
    expect(adaGoals((await publicRead(s)).rows)).toBe(1);
  }, 60_000);

  it("the hub's leader boards heal the same way", async () => {
    const s = await scene();
    await lostResult(s, "Reds", "Blues", s.ada);
    const before = await hub(s);
    expect(before.goals).toEqual([]);
    expect(before.tabs).not.toContain("stats");
    expect(probe.tasks).toHaveLength(1);

    await runAfterResponse();
    expect(queuedFor(s.divisionId)).toHaveLength(1);
    expect((await hub(s)).goals).toEqual([`${s.ada}=1`]);
  }, 60_000);

  it("a hub poll for an org denied stats.player checks nothing (final review round 2, n1)", async () => {
    const s = await scene();
    await lostResult(s, "Reds", "Blues", s.ada);
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${s.auth.orgId}, 'stats.player', false, 'test')`;
    await invalidateOrgEntitlements(s.auth.orgId);
    await hub(s);
    expect(probe.tasks, "the gate is paid after the response").toHaveLength(1);
    await runAfterResponse();
    expect(probe.checked, "no check for an org without player stats").toEqual([]);
    expect(queuedFor(s.divisionId)).toEqual([]);

    // Granted again, the next poll checks the division and queues its refresh.
    await sql`delete from org_entitlement_overrides where org_id = ${s.auth.orgId} and feature_key = 'stats.player'`;
    await invalidateOrgEntitlements(s.auth.orgId);
    later(A_MINUTE_ON);
    await hub(s);
    await runAfterResponse();
    expect(probe.checked).toEqual([s.divisionId]);
    expect(queuedFor(s.divisionId)).toHaveLength(1);
  }, 60_000);

  it("the console leaderboard, which folds a snapshot behind a result, queues the lost refresh so the public copies are cleared too", async () => {
    const s = await scene();
    await lostResult(s, "Reds", "Blues", s.ada);
    const board = await divisionPlayerStats(s.auth, s.divisionId, {});
    expect(board.rows.find((r) => r.person_id === s.ada)?.stats.goals).toBe(1);
    expect(probe.tasks).toHaveLength(1);

    probe.folds = 0;
    probe.order.length = 0;
    await runAfterResponse();
    expect(probe.folds, "the console's fold already covered it").toBe(0);
    expect(probe.order).toEqual(["tags", "del:hub", "push:score"]);

    // Current now: a second console read queues nothing.
    await divisionPlayerStats(s.auth, s.divisionId, {});
    expect(probe.tasks).toHaveLength(0);
  }, 60_000);

  it("a snapshot that is current queues nothing, and neither do goals in a match still in play", async () => {
    const s = await scene();
    const readAndCheck = async () => {
      later(A_MINUTE_ON); // past the per-division check interval
      probe.folds = 0;
      probe.tryLocks = 0;
      logMock.info.mockClear();
      await publicRead(s);
      await hub(s);
      expect(probe.tasks, "one check per division in flight").toHaveLength(1);
      await runAfterResponse();
      expect(queuedFor(s.divisionId)).toEqual([]);
      expect(probe.tryLocks, "no refresh was queued").toBe(0);
      expect(probe.folds).toBe(0);
    };
    // Never folded, and nothing played to a result yet: nothing is owed.
    const live = match(s, s.fixture("Reds", "Greens").id);
    await live.start();
    await live.goal(s.bea, s.reds);
    probe.tasks.length = 0;
    await readAndCheck();

    const done = match(s, s.fixture("Reds", "Blues").id);
    await done.start();
    await done.goal(s.ada, s.reds);
    await done.half();
    await done.fullTime();
    await runAfterResponse();
    await readAndCheck();

    // A match in play moves the ledger, but its goals reach the boards at the
    // next refresh by design, so reads do not refold the division per goal.
    await live.goal(s.ada, s.reds);
    probe.tasks.length = 0;
    await readAndCheck();

    // Nor does a match that kicks off after the fold (its first event), or a
    // lineup edit in a match in play: the md5 hashes settled fixtures only.
    const kickOff = match(s, s.fixture("Blues", "Greens").id);
    await kickOff.start();
    probe.tasks.length = 0;
    await readAndCheck();
    await sql`update lineups set order_no = order_no + 10 where fixture_id = ${s.fixture("Reds", "Greens").id}`;
    await readAndCheck();
  }, 60_000);

  it("an undo of a result whose refresh was lost heals on the next read", async () => {
    const s = await scene();
    const m = match(s, s.fixture("Reds", "Blues").id);
    await m.start();
    await m.goal(s.ada, s.reds);
    await m.half();
    await m.fullTime();
    await runAfterResponse();
    expect(await goalsOf(s.divisionId, s.ada)).toBe(1);

    // Undo back past the goal; every one of those refreshes is lost.
    await m.undoLast();
    await m.undoLast();
    await m.undoLast();
    probe.tasks.length = 0;
    await publicRead(s);
    await runAfterResponse();
    expect(queuedFor(s.divisionId)).toHaveLength(1);
    expect(await goalsOf(s.divisionId, s.ada)).toBeNull();
  }, 60_000);

  it("a stage delete whose refresh was lost, after its abandoned match's events were folded, heals on the next read", async () => {
    const s = await scene();
    const abandoned = s.fixture("Reds", "Blues").id;
    const m = match(s, abandoned);
    await m.start();
    await m.goal(s.ada, s.reds);
    await m.abandon();
    await runAfterResponse();
    await withTenant(s.auth.orgId, (tx) => recomputePlayerStats(tx, s.divisionId));
    const ledgerKeys = async () => {
      const [row] = await sql<{ ledger: Record<string, unknown> }[]>`
        select ledger from player_stat_folds where division_id = ${s.divisionId}`;
      return Object.keys(row!.ledger);
    };
    expect(await ledgerKeys()).toEqual([abandoned]);

    // No played fixture moves, so only the gone fixture says the snapshot is behind.
    await deleteStage(s.auth, s.stageId);
    probe.tasks.length = 0;
    await publicRead(s);
    await runAfterResponse();
    expect(queuedFor(s.divisionId)).toHaveLength(1);
    expect(await ledgerKeys()).toEqual([]);
  }, 60_000);

  it("a sport that declares no player stats is never owed, so its reads queue nothing", async () => {
    const s = await scene();
    await lostResult(s, "Reds", "Blues", s.ada);
    probe.withoutPlayerStats = true;
    await publicRead(s);
    await runAfterResponse();
    expect(queuedFor(s.divisionId), "no refresh for a division that never gets a fold record").toEqual([]);

    // The same division with its model back owes the lost result.
    probe.withoutPlayerStats = false;
    later(A_MINUTE_ON);
    await publicRead(s);
    await runAfterResponse();
    expect(queuedFor(s.divisionId)).toHaveLength(1);
  }, 60_000);

  it("a roster edit, which schedules nothing, is folded in by the refresh the next read queues", async () => {
    const s = await scene();
    const done = match(s, s.fixture("Reds", "Blues").id);
    await done.start();
    await done.goal(s.ada, s.reds);
    await done.half();
    await done.fullTime();
    await runAfterResponse();

    const late = await person(s.auth.orgId, "Late Signing");
    await sql`
      insert into entrant_members (entrant_id, person_id, squad_number, is_captain, roles)
      values (${s.reds}, ${late}, 99, false, ${sql.json([])})`;
    probe.folds = 0;
    await publicRead(s);
    await runAfterResponse();
    expect(queuedFor(s.divisionId)).toHaveLength(1);
    expect(probe.folds).toBe(1);
  }, 60_000);

  it("a burst of reads checks once and queues one refresh", async () => {
    const s = await scene();
    await lostResult(s, "Reds", "Blues", s.ada);
    probe.folds = 0;
    await Promise.all([publicRead(s), publicRead(s), publicRead(s), hub(s), publicRead(s), hub(s)]);
    expect(probe.tasks).toHaveLength(1);
    await runAfterResponse();
    expect(queuedFor(s.divisionId)).toHaveLength(1);
    expect(probe.folds).toBe(1);
    // Behind again only once something moves: the next reads queue nothing.
    await Promise.all([publicRead(s), hub(s)]);
    await runAfterResponse();
    expect(queuedFor(s.divisionId)).toHaveLength(1);
    expect(probe.folds).toBe(1);
  }, 60_000);

  it("a queued refresh that fails quiets the division's read checks instead of refolding per read", async () => {
    const s = await scene();
    await lostResult(s, "Reds", "Blues", s.ada);
    probe.failFold = new Error("the fold threw");
    await publicRead(s);
    await runAfterResponse();
    expect(logMock.warn).toHaveBeenCalledWith(expect.objectContaining({ divisionId: s.divisionId }), REFRESH_FAILED);
    probe.failFold = null;

    later(A_MINUTE_ON);
    await publicRead(s);
    await hub(s);
    expect(probe.tasks, "no check while the division is quiet").toHaveLength(0);
  }, 60_000);

  it("a queued refresh that gives up on a lock that never frees quiets for the base step each time, and grows no back-off (final review round 2, I1)", async () => {
    const s = await scene();
    await lostResult(s, "Reds", "Blues", s.ada);
    const checkAfter = async (ms: number) => {
      later(ms);
      await publicRead(s);
      const checked = probe.tasks.length;
      await runAfterResponse();
      return checked;
    };
    const saved = { ...REFRESH_TIMING };
    Object.assign(REFRESH_TIMING, { backoffMs: [], lockTimeoutMs: 200 });
    const holder = holdStatsLockElsewhere(s.auth.orgId, s.divisionId);
    try {
      await within(holder.wasEntered, 10_000, "the other process took the lock");
      expect(await checkAfter(0)).toBe(1);
      expect(logMock.warn).toHaveBeenCalledWith(expect.objectContaining({ divisionId: s.divisionId }), GAVE_UP);
      for (const again of [1, 2]) {
        expect(await checkAfter(TWO_MINUTES - 5_000), `quiet for the base step, busy ${again}`).toBe(0);
        expect(await checkAfter(10_000), `checked again after the base step, busy ${again}`).toBe(1);
      }
    } finally {
      Object.assign(REFRESH_TIMING, saved);
      holder.release();
      await holder.done;
    }
    // Three busy refreshes grew nothing: the first failure after them quiets
    // for the base step too.
    probe.failFold = new Error("the fold threw");
    expect(await checkAfter(TWO_MINUTES + 5_000)).toBe(1);
    expect(await checkAfter(TWO_MINUTES - 5_000), "quiet after the failure").toBe(0);
    expect(await checkAfter(10_000), "the base step, not a fourth doubling").toBe(1);
  }, 90_000);

  it("refreshes that keep failing back off, doubling to a cap of ten minutes (final review round 2, I1)", async () => {
    const s = await scene();
    await lostResult(s, "Reds", "Blues", s.ada);
    probe.failFold = new Error("canceling statement due to statement timeout");
    const checkAfter = async (ms: number) => {
      later(ms);
      await publicRead(s);
      const checked = probe.tasks.length;
      await runAfterResponse();
      return checked;
    };
    expect(await checkAfter(0)).toBe(1);
    // 2, 4, 8 minutes, then ten for good.
    for (const minutes of [2, 4, 8, 10, 10]) {
      expect(await checkAfter(minutes * 60_000 - 5_000), `still quiet ${minutes} min after a failure`).toBe(0);
      expect(await checkAfter(10_000), `checked again after ${minutes} min`).toBe(1);
    }
  }, 120_000);

  it("a success resets the back-off, so the next failure quiets for the first step again (final review m6)", async () => {
    const s = await scene();
    await lostResult(s, "Reds", "Blues", s.ada);
    const checkAfter = async (ms: number) => {
      later(ms);
      await publicRead(s);
      const checked = probe.tasks.length;
      await runAfterResponse();
      return checked;
    };
    probe.failFold = new Error("the fold threw");
    expect(await checkAfter(0)).toBe(1);
    expect(await checkAfter(2 * 60_000 + 5_000), "after the 2-minute step").toBe(1);
    probe.failFold = null;
    expect(await checkAfter(4 * 60_000 + 5_000), "after the 4-minute step: this one folds").toBe(1);
    expect(await goalsOf(s.divisionId, s.ada)).toBe(1);

    await lostResult(s, "Reds", "Greens", s.ada);
    probe.failFold = new Error("the fold threw again");
    expect(await checkAfter(A_MINUTE_ON)).toBe(1);
    expect(await checkAfter(2 * 60_000 + 5_000), "2 minutes, not the 8 the old streak would give").toBe(1);
  }, 120_000);

  it("a check that throws quiets the division, doubling the same way (final review m6, round 2 I1)", async () => {
    const s = await scene();
    await lostResult(s, "Reds", "Blues", s.ada);
    probe.failCheck = new Error("the check threw");
    await publicRead(s);
    await runAfterResponse();
    expect(logMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ divisionId: s.divisionId, err: probe.failCheck }),
      CHECK_FAILED,
    );

    later(A_MINUTE_ON);
    await publicRead(s);
    expect(probe.tasks, "no check while the division is quiet").toHaveLength(0);
    later(TWO_MINUTES);
    await publicRead(s);
    expect(probe.tasks, "checked after the base step").toHaveLength(1);
    await runAfterResponse();
    expect(logMock.warn.mock.calls.filter(([, text]) => text === CHECK_FAILED)).toHaveLength(2);
    probe.failCheck = null;

    later(2 * TWO_MINUTES - 5_000);
    await publicRead(s);
    expect(probe.tasks, "the second throw quiets for twice the base step").toHaveLength(0);
    later(10_000);
    await publicRead(s);
    expect(probe.tasks).toHaveLength(1);
    await runAfterResponse();
    expect(queuedFor(s.divisionId)).toHaveLength(1);
  }, 60_000);

  it("healthy checks between incidents reset the back-off, however far the incident before had grown it (final review round 2, I1)", async () => {
    const s = await scene();
    await lostResult(s, "Reds", "Blues", s.ada);
    const checkAfter = async (ms: number) => {
      later(ms);
      await publicRead(s);
      const checked = probe.tasks.length;
      await runAfterResponse();
      return checked;
    };
    probe.failFold = new Error("incident one");
    expect(await checkAfter(0)).toBe(1);
    expect(await checkAfter(TWO_MINUTES + 5_000)).toBe(1);
    expect(await checkAfter(2 * TWO_MINUTES + 5_000), "a third failure: eight minutes quiet").toBe(1);
    // The incident ends: a scoring write's own refresh folds the division, so
    // no read-queued refresh succeeds and resets anything.
    probe.failFold = null;
    expect(await refreshDivisionPlayerStats(s.auth.orgId, s.divisionId)).toBe("folded");
    expect(await checkAfter(4 * TWO_MINUTES + 5_000), "a healthy check").toBe(1);
    expect(await checkAfter(SIX_HOURS), "a healthy check").toBe(1);
    expect(await checkAfter(SIX_HOURS), "a healthy check").toBe(1);
    expect(queuedFor(s.divisionId), "the healthy checks queued nothing").toHaveLength(3);

    // Incident two starts from the base step again.
    await lostResult(s, "Reds", "Greens", s.ada);
    probe.failFold = new Error("incident two");
    expect(await checkAfter(A_MINUTE_ON)).toBe(1);
    expect(await checkAfter(TWO_MINUTES - 5_000), "quiet").toBe(0);
    expect(await checkAfter(10_000), "the base step, not the fourth doubling").toBe(1);
  }, 120_000);

  it("a match abandoned after a goal, whose refresh never came, heals on the next read, and so do later changes to it (final review m2)", async () => {
    const s = await scene();
    const done = match(s, s.fixture("Reds", "Blues").id);
    await done.start();
    await done.goal(s.ada, s.reds);
    await done.half();
    await done.fullTime();
    await runAfterResponse();
    const abandoned = match(s, s.fixture("Reds", "Greens").id);
    await abandoned.start();
    await abandoned.goal(s.ada, s.reds);
    await abandoned.abandon();
    probe.tasks.length = 0;
    expect(await goalsOf(s.divisionId, s.ada)).toBe(1);

    await publicRead(s);
    await runAfterResponse();
    expect(queuedFor(s.divisionId)).toHaveLength(1);
    expect(await goalsOf(s.divisionId, s.ada), "the abandoned match's goal, as the console already shows it").toBe(2);

    // A late event on the abandoned match once its earlier events are folded,
    // whose refresh never came: the goal is taken back. The fixture is already
    // among the md5's settled fixtures, so only the ledger sees the new event.
    const lateId = s.fixture("Reds", "Greens").id;
    const [goal] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${lateId} and type = 'football.goal'`;
    const [last] = await sql<{ seq: number }[]>`select max(seq)::int as seq from score_events where fixture_id = ${lateId}`;
    await scoreEvent(s.auth, lateId, { expected_seq: last!.seq, type: "core.void", payload: { event_id: goal!.id } });
    const [fixture] = await sql<{ status: string }[]>`select status from fixtures where id = ${lateId}`;
    expect(fixture!.status, "the late event leaves the match abandoned").toBe("abandoned");
    probe.tasks.length = 0;
    later(A_MINUTE_ON);
    await publicRead(s);
    await runAfterResponse();
    expect(queuedFor(s.divisionId)).toHaveLength(2);
    expect(await goalsOf(s.divisionId, s.ada), "the late undo").toBe(1);

    // An input edit to it with no event (its frozen config): only the inputs
    // md5 sees that, so its settled fixtures include the abandoned one.
    await sql`update fixtures set config_snapshot = ${sql.json(football.configSchema.parse({ halfMinutes: 40 }) as never)} where id = ${lateId}`;
    later(A_MINUTE_ON);
    await publicRead(s);
    await runAfterResponse();
    expect(queuedFor(s.divisionId), "the edit to the abandoned match").toHaveLength(3);
  }, 60_000);
});

describe.skipIf(!HAS_DB)("read-side checks are rate-limited and capped across the process (final review I2)", () => {
  /** The scene's competition with nine more divisions: ten in all. */
  async function tenDivisions() {
    const s = await scene();
    const ids = [s.divisionId];
    for (let i = 0; i < 9; i += 1) {
      const d = await createDivision(s.auth, s.competitionId, {
        name: `Extra ${i} ${randomUUID().slice(0, 4)}`,
        sport_key: "football",
        variant_key: "default",
        config: {},
      });
      ids.push(d.id);
    }
    probe.tasks.length = 0;
    return { s, ids };
  }

  /** The cap follows the configured pool (owner input 2026-09-17: production
   *  runs 20 connections, locally 5). Only the env the cap reads changes; the
   *  test's own pool is already open and keeps its size. */
  for (const { pool, cap } of [
    { pool: "5", cap: 1 },
    { pool: "20", cap: 4 },
  ]) {
    describe(`with a pool of ${pool}`, () => {
      let savedPool: string | undefined;
      beforeEach(() => {
        savedPool = process.env.DB_POOL_MAX;
        process.env.DB_POOL_MAX = pool;
      });
      afterEach(() => {
        if (savedPool === undefined) delete process.env.DB_POOL_MAX;
        else process.env.DB_POOL_MAX = savedPool;
      });

      it(`a burst of hub reads across ten divisions checks each division once, never more than ${cap} at a time, and a read inside the minute checks nothing`, async () => {
        const { s, ids } = await tenDivisions();
        await Promise.all([hub(s), hub(s), hub(s), hub(s), hub(s)]);
        await runAfterResponse();
        expect([...probe.checked].sort()).toEqual([...ids].sort());
        expect(probe.maxActiveChecks, "connections held by checks at once").toBeLessThanOrEqual(cap);

        probe.checked.length = 0;
        await hub(s);
        await runAfterResponse();
        expect(probe.checked, "inside the minute").toEqual([]);
        later(A_MINUTE_ON);
        await hub(s);
        await runAfterResponse();
        expect(probe.checked).toHaveLength(10);
      }, 90_000);

      it(`checks from many reads at once hold at most ${cap} connections, and a division skipped for it is checked by a later read`, async () => {
        const { s, ids } = await tenDivisions();
        const slugs = await sql<{ id: string; slug: string }[]>`select id, slug from divisions where id = any(${ids})`;
        const readAll = () => Promise.all(slugs.map((d) => publicDivisionStats(s.orgSlug, s.compSlug, d.slug)));
        const everyChecked = new Set<string>();
        for (let round = 0; round < ids.length && everyChecked.size < ids.length; round += 1) {
          let release!: () => void;
          probe.holdChecks = new Promise<void>((resolve) => {
            release = resolve;
          });
          openGates.push(release);
          probe.checked.length = 0;
          await readAll();
          const running = runAfterResponse();
          const full = Math.min(cap, ids.length - everyChecked.size);
          await until(() => probe.activeChecks === full, `${full} checks are running`);
          await sleep(100);
          expect(probe.activeChecks, "no further check starts while the cap is taken").toBe(full);
          release();
          await running;
          probe.holdChecks = null;
          expect(probe.checked.every((d) => !everyChecked.has(d)), "a checked division is not checked again").toBe(true);
          for (const d of probe.checked) everyChecked.add(d);
        }
        expect(probe.maxActiveChecks).toBe(cap);
        expect(everyChecked.size, "every division checked").toBe(ids.length);
      }, 120_000);
    });
  }
});

describe("the read-side check cap is a fifth of the configured DB pool (final review I2)", () => {
  it.each([
    [undefined, 1],
    ["1", 1],
    ["5", 1],
    ["9", 1],
    ["10", 2],
    ["20", 4],
    ["50", 10],
  ])("DB_POOL_MAX=%s allows %i", (pool, cap) => {
    expect(reconcileCheckCap({ DATABASE_URL: "postgres://u@localhost:5432/x", DB_POOL_MAX: pool })).toBe(cap);
  });
});

describe.skipIf(!HAS_DB)("every input the fold reads is in the fold record's fingerprint (review n1)", () => {
  /** A division folded once after a result, with lineups on every fixture. */
  async function folded(before?: (s: Scene) => Promise<unknown>) {
    const s = await scene();
    await before?.(s);
    const m = match(s, s.fixture("Reds", "Blues").id);
    await m.start();
    await m.goal(s.ada, s.reds);
    await m.half();
    await m.fullTime();
    await runAfterResponse();
    return s;
  }
  const coverage = (s: Scene) => withTenant(s.auth.orgId, (tx) => playerStatsCoverage(tx, s.divisionId));

  /** One edit per input, keyed by the table the fold reads it from. None of
   *  them appends an event, so only the inputs md5 can see it. */
  const EDITS: ReadonlyArray<{
    table: string;
    what: string;
    /** Setup before the fold, so the edit moves one input and nothing else. */
    before?: (s: Scene) => Promise<unknown>;
    edit: (s: Scene) => Promise<unknown>;
  }> = [
    {
      table: "divisions",
      what: "the division config",
      edit: (s) => sql`update divisions set config = ${sql.json(football.configSchema.parse({ halfMinutes: 40 }) as never)} where id = ${s.divisionId}`,
    },
    {
      table: "stages",
      what: "the stage config",
      edit: (s) => sql`update stages set config = ${sql.json({ note: "edited" } as never)} where id = ${s.stageId}`,
    },
    {
      table: "fixtures",
      what: "a played fixture's frozen config",
      edit: (s) =>
        sql`update fixtures set config_snapshot = ${sql.json(football.configSchema.parse({ halfMinutes: 40 }) as never)} where id = ${s.fixture("Reds", "Blues").id}`,
    },
    {
      table: "entrants",
      what: "an entrant's kind",
      edit: (s) => sql`update entrants set kind = 'individual' where id = ${s.entrantOf("Blues")}`,
    },
    {
      table: "entrant_members",
      what: "a roster member no lineup names, swapped for another person",
      // A member in no lineup, so the lineups' joined squad numbers cannot see
      // the swap for the roster: only the roster's own person column can.
      before: async (s) => {
        const spare = await person(s.auth.orgId, "Roster Spare");
        await sql`
          insert into entrant_members (entrant_id, person_id, squad_number, is_captain, roles)
          values (${s.entrantOf("Blues")}, ${spare}, null, false, ${sql.json([])})`;
      },
      edit: async (s) => {
        const other = await person(s.auth.orgId, "Swapped In");
        await sql`
          update entrant_members set person_id = ${other}
          where entrant_id = ${s.entrantOf("Blues")}
            and person_id = (select id from persons where org_id = ${s.auth.orgId} and full_name = 'Roster Spare')`;
      },
    },
    {
      table: "lineups",
      what: "a played fixture's lineup naming another member of the same team",
      // Blues field one player and carry no squad numbers, so the swap moves no
      // row's order and no joined squad number: only the lineup's person column
      // can see it.
      before: async (s) => {
        const sub = await person(s.auth.orgId, "Blues Sub");
        await sql`update entrant_members set squad_number = null where entrant_id = ${s.entrantOf("Blues")}`;
        await sql`
          insert into entrant_members (entrant_id, person_id, squad_number, is_captain, roles)
          values (${s.entrantOf("Blues")}, ${sub}, null, false, ${sql.json([])})`;
      },
      edit: (s) => sql`
        update lineups
        set person_id = (select id from persons where org_id = ${s.auth.orgId} and full_name = 'Blues Sub')
        where fixture_id = ${s.fixture("Reds", "Blues").id} and entrant_id = ${s.entrantOf("Blues")}`,
    },
    {
      table: "persons",
      what: "a merge tombstone in the org",
      edit: async (s) => {
        const twin = await person(s.auth.orgId, "Ada Striker");
        await sql`update persons set merged_into = ${s.ada} where id = ${twin}`;
      },
    },
  ];

  it.each(EDITS)("$table: $what leaves the snapshot not covered, and owed", async ({ before: setup, edit }) => {
    const s = await folded(setup);
    const before = await coverage(s);
    expect(before.covered, "covered before the edit").toBe(true);
    await edit(s);
    const after = await coverage(s);
    expect(after.drift, "no event moved").toEqual([]);
    expect(after.covered).toBe(false);
    expect(after.owed).toBe(true);
  }, 60_000);

  it("the fold reads exactly the tables above plus the score events, so a new input cannot skip the fingerprint", async () => {
    const s = await folded();
    const read = new Set<string>();
    await withTenant(s.auth.orgId, async (tx) => {
      const spy = new Proxy(tx, {
        apply(target, thisArg, args: unknown[]) {
          const strings = args[0] as { raw?: readonly string[] } | undefined;
          if (strings !== undefined && Array.isArray(strings.raw)) {
            for (const [, table] of strings.raw.join(" ? ").matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)) {
              read.add(table!.toLowerCase());
            }
          }
          return Reflect.apply(target as never, thisArg, args);
        },
      });
      const { rows } = await computePlayerStats(spy, s.divisionId);
      expect(rows.length, "the spied fold still folds").toBeGreaterThan(0);
    });
    // `score_events` is the ledger half of the record; every other table the
    // fold reads needs an edit case above.
    expect([...read].sort()).toEqual([...new Set(["score_events", ...EDITS.map((e) => e.table)])].sort());
  }, 60_000);
});

describe.skipIf(!HAS_DB)("an undo and a result queued together (review m6)", () => {
  it("a result that joins a queued undo still folds, even when the undo alone would have skipped", async () => {
    const one = await scene();
    const two = await scene();
    const first = match(one, one.fixture("Reds", "Blues").id);
    await first.start();
    await first.goal(one.ada, one.reds);
    await first.half();
    await first.fullTime();
    const [taskOne] = probe.tasks.splice(0);

    // Division two has been folded once; then an undo during play, then a result.
    const settled = match(two, two.fixture("Reds", "Blues").id);
    await settled.start();
    await settled.half();
    await settled.fullTime();
    await runAfterResponse();
    const live = match(two, two.fixture("Reds", "Greens").id);
    await live.start();
    await live.goal(two.bea, two.reds);
    await live.goal(two.ada, two.reds);
    await live.undoLast();
    const [undoTask] = probe.tasks.splice(0);
    await live.half();
    await live.fullTime();
    const [resultTask] = probe.tasks.splice(0);

    // Both of division two's requests queue behind division one's fold.
    const g = gate();
    probe.holdAfterLedgerRead = g.hold;
    const running = taskOne!() as Promise<unknown>;
    await within(g.wasEntered, 10_000, "division one is folding");
    const undo = undoTask!() as Promise<unknown>;
    const result = resultTask!() as Promise<unknown>;
    await sleep(200);
    g.release();
    await within(Promise.all([running, undo, result]), 20_000, "every refresh finished");
    expect(await goalsOf(two.divisionId, two.bea)).toBe(1);
    expect(await goalsOf(two.divisionId, two.ada)).toBeNull();
  }, 90_000);

  // The test above drives the real scoring tasks, whose target lookups race, so
  // it does not pin which request queues first. These two do.
  it.each(["the undo", "the result"] as const)(
    "%s queued first: the other joins it, and the entry folds because one trigger was not an undo",
    async (queuedFirst) => {
      const one = await scene();
      const two = await scene();
      const first = match(one, one.fixture("Reds", "Blues").id);
      await first.start();
      await first.goal(one.ada, one.reds);
      await first.half();
      await first.fullTime();
      const [taskOne] = probe.tasks.splice(0);

      const settled = match(two, two.fixture("Reds", "Blues").id);
      await settled.start();
      await settled.half();
      await settled.fullTime();
      await runAfterResponse();
      const liveId = two.fixture("Reds", "Greens").id;
      const live = match(two, liveId);
      await live.start();
      await live.goal(two.bea, two.reds);
      await live.goal(two.ada, two.reds);
      await live.undoLast();
      await live.half();
      await live.fullTime();
      probe.tasks.length = 0;
      const [target] = await sql<{ seq: number }[]>`
        select t.seq from score_events v join score_events t on t.id = v.voids_event_id
        where v.fixture_id = ${liveId} and v.type = 'core.void'`;
      const voided = { fixtureId: liveId, seq: Number(target!.seq) };

      const g = gate();
      probe.holdAfterLedgerRead = g.hold;
      const running = taskOne!() as Promise<unknown>;
      await within(g.wasEntered, 10_000, "division one is folding");
      const undo = () => refreshDivisionPlayerStats(two.auth.orgId, two.divisionId, { voided });
      const result = () => refreshDivisionPlayerStats(two.auth.orgId, two.divisionId);
      const outcomes = queuedFirst === "the undo" ? [undo(), result()] : [result(), undo()];
      g.release();
      await within(Promise.all([running, ...outcomes]), 20_000, "every refresh finished");
      expect(await Promise.all(outcomes)).toEqual(["folded", "folded"]);
      expect(await goalsOf(two.divisionId, two.bea)).toBe(1);
      expect(await goalsOf(two.divisionId, two.ada)).toBeNull();
    },
    90_000,
  );
});

describe.skipIf(!HAS_DB)("finishes in one division coalesce across processes, and none is lost", () => {
  it("a finish that lands while another process holds the lock, before its ledger read, costs no fold of its own", async () => {
    const s = await scene();
    const holder = holdStatsLockElsewhere(s.auth.orgId, s.divisionId, (tx) => recomputePlayerStats(tx, s.divisionId));
    await within(holder.wasEntered, 10_000, "the other process took the lock");
    const pid = await holderPid(s.divisionId);

    const m = match(s, s.fixture("Reds", "Blues").id);
    await m.start();
    await m.goal(s.ada, s.reds);
    await m.half();
    await m.fullTime();
    const [lateTask] = probe.tasks.splice(0);
    probe.tryLocks = 0;
    const late = lateTask!() as Promise<unknown>;

    // The late task retries rather than queueing INSIDE Postgres: a waiting
    // transaction would pin a pooled connection for the whole fold.
    await retriedTwice(late);
    expect(await waitersBlockedBy(pid)).toBe(0);
    expect(probe.folds).toBe(0);

    holder.release();
    await within(Promise.all([holder.done, late]), 20_000, "both finished");
    // The holder read the ledger after the late goal committed, so the late
    // task found the snapshot current and folded nothing.
    expect(probe.folds).toBe(1);
    expect(await goalsOf(s.divisionId, s.ada)).toBe(1);
  }, 60_000);

  it("a finish that lands after another process's ledger read is still counted: the refresh folds again", async () => {
    const s = await scene();
    const g = gate();
    probe.holdAfterLedgerRead = g.hold;
    const holder = withTenant(s.auth.orgId, (tx) => recomputePlayerStats(tx, s.divisionId));
    await within(g.wasEntered, 10_000, "the holder read the ledger");

    const m = match(s, s.fixture("Reds", "Blues").id);
    await m.start();
    await m.goal(s.ada, s.reds);
    await m.half();
    await m.fullTime();
    const [lateTask] = probe.tasks.splice(0);
    probe.tryLocks = 0;
    const late = lateTask!() as Promise<unknown>;
    await retriedTwice(late);

    g.release();
    await within(Promise.all([holder, late]), 20_000, "both finished");
    // The holder's rows missed Ada's goal; the late task saw the ledger had
    // moved past the snapshot and folded again.
    expect(probe.folds).toBe(2);
    expect(await goalsOf(s.divisionId, s.ada)).toBe(1);
    expect((await hub(s)).goals).toEqual([`${s.ada}=1`]);
  }, 60_000);

  it("a fold run by a stats READ holds the same lock: the refresh backs off, then counts that fold", async () => {
    const s = await scene();
    const m = match(s, s.fixture("Reds", "Blues").id);
    await m.start();
    await m.goal(s.ada, s.reds);
    await m.half();
    await m.fullTime();
    const [refreshTask] = probe.tasks.splice(0);

    // A console stats read refolds on its own, outside this module.
    const g = gate();
    probe.holdAfterLedgerRead = g.hold;
    const read = withTenant(s.auth.orgId, (tx) => recomputePlayerStats(tx, s.divisionId));
    await within(g.wasEntered, 10_000, "the read's fold read the ledger");
    probe.folds = 0;
    probe.tryLocks = 0;
    probe.divisionPushes.length = 0;
    const refresh = refreshTask!() as Promise<unknown>;
    await retriedTwice(refresh);

    g.release();
    await within(Promise.all([read, refresh]), 20_000, "read and refresh finished");
    // The read's fold saw the full-time write, so the refresh had nothing to
    // fold, and still cleared the caches: the read cleared none.
    expect(probe.folds).toBe(0);
    expect(await goalsOf(s.divisionId, s.ada)).toBe(1);
    expect(probe.divisionPushes).toEqual([`${s.divisionId}:score`]);
  }, 60_000);

  it("two results finishing together both reach the leaders", async () => {
    const s = await scene();
    const a = match(s, s.fixture("Reds", "Blues").id);
    const b = match(s, s.fixture("Reds", "Greens").id);
    await a.start();
    await b.start();
    await a.goal(s.ada, s.reds);
    await b.goal(s.bea, s.reds);
    await a.half();
    await b.half();
    await Promise.all([a.fullTime(), b.fullTime()]);
    expect(probe.tasks).toHaveLength(2);

    await runAfterResponse();
    expect(await goalsOf(s.divisionId, s.ada)).toBe(1);
    expect(await goalsOf(s.divisionId, s.bea)).toBe(1);
    expect(probe.folds).toBeLessThanOrEqual(2);
  }, 60_000);
});

describe.skipIf(!HAS_DB)("a refresh statement that never returns cannot hold the queue for good (review n7)", () => {
  it("every statement of a refresh transaction runs under a statement timeout, and the queue moves on", async () => {
    const s = await scene();
    const m = match(s, s.fixture("Reds", "Blues").id);
    await m.start();
    await m.goal(s.ada, s.reds);
    await m.half();
    await m.fullTime();
    probe.tasks.length = 0;

    probe.slowFoldSeconds = 3;
    const stuck = await within(
      refreshDivisionPlayerStats(s.auth.orgId, s.divisionId, {
        timing: { backoffMs: [], lockTimeoutMs: 1_000, statementTimeoutMs: 300 },
      }),
      2_500,
      "the refresh gave up on the slow statement",
    );
    expect(stuck).toBe("failed");
    const failure = logMock.warn.mock.calls.find((call) => call[1] === REFRESH_FAILED)?.[0] as
      | { err?: { code?: string } }
      | undefined;
    expect(failure?.err?.code, "canceling statement due to statement timeout").toBe("57014");

    probe.slowFoldSeconds = 0;
    expect(await within(refreshDivisionPlayerStats(s.auth.orgId, s.divisionId), 10_000, "the next refresh ran")).toBe("folded");
    expect(await goalsOf(s.divisionId, s.ada)).toBe(1);
  }, 60_000);
});

describe.skipIf(!HAS_DB)("a lock that never frees still reaches the public (review m2)", () => {
  it("after the backoff and one blocking try, the refresh clears the caches anyway and warns", async () => {
    const s = await scene();
    const m = match(s, s.fixture("Reds", "Blues").id);
    await m.start();
    await m.goal(s.ada, s.reds);
    await m.half();
    await m.fullTime();
    probe.tasks.length = 0;
    const holder = holdStatsLockElsewhere(s.auth.orgId, s.divisionId);
    await within(holder.wasEntered, 10_000, "the other process took the lock");
    probe.divisionPushes.length = 0;
    probe.order.length = 0;

    const outcome = await within(
      refreshDivisionPlayerStats(s.auth.orgId, s.divisionId, { timing: { backoffMs: [20, 20], lockTimeoutMs: 300, statementTimeoutMs: 30_000 } }),
      15_000,
      "the refresh gave up",
    );
    expect(outcome).toBe("busy");
    expect(probe.folds).toBe(0);
    expect(logMock.warn).toHaveBeenCalledWith(expect.objectContaining({ divisionId: s.divisionId }), GAVE_UP);
    expect(probe.order).toEqual(["tags", "del:hub", "push:score"]);
    holder.release();
    await holder.done;
  }, 60_000);

  it("two requests that give up together clear the caches once", async () => {
    const s = await scene();
    const m = match(s, s.fixture("Reds", "Blues").id);
    await m.start();
    await m.goal(s.ada, s.reds);
    await m.half();
    await m.fullTime();
    probe.tasks.length = 0;
    const holder = holdStatsLockElsewhere(s.auth.orgId, s.divisionId);
    await within(holder.wasEntered, 10_000, "the other process took the lock");
    probe.divisionPushes.length = 0;
    probe.order.length = 0;

    // A give-up carries no fold record, so only the shared result's `cleared`
    // flag stops the second caller clearing again.
    const timing = { backoffMs: [20, 20], lockTimeoutMs: 300, statementTimeoutMs: 30_000 };
    const both = Promise.all([
      refreshDivisionPlayerStats(s.auth.orgId, s.divisionId, { timing }),
      refreshDivisionPlayerStats(s.auth.orgId, s.divisionId, { timing }),
    ]);
    expect(await within(both, 15_000, "both gave up")).toEqual(["busy", "busy"]);
    expect(probe.order).toEqual(["tags", "del:hub", "push:score"]);
    holder.release();
    await holder.done;
  }, 60_000);

  it("the blocking try folds when the holder lets go inside its lock timeout", async () => {
    const s = await scene();
    const m = match(s, s.fixture("Reds", "Blues").id);
    await m.start();
    await m.goal(s.ada, s.reds);
    await m.half();
    await m.fullTime();
    probe.tasks.length = 0;
    const holder = holdStatsLockElsewhere(s.auth.orgId, s.divisionId);
    await within(holder.wasEntered, 10_000, "the other process took the lock");
    const pid = await holderPid(s.divisionId);

    const refresh = refreshDivisionPlayerStats(s.auth.orgId, s.divisionId, {
      timing: { backoffMs: [], lockTimeoutMs: 20_000, statementTimeoutMs: 30_000 },
    });
    await until(async () => (await waitersBlockedBy(pid)) > 0, "the refresh waits on the lock");
    holder.release();
    await holder.done;
    expect(await within(refresh, 20_000, "the refresh finished")).toBe("folded");
    expect(await goalsOf(s.divisionId, s.ada)).toBe(1);
    expect(logMock.warn).not.toHaveBeenCalledWith(expect.anything(), GAVE_UP);
  }, 60_000);
});

describe.skipIf(!HAS_DB)("a person merge and a result refresh never deadlock (review I1/I2)", () => {
  // A fold holds its division's stats lock and inserts snapshot rows, whose
  // foreign key takes FOR KEY SHARE on each `persons` row. A merge that locked
  // the pair FOR UPDATE and only then waited on the stats lock deadlocked
  // against a fold that got the division first (40P01).
  async function twinScene() {
    const s = await scene(["Ada Striker"]);
    const [twin] = await sql<{ id: string }[]>`
      select p.id from persons p join entrant_members em on em.person_id = p.id
      where em.entrant_id = ${s.reds} and p.full_name = 'Ada Striker' and p.id <> ${s.ada}`;
    const first = match(s, s.fixture("Reds", "Blues").id);
    await first.start();
    await first.goal(s.ada, s.reds);
    await first.half();
    await first.fullTime();
    await runAfterResponse();
    expect(await goalsOf(s.divisionId, s.ada)).toBe(1);
    return { s, twin: twin!.id };
  }

  function refreshFailures(): string[] {
    return logMock.warn.mock.calls
      .filter((call) => call[1] === REFRESH_FAILED)
      .map((call) => (call[0] as { err?: { code?: string; message?: string } }).err)
      .map((err) => `${err?.code}: ${err?.message}`);
  }

  describe.each(["merge", "reverse"] as const)("a %s clears the public copies of the rows it refolded (review round 2, gap hunt)", (which) => {
    it("queues the refolded division's refresh, which finds the rows current and clears the caches", async () => {
      const { s, twin } = await twinScene();
      let mergeId: string | null = null;
      if (which === "reverse") {
        mergeId = (await mergePersons(s.auth, twin, s.ada, { confirmedBy: s.auth.userId! })).merge_id;
        await runAfterResponse();
      }
      probe.tasks.length = 0;
      if (which === "merge") await mergePersons(s.auth, twin, s.ada, { confirmedBy: s.auth.userId! });
      else await reverseMerge(s.auth, mergeId!, { confirmedBy: s.auth.userId! });
      expect(await goalsOf(s.divisionId, which === "merge" ? twin : s.ada), "refolded in the staff write").toBe(1);

      expect(probe.tasks, "one refresh for the one refolded division").toHaveLength(1);
      probe.folds = 0;
      probe.order.length = 0;
      await runAfterResponse();
      expect(probe.folds, "the staff write's own fold already covered it").toBe(0);
      expect(probe.order).toEqual(["tags", "del:hub", "push:score"]);
    }, 90_000);
  });

  describe.each(["merge", "reverse"] as const)("%s", (which) => {
    async function prepared() {
      const { s, twin } = await twinScene();
      let mergeId: string | null = null;
      if (which === "reverse") {
        const merged = await mergePersons(s.auth, twin, s.ada, { confirmedBy: s.auth.userId! });
        mergeId = merged.merge_id;
        expect(await goalsOf(s.divisionId, twin)).toBe(1);
      }
      // The second result is on the board but not yet refreshed: the twin scores.
      const second = match(s, s.fixture("Reds", "Greens").id);
      await second.start();
      await second.goal(twin, s.reds);
      await second.half();
      await second.fullTime();
      const [refreshTask] = probe.tasks.splice(0);
      const staffWrite = () =>
        which === "merge"
          ? mergePersons(s.auth, twin, s.ada, { confirmedBy: s.auth.userId! })
          : reverseMerge(s.auth, mergeId!, { confirmedBy: s.auth.userId! });
      return { s, twin, refreshTask: refreshTask!, staffWrite };
    }

    async function expectBothLanded(s: Scene, twin: string) {
      if (which === "merge") {
        // Both goals now belong to the survivor.
        expect(await goalsOf(s.divisionId, twin)).toBe(2);
        expect(await goalsOf(s.divisionId, s.ada)).toBeNull();
      } else {
        expect(await goalsOf(s.divisionId, s.ada)).toBe(1);
        expect(await goalsOf(s.divisionId, twin)).toBe(1);
      }
    }

    it("the refresh gets the division first and is mid-fold when the staff write arrives", async () => {
      const { s, twin, refreshTask, staffWrite } = await prepared();
      const g = gate();
      probe.holdAfterLedgerRead = g.hold;
      const refresh = refreshTask() as Promise<unknown>;
      await within(g.wasEntered, 10_000, "the refresh read its ledger");
      const pid = await holderPid(s.divisionId);

      const staffOutcome = staffWrite().then(
        () => "ok" as const,
        (err: unknown) => err,
      );
      await until(async () => (await waitersBlockedBy(pid)) > 0, "the staff write waits on the refresh");

      g.release();
      await within(Promise.all([staffOutcome, refresh]), 30_000, "staff write and refresh finished");
      expect(await staffOutcome).toBe("ok");
      expect(refreshFailures()).toEqual([]);
      await expectBothLanded(s, twin);
    }, 90_000);

    it("the staff write gets the division first and is mid-fold when the refresh arrives", async () => {
      const { s, twin, refreshTask, staffWrite } = await prepared();
      const g = gate();
      probe.holdNextFold = g.hold;
      const staffOutcome = staffWrite().then(
        () => "ok" as const,
        (err: unknown) => err,
      );
      await within(g.wasEntered, 10_000, "the staff write reached its fold");

      probe.tryLocks = 0;
      const refresh = refreshTask() as Promise<unknown>;
      await retriedTwice(refresh);

      g.release();
      await within(Promise.all([staffOutcome, refresh]), 30_000, "staff write and refresh finished");
      expect(await staffOutcome).toBe("ok");
      expect(refreshFailures()).toEqual([]);
      await expectBothLanded(s, twin);
    }, 90_000);
  });

  /** A second division in the scene's competition, with a team the twin can be
   *  added to, and a result credited to the twin there. */
  async function secondDivision(s: Scene, twin: string) {
    const division = await createDivision(s.auth, s.competitionId, {
      name: "Second " + randomUUID().slice(0, 6),
      sport_key: "football",
      variant_key: "default",
      config: {},
    });
    const [team] = await createEntrants(s.auth, division.id, [{ kind: "team", display_name: "Late Reds", seed: 1, members: [] }]);
    return { divisionId: division.id, entrantId: team!.id, twin };
  }

  it("a roster add landing between the merge's division read and its row locks restarts the merge, which then refolds that division too", async () => {
    const { s, twin } = await twinScene();
    const extra = await secondDivision(s, twin);
    let added = false;
    probe.beforeStatsLocks = async () => {
      if (added) return;
      added = true;
      await sql`
        insert into entrant_members (entrant_id, person_id, squad_number, is_captain, roles)
        values (${extra.entrantId}, ${twin}, 9, false, ${sql.json([])})`;
    };
    probe.folds = 0;
    await mergePersons(s.auth, twin, s.ada, { confirmedBy: s.auth.userId! });
    expect(logMock.info).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1 }), MERGE_RESTARTED);
    const [record] = await sql<{ n: number }[]>`
      select count(*)::int as n from player_stat_folds where division_id = ${extra.divisionId}`;
    expect(record!.n, "the late division was refolded under its lock").toBe(1);
  }, 90_000);

  it("an unmerge that puts back a membership removed after the merge locks that division up front and succeeds", async () => {
    const { s, twin } = await twinScene();
    const extra = await secondDivision(s, twin);
    await sql`
      insert into entrant_members (entrant_id, person_id, squad_number, is_captain, roles)
      values (${extra.entrantId}, ${s.ada}, 7, false, ${sql.json([])})`;
    const { merge_id } = await mergePersons(s.auth, twin, s.ada, { confirmedBy: s.auth.userId! });
    // After the merge the organiser takes the survivor off that team.
    await sql`delete from entrant_members where entrant_id = ${extra.entrantId} and person_id = ${twin}`;

    await reverseMerge(s.auth, merge_id, { confirmedBy: s.auth.userId! });
    expect(logMock.info).not.toHaveBeenCalledWith(expect.anything(), MERGE_RESTARTED);
    const [back] = await sql<{ n: number }[]>`
      select count(*)::int as n from entrant_members where entrant_id = ${extra.entrantId} and person_id = ${s.ada}`;
    expect(back!.n).toBe(1);
  }, 90_000);

  it("a roster that keeps changing under the merge gives up with a 409 after three tries", async () => {
    const { s, twin } = await twinScene();
    const extras = [
      await secondDivision(s, twin),
      await secondDivision(s, twin),
      await secondDivision(s, twin),
    ];
    let next = 0;
    probe.beforeStatsLocks = async () => {
      const extra = extras[next++];
      if (!extra) return;
      await sql`
        insert into entrant_members (entrant_id, person_id, squad_number, is_captain, roles)
        values (${extra.entrantId}, ${twin}, 9, false, ${sql.json([])})`;
    };
    const err = await mergePersons(s.auth, twin, s.ada, { confirmedBy: s.auth.userId! }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: "MERGE_ROSTER_CHANGED" });
    expect(next).toBe(3);
    const [tomb] = await sql<{ merged_into: string | null }[]>`select merged_into from persons where id = ${s.ada}`;
    expect(tomb!.merged_into).toBeNull();
  }, 90_000);
});
