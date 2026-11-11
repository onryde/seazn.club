// Sponsor monetization (v10 PROMPT-56): package CRUD gating, Connect
// checkout as a destination charge on the entry-fee rail, and replay-safe
// webhook activation. Stripe is stubbed at the getStripe() seam
// (registrations.test.ts pattern); real Postgres required.
//
// Sponsor deals Task 7: the checkout is an ONLINE DEAL on an existing sponsor
// (`createDeal`, which sends its invoice); the order IS the deal. The webhook
// legs read the DEAL's sponsor (`sponsor_orders.sponsor_id` after the event),
// so they hold whether the webhook inserts a sponsor (today) or moves the
// deal's own (Task 8, D7).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn();
  const refundCreate = vi.fn();
  const retrieve = vi.fn();
  const expire = vi.fn();
  return {
    checkoutCreate,
    refundCreate,
    retrieve,
    expire,
    stripe: {
      checkout: { sessions: { create: checkoutCreate, retrieve, expire } },
      refunds: { create: refundCreate },
    },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

// The sponsor's mail goes through the email outbox: it is read from its rows and from the outbox's one network seam.
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { idempotencyKey } from "@/server/email-outbox/constants";
import { runOutboxTick } from "@/server/email-outbox/worker";
import { bornAgo } from "@/server/email-outbox/__tests__/_kind-harness";
import { stubOutboxEnv } from "./_invite-mail";
import {
  createSponsorPackage,
  deactivateSponsorPackage,
  handleSponsorChargeRefunded,
  handleSponsorPaymentFailed,
  handleSponsorPaymentSucceeded,
  listSponsorRows,
} from "../sponsors";
import { createDeal, refundDeal, sendDealInvoice } from "../sponsor-deals";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;
/** The orgs this file made: their outbox rows are removed at the end (a queued row must not wait for another file's worker). */
const madeOrgIds: string[] = [];

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
  madeOrgIds.push(orgId);
  if (plan !== "community") {
    await setOrgPlan(orgId, plan);
  }
  await invalidateOrgEntitlements(orgId);
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
    orgId,
  };
}

/** A Checkout session as Stripe answers `create`, alive for a day. */
const session = (id: string, url: string) => ({ id, url, expires_at: Math.floor(Date.now() / 1000) + 86_400 });

/** A sponsor added by hand (the row an online deal is sold on). */
async function addSponsor(orgId: string, name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, name, tier, status) values (${orgId}, ${name}, 'partner', 'active') returning id`;
  return row!.id;
}

/** Sell `packageId` online to a new sponsor `name` billed at `email`: the deal and its first invoice. */
async function sellOnline(auth: AuthCtx, packageId: string, name: string, email: string) {
  const sponsorId = await addSponsor(auth.orgId, name);
  const out = await createDeal(
    auth,
    sponsorId,
    { package_id: packageId, competition_id: null, payment_method: "online", go_live: "on_payment", sponsor_email: email, ends_on: null },
    "https://app.test",
  );
  return { sponsorId, deal: out.deal, checkout_url: out.checkout_url };
}

/** The sponsor a deal names now, and its status and tier. */
async function dealSponsor(dealId: string) {
  const [row] = await sql<{ id: string; status: string; tier: string }[]>`
    select s.id, s.status, s.tier from sponsors s join sponsor_orders d on d.sponsor_id = s.id where d.id = ${dealId}`;
  return row;
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
  stubOutboxEnv();
  deliverMock.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_${randomUUID()}` }));
  stripeMock.checkoutCreate.mockReset();
  stripeMock.refundCreate.mockReset().mockResolvedValue({ id: "re_test" });
  stripeMock.retrieve.mockReset().mockImplementation(async (id: string) => ({ id, status: "open" }));
  stripeMock.expire.mockReset().mockImplementation(async (id: string) => ({ id, status: "expired" }));
});

