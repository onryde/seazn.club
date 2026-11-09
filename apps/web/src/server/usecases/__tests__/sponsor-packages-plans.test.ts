// Sponsor deals, Task 4: packages on every plan, with "On stream" included (plan 2026-11-07-sponsor-deals D17; spec §8
// "Sponsors, packages, offline deals, complimentary deals, approval rule: community Yes"; §10 Q1, owner-confirmed
// 2026-11-07). A package is a placement: it passes the ONE placement gate (Task 3, `assertPlacementAllowed`), and no
// longer `sponsors.monetize` (that key is online selling's, §8). "Another sport" does not apply (sponsors read no sport
// key); its substitute is ANOTHER PLAN: community, Pro, and an Event Pass on one competition C beside its sibling C'.
//
// `used_by` (the brief's definition): the count of DISTINCT sponsors over non-ended, non-legacy deals on the package. Its
// empty case is stated first. Deals are seeded through SQL with every deal column explicit (Task 5's helpers do not
// exist yet), each a shape the V493 CHECKs accept. Expected values come from the spec and the brief, never from
// usecases/sponsors.ts. Real Postgres; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createSponsorPackage, listSponsorPackages, type SponsorPackageRow } from "../sponsors";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

interface Rig {
  orgId: string;
  auth: AuthCtx;
  /** Carries the Event Pass when the rig is "pass". */
  compC: string;
  /** Same org, never passed: the control arm. */
  compOther: string;
}

/** An org on `plan` with two competitions; "pass" holds an Event Pass on C. Community and pass orgs get an explicit
 *  community billing group (the resolver's pass arm fires only while the resolved plan is community). */
