// Sponsor deals, Task 7 (plan 2026-11-07-sponsor-deals; spec §5.2 online, D14, F3, F11, F32, F37): an online deal's invoice
// is ONE reusable Stripe Checkout session, and every path that replaces, abandons or deletes a stored session retires it first.
//
// What is under test, and where each expected value comes from:
//   - the session rule, typed from the plan's Task 7 "session rule" (never read back from sponsors.ts): reuse while more than
//     10 minutes remain; else retrieve the stored session — `open` is expired then re-minted, `expired` is re-minted with no
//     expire call, `complete` is money in flight (no re-mint; Mark as paid is 409 `deal_paid_online`); an expire that throws
//     stops the action (502, nothing written) — two payable sessions for one deal must never coexist;
//   - the Stripe idempotency key `sponsor-deal-<id>-<invoice_send_count + 1>` and the invoice's once-key `<id>:<n>`, so a
//     resend is a new invoice and a retried send is not;
//   - F11: createDeal online answers { deal, checkout_url } with the minted url, and the deal itself carries no url;
//   - a Stripe failure after the deal committed leaves the deal as committed (a draft; or an immediate deal live with its
//     payment pending, Resend invoice offered) and answers 502;
//   - Mark as paid, End now and delete apply the session rule; an online refund with a charge goes through Stripe, one
//     hand-marked paid (no charge) is recorded only (T2-I1);
//   - every refusal beside its accepted twin.
// "Another sport" is not applicable (sponsors read no sport key); online selling is one plan's (Pro, `sponsors.monetize`), and
// community's refusal is covered in sponsor-deals.test.ts.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripe = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), expire: vi.fn(), refund: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: stripe.create, retrieve: stripe.retrieve, expire: stripe.expire } },
    refunds: { create: stripe.refund },
  }),
}));
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { routes } from "@/lib/routes";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { allowedActions, dealChip } from "@/lib/sponsor-deals";
import type { AuthCtx } from "@/server/api-v1/auth";
import { stubOutboxEnv } from "./_invite-mail";
import { deleteSponsor, refundSponsorOrder, resolveSponsors } from "../sponsors";
import {
  createDeal,
  endDealNow,
  getDeal,
  markDealPaid,
  refundDeal,
  sendDealInvoice,
  type CreateDealInput,
} from "../sponsor-deals";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const made = { orgIds: [] as string[], userIds: [] as string[] };
const ORIGIN = "https://deals-online.test";
const DAY = 86_400;

/** A Checkout session as Stripe answers `create`: `secondsLeft` until it expires. */
const session = (secondsLeft = DAY) => ({
  id: `cs_${uniq()}`,
  url: `https://checkout.stripe.test/${uniq()}`,
  expires_at: Math.floor(Date.now() / 1000) + secondsLeft,
});

/** Stripe's idempotency (sandbox-verified, task-6-7-report.md fix round): the same key answers the same session. */
const mintedByKey = new Map<string, ReturnType<typeof session>>();
const mintFor = (opts: { idempotencyKey: string }) => {
  let s = mintedByKey.get(opts.idempotencyKey);
  if (!s) mintedByKey.set(opts.idempotencyKey, (s = session()));
  return s;
};

beforeEach(() => {
  stubOutboxEnv();
  deliverMock.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_${uniq()}` }));
  mintedByKey.clear();
  stripe.create.mockReset().mockImplementation(async (_params: unknown, opts: { idempotencyKey: string }) => mintFor(opts));
  stripe.retrieve.mockReset().mockImplementation(async (id: string) => ({ id, status: "open" }));
  stripe.expire.mockReset().mockImplementation(async (id: string) => ({ id, status: "expired" }));
  stripe.refund.mockReset().mockImplementation(async () => ({ id: `re_${uniq()}` }));
});

afterAll(async () => {
  if (!HAS_DB) return;
  if (made.orgIds.length > 0) {
    await sql`delete from email_outbox where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from sponsor_orders where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  }
  if (made.userIds.length > 0) {
    await sql`delete from subscriptions where owner_user_id = any(${made.userIds}::uuid[])`;
    await sql`delete from users where id = any(${made.userIds}::uuid[])`;
  }
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Org {
  orgId: string;
  slug: string;
  auth: AuthCtx;
}

/** A Pro org (online selling is `sponsors.monetize`) with a Connect account that can take charges, edited by a real user. */
async function org(): Promise<Org> {
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${`online-${uniq()}@test.local`}, 'Deal Editor', true) returning id`;
  made.userIds.push(userId);
  const s = uniq();
  const slug = `online-${s}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, stripe_account_id, stripe_charges_enabled)
    values (${`Online ${s}`}, ${slug}, ${userId}, ${`acct_${s}`}, true) returning id`;
  made.orgIds.push(orgId);
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  return { orgId, slug, auth: { orgId, via: "session", userId, role: "owner", keyId: null } };
}

async function pkg(o: Org, price = 25_000): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsor_packages (org_id, name, price_cents, currency, tier) values (${o.orgId}, ${`Pkg ${uniq()}`}, ${price}, 'gbp', 'partner')
    returning id`;
  return row!.id;
}

