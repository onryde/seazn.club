// F3 Task 5 (5a/5b, 2026-08-18 plan) — real Postgres, full usecase pipeline.
// Skipped without DATABASE_URL (same convention as the sibling
// stage-orphan-fixtures.test.ts).
//
// The premise this pins (plan's "Corrected premise"): generateStageFixtures
// is additive only, so a withdrawn entrant's name never comes off a
// generated board on its own. getStageRosterDrift derives the mismatch
// (never stores it); rebuildStageFixtures is the one path that can actually
// fix it, refusing outright the moment any fixture already carries a real
// result.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { startDivision } from "../schedule";
import {
  createStages,
  generateStageFixtures,
  getStageRosterDrift,
  rebuildStageFixtures,
} from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** A fresh division with N seeded individual entrants (E1..EN) and no stages
 *  yet — the caller defines the stage graph itself, since the eligible-kind
 *  tests (league) and the ineligible-kind test (group -> setup-timing KO)
 *  need different graphs. */
async function seedDivision(auth: AuthCtx, names: string[]): Promise<{ divisionId: string; entrantByName: Map<string, string> }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Drift " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    names.map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })),
  );
  const entrantByName = new Map(entrants.map((e) => [e.display_name, e.id]));
  return { divisionId: division.id, entrantByName };
}

/** Decide a fixture (core.start then generic.result), so its DB status
 *  becomes 'decided' with a real outcome — mirrors stage-progression.test
 *  .ts's decideAllGroupFixtures, inlined for a single fixture. */
async function decideFixture(auth: AuthCtx, fixtureId: string): Promise<void> {
  await appendEvent(auth.orgId, fixtureId, 0, { type: "core.start", payload: {} });
  await appendEvent(auth.orgId, fixtureId, 1, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
}

describe.skipIf(!HAS_DB)("F3 Task 5 (5a) — getStageRosterDrift", () => {
  it("reports both directions: a withdrawn entrant still referenced (ghost), and a newly active entrant referenced by nothing (unplaced)", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrantByName } = await seedDivision(auth, ["A", "B", "C"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "L", config: {}, progression: null,
    });
    await generateStageFixtures(auth, stage!.id);

    // B and C stay active and referenced — the negative case: neither may
    // appear in either list.
    await patchEntrant(auth, entrantByName.get("A")!, { status: "withdrawn" });
    const added = await createEntrants(auth, divisionId, [
      { kind: "individual", display_name: "D", seed: 4, members: [] },
    ]);

    const drift = await getStageRosterDrift(auth, stage!.id);
    expect(drift.ghosts.map((e) => e.id)).toEqual([entrantByName.get("A")]);
    expect(drift.unplaced.map((e) => e.id)).toEqual([added[0]!.id]);
    const allNames = [...drift.ghosts, ...drift.unplaced].map((e) => e.display_name);
    expect(allNames).not.toContain("B");
    expect(allNames).not.toContain("C");
  });

  it("a withdrawn entrant referenced by a fixture that ALREADY HAS A RESULT is still reported as a ghost", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrantByName } = await seedDivision(auth, ["A", "B"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "L", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await startDivision(auth, divisionId);
    await decideFixture(auth, fixtures[0]!.id);

    const [decided] = await sql<{ status: string }[]>`select status from fixtures where id = ${fixtures[0]!.id}`;
    expect(decided!.status).toBe("decided");

    await patchEntrant(auth, entrantByName.get("A")!, { status: "withdrawn" });

    const drift = await getStageRosterDrift(auth, stage!.id);
    expect(drift.ghosts.map((e) => e.id)).toEqual([entrantByName.get("A")]);
  });

  it("a stage with a progression source (not the root) reports no drift at all", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const stages = await createStages(auth, divisionId, [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
      {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ]);
    const koStage = stages.find((s) => s.kind === "knockout")!;
    await generateStageFixtures(auth, koStage.id); // TBD placeholders, no entrant refs

    const drift = await getStageRosterDrift(auth, koStage.id);
    expect(drift).toEqual({ ghosts: [], unplaced: [] });
  });
});

