// Sponsor deals, Task 23 (plan 2026-11-07-sponsor-deals; spec §7, D13, D14, F9, F13): the invoice EMAIL, its rotation, the
// club's "a sponsor has paid" notice, and the two ways an offline invoice still due after its deal ended is settled (late Mark as
// paid; Write off).
//
// Every producer is the REAL one: `createDeal` / `sendDealInvoice` queue the invoice, the payment webhook goes through the real
// dispatcher (`runEvent` / `processStripeEvent`), the term-end through the real hourly sweep, and the bodies are opened from the
// outbox row with the outbox's own `openBody`. The transport answers 503, so every row keeps its sealed body (a sent row has none to
// open). Every invoice token was minted by the real `mintInvoiceToken` (wrapped, F9) and is resolved by the real `invoiceDocByToken`.
//
// Where each expected value comes from: the words from the four dictionaries (the org's language for the sponsor's invoice, the
// OWNER's for the owner's notice); the number from T20's rule (an org's first invoice is SP-0001, typed here); the amounts from
// the package price the rig sets (£250.00, typed); the links from the route shapes the spec names (`/r/sponsor/invoice/<token>`,
// `/o/<slug>/sponsors?tab=sponsors&sponsor=<id>&deal=<id>`), typed here, never built by the code under test.
// Another sport: not applicable (a deal reads no sport).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { Tx } from "@/lib/db";

const stripe = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), expire: vi.fn(), refund: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: stripe.create, retrieve: stripe.retrieve, expire: stripe.expire } },
    refunds: { create: stripe.refund },
  }),
}));
// 503: every row stays queued with its sealed body for the test to open.
vi.mock("@/server/email-outbox/transport", () => ({
  deliver: async () => ({ ok: false as const, reason: "http" as const, status: 503, errorName: "service_unavailable", detail: "later" }),
}));
/** Every token the real producers minted, in order (F9). */
const minted = vi.hoisted(() => [] as { dealId: string; token: string }[]);
vi.mock("@/server/sponsors/invoice-doc", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/sponsors/invoice-doc")>();
  return {
    ...orig,
    mintInvoiceToken: vi.fn(async (tx: Tx, dealId: string) => {
      const token = await orig.mintInvoiceToken(tx, dealId);
      minted.push({ dealId, token });
      return token;
    }),
  };
});
/** T23 review m1: a one-shot hook run before the `at`-th `withTenant` call once armed - a writer landing between a send's
 *  unlocked read (call 1, `preflight`) and its locked transaction (call 2). Disarmed, every call passes straight through. */
const gap = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>), at: 0, calls: 0, fired: 0 }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const withTenant = (async (...args: Parameters<typeof actual.withTenant>) => {
    if (gap.hook) {
      gap.calls++;
      if (gap.calls === gap.at) {
        const hook = gap.hook;
        gap.hook = null;
        gap.fired++;
        await hook();
      }
    }
    return actual.withTenant(...args);
  }) as typeof actual.withTenant;
  return { ...actual, withTenant };
});
// The owner's notice renderer, wrapped so the atomicity case can make it fail once.
vi.mock("@/lib/email", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/email")>();
  return { ...orig, sponsorDealPaidEmail: vi.fn(orig.sponsorDealPaidEmail) };
});

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { sponsorDealPaidEmail } from "@/lib/email";
import { getDictionary, t } from "@/lib/i18n";
import { openBody } from "@/server/email-outbox/seal";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { invoiceDocByToken } from "@/server/sponsors/invoice-doc";
import { processStripeEvent, replayEvent, runEvent } from "@/server/usecases/billing-events";
import {
  INVOICE_EMAILS_PER_DAY,
  createDeal,
  endDealNow,
  markDealPaid,
  refundDeal,
  sendDealInvoice,
  sweepSponsorDeals,
  writeOffDeal,
} from "@/server/usecases/sponsor-deals";
import { stubOutboxEnv } from "./_invite-mail";
import {
  ORIGIN,
  cleanUp,
  dealInput,
  idempotentCreate,
  rigOrg,
  rigPackage,
  rigSponsor,
  uniq,
  type RigOrg,
} from "@/server/sponsors/__tests__/_invoice-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const BANK = "Riverside Shuttlers\nSort code 12-34-56\nAccount 12345678";
/** The rig's package price, as an email prints it (en-GB money, every locale). */
const AMOUNT = "£250.00";
/** The webhook origin the owner's notice links from (`sponsorEmailOrigin`: OAUTH_BASE_URL first). */
const APP = "https://app.seazn.test";
const eventIds: string[] = [];

beforeEach(() => {
  minted.length = 0;
  Object.assign(gap, { hook: null, at: 0, calls: 0, fired: 0 });
  stubOutboxEnv();
  vi.stubEnv("OAUTH_BASE_URL", APP);
  stripe.create.mockReset().mockImplementation(idempotentCreate());
  stripe.retrieve.mockReset().mockImplementation(async (id: string) => ({ id, status: "open" }));
  stripe.expire.mockReset().mockImplementation(async (id: string) => ({ id, status: "expired" }));
  stripe.refund.mockReset();
  vi.mocked(sponsorDealPaidEmail).mockClear();
});
afterAll(async () => {
  if (!HAS_DB) return;
  if (eventIds.length > 0) await sql`delete from billing_events where id = any(${eventIds}::text[])`;
  await cleanUp();
});

type Row = { id: string; status: string; recipient: string; recipient_user_id: string | null; subject: string; text: string; html: string };

/** The rows of `kind` about deal `dealId`, oldest first, their bodies opened. A row a newer one for the same deal and address
 *  REPLACED (the outbox's replace rule: a resend supersedes an invoice still waiting to go) has no body left; its text reads "". */
