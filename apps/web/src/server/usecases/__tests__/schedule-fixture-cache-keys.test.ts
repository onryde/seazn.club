// R10d n2 — a REAL schedule write drops the public documents of the fixtures it
// changed, and pushes each of those fixtures only after that delete.
//
// The match centre and the overlay read `pub:v1:fixture:{id}` (`publicFixture`,
// usecases/public.ts), a 30s cache of a fixture's kick-off, venue and court. A
// schedule write used to drop the hub key alone, so a moved fixture showed its
// NEW slot on the hub and its OLD one on the match centre and the overlay.
//
// `hub-cache-invalidation.test.ts` pins `afterScheduleWrite` when handed a list.
// These cases pin that every real writer HANDS it the right list, driven
// through the use-case against Postgres: a single move names its fixture, an
// apply names the fixtures it assigned and no others, and publish and start
// (which move no single fixture) name the division's fixtures from their own
// transaction.
//
// `@/lib/cache` and `@/lib/realtime` are recording passthroughs: every public
// literal-key DEL is recorded and, when `probe.hold` is set, held open until
// the test releases it. Real Postgres required; skipped without DATABASE_URL.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  hold: false,
  dels: [] as string[][],
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

import { sql } from "@/lib/db";
import { applySchedule, moveFixture, publishSchedule, putScheduleSettings, startDivision } from "../schedule";
import { createCourt, createVenue } from "../venues";
import { divisionRig, seedOrg } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hubKey = (competitionId: string) => `pub:v1:hub:${competitionId}`;
const fixtureKey = (fixtureId: string) => `pub:v1:fixture:v2:${fixtureId}`;
/** The division's own public documents (schedule, standings, entrants), DEL'd
 *  by name in the same DEL since review r2-m4 replaced the keyspace SCAN.
 *  Spelled out, so a drift in the production spelling reds. */
const divisionKeys = (divisionId: string) => [
  `pub:v1:div:${divisionId}:schedule`,
  `pub:v1:div:${divisionId}:standings`,
  `pub:v1:div:${divisionId}:entrants-v2`,
];

/** Let a PREVIOUS write's DEL settle and its pushes land (the rig's own
 *  `startDivision` runs `afterScheduleWrite`), then clear the recorders. */
