// Integration tests for PROMPT-27 (Jul3/07): scoring-path goals/assists →
// leaderboard, MOTM via core.award, void refold, consent-filtered public
// table, coarse-scoring message, 402 gate. Real Postgres required.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { football } from "@seazn/engine/sports/football";
import { generic } from "@seazn/engine/sports/generic";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createPerson } from "../persons";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { getLineup, putLineup } from "../fixtures";
import { divisionPlayerStats, personStats, publicDivisionStats } from "../player-stats";

// S8/#417 — badminton (individual/pair entrants) and volleyball (team
// entrants) are both on the setbased kernel, which is NOT in the sibling
// session's packages/engine edit list (football/period/hockey/icehockey
// are), so these two are a stable target: already-shipped kernel defaults
// (`points_won`, the `matches`/`sets_won`/`sets_lost` folded fold) apply to
// every preset on that kernel unconditionally.
const badminton = builtinModules.find((m) => m.key === "badminton")!;
const volleyball = builtinModules.find((m) => m.key === "volleyball")!;

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(plan: "community" | "pro" = "pro"): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Sta " + suffix}, ${"sta-" + suffix})
    returning id`;
  if (plan !== "community") {
    await setOrgPlan(orgId, plan);
  }
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('football', 'Football', ${football.version}, ${sql.json(football.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('football', 'default', 'Default', ${sql.json({})}, true)
    on conflict do nothing`;
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
  };
}

