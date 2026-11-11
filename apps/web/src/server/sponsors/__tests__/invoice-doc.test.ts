// Sponsor invoices, Task 22 (plan 2026-11-07-sponsor-deals; spec §7, F9): the invoice DOCUMENT and its token.
//
// The seam is real end to end (F9): every token here was minted by the REAL createDeal / sendDealInvoice, captured by wrapping
// the real `mintInvoiceToken` (vi.mock + importOriginal), and read back by the REAL `invoiceDocByToken`. No case writes a hash;
// the one guard case that needs an unnumbered row holding a token MOVES a real one there, and says so.
//
// Where each expected value comes from:
//   - the state (brief, Acceptance): `paid` when money is paid, `refunded`, `void` when the deal ended unpaid, else `unpaid` -
//     each state reached by its real producer (the payment webhook, Mark as paid, refund, End now);
//   - payable (brief): online, unpaid, not ended - and not a draft (a payment cannot move a draft: `statusAfterPaid` throws and
//     the webhook only alerts, so the pay button must not exist for one; deviation recorded in task-22-report.md);
//   - bank details: printed on an OFFLINE invoice only (T21 review carry: the settings card sets them "for offline invoices";
//     this overrides the brief's "also printed for online when set"), and never once it is no longer due (a paid invoice does not
//     invite a second transfer: product recommendation, task-22-report.md);
//   - the number: T20's rule, an org's first invoice is SP-0001 (typed here, not formatted by the code under test);
//   - the words: the four dictionaries (the org's `default_locale`, never the reader's);
//   - the issue date: the deal's creation day in the ORG's timezone, derived here with Intl.
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
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));
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

import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { getDictionary, t } from "@/lib/i18n";
import { allowedActions, type SponsorDeal } from "@/lib/sponsor-deals";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { handleSponsorPaymentSucceeded } from "@/server/usecases/sponsors";
import { createDeal, endDealNow, markDealPaid, refundDeal, sendDealInvoice } from "@/server/usecases/sponsor-deals";
import { hashReportToken } from "../report-token";
import {
  cardPayable,
  invoiceDocByToken,
  invoiceDocForDeal,
  invoiceState,
  mintInvoiceToken,
  type SponsorInvoiceDoc,
} from "../invoice-doc";
import { ORIGIN, cleanUp, dealInput, idempotentCreate, invoiceCols, rigOrg, rigPackage, rigSponsor, uniq, type RigOrg } from "./_invoice-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const ADDRESS = "12 Quay Street\nRiverside RV1 2AB";
const BANK = "Riverside Shuttlers\nSort code 12-34-56\nAccount 12345678";

