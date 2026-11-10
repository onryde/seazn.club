// Sponsor deals, Task 3: the placement and online gates (plan 2026-11-07-sponsor-deals D17, preflight F14; spec §8 and
// §10 Q1, owner-confirmed 2026-11-07). "Another sport" does not apply (sponsors read no sport key); its substitute is
// ANOTHER PLAN, and every gate is driven on all three: community, Pro, and an Event Pass on one competition C (with its
// sibling C' in the same org as the control arm, so a grant that leaked org-wide cannot pass).
//
// Expected answers come from the spec, never from the code under test:
//   - §10 Q1: on community every placement is Partner on the whole org; a tier or a competition scope needs
//     `sponsors.tiers` (402 naming that key);
//   - §8: online invoices and payment need `sponsors.monetize`, resolved against the deal's competition;
//   - the Event Pass lifts ONE competition (lib/entitlements.ts consults competition_passes only with a competition in
//     hand), so the org-wide answer on a pass org is community's.
// The F14 block drives `createSponsor`, whose private `assertTierAllowed` must decide by the same predicate: mutating
// `placementNeedsTiers` kills both the gate cases here and the sponsor cases. Real Postgres; skipped without
// DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { SPONSOR_TIERS } from "@/lib/sponsor-tiers";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createSponsor } from "@/server/usecases/sponsors";
import { assertOnlineAllowed, assertPlacementAllowed } from "../deal-gates";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

interface Rig {
  orgId: string;
  auth: AuthCtx;
  /** Carries the Event Pass when the rig is "pass"; a plain competition otherwise. */
  compC: string;
  /** Same org, never passed: the control arm. */
  compOther: string;
}

/** An org on `plan`, with two competitions. "community" and "pass" get an explicit community billing group (the
 *  resolver's pass arm fires only while the resolved plan is community); "pass" also holds an Event Pass on C. */