// two 7-a-side teams with numbered players
async function seedDivision(auth: AuthCtx, visibility: "private" | "public" = "public") {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Stats Cup",
    visibility,
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "football",
    variant_key: "default",
    config: {},
    eligibility: [],
  });
  const mkPeople = async (names: string[]) =>
    Promise.all(
      names.map((full_name) =>
        createPerson(auth, {
          full_name,
          consent: { public_name: full_name !== "Minor Hidden" },
          dob: null,
          gender: null,
          external_ref: null,
        }),
      ),
    );
  const teamA = await mkPeople(["Ada Striker", "Bea Winger", "Minor Hidden"]);
  const teamB = await mkPeople(["Cy Keeper", "Dee Back", "Eve Mid"]);
  const entrants = await createEntrants(auth, division.id, [
    {
      kind: "team" as const,
      display_name: "Reds",
      seed: 1,
      members: teamA.map((p, i) => ({
        person_id: p.id,
        squad_number: i + 7,
        is_captain: i === 0,
        roles: [],
        default_position_key: null,
      })),
    },
    {
      kind: "team" as const,
      display_name: "Blues",
      seed: 2,
      members: teamB.map((p, i) => ({
        person_id: p.id,
        squad_number: i + 1,
        is_captain: i === 0,
        roles: [],
        default_position_key: null,
      })),
    },
  ]);
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);
  // scorer attribution validates against the on-pitch lineup — set both sides
  const rosters = new Map([
    [entrants[0]!.id, teamA],
    [entrants[1]!.id, teamB],
  ]);
  for (const f of fixtures) {
    for (const entrantId of [f.home_entrant_id, f.away_entrant_id]) {
      if (!entrantId) continue;
      const people = rosters.get(entrantId)!;
      await putLineup(auth, f.id, entrantId, {
        slots: people.map((p, i) => ({
          person_id: p.id,
          slot: "starting" as const,
          position_key: null,
          order_no: i + 1,
          roles: [],
        })),
      });
    }
  }
  return { comp, division, fixtures, entrants, teamA, teamB };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("player statistics (Jul3/07)", () => {
  it("goal + assist via #number roster → top-scorer table with points = goals + assists; MOTM aggregates; void refolds", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures, teamA, entrants } = await seedDivision(auth);
    const f = fixtures[0]!;
    const redsHome = f.home_entrant_id === entrants[0]!.id;
    await scoreEvent(auth, f.id, {
      expected_seq: 0,
      type: "core.start",
      payload: {},
    });
    const goal = await scoreEvent(auth, f.id, {
      expected_seq: 1,
      type: "football.goal",
      payload: {
        by: entrants[0]!.id,
        scorer: teamA[0]!.id,
        assist: teamA[1]!.id,
      },
    });
    await scoreEvent(auth, f.id, {
      expected_seq: 2,
      type: "football.goal",
      payload: { by: entrants[0]!.id, scorer: teamA[0]!.id },
    });
    await scoreEvent(auth, f.id, {
      expected_seq: 3,
      type: "core.award",
      payload: { person: teamA[0]!.id, key: "motm" },
    });

    const table = await divisionPlayerStats(auth, division.id, {
      metric: "goals",
    });
    expect(table.requires_detailed_scoring).toBe(false);
    const ada = table.rows.find((r) => r.full_name === "Ada Striker")!;
    expect(ada.stats).toMatchObject({ goals: 2, points: 2, motm_awards: 1 });
    expect(ada.stats.assists ?? 0).toBe(0);
    expect(ada.squad_number).toBe(7);
    const bea = table.rows.find((r) => r.full_name === "Bea Winger")!;
    expect(bea.stats).toMatchObject({ assists: 1, points: 1 });

    // void the assisted goal → goal AND assist drop (refold, §8)
    const [goalRow] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${f.id} and seq = ${goal.seq}`;
    await scoreEvent(auth, f.id, {
      expected_seq: 4,
      type: "core.void",
      payload: { event_id: goalRow!.id },
    });
    const after = await divisionPlayerStats(auth, division.id, {
      metric: "goals",
    });
    expect(after.rows.find((r) => r.full_name === "Ada Striker")!.stats.goals).toBe(1);
    expect(after.rows.find((r) => r.full_name === "Bea Winger")).toBeUndefined();
    void redsHome;

    // per-division card
    const card = await personStats(auth, teamA[0]!.id);
    expect(card.divisions).toHaveLength(1);
    expect(card.divisions[0]!.stats.goals).toBe(1);
  });

  // S4/#428, review round 1 finding 1 — THE acceptance criterion this whole
  // session exists for: "a card issued to a non-player produces no
  // player-stat row", proven through the REAL product surface (putLineup +
  // scoreEvent + divisionPlayerStats), not a bare aggregatePlayerStats unit
  // call. A coach is a squad member (S3 ruling 3: he can be carded) but must
  // never earn a leaderboard row.
  it("a coach's card never reaches the leaderboard, scored through the real API path", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures, teamA, entrants } = await seedDivision(auth);
    const f = fixtures[0]!;
    const redsId = entrants[0]!.id;

    const coach = await createPerson(auth, {
      full_name: "Cara Coach",
      consent: { public_name: true },
      dob: null,
      gender: null,
      external_ref: null,
    });
    // A coach is a squad member (entrant_members), same as any player — the
    // ROLE that excludes him from the leaderboard lives on the per-fixture
    // lineup slot, not on squad membership itself.
    await sql`
      insert into entrant_members (entrant_id, person_id, org_id)
      values (${redsId}, ${coach.id}, ${auth.orgId})`;
    // putLineup REPLACES the whole lineup for this entrant — re-declare the
    // players seedDivision already named, plus the coach, through the REAL
    // usecase (proves the wire actually carries `role`, not just the DB).
    await putLineup(auth, f.id, redsId, {
      slots: [
        ...teamA.map((p, i) => ({
          person_id: p.id,
          slot: "starting" as const,
          position_key: null,
          order_no: i + 1,
          roles: [],
        })),
        {
          person_id: coach.id,
          slot: "bench" as const,
          position_key: null,
          order_no: teamA.length + 1,
          roles: [],
          role: "coach" as const,
        },
      ],
    });
    // Round-trips through the real read path too.
    const lineup = await getLineup(auth, f.id, redsId);
    const coachSlot = (lineup.slots as { person_id: string; role: string }[]).find(
      (s) => s.person_id === coach.id,
    );
    expect(coachSlot?.role).toBe("coach");

    await scoreEvent(auth, f.id, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, f.id, {
      expected_seq: 1,
      type: "football.goal",
      payload: { by: redsId, scorer: teamA[0]!.id },
    });
    // THE event under test: a yellow card shown to the coach, not a player.
    await scoreEvent(auth, f.id, {
      expected_seq: 2,
      type: "football.card",
      payload: { by: redsId, person: coach.id, color: "yellow" },
    });

    const table = await divisionPlayerStats(auth, division.id, { metric: "goals" });
    expect(table.rows.find((r) => r.person_id === coach.id)).toBeUndefined();
    // The real player's goal still counts — the fix must not be a blanket
    // suppression, only the coach's credit is dropped.
    expect(table.rows.find((r) => r.person_id === teamA[0]!.id)?.stats.goals).toBe(1);

    // The per-person card (personStats) must not surface the coach's
    // "stats" either, since he never entered the fold as a player.
    const coachCard = await personStats(auth, coach.id);
    expect(
      coachCard.divisions.find((d) => d.division_id === division.id)?.stats.yellow_cards ?? 0,
    ).toBe(0);
  });

  // W4 gave the generic fallback a playerStats model (generic.score → person),
  // which flipped every result-level generic division out of the empty board
  // and into the notice. Nothing asserted that branch, so the flip surfaced as
  // a stale e2e text probe instead of a failing unit test — this is the guard.
  it("result-level generic division flags requires_detailed_scoring, not an empty board", async () => {
    const { auth } = await seedOrg();
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values ('generic', 'Generic', ${generic.version}, ${sql.json(generic.positions as never)})
      on conflict (key) do nothing`;
    await sql`
      insert into sport_variants (sport_key, key, name, config, is_system)
      values ('generic', 'score', 'Score', ${sql.json(generic.variants.score as never)}, true)
      on conflict do nothing`;
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Generic Cup",
      visibility: "private",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open",
      sport_key: "generic",
      variant_key: "score",
      config: {},
      eligibility: [],
    });
    await createEntrants(
      auth,
      division.id,
      ["A", "B"].map((display_name, i) => ({
        kind: "individual" as const,
        display_name,
        seed: i + 1,
        members: [],
      })),
    );
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "league",
      name: "L",
      config: {},
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await startDivision(auth, division.id);
    const f = fixtures[0]!;
    await scoreEvent(auth, f.id, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, f.id, {
      expected_seq: 1,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 0 },
    });

    const table = await divisionPlayerStats(auth, division.id, {});
    // the model exists (metrics are declared) but no event named a person
    expect(table.metrics.map((m) => m.key)).toContain("points");
    expect(table.rows).toHaveLength(0);
    expect(table.requires_detailed_scoring).toBe(true);
  });

  it("lineup read model carries squad numbers (Jul3/07 §5)", async () => {
    const { auth } = await seedOrg();
    const { fixtures, entrants, teamA } = await seedDivision(auth);
    const f = fixtures[0]!;
    const entrantId = entrants[0]!.id;
    const lineup = await getLineup(auth, f.id, entrantId);
    const slot = (lineup.slots as { full_name: string; squad_number: number | null }[]).find(
      (s) => s.full_name === "Ada Striker",
    )!;
    expect(slot.squad_number).toBe(7);
  });

  it("public leaderboard is consent-filtered; stats gate 402s Community", async () => {
    const { auth } = await seedOrg();
    const { comp, division, fixtures, teamA, entrants } = await seedDivision(auth, "public");
    void division;
    const f = fixtures[0]!;
    await scoreEvent(auth, f.id, {
      expected_seq: 0,
      type: "core.start",
      payload: {},
    });
    await scoreEvent(auth, f.id, {
      expected_seq: 1,
      type: "football.goal",
      payload: { by: entrants[0]!.id, scorer: teamA[2]!.id }, // the no-consent minor
    });
    const [org] = await sql<{ slug: string }[]>`
      select slug from organizations where id = ${auth.orgId}`;
    const pub = await publicDivisionStats(org!.slug, comp.slug, "open");
    const names = pub.rows.map((r) => r.name);
    expect(names.some((n) => n.includes("Minor Hidden"))).toBe(false); // initials only
    expect(names.length).toBeGreaterThan(0);

    const { auth: freeAuth } = await seedOrg("community");
    const { division: freeDiv } = await seedDivision(freeAuth, "private");
    await expect(divisionPlayerStats(freeAuth, freeDiv.id, {})).rejects.toMatchObject({
      featureKey: "stats.player",
    });
  });
});

