// Quick match plan 1, Task 3: `startDivisionInTx` — the body of `startDivision`'s
// status transaction, taking the CALLER's transaction so a guest quick match can
// create its league/knockout and start it in one commit (plan 1 Task 5).
//
// What this file pins is the seam, not the start rules (those stay pinned
// through `startDivision` by schedule*.test.ts / start-division-*.test.ts):
//   * it starts a division on the caller's `tx` (status, event, fixture ids);
//   * it writes NOTHING of its own — a caller that throws after it rolls back
//     the status, the `division_started` / `schedule_published` events and the
//     competition promotion together (pre-flight B3);
//   * a second call on an already-active division is the no-op it always was;
//   * `firstStageId` is the stage the rolling quick-start times are written to,
//     and no other stage is;
//   * it refuses its own preconditions (house rule: assumptions are guards) —
//     an invisible division (404), a completed one (422), a `firstStageId` that
//     is not the division's first stage (422 START_STAGE_MISMATCH).
//
// Generic sport only: the transaction body has no sport branch (sport rules live
// in the generator and the engine, both upstream of this function).
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { sql, withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { putScheduleSettings, startDivisionInTx } from "../schedule";
import { GENERIC_CONFIG, seedCourts, seedOrg } from "./_seed";

// No organiser analytics leave a test run (the seed's create path fires them).
vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn().mockResolvedValue(undefined) }));

const HAS_DB = !!process.env.DATABASE_URL;

/** A generic league division with `count` entrants and its fixtures generated
 *  (so the start generates nothing). Copied from add-fixture.test.ts's
 *  `seedDivision` + `createStages` + `generateStageFixtures`. Names carry a
 *  random tag — the local DB is shared with parallel agents. */
