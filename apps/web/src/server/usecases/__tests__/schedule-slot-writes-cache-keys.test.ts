// R10e — every write that moves a fixture's slot reaches the live hub and the
// match centre without a reload (review-r10d m1).
//
// `schedule-fixture-cache-keys.test.ts` pins the five writers that already
// called `afterScheduleWrite` (apply, move, publish, start, joint apply). These
// cases pin the writers that did not: a rain-delay SHIFT, UNDO / REDO, RESTORE
// to a save point, CLEAR, and stage GENERATE / REBUILD, plus the writers found
// beside them: CLEAR-ENTRANTS, an ad-hoc fixture, a ladder challenge and a
// stage delete. R10f adds the organiser's manual stage COMPLETION that draws
// the next stage, driven through its route (`POST /stages/{id}/complete`),
// beside scoring's auto-advance, which must not publish that draw a second
// time. R10g adds the organiser's seed-proposal CONFIRM, which names entrants
// into a templated bracket's placeholders (`POST /stages/{id}/seed-proposal/
// confirm`); its "changed" fixtures are the ones whose entrants it filled.
// R10g also makes every stage COMPLETION that commits publish the hub key
// (stage and division status show on the hub), drawn or not. R10h adds the
// last writer of this class that a spectator can watch: a SCORE that advances
// a winner (or, in a double elimination, a loser) into the next fixture, where
// the fixture whose slot was filled is a different fixture from the one that
// was scored, with its own open match centre.
// Each is driven through
// its real use-case against Postgres, and each must:
//   - send ONE DEL of the hub key plus the keys of exactly the fixtures its own
//     write changed (derived here from a before/after read of the fixtures
//     table, never from a list typed into the test);
//   - send that DEL only after its transaction has committed (the `withTenant`
//     recorder below marks the async context of every transaction callback, so
//     a DEL sent from inside one is caught even while an unrelated, unawaited
//     lookup such as `fireStageRevalidate` holds a transaction of its own);
//   - send the division push once and the fixture pushes only after the DEL;
//   - send nothing at all when the write changed nothing.
//
// `@/lib/cache` and `@/lib/realtime` are recording passthroughs (the R10d
// probe): every public literal-key DEL is recorded and, when `probe.hold` is
// set, held open until the test releases it. `@/lib/db` is a passthrough whose
// `withTenant` runs each callback inside an AsyncLocalStorage mark. Real
// Postgres required; skipped without DATABASE_URL.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  hold: false,
  inTx: new (process.getBuiltinModule("node:async_hooks").AsyncLocalStorage)<true>(),
  dels: [] as string[][],
  inTxAtDel: [] as boolean[],
  gates: [] as Array<() => void>,
  fixturePushes: [] as Array<[string, string]>,
  divisionPushes: [] as Array<[string, string]>,
  /** R10f: when set, the Nth statement that takes a division's advisory lock
   *  (counted in `locks`) throws `injected`, so that transaction rolls back
   *  while the ones before it stay committed. */
  failAtLock: null as number | null,
  locks: 0,
  injected: new Error("injected: a later transaction of this write failed"),
  /** M2 r1: when set, `fireScoreRevalidate` throws it. That is one of the two
   *  points at which `invalidatePublicCache` itself can reject (the other is
   *  its `withTenant` lookup), and it is reached BEFORE any `cacheDel` — so
   *  arming it drives `scoreEvent`'s `.catch` fallback with no DEL having
   *  gone out, which is exactly the state that fallback reasons about. */
  failRevalidate: null as Error | null,
}));

vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  return {
    ...actual,
    cacheDel: (...keys: string[]) => {
      if (keys.length === 0 || !keys.every((key) => key.startsWith("pub:v1:"))) return actual.cacheDel(...keys);
      probe.dels.push(keys);
      probe.inTxAtDel.push(probe.inTx.getStore() === true);
      return probe.hold ? new Promise<void>((resolve) => probe.gates.push(resolve)) : Promise.resolve();
    },
  };
});
vi.mock("@/lib/realtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/realtime")>();
  return {
    ...actual,
    publishFixtureUpdate: async (fixtureId: string, reason: Parameters<typeof actual.publishFixtureUpdate>[1]) => {
      probe.fixturePushes.push([fixtureId, reason]);
    },
    publishDivisionUpdate: async (divisionId: string, reason: Parameters<typeof actual.publishDivisionUpdate>[1]) => {
      probe.divisionPushes.push([divisionId, reason]);
    },
  };
});
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    // Code running inside a transaction callback (before its COMMIT) sees the
    // mark; the caller's continuation after `await withTenant(...)` does not.
    withTenant: (orgId: string, fn: Parameters<typeof actual.withTenant>[1]) =>
      actual.withTenant(orgId, (tx) => {
        // R10f: armed only by the part-way failure cases. The Nth statement
        // that takes a division's advisory lock throws, and the transaction
        // that sent it rolls back. Every other call, and every other case,
        // gets the real `tx`.
        const handed = probe.failAtLock === null ? tx : new Proxy(tx, {
          apply(target, thisArg, args: unknown[]) {
            const strings = args[0];
            if (Array.isArray(strings) && "raw" in strings && strings.join("").includes("pg_advisory_xact_lock")) {
              probe.locks += 1;
              if (probe.locks === probe.failAtLock) throw probe.injected;
            }
            return Reflect.apply(target, thisArg, args);
          },
        });
        return probe.inTx.run(true, () => fn(handed));
      }),
  };
});
// R10f: the manual stage completion is driven through its real route handler
// over a real session (`requireResourceAuth` unmocked), the pattern of
// `divisions/[id]/fixtures/__tests__/route.test.ts`.
const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
// M2 r1 — a passthrough that diverges only when `probe.failRevalidate` is
// armed, which exactly one case does and `quiesce()` disarms. Every other case
// in this file, and every other write inside the armed one, gets the real
// `fireScoreRevalidate`.
vi.mock("@/server/public-site/revalidate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/public-site/revalidate")>();
  return {
    ...actual,
    fireScoreRevalidate: (divisionId: string, competitionId: string) => {
      if (probe.failRevalidate) throw probe.failRevalidate;
      return actual.fireScoreRevalidate(divisionId, competitionId);
    },
  };
});
// A deciding score also schedules a player-stats refresh, which deletes the hub
// key a SECOND time once its fold has committed (owner ruling 2026-09-16). In a
// route handler that runs after the response. Here, with no request scope,
// `lib/deferred.ts` runs it at once and its DEL would land among the write's
// own. This file pins the write's own invalidation, so the refresh is left out;
// `player-stats-refresh.test.ts` pins its DEL and push.
vi.mock("../player-stats-refresh", () => ({ schedulePlayerStatsRefresh: () => {} }));

