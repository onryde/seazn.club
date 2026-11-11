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
//   - a paid invoice is refused with 409 and nothing at Stripe is touched; so is an offline one; an unknown token is the 404.
// Killer for "payable ignores the paid state": the paid case (it would 303, or reach Stripe).
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
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { getDictionary, t } from "@/lib/i18n";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { handleSponsorPaymentSucceeded } from "@/server/usecases/sponsors";
import { createDeal } from "@/server/usecases/sponsor-deals";
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
  expect(mine, "premise: createDeal minted one token").toHaveLength(1);
  return { id: out.deal.id, token: mine[0]!.token, checkoutUrl: out.checkout_url };
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

  it("a PAID invoice is refused with 409, in the reader's language, and nothing at Stripe is touched", async () => {
    const o = await rigOrg();
    const { id, token } = await deal(o, "online");
    // The payment webhook, as invoice-doc.test.ts drives it (a PaymentIntent with the deal in its metadata).
    await handleSponsorPaymentSucceeded({ id: `pi_invoice_${uniq()}`, metadata: { kind: "sponsor", order_id: id, org_id: o.orgId } } as never);
    const [{ status }] = await sql<{ status: string }[]>`select status from sponsor_orders where id = ${id}`;
    expect(status, "premise: the webhook paid it").toBe("paid");
    stripe.create.mockClear();
    stripe.retrieve.mockClear();
    stripe.expire.mockClear();
    ctx.locale = "fr";
    const res = await pay(token);
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(t(fr, "sponsors.invoice.payRefused"));
    expectPrivate(res);
    expect(stripeCalls()).toBe(0);
    // The positive pair: the invoice itself still opens (a paid invoice is a receipt).
    expect((await pdf(token)).status).toBe(200);
  });

  it("an OFFLINE invoice is refused with 409 too, and no session is minted for it", async () => {
    const o = await rigOrg();
    const { id, token } = await deal(o, "offline");
    const res = await pay(token);
    expect(res.status).toBe(409);
    expect(stripeCalls()).toBe(0);
    const [row] = await sql<{ checkout_session_id: string | null }[]>`select checkout_session_id from sponsor_orders where id = ${id}`;
    expect(row!.checkout_session_id).toBeNull();
  });
});
