// Phase 3 wave 2, Batch B: the sponsor's money mail goes through the email outbox.
//   - Email 3, `sponsor_invoice`: a checkout queues the pay-now invoice to the sponsor contact (a literal address), ref
//     `sponsor_order/<order id>`, once-key the order id, in the org's language. The request makes the first attempt, after the Checkout
//     session is minted.
//   - Email 4, `sponsor_receipt`: the payment webhook queues the receipt to the sponsor contact in the transaction that activates the
//     placement, once per payment intent (once-key the intent id), in the org's language; the worker makes the first attempt. The
//     dispute evidence pack quotes that receipt in the language it was sent in.
//
// Producers under test are driven through their real entry points. Only the network seams are replaced (Stripe, and
// `@/server/email-outbox/transport`). The enqueue is the real one, observed through a spy that calls through, so a test can tell "not
// written because the key was taken" from "never asked".
//
// Sport: not applicable. A sponsor's invoice, receipt and refund notice do not vary by sport (spec, Test strategy 4); the locale is the
// axis that varies.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn();
  const refundCreate = vi.fn();
  return { checkoutCreate, refundCreate, stripe: { checkout: { sessions: { create: checkoutCreate } }, refunds: { create: refundCreate } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

// The one network seam of the outbox.
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

// The enqueue, observed: every call reaches the real writer.
vi.mock("@/server/email-outbox", async (io) => { const m = await io<typeof import("@/server/email-outbox")>(); return { ...m, enqueueEmailOnce: vi.fn(m.enqueueEmailOnce) }; });

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { enqueueEmailOnce, type OutboxKind } from "@/server/email-outbox";
import { idempotencyKey } from "@/server/email-outbox/constants";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { processStripeEvent } from "../billing-events";
import {
  buildSponsorDisputeEvidence,
  deactivateSponsorPackage,
  deleteSponsor,
  handleSponsorChargeRefunded,
  queueSponsorReceipt,
  startSponsorCheckout,
} from "../sponsors";
import { stubOutboxEnv } from "./_invite-mail";
import { cleanUpSponsorOrgs, seedSponsorOrder, seedSponsorOrg } from "./_money-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const INVOICE = "sponsor_invoice" as const;
const RECEIPT = "sponsor_receipt" as const;
const CHECKOUT_URL = "https://checkout.stripe.test/sponsor-session";

const made = { orgIds: [] as string[], userIds: [] as string[] };

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanUpSponsorOrgs(made.orgIds, made.userIds);
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

beforeEach(() => {
  stubOutboxEnv();
  vi.mocked(enqueueEmailOnce).mockClear();
  deliverMock.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_sp_${randomUUID()}` }));
  stripeMock.checkoutCreate.mockReset().mockImplementation(async () => ({ id: `cs_sp_${randomUUID().slice(0, 8)}`, url: CHECKOUT_URL }));
  stripeMock.refundCreate.mockReset().mockImplementation(async () => ({ id: `re_sp_${randomUUID().slice(0, 8)}` }));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fixtures and readers
// ---------------------------------------------------------------------------------------------------------------------------------

const address = (tag: string): string => `sp-${tag}-${randomUUID().slice(0, 8)}@test.local`;

async function sponsorOrg(defaultLocale: "en" | "fr" | "es" | "nl") {
  const s = await seedSponsorOrg({ defaultLocale });
  made.orgIds.push(s.orgId);
  made.userIds.push(s.ownerId);
  return s;
}

/** A sponsor order, its organisation tracked for cleanup. */
async function sponsorOrder(opts: Parameters<typeof seedSponsorOrder>[0]) {
  const o = await seedSponsorOrder(opts);
  made.orgIds.push(o.orgId);
  made.userIds.push(o.ownerId);
  return o;
}

const ownerAuth = (o: { orgId: string; ownerId: string }): AuthCtx => ({ orgId: o.orgId, via: "session", userId: o.ownerId, role: "owner", keyId: null });

/** Stripe's `payment_intent.succeeded` for an order, as the billing webhook receives it. */
const succeeded = (intent: string, orderId: string, kind = "sponsor") =>
  ({ type: "payment_intent.succeeded", data: { object: { id: intent, metadata: { kind, order_id: orderId } } } }) as unknown as Stripe.Event;

/** The enqueue calls the producers made for a kind and order (the spy sees every caller, so it is filtered). */
const enqueueCalls = (kind: OutboxKind, orderId: string) =>
  vi.mocked(enqueueEmailOnce).mock.calls.filter(([, m]) => m.kind === kind && m.refId === orderId);

const sponsorsIn = async (orgId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sponsors where org_id = ${orgId}`)[0]!.n;

type Row = {
  id: string;
  kind: string;
  ref_type: string;
  ref_id: string;
  org_id: string | null;
  recipient: string;
  recipient_user_id: string | null;
  subject: string;
  status: string;
  attempts: number;
  transactional: boolean;
  dedupe_key: string | null;
  cleared: boolean;
};

const rowsOf = (kind: OutboxKind, orderIds: string[]) =>
  sql<Row[]>`
    select id, kind, ref_type, ref_id, org_id, recipient, recipient_user_id, subject, status, attempts, transactional, dedupe_key,
           body_sealed is null as cleared
      from email_outbox
     where kind = ${kind} and ref_id = any(${orderIds}::text[])
     order by created_at, id`;

const rowsTo = (kind: OutboxKind, email: string) =>
  sql<Row[]>`
    select id, kind, ref_type, ref_id, org_id, recipient, recipient_user_id, subject, status, attempts, transactional, dedupe_key,
           body_sealed is null as cleared
      from email_outbox
     where kind = ${kind} and lower(recipient) = lower(${email})`;

type Sent = { to: string; subject: string; text: string; idempotencyKey: string };
const transportCallsFor = (rowId: string): Sent[] =>
  deliverMock.mock.calls.map((c) => c[0] as Sent).filter((c) => c.idempotencyKey === idempotencyKey(rowId));

/** Wait until these orders' rows of a kind have left `queued`/`sending` (the request's attempt runs after it returned). */
async function settled(kind: OutboxKind, orderIds: string[], n: number): Promise<Row[]> {
  await vi.waitFor(
    async () => {
      const rows = await rowsOf(kind, orderIds);
      if (rows.length !== n) throw new Error(`${rows.length} row(s), waiting for ${n}`);
      const open = rows.filter((r) => r.status === "queued" || r.status === "sending");
      if (open.length > 0) throw new Error(`${open.length} row(s) still ${open[0]!.status}`);
    },
    { timeout: 10_000, interval: 50 },
  );
  return rowsOf(kind, orderIds);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Email 3: the invoice, at checkout
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("a sponsor checkout sends its invoice through the outbox (DB)", () => {
  it("a checkout queues one invoice to the sponsor contact in the org's language, and sends it in the request", async () => {
    const s = await sponsorOrg("fr");
    const to = address("invoice");

    const { order, checkout_url } = await startSponsorCheckout(
      s.auth,
      { package_id: s.packageId, sponsor_name: "Acme Corp", sponsor_email: to },
      "https://app.test",
    );
    expect(checkout_url, "premise: the Stripe mock's session URL").toBe(CHECKOUT_URL);

    const [row] = await settled(INVOICE, [order.id], 1);
    expect(row).toMatchObject({
      kind: INVOICE,
      ref_type: "sponsor_order",
      ref_id: order.id,
      dedupe_key: order.id,
      org_id: s.orgId,
      recipient: to,
      recipient_user_id: null,
      transactional: false,
      status: "sent",
      cleared: true,
    });
    const subject = dictionarySubject("fr", "sponsorInvoice.subject", { orgName: s.orgName });
    expect(subject, "the French subject is not the English one").not.toBe(dictionarySubject("en", "sponsorInvoice.subject", { orgName: s.orgName }));
    expect(row!.subject).toBe(subject);
    const calls = transportCallsFor(row!.id);
    expect(calls, "one transport call under the row's key").toHaveLength(1);
    expect(calls[0]).toMatchObject({ to, subject });
    // The mail carries the link Stripe returned (the Stripe mock's own value).
    expect(calls[0]!.text).toContain(CHECKOUT_URL);
  });

  it("two checkouts for one package are two invoices, and neither replaces the other", async () => {
    const s = await sponsorOrg("fr");
    const to = address("twice");

    const first = await startSponsorCheckout(s.auth, { package_id: s.packageId, sponsor_name: "Acme Corp", sponsor_email: to }, "https://app.test");
    const second = await startSponsorCheckout(s.auth, { package_id: s.packageId, sponsor_name: "Acme Corp", sponsor_email: to }, "https://app.test");
    expect(first.order.id, "premise: two orders").not.toBe(second.order.id);

    const rows = await settled(INVOICE, [first.order.id, second.order.id], 2);
    expect(rows.map((r) => r.ref_id).sort()).toEqual([first.order.id, second.order.id].sort());
    // Distinct refs: the replace rule (kind + ref + recipient) pairs neither with the other.
    expect(rows.map((r) => r.status), "neither invoice was replaced").toEqual(["sent", "sent"]);
  });

  it("empty: an inactive package refuses before any order or row", async () => {
    const s = await sponsorOrg("fr");
    await deactivateSponsorPackage(s.auth, s.packageId);
    const to = address("inactive");

    await expect(
      startSponsorCheckout(s.auth, { package_id: s.packageId, sponsor_name: "Acme Corp", sponsor_email: to }, "https://app.test"),
    ).rejects.toMatchObject({ status: 422 });

    const orders = await sql<{ id: string }[]>`select id from sponsor_orders where org_id = ${s.orgId}`;
    expect(orders, "no order was opened").toHaveLength(0);
    expect(await rowsTo(INVOICE, to), "and no invoice was queued").toHaveLength(0);
    expect(vi.mocked(enqueueEmailOnce).mock.calls.filter(([, m]) => m.kind === INVOICE && m.to === to)).toHaveLength(0);
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Email 4: the receipt, when the payment succeeds
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("a paid sponsor order queues its receipt on the outbox (DB)", () => {
  it("a paid sponsor order queues one receipt for the worker, in the org's language", async () => {
    const o = await sponsorOrder({ status: "pending", defaultLocale: "nl" });

    await processStripeEvent(succeeded(o.intent, o.orderId));

    const rows = await rowsOf(RECEIPT, [o.orderId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: RECEIPT,
      ref_type: "sponsor_order",
      ref_id: o.orderId,
      dedupe_key: o.intent,
      org_id: o.orgId,
      recipient: o.sponsorEmail,
      recipient_user_id: null,
      transactional: false,
      status: "queued",
      attempts: 0,
    });
    const subject = dictionarySubject("nl", "sponsorReceipt.subject", { orgName: o.orgName });
    expect(subject, "the Dutch subject is not the English one").not.toBe(dictionarySubject("en", "sponsorReceipt.subject", { orgName: o.orgName }));
    expect(rows[0]!.subject).toBe(subject);
    expect(transportCallsFor(rows[0]!.id), "the webhook did not attempt the send: the first attempt is the worker's").toHaveLength(0);
    // R1: the row was written on the activation's transaction, not on the pool.
    const calls = enqueueCalls(RECEIPT, o.orderId);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0], "the enqueue ran on a transaction handle, not the pool").not.toBe(sql);
    // The placement went live in the same transaction.
    const [order] = await sql<{ status: string; sponsor_id: string | null }[]>`select status, sponsor_id from sponsor_orders where id = ${o.orderId}`;
    expect(order).toMatchObject({ status: "paid" });
    expect(order!.sponsor_id).not.toBeNull();
  });

  it("a redelivered success queues nothing new", async () => {
    const o = await sponsorOrder({ status: "pending", defaultLocale: "nl" });

    await processStripeEvent(succeeded(o.intent, o.orderId));
    await processStripeEvent(succeeded(o.intent, o.orderId)); // Stripe's retry, or an /admin/billing-events replay

    expect(await rowsOf(RECEIPT, [o.orderId])).toHaveLength(1);
    // Asked once: the second delivery finds the order paid and never reaches the once-key.
    expect(enqueueCalls(RECEIPT, o.orderId)).toHaveLength(1);
    expect(await sponsorsIn(o.orgId), "and activated one placement").toBe(1);
  });

  it("the receipt's once-key alone: two transactions for one payment intent queue one receipt", async () => {
    const o = await sponsorOrder({ status: "pending", defaultLocale: "en" });
    const order = { id: o.orderId, org_id: o.orgId, sponsor_name: "Acme Corp", sponsor_email: o.sponsorEmail, amount_cents: 25000, currency: "gbp" };

    const first = await sql.begin((tx) => queueSponsorReceipt(tx, { order, packageName: o.packageName, intentId: o.intent }));
    const second = await sql.begin((tx) => queueSponsorReceipt(tx, { order, packageName: o.packageName, intentId: o.intent }));

    expect(first, "the first call queued a row").not.toBeNull();
    expect(second, "the second is a duplicate: no id, nothing thrown").toBeNull();
    const rows = await rowsOf(RECEIPT, [o.orderId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first, dedupe_key: o.intent, status: "queued" });
  });

  it("the evidence pack quotes the receipt in the language it was sent in", async () => {
    const o = await sponsorOrder({ status: "paid", defaultLocale: "fr" });
    await sql`update sponsor_orders set disputed_at = now(), dispute_id = ${`dp_ev_${randomUUID().slice(0, 8)}`} where id = ${o.orderId}`;

    const pack = await buildSponsorDisputeEvidence(ownerAuth(o), o.orderId, "https://ev.test");

    const vars = { packageName: o.packageName, orgName: o.orgName };
    const fr = dictionarySubject("fr", "sponsorReceipt.textLine", vars);
    const en = dictionarySubject("en", "sponsorReceipt.textLine", vars);
    expect(fr, "premise: the French line is not the English one").not.toBe(en);
    // The names carry no character the pack escapes, so the line appears as the dictionary gives it.
    expect(pack.html).toContain(fr);
    expect(pack.html).not.toContain(en);
  });

  it("the invoice row survives the receipt: one order's invoice and receipt are two rows", async () => {
    const s = await sponsorOrg("en");
    const to = address("both");
    const { order } = await startSponsorCheckout(s.auth, { package_id: s.packageId, sponsor_name: "Acme Corp", sponsor_email: to }, "https://app.test");
    const [invoice] = await settled(INVOICE, [order.id], 1);
    expect(invoice!.status, "premise: the request sent the invoice").toBe("sent");

    await processStripeEvent(succeeded(`pi_sp_${randomUUID().slice(0, 12)}`, order.id));

    const receipts = await rowsOf(RECEIPT, [order.id]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ ref_type: "sponsor_order", ref_id: order.id, recipient: to, status: "queued" });
    // Same ref and recipient, different kinds: the replace rule (kind + ref + recipient) pairs neither with the other.
    const [after] = await rowsOf(INVOICE, [order.id]);
    expect(after!.status, "the invoice was not replaced").toBe("sent");
  });

  it("empty: a payment that is not a sponsor's queues nothing", async () => {
    const o = await sponsorOrder({ status: "pending", defaultLocale: "en" });

    // An entry-fee (or any other) payment naming this order's id in its metadata: not a sponsor payment.
    await processStripeEvent(succeeded(o.intent, o.orderId, "registration_group"));

    expect(await rowsOf(RECEIPT, [o.orderId])).toHaveLength(0);
    expect(enqueueCalls(RECEIPT, o.orderId)).toHaveLength(0);
    const [order] = await sql<{ status: string }[]>`select status from sponsor_orders where id = ${o.orderId}`;
    expect(order!.status, "and the order was not activated").toBe("pending");
  });

  it("a redelivered success after a refund re-activates nothing and queues no receipt", async () => {
    const o = await sponsorOrder({ status: "paid", defaultLocale: "en" });
    await handleSponsorChargeRefunded({ payment_intent: o.intent, refunded: true } as unknown as Stripe.Charge);
    const [refunded] = await sql<{ status: string; sponsor_id: string | null }[]>`select status, sponsor_id from sponsor_orders where id = ${o.orderId}`;
    expect(refunded, "premise: refunded, and the placement it bought is still named").toMatchObject({ status: "refunded", sponsor_id: o.sponsorId });

    await processStripeEvent(succeeded(o.intent, o.orderId));

    expect(await sponsorsIn(o.orgId), "no second placement").toBe(1);
    expect(await rowsOf(RECEIPT, [o.orderId])).toHaveLength(0);
    expect(enqueueCalls(RECEIPT, o.orderId)).toHaveLength(0);
  });

  it("a redelivered success after the organiser deleted the sponsor queues no second receipt", async () => {
    const o = await sponsorOrder({ status: "pending", defaultLocale: "en" });
    await processStripeEvent(succeeded(o.intent, o.orderId));
    expect(await rowsOf(RECEIPT, [o.orderId]), "premise: the first delivery queued the receipt").toHaveLength(1);
    const [paid] = await sql<{ sponsor_id: string | null }[]>`select sponsor_id from sponsor_orders where id = ${o.orderId}`;

    // The organiser deletes the placement: the order keeps its money record, `sponsor_id` is set null (V283's foreign key).
    await deleteSponsor(ownerAuth(o), paid!.sponsor_id!);
    const [after] = await sql<{ status: string; sponsor_id: string | null }[]>`select status, sponsor_id from sponsor_orders where id = ${o.orderId}`;
    expect(after, "premise: still paid, with no placement").toMatchObject({ status: "paid", sponsor_id: null });

    await processStripeEvent(succeeded(o.intent, o.orderId));

    expect(await sponsorsIn(o.orgId), "no placement was re-created").toBe(0);
    expect(await rowsOf(RECEIPT, [o.orderId])).toHaveLength(1);
    expect(enqueueCalls(RECEIPT, o.orderId), "asked once in total").toHaveLength(1);
  });
});