import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { POST as completeStageRoute } from "@/app/api/v1/stages/[id]/complete/route";
import { POST as confirmSeedProposalRoute } from "@/app/api/v1/stages/[id]/seed-proposal/confirm/route";
import { sql } from "@/lib/db";
import { shiftDivisionSchedule } from "../schedule-plus";
import {
  clearPoolEntrants,
  clearScheduleScoped,
  createCheckpoint,
  redoDivision,
  restoreCheckpoint,
  setDivisionLocks,
  undoDivision,
} from "../history";
import { moveFixture, startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import {
  addFixture,
  completeStage,
  createStages,
  deleteStage,
  generateStageFixtures,
  issueChallenge,
  rebuildStageFixtures,
} from "../stages";
import { divisionRig, seedOrg } from "./_rig";
import { GENERIC_CONFIG, seedOrg as seedOrgOnPlan } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hubKey = (competitionId: string) => `pub:v1:hub:${competitionId}`;
const fixtureKey = (fixtureId: string) => `pub:v1:fixture:${fixtureId}`;

/** Let a PREVIOUS write's DEL settle and its pushes land, then clear the
 *  recorders. */
async function quiesce(): Promise<void> {
  probe.hold = false;
  probe.failAtLock = null;
  probe.failRevalidate = null;
  probe.locks = 0;
  for (const release of probe.gates.splice(0)) release();
  await sleep(20);
  probe.dels.length = 0;
  probe.inTxAtDel.length = 0;
  probe.fixturePushes.length = 0;
  probe.divisionPushes.length = 0;
}

/** Settle the held DEL; control returns after a macrotask, so the pushes
 *  chained on it have already run. */
async function releaseDel(): Promise<void> {
  for (const release of probe.gates.splice(0)) release();
  await sleep(20);
}

async function competitionOf(divisionId: string): Promise<string> {
  const [row] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`;
  return row!.competition_id;
}

type Board = Map<string, string>;

/** Every fixture of the division, as `id -> slot` (kick-off and court). */
async function board(divisionId: string): Promise<Board> {
  const rows = await sql<{ id: string; at: string | null; court_id: string | null }[]>`
    select id, scheduled_at::text as at, court_id from fixtures where division_id = ${divisionId}`;
  return new Map(rows.map((row) => [row.id, `${row.at ?? "-"}|${row.court_id ?? "-"}`]));
}

/** What a write did to the board: fixtures whose slot changed, fixtures it
 *  deleted, fixtures it created. */
function diff(before: Board, after: Board): { moved: string[]; deleted: string[]; created: string[] } {
  const moved = [...after].filter(([id, slot]) => before.has(id) && before.get(id) !== slot).map(([id]) => id);
  const deleted = [...before.keys()].filter((id) => !after.has(id));
  const created = [...after.keys()].filter((id) => !before.has(id));
  return { moved: moved.sort(), deleted: deleted.sort(), created: created.sort() };
}

/** The one DEL, split into its first key and the rest (sorted), plus whether
 *  it was sent from inside a transaction callback. */
function theOneDel(): { first: string; rest: string[]; inTx: boolean } {
  expect(probe.dels, "one DEL for every literal key").toHaveLength(1);
  const [first, ...rest] = probe.dels[0]!;
  return { first: first!, rest: [...rest].sort(), inTx: probe.inTxAtDel[0]! };
}

/** The shape every slot-moving write owes: one DEL (hub key + `ids`) sent
 *  after commit, nothing pushed until it settles, then the division push once
 *  and one push per id. */
async function expectDelThenPushes(
  divisionId: string,
  competitionId: string,
  ids: readonly string[],
  opts: { fixturePushes?: readonly string[] } = {},
): Promise<void> {
  const del = theOneDel();
  expect(del.first).toBe(hubKey(competitionId));
  expect(del.rest).toEqual([...ids].sort().map(fixtureKey));
  expect(del.inTx, "the DEL went out after the write committed, not from inside its transaction").toBe(false);
  await sleep(20);
  expect(probe.fixturePushes, "fixture push before the DEL settled").toEqual([]);
  expect(probe.divisionPushes, "division push before the DEL settled").toEqual([]);

  await releaseDel();
  expect(probe.fixturePushes.map(([id]) => id).sort()).toEqual([...(opts.fixturePushes ?? ids)].sort());
  expect(new Set(probe.fixturePushes.map(([, reason]) => reason))).toEqual(
    new Set((opts.fixturePushes ?? ids).length > 0 ? ["schedule"] : []),
  );
  expect(probe.divisionPushes).toEqual([[divisionId, "schedule"]]);
}

/** A write that changed nothing sent nothing, not even later. */
async function expectNothingSent(): Promise<void> {
  await sleep(40);
  expect(probe.dels, "no DEL").toEqual([]);
  expect(probe.fixturePushes, "no fixture push").toEqual([]);
  expect(probe.divisionPushes, "no division push").toEqual([]);
}

/** A started three-entrant league whose fixtures all have a kick-off, one of
 *  them pinned (`schedule_locked`), so a shift moves some fixtures and not
 *  others. Times are written directly: this is setup, not a write under test. */
async function timedRig() {
  const { auth } = await seedOrg();
  const rig = await divisionRig(auth, { entrants: 3 });
  const competitionId = await competitionOf(rig.divisionId);
  const [pinned] = rig.fixtureIds;
  let hour = 9;
  for (const id of rig.fixtureIds) {
    await sql`update fixtures set scheduled_at = ${`2030-06-01T${String(hour++).padStart(2, "0")}:00:00.000Z`}
              where id = ${id}`;
  }
  await sql`update fixtures set schedule_locked = true where id = ${pinned!}`;
  await quiesce();
  return { auth, rig, competitionId, pinned: pinned! };
}

/** A six-entrant group stage in two pools, so a pool's fixtures can be
 *  removed while the other pool's stay. */
async function groupRig() {
  const { auth } = await seedOrg();
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31", name: "Rain Cup", visibility: "public", branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  await createEntrants(auth, division.id, ["A", "B", "C", "D", "E", "F"].map((name, i) => ({
    kind: "individual" as const, display_name: name, seed: i + 1, members: [],
  })));
  const [stage] = await createStages(auth, division.id, {
    seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } },
  });
  await generateStageFixtures(auth, stage!.id);
  const pools = await sql<{ id: string }[]>`select id from pools where stage_id = ${stage!.id} order by key`;
  await quiesce();
  return { auth, divisionId: division.id, competitionId: competition.id, poolA: pools[0]!.id };
}

/** A three-entrant league division whose stage has NO fixtures yet. */
async function ungeneratedRig() {
  const { auth } = await seedOrg();
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31", name: "Draw Cup", visibility: "public", branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  await createEntrants(auth, division.id, ["A", "B", "C"].map((name, i) => ({
    kind: "individual" as const, display_name: name, seed: i + 1, members: [],
  })));
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L1", config: {} });
  await quiesce();
  return { auth, divisionId: division.id, competitionId: competition.id, stageId: stage!.id };
}

/** A four-entrant ladder stage: no fixtures until a challenge creates one. A
 *  Pro org: a challenge requires `formats.advanced`. */
async function ladderRig() {
  const { auth } = await seedOrgOnPlan("pro");
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31", name: "Ladder Cup", visibility: "public", branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  await createEntrants(auth, division.id, ["L1", "L2", "L3", "L4"].map((name, i) => ({
    kind: "individual" as const, display_name: name, seed: i + 1, members: [],
  })));
  const [stage] = await createStages(auth, division.id, {
    seq: 1, kind: "ladder" as never, name: "Club ladder", config: { challengeRange: 2 },
  });
  const entrants = await sql<{ id: string }[]>`
    select id from entrants where division_id = ${division.id} order by seed`;
  await quiesce();
  return { auth, divisionId: division.id, competitionId: competition.id, stageId: stage!.id, ladder: entrants.map((e) => e.id) };
}

afterEach(async () => {
  await quiesce();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("a slot-moving write drops the fixture documents it changed, then pushes them (R10e)", () => {
  it("shift: the fixtures the shift moved, and ONLY those, ride the hub key's one DEL after commit; pushes wait for it", async () => {
    const { auth, rig, competitionId, pinned } = await timedRig();
    const before = await board(rig.divisionId);

    probe.hold = true;
    const out = await shiftDivisionSchedule(auth, {
      division_id: rig.divisionId,
      scope: { excludeLocked: true },
      delta_minutes: 45,
    });
    const { moved, deleted, created } = diff(before, await board(rig.divisionId));
    expect(out.shifted, "the shift landed").toBe(moved.length);
    expect(moved.length, "the shift moved fixtures").toBeGreaterThan(0);
    expect(moved, "the pinned fixture stayed put").not.toContain(pinned);
    expect([deleted, created]).toEqual([[], []]);

    await expectDelThenPushes(rig.divisionId, competitionId, moved);
  }, 120_000);

  it("shift that moves nothing (a scope no fixture matches) sends nothing", async () => {
    const { auth, rig } = await timedRig();
    const before = await board(rig.divisionId);

    const out = await shiftDivisionSchedule(auth, {
      division_id: rig.divisionId,
      scope: { stageId: "no-such-stage", excludeLocked: true },
      delta_minutes: 45,
    });
    expect(diff(before, await board(rig.divisionId))).toEqual({ moved: [], deleted: [], created: [] });
    expect(out.shifted).toBe(0);
    await expectNothingSent();
  }, 120_000);
});

describe.skipIf(!HAS_DB)("undo, redo, restore and clear drop the fixture documents they changed, then push them (R10e)", () => {
  it("undo: the fixture the undone move had moved rides the hub key's one DEL after commit; pushes wait for it", async () => {
    const { auth } = await seedOrg();
    const rig = await divisionRig(auth, { entrants: 3 });
    const competitionId = await competitionOf(rig.divisionId);
    await moveFixture(auth, rig.fixtureIds[0]!, { scheduled_at: "2030-06-01T10:00:00.000Z" });
    await quiesce();
    const before = await board(rig.divisionId);

    probe.hold = true;
    await undoDivision(auth, rig.divisionId);
    const { moved, deleted, created } = diff(before, await board(rig.divisionId));
    expect(moved, "the undo put exactly the moved fixture back").toEqual([rig.fixtureIds[0]]);
    expect([deleted, created]).toEqual([[], []]);

    await expectDelThenPushes(rig.divisionId, competitionId, moved);
  }, 120_000);

  it("redo: the fixture the redone move moves again rides the hub key's one DEL after commit; pushes wait for it", async () => {
    const { auth } = await seedOrg();
    const rig = await divisionRig(auth, { entrants: 3 });
    const competitionId = await competitionOf(rig.divisionId);
    await moveFixture(auth, rig.fixtureIds[1]!, { scheduled_at: "2030-06-01T11:00:00.000Z" });
    await undoDivision(auth, rig.divisionId);
    await quiesce();
    const before = await board(rig.divisionId);

    probe.hold = true;
    await redoDivision(auth, rig.divisionId);
    const { moved, deleted, created } = diff(before, await board(rig.divisionId));
    expect(moved, "the redo moved exactly that fixture again").toEqual([rig.fixtureIds[1]]);
    expect([deleted, created]).toEqual([[], []]);

    await expectDelThenPushes(rig.divisionId, competitionId, moved);
  }, 120_000);

  it("undo with nothing to undo, and redo with nothing to redo, change nothing and send nothing", async () => {
    const { auth } = await seedOrg();
    const rig = await divisionRig(auth, { entrants: 3 });
    await quiesce();
    const before = await board(rig.divisionId);
    await expect(redoDivision(auth, rig.divisionId), "nothing was undone, so nothing redoes").rejects.toThrow();

    const competition = await createCompetition(auth, {
      ends_on: "2030-12-31", name: "Empty Cup", visibility: "public", branding: {},
    });
    const empty = await createDivision(auth, competition.id, {
      name: "Open", sport_key: "generic", variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    await quiesce();
    await expect(undoDivision(auth, empty.id), "a division with no history has nothing to undo").rejects.toThrow();

    expect(diff(before, await board(rig.divisionId))).toEqual({ moved: [], deleted: [], created: [] });
    await expectNothingSent();
  }, 120_000);

  it("restore: every fixture the rewind moved, across ALL its undo steps, rides ONE DEL after commit", async () => {
    const { auth } = await seedOrg();
    const rig = await divisionRig(auth, { entrants: 3 });
    const competitionId = await competitionOf(rig.divisionId);
    const checkpoint = await createCheckpoint(auth, rig.divisionId, "before the rain");
    await moveFixture(auth, rig.fixtureIds[0]!, { scheduled_at: "2030-06-01T10:00:00.000Z" });
    await moveFixture(auth, rig.fixtureIds[1]!, { scheduled_at: "2030-06-01T11:00:00.000Z" });
    await quiesce();
    const before = await board(rig.divisionId);

    probe.hold = true;
    const out = await restoreCheckpoint(auth, rig.divisionId, checkpoint.id, true);
    const { moved, deleted, created } = diff(before, await board(rig.divisionId));
    expect(out.steps, "the restore took more than one undo step").toBeGreaterThan(1);
    expect(moved.length, "the restore moved fixtures back").toBe(2);
    expect([deleted, created]).toEqual([[], []]);

    await expectDelThenPushes(rig.divisionId, competitionId, moved);
  }, 120_000);

  it("restore to a save point the board is already at takes no step and sends nothing", async () => {
    const { auth } = await seedOrg();
    const rig = await divisionRig(auth, { entrants: 3 });
    await moveFixture(auth, rig.fixtureIds[0]!, { scheduled_at: "2030-06-01T10:00:00.000Z" });
    const checkpoint = await createCheckpoint(auth, rig.divisionId, "right here");
    await quiesce();
    const before = await board(rig.divisionId);

    const out = await restoreCheckpoint(auth, rig.divisionId, checkpoint.id, true);
    expect(out.steps).toBe(0);
    expect(diff(before, await board(rig.divisionId))).toEqual({ moved: [], deleted: [], created: [] });
    await expectNothingSent();
  }, 120_000);

  it("clear: the fixtures the clear emptied, and ONLY those, ride the hub key's one DEL after commit", async () => {
    const { auth, rig, competitionId, pinned } = await timedRig();
    const before = await board(rig.divisionId);

    probe.hold = true;
    const out = await clearScheduleScoped(auth, {
      division_id: rig.divisionId,
      scope: { excludeLocked: true },
      confirm: true,
    });
    const { moved, deleted, created } = diff(before, await board(rig.divisionId));
    expect(out.cleared, "the clear landed").toBe(moved.length);
    expect(moved.length).toBeGreaterThan(0);
    expect(moved, "the pinned fixture kept its slot").not.toContain(pinned);
    expect([deleted, created]).toEqual([[], []]);

    await expectDelThenPushes(rig.divisionId, competitionId, moved);
  }, 120_000);

  it("clear of a board with nothing left to clear sends nothing", async () => {
    const { auth, rig } = await timedRig();
    const input = { division_id: rig.divisionId, scope: { excludeLocked: true }, confirm: true as const };
    await clearScheduleScoped(auth, input);
    await quiesce();
    const before = await board(rig.divisionId);

    const out = await clearScheduleScoped(auth, input);
    expect(out.cleared).toBe(0);
    expect(diff(before, await board(rig.divisionId))).toEqual({ moved: [], deleted: [], created: [] });
    await expectNothingSent();
  }, 120_000);

  it("clear-entrants (found, R10e): the pool fixtures it deleted ride the hub key's one DEL after commit", async () => {
    const { auth, divisionId, competitionId, poolA } = await groupRig();
    const before = await board(divisionId);

    probe.hold = true;
    const out = await clearPoolEntrants(auth, poolA, true);
    const { moved, deleted, created } = diff(before, await board(divisionId));
    expect(out.removed, "the clear-entrants landed").toBe(deleted.length);
    expect(deleted.length).toBeGreaterThan(0);
    expect(deleted.length, "the other pool kept its fixtures").toBeLessThan(before.size);
    expect([moved, created]).toEqual([[], []]);

    await expectDelThenPushes(divisionId, competitionId, deleted);
  }, 120_000);
});

describe.skipIf(!HAS_DB)("stage generate and rebuild drop what they replaced, then push the division (R10e)", () => {
  it("generate: the hub key alone in one DEL after commit (no fixture was deleted), the division push, no fixture push", async () => {
    const { auth, divisionId, competitionId, stageId } = await ungeneratedRig();
    const before = await board(divisionId);

    probe.hold = true;
    const out = await generateStageFixtures(auth, stageId);
    const { moved, deleted, created } = diff(before, await board(divisionId));
    expect(out.created, "the generate landed").toBe(created.length);
    expect(created.length).toBeGreaterThan(0);
    expect(moved).toEqual([]);

    await expectDelThenPushes(divisionId, competitionId, deleted);
  }, 120_000);

  it("generate that creates nothing (already generated) sends nothing", async () => {
    const { auth, divisionId, stageId } = await ungeneratedRig();
    await generateStageFixtures(auth, stageId);
    await quiesce();
    const before = await board(divisionId);

    const out = await generateStageFixtures(auth, stageId);
    expect(out.created).toBe(0);
    expect(diff(before, await board(divisionId))).toEqual({ moved: [], deleted: [], created: [] });
    await expectNothingSent();
  }, 120_000);

  it("rebuild: the fixtures it DELETED ride the hub key's one DEL after commit; no push for the ids it created", async () => {
    const { auth } = await seedOrg();
    const rig = await divisionRig(auth, { entrants: 3, start: false });
    const competitionId = await competitionOf(rig.divisionId);
    await quiesce();
    const before = await board(rig.divisionId);

    probe.hold = true;
    const out = await rebuildStageFixtures(auth, rig.stages[0]!.stageId);
    const { moved, deleted, created } = diff(before, await board(rig.divisionId));
    expect(out.removed, "the rebuild deleted the old board").toBe(deleted.length);
    expect(deleted.length).toBeGreaterThan(0);
    expect(created.length, "and generated a new one").toBe(out.created);
    expect(moved).toEqual([]);

    await expectDelThenPushes(rig.divisionId, competitionId, deleted);
    for (const id of created) {
      expect(probe.fixturePushes.map(([pushed]) => pushed), "no push to a fixture nobody can be watching").not.toContain(id);
    }
  }, 120_000);

  it("startDivision that generates its first stage still sends ONE DEL: the generate inside it does not publish a second", async () => {
    const { auth, divisionId, competitionId } = await ungeneratedRig();

    probe.hold = true;
    const out = await startDivision(auth, divisionId);
    expect(out.started, "the start landed").toBe(true);
    const after = await board(divisionId);
    expect(after.size, "the start generated the stage").toBeGreaterThan(0);

    const del = theOneDel();
    expect(del.first).toBe(hubKey(competitionId));
    expect(del.rest).toEqual([...after.keys()].sort().map(fixtureKey));
    await releaseDel();
    expect(probe.divisionPushes).toEqual([[divisionId, "start"]]);
  }, 120_000);
});

describe.skipIf(!HAS_DB)("an ad-hoc fixture, a ladder challenge and a stage delete publish too (found, R10e)", () => {
  it("addFixture (found): the hub key alone in one DEL after commit, the division push, no push for the new id", async () => {
    const { auth } = await seedOrg();
    const rig = await divisionRig(auth, { entrants: 3 });
    const competitionId = await competitionOf(rig.divisionId);
    const entrants = await sql<{ id: string }[]>`
      select id from entrants where division_id = ${rig.divisionId} order by seed nulls last, id`;
    await quiesce();
    const before = await board(rig.divisionId);

    probe.hold = true;
    const out = await addFixture(auth, rig.stages[0]!.stageId, {
      home_entrant_id: entrants[0]!.id,
      away_entrant_id: entrants[1]!.id,
      scheduled_at: "2030-06-02T10:00:00.000Z",
    });
    const { moved, deleted, created } = diff(before, await board(rig.divisionId));
    expect(created, "the ad-hoc fixture landed").toEqual([out.fixture_id]);
    expect([moved, deleted]).toEqual([[], []]);

    await expectDelThenPushes(rig.divisionId, competitionId, deleted);
    expect(probe.fixturePushes.map(([id]) => id), "no push to a fixture nobody can be watching").not.toContain(out.fixture_id);
  }, 120_000);

  it("addFixture refused (an entrant cannot play itself) writes nothing and sends nothing", async () => {
    const { auth } = await seedOrg();
    const rig = await divisionRig(auth, { entrants: 3 });
    const [entrant] = await sql<{ id: string }[]>`
      select id from entrants where division_id = ${rig.divisionId} limit 1`;
    await quiesce();
    const before = await board(rig.divisionId);

    await expect(addFixture(auth, rig.stages[0]!.stageId, {
      home_entrant_id: entrant!.id, away_entrant_id: entrant!.id,
    })).rejects.toThrow(/cannot play itself/);
    expect(diff(before, await board(rig.divisionId))).toEqual({ moved: [], deleted: [], created: [] });
    await expectNothingSent();
  }, 120_000);

  it("issueChallenge (found): the hub key alone in one DEL after commit, the division push, no push for the new id", async () => {
    const { auth, divisionId, competitionId, stageId, ladder } = await ladderRig();
    const before = await board(divisionId);

    probe.hold = true;
    const out = await issueChallenge(auth, stageId, { challenger_id: ladder[2]!, opponent_id: ladder[0]! });
    const { moved, deleted, created } = diff(before, await board(divisionId));
    expect(created, "the challenge fixture landed").toEqual([out.fixture_id]);
    expect([moved, deleted]).toEqual([[], []]);

    await expectDelThenPushes(divisionId, competitionId, deleted);
  }, 120_000);

  it("issueChallenge refused (a downward challenge) writes nothing and sends nothing", async () => {
    const { auth, divisionId, stageId, ladder } = await ladderRig();
    const before = await board(divisionId);

    await expect(issueChallenge(auth, stageId, { challenger_id: ladder[0]!, opponent_id: ladder[2]! }))
      .rejects.toThrow(/challenge upward/);
    expect(diff(before, await board(divisionId))).toEqual({ moved: [], deleted: [], created: [] });
    await expectNothingSent();
  }, 120_000);

  it("deleteStage (found): the fixtures its delete removed ride the hub key's one DEL after commit; pushes wait for it", async () => {
    const { auth } = await seedOrg();
    const rig = await divisionRig(auth, { entrants: 3, start: false });
    const competitionId = await competitionOf(rig.divisionId);
    await quiesce();
    const before = await board(rig.divisionId);

    probe.hold = true;
    await deleteStage(auth, rig.stages[0]!.stageId);
    const { moved, deleted, created } = diff(before, await board(rig.divisionId));
    expect(deleted.length, "the stage took fixtures with it").toBeGreaterThan(0);
    expect([moved, created]).toEqual([[], []]);

    await expectDelThenPushes(rig.divisionId, competitionId, deleted);
  }, 120_000);

  it("deleteStage of a stage with NO fixtures (R10f): the hub key alone in one DEL after commit, the division push; the other stage's fixtures are not named", async () => {
    const { auth } = await seedOrg();
    const rig = await divisionRig(auth, { entrants: 3, start: false });
    const [empty] = await createStages(auth, rig.divisionId, { seq: 2, kind: "league", name: "L2", config: {} });
    const competitionId = await competitionOf(rig.divisionId);
    await quiesce();
    const before = await board(rig.divisionId);
    expect(rig.fixtureIds.length, "the first stage has fixtures to keep").toBeGreaterThan(0);
    expect(before.size, "and only the first stage has fixtures").toBe(rig.fixtureIds.length);

    probe.hold = true;
    await deleteStage(auth, empty!.id);
    expect(diff(before, await board(rig.divisionId)), "the empty stage took no fixture with it")
      .toEqual({ moved: [], deleted: [], created: [] });
    const [left] = await sql<{ n: number }[]>`select count(*)::int as n from stages where id = ${empty!.id}`;
    expect(left!.n, "the stage itself is gone").toBe(0);

    await expectDelThenPushes(rig.divisionId, competitionId, []);
  }, 120_000);

  it("deleteStage refused (not the last stage) writes nothing and sends nothing", async () => {
    const { auth } = await seedOrg();
    const rig = await divisionRig(auth, { entrants: 3, stages: 2, start: false });
    await quiesce();
    const before = await board(rig.divisionId);

    await expect(deleteStage(auth, rig.stages[0]!.stageId)).rejects.toThrow(/only the last stage/);
    expect(diff(before, await board(rig.divisionId))).toEqual({ moved: [], deleted: [], created: [] });
    await expectNothingSent();
  }, 120_000);
});

interface CompleteReply {
  status: number;
  body: {
    ok: boolean;
    data?: {
      completed?: boolean;
      next_stage_fixtures?: number;
      division_completed?: boolean;
      seed_proposal?: { id: string; status: string };
    };
    error?: { code: string; message: string };
  };
}

async function stageStatus(stageId: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`select status from stages where id = ${stageId}`;
  return row!.status;
}

/** `POST /api/v1/stages/{id}/complete`, as the organiser's button sends it. */
async function completeByRoute(auth: AuthCtx, stageId: string): Promise<CompleteReply> {
  authState.userId = auth.userId!;
  const res = await completeStageRoute(
    new Request(`https://test.local/api/v1/stages/${stageId}/complete`, { method: "POST" }),
    { params: Promise.resolve({ id: stageId }) },
  );
  return { status: res.status, body: (await res.json()) as CompleteReply["body"] };
}