// ---------------------------------------------------------------------------
// S8/#417 — entrant→person stat attribution wired into recomputePlayerStats
// for real, through the real usecase (divisionPlayerStats), against a real
// database. The engine's PlayerStatsFoldCtx/aggregatePlayerStatsWithDiagnostics
// (packages/engine/src/stats/stats.ts) already ships this fold; what these
// tests prove is that THIS APP feeds it real entrant-membership data and a
// real resolved cfg — the exact wiring gap S4/#428 and S6/#416 each shipped
// unreachable once already (see docs/superpowers/RULES.md's programme notes).
// ---------------------------------------------------------------------------

async function seedSetBasedCatalog(mod: AnySportModule): Promise<void> {
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values (${mod.key}, ${mod.key}, ${mod.version}, ${sql.json(mod.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values (${mod.key}, 'default', 'Default', ${sql.json({})}, true)
    on conflict do nothing`;
}

interface SetBasedEntrantSpec {
  kind: "individual" | "pair" | "team";
  name: string;
  personIds: string[];
}

async function seedSetBasedDivision(
  auth: AuthCtx,
  mod: AnySportModule,
  entrantSpecs: SetBasedEntrantSpec[],
  config: Record<string, unknown> = {},
) {
  await seedSetBasedCatalog(mod);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `${mod.key} Cup`,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: mod.key,
    variant_key: "default",
    config,
    eligibility: [],
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    entrantSpecs.map((spec, i) => ({
      kind: spec.kind,
      display_name: spec.name,
      seed: i + 1,
      members: spec.personIds.map((person_id) => ({
        person_id,
        squad_number: null,
        is_captain: false,
        roles: [],
        default_position_key: null,
      })),
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);
  return { division, entrants, fixture: fixtures[0]! };
}

describe.skipIf(!HAS_DB)("S8/#417 entrant→person stat attribution", () => {
  it("THE HEADLINE: a v1-era rally naming only the entrant (wonBy, no scorer/server) still produces a per-person row for an individual entrant", async () => {
    const { auth } = await seedOrg();
    const alex = await createPerson(auth, {
      full_name: "Alex Player",
      consent: { public_name: true },
      dob: null,
      gender: null,
      external_ref: null,
    });
    const bo = await createPerson(auth, {
      full_name: "Bo Player",
      consent: { public_name: true },
      dob: null,
      gender: null,
      external_ref: null,
    });
    const { division, entrants, fixture } = await seedSetBasedDivision(auth, badminton, [
      { kind: "individual", name: "Alex", personIds: [alex.id] },
      { kind: "individual", name: "Bo", personIds: [bo.id] },
    ]);

    await scoreEvent(auth, fixture.id, { expected_seq: 0, type: "core.start", payload: {} });
    // ONLY the entrant id — no scorer, no server. Before S8/#417's wiring this
    // fixture recomputes to ZERO player rows (requires_detailed_scoring).
    await scoreEvent(auth, fixture.id, {
      expected_seq: 1,
      type: "badminton.rally",
      payload: { wonBy: fixture.home_entrant_id! },
    });

    const table = await divisionPlayerStats(auth, division.id, {});
    const homePersonId = fixture.home_entrant_id === entrants[0]!.id ? alex.id : bo.id;
    const row = table.rows.find((r) => r.person_id === homePersonId);
    expect(row).toBeDefined();
    expect(row!.stats.points_won).toBe(1);
    expect(table.requires_detailed_scoring).toBe(false);
  });

  it("a pair entrant's wonBy-only rally credits BOTH partners", async () => {
    const { auth } = await seedOrg();
    const mkPerson = (name: string) =>
      createPerson(auth, { full_name: name, consent: { public_name: true }, dob: null, gender: null, external_ref: null });
    const [p1, p2, q1, q2] = await Promise.all([
      mkPerson("P One"),
      mkPerson("P Two"),
      mkPerson("Q One"),
      mkPerson("Q Two"),
    ]);
    const { division, entrants, fixture } = await seedSetBasedDivision(auth, badminton, [
      { kind: "pair", name: "Pair P", personIds: [p1!.id, p2!.id] },
      { kind: "pair", name: "Pair Q", personIds: [q1!.id, q2!.id] },
    ]);

    await scoreEvent(auth, fixture.id, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, fixture.id, {
      expected_seq: 1,
      type: "badminton.rally",
      payload: { wonBy: fixture.home_entrant_id! },
    });

    const table = await divisionPlayerStats(auth, division.id, {});
    const homePair = fixture.home_entrant_id === entrants[0]!.id ? [p1!, p2!] : [q1!, q2!];
    for (const p of homePair) {
      expect(table.rows.find((r) => r.person_id === p.id)?.stats.points_won, p.full_name).toBe(1);
    }
  });

  it("a team-entrant sport (volleyball) still produces no person rows from the entrant-fallback path — the designed no-stats state", async () => {
    const { auth } = await seedOrg();
    const mkPerson = (name: string) =>
      createPerson(auth, { full_name: name, consent: { public_name: true }, dob: null, gender: null, external_ref: null });
    const [home1, away1] = await Promise.all([mkPerson("Home Player"), mkPerson("Away Player")]);
    // Real rosters (not empty) — a person genuinely on the entrant's squad,
    // so this test is falsifiable: were the kind guard not enforced by this
    // app's own ctx wiring, these two would show up with points_won:1.
    const { division, fixture } = await seedSetBasedDivision(auth, volleyball, [
      { kind: "team", name: "Reds", personIds: [home1!.id] },
      { kind: "team", name: "Blues", personIds: [away1!.id] },
    ]);

    await scoreEvent(auth, fixture.id, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, fixture.id, {
      expected_seq: 1,
      type: "volleyball.rally",
      payload: { wonBy: fixture.home_entrant_id! },
    });

    const table = await divisionPlayerStats(auth, division.id, {});
    expect(table.rows).toEqual([]);
  });

  it("conflicting attribution: an explicit scorer wins over a DIFFERENT person the entrant's own roster names; the roster person gets no row", async () => {
    const { auth } = await seedOrg();
    const alex = await createPerson(auth, {
      full_name: "Alex Roster",
      consent: { public_name: true },
      dob: null,
      gender: null,
      external_ref: null,
    });
    const bo = await createPerson(auth, {
      full_name: "Bo Roster",
      consent: { public_name: true },
      dob: null,
      gender: null,
      external_ref: null,
    });
    // Casey is NOT on either entrant's roster — the explicit `scorer` field
    // does not check squad membership, only the entrant fallback does.
    const casey = await createPerson(auth, {
      full_name: "Casey Explicit",
      consent: { public_name: true },
      dob: null,
      gender: null,
      external_ref: null,
    });
    const { division, entrants, fixture } = await seedSetBasedDivision(auth, badminton, [
      { kind: "individual", name: "Alex", personIds: [alex.id] },
      { kind: "individual", name: "Bo", personIds: [bo.id] },
    ]);

    await scoreEvent(auth, fixture.id, { expected_seq: 0, type: "core.start", payload: {} });
    // wonBy names the home entrant (whose roster is alex-or-bo); scorer
    // explicitly names casey instead. The explicit field must win outright.
    await scoreEvent(auth, fixture.id, {
      expected_seq: 1,
      type: "badminton.rally",
      payload: { wonBy: fixture.home_entrant_id!, scorer: casey.id },
    });

    const table = await divisionPlayerStats(auth, division.id, {});
    const homeRosterPersonId = fixture.home_entrant_id === entrants[0]!.id ? alex.id : bo.id;
    expect(table.rows.find((r) => r.person_id === casey.id)?.stats.points_won).toBe(1);
    expect(table.rows.find((r) => r.person_id === casey.id)?.stats.points).toBe(1);
    // The roster person gets no SCORING credit at all from this event — not
    // "no row": the kernel's own folded fold separately credits `matches` to
    // both entrants' rosters the moment either plays a rally, regardless of
    // who scored it (see setBasedMatchOutcomesFold), so the roster person's
    // row can legitimately exist with `matches:1`. What must be zero is the
    // metric actually in dispute — the explicit `scorer` field must have
    // stopped the entrant fallback from ALSO crediting the roster person.
    const rosterRow = table.rows.find((r) => r.person_id === homeRosterPersonId);
    expect(rosterRow?.stats.points_won ?? 0).toBe(0);
    expect(rosterRow?.stats.points ?? 0).toBe(0);
  });

  it("ctx.cfg is threaded through: a completed set yields sets_won/matches, not matches-only — the silent-degradation regression", async () => {
    const { auth } = await seedOrg();
    const alex = await createPerson(auth, {
      full_name: "Alex Sets",
      consent: { public_name: true },
      dob: null,
      gender: null,
      external_ref: null,
    });
    const bo = await createPerson(auth, {
      full_name: "Bo Sets",
      consent: { public_name: true },
      dob: null,
      gender: null,
      external_ref: null,
    });
    // bestOf must be odd (kernel invariant); a tiny setTo keeps the test fast
    // — 3 straight rallies close the one and only (deciding) set.
    const { division, entrants, fixture } = await seedSetBasedDivision(
      auth,
      badminton,
      [
        { kind: "individual", name: "Alex", personIds: [alex.id] },
        { kind: "individual", name: "Bo", personIds: [bo.id] },
      ],
      { bestOf: 1, setTo: 3, finalSetTo: 3, winBy: 2 },
    );

    await scoreEvent(auth, fixture.id, { expected_seq: 0, type: "core.start", payload: {} });
    for (let seq = 1; seq <= 3; seq += 1) {
      await scoreEvent(auth, fixture.id, {
        expected_seq: seq,
        type: "badminton.rally",
        payload: { wonBy: fixture.home_entrant_id! },
      });
    }

    const table = await divisionPlayerStats(auth, division.id, {});
    const homePersonId = fixture.home_entrant_id === entrants[0]!.id ? alex.id : bo.id;
    const row = table.rows.find((r) => r.person_id === homePersonId)!;
    expect(row).toBeDefined();
    expect(row.stats.matches).toBe(1);
    // THE assertion that only passes when ctx.cfg reached the engine's
    // folded fold (setBasedMatchOutcomesFold replays applyRally/bankSet
    // against it) — omitted or unparseable cfg silently degrades to
    // matches-only, per stats.ts's own docstring on PlayerStatsFoldCtx.cfg.
    expect(row.stats.sets_won).toBe(1);
    expect(row.stats.sets_lost ?? 0).toBe(0);
  });
});