async function sponsor(o: Org): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, name, tier, status) values (${o.orgId}, ${`Acme ${uniq()}`}, 'partner', 'active') returning id`;
  return row!.id;
}

const online = (packageId: string, over: Partial<CreateDealInput> = {}): CreateDealInput => ({
  package_id: packageId,
  competition_id: null,
  payment_method: "online",
  go_live: "on_payment",
  sponsor_email: `pay-${uniq()}@test.local`,
  ends_on: null,
  end_current: false,
  ...over,
});

/** An org, a package, a sponsor and an online deal on it (its first invoice sent: one Checkout session minted). */
async function onlineDeal(over: Partial<CreateDealInput> = {}) {
  const o = await org();
  const p = await pkg(o);
  const sponsorId = await sponsor(o);
  const out = await createDeal(o.auth, sponsorId, online(p, over), ORIGIN);
  return { o, p, sponsorId, out, id: out.deal.id };
}

type Stored = {
  deal_status: string;
  status: string;
  checkout_session_id: string | null;
  checkout_url: string | null;
  checkout_expires_at: Date | null;
  invoice_send_count: number;
  invoice_sent_at: Date | null;
};
const stored = async (id: string): Promise<Stored> =>
  (await sql<Stored[]>`
    select deal_status, status, checkout_session_id, checkout_url, checkout_expires_at, invoice_send_count, invoice_sent_at
      from sponsor_orders where id = ${id}`)[0]!;
const dealBytes = async (id: string): Promise<string | null> =>
  (await sql<{ row: string }[]>`select to_jsonb(d)::text as row from sponsor_orders d where d.id = ${id}`)[0]?.row ?? null;
const invoiceKeys = async (id: string): Promise<string[]> =>
  (await sql<{ dedupe_key: string }[]>`
    select dedupe_key from email_outbox where kind = 'sponsor_invoice' and ref_id = ${id} order by created_at, id`).map((r) => r.dedupe_key);
/** Move the stored session's expiry to `minutes` from now (a session nearing its end). */
const expiresIn = (id: string, minutes: number) =>
  sql`update sponsor_orders set checkout_expires_at = now() + make_interval(mins => ${minutes}) where id = ${id}`;
const listed = async (o: Org, sponsorId: string) => (await resolveSponsors(o.orgId)).some((s) => s.id === sponsorId);
/** The Stripe idempotency key of each `create` call so far. */
const mintKeys = () => stripe.create.mock.calls.map((c) => (c[1] as { idempotencyKey: string }).idempotencyKey);
/** The backends waiting on a lock held by backend `pid` (exact: a wait on anything else is not counted). */
const waitersOf = async (pid: number): Promise<number> =>
  (await sql<{ n: number }[]>`
    select count(*)::int as n from pg_stat_activity
     where datname = current_database() and ${pid}::int = any(pg_blocking_pids(pid))`)[0]!.n;

async function refusal(fn: () => Promise<unknown>): Promise<{ http: boolean; status: number | undefined; code: string | undefined }> {
  try {
    await fn();
  } catch (err) {
    const e = err as { status?: number; code?: string };
    return { http: err instanceof HttpError, status: e.status, code: e.code };
  }
  return { http: false, status: undefined, code: "no_refusal" };
}

describe.skipIf(!HAS_DB)("an online deal's invoice is one reusable Checkout session (DB)", () => {
  it("createDeal online answers { deal, checkout_url } with the minted url (F11), minted once with key …-1; a send inside the session's life REUSES it", async () => {
    const { o, id, out } = await onlineDeal();
    expect(stripe.create).toHaveBeenCalledTimes(1);
    const minted = (await stripe.create.mock.results[0]!.value) as { id: string; url: string; expires_at: number };
    expect(out.checkout_url).toBe(minted.url);
    expect(Object.keys(out).sort()).toEqual(["checkout_url", "deal"]);
    for (const key of ["checkout_url", "checkout_session_id", "checkout_expires_at", "invoice_send_count", "payment_intent_id"]) {
      expect(Object.keys(out.deal), `the deal carries no ${key}`).not.toContain(key);
    }
    expect(mintKeys()).toEqual([`sponsor-deal-${id}-1`]);
    expect(out.deal.deal_status, "a sent draft awaits payment").toBe("awaiting_payment");
    expect(out.deal.invoice_sent_at).not.toBeNull();
    const first = await stored(id);
    expect(first).toMatchObject({ checkout_session_id: minted.id, checkout_url: minted.url, invoice_send_count: 1 });
    expect(first.checkout_expires_at!.getTime()).toBe(minted.expires_at * 1000);

    const again = await sendDealInvoice(o.auth, id, ORIGIN);
    expect(again.checkout_url, "the same link while the session lives").toBe(minted.url);
    expect(stripe.create, "no second mint").toHaveBeenCalledTimes(1);
    expect(stripe.retrieve.mock.calls.map((c) => c[0]), "Stripe is asked once that the link is still open (review I1)").toEqual([minted.id]);
    expect(stripe.expire).not.toHaveBeenCalled();
    expect(await stored(id)).toMatchObject({ checkout_session_id: minted.id, invoice_send_count: 2, deal_status: "awaiting_payment" });
    expect(await invoiceKeys(id), "two sends are two invoices, one per count").toEqual([`${id}:1`, `${id}:2`]);
  });

  it("re-mint (F3): 15 minutes left is reused (Stripe says open); under 10 minutes the old session is retrieved (open) and expired ONCE, keyed per session, then …-3 is minted (the reuse moved the count)", async () => {
    const { o, id } = await onlineDeal();
    const old = (await stored(id)).checkout_session_id!;
    await expiresIn(id, 15);
    await sendDealInvoice(o.auth, id, ORIGIN);
    expect(stripe.create, "15 minutes left: reused").toHaveBeenCalledTimes(1);
    expect(stripe.retrieve.mock.calls.map((c) => c[0]), "asked once, open").toEqual([old]);

    await expiresIn(id, 5);
    const out = await sendDealInvoice(o.auth, id, ORIGIN);
    expect(stripe.retrieve.mock.calls.map((c) => c[0])).toEqual([old, old]);
    expect(stripe.expire.mock.calls.map((c) => c[0]), "the open session is expired before the new one").toEqual([old]);
    expect(stripe.expire.mock.calls[0]![2], "m3: the expire is keyed per session").toEqual({ idempotencyKey: `sponsor-session-expire-${old}` });
    expect(stripe.expire.mock.invocationCallOrder[0]!).toBeLessThan(stripe.create.mock.invocationCallOrder[1]!);
    expect(mintKeys()).toEqual([`sponsor-deal-${id}-1`, `sponsor-deal-${id}-3`]);
    const now = await stored(id);
    expect(now.checkout_session_id).not.toBe(old);
    expect(now.checkout_url).toBe(out.checkout_url);
    expect(now.invoice_send_count).toBe(3);
  });

  it("re-mint after the old session reports EXPIRED: no expire call, …-2 minted", async () => {
    const { o, id } = await onlineDeal();
    const old = (await stored(id)).checkout_session_id!;
    await expiresIn(id, 2);
    stripe.retrieve.mockImplementation(async (sid: string) => ({ id: sid, status: "expired" }));
    await sendDealInvoice(o.auth, id, ORIGIN);
    expect(stripe.retrieve.mock.calls.map((c) => c[0])).toEqual([old]);
    expect(stripe.expire).not.toHaveBeenCalled();
    expect(mintKeys()).toEqual([`sponsor-deal-${id}-1`, `sponsor-deal-${id}-2`]);
  });

  it("an open session that cannot be expired stops the mint (F3): 502, no create, the deal byte-equal, no invoice queued", async () => {
    const { o, id } = await onlineDeal();
    await expiresIn(id, 5);
    const before = await dealBytes(id);
    stripe.expire.mockImplementation(async () => {
      throw new Error("stripe: this session cannot be expired");
    });
    expect(await refusal(() => sendDealInvoice(o.auth, id, ORIGIN))).toMatchObject({ http: true, status: 502 });
    expect(stripe.expire).toHaveBeenCalledTimes(1);
    expect(stripe.create, "nothing minted beside the open session").toHaveBeenCalledTimes(1);
    expect(await dealBytes(id)).toBe(before);
    expect(await invoiceKeys(id)).toEqual([`${id}:1`]);
    // The twin: once the session can be expired, the same send goes through.
    stripe.expire.mockImplementation(async (sid: string) => ({ id: sid, status: "expired" }));
    await expect(sendDealInvoice(o.auth, id, ORIGIN)).resolves.toMatchObject({ deal: { id } });
    expect(stripe.create).toHaveBeenCalledTimes(2);
  });

  it("a COMPLETED stored session is money in flight: a send answers 409 deal_paid_online and mints nothing", async () => {
    const { o, id } = await onlineDeal();
    await expiresIn(id, 5);
    const before = await dealBytes(id);
    stripe.retrieve.mockImplementation(async (sid: string) => ({ id: sid, status: "complete" }));
    expect(await refusal(() => sendDealInvoice(o.auth, id, ORIGIN))).toEqual({ http: true, status: 409, code: "deal_paid_online" });
    expect(stripe.expire).not.toHaveBeenCalled();
    expect(stripe.create).toHaveBeenCalledTimes(1);
    expect(await dealBytes(id)).toBe(before);
  });

  it("review I1 (c): a stored session Stripe calls expired is never reused, however long its stored expiry: the send mints a fresh link; one Stripe calls complete is 409 deal_paid_online", async () => {
    const { o, id } = await onlineDeal();
    const dead = await stored(id);
    expect(dead.checkout_expires_at!.getTime(), "premise: a day left in the DB").toBeGreaterThan(Date.now() + 60 * 60_000);
    stripe.retrieve.mockImplementation(async (sid: string) => ({ id: sid, status: "expired" }));
    const out = await sendDealInvoice(o.auth, id, ORIGIN);
    expect(stripe.retrieve.mock.calls.map((c) => c[0])).toEqual([dead.checkout_session_id]);
    expect(stripe.expire, "already expired: no call").not.toHaveBeenCalled();
    expect(mintKeys()).toEqual([`sponsor-deal-${id}-1`, `sponsor-deal-${id}-2`]);
    expect(out.checkout_url, "never the dead link").not.toBe(dead.checkout_url);
    expect((await stored(id)).checkout_session_id).not.toBe(dead.checkout_session_id);

    const paid = await onlineDeal();
    const before = await dealBytes(paid.id);
    stripe.create.mockClear();
    stripe.retrieve.mockImplementation(async (sid: string) => ({ id: sid, status: "complete" }));
    expect(await refusal(() => sendDealInvoice(paid.o.auth, paid.id, ORIGIN))).toEqual({ http: true, status: 409, code: "deal_paid_online" });
    expect(stripe.create).not.toHaveBeenCalled();
    expect(await dealBytes(paid.id)).toBe(before);
  });

  it("m5: a send refused after its mint leaves no dead link stored, and the retry gets the SAME session (its Stripe key is the count)", async () => {
    const { o, id } = await onlineDeal();
    const old = (await stored(id)).checkout_session_id!;
    await expiresIn(id, 5); // a re-mint: the old session is expired, then …-2 minted
    stripe.create.mockImplementationOnce(async (_params: unknown, opts: { idempotencyKey: string }) => {
      // The deal ends while the link is minted: the locked re-check refuses the send.
      await sql`update sponsor_orders set deal_status = 'ended', ended_at = now(), ended_reason = 'ended_now' where id = ${id}`;
      return mintFor(opts);
    });
    expect(await refusal(() => sendDealInvoice(o.auth, id, ORIGIN))).toEqual({ http: true, status: 409, code: "deal_not_invoiceable" });
    expect(stripe.expire.mock.calls.map((c) => c[0])).toEqual([old]);
    expect(await stored(id), "the expired link is forgotten, not rolled back onto the deal").toMatchObject({
      checkout_session_id: null,
      checkout_url: null,
      checkout_expires_at: null,
      invoice_send_count: 1,
    });
    const refusedMint = (await stripe.create.mock.results[1]!.value) as { id: string; url: string };

    await sql`update sponsor_orders set deal_status = 'awaiting_payment', ended_at = null, ended_reason = null where id = ${id}`;
    const retry = await sendDealInvoice(o.auth, id, ORIGIN);
    expect(mintKeys()).toEqual([`sponsor-deal-${id}-1`, `sponsor-deal-${id}-2`, `sponsor-deal-${id}-2`]);
    expect(retry.checkout_url, "the retry gets the session the refused send minted").toBe(refusedMint.url);
    expect((await stored(id)).checkout_session_id).toBe(refusedMint.id);
  });

  it("a retried send at the same count queues ONE invoice (its once-key is the count); the next count queues the next", async () => {
    const { o, id } = await onlineDeal();
    // The count write was lost (the request retried): the same send runs again at count 1.
    await sql`update sponsor_orders set invoice_send_count = 0 where id = ${id}`;
    await sendDealInvoice(o.auth, id, ORIGIN);
    expect(await invoiceKeys(id), "the retry is the same invoice").toEqual([`${id}:1`]);
    await sendDealInvoice(o.auth, id, ORIGIN);
    expect(await invoiceKeys(id)).toEqual([`${id}:1`, `${id}:2`]);
  });

  it("the session: destination charge with the Pro fee, metadata naming the deal, success and cancel on /live/<slug> (F25), the sponsor's email", async () => {
    const { o, id } = await onlineDeal({ sponsor_email: "billing@acme.test" });
    const [params, opts] = stripe.create.mock.calls[0]! as [Record<string, never>, unknown];
    expect(opts).toEqual({ idempotencyKey: `sponsor-deal-${id}-1` });
    const hub = `${ORIGIN}${routes.publicHub(o.slug)}`;
    expect(hub).toBe(`${ORIGIN}/live/${o.slug}`);
    expect(params).toMatchObject({
      mode: "payment",
      customer_email: "billing@acme.test",
      metadata: { kind: "sponsor", order_id: id, org_id: o.orgId },
      success_url: `${hub}?sponsorship=success`,
      cancel_url: `${hub}?sponsorship=cancelled`,
      payment_intent_data: {
        // Pro's entry-fee percent is 2: 2% of 25000.
        application_fee_amount: 500,
        transfer_data: { destination: expect.stringMatching(/^acct_/) },
        metadata: { kind: "sponsor", order_id: id, org_id: o.orgId },
      },
    });
    expect(JSON.stringify(params)).not.toContain("/shared/");
    expect((params as unknown as { line_items: { price_data: { unit_amount: number; currency: string } }[] }).line_items[0]!.price_data).toMatchObject({
      unit_amount: 25_000,
      currency: "gbp",
    });
  });

  it("the invoice box is asked BEFORE any row or mint (P-W2-1): a box that cannot queue refuses the online deal; the twin box creates it", async () => {
    const o = await org();
    const p = await pkg(o);
    const sponsorId = await sponsor(o);
    vi.stubEnv("EMAIL_OUTBOX_KEK", "");
    await expect(createDeal(o.auth, sponsorId, online(p), ORIGIN)).rejects.toThrow(/EMAIL_OUTBOX_KEK/);
    expect(stripe.create).not.toHaveBeenCalled();
    expect(await sql`select 1 from sponsor_orders where org_id = ${o.orgId}`).toHaveLength(0);
    stubOutboxEnv();
    const sent = await createDeal(o.auth, sponsorId, online(p), ORIGIN);
    expect(sent).toMatchObject({ deal: { deal_status: "awaiting_payment" } });

    // A resend asks too, before Stripe: a box that lost its key mints, expires and writes nothing for an existing deal.
    await expiresIn(sent.deal.id, 5); // a re-mint is due, so a late check would already have retired the old session
    const before = await dealBytes(sent.deal.id);
    stripe.create.mockClear();
    vi.stubEnv("EMAIL_OUTBOX_KEK", "");
    await expect(sendDealInvoice(o.auth, sent.deal.id, ORIGIN)).rejects.toThrow(/EMAIL_OUTBOX_KEK/);
    expect(stripe.create, "no mint").not.toHaveBeenCalled();
    expect(stripe.retrieve, "no session read").not.toHaveBeenCalled();
    expect(stripe.expire, "no session expired").not.toHaveBeenCalled();
    expect(await dealBytes(sent.deal.id), "the deal byte-equal").toBe(before);
    stubOutboxEnv();
  });

  it("only an unpaid online deal is invoiceable: offline, paid online and ended online are 409 deal_not_invoiceable, before Stripe (counted)", async () => {
    const { o, p, sponsorId, id } = await onlineDeal();
    const offline = (await createDeal(o.auth, sponsorId, { ...online(p), payment_method: "offline" }, ORIGIN)).deal.id;
    const paid = (await createDeal(o.auth, await sponsor(o), online(p), ORIGIN)).deal.id;
    await sql`update sponsor_orders set status = 'paid', paid_at = now(), payment_intent_id = ${`pi_${uniq()}`} where id = ${paid}`;
    const ended = (await createDeal(o.auth, await sponsor(o), online(p), ORIGIN)).deal.id;
    stripe.retrieve.mockImplementation(async (sid: string) => ({ id: sid, status: "expired" }));
    await endDealNow(o.auth, ended);
    stripe.create.mockClear();
    stripe.retrieve.mockClear();
    let checked = 0;
    for (const dealId of [offline, paid, ended]) {
      expect(await refusal(() => sendDealInvoice(o.auth, dealId, ORIGIN))).toEqual({ http: true, status: 409, code: "deal_not_invoiceable" });
      checked++;
    }
    expect(checked).toBe(3);
    expect(stripe.create).not.toHaveBeenCalled();
    expect(stripe.retrieve).not.toHaveBeenCalled();
    await expect(sendDealInvoice(o.auth, id, ORIGIN), "the twin: the unpaid online deal").resolves.toMatchObject({ deal: { id } });
  });
});

describe.skipIf(!HAS_DB)("a Stripe failure after the deal committed leaves it as committed (DB)", () => {
  it("when paid: Stripe throws on create → 502, the deal stays a draft with no session and no invoice; Send invoice then sends it", async () => {
    const o = await org();
    const p = await pkg(o);
    const sponsorId = await sponsor(o);
    stripe.create.mockImplementationOnce(async () => {
      throw new Error("stripe is down");
    });
    expect(await refusal(() => createDeal(o.auth, sponsorId, online(p), ORIGIN))).toMatchObject({ http: true, status: 502 });
    const [row] = await sql<{ id: string }[]>`select id from sponsor_orders where sponsor_id = ${sponsorId}`;
    const deal = await getDeal(o.auth, row!.id);
    expect(deal).toMatchObject({ deal_status: "draft", payment_status: "pending", invoice_sent_at: null });
    expect(await stored(deal.id)).toMatchObject({ checkout_session_id: null, invoice_send_count: 0 });
    expect(await invoiceKeys(deal.id)).toEqual([]);
    expect(allowedActions(deal)).toContain("send_invoice");
    expect(await listed(o, sponsorId), "a draft hides its sponsor").toBe(false);
    const sent = await sendDealInvoice(o.auth, deal.id, ORIGIN);
    expect(sent.deal.deal_status).toBe("awaiting_payment");
    expect(await invoiceKeys(deal.id)).toEqual([`${deal.id}:1`]);
  });

  it("straight away: Stripe throws → 502, the deal is LIVE with its payment pending (awaitingPayment chip) and Resend invoice is offered", async () => {
    const o = await org();
    const p = await pkg(o);
    const sponsorId = await sponsor(o);
    stripe.create.mockImplementationOnce(async () => {
      throw new Error("stripe is down");
    });
    expect(await refusal(() => createDeal(o.auth, sponsorId, online(p, { go_live: "immediate" }), ORIGIN))).toMatchObject({ http: true, status: 502 });
    const [row] = await sql<{ id: string }[]>`select id from sponsor_orders where sponsor_id = ${sponsorId}`;
    const deal = await getDeal(o.auth, row!.id);
    expect(deal).toMatchObject({ deal_status: "live", payment_status: "pending" });
    expect(dealChip(deal).awaitingPayment).toBe(true);
    expect(allowedActions(deal)).toContain("resend_invoice");
    expect(await listed(o, sponsorId), "live on the public strip").toBe(true);
    await expect(sendDealInvoice(o.auth, deal.id, ORIGIN)).resolves.toMatchObject({ deal: { deal_status: "live" } });
  });

  it("visibility: when paid stays hidden after its invoice is sent; straight away is live after create with its payment pending", async () => {
    const { o, sponsorId, out } = await onlineDeal();
    expect(out.deal.deal_status).toBe("awaiting_payment");
    expect(await listed(o, sponsorId)).toBe(false);
    const now = await createDeal(o.auth, await sponsor(o), online(await pkg(o), { go_live: "immediate" }), ORIGIN);
    expect(now.deal).toMatchObject({ deal_status: "live", payment_status: "pending" });
    expect(dealChip(now.deal).awaitingPayment).toBe(true);
    expect(await listed(o, now.deal.sponsor_id!)).toBe(true);
    expect(now.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
  });
});

describe.skipIf(!HAS_DB)("Mark as paid, End now, refund and delete apply the session rule (DB)", () => {
  it("Mark as paid (F37): complete → 409 deal_paid_online, byte-equal; expired → paid with no expire call; open → one expire, then paid", async () => {
    const complete = await onlineDeal();
    stripe.retrieve.mockImplementation(async (sid: string) => ({ id: sid, status: "complete" }));
    const before = await dealBytes(complete.id);
    expect(await refusal(() => markDealPaid(complete.o.auth, complete.id))).toEqual({ http: true, status: 409, code: "deal_paid_online" });
    expect(await dealBytes(complete.id)).toBe(before);
    expect(stripe.expire).not.toHaveBeenCalled();

    const expired = await onlineDeal();
    stripe.retrieve.mockImplementation(async (sid: string) => ({ id: sid, status: "expired" }));
    const paid = await markDealPaid(expired.o.auth, expired.id);
    expect(paid).toMatchObject({ payment_status: "paid", deal_status: "live" });
    expect(stripe.expire).not.toHaveBeenCalled();
    expect(await stored(expired.id), "the dead link is cleared").toMatchObject({ checkout_session_id: null, checkout_url: null });

    const open = await onlineDeal();
    const sid = (await stored(open.id)).checkout_session_id!;
    stripe.retrieve.mockImplementation(async (id: string) => ({ id, status: "open" }));
    const paidOpen = await markDealPaid(open.o.auth, open.id);
    expect(stripe.expire.mock.calls.map((c) => c[0])).toEqual([sid]);
    expect(paidOpen).toMatchObject({ payment_status: "paid", deal_status: "live" });
    expect(await stored(open.id)).toMatchObject({ checkout_session_id: null, checkout_url: null, checkout_expires_at: null });
  });

  it("End now (F3): an open session is expired, then the deal ends with no payable link; a completed one ends anyway (no expire)", async () => {
    const open = await onlineDeal();
    const sid = (await stored(open.id)).checkout_session_id!;
    const ended = await endDealNow(open.o.auth, open.id);
    expect(stripe.expire.mock.calls.map((c) => c[0])).toEqual([sid]);
    expect(ended).toMatchObject({ deal_status: "ended", ended_reason: "ended_now" });
    expect(await stored(open.id)).toMatchObject({ checkout_session_id: null, checkout_url: null });

    const done = await onlineDeal();
    stripe.expire.mockClear();
    stripe.retrieve.mockImplementation(async (id: string) => ({ id, status: "complete" }));
    await expect(endDealNow(done.o.auth, done.id)).resolves.toMatchObject({ deal_status: "ended" });
    expect(stripe.expire).not.toHaveBeenCalled();
  });

  it("End now: an open session that cannot be expired stops the end (502), the deal byte-equal", async () => {
    const d = await onlineDeal();
    stripe.expire.mockImplementation(async () => {
      throw new Error("no");
    });
    const before = await dealBytes(d.id);
    expect(await refusal(() => endDealNow(d.o.auth, d.id))).toMatchObject({ http: true, status: 502 });
    expect(await dealBytes(d.id)).toBe(before);
  });

  it("the send asks again under the lock: a payment recorded while the link is minted is 409 deal_not_invoiceable, and a concurrent send that moved the count first is 409 deal_changed; neither queues an invoice", async () => {
    // Under 10 minutes left forces a re-mint, so Stripe's create runs between the unlocked read and the lock: the hook.
    const paidMeanwhile = await onlineDeal();
    await expiresIn(paidMeanwhile.id, 5);
    stripe.create.mockImplementationOnce(async () => {
      await sql`update sponsor_orders set status = 'paid', paid_at = now(), payment_intent_id = ${`pi_${uniq()}`} where id = ${paidMeanwhile.id}`;
      return session();
    });
    expect(await refusal(() => sendDealInvoice(paidMeanwhile.o.auth, paidMeanwhile.id, ORIGIN))).toEqual({ http: true, status: 409, code: "deal_not_invoiceable" });
    expect(await invoiceKeys(paidMeanwhile.id), "no second invoice").toEqual([`${paidMeanwhile.id}:1`]);
    expect((await stored(paidMeanwhile.id)).invoice_send_count).toBe(1);

    const raced = await onlineDeal();
    await expiresIn(raced.id, 5);
    stripe.create.mockImplementationOnce(async () => {
      await sql`update sponsor_orders set invoice_send_count = invoice_send_count + 1 where id = ${raced.id}`;
      return session();
    });
    expect(await refusal(() => sendDealInvoice(raced.o.auth, raced.id, ORIGIN))).toEqual({ http: true, status: 409, code: "deal_changed" });
    expect(await invoiceKeys(raced.id), "no invoice for the stale send").toEqual([`${raced.id}:1`]);
  });

  it("a recorded refund asks again under the lock: a charge recorded on a hand-marked deal while it waits is never written down by hand (409 deal_changed, still paid, no Stripe call)", async () => {
    const d = await onlineDeal();
    stripe.retrieve.mockImplementation(async (id: string) => ({ id, status: "expired" }));
    await markDealPaid(d.o.auth, d.id);
    expect((await stored(d.id)).status, "premise: paid by hand").toBe("paid");
    stripe.refund.mockClear();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let holderPid = 0;
    let ready!: () => void;
    const holding = new Promise<void>((r) => (ready = r));
    // A writer in the lock order (F2): the sponsor first, then a charge recorded on the deal, committed when the gate opens.
    const holder = sql.begin(async (tx) => {
      await tx`select 1 from sponsors where id = ${d.sponsorId} for update`;
      await tx`update sponsor_orders set payment_intent_id = ${`pi_${uniq()}`} where id = ${d.id}`;
      holderPid = (await tx<{ pid: number }[]>`select pg_backend_pid() as pid`)[0]!.pid;
      ready();
      await gate;
    });
    holder.catch(() => undefined);
    try {
      await holding;
      const refunding = refusal(() => refundDeal(d.o.auth, d.id));
      refunding.catch(() => undefined);
      const deadline = Date.now() + 10_000;
      let waiting = 0;
      while (Date.now() < deadline && (waiting = await waitersOf(holderPid)) === 0) await new Promise((r) => setTimeout(r, 25));
      expect(waiting, "the refund waits on the holder's sponsor lock").toBe(1);
      release();
      await holder;
      expect(await refunding).toEqual({ http: true, status: 409, code: "deal_changed" });
      expect((await stored(d.id)).status, "nothing recorded").toBe("paid");
      expect(stripe.refund).not.toHaveBeenCalled();
    } finally {
      release();
      await holder.catch(() => undefined);
    }
  });

  it("review I1 (a): a create refused for its rules (complimentary on payment) with end_current touches no link: no retrieve, no expire, the live deal byte-equal", async () => {
    const d = await onlineDeal({ go_live: "immediate" });
    expect((await stored(d.id)).deal_status, "premise: live with an open link").toBe("live");
    const before = await dealBytes(d.id);
    stripe.retrieve.mockClear();
    stripe.expire.mockClear();
    const comp = { ...online(d.p), payment_method: "complimentary" as const, go_live: "on_payment" as const, sponsor_email: null, end_current: true };
    expect(await refusal(() => createDeal(d.o.auth, d.sponsorId, comp, ORIGIN))).toEqual({ http: true, status: 422, code: "on_payment_needs_payment" });
    expect(stripe.retrieve).not.toHaveBeenCalled();
    expect(stripe.expire).not.toHaveBeenCalled();
    expect(await dealBytes(d.id)).toBe(before);
  });

  it("a new deal that ends the current one (end_current) retires the live deal's open session first (F3); one it cannot expire stops the create (502), nothing written", async () => {
    // Straight away: the online deal is live from create, its payment pending, its session open.
    const d = await onlineDeal({ go_live: "immediate" });
    const sid = (await stored(d.id)).checkout_session_id!;
    expect((await stored(d.id)).deal_status, "premise: live with a session").toBe("live");
    const offline = { ...online(d.p), payment_method: "offline" as const, go_live: "immediate" as const, sponsor_email: null, end_current: true };

    stripe.expire.mockImplementation(async () => {
      throw new Error("no");
    });
    const before = await dealBytes(d.id);
    expect(await refusal(() => createDeal(d.o.auth, d.sponsorId, offline, ORIGIN))).toMatchObject({ http: true, status: 502 });
    expect(await dealBytes(d.id), "the live deal is untouched").toBe(before);
    expect((await sql`select 1 from sponsor_orders where sponsor_id = ${d.sponsorId}`).length, "and no new deal").toBe(1);

    stripe.expire.mockReset().mockImplementation(async (id: string) => ({ id, status: "expired" }));
    const next = await createDeal(d.o.auth, d.sponsorId, offline, ORIGIN);
    expect(stripe.expire.mock.calls.map((c) => c[0]), "the open session expired once").toEqual([sid]);
    expect(await stored(d.id)).toMatchObject({ deal_status: "ended", checkout_session_id: null, checkout_url: null, checkout_expires_at: null });
    expect(next.deal.deal_status).toBe("live");
  });

  it("refund: a deal paid by a charge refunds through Stripe (reverse transfer, fee back, keyed per deal); a hand-marked online deal is recorded only", async () => {
    const charged = await onlineDeal();
    const intent = `pi_${uniq()}`;
    await sql`update sponsor_orders set status = 'paid', paid_at = now(), payment_intent_id = ${intent} where id = ${charged.id}`;
    const refunded = await refundDeal(charged.o.auth, charged.id);
    expect(refunded.payment_status).toBe("refunded");
    expect(stripe.refund).toHaveBeenCalledTimes(1);
    const [params, opts] = stripe.refund.mock.calls[0]!;
    expect(params).toEqual({ payment_intent: intent, reverse_transfer: true, refund_application_fee: true });
    expect(opts).toEqual({ idempotencyKey: `sponsor-refund-${charged.id}` });
    expect(await refusal(() => refundDeal(charged.o.auth, charged.id)), "once").toEqual({ http: true, status: 409, code: "deal_not_refundable" });
    expect(stripe.refund).toHaveBeenCalledTimes(1);

    const byHand = await onlineDeal();
    stripe.retrieve.mockImplementation(async (id: string) => ({ id, status: "expired" }));
    await markDealPaid(byHand.o.auth, byHand.id);
    stripe.refund.mockClear();
    const recorded = await refundDeal(byHand.o.auth, byHand.id);
    expect(recorded).toMatchObject({ payment_status: "refunded", deal_status: "ended", ended_reason: "refunded" });
    expect(stripe.refund, "no charge moved this money: no Stripe call (T2-I1)").not.toHaveBeenCalled();
  });

  it("m2: a Stripe refund failure is the documented 502 stripe_unavailable in our words (never a 500 with Stripe's text), nothing recorded; the twin refunds; a lost refund race is 409 deal_not_refundable", async () => {
    const d = await onlineDeal();
    await sql`update sponsor_orders set status = 'paid', paid_at = now(), payment_intent_id = ${`pi_${uniq()}`} where id = ${d.id}`;
    stripe.refund.mockImplementationOnce(async () => {
      throw new Error("Stripe: charge ch_3Secret is in a state that cannot be refunded");
    });
    let caught: unknown;
    try {
      await refundDeal(d.o.auth, d.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught).toMatchObject({ status: 502, code: "stripe_unavailable" });
    expect((caught as Error).message, "our words, not Stripe's").not.toContain("ch_");
    expect((await stored(d.id)).status, "nothing recorded").toBe("paid");
    await expect(refundDeal(d.o.auth, d.id), "the twin: Stripe answers, the refund lands").resolves.toMatchObject({ payment_status: "refunded" });
    // The race a second refund loses (its preflight passed before the first landed) answers coded, never an uncoded 422.
    expect(await refusal(() => refundSponsorOrder(d.o.auth, d.id))).toEqual({ http: true, status: 409, code: "deal_not_refundable" });
  });

  it("delete (F3): the open session is expired, then the sponsor and its deal go; an unexpirable or completed session is 409 sponsor_has_open_checkout, nothing deleted", async () => {
    const gone = await onlineDeal();
    const sid = (await stored(gone.id)).checkout_session_id!;
    await deleteSponsor(gone.o.auth, gone.sponsorId);
    expect(stripe.expire.mock.calls.map((c) => c[0])).toEqual([sid]);
    expect(await sql`select 1 from sponsors where id = ${gone.sponsorId}`).toHaveLength(0);
    expect(await sql`select 1 from sponsor_orders where id = ${gone.id}`).toHaveLength(0);

    let checked = 0;
    for (const [label, arm] of [
      ["cannot be expired", () => stripe.expire.mockImplementation(async () => { throw new Error("no"); })],
      ["completed", () => stripe.retrieve.mockImplementation(async (id: string) => ({ id, status: "complete" }))],
    ] as const) {
      const kept = await onlineDeal();
      arm();
      const before = await dealBytes(kept.id);
      expect(await refusal(() => deleteSponsor(kept.o.auth, kept.sponsorId)), label).toEqual({ http: true, status: 409, code: "sponsor_has_open_checkout" });
      expect(await sql`select 1 from sponsors where id = ${kept.sponsorId}`, label).toHaveLength(1);
      expect(await dealBytes(kept.id), label).toBe(before);
      stripe.expire.mockReset().mockImplementation(async (id: string) => ({ id, status: "expired" }));
      stripe.retrieve.mockReset().mockImplementation(async (id: string) => ({ id, status: "open" }));
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("review I1 (a): a delete refused on a session paid at Stripe expires NOTHING — whichever of the sponsor's two links Stripe calls complete (counted)", async () => {
    let checked = 0;
    for (const completeIsFirstMade of [true, false]) {
      const o = await org();
      const p = await pkg(o);
      const sp = await sponsor(o);
      const a = (await createDeal(o.auth, sp, online(p), ORIGIN)).deal.id;
      const b = (await createDeal(o.auth, sp, online(p), ORIGIN)).deal.id;
      const sa = (await stored(a)).checkout_session_id!;
      const sb = (await stored(b)).checkout_session_id!;
      const paidAtStripe = completeIsFirstMade ? sa : sb;
      stripe.retrieve.mockImplementation(async (sid: string) => ({ id: sid, status: sid === paidAtStripe ? "complete" : "open" }));
      stripe.expire.mockClear();
      const label = completeIsFirstMade ? "the first deal paid at Stripe" : "the second deal paid at Stripe";
      expect(await refusal(() => deleteSponsor(o.auth, sp)), label).toEqual({ http: true, status: 409, code: "sponsor_has_open_checkout" });
      expect(stripe.expire, `${label}: no link closed`).not.toHaveBeenCalled();
      expect((await stored(a)).checkout_session_id, label).toBe(sa);
      expect((await stored(b)).checkout_session_id, label).toBe(sb);
      checked++;
    }
    expect(checked, "orders checked").toBe(2);
  });

  it("review I1 (b): a delete that closed one link and then failed to close the next forgets the closed one (committed), so Resend mints afresh; the other stays stored", async () => {
    const o = await org();
    const p = await pkg(o);
    const sp = await sponsor(o);
    const a = (await createDeal(o.auth, sp, online(p), ORIGIN)).deal.id;
    const b = (await createDeal(o.auth, sp, online(p), ORIGIN)).deal.id;
    const byId = { [(await stored(a)).checkout_session_id!]: a, [(await stored(b)).checkout_session_id!]: b };
    stripe.expire.mockImplementation(async (sid: string) => {
      if (stripe.expire.mock.calls.length > 1) throw new Error("stripe: try again later");
      return { id: sid, status: "expired" };
    });
    expect(await refusal(() => deleteSponsor(o.auth, sp))).toEqual({ http: true, status: 409, code: "sponsor_has_open_checkout" });
    expect(stripe.expire).toHaveBeenCalledTimes(2);
    const closed = stripe.expire.mock.calls[0]![0] as string;
    const open = stripe.expire.mock.calls[1]![0] as string;
    expect(await stored(byId[closed]!), "the closed link is forgotten, though the delete refused").toMatchObject({
      checkout_session_id: null,
      checkout_url: null,
      checkout_expires_at: null,
    });
    expect((await stored(byId[open]!)).checkout_session_id, "the link it could not close stays stored").toBe(open);
    expect(await sql`select 1 from sponsors where id = ${sp}`).toHaveLength(1);

    stripe.create.mockClear();
    stripe.retrieve.mockClear();
    const resent = await sendDealInvoice(o.auth, byId[closed]!, ORIGIN);
    expect(stripe.create, "Resend mints: no dead link to reuse").toHaveBeenCalledTimes(1);
    expect(stripe.retrieve, "nothing stored to ask about").not.toHaveBeenCalled();
    expect((await stored(byId[closed]!)).checkout_url).toBe(resent.checkout_url);
  });

  it("review I1 (b): Mark as paid closed the link, then the locked re-check refused (paid meanwhile): the closed link is forgotten, not rolled back", async () => {
    const d = await onlineDeal();
    const sid = (await stored(d.id)).checkout_session_id!;
    stripe.expire.mockImplementationOnce(async (s: string) => {
      await sql`update sponsor_orders set status = 'paid', paid_at = now(), payment_intent_id = ${`pi_${uniq()}`} where id = ${d.id}`;
      return { id: s, status: "expired" };
    });
    expect(await refusal(() => markDealPaid(d.o.auth, d.id))).toEqual({ http: true, status: 409, code: "deal_already_paid" });
    expect(stripe.expire.mock.calls.map((c) => c[0])).toEqual([sid]);
    expect(await stored(d.id)).toMatchObject({ checkout_session_id: null, checkout_url: null, checkout_expires_at: null });
  });

  it("delete: a sponsor with money history is refused BEFORE any open session of its other deals is touched", async () => {
    const d = await onlineDeal();
    const paidDeal = (await createDeal(d.o.auth, d.sponsorId, { ...online(d.p), payment_method: "offline" }, ORIGIN)).deal.id;
    await sql`update sponsor_orders set status = 'paid', paid_at = now() where id = ${paidDeal}`;
    stripe.retrieve.mockClear();
    expect(await refusal(() => deleteSponsor(d.o.auth, d.sponsorId))).toEqual({ http: true, status: 409, code: "sponsor_has_deal_history" });
    expect(stripe.retrieve).not.toHaveBeenCalled();
    expect(stripe.expire).not.toHaveBeenCalled();
    expect((await stored(d.id)).checkout_session_id, "the other deal's link is untouched").not.toBeNull();
  });
});