/** Groups -> knockout with an `on_complete` progression: completing the groups
 *  seeds the knockout and draws its bracket. Four entrants, two pools of two
 *  (one fixture per pool). A started division on a Pro org whose owner is a
 *  real user, so the route authenticates a session.
 *
 *  R10g: `timing: "setup"` is the templated shape instead. The knockout's
 *  fixtures exist from the start as TBD placeholders, completing the groups
 *  computes a DRAFT seed proposal, and the organiser's confirm names the
 *  entrants into those placeholders. */
async function groupsToKnockoutRig(opts: { autoProgress?: boolean; timing?: "setup" | "on_complete" } = {}) {
  const { auth } = await seedOrgOnPlan("pro");
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31", name: "Knockout Cup", visibility: "public", branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG,
  });
  if (opts.autoProgress) await patchDivision(auth, division.id, { auto_progress: true });
  await createEntrants(auth, division.id, ["A", "B", "C", "D"].map((name, i) => ({
    kind: "individual" as const, display_name: name, seed: i + 1, members: [],
  })));
  const stages = await createStages(auth, division.id, [
    { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
    {
      seq: 2,
      kind: "knockout",
      name: "KO",
      config: {},
      progression: {
        sources: [{
          stage: "previous",
          take: [{
            kind: "picks",
            picks: [{ pool: "A", rank: 1 }, { pool: "B", rank: 2 }, { pool: "B", rank: 1 }, { pool: "A", rank: 2 }],
          }],
        }],
        placement: "rank_order",
        timing: opts.timing ?? "on_complete",
      },
    },
  ]);
  const groupId = stages.find((s) => s.kind === "group")!.id;
  const koId = stages.find((s) => s.kind === "knockout")!.id;
  await generateStageFixtures(auth, groupId);
  if (opts.timing === "setup") await generateStageFixtures(auth, koId);
  await startDivision(auth, division.id);
  const groupFixtures = (await sql<{ id: string }[]>`
    select id from fixtures where stage_id = ${groupId} order by id`).map((row) => row.id);
  await quiesce();
  return { auth, divisionId: division.id, competitionId: competition.id, groupId, koId, groupFixtures };
}

