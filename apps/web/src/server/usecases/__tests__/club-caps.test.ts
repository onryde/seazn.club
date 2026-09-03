// Cap enforcement (W1 §4): community grids cap clubs at 5, teams at 8, and the
// squad at whatever `teams.squad_max` says (V319 set 20; V393 raised it to 23).
// createClub/createTeam/setTeamSquad must throw
// PaymentRequiredError(featureKey) once a create would cross the plan limit.
// Each test seeds a fresh org (unique orgId → unique entitlement cache key), so
// the 300s entitlement cache never leaks a limit across tests. Real Postgres.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { football } from "@seazn/engine/sports/football";
import { icehockey } from "@seazn/engine/sports/icehockey";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createClub } from "../clubs";
import { createTeam, setTeamSquad } from "../teams";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Cap " + suffix}, ${"cap-" + suffix})
    returning id`;
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("club/team caps", () => {
  it("blocks the 6th club on community with PaymentRequiredError(clubs.max)", async () => {
    const auth = await seedOrg(); // fixture org is community by default
    for (const name of ["Cap One", "Cap Two", "Cap Three", "Cap Four", "Cap Five"]) {
      await createClub(auth, { name }); // community cap is 5 (V319)
    }
    await expect(createClub(auth, { name: "Cap Six" })).rejects.toMatchObject({
      featureKey: "clubs.max",
    });
  });

  it("blocks the 9th team org-wide on community with teams.max", async () => {
    const auth2 = await seedOrg(); // fresh org fixture
    const club = await createClub(auth2, { name: "T Cap" });
    await createTeam(auth2, { name: "T1", club_id: club.id });
    // Fill to the community teams cap of 8 (V319); standalone teams count too.
    for (const name of ["T2", "T3", "T4", "T5", "T6", "T7", "T8"]) {
      await createTeam(auth2, { name });
    }
    await expect(createTeam(auth2, { name: "T9" })).rejects.toMatchObject({
      featureKey: "teams.max",
    });
  });

  /**
   * The biggest matchday squad the ENGINE declares, derived from the sport
   * modules themselves rather than typed here. V393 (entitlements v18 W2 T12)
   * raised Free's `teams.squad_max` from 20 to 23 for exactly this reason:
   * football is `{ size: 11, benchMax: 12 }` and icehockey `{ size: 6,
   * benchMax: 17 }`, both 23, so at 20 a football or ice-hockey club could not
   * register its first full squad on Free at all.
   *
   * Deriving it means a change to the source of truth moves this test with it
   * instead of leaving it asserting yesterday's number — and the value it
   * produces (23) is deliberately NOT the retired constant (20), so the test
   * can witness the regression it exists for.
   */
  const matchdaySquad = (m: {
    positions: { lineup: { size: number; benchMax?: number } };
  }): number => m.positions.lineup.size + (m.positions.lineup.benchMax ?? 0);
  const ENGINE_MAX_MATCHDAY_SQUAD = Math.max(matchdaySquad(football), matchdaySquad(icehockey));

  async function squadOf(auth: AuthCtx, n: number) {
    const members = [];
    for (let i = 0; i < n; i++) {
      const [{ id }] = await sql<{ id: string }[]>`
        insert into persons (org_id, full_name) values (${auth.orgId}, ${"P" + i}) returning id`;
      members.push({ person_id: id, squad_number: null, default_position_key: null, is_captain: false, roles: [] });
    }
    return members;
  }

  async function communitySquadCap(): Promise<number> {
    const [row] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
       where plan_key = 'community' and feature_key = 'teams.squad_max'`;
    expect(row?.int_value, "teams.squad_max must be a finite community cap").toBeTypeOf("number");
    return row!.int_value!;
  }

  it("takes a full football matchday squad on community (V393: 11 + 12 bench)", async () => {
    // Anti-vacuity: the two sports the raise was made for really do want 23,
    // and 23 is really more than the cap this replaced. Without this the
    // acceptance below passes at any cap at all.
    expect(ENGINE_MAX_MATCHDAY_SQUAD).toBe(23);
    expect(matchdaySquad(football)).toBe(ENGINE_MAX_MATCHDAY_SQUAD);
    expect(matchdaySquad(icehockey)).toBe(ENGINE_MAX_MATCHDAY_SQUAD);
    expect(await communitySquadCap()).toBeGreaterThanOrEqual(ENGINE_MAX_MATCHDAY_SQUAD);

    const auth3 = await seedOrg(); // fresh community org fixture
    const team = await createTeam(auth3, { name: "Full Squad" });
    const saved = await setTeamSquad(auth3, team.id, await squadOf(auth3, ENGINE_MAX_MATCHDAY_SQUAD));
    expect(saved.members).toHaveLength(ENGINE_MAX_MATCHDAY_SQUAD);
  });

  it("blocks the squad one past the cap on community with teams.squad_max", async () => {
    const cap = await communitySquadCap();
    const auth4 = await seedOrg(); // fresh community org fixture
    const team = await createTeam(auth4, { name: "Squad Cap" }); // standalone is fine
    await expect(setTeamSquad(auth4, team.id, await squadOf(auth4, cap + 1))).rejects.toMatchObject({
      featureKey: "teams.squad_max",
    });
  });
});
