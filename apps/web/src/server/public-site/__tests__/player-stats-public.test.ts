// PROMPT-65 — per-player stats on the public profile: getPublicPlayer reads
// player_stat_snapshots and labels metrics from the sport module's declared
// playerStats model. No stats.player gate on the profile block (locked
// decision: the leaderboard TABLE stays Pro; profile totals ride the existing
// consent + dashboard.player_profiles visibility). Real Postgres required.
import { describe, expect, it, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

// unstable_cache is a Next server-runtime API — passthrough under vitest.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { football } from "@seazn/engine/sports/football";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createPerson } from "@/server/usecases/persons";
import { getPublicPlayer } from "../data";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const FOOTBALL_CONFIG = {
  halfMinutes: 45,
  halves: 2,
  extraTime: { enabled: false, halfMinutes: 15 },
  shootout: false,
  points: { win: 3, draw: 1, loss: 0 },
  awardScore: { goals: 3 },
  fairPlay: true,
  abandonPolicy: "replay",
};

async function seed() {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Ps " + suffix}, ${"ps-" + suffix})
    returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('football', 'Football', '1.0.0',
            ${sql.json(football.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('football', 'std', 'Standard', ${sql.json(FOOTBALL_CONFIG)}, true)
    on conflict do nothing`;
  const auth: AuthCtx = {
    orgId,
    via: "session",
    userId: null,
    role: "owner",
    keyId: null,
  };
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Ps Cup " + suffix,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "football",
    variant_key: "std",
    config: FOOTBALL_CONFIG,
  });
  const person = await createPerson(auth, {
    full_name: "Striker Nine",
    consent: { public_name: true },
  } as never);
  await createEntrants(auth, division.id, [
    {
      kind: "team",
      display_name: "Mexico",
      members: [{ person_id: person.id, squad_number: 9, is_captain: false, roles: [] }],
    } as never,
  ]);
  const [org] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${orgId}`;
  return {
    auth,
    orgId,
    orgSlug: org!.slug,
    compId: comp.id,
    compSlug: comp.slug,
    division,
    person,
  };
}

/** A second division of any sport inside the SAME competition, with `person`
 *  rostered. The public rollup only renders where a sport spans more than one
 *  division — a one-division sport would just restate the Stats row below it —
 *  so any test of the career payload needs two. */
async function secondDivision(
  auth: AuthCtx,
  compId: string,
  personId: string,
  opts: { sportKey?: string; slug?: string } = {},
): Promise<{ id: string }> {
  const sportKey = opts.sportKey ?? "football";
  const division = await createDivision(auth, compId, {
    name: "Open " + (opts.slug ?? "two"),
    slug: opts.slug ?? "open-two",
    sport_key: sportKey,
    variant_key: "std",
    config: FOOTBALL_CONFIG,
  });
  await createEntrants(auth, division.id, [
    {
      kind: "team",
      display_name: "Chile " + (opts.slug ?? "two"),
      members: [{ person_id: personId, squad_number: 7, is_captain: false, roles: [] }],
    } as never,
  ]);
  return division;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("getPublicPlayer stats (PROMPT-65)", () => {
  it("returns module-labelled totals from player_stat_snapshots; zeros filtered", async () => {
    const { orgSlug, compSlug, division, person } = await seed();
    await sql`
      insert into player_stat_snapshots (division_id, person_id, sport_key, stats, computed_through_seq)
      values (${division.id}, ${person.id}, 'football',
              ${sql.json({ goals: 2, assists: 1, yellow_cards: 0 })}, 10)`;
    const data = await getPublicPlayer(orgSlug, compSlug, person.id);
    expect(data).not.toBeNull();
    expect(data!.stats).toHaveLength(1);
    expect(data!.stats[0]).toMatchObject({
      division_name: "Open",
      sport_key: "football",
    });
    const byKey = Object.fromEntries(data!.stats[0]!.metrics.map((m) => [m.key, m]));
    expect(byKey.goals).toMatchObject({ label: "Goals", value: 2 });
    expect(byKey.assists).toMatchObject({ label: "Assists", value: 1 });
    expect(byKey.yellow_cards).toBeUndefined(); // zero → filtered, no clutter
  });

  it("a player with no snapshots gets an empty stats list (no layout shift)", async () => {
    const { orgSlug, compSlug, person } = await seed();
    const data = await getPublicPlayer(orgSlug, compSlug, person.id);
    expect(data).not.toBeNull();
    expect(data!.stats).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// S9/#418 — the per-sport career rollup on the public player card, and its
// mandatory scoping regression: getPublicPlayer sums the snapshot rows it
// ALREADY read for stats[] (WHERE d.competition_id = this competition), so
// this proves the aggregation on top of that read carries the scoping
// through — never re-broadens it. A cross-ORG leak is structurally
// impossible for one person (persons.org_id is a hard FK, one org per
// person row, per this programme's own pinned analysis), so the meaningful
// regression is cross-COMPETITION, same org: this person plays football in
// TWO competitions of the SAME org, and competition B's obviously-distinct
// numbers must never appear on competition A's card.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("getPublicPlayer career rollup (S9/#418)", () => {
  it("sums metrics/divisions for THIS competition only", async () => {
    const { auth, compId, orgSlug, compSlug, division, person } = await seed();
    const divisionB = await secondDivision(auth, compId, person.id);
    await sql`
      insert into player_stat_snapshots (division_id, person_id, sport_key, stats, computed_through_seq)
      values (${division.id}, ${person.id}, 'football', ${sql.json({ goals: 2, assists: 1 })}, 10),
             (${divisionB.id}, ${person.id}, 'football', ${sql.json({ goals: 3 })}, 10)`;

    const data = await getPublicPlayer(orgSlug, compSlug, person.id);
    expect(data).not.toBeNull();
    expect(data!.career).toHaveLength(1);
    const football = data!.career[0]!;
    expect(football.sport_key).toBe("football");
    expect(football.divisions).toBe(2);
    expect(football.meta.length).toBeGreaterThan(0); // baked "N divisions · N variants · N matches" copy
    expect(data!.careerLabel.length).toBeGreaterThan(0);
    const byKey = Object.fromEntries(football.metrics.map((m) => [m.key, m.value]));
    expect(byKey.goals).toBe(5);
    expect(byKey.assists).toBe(1);
  });

  // Final-review finding 1. Gating the SECTION on "some sport aggregates"
  // still rendered the sports that do not, so a mixed competition showed one
  // real rollup beside a card restating its own Stats row — the duplication
  // the rule exists to remove, reintroduced for exactly the case that has
  // more than one sport. The drop is therefore per SPORT, not per page.
  it("a mixed competition drops the single-division sport and keeps the one that aggregates", async () => {
    const { auth, compId, orgSlug, compSlug, division, person } = await seed();
    const footballB = await secondDivision(auth, compId, person.id, { slug: "fb-two" });
    const lone = await secondDivision(auth, compId, person.id, { slug: "solo" });
    await sql`
      insert into player_stat_snapshots (division_id, person_id, sport_key, stats, computed_through_seq)
      values (${division.id}, ${person.id}, 'football', ${sql.json({ goals: 2 })}, 10),
             (${footballB.id}, ${person.id}, 'football', ${sql.json({ goals: 3 })}, 10),
             (${lone.id}, ${person.id}, 'badminton', ${sql.json({ points_won: 9 })}, 10)`;

    const data = await getPublicPlayer(orgSlug, compSlug, person.id);
    expect(data!.career.map((c) => c.sport_key)).toEqual(["football"]);
    expect(data!.career[0]!.divisions).toBe(2);
  });

  it("no sport aggregates → no career payload at all, and no rollup work done", async () => {
    const { orgSlug, compSlug, division, person } = await seed();
    await sql`
      insert into player_stat_snapshots (division_id, person_id, sport_key, stats, computed_through_seq)
      values (${division.id}, ${person.id}, 'football', ${sql.json({ goals: 2 })}, 10)`;

    const data = await getPublicPlayer(orgSlug, compSlug, person.id);
    // The per-division Stats block still carries the numbers — nothing is
    // hidden from the spectator, only the restatement is gone.
    expect(data!.career).toEqual([]);
    expect(data!.stats.length).toBe(1);
  });

  it("REGRESSION: a SECOND competition's snapshot in the SAME org never bleeds into this card's rollup", async () => {
    const { auth, orgId, compId, orgSlug, compSlug, division, person } = await seed();
    // Two divisions per competition throughout: a one-division sport is
    // dropped from the rollup entirely, so a single-division fixture would
    // assert an empty payload and prove nothing about scoping.
    const divisionA2 = await secondDivision(auth, compId, person.id, { slug: "a-two" });
    await sql`
      insert into player_stat_snapshots (division_id, person_id, sport_key, stats, computed_through_seq)
      values (${division.id}, ${person.id}, 'football', ${sql.json({ goals: 2, assists: 1 })}, 10),
             (${divisionA2.id}, ${person.id}, 'football', ${sql.json({ goals: 1 })}, 10)`;

    // A second competition, SAME org, SAME person rostered — obviously-wrong-
    // if-leaked numbers (100s) so a leak is unmistakable in the assertion.
    const compB = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Ps Cup B " + randomUUID().slice(0, 6),
      visibility: "public",
      branding: {},
    });
    const divisionB = await createDivision(auth, compB.id, {
      name: "Open B",
      slug: "open-b",
      sport_key: "football",
      variant_key: "std",
      config: FOOTBALL_CONFIG,
    });
    await createEntrants(auth, divisionB.id, [
      {
        kind: "team",
        display_name: "Brazil",
        members: [{ person_id: person.id, squad_number: 10, is_captain: false, roles: [] }],
      } as never,
    ]);
    const divisionB2 = await secondDivision(auth, compB.id, person.id, { slug: "b-two" });
    await sql`
      insert into player_stat_snapshots (division_id, person_id, sport_key, stats, computed_through_seq)
      values (${divisionB.id}, ${person.id}, 'football', ${sql.json({ goals: 100, assists: 100 })}, 10),
             (${divisionB2.id}, ${person.id}, 'football', ${sql.json({ goals: 100 })}, 10)`;
    void orgId;

    const dataA = await getPublicPlayer(orgSlug, compSlug, person.id);
    expect(dataA!.career).toHaveLength(1);
    expect(dataA!.career[0]!.divisions).toBe(2); // A's OWN two, NOT all four
    const byKeyA = Object.fromEntries(dataA!.career[0]!.metrics.map((m) => [m.key, m.value]));
    expect(byKeyA.goals).toBe(3); // NOT 203 — competition B's numbers must not bleed in

    // Sanity: competition B's OWN card genuinely has its own (large) total —
    // proves the isolation above is real scoping, not just a coincidence of
    // competition B's data never having been written.
    const [orgRow] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
    const dataB = await getPublicPlayer(orgRow!.slug, compB.slug, person.id);
    const byKeyB = Object.fromEntries(dataB!.career[0]!.metrics.map((m) => [m.key, m.value]));
    expect(byKeyB.goals).toBe(200);
  });
});