/** Decide every group fixture through the engine's own `appendEvent`, which
 *  runs no scoring hook: setup, not a write under test. */
async function decideThroughEngine(orgId: string, fixtureIds: readonly string[]): Promise<void> {
  for (const id of fixtureIds) {
    await appendEvent(orgId, id, 0, { type: "core.start", payload: {} });
    await appendEvent(orgId, id, 1, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
  }
}

describe.skipIf(!HAS_DB)("a manual stage completion publishes the bracket it draws; scoring's auto-advance does not publish it twice (R10f)", () => {
  it("POST /stages/{id}/complete that draws the knockout: the hub key alone in one DEL after commit, the division push, no fixture push", async () => {
    const rig = await groupsToKnockoutRig();
    await decideThroughEngine(rig.auth.orgId, rig.groupFixtures);
    await quiesce();
    const before = await board(rig.divisionId);

    probe.hold = true;
    const reply = await completeByRoute(rig.auth, rig.groupId);
    expect(reply.status, JSON.stringify(reply.body.error)).toBe(200);
    const { moved, deleted, created } = diff(before, await board(rig.divisionId));
    expect(reply.body.data?.completed).toBe(true);
    expect(created.length, "the completion drew the knockout").toBeGreaterThan(0);
    expect(reply.body.data?.next_stage_fixtures).toBe(created.length);
    expect([moved, deleted]).toEqual([[], []]);

    await expectDelThenPushes(rig.divisionId, rig.competitionId, deleted);
  }, 120_000);

  it("completeStage called with NO options (R10g): publishing is the default, so the draw's hub key goes in one DEL after commit, then the division push", async () => {
    const rig = await groupsToKnockoutRig();
    await decideThroughEngine(rig.auth.orgId, rig.groupFixtures);
    await quiesce();
    const before = await board(rig.divisionId);

    probe.hold = true;
    const result = await completeStage(rig.auth, rig.groupId);
    const { moved, deleted, created } = diff(before, await board(rig.divisionId));
    expect(result.completed).toBe(true);
    expect(created.length, "the completion drew the knockout").toBeGreaterThan(0);
    expect(result.next_stage_fixtures).toBe(created.length);
    expect([moved, deleted]).toEqual([[], []]);

    await expectDelThenPushes(rig.divisionId, rig.competitionId, deleted);
  }, 120_000);

  // R10g (review-r10f m2) REVERSES R10f's expectation here: the freeze refuses
  // only the DRAW. The stage's own completion commits (a freeze does not bind
  // the lifecycle transition, see `completeStage`), and the hub shows stage
  // status, so the hub key goes out.
  it("POST /stages/{id}/complete on a frozen division: the completion commits, no knockout is drawn, and the hub key alone goes in one DEL after commit (R10g)", async () => {
    const rig = await groupsToKnockoutRig();
    await decideThroughEngine(rig.auth.orgId, rig.groupFixtures);
    await setDivisionLocks(rig.auth, rig.divisionId, { schedule_locked: true });
    await quiesce();
    const before = await board(rig.divisionId);

    probe.hold = true;
    const reply = await completeByRoute(rig.auth, rig.groupId);
    expect(reply.status, JSON.stringify(reply.body.error)).toBe(200);
    expect(reply.body.data?.completed).toBe(true);
    expect(reply.body.data?.next_stage_fixtures, "the freeze refused the draw").toBeUndefined();
    expect(await stageStatus(rig.groupId), "the completion itself committed").toBe("complete");
    expect(diff(before, await board(rig.divisionId))).toEqual({ moved: [], deleted: [], created: [] });
    await expectDelThenPushes(rig.divisionId, rig.competitionId, []);
  }, 120_000);

  // R10h (review-r10g m1): the reason an already-complete stage still
  // publishes. `completeStageIfReady` returns `completed: true, events: []`
  // for a stage that is already complete and writes nothing itself — but the
  // call around it is not a no-op: the draw the freeze refused happens NOW.
  // A "publish only when this call wrote something" guard would look safe
  // against every other case here and leave this hub stale.
  it("re-completing an already-complete stage after the freeze is lifted draws the knockout, and the hub key alone still goes in one DEL after commit (R10h)", async () => {
    const rig = await groupsToKnockoutRig();
    await decideThroughEngine(rig.auth.orgId, rig.groupFixtures);
    await setDivisionLocks(rig.auth, rig.divisionId, { schedule_locked: true });
    const frozen = await completeByRoute(rig.auth, rig.groupId);
    expect(frozen.status, JSON.stringify(frozen.body.error)).toBe(200);
    expect(frozen.body.data?.next_stage_fixtures, "the freeze refused the draw").toBeUndefined();
    expect(await stageStatus(rig.groupId), "the stage is already complete before the second call").toBe("complete");
    await setDivisionLocks(rig.auth, rig.divisionId, { schedule_locked: false });
    await quiesce();
    const before = await board(rig.divisionId);

    probe.hold = true;
    const again = await completeByRoute(rig.auth, rig.groupId);
    expect(again.status, JSON.stringify(again.body.error)).toBe(200);
    expect(again.body.data?.completed, "an already-complete stage reports completed").toBe(true);
    const { moved, deleted, created } = diff(before, await board(rig.divisionId));
    expect(created.length, "the second call drew the knockout the freeze had refused").toBeGreaterThan(0);
    expect(again.body.data?.next_stage_fixtures).toBe(created.length);
    expect([moved, deleted]).toEqual([[], []]);

    await expectDelThenPushes(rig.divisionId, rig.competitionId, deleted);
  }, 120_000);

  // R10g (review-r10f m2) deliberately REVERSES R10f's "the last stage sends
  // nothing": the division's status changes on the hub.
  it("POST /stages/{id}/complete of the last stage: the division completes, nothing is drawn, and the hub key alone goes in one DEL after commit (R10g)", async () => {
    const { auth } = await seedOrgOnPlan("pro");
    const rig = await divisionRig(auth, { entrants: 2 });
    const competitionId = await competitionOf(rig.divisionId);
    await decideThroughEngine(auth.orgId, rig.fixtureIds);
    await quiesce();
    const before = await board(rig.divisionId);

    probe.hold = true;
    const reply = await completeByRoute(auth, rig.stages[0]!.stageId);
    expect(reply.status, JSON.stringify(reply.body.error)).toBe(200);
    expect(reply.body.data?.division_completed).toBe(true);
    expect(diff(before, await board(rig.divisionId))).toEqual({ moved: [], deleted: [], created: [] });
    await expectDelThenPushes(rig.divisionId, competitionId, []);
  }, 120_000);

  it("POST /stages/{id}/complete that computes a seed proposal (the templated setup path, R10g): the stage completes, nothing is drawn, and the hub key alone goes in one DEL after commit", async () => {
    const rig = await groupsToKnockoutRig({ timing: "setup" });
    await decideThroughEngine(rig.auth.orgId, rig.groupFixtures);
    await quiesce();
    const before = await board(rig.divisionId);

    probe.hold = true;
    const reply = await completeByRoute(rig.auth, rig.groupId);
    expect(reply.status, JSON.stringify(reply.body.error)).toBe(200);
    expect(reply.body.data?.completed).toBe(true);
    expect(reply.body.data?.seed_proposal?.status, "the completion computed the knockout's draft proposal").toBe("draft");
    expect(diff(before, await board(rig.divisionId))).toEqual({ moved: [], deleted: [], created: [] });
    await expectDelThenPushes(rig.divisionId, rig.competitionId, []);
  }, 120_000);

  it("POST /stages/{id}/complete of a stage that is not finished (R10g): refused, nothing committed, nothing sent", async () => {
    const rig = await groupsToKnockoutRig();
    const before = await board(rig.divisionId);

    const reply = await completeByRoute(rig.auth, rig.groupId);
    expect(reply.status, JSON.stringify(reply.body.error)).toBe(200);
    expect(reply.body.data?.completed, "the group fixtures are undecided").toBe(false);
    expect(await stageStatus(rig.groupId)).not.toBe("complete");
    expect(diff(before, await board(rig.divisionId))).toEqual({ moved: [], deleted: [], created: [] });
    await expectNothingSent();
  }, 120_000);

  it("a completion that commits and then fails seeding the next stage (R10g): the error propagates, the stage stays complete, and the hub key alone still goes in one DEL after commit", async () => {
    const rig = await groupsToKnockoutRig();
    await decideThroughEngine(rig.auth.orgId, rig.groupFixtures);
    await quiesce();
    const before = await board(rig.divisionId);

    probe.hold = true;
    probe.failAtLock = 2;
    await expect(completeStage(rig.auth, rig.groupId), "the seeding step's own error reaches the caller")
      .rejects.toBe(probe.injected);
    expect(probe.locks, "the completion took the first lock and committed; seeding the knockout took the second").toBe(2);
    expect(await stageStatus(rig.groupId), "the completion committed before seeding failed").toBe("complete");
    expect(diff(before, await board(rig.divisionId))).toEqual({ moved: [], deleted: [], created: [] });
    await expectDelThenPushes(rig.divisionId, rig.competitionId, []);
  }, 120_000);

  it("auto-advance through scoring: the deciding score draws the knockout and sends scoring's own one DEL and pushes, nothing more", async () => {
    const rig = await groupsToKnockoutRig({ autoProgress: true });
    const [first, last] = rig.groupFixtures;
    await scoreEvent(rig.auth, first!, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(rig.auth, first!, { expected_seq: 1, type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
    await scoreEvent(rig.auth, last!, { expected_seq: 0, type: "core.start", payload: {} });
    await quiesce();
    const before = await board(rig.divisionId);

    await scoreEvent(rig.auth, last!, { expected_seq: 1, type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
    const { moved, deleted, created } = diff(before, await board(rig.divisionId));
    expect(created.length, "the deciding score auto-advanced into the knockout").toBeGreaterThan(0);
    expect([moved, deleted]).toEqual([[], []]);

    await sleep(40);
    expect(probe.dels, "scoring's DEL of its fixture and the hub key, once; no second hub DEL for the draw").toEqual([
      [fixtureKey(last!), hubKey(rig.competitionId)],
    ]);
    expect(probe.divisionPushes, "scoring's division push, once; no schedule push for the draw").toEqual([
      [rig.divisionId, "score"],
    ]);
    expect(probe.fixturePushes).toEqual([[last!, "event"]]);
  }, 120_000);
});

describe.skipIf(!HAS_DB)("a restore or rebuild that fails part-way still publishes what it committed (R10f)", () => {
  it("restore whose SECOND undo step throws: the error propagates, and the first step's fixture alone rides the hub key's one DEL after commit; pushes wait for it", async () => {
    const { auth } = await seedOrg();
    const rig = await divisionRig(auth, { entrants: 3 });
    const competitionId = await competitionOf(rig.divisionId);
    const checkpoint = await createCheckpoint(auth, rig.divisionId, "before the rain");
    await moveFixture(auth, rig.fixtureIds[0]!, { scheduled_at: "2030-06-01T10:00:00.000Z" });
    await moveFixture(auth, rig.fixtureIds[1]!, { scheduled_at: "2030-06-01T11:00:00.000Z" });
    await quiesce();
    const before = await board(rig.divisionId);

    probe.hold = true;
    probe.failAtLock = 2;
    await expect(restoreCheckpoint(auth, rig.divisionId, checkpoint.id, true), "the step's own error reaches the caller")
      .rejects.toBe(probe.injected);
    expect(probe.locks, "the second undo step's transaction was the one that failed").toBe(2);
    const { moved, deleted, created } = diff(before, await board(rig.divisionId));
    expect(moved, "the first step committed (the later move undone); the second rolled back (the earlier move stands)")
      .toEqual([rig.fixtureIds[1]]);
    expect([deleted, created]).toEqual([[], []]);

    await expectDelThenPushes(rig.divisionId, competitionId, moved);
  }, 120_000);

  it("rebuild whose regenerate throws after the delete committed: the error propagates, and the deleted fixtures ride the hub key's one DEL after commit; pushes wait for it", async () => {
    const { auth } = await seedOrg();
    const rig = await divisionRig(auth, { entrants: 3, start: false });
    const competitionId = await competitionOf(rig.divisionId);
    await quiesce();
    const before = await board(rig.divisionId);

    probe.hold = true;
    probe.failAtLock = 2;
    await expect(rebuildStageFixtures(auth, rig.stages[0]!.stageId), "the regenerate's error reaches the caller")
      .rejects.toBe(probe.injected);
    expect(probe.locks, "the regenerate's transaction, after the delete's, was the one that failed").toBe(2);
    const { moved, deleted, created } = diff(before, await board(rig.divisionId));
    expect(deleted.length, "the delete committed: the whole old board is gone").toBe(before.size);
    expect(deleted.length).toBeGreaterThan(0);
    expect([moved, created], "the regenerate rolled back: nothing new on the board").toEqual([[], []]);

    await expectDelThenPushes(rig.divisionId, competitionId, deleted);
  }, 120_000);
});

/** Every fixture of the division, as `id -> who plays it` (both sides'
 *  entrant), so `diff(...).moved` is exactly the fixtures a write named
 *  entrants into. */
async function lineups(divisionId: string): Promise<Board> {
  const rows = await sql<{ id: string; home: string | null; away: string | null }[]>`
    select id, home_entrant_id as home, away_entrant_id as away from fixtures where division_id = ${divisionId}`;
  return new Map(rows.map((row) => [row.id, `${row.home ?? "-"}|${row.away ?? "-"}`]));
}

interface ConfirmReply {
  status: number;
  body: { ok: boolean; data?: { filled?: number }; error?: { code: string; message: string } };
}

/** `POST /api/v1/stages/{id}/seed-proposal/confirm`, as the progression
 *  panel's Confirm button sends it. */
async function confirmByRoute(auth: AuthCtx, stageId: string, proposalId: string): Promise<ConfirmReply> {
  authState.userId = auth.userId!;
  const res = await confirmSeedProposalRoute(
    new Request(`https://test.local/api/v1/stages/${stageId}/seed-proposal/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId }),
    }),
    { params: Promise.resolve({ id: stageId }) },
  );
  return { status: res.status, body: (await res.json()) as ConfirmReply["body"] };
}

/** A templated groups -> knockout whose groups are decided and completed, so
 *  the knockout holds a draft seed proposal and TBD placeholders. */
async function proposalRig() {
  const rig = await groupsToKnockoutRig({ timing: "setup" });
  await decideThroughEngine(rig.auth.orgId, rig.groupFixtures);
  const done = await completeStage(rig.auth, rig.groupId);
  expect(done.seed_proposal?.status, "the completion computed the knockout's draft proposal").toBe("draft");
  const knockout = (await sql<{ id: string }[]>`
    select id from fixtures where stage_id = ${rig.koId}`).map((row) => row.id);
  expect(knockout.length, "the knockout's placeholders exist before the confirm").toBeGreaterThan(0);
  await quiesce();
  return { ...rig, proposalId: done.seed_proposal!.id, knockout };
}

describe.skipIf(!HAS_DB)("confirming a seed proposal publishes the names it filled into the bracket (R10g)", () => {
  it("POST /stages/{id}/seed-proposal/confirm: the fixtures it filled, and ONLY those, ride the hub key's one DEL after commit; pushes wait for it", async () => {
    const rig = await proposalRig();
    const before = await lineups(rig.divisionId);
    const slotsBefore = await board(rig.divisionId);

    probe.hold = true;
    const reply = await confirmByRoute(rig.auth, rig.koId, rig.proposalId);
    expect(reply.status, JSON.stringify(reply.body.error)).toBe(200);
    const after = await lineups(rig.divisionId);
    const { moved: filled, deleted, created } = diff(before, after);
    expect([deleted, created]).toEqual([[], []]);
    expect(filled.length, "the confirm named entrants into the bracket").toBeGreaterThan(0);
    expect(filled.every((id) => rig.knockout.includes(id)), "only knockout fixtures were filled").toBe(true);
    expect(
      rig.knockout.filter((id) => after.get(id) === "-|-").length,
      "a fixture fed by winners is still TBD, so a DEL naming the whole stage would differ",
    ).toBeGreaterThan(0);
    expect(diff(slotsBefore, await board(rig.divisionId)).moved, "a confirm names entrants; it moves no kick-off").toEqual([]);

    await expectDelThenPushes(rig.divisionId, rig.competitionId, filled);
  }, 120_000);

  it("a confirm that changes nothing (the proposal is already confirmed) is refused and sends nothing", async () => {
    const rig = await proposalRig();
    const first = await confirmByRoute(rig.auth, rig.koId, rig.proposalId);
    expect(first.status, JSON.stringify(first.body.error)).toBe(200);
    await quiesce();
    const before = await lineups(rig.divisionId);

    const again = await confirmByRoute(rig.auth, rig.koId, rig.proposalId);
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("SEEDING_ALREADY_CONFIRMED");
    expect(diff(before, await lineups(rig.divisionId))).toEqual({ moved: [], deleted: [], created: [] });
    await expectNothingSent();
  }, 120_000);
});

interface BracketRow {
  id: string;
  ext_key: string | null;
  home: string | null;
  away: string | null;
  winner_to: string | null;
  loser_to: string | null;
}

/** A started bracket of four on a Pro org: `knockout` is two semi-finals
 *  feeding one final; `double_elim` also drops each loser into the losers'
 *  bracket. Deciding a first-round fixture through the real `scoreEvent`
 *  advances a name into the next fixture — the write under test. */
async function bracketRig(kind: "knockout" | "double_elim" = "knockout") {
  const { auth } = await seedOrgOnPlan("pro");
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31", name: "Advance Cup", visibility: "public", branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG,
  });
  await createEntrants(auth, division.id, ["A", "B", "C", "D"].map((name, i) => ({
    kind: "individual" as const, display_name: name, seed: i + 1, members: [],
  })));
  const [stage] = await createStages(auth, division.id, { seq: 1, kind, name: "Bracket", config: {} });
  await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);
  const fixtures = await sql<BracketRow[]>`
    select id, ext_key, home_entrant_id as home, away_entrant_id as away,
           winner_to_fixture as winner_to, loser_to_fixture as loser_to
    from fixtures where stage_id = ${stage!.id} order by ext_key`;
  await quiesce();
  return { auth, divisionId: division.id, competitionId: competition.id, stageId: stage!.id, fixtures };
}

/** Both sides known, so the fixture can actually be played now. */
const playable = (f: BracketRow) => f.home !== null && f.away !== null;

const decide = (rig: { auth: AuthCtx }, fixtureId: string, seq: number) =>
  scoreEvent(rig.auth, fixtureId, {
    expected_seq: seq, type: "generic.result", payload: { p1Score: 2, p2Score: 0 },
  });

const start = (rig: { auth: AuthCtx }, fixtureId: string) =>
  scoreEvent(rig.auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });

describe.skipIf(!HAS_DB)("a score that advances a name into the next fixture publishes THAT fixture too (R10h)", () => {
  it("deciding a semi-final: the final's key rides scoring's own one DEL, and its push goes out after that DEL", async () => {
    const rig = await bracketRig();
    const semi = rig.fixtures.find((f) => playable(f) && f.winner_to !== null);
    expect(semi, "the bracket has a playable fixture that feeds another").toBeDefined();
    await start(rig, semi!.id);
    await quiesce();
    const before = await lineups(rig.divisionId);

    probe.hold = true;
    await decide(rig, semi!.id, 1);
    const { moved: advanced, deleted, created } = diff(before, await lineups(rig.divisionId));
    expect([deleted, created]).toEqual([[], []]);
    expect(advanced, "the winner was named into exactly the fixture this one feeds").toEqual([semi!.winner_to]);

    expect(probe.dels, "scoring's own two keys, plus the advanced-into fixture's, in ONE DEL").toEqual([
      [fixtureKey(semi!.id), hubKey(rig.competitionId), ...advanced.map(fixtureKey)],
    ]);
    expect(probe.inTxAtDel, "the DEL went out after the score committed, not from inside its transaction")
      .toEqual([false]);
    await sleep(20);
    expect(probe.fixturePushes, "fixture push before the DEL settled").toEqual([]);
    expect(probe.divisionPushes, "division push before the DEL settled").toEqual([]);

    await releaseDel();
    expect(probe.fixturePushes, "scoring's own push, plus one for the fixture the winner advanced into").toEqual([
      [semi!.id, "event"],
      ...advanced.map((id) => [id, "schedule"]),
    ]);
    expect(probe.divisionPushes).toEqual([[rig.divisionId, "score"]]);
  }, 120_000);

  it("deciding the FINAL advances nobody: the DEL and the pushes are exactly the two keys and the one push scoring sends on its own", async () => {
    const rig = await bracketRig();
    const semis = rig.fixtures.filter((f) => playable(f) && f.winner_to !== null);
    const finals = rig.fixtures.filter((f) => f.winner_to === null);
    expect(finals, "a four-entrant knockout ends in exactly one fixture that feeds nothing").toHaveLength(1);
    const final = finals[0]!;
    for (const semi of semis) {
      await start(rig, semi.id);
      await decide(rig, semi.id, 1);
    }
    await start(rig, final.id);
    await quiesce();
    const before = await lineups(rig.divisionId);

    probe.hold = true;
    await decide(rig, final.id, 1);
    expect(diff(before, await lineups(rig.divisionId)), "a final's winner is named into nothing")
      .toEqual({ moved: [], deleted: [], created: [] });

    expect(probe.dels, "no third key: nothing advanced").toEqual([
      [fixtureKey(final.id), hubKey(rig.competitionId)],
    ]);
    expect(probe.inTxAtDel).toEqual([false]);
    await releaseDel();
    expect(probe.fixturePushes, "no second push: nothing advanced").toEqual([[final.id, "event"]]);
    expect(probe.divisionPushes).toEqual([[rig.divisionId, "score"]]);
  }, 120_000);

  // The ids are the FILL's own result, not the bracket link: `fillSlot` only
  // touches a slot that is still open, and reports the row it touched. Undoing
  // a decision does not empty the slot it filled (a pre-existing gap, R10h
  // report), so re-deciding the fixture runs a fill that touches nothing —
  // and a fixture nothing was written into owes no DEL and no push.
  it("re-deciding a fixture whose destination slot is already taken advances nobody: the DEL and the pushes are scoring's own again", async () => {
    const rig = await bracketRig();
    const semi = rig.fixtures.find((f) => playable(f) && f.winner_to !== null);
    expect(semi, "the bracket has a playable fixture that feeds another").toBeDefined();
    await start(rig, semi!.id);
    await decide(rig, semi!.id, 1);
    const filled = await lineups(rig.divisionId);
    const [decider] = await sql<{ id: string; seq: number }[]>`
      select id, seq from score_events where fixture_id = ${semi!.id} and type = 'generic.result'`;
    await scoreEvent(rig.auth, semi!.id, {
      expected_seq: decider!.seq, type: "core.void", payload: { event_id: decider!.id },
    });
    await quiesce();
    const before = await lineups(rig.divisionId);
    expect(before.get(semi!.winner_to!), "undoing the result leaves the name it advanced in place")
      .toBe(filled.get(semi!.winner_to!));

    probe.hold = true;
    await scoreEvent(rig.auth, semi!.id, {
      expected_seq: decider!.seq + 1, type: "generic.result", payload: { p1Score: 0, p2Score: 2 },
    });
    expect(diff(before, await lineups(rig.divisionId)), "the slot was already taken, so this score named nobody")
      .toEqual({ moved: [], deleted: [], created: [] });

    expect(probe.dels, "no third key: the fill touched no row").toEqual([
      [fixtureKey(semi!.id), hubKey(rig.competitionId)],
    ]);
    await releaseDel();
    expect(probe.fixturePushes, "no second push: the fill touched no row").toEqual([[semi!.id, "event"]]);
    expect(probe.divisionPushes).toEqual([[rig.divisionId, "score"]]);
  }, 120_000);

  it("double elimination: the loser's drop is advanced too, so BOTH fixtures ride the one DEL and both are pushed after it", async () => {
    const rig = await bracketRig("double_elim");
    const first = rig.fixtures.find((f) => playable(f) && f.winner_to !== null && f.loser_to !== null);
    expect(first, "a double-elimination first round feeds a winners' AND a losers' fixture").toBeDefined();
    await start(rig, first!.id);
    await quiesce();
    const before = await lineups(rig.divisionId);

    probe.hold = true;
    await decide(rig, first!.id, 1);
    const { moved: advanced, deleted, created } = diff(before, await lineups(rig.divisionId));
    expect([deleted, created]).toEqual([[], []]);
    expect(advanced, "the winner went up and the loser dropped")
      .toEqual([first!.winner_to, first!.loser_to].sort());

    expect(probe.dels, "one DEL").toHaveLength(1);
    const del = probe.dels[0]!;
    expect(del.slice(0, 2), "scoring's own two keys first").toEqual([
      fixtureKey(first!.id), hubKey(rig.competitionId),
    ]);
    expect([...del.slice(2)].sort(), "then both advanced-into fixtures").toEqual(advanced.map(fixtureKey).sort());
    expect(probe.inTxAtDel).toEqual([false]);
    await sleep(20);
    expect(probe.fixturePushes, "fixture push before the DEL settled").toEqual([]);

    await releaseDel();
    expect(probe.fixturePushes[0], "scoring's own push first").toEqual([first!.id, "event"]);
    expect(probe.fixturePushes.slice(1).map(([id]) => id).sort(), "one push per advanced-into fixture")
      .toEqual([...advanced].sort());
    expect(new Set(probe.fixturePushes.slice(1).map(([, reason]) => reason))).toEqual(new Set(["schedule"]));
    expect(probe.divisionPushes).toEqual([[rig.divisionId, "score"]]);
  }, 120_000);

  // M2 r1 (review-p2-r10h R10h-m2) — the OTHER half of the R10h decision, and
  // until now the unpinned one.
  //
  // `invalidatePublicCache` can reject in exactly two places, its `withTenant`
  // lookup and the `fireScoreRevalidate` tag call, and BOTH sit before any
  // `cacheDel`: the two inner Redis calls carry their own catches, and
  // `sendAfterDeleteOrBound` is never reached on that path. So when it
  // rejects, no DEL went out at all, and `scoreEvent`'s `.catch` fallback
  // (scoring.ts:215-227) deliberately pushes ONLY the decided fixture — the
  // scorer's other devices still need their ping, while a push for a fixture
  // this score advanced a name INTO would send its spectators straight back
  // to the stale cached document they are already showing. They keep their
  // own 30 s poll, which is what every score did before R10h.
  //
  // That is the right call and nothing asserted it: `hub-cache-invalidation`
  // covers a rejecting DEL and a rejecting SCAN but not the function itself
  // rejecting, and none of the cases above exercise it. A later edit that
  // "helpfully" added `for (const id of advanced) void
  // publishFixtureUpdate(id, "schedule")` to that catch would have stayed
  // green everywhere.
  it("when the invalidation itself rejects, no DEL goes out and ONLY the decided fixture is pushed — never the one it advanced into", async () => {
    const rig = await bracketRig();
    const semi = rig.fixtures.find((f) => playable(f) && f.winner_to !== null);
    expect(semi, "the bracket has a playable fixture that feeds another").toBeDefined();
    await start(rig, semi!.id);
    await quiesce();
    const before = await lineups(rig.divisionId);

    probe.failRevalidate = new Error("injected: the ISR tag call failed");
    // No `probe.hold`: there is nothing to hold. The point of the case is that
    // the DEL is never issued, so the pushes cannot be waiting on one.
    const out = await decide(rig, semi!.id, 1);
    expect(out.outcome, "the score itself still stands — the invalidation is post-commit").not.toBeNull();

    // ANTI-VACUITY, and the half R10h-m2 asked for: the advance really did
    // happen, so `advanced` was NON-EMPTY when the fallback chose what to
    // push. Without this the case would pass just as well on a score that
    // advanced nobody, and would be pinning nothing.
    const { moved: advanced, deleted, created } = diff(before, await lineups(rig.divisionId));
    expect([deleted, created]).toEqual([[], []]);
    expect(advanced, "the winner was still named into the fixture this one feeds")
      .toEqual([semi!.winner_to]);

    expect(probe.dels, "the invalidation rejected before `cacheDel`, so no key was dropped").toEqual([]);
    // Late arrivals too: `sendAfterDeleteOrBound` is never reached on this
    // path, so nothing can turn up on the bound either.
    await sleep(40);
    expect(probe.dels, "a DEL turned up later").toEqual([]);
    expect(
      probe.fixturePushes,
      "the fallback pushed something other than the decided fixture — a push for a fixture whose Redis copy was NOT dropped sends its spectators back to the stale document they already have",
    ).toEqual([[semi!.id, "event"]]);
    expect(probe.divisionPushes, "the division push rides the callback, which is never reached").toEqual([]);
  }, 120_000);
});
