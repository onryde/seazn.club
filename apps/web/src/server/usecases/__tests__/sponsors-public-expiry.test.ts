// An organiser's sponsor write expires the org's public pages BEFORE it resolves (R4 PR A, smoke job 128625643038).
//
// The smoke check "v3→v10: free sponsor strip renders publicly, un-tiered" created a free org's partner sponsor and read the
// public competition page 3 ms after the 201: it was served from cache, without the sponsor. The org-tag expiry ran through
// `deferred`, i.e. Next's `after()`, which runs once the response has gone and fires its tags only when every tail task is
// done. The house rule (beside `expireCompetitionShell` in server/public-site/revalidate.ts): a write whose author looks next
// at the public page expires the tag in the request, before the use-case resolves - Next applies a request's revalidations
// when its handler finishes.
//
// Here `after` is a queue that never runs (what a request has done by the time its response goes) and `revalidateTag` a
// recorder, so a bust left to `after()` reads as never fired. Real Postgres; the org is a COMMUNITY org, the smoke's case
// (Partner-only, org-wide: the free tier's whole surface).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({ tails: [] as unknown[], tags: [] as { tag: string; profile: unknown }[] }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (task: unknown) => {
    h.tails.push(task);
  },
}));
vi.mock("next/cache", async (orig) => ({
  ...(await orig<typeof import("next/cache")>()),
  revalidateTag: (tag: string, profile: unknown) => {
    h.tags.push({ tag, profile });
  },
}));
// The console refund's two network seams (sponsor-checkout.test.ts's): Stripe at getStripe(), mail at the outbox transport.
const stripeMock = vi.hoisted(() => ({ checkoutCreate: vi.fn(), refundCreate: vi.fn(), retrieve: vi.fn(), expire: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: stripeMock.checkoutCreate, retrieve: stripeMock.retrieve, expire: stripeMock.expire } },
    refunds: { create: stripeMock.refundCreate },
  }),
}));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn(async () => ({ ok: true, providerId: "re_test" })) }));

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { orgTag } from "@/server/public-site/cache-tags";
import { stubOutboxEnv } from "./_invite-mail";
import {
  createSponsor,
  createSponsorPackage,
  deleteSponsor,
  handleSponsorPaymentSucceeded,
  patchSponsor,
  reorderSponsors,
} from "../sponsors";
import { approveDeal, createDeal, endDealNow, markDealPaid, refundDeal, sendDealInvoice } from "../sponsor-deals";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("an organiser's sponsor write expires the public pages before it resolves", () => {
  let auth: AuthCtx;
  let slug = "";
  let refundOrgId = "";

  beforeEach(() => {
    h.tails.length = 0;
    h.tags.length = 0;
  });

  it("create, edit, reorder, delete - each has fired the org tag ({ expire: 0 }) by the time it resolves, a free org's partner row (4 writes)", async () => {
    slug = `spx-${randomUUID().slice(0, 8)}`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values (${`Spx ${slug}`}, ${slug}) returning id`;
    await invalidateOrgEntitlements(orgId);
    auth = { orgId, via: "session", userId: null, role: "owner", keyId: null };
    const want = { tag: orgTag(slug), profile: { expire: 0 } };
    const writes: [string, () => Promise<unknown>][] = [];
    let firstId = "";
    let secondId = "";
    writes.push(["create", async () => (firstId = (await createSponsor(auth, { name: "Acme Free", tier: "partner", status: "active" })).id)]);
    writes.push(["edit", () => patchSponsor(auth, firstId, { name: "Acme Free Ltd" })]);
    writes.push(["reorder", async () => {
      secondId = (await createSponsor(auth, { name: "Corner Shop", tier: "partner", status: "active" })).id;
      h.tags.length = 0;
      return reorderSponsors(auth, { ids: [secondId, firstId] });
    }]);
    writes.push(["delete", () => deleteSponsor(auth, secondId)]);

    let checked = 0;
    for (const [what, write] of writes) {
      h.tags.length = 0;
      await write();
      // Synchronously after the await: nothing has run in after() (the queue never runs), so only an in-request fire counts.
      expect(h.tags, `${what}: the org's public tag expired before the write resolved, not left to after()`).toContainEqual(want);
      checked++;
    }
    expect(checked, "anti-vacuity: every organiser write was checked").toBe(4);
  });

  // Sponsor deals Task 7/8 (F8): the checkout is an online deal on an existing sponsor, refunded through refundDeal (a charge
  // moved the money, so the refund goes through Stripe). Its webhook leg moves the deal, and the deal puts its OWN sponsor live
  // (Task 8: the webhook never inserts one); nobody reads a webhook's result back at once, so its bust stays `deferred` (F1).
  it("a console refund has fired the org tag ({ expire: 0 }) by the time it resolves: the refunded placement leaves the public page at once", async () => {
    stubOutboxEnv();
    stripeMock.checkoutCreate.mockReset().mockResolvedValue({ id: "cs_x", url: "https://stripe.test/s", expires_at: Math.floor(Date.now() / 1000) + 86_400 });
    stripeMock.refundCreate.mockReset().mockResolvedValue({ id: "re_test" });
    const suffix = randomUUID().slice(0, 8);
    const proSlug = `spr-${suffix}`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, stripe_account_id, stripe_charges_enabled)
      values (${`Spr ${suffix}`}, ${proSlug}, ${`acct_${suffix}`}, true) returning id`;
    refundOrgId = orgId;
    await setOrgPlan(orgId, "pro");
    await invalidateOrgEntitlements(orgId);
    const pro: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
    const pkg = await createSponsorPackage(pro, { name: "Silver package", price_cents: 8_000, currency: "gbp", tier: "silver", includes_on_stream: false });
    const sponsorId = (await createSponsor(pro, { name: "Refundable Ltd", tier: "partner", status: "active" })).id;
    const { deal } = await createDeal(
      pro,
      sponsorId,
      { package_id: pkg.id, competition_id: null, payment_method: "online", go_live: "on_payment", sponsor_email: "r@ref.test", ends_on: null },
      "https://app.test",
    );
    h.tags.length = 0;
    h.tails.length = 0;
    await handleSponsorPaymentSucceeded({
      id: `pi_${suffix}`,
      metadata: { kind: "sponsor", order_id: deal.id, package_id: pkg.id, org_id: orgId },
    } as unknown as Stripe.PaymentIntent);
    const [live] = await sql<{ id: string; status: string }[]>`
      select s.id, s.status from sponsors s join sponsor_orders d on d.sponsor_id = s.id where d.id = ${deal.id}`;
    expect(live?.id, "the deal's EXISTING sponsor, not a new row").toBe(sponsorId);
    expect(live?.status, "premise: the paid placement is live before the refund").toBe("active");
    // The webhook's bust is tail work (F1): nothing fired in the request, one task left to after(), and running it fires the tag.
    expect(h.tags.filter((t) => t.tag === orgTag(proSlug)), "the webhook fires no tag in the request").toEqual([]);
    expect(h.tails, "the webhook leaves its bust to after()").toHaveLength(1);
    await (h.tails[0] as () => Promise<void>)();
    expect(h.tags.map((t) => t.tag), "the deferred bust expires the org's tag").toContain(orgTag(proSlug));

    h.tags.length = 0;
    const refunded = await refundDeal(pro, deal.id);
    expect(refunded.payment_status, "premise: the deal's money is refunded").toBe("refunded");
    expect(stripeMock.refundCreate, "premise: a charge moved this money, so Stripe refunded it").toHaveBeenCalledTimes(1);
    expect(h.tags, "refund: the org's public tag expired before the refund resolved, not left to after()").toContainEqual({
      tag: orgTag(proSlug),
      profile: { expire: 0 },
    });
  });

  afterAll(async () => {
    if (refundOrgId) await sql`delete from email_outbox where org_id = ${refundOrgId}`;
    if (!auth) return;
    await sql`delete from sponsors where org_id = ${auth.orgId}`;
    await sql`delete from organizations where id = ${auth.orgId}`;
  });
});

// Sponsor deals F1 (plan 2026-11-07-sponsor-deals, Task 6): every console deal action is an organiser write the organiser
// reads back on the public page, so each one expires the org tag in the request, and leaves no bust to after().
describe.skipIf(!HAS_DB)("a console deal action expires the public pages before it resolves (F1)", () => {
  let dealOrgId = "";
  let sendOrgId = "";

  beforeEach(() => {
    h.tails.length = 0;
    h.tags.length = 0;
  });

  it("create, mark paid, approve, end and offline refund - each has fired the org tag by the time it resolves, and left nothing to after() (5 actions)", async () => {
    const s = `spd-${randomUUID().slice(0, 8)}`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values (${`Spd ${s}`}, ${s}) returning id`;
    dealOrgId = orgId;
    await invalidateOrgEntitlements(orgId);
    const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
    const want = { tag: orgTag(s), profile: { expire: 0 } };
    const pkgId = (await createSponsorPackage(auth, { name: "Partner", price_cents: 5_000, currency: "gbp", tier: "partner", includes_on_stream: false })).id;
    const sponsorId = (await createSponsor(auth, { name: "Deal Co", tier: "partner", status: "active" })).id;
    const offline = { package_id: pkgId, competition_id: null, payment_method: "offline", sponsor_email: null, ends_on: null, end_current: false } as const;
    let approvalId = "";
    let paidId = "";
    const actions: [string, () => Promise<unknown>][] = [
      ["create", async () => (approvalId = (await createDeal(auth, sponsorId, { ...offline, go_live: "on_approval" }, "https://app.test")).deal.id)],
      ["mark paid", () => markDealPaid(auth, approvalId)],
      ["approve", () => approveDeal(auth, approvalId)],
      ["end", () => endDealNow(auth, approvalId)],
      ["offline refund", async () => {
        paidId = (await createDeal(auth, sponsorId, { ...offline, go_live: "immediate" }, "https://app.test")).deal.id;
        await markDealPaid(auth, paidId);
        h.tags.length = 0;
        h.tails.length = 0;
        return refundDeal(auth, paidId);
      }],
    ];
    let checked = 0;
    for (const [what, act] of actions) {
      h.tags.length = 0;
      h.tails.length = 0;
      await act();
      expect(h.tags, `${what}: the org's public tag expired before the action resolved`).toContainEqual(want);
      expect(h.tails, `${what}: no sponsor bust left to after()`).toEqual([]);
      checked++;
    }
    expect(checked, "anti-vacuity: every console deal action was checked").toBe(5);
  });

  it("send invoice (Task 7) - on a Pro org, a resend has fired the org tag by the time it resolves, and left nothing to after()", async () => {
    stubOutboxEnv();
    stripeMock.checkoutCreate.mockReset().mockResolvedValue({ id: "cs_send", url: "https://stripe.test/send", expires_at: Math.floor(Date.now() / 1000) + 86_400 });
    // The resend reuses the stored link once Stripe says it is still open (review I1).
    stripeMock.retrieve.mockReset().mockImplementation(async (id: string) => ({ id, status: "open" }));
    const s = `spi-${randomUUID().slice(0, 8)}`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, stripe_account_id, stripe_charges_enabled) values (${`Spi ${s}`}, ${s}, ${`acct_${s}`}, true) returning id`;
    sendOrgId = orgId;
    await setOrgPlan(orgId, "pro");
    await invalidateOrgEntitlements(orgId);
    const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
    const pkgId = (await createSponsorPackage(auth, { name: "Partner", price_cents: 5_000, currency: "gbp", tier: "partner", includes_on_stream: false })).id;
    const sponsorId = (await createSponsor(auth, { name: "Invoice Co", tier: "partner", status: "active" })).id;
    const { deal } = await createDeal(
      auth,
      sponsorId,
      { package_id: pkgId, competition_id: null, payment_method: "online", go_live: "on_payment", sponsor_email: "i@inv.test", ends_on: null },
      "https://app.test",
    );
    h.tags.length = 0;
    h.tails.length = 0;
    const sent = await sendDealInvoice(auth, deal.id, "https://app.test");
    expect((await sql<{ checkout_url: string | null }[]>`select checkout_url from sponsor_orders where id = ${deal.id}`)[0]!.checkout_url, "premise: the resend reused the session").toBe("https://stripe.test/send");
    expect(sent.invoice_url, "the answer is the emailed invoice page").toMatch(/^https:\/\/app\.test\/r\/sponsor\/invoice\//);
    expect(h.tags).toContainEqual({ tag: orgTag(s), profile: { expire: 0 } });
    // The invoice's first attempt is the one task a send leaves to after() (the request makes it once it has answered); a bust
    // left there too would make two.
    expect(h.tails, "only the invoice's first attempt is left to after(), no sponsor bust").toHaveLength(1);
  });

  afterAll(async () => {
    for (const id of [dealOrgId, sendOrgId].filter(Boolean)) {
      await sql`delete from email_outbox where org_id = ${id}`;
      await sql`delete from sponsor_orders where org_id = ${id}`;
      await sql`delete from sponsor_invoice_counters where org_id = ${id}`;
      await sql`delete from organizations where id = ${id}`;
    }
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});