beforeEach(() => {
  minted.length = 0;
  stubOutboxEnv();
  deliverMock.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_${uniq()}` }));
  stripe.create.mockReset().mockImplementation(idempotentCreate());
  stripe.retrieve.mockReset().mockImplementation(async (id: string) => ({ id, status: "open" }));
  stripe.expire.mockReset().mockImplementation(async (id: string) => ({ id, status: "expired" }));
  stripe.refund.mockReset();
});
afterAll(async () => {
  if (HAS_DB) await cleanUp();
});

/** The token the real producer minted for this deal (exactly one so far). */
function tokenOf(dealId: string): string {
  const mine = minted.filter((m) => m.dealId === dealId);
  expect(mine, `premise: one token minted for ${dealId}`).toHaveLength(1);
  return mine[0]!.token;
}

/** An org, a package, a sponsor and a deal made by the REAL createDeal. */
async function made(over: Parameters<typeof dealInput>[1] = {}, org: Parameters<typeof rigOrg>[0] = {}) {
  const o = await rigOrg(org);
  return madeOn(o, over);
}
async function madeOn(o: RigOrg, over: Parameters<typeof dealInput>[1] = {}) {
  const p = await rigPackage(o);
  const s = await rigSponsor(o);
  const out = await createDeal(o.auth, s.id, dealInput(p.id, over), ORIGIN);
  return { o, p, s, deal: out.deal, id: out.deal.id };
}

const paidByWebhook = (o: RigOrg, dealId: string) =>
  handleSponsorPaymentSucceeded({
    id: `pi_invoice_${uniq()}`,
    metadata: { kind: "sponsor", order_id: dealId, org_id: o.orgId },
  } as unknown as Stripe.PaymentIntent);

describe("invoiceState and cardPayable: the rules, total over every deal shape (pure)", () => {
  it("state: paid / refunded by the money; void when ended unpaid; else unpaid - and a complimentary deal has no invoice (counted)", () => {
    const cases: [Pick<SponsorDeal, "payment_status" | "deal_status">, string][] = [
      [{ payment_status: "paid", deal_status: "live" }, "paid"],
      [{ payment_status: "paid", deal_status: "ended" }, "paid"],
      [{ payment_status: "refunded", deal_status: "ended" }, "refunded"],
      [{ payment_status: "pending", deal_status: "ended" }, "void"],
      [{ payment_status: "failed", deal_status: "ended" }, "void"],
      [{ payment_status: "pending", deal_status: "awaiting_payment" }, "unpaid"],
      [{ payment_status: "failed", deal_status: "awaiting_payment" }, "unpaid"],
      [{ payment_status: "pending", deal_status: "live" }, "unpaid"],
      [{ payment_status: "pending", deal_status: "draft" }, "unpaid"],
    ];
    let checked = 0;
    for (const [deal, state] of cases) {
      expect(invoiceState(deal), JSON.stringify(deal)).toBe(state);
      checked++;
    }
    expect(checked).toBe(9);
    // "Cannot happen" is a refusal: a complimentary deal is never numbered, so it is never asked for a state.
    expect(() => invoiceState({ payment_status: "none", deal_status: "live" })).toThrow(/complimentary/);
  });

  it("payable: online AND a payment would move the deal (unpaid; awaiting payment, live or scheduled) - never offline, a draft, or ended (counted)", () => {
    const base = { disputed_at: null, ended_reason: null } as const;
    const cases: [Parameters<typeof cardPayable>[0], boolean][] = [
      [{ ...base, payment_method: "online", payment_status: "pending", deal_status: "awaiting_payment" }, true],
      [{ ...base, payment_method: "online", payment_status: "failed", deal_status: "awaiting_payment" }, true],
      [{ ...base, payment_method: "online", payment_status: "pending", deal_status: "live" }, true],
      [{ ...base, payment_method: "online", payment_status: "pending", deal_status: "scheduled" }, true],
      [{ ...base, payment_method: "online", payment_status: "pending", deal_status: "draft" }, false],
      [{ ...base, payment_method: "online", payment_status: "paid", deal_status: "live" }, false],
      [{ ...base, payment_method: "online", payment_status: "paid", deal_status: "awaiting_approval" }, false],
      [{ ...base, payment_method: "online", payment_status: "pending", deal_status: "ended" }, false],
      [{ ...base, payment_method: "online", payment_status: "refunded", deal_status: "ended", ended_reason: "refunded" }, false],
      [{ ...base, payment_method: "offline", payment_status: "pending", deal_status: "awaiting_payment" }, false],
      [{ ...base, payment_method: "complimentary", payment_status: "none", deal_status: "live" }, false],
    ];
    let checked = 0;
    for (const [deal, payable] of cases) {
      expect(cardPayable(deal), JSON.stringify(deal)).toBe(payable);
      // The positive half is exactly the deals a payment can move (the webhook's own acceptance, F12), online.
      if (payable) expect(allowedActions(deal)).toContain("mark_paid");
      checked++;
    }
    expect(checked).toBe(11);
  });
});

describe.skipIf(!HAS_DB)("the invoice document, from the real token (DB, F9)", () => {
  it("EMPTY CASE FIRST: a token nobody minted, a malformed one, an empty one and a path are each null - and nothing was minted", async () => {
    let checked = 0;
    for (const token of [hashReportToken("x").toString("base64url"), "%E0%A4%A", "", "../../etc", "invoice"]) {
      expect(await invoiceDocByToken(token), JSON.stringify(token)).toBeNull();
      checked++;
    }
    expect(checked).toBe(5);
    expect(minted).toEqual([]);
  });

  it("offline: createDeal mints ONE token in its transaction; it opens the doc in the ORG's language, with the bank details, not payable", async () => {
    const { o, p, s, id } = await made({ payment_method: "offline" }, { locale: "fr", address: ADDRESS, bank: BANK });
    const token = tokenOf(id);
    expect(token, "32 random bytes, base64url").toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await invoiceCols(id)).invoice_token_hash, "only the hash is stored").toEqual(hashReportToken(token));
    const fr = await getDictionary("fr", "ui");
    const doc = await invoiceDocByToken(token);
    expect(doc).toEqual<SponsorInvoiceDoc>({
      number: "SP-0001",
      issuedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as unknown as string,
      org: { name: o.name, address: ADDRESS, logoPath: null },
      billedTo: { name: s.name, email: null },
      line: { description: t(fr, "sponsors.invoice.line", { package: p.name, scope: t(fr, "sponsors.scopeAll") }), amountCents: 25_000, currency: "gbp" },
      included: { tier: "partner", scope: t(fr, "sponsors.scopeAll"), onStream: false },
      state: "unpaid",
      method: "offline",
      bankDetails: BANK,
      payable: false,
      locale: "fr",
    });
  });

  it("a blank setting is no setting: null, \"\" and whitespace-only address and bank details are absent (Task 21's PATCH may store \"\"; 3 shapes counted)", async () => {
    let checked = 0;
    for (const blank of [null, "", "  \n\t "]) {
      const { id } = await made({ payment_method: "offline" }, { address: blank, bank: blank });
      const doc = await invoiceDocByToken(tokenOf(id));
      expect(doc!.org.address, JSON.stringify(blank)).toBeNull();
      expect(doc!.bankDetails, JSON.stringify(blank)).toBeNull();
      checked++;
    }
    expect(checked).toBe(3);
    // The positive pair: a set value survives, trimmed of the blank lines around it.
    const { id } = await made({ payment_method: "offline" }, { address: `\n${ADDRESS}  `, bank: ` ${BANK}\n` });
    expect(await invoiceDocByToken(tokenOf(id))).toMatchObject({ org: { address: ADDRESS }, bankDetails: BANK });
  });

  it("online unpaid: payable, and NO bank details whether or not the club set them - they are for offline invoices (counted)", async () => {
    let checked = 0;
    for (const bank of [null, BANK]) {
      const { id } = await made({ payment_method: "online" }, { bank });
      const doc = await invoiceDocByToken(tokenOf(id));
      expect(doc, String(bank)).toMatchObject({ state: "unpaid", method: "online", payable: true, bankDetails: null });
      checked++;
    }
    expect(checked).toBe(2);
    // The positive pair, on the same settings: an offline invoice of an org with bank details prints them.
    const { id } = await made({ payment_method: "offline" }, { bank: BANK });
    expect((await invoiceDocByToken(tokenOf(id)))!.bankDetails).toBe(BANK);
  });

  it("each state from its REAL producer: webhook paid; marked paid then refunded; ended unpaid (offline and online) - the same token throughout (counted)", async () => {
    const seen: string[] = [];
    // Online, paid by the payment webhook: paid, no longer payable, no bank details.
    {
      const { o, id } = await made({ payment_method: "online" }, { bank: BANK });
      const token = tokenOf(id);
      await paidByWebhook(o, id);
      expect(await invoiceDocByToken(token)).toMatchObject({ state: "paid", payable: false, bankDetails: null });
      seen.push("paid");
    }
    // Offline, marked paid then refunded (recorded only).
    {
      const { o, id } = await made({ payment_method: "offline" }, { bank: BANK });
      const token = tokenOf(id);
      await markDealPaid(o.auth, id);
      expect(await invoiceDocByToken(token)).toMatchObject({ state: "paid", payable: false, bankDetails: null });
      await refundDeal(o.auth, id);
      expect(await invoiceDocByToken(token)).toMatchObject({ state: "refunded", payable: false, bankDetails: null });
      seen.push("refunded");
    }
    // Ended unpaid: void, offline and online alike.
    for (const method of ["offline", "online"] as const) {
      const { o, id } = await made({ payment_method: method }, { bank: BANK });
      const token = tokenOf(id);
      await endDealNow(o.auth, id);
      expect(await invoiceDocByToken(token), method).toMatchObject({ state: "void", payable: false, bankDetails: null, method });
      seen.push(`void-${method}`);
    }
    expect(seen).toEqual(["paid", "refunded", "void-offline", "void-online"]);
  });

  it("an online deal still a DRAFT (Stripe failed at create: 502, the deal committed) has its token but is not payable - a payment could not move it", async () => {
    const o = await rigOrg();
    const p = await rigPackage(o);
    const s = await rigSponsor(o);
    stripe.create.mockRejectedValueOnce(new Error("stripe down"));
    await expect(createDeal(o.auth, s.id, dealInput(p.id, { payment_method: "online" }), ORIGIN)).rejects.toMatchObject({ status: 502 });
    const [row] = await sql<{ id: string; deal_status: string }[]>`select id, deal_status from sponsor_orders where sponsor_id = ${s.id}`;
    expect(row!.deal_status, "premise: committed as a draft").toBe("draft");
    expect(await invoiceDocByToken(tokenOf(row!.id))).toMatchObject({ state: "unpaid", payable: false });
  });

  it("complimentary: no number and NO token - mintInvoiceToken is never called for it", async () => {
    const { id } = await made({ payment_method: "complimentary" });
    expect(minted.filter((m) => m.dealId === id)).toEqual([]);
    expect(await invoiceCols(id)).toEqual({ invoice_number: null, invoice_token_hash: null });
  });

  it("the issue date is the deal's creation DAY in the org's timezone (20:00 UTC on 1 June is 2 June in Kiritimati, UTC+14)", async () => {
    const tz = "Pacific/Kiritimati";
    const { id } = await made({ payment_method: "offline" }, { timezone: tz });
    const at = new Date("2026-06-01T20:00:00.000Z");
    await sql`update sponsor_orders set created_at = ${at} where id = ${id}`;
    const expected = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
    expect(expected, "premise: the zone moves the day").toBe("2026-06-02");
    expect((await invoiceDocByToken(tokenOf(id)))!.issuedOn).toBe(expected);
  });

  it("a deal scoped to one competition names it in the line and in what is included; on stream follows the package's snapshot", async () => {
    const o = await rigOrg({ locale: "nl" });
    const [comp] = await sql<{ id: string; name: string }[]>`
      insert into competitions (org_id, name, slug) values (${o.orgId}, ${`Spring Cup ${uniq()}`}, ${`spring-${uniq()}`}) returning id, name`;
    const p = await rigPackage(o, { onStream: true });
    const s = await rigSponsor(o);
    const out = await createDeal(o.auth, s.id, dealInput(p.id, { payment_method: "offline", competition_id: comp!.id }), ORIGIN);
    const nl = await getDictionary("nl", "ui");
    const doc = await invoiceDocByToken(tokenOf(out.deal.id));
    expect(doc!.line.description).toBe(t(nl, "sponsors.invoice.line", { package: p.name, scope: comp!.name }));
    expect(doc!.included).toEqual({ tier: "partner", scope: comp!.name, onStream: true });
    expect(doc!.locale).toBe("nl");
  });

  it("the org's second invoice is SP-0002 and the two tokens open their own documents", async () => {
    const o = await rigOrg();
    const a = await madeOn(o, { payment_method: "offline" });
    const b = await madeOn(o, { payment_method: "online" });
    expect((await invoiceDocByToken(tokenOf(a.id)))!.number).toBe("SP-0001");
    expect((await invoiceDocByToken(tokenOf(b.id)))!.number).toBe("SP-0002");
  });

  it("a soft-deleted org's invoice is null (its token opens nothing)", async () => {
    const { o, id } = await made({ payment_method: "offline" });
    const token = tokenOf(id);
    expect(await invoiceDocByToken(token), "premise: opens while the org is live").not.toBeNull();
    await sql`update organizations set deleted_at = now() where id = ${o.orgId}`;
    expect(await invoiceDocByToken(token)).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("sendDealInvoice mints for a NUMBERED online deal with no token; keyed on the number, never the method (F9, carry m6)", () => {
  it("a numbered deal with no token (made before this task) gets one on its next send, and it resolves; a later send keeps it", async () => {
    const { o, id } = await made({ payment_method: "online" });
    tokenOf(id); // createDeal's own
    await sql`update sponsor_orders set invoice_token_hash = null where id = ${id}`; // as a deal made between T20 and T22 is
    minted.length = 0;
    await sendDealInvoice(o.auth, id, ORIGIN);
    const token = tokenOf(id);
    expect(await invoiceDocByToken(token)).toMatchObject({ number: "SP-0001", state: "unpaid", payable: true });
    const kept = (await invoiceCols(id)).invoice_token_hash;
    await sendDealInvoice(o.auth, id, ORIGIN);
    expect(minted, "no second mint: rotation is Task 23's").toHaveLength(1);
    expect((await invoiceCols(id)).invoice_token_hash, "the same hash").toEqual(kept);
    expect(await invoiceDocByToken(token)).not.toBeNull();
  });

  it("an UNNUMBERED online deal (a deal made before V500: seeded as the smoke suite seeds one) is sent but never minted - no number, no invoice", async () => {
    const o = await rigOrg();
    const p = await rigPackage(o);
    const s = await rigSponsor(o);
    const [row] = await sql<{ id: string }[]>`
      insert into sponsor_orders (org_id, package_id, sponsor_id, sponsor_name, sponsor_email, amount_cents, currency, status,
                                  deal_status, payment_method, go_live, tier, includes_on_stream, package_name, competition_id)
      values (${o.orgId}, ${p.id}, ${s.id}, ${s.name}, ${`old-${uniq()}@test.local`}, 25000, 'gbp', 'pending',
              'awaiting_payment', 'online', 'on_payment', 'partner', false, ${p.name}, ${null})
      returning id`;
    const out = await sendDealInvoice(o.auth, row!.id, ORIGIN);
    expect(out.checkout_url, "premise: the send itself worked").toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(minted).toEqual([]);
    expect(await invoiceCols(row!.id)).toEqual({ invoice_number: null, invoice_token_hash: null });
  });
});

describe.skipIf(!HAS_DB)("guards: no invoice without a number", () => {
  it("mintInvoiceToken refuses a deal with no number (a complimentary one; an unnumbered online one), writing nothing (counted)", async () => {
    const o = await rigOrg();
    const comp = await madeOn(o, { payment_method: "complimentary" });
    const p = await rigPackage(o);
    const s = await rigSponsor(o);
    const [old] = await sql<{ id: string }[]>`
      insert into sponsor_orders (org_id, package_id, sponsor_id, sponsor_name, sponsor_email, amount_cents, currency, status,
                                  deal_status, payment_method, go_live, tier, includes_on_stream, package_name, competition_id)
      values (${o.orgId}, ${p.id}, ${s.id}, ${s.name}, ${`old-${uniq()}@test.local`}, 25000, 'gbp', 'pending',
              'awaiting_payment', 'online', 'on_payment', 'partner', false, ${p.name}, ${null})
      returning id`;
    let checked = 0;
    for (const dealId of [comp.id, old!.id]) {
      await expect(withTenant(o.orgId, (tx) => mintInvoiceToken(tx, dealId))).rejects.toThrow(/no invoice number/);
      expect((await invoiceCols(dealId)).invoice_token_hash).toBeNull();
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a token on an UNNUMBERED row opens nothing: a real token, MOVED onto such a row (the one planted state here), is null; back on its own deal it opens", async () => {
    const o = await rigOrg();
    const real = await madeOn(o, { payment_method: "offline" });
    const token = tokenOf(real.id);
    const p = await rigPackage(o);
    const s = await rigSponsor(o);
    const [old] = await sql<{ id: string }[]>`
      insert into sponsor_orders (org_id, package_id, sponsor_id, sponsor_name, sponsor_email, amount_cents, currency, status,
                                  deal_status, payment_method, go_live, tier, includes_on_stream, package_name, competition_id)
      values (${o.orgId}, ${p.id}, ${s.id}, ${s.name}, ${`old-${uniq()}@test.local`}, 25000, 'gbp', 'pending',
              'awaiting_payment', 'online', 'on_payment', 'partner', false, ${p.name}, ${null})
      returning id`;
    const hash = (await invoiceCols(real.id)).invoice_token_hash!;
    await sql`update sponsor_orders set invoice_token_hash = null where id = ${real.id}`;
    await sql`update sponsor_orders set invoice_token_hash = ${hash} where id = ${old!.id}`;
    expect(await invoiceDocByToken(token)).toBeNull();
    await sql`update sponsor_orders set invoice_token_hash = null where id = ${old!.id}`;
    await sql`update sponsor_orders set invoice_token_hash = ${hash} where id = ${real.id}`;
    expect(await invoiceDocByToken(token), "the positive pair").not.toBeNull();
  });
});

describe.skipIf(!HAS_DB)("invoiceDocForDeal: the console's reader (the org's own deal, by id)", () => {
  it("is the same document the token opens; a deal with no invoice and another org's deal are each 404 (counted)", async () => {
    const { o, id } = await made({ payment_method: "online" }, { address: ADDRESS });
    expect(await invoiceDocForDeal(o.auth, id)).toEqual(await invoiceDocByToken(tokenOf(id)));
    const comp = await madeOn(o, { payment_method: "complimentary" });
    const other = await made({ payment_method: "offline" });
    let checked = 0;
    for (const [auth, dealId] of [[o.auth, comp.id], [o.auth, other.id], [other.o.auth, id]] as const) {
      const err = await invoiceDocForDeal(auth, dealId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(404);
      checked++;
    }
    expect(checked).toBe(3);
  });
});
