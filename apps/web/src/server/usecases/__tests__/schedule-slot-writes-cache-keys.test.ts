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
// time. Each is driven through
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
      actual.withTenant(orgId, (tx) => probe.inTx.run(true, () => fn(tx))),
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

import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { POST as completeStageRoute } from "@/app/api/v1/stages/[id]/complete/route";
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
    data?: { completed?: boolean; next_stage_fixtures?: number; division_completed?: boolean };
    error?: { code: string; message: string };
  };
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
 *  real user, so the route authenticates a session. */
async function groupsToKnockoutRig(opts: { autoProgress?: boolean } = {}) {
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
        timing: "on_complete",
      },
    },
  ]);
  const groupId = stages.find((s) => s.kind === "group")!.id;
  await generateStageFixtures(auth, groupId);
  await startDivision(auth, division.id);
  const groupFixtures = (await sql<{ id: string }[]>`
    select id from fixtures where stage_id = ${groupId} order by id`).map((row) => row.id);
  await quiesce();
  return { auth, divisionId: division.id, competitionId: competition.id, groupId, groupFixtures };
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

  it("POST /stages/{id}/complete on a frozen division: the completion stands, no knockout is drawn, nothing is sent", async () => {
    const rig = await groupsToKnockoutRig();
    await decideThroughEngine(rig.auth.orgId, rig.groupFixtures);
    await setDivisionLocks(rig.auth, rig.divisionId, { schedule_locked: true });
    await quiesce();
    const before = await board(rig.divisionId);

    const reply = await completeByRoute(rig.auth, rig.groupId);
    expect(reply.status, JSON.stringify(reply.body.error)).toBe(200);
    expect(reply.body.data?.completed).toBe(true);
    expect(reply.body.data?.next_stage_fixtures, "the freeze refused the draw").toBeUndefined();
    expect(diff(before, await board(rig.divisionId))).toEqual({ moved: [], deleted: [], created: [] });
    await expectNothingSent();
  }, 120_000);

  it("POST /stages/{id}/complete of the last stage: the division completes, nothing is drawn, nothing is sent", async () => {
    const { auth } = await seedOrgOnPlan("pro");
    const rig = await divisionRig(auth, { entrants: 2 });
    await decideThroughEngine(auth.orgId, rig.fixtureIds);
    await quiesce();
    const before = await board(rig.divisionId);

    const reply = await completeByRoute(auth, rig.stages[0]!.stageId);
    expect(reply.status, JSON.stringify(reply.body.error)).toBe(200);
    expect(reply.body.data?.division_completed).toBe(true);
    expect(diff(before, await board(rig.divisionId))).toEqual({ moved: [], deleted: [], created: [] });
    await expectNothingSent();
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