async function rowsOf(kind: "sponsor_invoice" | "sponsor_deal_paid" | "sponsor_receipt", dealId: string): Promise<Row[]> {
  const rows = await sql<{ id: string; status: string; recipient: string; recipient_user_id: string | null; subject: string; body_sealed: Buffer | null }[]>`
    select id, status, recipient, recipient_user_id, subject, body_sealed from email_outbox
     where kind = ${kind} and ref_type = 'sponsor_order' and ref_id = ${dealId}
     order by created_at, id`;
  return rows.map((r) => {
    if (r.status === "replaced" && r.body_sealed === null) return { ...r, text: "", html: "" };
    expect(r.body_sealed, `premise: the ${kind} row (${r.status}) still holds its body`).not.toBeNull();
    const body = openBody(r.body_sealed!);
    return { id: r.id, status: r.status, recipient: r.recipient, recipient_user_id: r.recipient_user_id, subject: r.subject, text: body.text, html: body.html };
  });
}
/** Every outbox row of the org, by kind (what a step mailed, or did not). */
async function kindsOf(orgId: string): Promise<Record<string, number>> {
  const rows = await sql<{ kind: string; n: number }[]>`
    select kind, count(*)::int as n from email_outbox where org_id = ${orgId} group by kind`;
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}
/** The invoice link an email carries, and its token. */
function linkIn(text: string): { url: string; token: string } {
  const m = new RegExp(`${ORIGIN.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/r/sponsor/invoice/([A-Za-z0-9_-]{20,})`).exec(text);
  expect(m, "the email carries the invoice page's link").not.toBeNull();
  return { url: m![0], token: m![1]! };
}
async function refusal(fn: () => Promise<unknown>): Promise<{ status: number; code: string | undefined } | "no refusal"> {
  try {
    await fn();
    return "no refusal";
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return { status: err.status, code: (err as { code?: string }).code };
  }
}
const dealRow = async (id: string) =>
  (await sql<{ status: string; deal_status: string; ended_reason: string | null; invoice_send_count: number; invoice_sent_at: Date | null; paid_at: Date | null; invoice_token_hash: Buffer | null }[]>`
    select status, deal_status, ended_reason, invoice_send_count, invoice_sent_at, paid_at, invoice_token_hash from sponsor_orders where id = ${id}`)[0]!;

