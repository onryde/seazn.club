// S9/#418 — listMyCareerStats: the /me Career section's cross-org rollup.
// Deliberately different from personCareerStats (usecases/player-stats.ts,
// see player-stats-career.test.ts): that one is org-scoped via withTenant
// (the organiser's console read), this one sums across EVERY org/person the
// signed-in user has claimed — cross-org totals are correct and intended
// here (/me is the player's own view of their whole career), not a leak.
// Real Postgres required.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createPerson } from "../persons";
import { listMyCareerStats } from "../me";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

async function seedOrgWithCatalog(tag: string): Promise<{ owner: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"MC " + tag + " " + suffix}, ${"mc-" + tag + "-" + suffix})
    returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('football', 'Football', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('football', 'default', 'Default', ${sql.json({})}, true)
    on conflict do nothing`;
  return { owner: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

async function seedDivision(owner: AuthCtx, name: string): Promise<string> {
  const suffix = randomUUID().slice(0, 6);
  const comp = await createCompetition(owner, {
    ends_on: "2030-12-31",
    name: `${name} Cup ${suffix}`,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(owner, comp.id, {
    name,
    slug: `${name.toLowerCase()}-${suffix}`,
    sport_key: "football",
    variant_key: "default",
    config: {},
    eligibility: [],
  });
  return division.id;
}

async function insertSnapshot(
  divisionId: string,
  personId: string,
  sportKey: string,
  stats: Record<string, number>,
): Promise<void> {
  await sql`
    insert into player_stat_snapshots (division_id, person_id, sport_key, stats, computed_through_seq)
    values (${divisionId}, ${personId}, ${sportKey}, ${sql.json(stats as never)}, 1)`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("listMyCareerStats (S9/#418)", () => {
  it("CROSS-ORG: sums the SAME sport across TWO orgs the user has claimed a person in — deliberately unlike personCareerStats", async () => {
    const player = await makeUser("crossorg");

    const a = await seedOrgWithCatalog("a");
    const personA = await createPerson(a.owner, {
      full_name: "Robin A",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
    });
    await sql`update persons set user_id = ${player} where id = ${personA.id}`;
    const divA = await seedDivision(a.owner, "Open A");
    await insertSnapshot(divA, personA.id, "football", { goals: 2, assists: 1 });

    const b = await seedOrgWithCatalog("b");
    const personB = await createPerson(b.owner, {
      full_name: "Robin B",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
    });
    await sql`update persons set user_id = ${player} where id = ${personB.id}`;
    const divB = await seedDivision(b.owner, "Open B");
    await insertSnapshot(divB, personB.id, "football", { goals: 5, assists: 0 });

    const career = await listMyCareerStats(player);
    expect(career).toHaveLength(1);
    expect(career[0]!.sport_key).toBe("football");
    expect(career[0]!.divisions).toBe(2); // ONE division per org, summed across BOTH
    const byKey = Object.fromEntries(career[0]!.metrics.map((m) => [m.key, m.value]));
    expect(byKey.goals).toBe(7); // 2 + 5, across two DIFFERENT orgs' persons
    expect(byKey.assists).toBe(1);
    expect(byKey.points).toBe(8); // derived AFTER the cross-org sum
  });

  it("isolation: a stranger user with no claimed persons gets an empty list", async () => {
    const stranger = await makeUser("stranger");
    expect(await listMyCareerStats(stranger)).toEqual([]);
  });

  it("a claimed person in one org does not leak another user's claimed person in the SAME org/division", async () => {
    const { owner } = await seedOrgWithCatalog("shared");
    const division = await seedDivision(owner, "Shared Div");
    const me = await makeUser("me");
    const someoneElse = await makeUser("someoneElse");
    const myPerson = await createPerson(owner, {
      full_name: "Mine",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
    });
    const theirPerson = await createPerson(owner, {
      full_name: "Theirs",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
    });
    await sql`update persons set user_id = ${me} where id = ${myPerson.id}`;
    await sql`update persons set user_id = ${someoneElse} where id = ${theirPerson.id}`;
    await insertSnapshot(division, myPerson.id, "football", { goals: 1 });
    await insertSnapshot(division, theirPerson.id, "football", { goals: 99 });

    const career = await listMyCareerStats(me);
    const byKey = Object.fromEntries(career[0]!.metrics.map((m) => [m.key, m.value]));
    expect(byKey.goals).toBe(1); // NOT 100 — the other claimed person's row must not bleed in
  });

  // Regression (d), me.ts's own code path: a snapshot with NO backing
  // fixtures/score_events in its division stays exactly as inserted. If
  // listMyCareerStats ever called recomputePlayerStats, the refold would
  // find zero events for this division and DELETE the row entirely (a real
  // recompute always does `delete ... where division_id=X` then reinserts
  // only what the fold produced) — so "still here, unchanged" is a
  // falsifiable proof, not an assumption.
  it("issues NO recompute — a snapshot with no backing fixtures/events is returned unchanged, not wiped by a refold", async () => {
    const player = await makeUser("stale");
    const { owner } = await seedOrgWithCatalog("stale");
    const person = await createPerson(owner, {
      full_name: "Stale Player",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
    });
    await sql`update persons set user_id = ${player} where id = ${person.id}`;
    const division = await seedDivision(owner, "Stale Div");
    await insertSnapshot(division, person.id, "football", { goals: 4 });

    const career = await listMyCareerStats(player);
    expect(career).toHaveLength(1); // still here — a recompute against zero events would have deleted it
    expect(career[0]!.metrics.find((m) => m.key === "goals")?.value).toBe(4);
  });
});
