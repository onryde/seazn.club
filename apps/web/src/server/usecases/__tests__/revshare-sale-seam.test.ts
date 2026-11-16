// Revshare sale reporting, driven through the REAL producer and consumer
// (AGENTS.md "inert seam"): a signed-shaped invoice.payment_succeeded event goes
// through runEvent -> dispatch -> handleInvoicePaymentSucceeded -> the DB lookup of
// subscriptions.revshare_ref_code -> reportSale -> fetch. Only the network edge
// (fetch) is stubbed; every expected value below is typed from the Revshare
// contract / the seeded rows, not read back from the code under test.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { runEvent } from "../billing-events";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const REVSHARE_URL = "https://www.revshare.so/api/referral";

(HAS_DB ? describe : describe.skip)("revshare sale reporting (invoice seam)", () => {
  const s = uniq();
  const fetchMock = vi.fn();
  let payerId: string;
  let attributedSub: string; // stripe sub id of the group carrying a ref_code
  let plainSub: string; // a paying group with no attribution
  let attributedGroupId: string;
  let plainGroupId: string;
  let foundingOrgId: string; // the org that founded the attributed group
  const cusA = `cus_rs_${s}`;

  function invoiceEvent(opts: {
    sub: string;
    customer: string;
    invoiceId: string;
    amountPaid: number;
    currency?: string;
    reason?: string | null;
    totalExTax?: number | null;
    eventId?: string;
  }): Stripe.Event {
    return {
      id: opts.eventId ?? `evt_${uniq()}`,
      type: "invoice.payment_succeeded",
      data: {
        object: {
          object: "invoice",
          id: opts.invoiceId,
          customer: opts.customer,
          amount_paid: opts.amountPaid,
          total_excluding_tax: opts.totalExTax === undefined ? opts.amountPaid : opts.totalExTax,
          currency: opts.currency ?? "gbp",
          billing_reason: opts.reason === undefined ? "subscription_cycle" : opts.reason,
          metadata: {},
          lines: { data: [] },
          parent: { subscription_details: { subscription: opts.sub } },
        } as unknown as Stripe.Invoice,
      },
    } as unknown as Stripe.Event;
  }

  const revshareCalls = () => fetchMock.mock.calls.filter(([url]) => url === REVSHARE_URL);
  const bodyOf = (i: number) => JSON.parse(revshareCalls()[i][1].body as string);
  const attributed = (invoiceId: string, extra: Partial<Parameters<typeof invoiceEvent>[0]> = {}) =>
    invoiceEvent({ sub: attributedSub, customer: cusA, invoiceId, amountPaid: 4900, ...extra });

  beforeAll(async () => {
    [{ id: payerId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`rs-seam-${s}@test.local`}, 'Rs Payer', true) returning id`;
    attributedSub = `sub_rs_${s}`;
    plainSub = `sub_plain_${s}`;
    [{ id: attributedGroupId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status, stripe_subscription_id, stripe_customer_id, revshare_ref_code)
      values (${payerId}, 'pro', 'active', ${attributedSub}, ${cusA}, 'aff_frozen') returning id`;
    [{ id: plainGroupId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status, stripe_subscription_id, stripe_customer_id)
      values (${payerId}, 'pro', 'active', ${plainSub}, ${`cus_plain_${s}`}) returning id`;
    [{ id: foundingOrgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by, subscription_id)
      values (${`Founder ${s}`}, ${`founder-${s}`}, ${payerId}, ${attributedGroupId}) returning id`;
    await sql`insert into organizations (name, slug, created_by, subscription_id)
              values (${`Plain ${s}`}, ${`plain-${s}`}, ${payerId}, ${plainGroupId})`;
  });

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("REVSHARE_API_KEY", "rs_seam_key");
    vi.stubEnv("NEXT_PUBLIC_REVSHARE_ENABLED", "1");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  afterAll(async () => { await sql.end({ timeout: 5 }); });

  it("reports a paid invoice: frozen ref_code, invoice id as transaction, cents, GBP", async () => {
    await runEvent(attributed(`in_a_${s}`));
    expect(revshareCalls()).toHaveLength(1);
    const [, init] = revshareCalls()[0];
    expect(init.headers["x-api-key"]).toBe("rs_seam_key");
    expect(bodyOf(0)).toEqual({
      ref_code: "aff_frozen",
      program_id: "6ac5012c6a42960a11fbb86b",
      spent_amount: 4900,
      currency: "GBP",
      transaction_id: `in_a_${s}`,
      customer_id: cusA,
    });
  });

  it("reports the amount EXCLUDING tax (M3): 5880 paid with 20% VAT -> 4900 sent, never 5880", async () => {
    await runEvent(attributed(`in_t_${s}`, { amountPaid: 5880, totalExTax: 4900 }));
    expect(bodyOf(0).spent_amount).toBe(4900);
  });

  it("falls back to the paid amount when Stripe gives no pre-tax total", async () => {
    await runEvent(attributed(`in_nt_${s}`, { totalExTax: null }));
    expect(bodyOf(0).spent_amount).toBe(4900);
  });

  it("never reports more than was paid even if the pre-tax total is larger", async () => {
    await runEvent(attributed(`in_big_${s}`, { amountPaid: 1000, totalExTax: 4900 }));
    expect(bodyOf(0).spent_amount).toBe(1000);
  });

  it.each(["subscription_create", "subscription_cycle"])("billing_reason %s IS reported", async (reason) => {
    await runEvent(attributed(`in_${reason}_${s}`, { reason }));
    expect(revshareCalls()).toHaveLength(1);
  });

  it.each(["subscription_update", "manual", "subscription_threshold", null])(
    "billing_reason %j is NOT reported (proration / add-on / manual are out of scope)",
    async (reason) => {
      await runEvent(attributed(`in_x_${String(reason)}_${s}`, { reason }));
      expect(revshareCalls()).toHaveLength(0);
    },
  );

  it("renewal: a second invoice reports again, same customer_id, NEW transaction_id", async () => {
    await runEvent(attributed(`in_r1_${s}`));
    await runEvent(attributed(`in_r2_${s}`));
    expect(revshareCalls()).toHaveLength(2);
    expect(bodyOf(0).customer_id).toBe(bodyOf(1).customer_id);
    expect(bodyOf(0).transaction_id).not.toBe(bodyOf(1).transaction_id);
  });

  it("a replayed event id reports exactly once", async () => {
    const ev = attributed(`in_d_${s}`);
    await runEvent(ev);
    await runEvent(ev);
    expect(revshareCalls()).toHaveLength(1);
  });

  it("an unattributed group reports nothing (negative pair of the first case)", async () => {
    await runEvent(invoiceEvent({ sub: plainSub, customer: `cus_plain_${s}`, invoiceId: `in_p_${s}`, amountPaid: 4900 }));
    expect(revshareCalls()).toHaveLength(0);
  });

  it("a zero-value invoice reports nothing", async () => {
    await runEvent(attributed(`in_z_${s}`, { amountPaid: 0, totalExTax: 0 }));
    expect(revshareCalls()).toHaveLength(0);
  });

  it("an unknown Stripe subscription reports nothing and does not throw", async () => {
    await runEvent(invoiceEvent({ sub: `sub_nope_${s}`, customer: `cus_x_${s}`, invoiceId: `in_n_${s}`, amountPaid: 4900 }));
    expect(revshareCalls()).toHaveLength(0);
  });

  it("master switch off (stg: dummy key + 0): nothing is reported and the webhook still succeeds", async () => {
    vi.stubEnv("NEXT_PUBLIC_REVSHARE_ENABLED", "0");
    const ev = attributed(`in_off_${s}`);
    await runEvent(ev);
    expect(revshareCalls()).toHaveLength(0);
    const [row] = await sql<{ processed_at: Date | null }[]>`select processed_at from billing_events where id = ${ev.id}`;
    expect(row.processed_at).not.toBeNull();
  });

  it("a Revshare outage never fails the webhook: runEvent resolves and the event is processed", async () => {
    fetchMock.mockRejectedValue(new Error("revshare down"));
    const ev = attributed(`in_o_${s}`);
    await expect(runEvent(ev)).resolves.not.toThrow();
    expect(revshareCalls()).toHaveLength(1);
    const [row] = await sql<{ processed_at: Date | null }[]>`select processed_at from billing_events where id = ${ev.id}`;
    expect(row.processed_at).not.toBeNull();
  });

  // --- group moves (H2): attribution belongs to the PAYER, not to whichever orgs are members today ---

  it("moving the founding org OUT of the group does not drop the group's attribution", async () => {
    const [{ id: elsewhere }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status) values (${payerId}, 'community', 'active') returning id`;
    await sql`update organizations set subscription_id = ${elsewhere} where id = ${foundingOrgId}`;
    try {
      await runEvent(attributed(`in_mv1_${s}`));
      expect(revshareCalls()).toHaveLength(1);
      expect(bodyOf(0).ref_code).toBe("aff_frozen");
    } finally {
      await sql`update organizations set subscription_id = ${attributedGroupId} where id = ${foundingOrgId}`;
    }
  });

  it("attaching an org that came from an attributed group to an UNATTRIBUTED paying group does not attribute it", async () => {
    await sql`update organizations set subscription_id = ${plainGroupId} where id = ${foundingOrgId}`;
    try {
      await runEvent(invoiceEvent({ sub: plainSub, customer: `cus_plain_${s}`, invoiceId: `in_mv2_${s}`, amountPaid: 4900 }));
      expect(revshareCalls()).toHaveLength(0);
    } finally {
      await sql`update organizations set subscription_id = ${attributedGroupId} where id = ${foundingOrgId}`;
    }
  });
});