/** Arm the gap hook: `hook` runs once, just before the `at`-th `withTenant` call from here on. */
function arm(at: number, hook: () => Promise<unknown>): void {
  Object.assign(gap, { hook: async () => void (await hook()), at, calls: 0 });
}
/** Every `sponsor_invoice` row of the org, whatever its status - what the daily cap counts, read here by the test's own query. */
async function invoiceRowsOfOrg(orgId: string): Promise<number> {
  return (await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where org_id = ${orgId} and kind = 'sponsor_invoice'`)[0]!.n;
}
/** `n` inert copies of the real invoice row `id` (status `replaced`, no body; each its own ref and once-key, so neither the replace
 *  rule nor the once-index touches them): rows the cap counts that nothing will ever send. The real row's first send is still
 *  running in the background (`deferred` is inline fire-and-forget outside a request), so the dispatcher may have leased it or
 *  marked it sent by the time it is copied: every column the dispatcher stamps is set to its queued-row value here, or a copy
 *  inherits a `lease_until` (the lease-only-while-sending CHECK refuses it) or a `provider_id` (its unique index refuses it). */
async function seedInvoiceRows(id: string, n: number): Promise<string> {
  const tag = `seed-${uniq()}`;
  await sql`
    insert into email_outbox
    select (jsonb_populate_record(null::email_outbox, to_jsonb(o) || jsonb_build_object(
             'id', gen_random_uuid(), 'ref_id', o.ref_id || ':' || ${tag} || '-' || g, 'dedupe_key', ${tag} || '-' || g,
             'status', 'replaced', 'body_sealed', null, 'created_at', now(), 'status_at', now(),
             'lease_until', null, 'provider_id', null, 'sent_at', null, 'last_error', null, 'attempts', 0, 'next_attempt_at', now()))).*
      from email_outbox o, generate_series(1, ${n}::int) g
     where o.id = ${id}`;
  return tag;
}

/** A rig org, its package and sponsor. */
async function shop(opts: Parameters<typeof rigOrg>[0] = {}) {
  const o = await rigOrg(opts);
  const p = await rigPackage(o);
  const s = await rigSponsor(o, "Harbour Bank");
  return { o, p, s };
}
/** An offline deal ended unpaid after it ran live (term over, by the real sweep): its invoice is still due. */
async function endedDue(over: Parameters<typeof dealInput>[1] = {}, org: Parameters<typeof rigOrg>[0] = {}) {
  const { o, p, s } = await shop(org);
  const today = new Date().toISOString().slice(0, 10); // the rig org has no timezone: UTC
  const { deal } = await createDeal(o.auth, s.id, dealInput(p.id, { payment_method: "offline", go_live: "immediate", ends_on: today, ...over }), ORIGIN);
  expect(deal.deal_status, "premise: an immediate offline deal is live").toBe("live");
  await sweepSponsorDeals(new Date(Date.now() + 3 * 86_400_000), { orgIds: [o.orgId] });
  const row = await dealRow(deal.id);
  expect([row.deal_status, row.status, row.ended_reason], "premise: ended by its term, unpaid").toEqual(["ended", "pending", "expired"]);
  return { o, p, s, id: deal.id };
}

/** A signed-webhook-shaped `payment_intent.succeeded` for `dealId`. */
function paidEvent(o: RigOrg, dealId: string, intent = `pi_${uniq()}`, amount = 25_000): Stripe.Event {
  const id = `evt_t23_${uniq()}`;
  eventIds.push(id);
  return {
    id,
    object: "event",
    type: "payment_intent.succeeded",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: {
      object: {
        id: intent, object: "payment_intent", amount, amount_received: amount, currency: "gbp", status: "succeeded",
        metadata: { kind: "sponsor", order_id: dealId, org_id: o.orgId },
      },
    },
  } as unknown as Stripe.Event;
}

describe.skipIf(!HAS_DB)("the sponsor's invoice email links the numbered invoice page (DB)", () => {
  it("the empty case: an offline deal with no billing email is 422 no_billing_email, and nothing is queued, counted or rotated", async () => {
    const { o, p, s } = await shop();
    const { deal } = await createDeal(o.auth, s.id, dealInput(p.id, { payment_method: "offline" }), ORIGIN);
    const before = await dealRow(deal.id);
    expect(await refusal(() => sendDealInvoice(o.auth, deal.id, ORIGIN))).toEqual({ status: 422, code: "no_billing_email" });
    expect(await rowsOf("sponsor_invoice", deal.id)).toEqual([]);
    const after = await dealRow(deal.id);
    expect([after.invoice_send_count, after.invoice_sent_at], "not counted").toEqual([0, null]);
    expect(after.invoice_token_hash!.equals(before.invoice_token_hash!), "the create's token still stands: nothing rotated").toBe(true);
    // The positive pair: the same deal with an address sends.
    await sql`update sponsor_orders set sponsor_email = ${`billing-${uniq()}@test.local`} where id = ${deal.id}`;
    const sent = await sendDealInvoice(o.auth, deal.id, ORIGIN);
    const rows = await rowsOf("sponsor_invoice", deal.id);
    expect(rows).toHaveLength(1);
    expect(sent.invoice_url, "the answer is the link the email carries").toBe(linkIn(rows[0]!.text).url);
  });

  it("ONLINE: the email links the invoice page (never checkout.stripe), says it is paid by card there, carries no bank details, in the org's language", async () => {
    const { o, p, s } = await shop({ locale: "es", bank: BANK });
    const es = await getDictionary("es", "emails");
    const { deal, invoice_url } = await createDeal(o.auth, s.id, dealInput(p.id, { payment_method: "online" }), ORIGIN);
    const [{ checkout_url }] = await sql<{ checkout_url: string }[]>`select checkout_url from sponsor_orders where id = ${deal.id}`;
    expect(checkout_url, "premise: the deal holds a Checkout session (the invoice page's Pay by card reaches it)").toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const [row, ...more] = await rowsOf("sponsor_invoice", deal.id);
    expect(more, "one email").toEqual([]);
    expect(row!.subject).toBe(dictionarySubject("es", "sponsorInvoice.subject", { number: "SP-0001", orgName: o.name }));
    const { url, token } = linkIn(row!.text);
    expect(url).toBe(`${ORIGIN}/r/sponsor/invoice/${minted.filter((m) => m.dealId === deal.id).at(-1)!.token}`);
    expect(invoice_url, "the console's copy link is that same page (T23 review I1)").toBe(url);
    expect(row!.html, "the button links the same page").toContain(`href="${url}"`);
    for (const part of [row!.text, row!.html]) {
      expect(part).not.toContain("checkout.stripe");
      expect(part).not.toContain(checkout_url);
      expect(part).not.toContain("Sort code 12-34-56");
    }
    expect(row!.text).toContain(t(es, "sponsorInvoice.payByCard"));
    expect(row!.text).not.toContain(t(es, "sponsorInvoice.payByTransfer", { number: "SP-0001" }));
    expect(row!.text).toContain(AMOUNT);
    expect((await invoiceDocByToken(token))?.number, "the link opens this invoice").toBe("SP-0001");
  });

  it("OFFLINE: the email carries the bank details and the reference, links the invoice page, and no pay-by-card sentence; the deal does not move", async () => {
    const { o, p, s } = await shop({ bank: BANK });
    const en = await getDictionary("en", "emails");
    const { deal } = await createDeal(o.auth, s.id, dealInput(p.id, { payment_method: "offline", sponsor_email: "pay@harbour.test" }), ORIGIN);
    expect(await rowsOf("sponsor_invoice", deal.id), "an offline create mails nothing (the club sends)").toEqual([]);
    const sent = await sendDealInvoice(o.auth, deal.id, ORIGIN);
    expect(stripe.create, "no Stripe for an offline invoice").not.toHaveBeenCalled();
    expect(sent.deal.deal_status, "the deal's status does not move").toBe(deal.deal_status);
    const [row] = await rowsOf("sponsor_invoice", deal.id);
    expect(row!.recipient).toBe("pay@harbour.test");
    expect(row!.text).toContain(BANK);
    expect(row!.html).toContain("Sort code 12-34-56");
    expect(row!.text).toContain(t(en, "sponsorInvoice.payByTransfer", { number: "SP-0001" }));
    expect(row!.text).not.toContain(t(en, "sponsorInvoice.payByCard"));
    expect(row!.text).not.toContain(t(en, "sponsorInvoice.noBankDetails", { orgName: o.name }));
    expect(row!.text).not.toContain("checkout.stripe");
    const { url, token } = linkIn(row!.text);
    expect(sent.invoice_url, "the answer is the link the email carries").toBe(url);
    expect((await invoiceDocByToken(token))?.bankDetails, "the page it opens carries the same details").toBe(BANK);
    const after = await dealRow(deal.id);
    expect(after.invoice_send_count).toBe(1);
    expect(after.invoice_sent_at, "stamped").not.toBeNull();

    // An org with no bank details set: the sponsor is told whom to ask, never an empty panel.
    const bare = await shop();
    const d2 = (await createDeal(bare.o.auth, bare.s.id, dealInput(bare.p.id, { payment_method: "offline", sponsor_email: "pay@harbour.test" }), ORIGIN)).deal;
    await sendDealInvoice(bare.o.auth, d2.id, ORIGIN);
    const [row2] = await rowsOf("sponsor_invoice", d2.id);
    expect(row2!.text).toContain(t(en, "sponsorInvoice.noBankDetails", { orgName: bare.o.name }));
    expect(row2!.html).not.toContain(t(en, "sponsorInvoice.bankTitle"));
  });

  it("ROTATION (F9): every send mints a new token: two sends, two rows, each its own link; the earlier links open nothing, the last opens the invoice (online and offline, counted)", async () => {
    let checked = 0;
    for (const method of ["online", "offline"] as const) {
      const { o, p, s } = await shop({ bank: BANK });
      const { deal } = await createDeal(o.auth, s.id, dealInput(p.id, { payment_method: method, sponsor_email: `pay-${uniq()}@test.local` }), ORIGIN);
      if (method === "offline") await sendDealInvoice(o.auth, deal.id, ORIGIN);
      await sendDealInvoice(o.auth, deal.id, ORIGIN); // the resend
      const rows = await rowsOf("sponsor_invoice", deal.id);
      expect(rows, `${method}: two sends, two rows`).toHaveLength(2);
      // The resend replaced the first email while it still waited to go (the outbox's replace rule): the dead link is never sent.
      expect(rows.map((r) => r.status), method).toEqual(["replaced", "queued"]);
      const mine = minted.filter((m) => m.dealId === deal.id).map((m) => m.token);
      expect(mine, `${method}: the create's token, then one per send`).toHaveLength(3);
      const first = mine[1]!;
      const second = linkIn(rows[1]!.text).token;
      expect(first, method).not.toBe(second);
      expect(await invoiceDocByToken(first!), `${method}: the first link opens nothing`).toBeNull();
      expect((await invoiceDocByToken(second!))?.number, `${method}: the new link opens the invoice`).toBe("SP-0001");
      // The create's own token (never mailed) is gone too: only the last one minted stands.
      expect(mine.at(-1), method).toBe(second);
      for (const old of mine.slice(0, -1)) expect(await invoiceDocByToken(old), `${method}: ${old.slice(0, 6)}… is dead`).toBeNull();
      expect((await dealRow(deal.id)).invoice_send_count, method).toBe(2);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("sequences: a send after End now, and a resend after the deal is paid, are refused with nothing queued; an ENDED offline deal still due can be re-sent (bank details and all)", async () => {
    // After End now (void: nothing is due).
    const a = await shop();
    const voided = (await createDeal(a.o.auth, a.s.id, dealInput(a.p.id, { payment_method: "offline", sponsor_email: "pay@harbour.test" }), ORIGIN)).deal;
    await endDealNow(a.o.auth, voided.id);
    expect(await refusal(() => sendDealInvoice(a.o.auth, voided.id, ORIGIN))).toEqual({ status: 409, code: "deal_not_invoiceable" });
    expect(await rowsOf("sponsor_invoice", voided.id)).toEqual([]);
    // After it is paid.
    const paid = (await createDeal(a.o.auth, (await rigSponsor(a.o)).id, dealInput(a.p.id, { payment_method: "offline", sponsor_email: "pay@harbour.test" }), ORIGIN)).deal;
    await sendDealInvoice(a.o.auth, paid.id, ORIGIN);
    await markDealPaid(a.o.auth, paid.id);
    expect(await refusal(() => sendDealInvoice(a.o.auth, paid.id, ORIGIN))).toEqual({ status: 409, code: "deal_not_invoiceable" });
    expect(await rowsOf("sponsor_invoice", paid.id), "the one send before it was paid").toHaveLength(1);
    // Ended by its term, unpaid: still due, so Resend is offered and the email still carries the bank details.
    const due = await endedDue({ sponsor_email: "pay@harbour.test" }, { bank: BANK });
    await sendDealInvoice(due.o.auth, due.id, ORIGIN);
    const [row] = await rowsOf("sponsor_invoice", due.id);
    expect(row!.text).toContain(BANK);
    expect((await invoiceDocByToken(linkIn(row!.text).token))?.state, "the invoice still reads unpaid").toBe("unpaid");
    expect((await dealRow(due.id)).deal_status, "a send does not revive an ended deal").toBe("ended");
  });
});

