// Sponsor monetization (v10 PROMPT-56): package CRUD gating, Connect
// checkout as a destination charge on the entry-fee rail, and replay-safe
// webhook activation. Stripe is stubbed at the getStripe() seam
// (registrations.test.ts pattern); real Postgres required.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn();
  const refundCreate = vi.fn();
  return {
    checkoutCreate,
    refundCreate,
    stripe: {
      checkout: { sessions: { create: checkoutCreate } },
      refunds: { create: refundCreate },
    },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

const emailMock = vi.hoisted(() => ({
  invoice: vi.fn().mockResolvedValue(true),
  receipt: vi.fn().mockResolvedValue(true),
  refund: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendSponsorInvoiceEmail: emailMock.invoice,
  sendSponsorReceiptEmail: emailMock.receipt,
  sendSponsorRefundEmail: emailMock.refund,
}));

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  createSponsorPackage,
  deactivateSponsorPackage,
  handleSponsorChargeRefunded,
  handleSponsorPaymentFailed,
  handleSponsorPaymentSucceeded,
  listSponsorRows,
  refundSponsorOrder,
  startSponsorCheckout,
  type SponsorPackageRow,
} from "../sponsors";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(
  plan: "community" | "pro",
  connect = true,
): Promise<{ auth: AuthCtx; orgId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, stripe_account_id, stripe_charges_enabled)
    values (${"Mon " + suffix}, ${"mon-" + suffix},
            ${connect ? "acct_" + suffix : null}, ${connect})
    returning id`;
  if (plan !== "community") {
    await setOrgPlan(orgId, plan);
  }
  await invalidateOrgEntitlements(orgId);
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
    orgId,
  };
}

function fakeIntent(orderId: string, packageId = "", orgId = ""): Stripe.PaymentIntent {
  return {
    id: `pi_${randomUUID().slice(0, 8)}`,
    metadata: {
      kind: "sponsor",
      order_id: orderId,
      package_id: packageId,
      org_id: orgId,
    },
  } as unknown as Stripe.PaymentIntent;
}

beforeEach(() => {
  stripeMock.checkoutCreate.mockReset();
  stripeMock.refundCreate.mockReset().mockResolvedValue({ id: "re_test" });
  emailMock.invoice.mockClear();
  emailMock.receipt.mockClear();
  emailMock.refund.mockClear();
});

describe.skipIf(!HAS_DB)("sponsor monetization", () => {
  it("packages are Pro sponsors.monetize; deactivate is a soft flip", async () => {
    const { auth: free } = await seedOrg("community");
    await expect(
      createSponsorPackage(free, {
        name: "Gold",
        price_cents: 10_000,
        currency: "gbp",
        tier: "gold",
      }),
    ).rejects.toMatchObject({ status: 402 });

    const { auth: pro } = await seedOrg("pro");
    const pkg = await createSponsorPackage(pro, {
      name: "Gold",
      price_cents: 10_000,
      currency: "gbp",
      tier: "gold",
    });
    const retired = await deactivateSponsorPackage(pro, pkg.id);
    expect(retired.active).toBe(false);
  });

  it("refuses checkout when the org is not Connect-onboarded (409)", async () => {
    const { auth } = await seedOrg("pro", false);
    const pkg = await createSponsorPackage(auth, {
      name: "Silver",
      price_cents: 5_000,
      currency: "gbp",
      tier: "silver",
    });
    await expect(
      startSponsorCheckout(
        auth,
        {
          package_id: pkg.id,
          sponsor_name: "Acme",
          sponsor_email: "a@acme.test",
        },
        "https://app.test",
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
    // No half-started rail: the refusal happens before the order row exists.
    const orders = await sql<{ id: string }[]>`
      select id from sponsor_orders where org_id = ${auth.orgId}`;
    expect(orders).toHaveLength(0);
  });

  /**
   * W8 Task 9's mutation sweep, finding F21 — the fifth gate, and the only one
   * of the five on a live money path.
   *
   * `startSponsorCheckout` gates `sponsors.monetize` (`sponsors.ts:465`) before
   * it mints a real Stripe Checkout Session on the org's connected account.
   * Mutating that call to `.catch(() => undefined)` left all 13 tests across
   * this file, `sponsors.test.ts` and `pass-scope-sponsors-write.test.ts` green
   * — nothing in the repo reddened. Every checkout case here seeds a `pro` org
   * with the key granted, and the walkthrough spec that drives this path
   * (`settings-sponsor-monetize.spec.ts`) is a Pro happy path whose only
   * override sets the key to TRUE.
   *
   * The deny has to be written AFTER the package exists: a community org
   * cannot create a package at all (`createSponsorPackage`'s own
   * `sponsors.monetize` gate at `:380`, proven by the first test in this file),
   * so the state this gate exists for is the org that sold a package and then
   * LOST the key — a staff deny for abuse or chargeback risk, or a downgrade.
   * If it regressed, that org would keep minting real Checkout Sessions.
   *
   * The org is deliberately Connect-live, so the 409 Connect refusal one line
   * below the gate cannot be what answers; and the positive pair runs on the
   * SAME org with the deny lifted, so an over-refusing guard — or a broken
   * fixture — cannot satisfy this test.
   */
  it("refuses checkout with 402 sponsors.monetize when the key is denied, before any order row — and mints once it is back", async () => {
    const { auth, orgId } = await seedOrg("pro");
    const pkg = await createSponsorPackage(auth, {
      name: "Revoked package",
      price_cents: 12_000,
      currency: "gbp",
      tier: "gold",
    });

    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${orgId}, 'sponsors.monetize', false, 'test: W8 F21 gate coverage')
      on conflict (org_id, feature_key) do update set bool_value = false`;
    await invalidateOrgEntitlements(orgId);

    // Stripe is armed to SUCCEED for the refused call. Without this the gate's
    // own mutant (`requireFeature(…).catch(() => undefined)`) reds this test on
    // an incidental `TypeError` from reading `.url` off an unmocked create —
    // the test fails, but for the wrong reason and with a message that does not
    // say "the guard did not fire". Armed, the mutant produces a real session
    // and the assertions below name exactly that.
    stripeMock.checkoutCreate.mockResolvedValue({
      id: "cs_must_not_be_minted",
      url: "https://stripe.test/must-not-be-minted",
    });

    await expect(
      startSponsorCheckout(
        auth,
        {
          package_id: pkg.id,
          sponsor_name: "Acme",
          sponsor_email: "a@acme.test",
        },
        "https://app.test",
      ),
    ).rejects.toMatchObject({ status: 402, featureKey: "sponsors.monetize" });
    // The ENTITLEMENT answered, not the Connect gate below it — this org has a
    // connected account, so a 409 here would mean the gate under test is gone.
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
    // No half-written rail either: the refusal happens before the order insert.
    const none = await sql<{ id: string }[]>`
      select id from sponsor_orders where org_id = ${orgId}`;
    expect(none).toHaveLength(0);

    // The positive pair, same org, same package: lift the deny and the exact
    // call above succeeds. Without it, a guard that refused EVERY checkout
    // would pass the assertions above.
    await sql`
      delete from org_entitlement_overrides
       where org_id = ${orgId} and feature_key = 'sponsors.monetize'`;
    await invalidateOrgEntitlements(orgId);
    stripeMock.checkoutCreate.mockResolvedValue({
      id: "cs_regranted",
      url: "https://stripe.test/regranted",
    });
    const { order, checkout_url } = await startSponsorCheckout(
      auth,
      {
        package_id: pkg.id,
        sponsor_name: "Acme",
        sponsor_email: "a@acme.test",
      },
      "https://app.test",
    );
    expect(checkout_url).toBe("https://stripe.test/regranted");
    expect(order.status).toBe("pending");
  });

  it("checkout: pending order first, destination charge with fee + metadata + idempotency", async () => {
    const { auth, orgId } = await seedOrg("pro");
    const pkg = await createSponsorPackage(auth, {
      name: "Title package",
      price_cents: 50_000,
      currency: "gbp",
      tier: "title",
    });

    let orderExistedAtCreate = false;
    stripeMock.checkoutCreate.mockImplementation(
      async (params: { metadata: { order_id: string } }) => {
        const rows = await sql<{ status: string }[]>`
          select status from sponsor_orders where id = ${params.metadata.order_id}`;
        orderExistedAtCreate = rows[0]?.status === "pending";
        return { id: "cs_test", url: "https://stripe.test/session" };
      },
    );

    const { order, checkout_url } = await startSponsorCheckout(
      auth,
      {
        package_id: pkg.id,
        sponsor_name: "Acme Corp",
        sponsor_email: "pay@acme.test",
      },
      "https://app.test",
    );
    expect(checkout_url).toBe("https://stripe.test/session");
    expect(order.status).toBe("pending");
    expect(orderExistedAtCreate).toBe(true); // row inserted BEFORE the Stripe call

    const [params, opts] = stripeMock.checkoutCreate.mock.calls[0]!;
    expect(opts).toEqual({ idempotencyKey: `sponsor-order-${order.id}` });
    expect(params.metadata).toMatchObject({
      kind: "sponsor",
      order_id: order.id,
      org_id: orgId,
    });
    expect(params.line_items[0].price_data.unit_amount).toBe(50_000);
    expect(params.payment_intent_data).toMatchObject({
      // Pro entry-fee percent is 2 → 2% of 50000.
      application_fee_amount: 1000,
      transfer_data: { destination: expect.stringMatching(/^acct_/) },
      metadata: {
        kind: "sponsor",
        order_id: order.id,
        package_id: pkg.id,
        org_id: orgId,
      },
    });

    expect(emailMock.invoice).toHaveBeenCalledOnce();
    expect(emailMock.invoice.mock.calls[0]![0]).toMatchObject({
      to: "pay@acme.test",
      checkoutUrl: "https://stripe.test/session",
      amountCents: 50_000,
    });
  });

  it("webhook: paid activates exactly once under replay; failed flips pending only", async () => {
    const { auth, orgId } = await seedOrg("pro");
    stripeMock.checkoutCreate.mockResolvedValue({
      id: "cs_x",
      url: "https://stripe.test/s",
    });
    const pkg = await createSponsorPackage(auth, {
      name: "Gold package",
      price_cents: 20_000,
      currency: "gbp",
      tier: "gold",
    });
    const { order } = await startSponsorCheckout(
      auth,
      {
        package_id: pkg.id,
        sponsor_name: "Bolt Ltd",
        sponsor_email: "b@bolt.test",
      },
      "https://app.test",
    );

    const intent = fakeIntent(order.id, pkg.id, orgId);
    await handleSponsorPaymentSucceeded(intent);
    await handleSponsorPaymentSucceeded(intent); // /admin/billing-events replay

    const sponsors = await sql<{ id: string; tier: string; status: string }[]>`
      select id, tier, status from sponsors where org_id = ${orgId} and name = 'Bolt Ltd'`;
    expect(sponsors).toHaveLength(1); // no double activation
    expect(sponsors[0]).toMatchObject({ tier: "gold", status: "active" });

    const [paid] = await sql<
      { status: string; sponsor_id: string | null; payment_intent_id: string }[]
    >`
      select status, sponsor_id, payment_intent_id from sponsor_orders where id = ${order.id}`;
    expect(paid).toMatchObject({
      status: "paid",
      sponsor_id: sponsors[0]!.id,
      payment_intent_id: intent.id,
    });
    expect(emailMock.receipt).toHaveBeenCalledOnce();
    // The "See it live" link must be absolute — mail clients have no origin
    // to resolve "/shared/…" against (stg regression: NEXT_PUBLIC_APP_URL was
    // never set anywhere, so every receipt shipped a relative link).
    expect(emailMock.receipt.mock.calls[0]![0]).toMatchObject({
      publicUrl: expect.stringMatching(/^https?:\/\/.+\/shared\//),
    });

    // A late failure event never clobbers the paid order.
    await handleSponsorPaymentFailed(intent);
    const [still] = await sql<{ status: string }[]>`
      select status from sponsor_orders where id = ${order.id}`;
    expect(still.status).toBe("paid");

    // The manager list ties the bought placement back to its order.
    const listed = await listSponsorRows(orgId);
    expect(listed.find((s) => s.name === "Bolt Ltd")?.paid_order_id).toBe(order.id);

    // charge.refunded (dashboard refund): order → refunded, placement off
    // the public pages; a replay is a no-op.
    const charge = {
      id: "ch_refund",
      payment_intent: intent.id,
      refunded: true,
    } as unknown as Stripe.Charge;
    await handleSponsorChargeRefunded(charge);
    await handleSponsorChargeRefunded(charge);
    const [refunded] = await sql<{ status: string }[]>`
      select status from sponsor_orders where id = ${order.id}`;
    expect(refunded.status).toBe("refunded");
    const [inactive] = await sql<{ status: string }[]>`
      select status from sponsors where id = ${sponsors[0]!.id}`;
    expect(inactive.status).toBe("inactive");

    // A stray non-sponsor refunded charge touches nothing.
    await expect(
      handleSponsorChargeRefunded({
        id: "ch_stray",
        payment_intent: "pi_not_ours",
        refunded: true,
      } as unknown as Stripe.Charge),
    ).resolves.toBeUndefined();
  });

  it("console refund: entry-fee shape, order → refunded, placement deactivated", async () => {
    const { auth, orgId } = await seedOrg("pro");
    stripeMock.checkoutCreate.mockResolvedValue({
      id: "cs_r",
      url: "https://stripe.test/s",
    });
    const pkg = await createSponsorPackage(auth, {
      name: "Silver package",
      price_cents: 8_000,
      currency: "gbp",
      tier: "silver",
    });
    const { order } = await startSponsorCheckout(
      auth,
      {
        package_id: pkg.id,
        sponsor_name: "Refundable Ltd",
        sponsor_email: "r@ref.test",
      },
      "https://app.test",
    );
    // Refunding an unpaid order is refused before Stripe is touched.
    await expect(refundSponsorOrder(auth, order.id)).rejects.toMatchObject({
      status: 422,
    });
    expect(stripeMock.refundCreate).not.toHaveBeenCalled();

    await handleSponsorPaymentSucceeded(fakeIntent(order.id, pkg.id, orgId));
    const refunded = await refundSponsorOrder(auth, order.id);
    expect(refunded.status).toBe("refunded");

    const [params, opts] = stripeMock.refundCreate.mock.calls[0]!;
    expect(params).toMatchObject({
      reverse_transfer: true,
      refund_application_fee: true,
    });
    expect(params.payment_intent).toMatch(/^pi_/);
    expect(opts).toEqual({ idempotencyKey: `sponsor-refund-${order.id}` });

    const [sponsor] = await sql<{ status: string }[]>`
      select status from sponsors where org_id = ${orgId} and name = 'Refundable Ltd'`;
    expect(sponsor.status).toBe("inactive");

    // The sponsor hears about it — once (the later Stripe event replay
    // finds the order already refunded and stays silent).
    expect(emailMock.refund).toHaveBeenCalledOnce();
    expect(emailMock.refund.mock.calls[0]![0]).toMatchObject({
      to: "r@ref.test",
      amountCents: 8_000,
      packageName: "Silver package",
    });
  });

  it("webhook: pending order fails on payment_failed; stray intents are ignored", async () => {
    const { auth, orgId } = await seedOrg("pro");
    stripeMock.checkoutCreate.mockResolvedValue({
      id: "cs_y",
      url: "https://stripe.test/s",
    });
    const pkg = await createSponsorPackage(auth, {
      name: "Partner package",
      price_cents: 3_000,
      currency: "gbp",
      tier: "partner",
    });
    const { order } = await startSponsorCheckout(
      auth,
      {
        package_id: pkg.id,
        sponsor_name: "Slow Pay",
        sponsor_email: "s@slow.test",
      },
      "https://app.test",
    );

    await handleSponsorPaymentFailed(fakeIntent(order.id));
    const [failed] = await sql<{ status: string }[]>`
      select status from sponsor_orders where id = ${order.id}`;
    expect(failed.status).toBe("failed");

    // Non-sponsor intent (registration entry fee): both handlers no-op.
    const stray = {
      id: "pi_stray",
      metadata: { registration_id: randomUUID(), org_id: orgId },
    } as unknown as Stripe.PaymentIntent;
    await expect(handleSponsorPaymentSucceeded(stray)).resolves.toBeUndefined();
    await expect(handleSponsorPaymentFailed(stray)).resolves.toBeUndefined();
    const sponsors = await sql<{ id: string }[]>`
      select id from sponsors where org_id = ${orgId}`;
    expect(sponsors).toHaveLength(0);
    expect(emailMock.receipt).not.toHaveBeenCalled();
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});
