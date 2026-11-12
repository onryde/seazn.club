// Competition-delete money guards (payments-hardening spec P0-1). A CASCADE
// delete would erase the app's only record of live money — the Event Pass,
// paid registrations, and comp-scoped sponsor orders. deleteCompetition must
// 409 with the archive hint instead. Fully-refunded money still deletes.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, deleteCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

// Seed a Pro org holding one competition with one (empty) division, and hand
// back the ids the guards key off. Mirrors division-delete.test.ts's local
// seeding: org/subscription/sports via SQL, comp/division via the use-cases.
async function seedCompWithDivision(): Promise<{
  auth: AuthCtx;
  orgId: string;
  compId: string;
  divId: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Money " + suffix}, ${"money-" + suffix})
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
  const auth: AuthCtx = {
    orgId,
    via: "session",
    userId: null,
    role: "owner",
    keyId: null,
  };
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Cup ${randomUUID().slice(0, 6)}`,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: `open-${randomUUID().slice(0, 6)}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  return { auth, orgId, compId: comp.id, divId: division.id };
}

/** A cart in `divId`; each entry carries its own intent (stamped as the webhook stamps the entry a session paid) and its own
 *  totals (a refund books entry and cart). The cart's amount is the entries' sum. */
async function seedCart(
  compId: string,
  divId: string,
  entries: { amount: number; status: string; intent: string | null; refunded?: number; late?: number }[],
  cart: { intent: string; refunded: number },
): Promise<void> {
  const [{ id: groupId }] = await sql<{ id: string }[]>`
    insert into registration_groups
      (competition_id, contact_name, contact_email, access_token_hash,
       amount_cents, currency, payment_intent_id, refunded_cents)
    values (${compId}, 'P', 'p@x.test', ${randomUUID()}, ${entries.reduce((a, e) => a + e.amount, 0)}, 'gbp',
            ${cart.intent}, ${cart.refunded})
    returning id`;
  for (const e of entries) {
    await sql`insert into registrations
        (division_id, group_id, status, display_name, amount_cents, payment_intent_id, refunded_cents, late_refunded_cents)
      values (${divId}, ${groupId}, ${e.status}, 'P', ${e.amount}, ${e.intent}, ${e.refunded ?? 0}, ${e.late ?? 0})`;
  }
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("deleteCompetition money guards", () => {
  it("409s when the competition holds an Event Pass", async () => {
    const { auth, compId, orgId } = await seedCompWithDivision();
    await sql`insert into competition_passes (competition_id, org_id, stripe_payment_intent)
              values (${compId}, ${orgId}, 'pi_test_pass')`;
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Event Pass"),
    });
  });

  it("409s when a registration has unrefunded card money", async () => {
    const { auth, compId, divId } = await seedCompWithDivision();
    // Seeded as the webhook writes a card payment: the intent on the cart AND on the entry it paid (`checkout-completion.ts`,
    // V387) - the guard reads the entry's own.
    await seedCart(compId, divId, [{ amount: 2000, status: "paid", intent: "pi_reg" }], { intent: "pi_reg", refunded: 0 });
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("card payments"),
    });
  });

  // Polish wave P5 (P1-review carry d): the guard read the CART's totals, which never clear while a cart holds an unpaid entry
  // beside a paid-and-refunded one - the competition could never be deleted although no money was held.
  it("still deletes when the cart's only payment was refunded, though an unpaid sibling keeps the cart's totals apart", async () => {
    const { auth, compId, divId } = await seedCompWithDivision();
    const intent = "pi_" + randomUUID().slice(0, 8);
    await seedCart(
      compId,
      divId,
      [
        { amount: 1500, status: "withdrawn", intent, refunded: 1500 },
        { amount: 1000, status: "pending", intent: null },
      ],
      { intent, refunded: 1500 },
    );
    await deleteCompetition(auth, compId);
    const [gone] = await sql`select 1 from competitions where id = ${compId}`;
    expect(gone).toBeUndefined();
  });

  it("409s for an entry that paid again after its late payment was refunded (only its current payment's refunds count)", async () => {
    const { auth, compId, divId } = await seedCompWithDivision();
    const intent = "pi_" + randomUUID().slice(0, 8);
    // The late payment's refund is booked as history AND late (`checkout-completion.ts`, V512), on both totals.
    await seedCart(compId, divId, [{ amount: 500, status: "confirmed", intent, refunded: 500, late: 500 }], { intent, refunded: 500 });
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("card payments"),
    });
  });

  it("409s when a paid sponsor order is scoped to this comp via its package", async () => {
    const { auth, compId, orgId } = await seedCompWithDivision();
    const [pkg] = await sql<{ id: string }[]>`
      insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier)
      values (${orgId}, ${compId}, 'Gold', 25000, 'gbp', 'gold') returning id`;
    // A deal always has its sponsor (sponsor_orders_sponsor_or_legacy): a live, online, on-payment deal with paid money,
    // snapshotting its package (sponsor deals F4/F5).
    const [sp] = await sql<{ id: string }[]>`
      insert into sponsors (org_id, competition_id, name, tier, status)
      values (${orgId}, ${compId}, 'S', 'gold', 'active') returning id`;
    await sql`insert into sponsor_orders
      (org_id, package_id, sponsor_name, sponsor_email, amount_cents, currency, status, paid_at, sponsor_id,
       deal_status, payment_method, go_live, live_at, tier, includes_on_stream, package_name, competition_id)
      values (${orgId}, ${pkg.id}, 'S', 's@x.test', 25000, 'gbp', 'paid', now(), ${sp.id},
              'live', 'online', 'on_payment', now(), 'gold', false, 'Gold', ${compId})`;
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("still deletes when money is fully refunded", async () => {
    const { auth, compId, divId } = await seedCompWithDivision();
    await seedCart(compId, divId, [{ amount: 2000, status: "withdrawn", intent: "pi_reg2", refunded: 2000 }], {
      intent: "pi_reg2",
      refunded: 2000,
    });
    await deleteCompetition(auth, compId);
    const [gone] = await sql`select 1 from competitions where id = ${compId}`;
    expect(gone).toBeUndefined();
  });
});
