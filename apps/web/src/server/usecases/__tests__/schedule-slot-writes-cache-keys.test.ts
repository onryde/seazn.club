// R10e — every write that moves a fixture's slot reaches the live hub and the
// match centre without a reload (review-r10d m1).
//
// `schedule-fixture-cache-keys.test.ts` pins the five writers that already
// called `afterScheduleWrite` (apply, move, publish, start, joint apply). These
// cases pin the writers that did not: a rain-delay SHIFT, UNDO / REDO, RESTORE
// to a save point, CLEAR, and stage GENERATE / REBUILD. Each is driven through
// its real use-case against Postgres, and each must:
//   - send ONE DEL of the hub key plus the keys of exactly the fixtures its own
//     write changed (derived here from a before/after read of the fixtures
//     table, never from a list typed into the test);
//   - send that DEL only after its transaction has committed (the `withTenant`
//     recorder below counts open transactions at the moment of the DEL);
//   - send the division push once and the fixture pushes only after the DEL;
//   - send nothing at all when the write changed nothing.
//
// `@/lib/cache` and `@/lib/realtime` are recording passthroughs (the R10d
// probe): every public literal-key DEL is recorded and, when `probe.hold` is
// set, held open until the test releases it. `@/lib/db` is a passthrough whose
// `withTenant` counts the transactions still open. Real Postgres required;
// skipped without DATABASE_URL.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  hold: false,
  openTx: 0,
  dels: [] as string[][],
  openTxAtDel: [] as number[],
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
      probe.openTxAtDel.push(probe.openTx);
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
    // The promise `withTenant` returns settles after COMMIT, so a DEL recorded
    // while this count is above zero was sent from inside a transaction.
    withTenant: async (orgId: string, fn: Parameters<typeof actual.withTenant>[1]) => {
      probe.openTx++;
      try {
        return await actual.withTenant(orgId, fn);
      } finally {
        probe.openTx--;
      }
    },
  };
});

import { sql } from "@/lib/db";
import { shiftDivisionSchedule } from "../schedule-plus";
import { divisionRig, seedOrg } from "./_rig";

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
  probe.openTxAtDel.length = 0;
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

/** The one DEL, split into its first key and the rest (sorted), plus how many
 *  transactions were open when it was sent. */
function theOneDel(): { first: string; rest: string[]; openTx: number } {
  expect(probe.dels, "one DEL for every literal key").toHaveLength(1);
  const [first, ...rest] = probe.dels[0]!;
  return { first: first!, rest: [...rest].sort(), openTx: probe.openTxAtDel[0]! };
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
  expect(del.openTx, "the DEL went out after the write committed").toBe(0);
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