describe.skipIf(!HAS_DB)("T23 review fixes: the answer's link, the in-lock re-check, the daily cap (DB)", () => {
  it("I1: every answer that sent an email carries invoice_url - exactly the link that email carries - and never a Checkout url; online create and resend, offline send and resend; a create that mailed nothing answers null (5 counted)", async () => {
    let checked = 0;
    const answered = (out: object, rows: Row[], label: string) => {
      expect(Object.keys(out).sort(), `${label}: the answer's fields`).toEqual(["deal", "invoice_url"]);
      const url = (out as { invoice_url: string | null }).invoice_url;
      expect(url, `${label}: the link the newest email carries`).toBe(linkIn(rows.at(-1)!.text).url);
      expect(url, label).not.toContain("checkout.stripe");
      checked++;
      return url!;
    };
    const { o, p, s } = await shop({ bank: BANK });
    // ONLINE: the create sends, the resend sends again with a new link.
    const made = await createDeal(o.auth, s.id, dealInput(p.id, { payment_method: "online" }), ORIGIN);
    const [{ checkout_url }] = await sql<{ checkout_url: string }[]>`select checkout_url from sponsor_orders where id = ${made.deal.id}`;
    expect(checkout_url, "premise: a Checkout session exists to leak").toMatch(/checkout\.stripe/);
    const onFirst = answered(made, await rowsOf("sponsor_invoice", made.deal.id), "online create");
    const onAgain = answered(await sendDealInvoice(o.auth, made.deal.id, ORIGIN), await rowsOf("sponsor_invoice", made.deal.id), "online resend");
    expect(onAgain, "the resend's link is the new one").not.toBe(onFirst);
    expect(JSON.stringify(made), "no Checkout url anywhere in the answer").not.toContain(checkout_url);
    // OFFLINE: the create mails nothing (null); the send and the resend each answer their own link.
    const s2 = await rigSponsor(o);
    const off = await createDeal(o.auth, s2.id, dealInput(p.id, { payment_method: "offline", sponsor_email: "pay@harbour.test" }), ORIGIN);
    expect(Object.keys(off).sort()).toEqual(["deal", "invoice_url"]);
    expect(off.invoice_url, "an offline create sends no email, so it has no link").toBeNull();
    checked++;
    const offFirst = answered(await sendDealInvoice(o.auth, off.deal.id, ORIGIN), await rowsOf("sponsor_invoice", off.deal.id), "offline send");
    const offAgain = answered(await sendDealInvoice(o.auth, off.deal.id, ORIGIN), await rowsOf("sponsor_invoice", off.deal.id), "offline resend");
    expect(offAgain).not.toBe(offFirst);
    expect(await invoiceDocByToken(linkIn(`${offFirst}`).token), "the earlier answer's link opens nothing").toBeNull();
    expect(checked).toBe(5);
  });

  it("m1: a Mark as paid, or a Write off, landing between an offline send's unlocked read and its lock: the send is 409 deal_not_invoiceable, nothing queued, counted or rotated (2 counted, the hook fired each time)", async () => {
    let checked = 0;
    // Mark as paid lands in the gap: a running offline deal, unpaid, with an address - offered Resend when it was read.
    const { o, p, s } = await shop({ bank: BANK });
    const { deal } = await createDeal(o.auth, s.id, dealInput(p.id, { payment_method: "offline", go_live: "immediate", sponsor_email: "pay@harbour.test" }), ORIGIN);
    const before = await dealRow(deal.id);
    arm(2, () => markDealPaid(o.auth, deal.id));
    expect(await refusal(() => sendDealInvoice(o.auth, deal.id, ORIGIN))).toEqual({ status: 409, code: "deal_not_invoiceable" });
    expect(gap.fired, "the Mark as paid ran in the gap").toBe(1);
    let after = await dealRow(deal.id);
    expect(after.status, "premise: the Mark as paid committed").toBe("paid");
    expect(await rowsOf("sponsor_invoice", deal.id), "no invoice for a paid deal").toEqual([]);
    expect([after.invoice_send_count, after.invoice_sent_at], "not counted").toEqual([0, null]);
    expect(after.invoice_token_hash!.equals(before.invoice_token_hash!), "not rotated").toBe(true);
    checked++;

    // Write off lands in the gap: an offline deal ended unpaid after it ran (still due, so offered Resend when it was read).
    const due = await endedDue({ sponsor_email: "pay@harbour.test" }, { bank: BANK });
    const dueBefore = await dealRow(due.id);
    arm(2, () => writeOffDeal(due.o.auth, due.id));
    expect(await refusal(() => sendDealInvoice(due.o.auth, due.id, ORIGIN))).toEqual({ status: 409, code: "deal_not_invoiceable" });
    expect(gap.fired, "the Write off ran in the gap").toBe(2);
    after = await dealRow(due.id);
    expect(after.ended_reason, "premise: the Write off committed").toBe("written_off");
    expect(await rowsOf("sponsor_invoice", due.id), "no invoice for a written-off deal").toEqual([]);
    expect(after.invoice_send_count).toBe(dueBefore.invoice_send_count);
    expect(after.invoice_token_hash!.equals(dueBefore.invoice_token_hash!), "not rotated").toBe(true);
    checked++;

    // The positive pair: with nothing in the gap, the same kind of send goes.
    const ok = await endedDue({ sponsor_email: "pay@harbour.test" }, { bank: BANK });
    arm(2, async () => {});
    await sendDealInvoice(ok.o.auth, ok.id, ORIGIN);
    expect(await rowsOf("sponsor_invoice", ok.id)).toHaveLength(1);
    expect(checked).toBe(2);
  });

  it("m7: at most INVOICE_EMAILS_PER_DAY invoice emails per org in 24 hours - the 50th send goes, the 51st is 429 invoice_send_limit (offline and online sends, and an online create, refused before Stripe or any write); rows older than 24 hours stop counting; another org is untouched", async () => {
    expect(INVOICE_EMAILS_PER_DAY, "the PO ruling: 50 a day").toBe(50);
    const { o, p, s } = await shop({ bank: BANK });
    // The empty case: an org with no invoices sends (and counts its own rows from zero).
    expect(await invoiceRowsOfOrg(o.orgId)).toBe(0);
    const online = await createDeal(o.auth, s.id, dealInput(p.id, { payment_method: "online" }), ORIGIN); // row 1
    const s2 = await rigSponsor(o);
    const off = (await createDeal(o.auth, s2.id, dealInput(p.id, { payment_method: "offline", sponsor_email: "pay@harbour.test" }), ORIGIN)).deal;
    await sendDealInvoice(o.auth, off.id, ORIGIN); // row 2
    const [real] = await rowsOf("sponsor_invoice", off.id);
    const tag = await seedInvoiceRows(real!.id, INVOICE_EMAILS_PER_DAY - 3);
    expect(await invoiceRowsOfOrg(o.orgId), "premise: one short of the cap").toBe(INVOICE_EMAILS_PER_DAY - 1);

    await sendDealInvoice(o.auth, off.id, ORIGIN); // the 50th goes
    expect(await invoiceRowsOfOrg(o.orgId), "the 50th was queued").toBe(INVOICE_EMAILS_PER_DAY);

    // The 51st, every way: refused, nothing queued, counted, rotated or sent to Stripe.
    const offBefore = await dealRow(off.id);
    const onBefore = await dealRow(online.deal.id);
    stripe.create.mockClear();
    stripe.retrieve.mockClear();
    stripe.expire.mockClear();
    const LIMIT = { status: 429, code: "invoice_send_limit" };
    expect(await refusal(() => sendDealInvoice(o.auth, off.id, ORIGIN)), "offline resend").toEqual(LIMIT);
    expect(await refusal(() => sendDealInvoice(o.auth, online.deal.id, ORIGIN)), "online resend").toEqual(LIMIT);
    const s3 = await rigSponsor(o);
    expect(await refusal(() => createDeal(o.auth, s3.id, dealInput(p.id, { payment_method: "online" }), ORIGIN)), "online create").toEqual(LIMIT);
    expect(await invoiceRowsOfOrg(o.orgId), "nothing queued").toBe(INVOICE_EMAILS_PER_DAY);
    for (const [label, id, was] of [["offline", off.id, offBefore], ["online", online.deal.id, onBefore]] as const) {
      const now = await dealRow(id);
      expect(now.invoice_send_count, `${label}: not counted`).toBe(was.invoice_send_count);
      expect(now.invoice_token_hash!.equals(was.invoice_token_hash!), `${label}: not rotated`).toBe(true);
    }
    expect((await sql`select 1 from sponsor_orders where sponsor_id = ${s3.id}`).length, "the refused create wrote no deal").toBe(0);
    expect([stripe.create.mock.calls.length, stripe.retrieve.mock.calls.length, stripe.expire.mock.calls.length], "Stripe untouched").toEqual([0, 0, 0]);
    // A deal that mails nothing is not an invoice email: an offline create at the cap is saved.
    await expect(createDeal(o.auth, s3.id, dealInput(p.id, { payment_method: "offline", sponsor_email: "pay@harbour.test" }), ORIGIN)).resolves.toMatchObject({ invoice_url: null });
    // Another org at the same moment is untouched.
    const other = await shop();
    const od = (await createDeal(other.o.auth, other.s.id, dealInput(other.p.id, { payment_method: "offline", sponsor_email: "pay@harbour.test" }), ORIGIN)).deal;
    await sendDealInvoice(other.o.auth, od.id, ORIGIN);
    expect(await rowsOf("sponsor_invoice", od.id)).toHaveLength(1);

    // A rolling window, witnessed from both sides. Rows 23 hours old (inside 24, long past an hour) still count: the send is refused.
    const age = async (hours: number) => {
      const moved = await sql`update email_outbox set created_at = now() - make_interval(hours => ${hours}::int) where org_id = ${o.orgId} and dedupe_key like ${`${tag}-%`}`;
      expect(moved.count, `premise: all ${INVOICE_EMAILS_PER_DAY - 3} seeded rows aged to ${hours}h`).toBe(INVOICE_EMAILS_PER_DAY - 3);
    };
    await age(23);
    expect(await refusal(() => sendDealInvoice(o.auth, online.deal.id, ORIGIN)), "rows 23h old still count").toEqual(LIMIT);
    expect((await dealRow(online.deal.id)).invoice_send_count, "the 23h refusal counted nothing").toBe(onBefore.invoice_send_count);
    // Once the seeded rows are older than 24 hours, the org is back under the cap and sends.
    await age(25);
    await sendDealInvoice(o.auth, online.deal.id, ORIGIN);
    expect((await dealRow(online.deal.id)).invoice_send_count, "the online resend went").toBe(onBefore.invoice_send_count + 1);
  });
});