async function seedRig(plan: "community" | "pro" | "pass"): Promise<Rig> {
  const s = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Deal Gates " + s}, ${"deal-gates-" + s}) returning id`;
  if (plan === "pro") {
    await setOrgPlan(orgId, "pro");
  } else {
    await sql`with _owner as (
        insert into users (email, display_name, email_verified)
        values ('dealgates-' || gen_random_uuid() || '@test.local', 'Gate Owner', true)
        returning id
      ),
      _seed_sub as (
        insert into subscriptions (owner_user_id, plan_key, status)
        select (select id from _owner), 'community', 'active'
        returning id
      )
      update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  }
  const [{ id: compC }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, 'Cup C', ${"deal-gates-c-" + s}, 'unlisted') returning id`;
  const [{ id: compOther }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, 'Cup Other', ${"deal-gates-o-" + s}, 'unlisted') returning id`;
  if (plan === "pass") {
    await sql`insert into competition_passes (competition_id, org_id) values (${compC}, ${orgId})`;
  }
  await invalidateOrgEntitlements(orgId);
  return { orgId, compC, compOther, auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

const TIERS_402 = { status: 402, featureKey: "sponsors.tiers" };
const MONETIZE_402 = { status: 402, featureKey: "sponsors.monetize" };

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("assertPlacementAllowed — spec §10 Q1 on every plan", () => {
  it("community: partner on the whole org passes; gold on the whole org and partner on a competition 402 sponsors.tiers", async () => {
    const rig = await seedRig("community");
    await expect(assertPlacementAllowed(rig.orgId, "partner", null)).resolves.toBeUndefined();
    await expect(assertPlacementAllowed(rig.orgId, "gold", null)).rejects.toMatchObject(TIERS_402);
    await expect(assertPlacementAllowed(rig.orgId, "partner", rig.compC)).rejects.toMatchObject(TIERS_402);
  });

  it("community: every tier other than partner 402s on the whole org and on a competition (6 refusals checked)", async () => {
    const rig = await seedRig("community");
    let refused = 0;
    for (const tier of SPONSOR_TIERS.filter((t) => t !== "partner")) {
      for (const scope of [null, rig.compC]) {
        await expect(assertPlacementAllowed(rig.orgId, tier, scope), `${tier} on ${scope ?? "org"}`).rejects.toMatchObject(
          TIERS_402,
        );
        refused++;
      }
    }
    expect(refused, "refusals checked").toBe(6);
  });

  it("Pro: every tier on the whole org and on a competition passes (8 checked)", async () => {
    const rig = await seedRig("pro");
    let checked = 0;
    for (const tier of SPONSOR_TIERS) {
      for (const scope of [null, rig.compC]) {
        await expect(assertPlacementAllowed(rig.orgId, tier, scope), `${tier} on ${scope ?? "org"}`).resolves.toBeUndefined();
        checked++;
      }
    }
    expect(checked, "placements checked").toBe(8);
  });

  it("Event Pass on C: gold on C passes; gold on the whole org and gold on C' 402 sponsors.tiers; partner org-wide passes", async () => {
    const rig = await seedRig("pass");
    await expect(assertPlacementAllowed(rig.orgId, "gold", rig.compC)).resolves.toBeUndefined();
    await expect(assertPlacementAllowed(rig.orgId, "partner", rig.compC)).resolves.toBeUndefined();
    await expect(assertPlacementAllowed(rig.orgId, "gold", null)).rejects.toMatchObject(TIERS_402);
    await expect(assertPlacementAllowed(rig.orgId, "gold", rig.compOther)).rejects.toMatchObject(TIERS_402);
    await expect(assertPlacementAllowed(rig.orgId, "partner", rig.compOther)).rejects.toMatchObject(TIERS_402);
    await expect(assertPlacementAllowed(rig.orgId, "partner", null)).resolves.toBeUndefined();
  });

  it("a second call answers the same (the gate keeps no state between calls)", async () => {
    const rig = await seedRig("community");
    for (let i = 0; i < 2; i++) {
      await expect(assertPlacementAllowed(rig.orgId, "partner", null)).resolves.toBeUndefined();
      await expect(assertPlacementAllowed(rig.orgId, "gold", null)).rejects.toMatchObject(TIERS_402);
    }
  });
});

describe.skipIf(!HAS_DB)("assertOnlineAllowed — spec §8 (online needs sponsors.monetize, scoped to the deal's competition)", () => {
  it("community: 402 sponsors.monetize on the whole org and on a competition", async () => {
    const rig = await seedRig("community");
    await expect(assertOnlineAllowed(rig.orgId, null)).rejects.toMatchObject(MONETIZE_402);
    await expect(assertOnlineAllowed(rig.orgId, rig.compC)).rejects.toMatchObject(MONETIZE_402);
  });

  it("Event Pass on C: passes on C; 402 sponsors.monetize on C' and on the whole org", async () => {
    const rig = await seedRig("pass");
    await expect(assertOnlineAllowed(rig.orgId, rig.compC)).resolves.toBeUndefined();
    await expect(assertOnlineAllowed(rig.orgId, rig.compOther)).rejects.toMatchObject(MONETIZE_402);
    await expect(assertOnlineAllowed(rig.orgId, null)).rejects.toMatchObject(MONETIZE_402);
  });

  it("Pro: passes on the whole org and on a competition", async () => {
    const rig = await seedRig("pro");
    await expect(assertOnlineAllowed(rig.orgId, null)).resolves.toBeUndefined();
    await expect(assertOnlineAllowed(rig.orgId, rig.compC)).resolves.toBeUndefined();
  });
});

describe.skipIf(!HAS_DB)("one predicate (F14): createSponsor's tier gate decides by placementNeedsTiers", () => {
  it("community: gold 402s, partner on a competition 402s, partner on the whole org is created", async () => {
    const rig = await seedRig("community");
    await expect(
      createSponsor(rig.auth, { name: "Big Bank", tier: "gold", status: "active" }),
    ).rejects.toMatchObject(TIERS_402);
    await expect(
      createSponsor(rig.auth, { name: "Scoped Shop", tier: "partner", status: "active", competition_id: rig.compC }),
    ).rejects.toMatchObject(TIERS_402);
    const partner = await createSponsor(rig.auth, { name: "Corner Shop", tier: "partner", status: "active" });
    expect(partner.tier).toBe("partner");
    expect(partner.competition_id).toBeNull();
    // Only the org-wide partner landed: the refusals wrote nothing.
    const rows = await sql<{ name: string }[]>`select name from sponsors where org_id = ${rig.orgId} order by name`;
    expect(rows.map((r) => r.name)).toEqual(["Corner Shop"]);
  });
});
