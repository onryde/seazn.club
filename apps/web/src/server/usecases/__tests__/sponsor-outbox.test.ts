// Phase 3 wave 2, Batch B: the sponsor's money mail goes through the email outbox.
//   - Email 3, `sponsor_invoice`: a checkout queues the pay-now invoice to the sponsor contact (a literal address), ref
//     `sponsor_order/<order id>`, once-key the order id, in the org's language. The request makes the first attempt, after the Checkout
//     session is minted.
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

import { sql } from "@/lib/db";
import { enqueueEmailOnce, type OutboxKind } from "@/server/email-outbox";
import { idempotencyKey } from "@/server/email-outbox/constants";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { deactivateSponsorPackage, startSponsorCheckout } from "../sponsors";
import { stubOutboxEnv } from "./_invite-mail";
import { cleanUpSponsorOrgs, seedSponsorOrg } from "./_money-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const INVOICE = "sponsor_invoice" as const;
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