async function quiesce(): Promise<void> {
  probe.hold = false;
  for (const release of probe.gates.splice(0)) release();
  await sleep(20);
  probe.dels.length = 0;
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

async function fixtureIdsOf(divisionId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId}`;
  return rows.map((row) => row.id).sort();
}

/** The one DEL, split: its first key and the rest, sorted. */
function theOneDel(): { first: string; rest: string[] } {
  expect(probe.dels, "one DEL for every literal key").toHaveLength(1);
  const [first, ...rest] = probe.dels[0]!;
  return { first: first!, rest: [...rest].sort() };
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

describe.skipIf(!HAS_DB)("a real schedule write drops the fixture documents it changed, then pushes them (R10d n2)", () => {
  it("moveFixture: the moved fixture's key rides the hub key's one DEL, and its push waits for that DEL", async () => {
    const { auth } = await seedOrg();
    const rig = await divisionRig(auth, { entrants: 3 });
    const competitionId = await competitionOf(rig.divisionId);
    const [moved, ...untouched] = rig.fixtureIds;
    expect(untouched.length, "the division holds fixtures this move does not touch").toBeGreaterThan(0);
    await quiesce();

    probe.hold = true;
    const at = "2030-06-01T10:00:00.000Z";
    await moveFixture(auth, moved!, { scheduled_at: at });
    const [row] = await sql<{ scheduled_at: Date }[]>`select scheduled_at from fixtures where id = ${moved!}`;
    expect(new Date(row!.scheduled_at).toISOString(), "the move landed").toBe(at);

    expect(probe.dels).toEqual([[hubKey(competitionId), fixtureKey(moved!), ...divisionKeys(rig.divisionId)]]);
    await sleep(20);
    expect(probe.fixturePushes, "fixture push before the DEL settled").toEqual([]);
    expect(probe.divisionPushes, "division push before the DEL settled").toEqual([]);

    await releaseDel();
    expect(probe.fixturePushes).toEqual([[moved!, "schedule"]]);
    expect(probe.divisionPushes).toEqual([[rig.divisionId, "schedule"]]);
  }, 120_000);

  it("applySchedule: the fixtures the apply assigned, and ONLY those, then one push each after the DEL", async () => {
    const { auth } = await seedOrg();
    const rig = await divisionRig(auth, { entrants: 3, start: false });
    const competitionId = await competitionOf(rig.divisionId);
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    const at = "2030-06-01T09:00:00.000Z";
    await putScheduleSettings(auth, rig.divisionId, {
      config: {
        startAt: at,
        matchMinutes: 30,
        gapMinutes: 0,
        courts: [court.id],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
      tz: "UTC",
    });
    const [assigned, ...unassigned] = rig.fixtureIds;
    expect(unassigned.length, "the stage holds fixtures this apply does not assign").toBeGreaterThan(0);
    await quiesce();

    probe.hold = true;
    const out = await applySchedule(auth, rig.stages[0]!.stageId, {
      assignments: [{ fixture_id: assigned!, scheduled_at: at, court_id: court.id }],
      source: "ai",
    });
    expect(out.applied, "the apply landed").toBe(1);

    expect(probe.dels).toEqual([[hubKey(competitionId), fixtureKey(assigned!), ...divisionKeys(rig.divisionId)]]);
    await sleep(20);
    expect(probe.fixturePushes, "fixture push before the DEL settled").toEqual([]);

    await releaseDel();
    expect(probe.fixturePushes).toEqual([[assigned!, "schedule"]]);
    expect(probe.divisionPushes).toEqual([[rig.divisionId, "schedule"]]);
  }, 120_000);

  it("publishSchedule: every fixture of the division, from the write's own transaction, then one push each after the DEL", async () => {
    const { auth } = await seedOrg();
    const rig = await divisionRig(auth, { entrants: 3, start: false });
    const competitionId = await competitionOf(rig.divisionId);
    const all = await fixtureIdsOf(rig.divisionId);
    // #850: three matches AND three settled rest-bye rows — every one of them
    // has a public document, so the publish/start DEL below names all six.
    expect(all.length, "the rig's division holds three matches and three bye rows").toBe(6);
    await quiesce();

    probe.hold = true;
    const out = await publishSchedule(auth, rig.divisionId);
    expect(out.published, "the publish landed").toBe(true);

    const del = theOneDel();
    expect(del.first).toBe(hubKey(competitionId));
    expect(del.rest).toEqual([...all.map(fixtureKey), ...divisionKeys(rig.divisionId)].sort());
    await sleep(20);
    expect(probe.fixturePushes, "fixture push before the DEL settled").toEqual([]);

    await releaseDel();
    expect(probe.fixturePushes.map(([id]) => id).sort()).toEqual(all);
    expect(new Set(probe.fixturePushes.map(([, reason]) => reason))).toEqual(new Set(["schedule"]));
    expect(probe.divisionPushes).toEqual([[rig.divisionId, "publish"]]);
  }, 120_000);

  it("startDivision: every fixture of the division, from the write's own transaction, then one push each after the DEL", async () => {
    const { auth } = await seedOrg();
    const rig = await divisionRig(auth, { entrants: 3, start: false });
    const competitionId = await competitionOf(rig.divisionId);
    const all = await fixtureIdsOf(rig.divisionId);
    // #850: three matches AND three settled rest-bye rows — every one of them
    // has a public document, so the publish/start DEL below names all six.
    expect(all.length, "the rig's division holds three matches and three bye rows").toBe(6);
    await quiesce();

    probe.hold = true;
    const out = await startDivision(auth, rig.divisionId);
    expect(out.started, "the start landed").toBe(true);

    const del = theOneDel();
    expect(del.first).toBe(hubKey(competitionId));
    expect(del.rest).toEqual([...all.map(fixtureKey), ...divisionKeys(rig.divisionId)].sort());
    await sleep(20);
    expect(probe.fixturePushes, "fixture push before the DEL settled").toEqual([]);

    await releaseDel();
    expect(probe.fixturePushes.map(([id]) => id).sort()).toEqual(all);
    expect(new Set(probe.fixturePushes.map(([, reason]) => reason))).toEqual(new Set(["schedule"]));
    expect(probe.divisionPushes).toEqual([[rig.divisionId, "start"]]);
  }, 120_000);
});
