// Sponsor deals T22 - the invoice's two handlers: GET /r/sponsor/invoice/[token]/pdf and POST /r/sponsor/invoice/[token]/pay
// (spec §7; brief "The routes" and "Money").
//
// The seam is real: the REAL createDeal mints the token (the real `mintInvoiceToken`, wrapped to read it, F9), the real handler
// reads it, the real `payInvoice` takes its session from the real `ensureDealCheckout` (F32) against a Stripe stand-in with
// Stripe's own idempotency (the same key answers the same session, so a re-used key would surface as a STALE link here).
//
// Money (brief):
//   - an open session with more than 10 minutes left is reused: two POSTs, no new create;
//   - a session with under 10 minutes left is expired BEFORE a new one is minted, and the new one is then reused (one create
//     across two POSTs);
//   - each re-mint uses a NEW idempotency key, so the sponsor never gets the stale link back (two re-mints, two keys, two urls);
//   - a paid invoice is refused - 303 BACK to the invoice page (review m7: it shows where the invoice stands) - and nothing at
//     Stripe is touched; so is an offline one, and one the club can no longer take cards for (402 plan, 409 Connect: review m3);
//     an unknown token is the 404;
//   - the lock (review I1, I2): the club marks the deal paid, or ends it, while Stripe mints - refused, nothing stored; a send
//     that stored a DIFFERENT session meanwhile - refused, the send's session kept; two clicks that mint the same session - both
//     sent to it.
// Killer for "payable ignores the paid state": the paid case (it would 303 to Stripe, or reach Stripe).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { Tx } from "@/lib/db";

const ctx = vi.hoisted(() => ({ locale: "en" as "en" | "es" | "fr" | "nl" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => ctx.locale }));
const stripe = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: stripe.create, retrieve: stripe.retrieve, expire: stripe.expire } } }),
}));
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));
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

import { sql, statementCount } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { invoicePath } from "@/lib/sponsor-invoice";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { getDictionary, t } from "@/lib/i18n";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { handleSponsorPaymentSucceeded } from "@/server/usecases/sponsors";
import { createDeal, endDealNow, markDealPaid, sendDealInvoice } from "@/server/usecases/sponsor-deals";
import { ORIGIN, cleanUp, dealInput, idempotentCreate, rigOrg, rigPackage, rigSponsor, uniq, type RigOrg } from "@/server/sponsors/__tests__/_invoice-rig";
import { GET as getPdf } from "../pdf/route";
import { POST as postPay } from "../pay/route";

const HAS_DB = !!process.env.DATABASE_URL;
const en = await getDictionary("en", "ui");
const fr = await getDictionary("fr", "ui");

