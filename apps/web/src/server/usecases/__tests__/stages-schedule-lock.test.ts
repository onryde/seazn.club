// A frozen division (`divisions.schedule_locked`) refuses every board write —
// and `usecases/stages.ts` had NO division-freeze awareness at all. Four
// organiser-reachable write paths in that file went through a frozen board
// unrefused, each behind the same `requireResourceAuth(..., "write")` as the
// routes that DO refuse:
//
//   generateStageFixtures  POST /api/v1/stages/{id}/generate   writes the timetable
//   rebuildStageFixtures   POST /api/v1/stages/{id}/rebuild    HARD-DELETES every fixture
//   addFixture             POST /api/v1/stages/{id}/fixtures   inserts scheduled_at + court_id
//   deleteStage            DELETE /api/v1/stages/{id}          takes the stage and its board
//
// DO NOT be misled by `stages.ts`'s own `schedule_locked` matches: every one
// of them is `fixtures.schedule_locked`, the PER-FIXTURE pin, in a select list
// or a row type. Different column, different table, same name.
//
// THREE cases per path, never two. Frozen-refuses plus a missing-row 404
// cannot tell a correct guard from one that refuses everything; frozen-refuses
// plus unfrozen-succeeds cannot tell a correctly-placed guard from one that
// sits ABOVE the existence check and turns every unknown id into a 422
// (`divisionLockState` reads `frozen: row?.schedule_locked ?? false`, so a
// missing row reads as UNFROZEN and would sail through a guard placed there —
// which is exactly why the third case is a 404 assertion and not a 422 one).
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { sql } from "@/lib/db";
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { log } from "@/server/logger";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { setDivisionLocks } from "../history";
import {
  addFixture,
  completeStage,
  createStages,
  deleteStage,
  generateStageFixtures,
  issueChallenge,
  rebuildStageFixtures,
} from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterEach(() => {
  // `log` is a module-level SINGLETON, and vitest does not reset a spy on it
  // between tests in one file. Without this, the "was it logged?" assertions
  // below can be satisfied by an EARLIER test's call — the assertion goes
  // green while the code under test did nothing.
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface Board {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  entrants: string[];
}

/** A division with four entrants and one league stage. `generate` decides
 *  whether the stage's fixtures already exist — `generateStageFixtures` needs
 *  an EMPTY stage to have a timetable to write, `rebuild`/`addFixture` need a
 *  populated one. */
async function seedBoard(generate: boolean): Promise<Board> {
  const { auth } = await seedOrg();
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Lock " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    ["A", "B", "C", "D"].map((display_name, i) => ({
      kind: "individual" as const,
      display_name,
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
  if (generate) await generateStageFixtures(auth, stage!.id);
  return {
    auth,
    divisionId: division.id,
    stageId: stage!.id,
    entrants: entrants.map((e) => e.id),
  };
}

const freeze = (auth: AuthCtx, divisionId: string, on: boolean): Promise<unknown> =>
  setDivisionLocks(auth, divisionId, { schedule_locked: on });

async function fixtureCount(divisionId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from fixtures where division_id = ${divisionId}`;
  return row!.n;
}

async function stageExists(stageId: string): Promise<boolean> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from stages where id = ${stageId}`;
  return row!.n === 1;
}

/** Both halves of the refusal in one place: `message` is not an own enumerable
 *  property of an Error, so `toMatchObject` cannot see it and needs its own
 *  matcher — the pattern schedule-start-gate.test.ts established. */
async function expectScheduleLocked(run: () => Promise<unknown>): Promise<void> {
  await expect(run()).rejects.toMatchObject({ status: 422, code: SCHEDULE_LOCKED_CODE });
  await expect(run()).rejects.toThrow(SCHEDULE_LOCKED_MESSAGE);
}

describe.skipIf(!HAS_DB)("a frozen division refuses stages.ts's write paths", () => {
  // -------------------------------------------------------------------------
  // generateStageFixtures — POST /api/v1/stages/{id}/generate
  // -------------------------------------------------------------------------
  // The Critical. `startDivision` guards its OWN call to this
  // (`schedule.ts:3666`), but the route bypasses `startDivision` entirely, so
  // an organiser could write a whole timetable onto a frozen board by pressing
  // Generate instead of Start — the same walk-around shape as #230 item 2.
  describe("generateStageFixtures", () => {
    it("frozen + an empty stage → 422 SCHEDULE_LOCKED, and writes no timetable", async () => {
      const board = await seedBoard(false);
      expect(await fixtureCount(board.divisionId)).toBe(0);
      await freeze(board.auth, board.divisionId, true);

      await expectScheduleLocked(() => generateStageFixtures(board.auth, board.stageId));
      expect(await fixtureCount(board.divisionId)).toBe(0);
    }, 120_000);

    it("unfrozen + the same stage → still generates", async () => {
      const board = await seedBoard(false);
      const out = await generateStageFixtures(board.auth, board.stageId);
      expect(out.created).toBeGreaterThan(0);
      expect(await fixtureCount(board.divisionId)).toBe(out.created);
    }, 120_000);

    it("an unknown stage id → still 404, never the freeze refusal", async () => {
      const board = await seedBoard(false);
      await freeze(board.auth, board.divisionId, true);
      await expect(generateStageFixtures(board.auth, randomUUID())).rejects.toMatchObject({
        status: 404,
      });
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  // rebuildStageFixtures — POST /api/v1/stages/{id}/rebuild
  // -------------------------------------------------------------------------
  // Strictly wider than the `clearScheduleScoped` the freeze already refuses:
  // this HARD-DELETES every fixture on the stage (cascading into lineups,
  // fixture_officials and device_links) and regenerates. Its delete commits in
  // its OWN transaction before `generateStageFixtures` runs, so the guard has
  // to sit ahead of the delete — a guard that only lived on the generator
  // would let the delete commit and then refuse, leaving the organiser with an
  // empty frozen board. That is what `fixtureCount` pins below.
  describe("rebuildStageFixtures", () => {
    it("frozen + a populated stage → 422 SCHEDULE_LOCKED, and the fixtures survive", async () => {
      const board = await seedBoard(true);
      const before = await fixtureCount(board.divisionId);
      expect(before).toBeGreaterThan(0);
      await freeze(board.auth, board.divisionId, true);

      await expectScheduleLocked(() => rebuildStageFixtures(board.auth, board.stageId));
      expect(await fixtureCount(board.divisionId)).toBe(before);
    }, 120_000);

    it("unfrozen + the same stage → still rebuilds", async () => {
      const board = await seedBoard(true);
      const before = await fixtureCount(board.divisionId);
      const out = await rebuildStageFixtures(board.auth, board.stageId);
      expect(out.removed).toBe(before);
      expect(out.created).toBe(before);
      expect(await fixtureCount(board.divisionId)).toBe(before);
    }, 120_000);

    it("an unknown stage id → still 404, never the freeze refusal", async () => {
      const board = await seedBoard(true);
      await freeze(board.auth, board.divisionId, true);
      await expect(rebuildStageFixtures(board.auth, randomUUID())).rejects.toMatchObject({
        status: 404,
      });
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  // addFixture — POST /api/v1/stages/{id}/fixtures
  // -------------------------------------------------------------------------
  // Inserts a fixture carrying client-supplied `scheduled_at` and `court_id`:
  // a timetable write by any other name, and one the freeze exists to stop.
  describe("addFixture", () => {
    const body = (board: Board) => ({
      home_entrant_id: board.entrants[0]!,
      away_entrant_id: board.entrants[1]!,
      scheduled_at: "2030-06-01T10:00:00.000Z",
    });

    it("frozen → 422 SCHEDULE_LOCKED, and inserts nothing", async () => {
      const board = await seedBoard(true);
      const before = await fixtureCount(board.divisionId);
      await freeze(board.auth, board.divisionId, true);

      await expectScheduleLocked(() => addFixture(board.auth, board.stageId, body(board)));
      expect(await fixtureCount(board.divisionId)).toBe(before);
    }, 120_000);

    it("unfrozen → still inserts the ad-hoc fixture", async () => {
      const board = await seedBoard(true);
      const before = await fixtureCount(board.divisionId);
      const out = await addFixture(board.auth, board.stageId, body(board));
      expect(out.fixture_id).toBeTruthy();
      expect(await fixtureCount(board.divisionId)).toBe(before + 1);
    }, 120_000);

    it("an unknown stage id → still 404, never the freeze refusal", async () => {
      const board = await seedBoard(true);
      await freeze(board.auth, board.divisionId, true);
      await expect(addFixture(board.auth, randomUUID(), body(board))).rejects.toMatchObject({
        status: 404,
      });
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  // deleteStage — DELETE /api/v1/stages/{id}
  // -------------------------------------------------------------------------
  // Carried only the BILLING freeze (`assertNotFrozen`, entitlement-freeze.ts)
  // — a THIRD unrelated meaning of "frozen" in this repo. Deleting a stage
  // takes its pools, fixtures and snapshots with it via ON DELETE CASCADE,
  // which is the widest board write of the four.
  describe("deleteStage", () => {
    it("frozen → 422 SCHEDULE_LOCKED, and the stage survives", async () => {
      const board = await seedBoard(false);
      await freeze(board.auth, board.divisionId, true);

      await expectScheduleLocked(() => deleteStage(board.auth, board.stageId));
      expect(await stageExists(board.stageId)).toBe(true);
    }, 120_000);

    it("unfrozen → still deletes", async () => {
      const board = await seedBoard(false);
      await expect(deleteStage(board.auth, board.stageId)).resolves.toEqual({ deleted: true });
      expect(await stageExists(board.stageId)).toBe(false);
    }, 120_000);

    it("an unknown stage id → still 404, never the freeze refusal", async () => {
      const board = await seedBoard(false);
      await freeze(board.auth, board.divisionId, true);
      await expect(deleteStage(board.auth, randomUUID())).rejects.toMatchObject({ status: 404 });
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  // completeStage — the FIFTH caller of the generator, found while guarding it
  // -------------------------------------------------------------------------
  // `completeStage` (stages.ts, the `timing: "on_complete"` branch) calls
  // `generateStageFixtures` for the stage it just seeded — a whole stage's
  // timetable written onto the board through a THIRD door, and the one caller
  // of the generator that was NOT already refusing a frozen division
  // (`startDivision` and history's undo/redo both throw 422 before their own
  // calls; `rebuildStageFixtures` now does too).
  //
  // The new guard closes it, and this is what that looks like from outside.
  // The generate call sits inside `completeStage`'s deliberate best-effort
  // `try { … } catch { generated = undefined }` — "completion stands even if
  // generation trips (e.g. paywall)" — so the refusal does NOT surface as an
  // error. Completion itself still succeeds, which is the design's own line
  // (the freeze binds schedule EDITS, not lifecycle TRANSITIONS — see
  // schedule-start-gate.test.ts on `startDivision`), and the next stage simply
  // does not get a timetable written onto a frozen board.
  //
  // Pinned here rather than left to be rediscovered: it is a behaviour CHANGE,
  // it is silent, and the silence is what makes it worth a test. Whether
  // completion should instead SURFACE the refusal is an owner question, not a
  // guess to make in a guard — see the wave report.
  describe("completeStage's auto-generation of the next stage (behaviour change)", () => {
    /** Groups -> knockout with an `on_complete` progression: completing the
     *  group stage seeds the KO stage and generates its bracket. Four
     *  entrants, two pools of two — one fixture per pool, three in the KO. */
    async function seedGroupsToKo(): Promise<{ auth: AuthCtx; divisionId: string; groupId: string; koId: string }> {
      const { auth } = await seedOrg();
      const comp = await createCompetition(auth, {
        ends_on: "2030-12-31",
        name: "Lock " + randomUUID().slice(0, 6),
        visibility: "private",
        branding: {},
      });
      const division = await createDivision(auth, comp.id, {
        name: "Open",
        slug: "open-" + randomUUID().slice(0, 6),
        sport_key: "generic",
        variant_key: "score",
        config: GENERIC_CONFIG,
      });
      await createEntrants(
        auth,
        division.id,
        ["A", "B", "C", "D"].map((display_name, i) => ({
          kind: "individual" as const,
          display_name,
          seed: i + 1,
          members: [],
        })),
      );
      const stages = await createStages(auth, division.id, [
        { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
        {
          seq: 2,
          kind: "knockout",
          name: "KO",
          config: {},
          progression: {
            sources: [
              {
                stage: "previous",
                take: [
                  {
                    kind: "picks",
                    picks: [
                      { pool: "A", rank: 1 },
                      { pool: "B", rank: 2 },
                      { pool: "B", rank: 1 },
                      { pool: "A", rank: 2 },
                    ],
                  },
                ],
              },
            ],
            placement: "rank_order",
            timing: "on_complete",
          },
        },
      ]);
      const groupId = stages.find((s) => s.kind === "group")!.id;
      const koId = stages.find((s) => s.kind === "knockout")!.id;
      await generateStageFixtures(auth, groupId);
      const fixtures = await sql<{ id: string }[]>`
        select id from fixtures where stage_id = ${groupId} order by id`;
      for (const f of fixtures) {
        await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
        await appendEvent(auth.orgId, f.id, 1, {
          type: "generic.result",
          payload: { p1Score: 2, p2Score: 0 },
        });
      }
      return { auth, divisionId: division.id, groupId, koId };
    }

    async function stageFixtureCount(stageId: string): Promise<number> {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from fixtures where stage_id = ${stageId}`;
      return row!.n;
    }

    it("unfrozen → completion seeds the next stage AND generates its bracket", async () => {
      const board = await seedGroupsToKo();
      const done = await completeStage(board.auth, board.groupId);
      expect(done.completed).toBe(true);
      expect(done.qualified?.stage_id).toBe(board.koId);
      expect(done.next_stage_fixtures).toBeGreaterThan(0);
      expect(await stageFixtureCount(board.koId)).toBe(done.next_stage_fixtures);
    }, 120_000);

    it("frozen → completion STILL succeeds, but writes no timetable onto the frozen board", async () => {
      const board = await seedGroupsToKo();
      await freeze(board.auth, board.divisionId, true);

      const done = await completeStage(board.auth, board.groupId);
      // The lifecycle transition is not what a freeze binds.
      expect(done.completed).toBe(true);
      expect(done.qualified?.stage_id).toBe(board.koId);
      // The schedule write is. `next_stage_fixtures` is absent rather than 0:
      // the generator threw and `completeStage`'s best-effort catch left
      // `generated` undefined, so the key is omitted entirely.
      expect(done.next_stage_fixtures).toBeUndefined();
      expect(await stageFixtureCount(board.koId)).toBe(0);

      // And it really was available to be written — unfreeze, generate, and
      // the same bracket appears. Without this the test above could not tell
      // a freeze refusal from a progression that never resolved.
      await freeze(board.auth, board.divisionId, false);
      const gen = await generateStageFixtures(board.auth, board.koId);
      expect(gen.created).toBeGreaterThan(0);
      expect(await stageFixtureCount(board.koId)).toBe(gen.created);
    }, 120_000);

    // The catch that swallows this refusal is a BARE `catch { generated =
    // undefined; }` — it swallows every cause equally and logs nothing at all,
    // so a genuine generator fault (a bad bracket, a DB error) has always been
    // exactly as invisible as this freeze refusal. The freeze did not create
    // that hole, it revealed it. These two tests pin the fix: the catch still
    // swallows (a completion that already committed must not be undone by a
    // paywalled or frozen next stage) but it no longer swallows SILENTLY, and
    // what it logs NAMES the error rather than merely saying "frozen".
    it("frozen → the swallowed refusal is logged, naming the error it swallowed", async () => {
      const board = await seedGroupsToKo();
      await freeze(board.auth, board.divisionId, true);
      const warn = vi.spyOn(log, "warn").mockImplementation((() => undefined) as never);

      const done = await completeStage(board.auth, board.groupId);
      expect(done.completed).toBe(true);
      expect(done.next_stage_fixtures).toBeUndefined();

      const skipped = warn.mock.calls.filter(
        (c) => (c[0] as { event?: string } | undefined)?.event === "next_stage_generate_skipped",
      );
      expect(skipped).toHaveLength(1);
      const payload = skipped[0]![0] as Record<string, unknown>;
      expect(payload.nextStageId).toBe(board.koId);
      expect(payload.code).toBe(SCHEDULE_LOCKED_CODE);
      expect(payload.locked).toBe(true);
      // The whole point: the swallowed ERROR is in the record, so a real fault
      // reaching this catch is as legible as this refusal is.
      expect(String(payload.err)).toContain(SCHEDULE_LOCKED_MESSAGE);
    }, 120_000);

    it("unfrozen → nothing is logged as skipped, because nothing was swallowed", async () => {
      const board = await seedGroupsToKo();
      const warn = vi.spyOn(log, "warn").mockImplementation((() => undefined) as never);

      const done = await completeStage(board.auth, board.groupId);
      expect(done.next_stage_fixtures).toBeGreaterThan(0);
      expect(
        warn.mock.calls.filter(
          (c) => (c[0] as { event?: string } | undefined)?.event === "next_stage_generate_skipped",
        ),
      ).toHaveLength(0);
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  // issueChallenge — POST /api/v1/stages/{id}/challenges
  // -------------------------------------------------------------------------
  // A ladder has no pre-generated timetable — fixtures are created on demand,
  // one per challenge — but a challenge still INSERTS a fixture onto the
  // division's board (and initialises `stage.config.ladder_order` on first
  // use), at the same `requireResourceAuth(..., "write")` as the four above.
  // Same class, same refusal.
  describe("issueChallenge", () => {
    async function seedLadder(): Promise<{
      auth: AuthCtx;
      divisionId: string;
      stageId: string;
      entrants: string[];
    }> {
      const { auth } = await seedOrg();
      const comp = await createCompetition(auth, {
        ends_on: "2030-12-31",
        name: "Lock " + randomUUID().slice(0, 6),
        visibility: "private",
        branding: {},
      });
      const division = await createDivision(auth, comp.id, {
        name: "Open",
        slug: "open-" + randomUUID().slice(0, 6),
        sport_key: "generic",
        variant_key: "score",
        config: GENERIC_CONFIG,
      });
      const entrants = await createEntrants(
        auth,
        division.id,
        ["L1", "L2", "L3", "L4"].map((display_name, i) => ({
          kind: "individual" as const,
          display_name,
          seed: i + 1,
          members: [],
        })),
      );
      const [ladder] = await createStages(auth, division.id, [
        { seq: 1, kind: "ladder" as never, name: "Ladder", config: { challengeRange: 3 } },
      ]);
      return {
        auth,
        divisionId: division.id,
        stageId: ladder!.id,
        entrants: entrants.map((e) => e.id),
      };
    }

    /** L3 (position 3) challenges L1 (position 1) — two places up, inside the
     *  stage's `challengeRange: 3`, so nothing but the freeze can refuse it. */
    const challenge = (board: { entrants: string[] }) => ({
      challenger_id: board.entrants[2]!,
      opponent_id: board.entrants[0]!,
    });

    it("frozen → 422 SCHEDULE_LOCKED, and inserts no fixture", async () => {
      const board = await seedLadder();
      const before = await fixtureCount(board.divisionId);
      await freeze(board.auth, board.divisionId, true);

      await expectScheduleLocked(() => issueChallenge(board.auth, board.stageId, challenge(board)));
      expect(await fixtureCount(board.divisionId)).toBe(before);
    }, 120_000);

    it("unfrozen → still creates the challenge fixture", async () => {
      const board = await seedLadder();
      const before = await fixtureCount(board.divisionId);
      const out = await issueChallenge(board.auth, board.stageId, challenge(board));
      expect(out.fixture_id).toBeTruthy();
      expect(out.ladder_order).toHaveLength(4);
      expect(await fixtureCount(board.divisionId)).toBe(before + 1);
    }, 120_000);

    it("an unknown stage id → still 404, never the freeze refusal", async () => {
      const board = await seedLadder();
      await freeze(board.auth, board.divisionId, true);
      await expect(
        issueChallenge(board.auth, randomUUID(), challenge(board)),
      ).rejects.toMatchObject({ status: 404 });
    }, 120_000);
  });
});