describe.skipIf(!HAS_DB)("F3 Task 5 (5b) — rebuildStageFixtures", () => {
  it("regression: refuses once any fixture in the stage is decided, even with no roster drift at all", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "L", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await startDivision(auth, divisionId);
    await decideFixture(auth, fixtures[0]!.id);

    const [{ count: before }] = await sql<{ count: string }[]>`
      select count(*)::text from fixtures where stage_id = ${stage!.id}`;

    await expect(rebuildStageFixtures(auth, stage!.id)).rejects.toMatchObject({
      status: 409,
      code: "STAGE_HAS_RESULTS",
    });

    // Refused means untouched — the guard runs BEFORE the delete, not a
    // rollback after a partial one.
    const [{ count: after }] = await sql<{ count: string }[]>`
      select count(*)::text from fixtures where stage_id = ${stage!.id}`;
    expect(after).toBe(before);
  });

  it("a withdrawn entrant on an already-decided fixture is a ghost AND blocks the rebuild (hard constraint 1)", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrantByName } = await seedDivision(auth, ["A", "B"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "L", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await startDivision(auth, divisionId);
    await decideFixture(auth, fixtures[0]!.id);
    await patchEntrant(auth, entrantByName.get("A")!, { status: "withdrawn" });

    const drift = await getStageRosterDrift(auth, stage!.id);
    expect(drift.ghosts.map((e) => e.id)).toContain(entrantByName.get("A"));

    await expect(rebuildStageFixtures(auth, stage!.id)).rejects.toMatchObject({
      status: 409,
      code: "STAGE_HAS_RESULTS",
    });
  });

  it("a generation-time bye (one side never had an opponent) does NOT block — only a two-sided result does", async () => {
    const { auth } = await seedOrg();
    // 3 entrants in a knockout: bracket size 4, one bye in round 1.
    const { divisionId } = await seedDivision(auth, ["A", "B", "C"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "knockout", name: "KO", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    const bye = fixtures.find((f) => f.home_entrant_id === null || f.away_entrant_id === null);
    expect(bye).toBeDefined();
    expect(bye!.status).toBe("forfeited");

    const out = await rebuildStageFixtures(auth, stage!.id);
    expect(out.removed).toBe(fixtures.length);
    expect(out.created).toBeGreaterThan(0);
  });

  it("a two-sided 'forfeited' fixture (a withdrawal walkover, not a bye) DOES block — same status as a bye, different shape", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "knockout", name: "KO", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    // 4 entrants: a clean bracket, no byes — every round-1 fixture already
    // has both sides filled. Simulate a walkover the way withdrawal.ts's
    // core.forfeit really leaves it: 'forfeited' status, BOTH entrant ids
    // still populated (the cascade never nulls the FK, only appends a
    // scoring event) — append-event.ts:116 maps core.forfeit to this exact
    // status, so it is indistinguishable from a bye by status alone.
    const round1 = fixtures.filter((f) => f.round_no === Math.min(...fixtures.map((x) => x.round_no)));
    const target = round1[0]!;
    expect(target.home_entrant_id).not.toBeNull();
    expect(target.away_entrant_id).not.toBeNull();
    await sql`
      update fixtures set status = 'forfeited', outcome = ${sql.json({ kind: "award", winner: target.home_entrant_id } as never)}
      where id = ${target.id}`;

    await expect(rebuildStageFixtures(auth, stage!.id)).rejects.toMatchObject({
      status: 409,
      code: "STAGE_HAS_RESULTS",
    });
  });

  // Added after review of the 5a/5b work: the guard originally keyed off
  // `fixtures.status` alone. `delete from fixtures` CASCADEs into
  // score_events, match_states, match_reports, official_marks (and SET NULLs
  // suspensions.fixture_id), so a status-only test can delete real evidence
  // under any status it does not happen to name. These two cases fail against
  // a status-only guard.
  it("an 'abandoned' fixture blocks — it was PLAYED, and match-reports accepts a report on exactly that status", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "knockout", name: "KO", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await sql`update fixtures set status = 'abandoned' where id = ${fixtures[0]!.id}`;

    await expect(rebuildStageFixtures(auth, stage!.id)).rejects.toMatchObject({
      status: 409,
      code: "STAGE_HAS_RESULTS",
    });
  });

  it("a fixture carrying score_events blocks even while its status is still 'scheduled'", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "knockout", name: "KO", config: {}, progression: null,
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    const target = fixtures[0]!;
    // Evidence without a status transition: the guard must not depend on WHEN
    // a status flips relative to the first event landing.
    await sql`
      insert into score_events (fixture_id, org_id, seq, type, payload)
      values (${target.id}, ${auth.orgId}, 1, 'core.point', ${sql.json({ side: "home" } as never)})`;
    const [{ status }] = await sql<{ status: string }[]>`
      select status from fixtures where id = ${target.id}`;
    expect(status).toBe("scheduled");

    await expect(rebuildStageFixtures(auth, stage!.id)).rejects.toMatchObject({
      status: 409,
      code: "STAGE_HAS_RESULTS",
    });
  });

  it("422 STAGE_NOT_ROOT for a stage that doesn't draw fixtures directly from the active roster", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const stages = await createStages(auth, divisionId, [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
      {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ]);
    const koStage = stages.find((s) => s.kind === "knockout")!;
    await generateStageFixtures(auth, koStage.id);

    await expect(rebuildStageFixtures(auth, koStage.id)).rejects.toMatchObject({
      status: 422,
      code: "STAGE_NOT_ROOT",
    });
  });

  it("end to end: rebuild drops the withdrawn ghost and picks up the new entrant — the board matches the roster again", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrantByName } = await seedDivision(auth, ["A", "B", "C"]);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1, kind: "league", name: "L", config: {}, progression: null,
    });
    await generateStageFixtures(auth, stage!.id); // AB, AC, BC — 3 fixtures

    await patchEntrant(auth, entrantByName.get("A")!, { status: "withdrawn" });
    const added = await createEntrants(auth, divisionId, [
      { kind: "individual", display_name: "D", seed: 4, members: [] },
    ]);

    const before = await getStageRosterDrift(auth, stage!.id);
    expect(before.ghosts).toHaveLength(1);
    expect(before.unplaced).toHaveLength(1);

    const out = await rebuildStageFixtures(auth, stage!.id);
    expect(out.removed).toBe(3);
    expect(out.created).toBe(3); // B-C-D round robin: BC, BD, CD

    const rows = await sql<{ home_entrant_id: string; away_entrant_id: string }[]>`
      select home_entrant_id, away_entrant_id from fixtures where stage_id = ${stage!.id}`;
    const referenced = new Set(rows.flatMap((r) => [r.home_entrant_id, r.away_entrant_id]));
    expect(referenced.has(entrantByName.get("A")!)).toBe(false);
    expect(referenced.has(added[0]!.id)).toBe(true);

    const after = await getStageRosterDrift(auth, stage!.id);
    expect(after).toEqual({ ghosts: [], unplaced: [] });
  });
});