let overLimit = false;
beforeEach(() => {
  minted.length = 0;
  overLimit = false;
  ctx.locale = "en";
  stubOutboxEnv();
  deliverMock.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_${uniq()}` }));
  stripe.create.mockReset().mockImplementation(idempotentCreate());
  stripe.retrieve.mockReset().mockImplementation(async (id: string) => ({ id, status: "open" }));
  stripe.expire.mockReset().mockImplementation(async (id: string) => ({ id, status: "expired" }));
  let n = 0;
  __setRateLimitCounterForTests(async () => ({ count: overLimit ? 61 : ++n, ttlMs: 30_000 }));
});
afterAll(async () => {
  __setRateLimitCounterForTests(null);
  if (HAS_DB) await cleanUp();
});

const ip = () => `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
const pdf = (token: string) =>
  getPdf(new Request(`${ORIGIN}/r/sponsor/invoice/${token}/pdf`, { headers: { "x-forwarded-for": ip() } }), { params: Promise.resolve({ token }) });
const pay = (token: string) =>
  postPay(new Request(`${ORIGIN}/r/sponsor/invoice/${token}/pay`, { method: "POST", headers: { "x-forwarded-for": ip() } }), {
    params: Promise.resolve({ token }),
  });
const stripeCalls = () => stripe.create.mock.calls.length + stripe.expire.mock.calls.length + stripe.retrieve.mock.calls.length;
function clearStripe(): void {
  stripe.create.mockClear();
  stripe.retrieve.mockClear();
  stripe.expire.mockClear();
}

/** The deal's stored session and send count. */
async function stored(id: string): Promise<{ checkout_session_id: string | null; checkout_url: string | null; invoice_send_count: number }> {
  const [row] = await sql<{ checkout_session_id: string | null; checkout_url: string | null; invoice_send_count: number }[]>`
    select checkout_session_id, checkout_url, invoice_send_count from sponsor_orders where id = ${id}`;
  return row!;
}

/** A pay refused back to the invoice page: 303 to the page itself (never to Stripe), private. */
function expectBackToInvoice(res: Response, token: string): void {
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(invoicePath(token));
  expectPrivate(res);
}

/** The headers every answer of both handlers carries (lib/sponsor-invoice.ts INVOICE_PRIVATE_HEADERS). */
function expectPrivate(res: Response): void {
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
}

async function deal(o: RigOrg, method: "online" | "offline") {
  const p = await rigPackage(o);
  const s = await rigSponsor(o);
  const out = await createDeal(o.auth, s.id, dealInput(p.id, { payment_method: method }), ORIGIN);
  const mine = minted.filter((m) => m.dealId === out.deal.id);
  // createDeal mints one (F9); an online create also sends its invoice, which mints the one it mails (Task 23). The last is in effect.
  expect(mine, "premise: createDeal minted, and an online create's send minted again").toHaveLength(method === "online" ? 2 : 1);
  return { id: out.deal.id, token: mine.at(-1)!.token, checkoutUrl: out.checkout_url };
}

describe("before the lookup", () => {
  it("over the public budget: both handlers answer 429 in the reader's language and spend no statement", async () => {
    overLimit = true;
    ctx.locale = "fr";
    const token = randomBytes(32).toString("base64url");
    for (const res of [await pdf(token), await pay(token)]) {
      expect(res.status).toBe(429);
      expect(await res.text()).toBe(t(fr, "sponsors.invoice.throttled.body"));
      expectPrivate(res);
    }
    const before = statementCount();
    await pdf(token);
    await pay(token);
    expect(statementCount() - before).toBe(0);
    expect(stripeCalls()).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("the PDF handler", () => {
  it("empty case: an unknown token is the opaque 404, plain text, nothing rendered", async () => {
    const res = await pdf(randomBytes(32).toString("base64url"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe(t(en, "sponsors.invoice.notFound.body"));
    expectPrivate(res);
  });

  it("a real token: application/pdf, an attachment named after the number, never cached", async () => {
    const o = await rigOrg();
    const { token } = await deal(o, "offline");
    const res = await pdf(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="SP-0001.pdf"');
    expectPrivate(res);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe.skipIf(!HAS_DB)("the pay handler (money)", () => {
  it("empty case: an unknown token is the 404 and touches nothing at Stripe", async () => {
    const res = await pay(randomBytes(32).toString("base64url"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(t(en, "sponsors.invoice.notFound.body"));
    expect(stripeCalls()).toBe(0);
  });

  it("an open session with more than 10 minutes left is reused: two POSTs, 303 to the same Checkout, no create", async () => {
    const o = await rigOrg();
    const { token, checkoutUrl } = await deal(o, "online");
    expect(checkoutUrl, "premise: createDeal minted the deal's session").toMatch(/^https:\/\/checkout\.stripe\.test\//);
    stripe.create.mockClear();
    for (let i = 0; i < 2; i++) {
      const res = await pay(token);
      expect(res.status, `POST ${i + 1}`).toBe(303);
      expect(res.headers.get("location")).toBe(checkoutUrl);
      expectPrivate(res);
    }
    expect(stripe.create).not.toHaveBeenCalled();
    expect(stripe.expire).not.toHaveBeenCalled();
  });

  it("a session with under 10 minutes left is expired BEFORE a new one is minted, then the new one is reused: one create across two POSTs", async () => {
    const o = await rigOrg();
    const { id, token, checkoutUrl } = await deal(o, "online");
    const [{ checkout_session_id: oldSession }] = await sql<{ checkout_session_id: string }[]>`
      update sponsor_orders set checkout_expires_at = now() + interval '5 minutes' where id = ${id} returning checkout_session_id`;
    stripe.create.mockClear();
    const order: string[] = [];
    stripe.expire.mockImplementation(async (sid: string) => (order.push(`expire ${sid}`), { id: sid, status: "expired" }));
    const create = idempotentCreate();
    stripe.create.mockImplementation(async (params: unknown, opts: { idempotencyKey: string }) => (order.push("create"), create(params, opts)));

    const first = await pay(token);
    expect(first.status).toBe(303);
    const fresh = first.headers.get("location")!;
    expect(fresh, "a NEW link, not the one about to lapse").not.toBe(checkoutUrl);
    expect(order).toEqual([`expire ${oldSession}`, "create"]);
    const second = await pay(token);
    expect(second.status).toBe(303);
    expect(second.headers.get("location")).toBe(fresh);
    expect(stripe.create).toHaveBeenCalledTimes(1);
  });

  it("each re-mint uses a new idempotency key, so the sponsor never gets the stale link back (2 re-mints counted)", async () => {
    const o = await rigOrg();
    const { id, token, checkoutUrl } = await deal(o, "online");
    const keys = [(stripe.create.mock.calls.at(-1)![1] as { idempotencyKey: string }).idempotencyKey];
    const urls = [checkoutUrl];
    for (let i = 0; i < 2; i++) {
      await sql`update sponsor_orders set checkout_expires_at = now() + interval '1 minute' where id = ${id}`;
      const res = await pay(token);
      expect(res.status).toBe(303);
      urls.push(res.headers.get("location"));
      keys.push((stripe.create.mock.calls.at(-1)![1] as { idempotencyKey: string }).idempotencyKey);
    }
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size, keys.join(", ")).toBe(3);
    expect(new Set(urls).size, "three distinct links").toBe(3);
    const [{ checkout_url }] = await sql<{ checkout_url: string }[]>`select checkout_url from sponsor_orders where id = ${id}`;
    expect(checkout_url, "the stored link is the last one handed out").toBe(urls[2]);
  });

  it("a PAID invoice is refused: 303 back to the invoice page (where it reads Paid), and nothing at Stripe is touched", async () => {
    const o = await rigOrg();
    const { id, token } = await deal(o, "online");
    // The payment webhook, as invoice-doc.test.ts drives it (a PaymentIntent with the deal in its metadata).
    await handleSponsorPaymentSucceeded({ id: `pi_invoice_${uniq()}`, metadata: { kind: "sponsor", order_id: id, org_id: o.orgId } } as never);
    const [{ status }] = await sql<{ status: string }[]>`select status from sponsor_orders where id = ${id}`;
    expect(status, "premise: the webhook paid it").toBe("paid");
    clearStripe();
    const res = await pay(token);
    expectBackToInvoice(res, token);
    expect(stripeCalls()).toBe(0);
    // The positive pair: the invoice itself still opens (a paid invoice is a receipt).
    expect((await pdf(token)).status).toBe(200);
  });

  it("an OFFLINE invoice is refused too (303 back), and no session is minted for it", async () => {
    const o = await rigOrg();
    const { id, token } = await deal(o, "offline");
    const res = await pay(token);
    expectBackToInvoice(res, token);
    expect(stripeCalls()).toBe(0);
    const [row] = await sql<{ checkout_session_id: string | null }[]>`select checkout_session_id from sponsor_orders where id = ${id}`;
    expect(row!.checkout_session_id).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("the pay handler: Stripe already has the card payment, the webhook has not landed (T22 re-review M1)", () => {
  it("the stored session is COMPLETE at Stripe: 303 back WITH the 'being recorded' notice, nothing minted, expired or stored - fresh and near-expiry alike (2 counted)", async () => {
    let checked = 0;
    for (const nearExpiry of [false, true]) {
      const o = await rigOrg();
      const { id, token } = await deal(o, "online");
      if (nearExpiry) await sql`update sponsor_orders set checkout_expires_at = now() + interval '5 minutes' where id = ${id}`;
      const before = await stored(id);
      clearStripe();
      stripe.retrieve.mockImplementation(async (sid: string) => ({ id: sid, status: "complete" }));
      const res = await pay(token);
      expect(res.status, String(nearExpiry)).toBe(303);
      // The flag the page reads (re-review M1): typed here, not built by the code under test.
      expect(res.headers.get("location"), String(nearExpiry)).toBe(`/r/sponsor/invoice/${token}?notice=recording`);
      expectPrivate(res);
      expect(stripe.retrieve, "premise: Stripe was asked").toHaveBeenCalledTimes(1);
      expect(stripe.create).not.toHaveBeenCalled();
      expect(stripe.expire).not.toHaveBeenCalled();
      expect(await stored(id), String(nearExpiry)).toEqual(before);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe.skipIf(!HAS_DB)("the pay handler: the club cannot take cards (review m2, m3)", () => {
  it("the plan lost sponsors.monetize (402) and Connect stopped taking charges (409 connect_required): each 303 back, nothing at Stripe (2 counted)", async () => {
    const cuts: [string, (o: RigOrg) => Promise<void>][] = [
      ["402: the plan", async (o) => {
        await setOrgPlan(o.orgId, "community");
        await invalidateOrgEntitlements(o.orgId);
      }],
      ["409 connect_required: Connect", async (o) => {
        await sql`update organizations set stripe_charges_enabled = false where id = ${o.orgId}`;
      }],
    ];
    let checked = 0;
    for (const [label, cut] of cuts) {
      const o = await rigOrg();
      const { id, token } = await deal(o, "online");
      const before = await stored(id);
      await cut(o);
      clearStripe();
      const res = await pay(token);
      expectBackToInvoice(res, token);
      expect(stripeCalls(), label).toBe(0);
      expect(await stored(id), label).toEqual(before);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe.skipIf(!HAS_DB)("the pay handler: what the lock re-checks while Stripe mints (review I1, I2)", () => {
  /** An online deal whose stored session has under 10 minutes left, so the next pay retires it and MINTS. */
  async function minting(o: RigOrg) {
    const d = await deal(o, "online");
    await sql`update sponsor_orders set checkout_expires_at = now() + interval '5 minutes' where id = ${d.id}`;
    return d;
  }

  it("the club marks the deal paid, or ends it, while Stripe mints: refused (303 back), no session stored, the count unmoved (2 counted)", async () => {
    const races: [string, (o: RigOrg, id: string) => Promise<unknown>][] = [
      ["Mark as paid", (o, id) => markDealPaid(o.auth, id)],
      ["End now", (o, id) => endDealNow(o.auth, id)],
    ];
    let checked = 0;
    for (const [label, race] of races) {
      const o = await rigOrg();
      const { id, token } = await minting(o);
      const before = await stored(id);
      const create = idempotentCreate();
      let raced = 0;
      stripe.create.mockImplementation(async (params: unknown, opts: { idempotencyKey: string }) => {
        // The club's action lands while Stripe is minting this request's session (the stored one is already retired).
        if (raced++ === 0) await race(o, id);
        return create(params, opts);
      });
      const res = await pay(token);
      expect(raced, `${label}: premise, Stripe minted`).toBe(1);
      expectBackToInvoice(res, token);
      const after = await stored(id);
      expect(after.checkout_session_id, `${label}: no session stored on a deal that is no longer due`).toBeNull();
      expect(after.invoice_send_count, label).toBe(before.invoice_send_count);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a send that stored a DIFFERENT session while this pay minted: refused (303 back), and the send's session is the one kept", async () => {
    const o = await rigOrg();
    const { id, token } = await minting(o);
    const create = idempotentCreate();
    let calls = 0;
    stripe.create.mockImplementation(async (params: unknown, opts: { idempotencyKey: string }) => {
      if (calls++ === 0) {
        // Two sends land first: the first takes this pay's key (count + 1, the SAME session), then that session nears expiry
        // and the second send retires it and mints the next key. This pay's key now answers a retired session.
        await sendDealInvoice(o.auth, id, ORIGIN);
        await sql`update sponsor_orders set checkout_expires_at = now() + interval '5 minutes' where id = ${id}`;
        await sendDealInvoice(o.auth, id, ORIGIN);
      }
      return create(params, opts);
    });
    const before = await stored(id);
    stripe.create.mockClear(); // createDeal's own mint is not this race's
    const res = await pay(token);
    const after = await stored(id);
    expect(calls, "premise: the pay and the two sends each minted").toBe(3);
    expect(after.invoice_send_count, "premise: two sends counted").toBe(before.invoice_send_count + 2);
    expectBackToInvoice(res, token);
    const keys = stripe.create.mock.calls.map((c) => (c[1] as { idempotencyKey: string }).idempotencyKey);
    // The send's last session is stored, not the stale one this pay's key answered (the stand-in answers a key as Stripe does).
    expect(keys, "the pay's key, the first send's (the same), the second send's").toHaveLength(3);
    expect(keys[1], "premise: the first send took this pay's key").toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    const paysOwn = await create(null, { idempotencyKey: keys[0]! });
    const sendsLast = await create(null, { idempotencyKey: keys[2]! });
    expect(after.checkout_session_id, "the second send's session").toBe(sendsLast.id);
    expect(after.checkout_session_id, "never the retired one").not.toBe(paysOwn.id);
  });

  it("the COUNT half of the lock's compare: a send stored a session, then a retire and a FAILED mint left the deal with none - the count moved, so refused (303 back) and the pay's stale session is never stored (T22 re-review M2)", async () => {
    const o = await rigOrg();
    const { id, token } = await minting(o);
    const create = idempotentCreate();
    let calls = 0;
    stripe.create.mockImplementation(async (params: unknown, opts: { idempotencyKey: string }) => {
      const n = ++calls; // this call's own number: the nested sends move `calls` on while it waits
      if (n === 1) {
        // A send takes this pay's key (count + 1: the SAME session), stores it and counts itself. That session then nears expiry,
        // and the next send retires it (forgotten, committed) before its own mint fails.
        await sendDealInvoice(o.auth, id, ORIGIN);
        await sql`update sponsor_orders set checkout_expires_at = now() + interval '5 minutes' where id = ${id}`;
        await expect(sendDealInvoice(o.auth, id, ORIGIN)).rejects.toMatchObject({ status: 502 });
      }
      if (n === 3) throw new Error("stripe down");
      return create(params, opts);
    });
    const before = await stored(id);
    const res = await pay(token);
    const after = await stored(id);
    expect(calls, "premise: the pay, the first send and the failed send each reached create").toBe(3);
    expect(after.invoice_send_count, "premise: the first send counted, the failed one did not").toBe(before.invoice_send_count + 1);
    // Only the count tells this deal moved: it holds no session, exactly as when the pay read it.
    expect(after.checkout_session_id, "no session stored: never the pay's, which the retire already expired").toBeNull();
    expectBackToInvoice(res, token);
  });

  it("two clicks that mint at once: both are sent to the ONE session (one key), stored once, counted once", async () => {
    const o = await rigOrg();
    const { id, token, checkoutUrl } = await minting(o);
    const before = await stored(id);
    const create = idempotentCreate();
    // A barrier: neither create answers until both requests are inside Stripe, so both minted before either stored.
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    stripe.create.mockImplementation(async (params: unknown, opts: { idempotencyKey: string }) => {
      if (++arrived === 2) release();
      await Promise.race([both, new Promise((r) => setTimeout(r, 3_000))]);
      return create(params, opts);
    });
    stripe.create.mockClear(); // createDeal's own mint is not this race's
    const [a, b] = await Promise.all([pay(token), pay(token)]);
    expect(arrived, "premise: both requests minted").toBe(2);
    const keys = stripe.create.mock.calls.map((c) => (c[1] as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size, keys.join(", ")).toBe(1);
    for (const res of [a, b]) {
      expect(res.status).toBe(303);
      expectPrivate(res);
    }
    const url = a.headers.get("location");
    expect(url, "a Stripe link").toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(url, "a NEW link").not.toBe(checkoutUrl);
    expect(b.headers.get("location"), "the second click lands on the same session").toBe(url);
    const after = await stored(id);
    expect(after.checkout_url).toBe(url);
    expect(after.invoice_send_count, "one mint, one count").toBe(before.invoice_send_count + 1);
  });
});