async function seedLeagueDivision(
  auth: AuthCtx,
  count: number,
): Promise<{ id: string; stageId: string; competitionId: string }> {
  const tag = randomUUID().slice(0, 8);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `QM T3 ${tag}`,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: `qm-t3-${tag}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: count }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
    progression: null,
  });
  await generateStageFixtures(auth, stage!.id);
  return { id: division.id, stageId: stage!.id, competitionId: comp.id };
}

/** A SECOND stage of the division with two unscheduled fixtures, in rounds 1
 *  and 2 — the same round numbers as the first stage's, so a rolling-times write
 *  keyed on the division (not the stage) would reach them. Inserted directly: a
 *  generated second stage would need the first one played out. */
async function addSecondStage(auth: AuthCtx, divisionId: string): Promise<string> {
  const [stage] = await createStages(auth, divisionId, {
    seq: 2,
    kind: "league",
    name: "Second",
    config: {},
    progression: null,
  });
  const entrants = await sql<{ id: string }[]>`
    select id from entrants where division_id = ${divisionId} order by seed`;
  for (const round of [1, 2]) {
    await sql`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key,
                            status, home_entrant_id, away_entrant_id)
      values (${stage!.id}, ${divisionId}, ${auth.orgId}, ${round}, 0, ${"s2-r" + round},
              'scheduled', ${entrants[0]!.id}, ${entrants[1]!.id})`;
  }
  return stage!.id;
}

async function divisionStatus(auth: AuthCtx, divisionId: string): Promise<string> {
  const [row] = await withTenant(auth.orgId, (tx) => tx<{ status: string }[]>`
    select status from divisions where id = ${divisionId}`);
  return row!.status;
}

/** `division_events` rows of `type` (V220: the column is `type`). */
async function eventCount(auth: AuthCtx, divisionId: string, type: string): Promise<number> {
  const rows = await withTenant(auth.orgId, (tx) => tx`
    select 1 from division_events where division_id = ${divisionId} and type = ${type}`);
  return rows.length;
}

async function competitionStatus(auth: AuthCtx, divisionId: string): Promise<string> {
  const [row] = await withTenant(auth.orgId, (tx) => tx<{ status: string }[]>`
    select c.status from competitions c join divisions d on d.competition_id = c.id where d.id = ${divisionId}`);
  return row!.status;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("startDivisionInTx", () => {
  it("starts a generated league division inside the caller's transaction", async () => {
    const { auth } = await seedOrg();
    const div = await seedLeagueDivision(auth, 3);
    const divisionFixtureIds = (
      await sql<{ id: string }[]>`select id from fixtures where division_id = ${div.id}`
    ).map((f) => f.id);
    // A 3-entrant round robin plays C(3,2) = 3 matches.
    expect(divisionFixtureIds).toHaveLength(3);

    const out = await withTenant(auth.orgId, (tx) => startDivisionInTx(tx, auth, div.id, div.stageId, {}));

    expect(out.started).toBe(true);
    expect(out.fixtureIds).toHaveLength(3);
    expect([...out.fixtureIds].sort()).toEqual([...divisionFixtureIds].sort());
    expect(await divisionStatus(auth, div.id)).toBe("active");
    expect(await eventCount(auth, div.id, "division_started")).toBe(1);
    // Started from `setup`: the schedule is published on the way through.
    expect(await eventCount(auth, div.id, "schedule_published")).toBe(1);
  });

  it("rolls back with the caller: no status, no event, no promotion (pre-flight B3)", async () => {
    const { auth } = await seedOrg();
    const div = await seedLeagueDivision(auth, 3);
    // `published`, so the start WOULD promote it to `live` — without this the
    // "no promotion" half is vacuous (a fresh competition is `draft`, which a
    // start never promotes).
    await sql`update competitions set status = 'published' where id = ${div.competitionId}`;
    const before = await competitionStatus(auth, div.id);
    expect(before).toBe("published");

    await expect(
      withTenant(auth.orgId, async (tx) => {
        const out = await startDivisionInTx(tx, auth, div.id, div.stageId, {});
        expect(out.started).toBe(true); // it did run, inside this transaction
        expect(out.competitionPromoted).toBe(true); // and did promote, inside it
        throw new Error("the caller failed after the start");
      }),
    ).rejects.toThrow("the caller failed after the start");

    expect(await divisionStatus(auth, div.id)).toBe("setup");
    expect(await eventCount(auth, div.id, "division_started")).toBe(0);
    expect(await eventCount(auth, div.id, "schedule_published")).toBe(0);
    expect(await competitionStatus(auth, div.id)).toBe(before);
  });

  it("a second call on the started division is a no-op: started false, no second event, no promotion", async () => {
    const { auth } = await seedOrg();
    const div = await seedLeagueDivision(auth, 3);
    await sql`update competitions set status = 'published' where id = ${div.competitionId}`;
    const first = await withTenant(auth.orgId, (tx) => startDivisionInTx(tx, auth, div.id, div.stageId, {}));
    expect(first).toMatchObject({ started: true, competitionPromoted: true });

    const second = await withTenant(auth.orgId, (tx) => startDivisionInTx(tx, auth, div.id, div.stageId, {}));

    expect(second.started).toBe(false);
    expect(second.competitionPromoted).toBe(false);
    // The early return still names every fixture (the caller drops their keys).
    expect([...second.fixtureIds].sort()).toEqual([...first.fixtureIds].sort());
    expect(second.fixtureIds).toHaveLength(3);
    expect(await eventCount(auth, div.id, "division_started")).toBe(1);
    expect(await eventCount(auth, div.id, "schedule_published")).toBe(1);
    expect(await divisionStatus(auth, div.id)).toBe("active");
  });

  it("writes the rolling quick-start times to the stage named by firstStageId (doc 12 §1.A), and to no other stage", async () => {
    const { auth } = await seedOrg();
    const div = await seedLeagueDivision(auth, 3);
    const secondStageId = await addSecondStage(auth, div.id);
    const [court] = await seedCourts(auth.orgId, 1);
    const T0 = "2026-08-01T09:00:00.000Z";
    const ROUND_MINUTES = 60;
    await putScheduleSettings(auth, div.id, {
      config: {
        startAt: T0, matchMinutes: 25, gapMinutes: 0,
        courts: [court!], perEntrantMinRest: 0, blackouts: [], sessionWindows: [],
        roundMinutes: ROUND_MINUTES,
      },
      tz: "UTC",
    });
    const unslotted = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures where stage_id = ${div.stageId} and scheduled_at is null`;
    expect(unslotted[0]!.n).toBe(3);

    const out = await withTenant(auth.orgId, (tx) => startDivisionInTx(tx, auth, div.id, div.stageId, {}));
    expect(out.started).toBe(true);

    const rows = await sql<{ round_no: number; scheduled_at: Date | null }[]>`
      select round_no, scheduled_at from fixtures where stage_id = ${div.stageId} order by round_no`;
    expect(rows).toHaveLength(3);
    // Rolling (doc 12 §1.A): round r starts at startAt + (r−1)·roundMinutes.
    for (const r of rows) {
      expect(r.scheduled_at?.toISOString()).toBe(
        new Date(Date.parse(T0) + (r.round_no - 1) * ROUND_MINUTES * 60_000).toISOString(),
      );
    }
    // The second stage is not the first stage: its rounds 1 and 2 share round
    // numbers with the slotted ones and must still be unscheduled.
    const second = await sql<{ round_no: number; scheduled_at: Date | null }[]>`
      select round_no, scheduled_at from fixtures where stage_id = ${secondStageId} order by round_no`;
    expect(second.map((r) => r.round_no)).toEqual([1, 2]);
    for (const r of second) expect(r.scheduled_at).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Its own preconditions (house rule: assumptions are guards). `startDivision`'s
  // pre-flight refuses the first two before this function is reached; these pin
  // the refusals for a caller that has no such pre-flight (the quick match).
  // ---------------------------------------------------------------------------

  it("refuses a division the caller cannot see (another org's) with 404, and leaves it untouched", async () => {
    const { auth: owner } = await seedOrg();
    const div = await seedLeagueDivision(owner, 3);
    const { auth: stranger } = await seedOrg();

    await expect(
      withTenant(stranger.orgId, (tx) => startDivisionInTx(tx, stranger, div.id, div.stageId, {})),
    ).rejects.toMatchObject({ status: 404, message: "division not found" });

    expect(await divisionStatus(owner, div.id)).toBe("setup");
    expect(await eventCount(owner, div.id, "division_started")).toBe(0);
  });

  it("refuses a completed division with 422, and does not reopen it", async () => {
    const { auth } = await seedOrg();
    const div = await seedLeagueDivision(auth, 3);
    await sql`update divisions set status = 'completed' where id = ${div.id}`;

    await expect(
      withTenant(auth.orgId, (tx) => startDivisionInTx(tx, auth, div.id, div.stageId, {})),
    ).rejects.toMatchObject({ status: 422, message: "division is completed" });

    expect(await divisionStatus(auth, div.id)).toBe("completed");
    expect(await eventCount(auth, div.id, "division_started")).toBe(0);
    expect(await eventCount(auth, div.id, "schedule_published")).toBe(0);
  });

  it("refuses a firstStageId that is not the division's first stage (422 START_STAGE_MISMATCH)", async () => {
    const { auth } = await seedOrg();
    const div = await seedLeagueDivision(auth, 3);
    const secondStageId = await addSecondStage(auth, div.id);
    const other = await seedLeagueDivision(auth, 3);
    // Its own second stage, and another division's first stage.
    const wrong = [secondStageId, other.stageId];

    for (const stageId of wrong) {
      await expect(
        withTenant(auth.orgId, (tx) => startDivisionInTx(tx, auth, div.id, stageId, {})),
      ).rejects.toMatchObject({ status: 422, code: "START_STAGE_MISMATCH" });
    }
    expect(wrong).toHaveLength(2);
    expect(await divisionStatus(auth, div.id)).toBe("setup");
    expect(await eventCount(auth, div.id, "division_started")).toBe(0);
    expect(await eventCount(auth, div.id, "schedule_published")).toBe(0);
  });
});
