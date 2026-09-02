// Competition Desk W1, Task 3 — getCompetitionDesk (spec 2026-09-02 §"The
// shared model"): the per-division phase/attention/counts the desk's own
// list and card views both read. Real Postgres required; skipped without
// DATABASE_URL. seedOrg/seedDivision copied from add-fixture.test.ts (org +
// sports + pro plan + competition + division + N entrants), with
// seedDivision's return narrowed to the ids this file actually needs.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { getCompetitionDesk, competitionPhase } from "../competition-desk";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Af " + suffix}, ${"af-" + suffix})
    returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
  };
}

// Same seeding as add-fixture.test.ts's seedDivision, return narrowed to
// { competitionId, divisionId } — the only two ids this file's tests read.
async function seedDivision(auth: AuthCtx, count: number) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Af Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
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
  return { competitionId: comp.id, divisionId: division.id };
}

describe.skipIf(!HAS_DB)("getCompetitionDesk", () => {
  afterAll(async () => {
    await sql.end({ timeout: 1 });
  });

  // Found by driving the product: a competition created seconds ago rendered
  // "Finished · 0 divisions" in its masthead, directly above the "No divisions
  // yet" empty state. `competitionPhase` derives from the division phases, and
  // an EMPTY set satisfied none of the `includes` tests and fell through to
  // finished — the same vacuous truth the division rule was amended for.
  it("a competition with no divisions is setting up, never finished", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Af Empty " + randomUUID().slice(0, 6),
      visibility: "private",
      branding: {},
    });
    const desk = await getCompetitionDesk(auth, comp.id);
    expect(desk.divisions.size).toBe(0);
    expect(competitionPhase(desk)).toEqual({ kind: "setting_up" });
  });

  it("a fresh division with no stage is setting_up with no attention", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const desk = await getCompetitionDesk(auth, competitionId);
    const d = desk.divisions.get(divisionId)!;
    expect(d.phase).toBe("setting_up");
    expect(d.attention).toEqual([]);
    expect(competitionPhase(desk)).toEqual({ kind: "setting_up" });
  });

  it("F1 fix: unscheduled fixtures on an active division are 'setting_up', never 'scheduled', with an unscheduled attention", async () => {
    // Final review, Critical: the OLD rule 5 was a bare "otherwise", so this
    // exact shape — a started division, fixtures generated, none carrying a
    // time — read "Scheduled" while its own status line said "nothing
    // scheduled". Rule 5 now requires a live fixture to actually carry a
    // scheduledAt; with none, the division is still setting_up.
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
      progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const desk = await getCompetitionDesk(auth, competitionId, new Date("2026-09-08T10:00:00Z"));
    const d = desk.divisions.get(divisionId)!;
    expect(d.phase).toBe("setting_up");
    expect(d.attention).toContainEqual({ kind: "unscheduled", count: 6 });
    expect(d.total).toBe(6);
  });
  it("F1 fix, contrast: the same league with ONE fixture given a real (future) time reads 'scheduled'", async () => {
    // Isolates the fix: it is not "generated fixtures never read scheduled",
    // it is specifically "no fixture carries a time yet" — one dated,
    // still-unplayed fixture is enough.
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
      progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const [f] = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} order by fixture_no limit 1`;
    await sql`update fixtures set scheduled_at = ${new Date("2026-09-20T09:00:00Z").toISOString()} where id = ${f!.id}`;
    const desk = await getCompetitionDesk(auth, competitionId, new Date("2026-09-08T10:00:00Z"));
    const d = desk.divisions.get(divisionId)!;
    expect(d.phase).toBe("scheduled");
    expect(d.attention).toContainEqual({ kind: "unscheduled", count: 5 });
  });

  it("regression #1: an all-decided league is finished, never 'nothing scheduled'", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
      progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    await sql`update fixtures set status = 'decided' where division_id = ${divisionId}`;
    await sql`update stages set status = 'complete' where id = ${stage!.id}`;
    const desk = await getCompetitionDesk(auth, competitionId);
    const d = desk.divisions.get(divisionId)!;
    expect(d.phase).toBe("finished");
    expect(d.played).toBe(6);
    expect(d.attention.some((a) => a.kind === "unscheduled")).toBe(false);
  });

  it("an in_play fixture with no events raises no_scorer and lifts the competition to in_play", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
      progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const [f] = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} order by fixture_no limit 1`;
    await sql`update fixtures set status = 'in_play', scheduled_at = now() - interval '12 minutes' where id = ${f!.id}`;
    const desk = await getCompetitionDesk(auth, competitionId);
    const d = desk.divisions.get(divisionId)!;
    expect(d.phase).toBe("match_day");
    expect(d.in_play).toBe(1);
    expect(d.attention[0]).toMatchObject({ kind: "no_scorer", fixtureId: f!.id });
    expect(d.fixture_names[f!.id]?.fixture_no).toBe(1);
    expect(desk.in_play).toBe(1);
    expect(competitionPhase(desk)).toEqual({ kind: "in_play", n: 1 });
  });

  // Fix round 1, finding 1: DEFAULT_MATCH_MINUTES must come from
  // ScheduleConfig's own zod default (schemas.ts, 30), not a retyped
  // constant. This division has NO schedule_settings row at all, so
  // getCompetitionDesk falls all the way back to DEFAULT_MATCH_MINUTES — a
  // fixture scheduled 45 minutes ago clears a 30-minute match (result
  // overdue) but not a 60-minute one, so this witnesses the regression: it
  // passes with 30 and fails with 60.
  it("no schedule_settings row: a fixture 45 minutes past kickoff is result_missing under the schema's 30-minute default, not a 60-minute one", async () => {
    const { auth } = await seedOrg();
    const { competitionId, divisionId } = await seedDivision(auth, 4);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
      progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const [f] = await sql<{ id: string }[]>`select id from fixtures where division_id = ${divisionId} order by fixture_no limit 1`;
    await sql`update fixtures set status = 'scheduled', scheduled_at = now() - interval '45 minutes' where id = ${f!.id}`;
    const [settingsRow] = await sql<{ division_id: string }[]>`select division_id from schedule_settings where division_id = ${divisionId}`;
    expect(settingsRow).toBeUndefined();
    const desk = await getCompetitionDesk(auth, competitionId);
    const d = desk.divisions.get(divisionId)!;
    expect(d.attention).toContainEqual({ kind: "result_missing", fixtureId: f!.id });
  });
});
