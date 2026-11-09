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
const stripeMock = vi.hoisted(() => ({ checkoutCreate: vi.fn(), refundCreate: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: stripeMock.checkoutCreate } }, refunds: { create: stripeMock.refundCreate } }),
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
  refundSponsorOrder,
  reorderSponsors,
  startSponsorCheckout,
} from "../sponsors";

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

  it("a console refund has fired the org tag ({ expire: 0 }) by the time it resolves: the refunded placement leaves the public page at once", async () => {
    stubOutboxEnv();
    stripeMock.checkoutCreate.mockReset().mockResolvedValue({ id: "cs_x", url: "https://stripe.test/s" });
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
    const { order } = await startSponsorCheckout(pro, { package_id: pkg.id, sponsor_name: "Refundable Ltd", sponsor_email: "r@ref.test" }, "https://app.test");
    await handleSponsorPaymentSucceeded({
      id: `pi_${suffix}`,
      metadata: { kind: "sponsor", order_id: order.id, package_id: pkg.id, org_id: orgId },
    } as unknown as Stripe.PaymentIntent);
    const [live] = await sql<{ status: string }[]>`select status from sponsors where org_id = ${orgId} and name = 'Refundable Ltd'`;
    expect(live?.status, "premise: the paid placement is live before the refund").toBe("active");

    h.tags.length = 0;
    const refunded = await refundSponsorOrder(pro, order.id);
    expect(refunded.status, "premise: the order is refunded").toBe("refunded");
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

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});