describe.skipIf(!HAS_DB)("the owner hears when a sponsor pays by card: sponsor_deal_paid (DB)", () => {
  it("through runEvent: ONE notice to the org's owner, in the OWNER's language (an fr owner of an nl org reads French), naming the sponsor and the amount, saying they are live, linking the deal; a replay and a redelivery on a new event id add nothing", async () => {
    const { o, p, s } = await shop({ locale: "nl" });
    await sql`update users set locale = 'fr' where id = ${o.auth.userId}`;
    const [owner] = await sql<{ email: string }[]>`select email from users where id = ${o.auth.userId}`;
    const fr = await getDictionary("fr", "emails");
    const { deal } = await createDeal(o.auth, s.id, dealInput(p.id, { payment_method: "online" }), ORIGIN);
    const intent = `pi_${uniq()}`;
    const event = paidEvent(o, deal.id, intent);
    expect(await runEvent(event), "the dispatcher claimed and ran it").toBe(true);
    expect((await dealRow(deal.id)).status, "premise: paid").toBe("paid");

    const [row, ...more] = await rowsOf("sponsor_deal_paid", deal.id);
    expect(more, "one notice").toEqual([]);
    // T23 review m2: the once-key is the PAYMENT, written out (`onceKey(kind, ref, id)` with no suffix is the id itself): one
    // notice per payment intent - a redelivery adds nothing, a different payment on the same deal is told.
    const [{ dedupe_key }] = await sql<{ dedupe_key: string }[]>`select dedupe_key from email_outbox where id = ${row!.id}`;
    expect(dedupe_key).toBe(intent);
    expect(row!.recipient).toBe(owner!.email.toLowerCase());
    expect(row!.recipient_user_id, "an account kind: the owner's account").toBe(o.auth.userId);
    expect(row!.subject).toBe(dictionarySubject("fr", "sponsorDealPaid.subject", { sponsorName: "Harbour Bank", orgName: o.name }));
    expect(row!.subject, "not the org's nl").not.toBe(dictionarySubject("nl", "sponsorDealPaid.subject", { sponsorName: "Harbour Bank", orgName: o.name }));
    expect(row!.text).toContain("Harbour Bank");
    expect(row!.text).toContain(AMOUNT);
    expect(row!.text).toContain(t(fr, "sponsorDealPaid.next.live"));
    const dealUrl = `${APP}/o/${o.slug}/sponsors?tab=sponsors&sponsor=${s.id}&deal=${deal.id}`;
    expect(row!.text).toContain(dealUrl);
    expect(row!.html).toContain(`href="${dealUrl.replace(/&/g, "&amp;")}"`);

    // Replays: the same event (the ledger refuses it), the staff replay, and Stripe redelivering the payment on a new event id.
    expect(await runEvent(event), "the same event is not run twice").toBe(false);
    expect(await replayEvent(event)).toBe("already_processed");
    expect(await runEvent(paidEvent(o, deal.id, intent)), "a new event id is claimed").toBe(true);
    expect(await rowsOf("sponsor_deal_paid", deal.id), "still one notice").toHaveLength(1);
    expect(await rowsOf("sponsor_receipt", deal.id), "and one receipt").toHaveLength(1);
  });

  it("the notice and the payment commit together: a notice that cannot be rendered rolls the payment back (still pending, nothing queued); the retry records it with exactly one notice and one receipt", async () => {
    const { o, p, s } = await shop();
    const { deal } = await createDeal(o.auth, s.id, dealInput(p.id, { payment_method: "online" }), ORIGIN);
    const event = paidEvent(o, deal.id);
    vi.mocked(sponsorDealPaidEmail).mockRejectedValueOnce(new Error("renderer down"));
    await expect(processStripeEvent(event)).rejects.toThrow(/renderer down/);
    expect(vi.mocked(sponsorDealPaidEmail), "premise: the notice was being rendered").toHaveBeenCalledTimes(1);
    const rolled = await dealRow(deal.id);
    expect([rolled.status, rolled.paid_at], "the payment rolled back with it").toEqual(["pending", null]);
    expect(await rowsOf("sponsor_deal_paid", deal.id)).toEqual([]);
    expect(await rowsOf("sponsor_receipt", deal.id)).toEqual([]);
    // Stripe retries the webhook.
    await processStripeEvent(event);
    expect((await dealRow(deal.id)).status).toBe("paid");
    expect(await rowsOf("sponsor_deal_paid", deal.id)).toHaveLength(1);
    expect(await rowsOf("sponsor_receipt", deal.id)).toHaveLength(1);
  });

  it("the next step it names is what the payment did: live, approve (After I approve), scheduled (another deal live), a second payment, an ended deal (5 counted)", async () => {
    const en = await getDictionary("en", "emails");
    type Case = { label: string; next: string; setup: () => Promise<{ o: RigOrg; dealId: string; event: Stripe.Event; notedOn: () => Promise<string> }> };
    const online = async (over: Parameters<typeof dealInput>[1] = {}, prior?: (x: Awaited<ReturnType<typeof shop>>) => Promise<void>) => {
      const x = await shop();
      if (prior) await prior(x);
      const { deal } = await createDeal(x.o.auth, x.s.id, dealInput(x.p.id, { payment_method: "online", ...over }), ORIGIN);
      return { ...x, dealId: deal.id };
    };
    const cases: Case[] = [
      { label: "live", next: "sponsorDealPaid.next.live", setup: async () => {
        const d = await online();
        return { o: d.o, dealId: d.dealId, event: paidEvent(d.o, d.dealId), notedOn: async () => d.dealId };
      } },
      { label: "approve", next: "sponsorDealPaid.next.approve", setup: async () => {
        const d = await online({ go_live: "on_approval" });
        return { o: d.o, dealId: d.dealId, event: paidEvent(d.o, d.dealId), notedOn: async () => d.dealId };
      } },
      { label: "scheduled", next: "sponsorDealPaid.next.scheduled", setup: async () => {
        // The sponsor already has a live deal (offline, live at once): the new one waits behind it.
        const d = await online({}, async (x) => {
          await createDeal(x.o.auth, x.s.id, dealInput(x.p.id, { payment_method: "offline", go_live: "immediate" }), ORIGIN);
        });
        return { o: d.o, dealId: d.dealId, event: paidEvent(d.o, d.dealId), notedOn: async () => d.dealId };
      } },
      { label: "duplicate", next: "sponsorDealPaid.next.duplicate", setup: async () => {
        const d = await online();
        await processStripeEvent(paidEvent(d.o, d.dealId)); // the first payment
        // The second payment is recorded on its own row; the notice is about that row.
        return {
          o: d.o, dealId: d.dealId, event: paidEvent(d.o, d.dealId),
          notedOn: async () => (await sql<{ id: string }[]>`
            select id from sponsor_orders where org_id = ${d.o.orgId} and ended_reason = 'duplicate_payment'`)[0]!.id,
        };
      } },
      { label: "ended", next: "sponsorDealPaid.next.check", setup: async () => {
        const d = await online();
        stripe.retrieve.mockImplementation(async (id: string) => ({ id, status: "expired" }));
        await endDealNow(d.o.auth, d.dealId);
        return { o: d.o, dealId: d.dealId, event: paidEvent(d.o, d.dealId), notedOn: async () => d.dealId };
      } },
    ];
    let checked = 0;
    for (const c of cases) {
      const { o, event, notedOn } = await c.setup();
      await processStripeEvent(event);
      const on = await notedOn();
      const rows = await rowsOf("sponsor_deal_paid", on);
      const mine = rows.filter((r) => r.text.includes(t(en, c.next as Parameters<typeof t>[1])));
      expect(mine, `${c.label}: one notice naming its next step`).toHaveLength(1);
      for (const other of ["live", "approve", "scheduled", "duplicate", "check"].map((k) => `sponsorDealPaid.next.${k}`).filter((k) => k !== c.next)) {
        expect(mine[0]!.text, `${c.label} does not say ${other}`).not.toContain(t(en, other as Parameters<typeof t>[1]));
      }
      expect(mine[0]!.text, c.label).toContain(`deal=${on}`);
      expect((await kindsOf(o.orgId)).sponsor_deal_paid, `${c.label}: one notice per payment in the org`).toBe(c.label === "duplicate" ? 2 : 1);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("D13: no notice for an offline Mark as paid, an offline refund, or a complimentary deal - and none to the sponsor either (counted)", async () => {
    const { o, p, s } = await shop();
    const offline = (await createDeal(o.auth, s.id, dealInput(p.id, { payment_method: "offline", sponsor_email: "pay@harbour.test" }), ORIGIN)).deal;
    await markDealPaid(o.auth, offline.id);
    await refundDeal(o.auth, offline.id);
    await createDeal(o.auth, (await rigSponsor(o)).id, dealInput(p.id, { payment_method: "complimentary", sponsor_email: "free@harbour.test" }), ORIGIN);
    expect((await dealRow(offline.id)).status, "premise: recorded").toBe("refunded");
    expect(await kindsOf(o.orgId), "nothing at all was mailed").toEqual({});
  });
});

describe.skipIf(!HAS_DB)("an offline invoice still due after its deal ended: late Mark as paid, or Write off (DB)", () => {
  it("late Mark as paid on a deal its term ended unpaid: recorded paid, the deal stays ENDED, the invoice reads paid, nothing is mailed", async () => {
    const due = await endedDue({ sponsor_email: "pay@harbour.test" });
    const token = minted.filter((m) => m.dealId === due.id).at(-1)!.token;
    expect((await invoiceDocByToken(token))?.state, "premise: still due").toBe("unpaid");
    const after = await markDealPaid(due.o.auth, due.id);
    expect([after.deal_status, after.payment_status, after.ended_reason]).toEqual(["ended", "paid", "expired"]);
    expect((await dealRow(due.id)).paid_at).not.toBeNull();
    expect((await invoiceDocByToken(token))?.state).toBe("paid");
    expect(await kindsOf(due.o.orgId), "D13: an offline mark-paid mails nobody").toEqual({});
    // The second press.
    expect(await refusal(() => markDealPaid(due.o.auth, due.id))).toEqual({ status: 409, code: "deal_already_paid" });
  });

  it("late Mark as paid is refused where nothing is due: an offline deal the club ended (End now), a refunded one, an online deal ended unpaid; and a complimentary deal never takes it (4 counted)", async () => {
    const { o, p, s } = await shop();
    const ended = (await createDeal(o.auth, s.id, dealInput(p.id, { payment_method: "offline", go_live: "immediate" }), ORIGIN)).deal;
    await endDealNow(o.auth, ended.id);
    const refunded = (await createDeal(o.auth, (await rigSponsor(o)).id, dealInput(p.id, { payment_method: "offline" }), ORIGIN)).deal;
    await markDealPaid(o.auth, refunded.id);
    await refundDeal(o.auth, refunded.id);
    stripe.retrieve.mockImplementation(async (id: string) => ({ id, status: "expired" }));
    const onlineEnded = (await createDeal(o.auth, (await rigSponsor(o)).id, dealInput(p.id, { payment_method: "online" }), ORIGIN)).deal;
    await endDealNow(o.auth, onlineEnded.id);
    const comp = (await createDeal(o.auth, (await rigSponsor(o)).id, dealInput(p.id, { payment_method: "complimentary" }), ORIGIN)).deal;
    const rows: [string, string, string][] = [
      ["End now", ended.id, "deal_ended"],
      ["refunded", refunded.id, "deal_already_paid"],
      ["online ended unpaid", onlineEnded.id, "deal_ended"],
      ["complimentary", comp.id, "deal_not_payable"],
    ];
    let checked = 0;
    for (const [label, id, code] of rows) {
      const before = await dealRow(id);
      expect(await refusal(() => markDealPaid(o.auth, id)), label).toEqual({ status: 409, code });
      expect((await dealRow(id)).status, `${label}: unchanged`).toBe(before.status);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("Write off: the invoice reads 'written off' with no bank details, the deal stays ended and unpaid, nothing is mailed; then neither Mark as paid, Resend nor a second write-off is offered", async () => {
    const due = await endedDue({ sponsor_email: "pay@harbour.test" }, { bank: BANK });
    const token = minted.filter((m) => m.dealId === due.id).at(-1)!.token;
    const after = await writeOffDeal(due.o.auth, due.id);
    expect([after.deal_status, after.payment_status, after.ended_reason]).toEqual(["ended", "pending", "written_off"]);
    const doc = await invoiceDocByToken(token);
    expect(doc?.state).toBe("written_off");
    expect(doc?.bankDetails, "nothing to transfer").toBeNull();
    expect(doc?.payable).toBe(false);
    expect(await kindsOf(due.o.orgId), "a write-off mails nobody").toEqual({});
    expect(await refusal(() => markDealPaid(due.o.auth, due.id)), "Mark as paid").toEqual({ status: 409, code: "deal_ended" });
    expect(await refusal(() => sendDealInvoice(due.o.auth, due.id, ORIGIN)), "Resend").toEqual({ status: 409, code: "deal_not_invoiceable" });
    expect(await refusal(() => writeOffDeal(due.o.auth, due.id)), "the second write-off").toEqual({ status: 409, code: "deal_nothing_due" });
  });

  it("Write off is refused where nothing is due: a running offline deal, a paid one (late Mark as paid), the club's End now, an online deal ended unpaid, a complimentary deal (5 counted, each unchanged)", async () => {
    const { o, p, s } = await shop();
    const running = (await createDeal(o.auth, s.id, dealInput(p.id, { payment_method: "offline", go_live: "immediate" }), ORIGIN)).deal;
    const paid = await endedDue();
    await markDealPaid(paid.o.auth, paid.id);
    const voided = (await createDeal(o.auth, (await rigSponsor(o)).id, dealInput(p.id, { payment_method: "offline", go_live: "immediate" }), ORIGIN)).deal;
    await endDealNow(o.auth, voided.id);
    stripe.retrieve.mockImplementation(async (id: string) => ({ id, status: "expired" }));
    const onlineEnded = (await createDeal(o.auth, (await rigSponsor(o)).id, dealInput(p.id, { payment_method: "online" }), ORIGIN)).deal;
    await endDealNow(o.auth, onlineEnded.id);
    const comp = (await createDeal(o.auth, (await rigSponsor(o)).id, dealInput(p.id, { payment_method: "complimentary" }), ORIGIN)).deal;
    const rows: [string, string, typeof o.auth, string][] = [
      ["running", running.id, o.auth, "deal_nothing_due"],
      ["paid", paid.id, paid.o.auth, "deal_already_paid"],
      ["End now", voided.id, o.auth, "deal_nothing_due"],
      ["online ended unpaid", onlineEnded.id, o.auth, "deal_nothing_due"],
      ["complimentary", comp.id, o.auth, "deal_nothing_due"],
    ];
    let checked = 0;
    for (const [label, id, auth, code] of rows) {
      const before = await dealRow(id);
      expect(await refusal(() => writeOffDeal(auth, id)), label).toEqual({ status: 409, code });
      const now = await dealRow(id);
      expect([now.status, now.deal_status, now.ended_reason], `${label}: unchanged`).toEqual([before.status, before.deal_status, before.ended_reason]);
      checked++;
    }
    expect(checked).toBe(5);
  });
});