describe.skipIf(!HAS_DB)("sponsor monetization", () => {
  // Sponsor deals Task 4: packages are on every plan; a GOLD package is a tiered placement, so community is refused it on
  // `sponsors.tiers` (the placement gate), never `sponsors.monetize`. sponsor-packages-plans.test.ts owns the plan sweep.
  it("a gold package needs sponsors.tiers (community 402, Pro created); deactivate is a soft flip", async () => {
    const { auth: free } = await seedOrg("community");
    await expect(
      createSponsorPackage(free, {
        name: "Gold",
        price_cents: 10_000,
        currency: "gbp",
        tier: "gold",
        includes_on_stream: false,
      }),
    ).rejects.toMatchObject({ status: 402, featureKey: "sponsors.tiers" });

    const { auth: pro } = await seedOrg("pro");
    const pkg = await createSponsorPackage(pro, {
      name: "Gold",
      price_cents: 10_000,
      currency: "gbp",
      tier: "gold",
      includes_on_stream: false,
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
      includes_on_stream: false,
    });
    await expect(sellOnline(auth, pkg.id, "Acme", "a@acme.test")).rejects.toMatchObject({ status: 409, code: "connect_required" });
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
   * The checkout gated `sponsors.monetize` before it minted a real Stripe
   * Checkout Session on the org's connected account. Since sponsor deals Task 7
   * that checkout is an online deal: `createDeal` asks the gate before any row
   * (`assertOnlineAllowed`), and `sendDealInvoice` asks it again before every
   * mint, so a resend on an org that lost the key mints nothing either.
   * Mutating that call to `.catch(() => undefined)` left all 13 tests across
   * this file, `sponsors.test.ts` and `pass-scope-sponsors-write.test.ts` green
   * — nothing in the repo reddened. Every checkout case here seeds a `pro` org
   * with the key granted, and the walkthrough spec that drives this path
   * (`settings-sponsor-monetize.spec.ts`) is a Pro happy path whose only
   * override sets the key to TRUE.
   *
   * The deny is written AFTER the package exists: the state this gate exists
   * for is the org that sold a package and then LOST the key (since sponsor
   * deals Task 4 a package itself never reads `sponsors.monetize`, so the
   * checkout is the only gate between such an org and a Checkout Session) —
   * a staff deny for abuse or chargeback risk, or a downgrade.
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
      includes_on_stream: false,
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
    stripeMock.checkoutCreate.mockResolvedValue(session("cs_must_not_be_minted", "https://stripe.test/must-not-be-minted"));

    await expect(sellOnline(auth, pkg.id, "Acme", "a@acme.test")).rejects.toMatchObject({
      status: 402,
      featureKey: "sponsors.monetize",
    });
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
    stripeMock.checkoutCreate.mockResolvedValue(session("cs_regranted", "https://stripe.test/regranted"));
    const { deal, checkout_url } = await sellOnline(auth, pkg.id, "Acme", "a@acme.test");
    expect(checkout_url).toBe("https://stripe.test/regranted");
    expect(deal.payment_status).toBe("pending");

    // A RESEND is the same gate: an org that loses the key after selling cannot mint a fresh session for the deal it holds.
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${orgId}, 'sponsors.monetize', false, 'test: W8 F21 gate coverage (resend)')
      on conflict (org_id, feature_key) do update set bool_value = false`;
    await invalidateOrgEntitlements(orgId);
    await sql`update sponsor_orders set checkout_expires_at = now() + interval '1 minute' where id = ${deal.id}`;
    stripeMock.checkoutCreate.mockClear();
    await expect(sendDealInvoice(auth, deal.id, "https://app.test")).rejects.toMatchObject({
      status: 402,
      featureKey: "sponsors.monetize",
    });
    expect(stripeMock.checkoutCreate, "no fresh session for a denied org").not.toHaveBeenCalled();
    expect(stripeMock.expire, "nor is the open one retired").not.toHaveBeenCalled();
  });

  it("checkout: pending order first, destination charge with fee + metadata + idempotency", async () => {
    const { auth, orgId } = await seedOrg("pro");
    const pkg = await createSponsorPackage(auth, {
      name: "Title package",
      price_cents: 50_000,
      currency: "gbp",
      tier: "title",
      includes_on_stream: false,
    });

    let orderExistedAtCreate = false;
    stripeMock.checkoutCreate.mockImplementation(
      async (params: { metadata: { order_id: string } }) => {
        const rows = await sql<{ status: string }[]>`
          select status from sponsor_orders where id = ${params.metadata.order_id}`;
        orderExistedAtCreate = rows[0]?.status === "pending";
        return session("cs_test", "https://stripe.test/session");
      },
    );

    const { deal: order, checkout_url } = await sellOnline(auth, pkg.id, "Acme Corp", "pay@acme.test");
    expect(checkout_url).toBe("https://stripe.test/session");
    expect(order.payment_status).toBe("pending");
    expect(orderExistedAtCreate).toBe(true); // row inserted BEFORE the Stripe call

    const [params, opts] = stripeMock.checkoutCreate.mock.calls[0]!;
    expect(opts).toEqual({ idempotencyKey: `sponsor-deal-${order.id}-1` });
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

    // The sponsor contact's invoice is one outbox row for this order, sent by the request (after it returned), carrying the
    // numbered invoice page's link and the package's price - never the Checkout link Stripe returned (Task 23, D14).
    await vi.waitFor(
      async () => {
        const [r] = await sql<{ status: string }[]>`
          select status from email_outbox where kind = 'sponsor_invoice' and ref_id = ${order.id}`;
        if (r?.status !== "sent") throw new Error(`the invoice is ${r?.status ?? "not queued"}`);
      },
      { timeout: 10_000, interval: 50 },
    );
    const invoices = await sql<{ id: string; recipient: string }[]>`
      select id, recipient from email_outbox where kind = 'sponsor_invoice' and ref_id = ${order.id}`;
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.recipient).toBe("pay@acme.test");
    const sent = deliverMock.mock.calls
      .map((c) => c[0] as { to: string; text: string; idempotencyKey: string })
      .filter((c) => c.idempotencyKey === idempotencyKey(invoices[0]!.id));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("pay@acme.test");
    expect(sent[0]!.text).toMatch(/\/r\/sponsor\/invoice\/[A-Za-z0-9_-]{20,}/);
    expect(sent[0]!.text).not.toContain("https://stripe.test/session");
    expect(sent[0]!.text).toContain("£500.00");
  });

  it("webhook: paid activates exactly once under replay; failed flips pending only", async () => {
    const { auth, orgId } = await seedOrg("pro");
    stripeMock.checkoutCreate.mockResolvedValue(session("cs_x", "https://stripe.test/s"));
    const pkg = await createSponsorPackage(auth, {
      name: "Gold package",
      price_cents: 20_000,
      currency: "gbp",
      tier: "gold",
      includes_on_stream: false,
    });
    const { deal: order } = await sellOnline(auth, pkg.id, "Bolt Ltd", "b@bolt.test");
    const count = async () => (await sql<{ n: number }[]>`select count(*)::int as n from sponsors where org_id = ${orgId}`)[0]!.n;

    const intent = fakeIntent(order.id, pkg.id, orgId);
    await handleSponsorPaymentSucceeded(intent);
    const afterFirst = await count();
    await handleSponsorPaymentSucceeded(intent); // /admin/billing-events replay
    expect(await count(), "the replay activates nothing more").toBe(afterFirst);

    const placed = await dealSponsor(order.id);
    expect(placed).toMatchObject({ tier: "gold", status: "active" });
    const sponsors = [placed!];

    const [paid] = await sql<
      { status: string; sponsor_id: string | null; payment_intent_id: string }[]
    >`
      select status, sponsor_id, payment_intent_id from sponsor_orders where id = ${order.id}`;
    expect(paid).toMatchObject({
      status: "paid",
      sponsor_id: sponsors[0]!.id,
      payment_intent_id: intent.id,
    });
    // One receipt for the replayed payment: an outbox row the worker sends.
    const receipts = await sql<{ id: string; status: string }[]>`
      select id, status from email_outbox where kind = 'sponsor_receipt' and ref_id = ${order.id}`;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.status).toBe("queued");
    await bornAgo([receipts[0]!.id]);
    await runOutboxTick({ onlyIds: [receipts[0]!.id], sleep: async () => undefined });
    const mailed = deliverMock.mock.calls
      .map((c) => c[0] as { to: string; text: string; idempotencyKey: string })
      .filter((c) => c.idempotencyKey === idempotencyKey(receipts[0]!.id));
    expect(mailed).toHaveLength(1);
    expect(mailed[0]!.to).toBe("b@bolt.test");
    // The "See it live" link must be absolute — mail clients have no origin
    // to resolve "/live/…" against (stg regression: NEXT_PUBLIC_APP_URL was
    // never set anywhere, so every receipt shipped a relative link).
    expect(mailed[0]!.text).toMatch(/^https?:\/\/.+\/live\//m);

    // A late failure event never clobbers the paid order.
    await handleSponsorPaymentFailed(intent);
    const [still] = await sql<{ status: string }[]>`
      select status from sponsor_orders where id = ${order.id}`;
    expect(still.status).toBe("paid");

    // The manager list ties the bought placement back to its order.
    const listed = await listSponsorRows(orgId);
    expect(listed.find((s) => s.id === placed!.id)?.paid_order_id).toBe(order.id);

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
    ).resolves.toBeNull();
  });

  it("console refund: entry-fee shape, order → refunded, placement deactivated", async () => {
    const { auth, orgId } = await seedOrg("pro");
    stripeMock.checkoutCreate.mockResolvedValue(session("cs_r", "https://stripe.test/s"));
    const pkg = await createSponsorPackage(auth, {
      name: "Silver package",
      price_cents: 8_000,
      currency: "gbp",
      tier: "silver",
      includes_on_stream: false,
    });
    const { deal: order } = await sellOnline(auth, pkg.id, "Refundable Ltd", "r@ref.test");
    // Refunding an unpaid deal is refused before Stripe is touched (the deal does not offer it: F12).
    await expect(refundDeal(auth, order.id)).rejects.toMatchObject({
      status: 409,
      code: "deal_not_refundable",
    });
    expect(stripeMock.refundCreate).not.toHaveBeenCalled();

    await handleSponsorPaymentSucceeded(fakeIntent(order.id, pkg.id, orgId));
    const refunded = await refundDeal(auth, order.id);
    expect(refunded.payment_status).toBe("refunded");

    const [params, opts] = stripeMock.refundCreate.mock.calls[0]!;
    expect(params).toMatchObject({
      reverse_transfer: true,
      refund_application_fee: true,
    });
    expect(params.payment_intent).toMatch(/^pi_/);
    expect(opts).toEqual({ idempotencyKey: `sponsor-refund-${order.id}` });

    const sponsor = await dealSponsor(order.id);
    expect(sponsor?.status).toBe("inactive");

    // The sponsor hears about it — once (the later Stripe event replay
    // finds the order already refunded and stays silent): one outbox row,
    // sent by the request after it returned.
    await expect(
      handleSponsorChargeRefunded({ payment_intent: params.payment_intent, refunded: true } as unknown as Stripe.Charge),
    ).resolves.toBeNull();
    await vi.waitFor(
      async () => {
        const [r] = await sql<{ status: string }[]>`
          select status from email_outbox where kind = 'sponsor_refund' and ref_id = ${order.id}`;
        if (r?.status !== "sent") throw new Error(`the refund notice is ${r?.status ?? "not queued"}`);
      },
      { timeout: 10_000, interval: 50 },
    );
    const notices = await sql<{ id: string; recipient: string }[]>`
      select id, recipient from email_outbox where kind = 'sponsor_refund' and ref_id = ${order.id}`;
    expect(notices).toHaveLength(1);
    expect(notices[0]!.recipient).toBe("r@ref.test");
    const mailed = deliverMock.mock.calls
      .map((c) => c[0] as { to: string; text: string; idempotencyKey: string })
      .filter((c) => c.idempotencyKey === idempotencyKey(notices[0]!.id));
    expect(mailed).toHaveLength(1);
    expect(mailed[0]!.text).toContain("Silver package");
    expect(mailed[0]!.text).toContain("£80.00");
  });

  it("webhook: pending order fails on payment_failed; stray intents are ignored", async () => {
    const { auth, orgId } = await seedOrg("pro");
    stripeMock.checkoutCreate.mockResolvedValue(session("cs_y", "https://stripe.test/s"));
    const pkg = await createSponsorPackage(auth, {
      name: "Partner package",
      price_cents: 3_000,
      currency: "gbp",
      tier: "partner",
      includes_on_stream: false,
    });
    const { deal: order, sponsorId } = await sellOnline(auth, pkg.id, "Slow Pay", "s@slow.test");

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
    expect(sponsors.map((r) => r.id), "only the sponsor the deal was sold on").toEqual([sponsorId]);
    const receipts = await sql<{ id: string }[]>`
      select id from email_outbox where kind = 'sponsor_receipt' and org_id = ${orgId}`;
    expect(receipts).toHaveLength(0);
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where org_id = any(${madeOrgIds}::uuid[])`;
  await sql`delete from sponsor_orders where org_id = any(${madeOrgIds}::uuid[])`;
  await sql.end();
});