async function seedRig(plan: "community" | "pro" | "pass"): Promise<Rig> {
  const s = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Pkg Plans " + s}, ${"pkg-plans-" + s}) returning id`;
  if (plan === "pro") {
    await setOrgPlan(orgId, "pro");
  } else {
    await sql`with _owner as (
        insert into users (email, display_name, email_verified)
        values ('pkgplans-' || gen_random_uuid() || '@test.local', 'Pkg Owner', true)
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
    values (${orgId}, 'Pkg Cup C', ${"pkg-plans-c-" + s}, 'unlisted') returning id`;
  const [{ id: compOther }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, 'Pkg Cup Other', ${"pkg-plans-o-" + s}, 'unlisted') returning id`;
  if (plan === "pass") {
    await sql`insert into competition_passes (competition_id, org_id) values (${compC}, ${orgId})`;
  }
  await invalidateOrgEntitlements(orgId);
  return { orgId, compC, compOther, auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

const TIERS_402 = { status: 402, featureKey: "sponsors.tiers" };

function pkg(over: Partial<Parameters<typeof createSponsorPackage>[1]> = {}): Parameters<typeof createSponsorPackage>[1] {
  return {
    name: "Season partner",
    price_cents: 50_000,
    currency: "gbp",
    tier: "partner",
    includes_on_stream: false,
    ...over,
  };
}

async function sponsorRow(orgId: string, name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, competition_id, name, tier, status)
    values (${orgId}, ${null}, ${name}, 'partner', 'inactive') returning id`;
  return id;
}

/** One OPEN deal (an offline deal awaiting payment, live on payment), every deal column explicit. */
async function openDeal(orgId: string, packageId: string, sponsorId: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into sponsor_orders (org_id, package_id, sponsor_name, sponsor_email, amount_cents, currency, status,
                                sponsor_id, payment_intent_id, paid_at,
                                deal_status, payment_method, go_live, tier, includes_on_stream, package_name,
                                competition_id, ends_at, live_at, ended_at, ended_reason)
    values (${orgId}, ${packageId}, 'Deal Sponsor', ${null}, 50000, 'gbp', 'pending',
            ${sponsorId}, ${null}, ${null},
            'awaiting_payment', 'offline', 'on_payment', 'partner', false, 'Season partner',
            ${null}, ${null}, ${null}, ${null}, ${null})
    returning id`;
  return id;
}

async function usedBy(auth: AuthCtx, packageId: string): Promise<number> {
  const row = (await listSponsorPackages(auth)).find((p) => p.id === packageId);
  expect(row, "the package is listed").toBeDefined();
  return row!.used_by;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("used_by — distinct sponsors with an open (non-ended, non-legacy) deal on the package", () => {
  it("empty case first: a new package has used_by 0, in the create response and in the list", async () => {
    const rig = await seedRig("pro");
    const created = await createSponsorPackage(rig.auth, pkg());
    expect(created.used_by).toBe(0);
    expect(await usedBy(rig.auth, created.id)).toBe(0);
  });

  it("counts 2 for two sponsors with open deals; a sponsor's second open deal counts once; 1 after one ends; legacy and other packages never count", async () => {
    const rig = await seedRig("pro");
    const target = await createSponsorPackage(rig.auth, pkg({ name: "Target" }));
    const other = await createSponsorPackage(rig.auth, pkg({ name: "Other" }));
    const a = await sponsorRow(rig.orgId, "Sponsor A");
    const b = await sponsorRow(rig.orgId, "Sponsor B");

    await openDeal(rig.orgId, target.id, a);
    const bDeal = await openDeal(rig.orgId, target.id, b);
    expect(await usedBy(rig.auth, target.id)).toBe(2);

    // DISTINCT sponsors, not deals: A's second open deal on the same package leaves the count at 2.
    await openDeal(rig.orgId, target.id, a);
    expect(await usedBy(rig.auth, target.id)).toBe(2);

    // B's only deal ends (End now): B no longer uses the package.
    await sql`update sponsor_orders set deal_status = 'ended', ended_at = now(), ended_reason = 'ended_now'
              where id = ${bDeal}`;
    expect(await usedBy(rig.auth, target.id)).toBe(1);

    // A legacy row (an ENDED pre-deals order, the only kind allowed no sponsor) never counts.
    await sql`
      insert into sponsor_orders (org_id, package_id, sponsor_name, sponsor_email, amount_cents, currency, status,
                                  sponsor_id, deal_status, payment_method, go_live, tier, includes_on_stream,
                                  package_name, competition_id, ended_at, ended_reason)
      values (${rig.orgId}, ${target.id}, 'Old Order', 'old@test.local', 50000, 'gbp', 'paid',
              ${null}, 'ended', 'online', 'on_payment', 'partner', false, 'Target', ${null}, now(), 'legacy')`;
    expect(await usedBy(rig.auth, target.id)).toBe(1);

    // The other package's count is its own: none of the target's deals bleed into it.
    expect(await usedBy(rig.auth, other.id)).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("package create on every plan (D17: the placement gate, never sponsors.monetize)", () => {
  it("community: a partner package for any competition is created, includes_on_stream false by default and true when sent", async () => {
    const rig = await seedRig("community");
    const plain = await createSponsorPackage(rig.auth, pkg({ name: "Partner pack" }));
    expect(plain.tier).toBe("partner");
    expect(plain.competition_id).toBeNull();
    expect(plain.includes_on_stream).toBe(false);

    const onStream = await createSponsorPackage(rig.auth, pkg({ name: "Partner on stream", includes_on_stream: true }));
    expect(onStream.includes_on_stream).toBe(true);

    // The list reads the column back (not just the insert's echo).
    const listed = new Map((await listSponsorPackages(rig.auth)).map((p): [string, SponsorPackageRow] => [p.id, p]));
    expect(listed.get(plain.id)?.includes_on_stream).toBe(false);
    expect(listed.get(onStream.id)?.includes_on_stream).toBe(true);
  });

  it("community: a gold package and a partner package scoped to one competition 402 sponsors.tiers, and write nothing", async () => {
    const rig = await seedRig("community");
    await expect(createSponsorPackage(rig.auth, pkg({ name: "Gold", tier: "gold" }))).rejects.toMatchObject(TIERS_402);
    await expect(
      createSponsorPackage(rig.auth, pkg({ name: "Cup partner", competition_id: rig.compC })),
    ).rejects.toMatchObject(TIERS_402);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from sponsor_packages where org_id = ${rig.orgId}`;
    expect(n).toBe(0);
  });

  it("Pro: a gold package is created, on the whole org and on a competition", async () => {
    const rig = await seedRig("pro");
    const gold = await createSponsorPackage(rig.auth, pkg({ name: "Gold", tier: "gold" }));
    expect(gold.tier).toBe("gold");
    const scoped = await createSponsorPackage(rig.auth, pkg({ name: "Cup gold", tier: "gold", competition_id: rig.compC }));
    expect(scoped.competition_id).toBe(rig.compC);
  });

  it("Event Pass on C: a partner package for any competition and a gold package on C are created; gold on C' and gold for any competition 402 sponsors.tiers", async () => {
    const rig = await seedRig("pass");
    const partner = await createSponsorPackage(rig.auth, pkg({ name: "Partner pack" }));
    expect(partner.competition_id).toBeNull();
    const goldC = await createSponsorPackage(rig.auth, pkg({ name: "Gold C", tier: "gold", competition_id: rig.compC }));
    expect(goldC.competition_id).toBe(rig.compC);
    await expect(
      createSponsorPackage(rig.auth, pkg({ name: "Gold other", tier: "gold", competition_id: rig.compOther })),
    ).rejects.toMatchObject(TIERS_402);
    await expect(createSponsorPackage(rig.auth, pkg({ name: "Gold any", tier: "gold" }))).rejects.toMatchObject(TIERS_402);
  });

  it("a second create is a second package: both are listed, each with its own used_by", async () => {
    const rig = await seedRig("community");
    const first = await createSponsorPackage(rig.auth, pkg({ name: "Partner pack" }));
    const second = await createSponsorPackage(rig.auth, pkg({ name: "Partner pack" }));
    expect(second.id).not.toBe(first.id);
    const ids = (await listSponsorPackages(rig.auth)).map((p) => p.id).sort();
    expect(ids).toEqual([first.id, second.id].sort());
  });
});
