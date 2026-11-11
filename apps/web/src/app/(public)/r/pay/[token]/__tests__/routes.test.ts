// Player payment page, Task 4 (plan 2026-11-11-player-payment-page) - the Pay route, POST /r/pay/[token]/pay, against the real
// database and the real `payFromPayPage`. Stand-ins: Stripe (a small in-memory session store: create / retrieve / expire) and the
// request context Next would supply (locale, headers). Tokens come from the REAL producer (`issuePayLink` + `recordPayToken` with the
// entry's own org), never a hand-inserted hash.
//
// What the route must do (brief, Step 1; Review Focus 5):
//   - `publicRateLimit` FIRST: a throttled press answers 429 and spends no database statement and no Stripe call;
//   - unknown token → 404 text and zero `create`; the entry's state decides the rest (paid → 409, no mint);
//   - a payable entry → 303 to the Checkout URL, `Referrer-Policy: no-referrer` (a redirect's own policy is what Stripe's Referer
//     follows), private, noindex;
//   - Stripe says the card payment is complete and the webhook has not landed → 303 to `?notice=recording`;
//   - Connect off → 503 in the ENTRY's language (the document's), not the reader's; never a 500 for an HttpError.
// Real Postgres required; skipped without DATABASE_URL (as every sibling usecase suite).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

const ctx = vi.hoisted(() => ({ locale: "en" as "en" | "es" | "fr" | "nl" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => ctx.locale }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));

interface FakeSession {
  id: string;
  object: "checkout.session";
  status: "open" | "complete" | "expired";
  payment_status: "unpaid" | "paid";
  payment_intent: string | null;
  url: string | null;
  expires_at: number;
  metadata: Record<string, string>;
}
const stripeMock = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  create: vi.fn(),
  retrieve: vi.fn(),
  expire: vi.fn(),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: stripeMock.create, retrieve: stripeMock.retrieve, expire: stripeMock.expire } } }),
}));

import { sql, statementCount } from "@/lib/db";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { getDictionary, t } from "@/lib/i18n";
import { REG_PAY_PRIVATE_HEADERS, registrationPayPath, registrationPayRecordingPath } from "@/lib/registration-pay";
import { issuePayLink, putRegistrationSettings, recordPayToken } from "@/server/usecases/registrations";
import { SETTINGS_BASE, seedRegistration, stripeRig, type StripeRigResult } from "@/server/usecases/__tests__/_registration-fixtures";
import { POST } from "../pay/route";

const HAS_DB = !!process.env.DATABASE_URL;
const ORIGIN = "https://pay.test";
const en = await getDictionary("en", "ui");
const fr = await getDictionary("fr", "ui");
const nl = await getDictionary("nl", "ui");

let overLimit = false;
beforeEach(() => {
  overLimit = false;
  ctx.locale = "en";
  stripeMock.store.clear();
  let n = 0;
  __setRateLimitCounterForTests(async () => ({ count: overLimit ? 61 : ++n, ttlMs: 30_000 }));
  stripeMock.create.mockReset().mockImplementation(async (params: Stripe.Checkout.SessionCreateParams) => {
    const id = `cs_test_pp4_${++n}_${randomUUID().slice(0, 6)}`;
    const s: FakeSession = {
      id,
      object: "checkout.session",
      status: "open",
      payment_status: "unpaid",
      payment_intent: null,
      url: `https://checkout.stripe.test/${id}`,
      expires_at: Math.floor(Date.now() / 1000) + 24 * 3600,
      metadata: { ...(params.metadata as Record<string, string>) },
    };
    stripeMock.store.set(id, s);
    return { ...s };
  });
  stripeMock.retrieve.mockReset().mockImplementation(async (id: string) => {
    const s = stripeMock.store.get(id);
    if (!s) throw new Error(`No such checkout.session: ${id}`);
    return { ...(s as object) };
  });
  stripeMock.expire.mockReset().mockImplementation(async (id: string) => {
    const s = stripeMock.store.get(id) as FakeSession;
    s.status = "expired";
    return { ...s };
  });
});
afterEach(() => {
  __setRateLimitCounterForTests(null);
});

const ip = () => `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
const press = (token: string) =>
  POST(new Request(`${ORIGIN}${registrationPayPath(token)}/pay`, { method: "POST", headers: { "x-forwarded-for": ip() } }), {
    params: Promise.resolve({ token }),
  });
const stripeCalls = () => stripeMock.create.mock.calls.length + stripeMock.retrieve.mock.calls.length + stripeMock.expire.mock.calls.length;

function expectPrivate(res: Response): void {
  expect(res.headers.get("cache-control")).toBe(REG_PAY_PRIVATE_HEADERS["Cache-Control"]);
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
}

async function entry(over: Parameters<typeof seedRegistration>[3] = {}, rig?: StripeRigResult) {
  const r = rig ?? (await stripeRig({ feeCents: 1500 }));
  const reg = (await seedRegistration(r.competition.id, r.division.id, r.settings, over)).registration;
  const { url, tokenHash } = issuePayLink(ORIGIN);
  await recordPayToken(sql, { tokenHash, registrationId: reg.id, orgId: reg.org_id });
  return { rig: r, reg, token: new URL(url).pathname.split("/").pop()! };
}

describe.skipIf(!HAS_DB)("POST /r/pay/[token]/pay", () => {
  it("over the public budget: 429 in the reader's language, and no statement and no Stripe call are spent (zero DB reads)", async () => {
    overLimit = true;
    ctx.locale = "fr";
    const { token } = await entry(); // seeded BEFORE the measured window: the press itself must read nothing
    const before = statementCount();
    const res = await press(token);
    expect(statementCount() - before).toBe(0);
    expect(res.status).toBe(429);
    expect(await res.text()).toBe(t(fr, "regPay.throttled.body"));
    expectPrivate(res);
    expect(stripeCalls()).toBe(0);
  });

  it("unknown token → 404 text in the reader's language, zero create (empty case first)", async () => {
    ctx.locale = "fr";
    const res = await press("x".repeat(43));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(t(fr, "regPay.notFound.body"));
    expectPrivate(res);
    expect(stripeMock.create).not.toHaveBeenCalled();
    expect((await press("")).status).toBe(404);
  });

  it("a payable entry → 303 to the Checkout URL, no-referrer, private; one create for this entry", async () => {
    const { reg, token } = await entry();
    const res = await press(token);
    expect(res.status).toBe(303);
    const [row] = await sql<{ pay_session_id: string }[]>`select pay_session_id from registrations where id = ${reg.id}`;
    const session = stripeMock.store.get(row!.pay_session_id) as FakeSession;
    expect(res.headers.get("location")).toBe(session.url);
    expectPrivate(res);
    expect(stripeMock.create).toHaveBeenCalledTimes(1);
    // A second press, session still fresh: handed out again, no second create.
    const again = await press(token);
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe(session.url);
    expect(stripeMock.create).toHaveBeenCalledTimes(1);
  });

  it("a paid entry → 409 in the entry's language, nothing minted", async () => {
    const { token } = await entry({ status: "confirmed", locale: "nl" });
    const res = await press(token);
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(t(nl, "regPay.refused.notPayable"));
    expectPrivate(res);
    expect(stripeMock.create).not.toHaveBeenCalled();
  });

  it("Stripe says the card payment is complete (webhook not landed) → 303 to the page with ?notice=recording", async () => {
    const { token } = await entry();
    await press(token);
    const [only] = [...stripeMock.store.values()] as FakeSession[];
    only!.status = "complete";
    only!.payment_status = "paid";
    const res = await press(token);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(registrationPayRecordingPath(token));
    expectPrivate(res);
    expect(stripeMock.create).toHaveBeenCalledTimes(1);
  });

  it("Connect off (Review Focus 5) → 503 in the ENTRY's language, not the reader's, and nothing minted", async () => {
    ctx.locale = "en"; // the reader
    const { rig, token } = await entry({ locale: "nl" }); // the entry
    await sql`update organizations set stripe_charges_enabled = false where id = ${rig.orgId}`;
    const res = await press(token);
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toBe(t(nl, "regPay.refused.unavailable"));
    expect(body).not.toBe(t(en, "regPay.refused.unavailable"));
    expectPrivate(res);
    expect(stripeMock.create).not.toHaveBeenCalled();
  });

  it("Stripe cannot read the stored session → 502 short text (never a 500), nothing new minted", async () => {
    const { token } = await entry();
    await press(token);
    stripeMock.retrieve.mockReset().mockRejectedValue(new Error("stripe is down"));
    const res = await press(token);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(t(en, "regPay.refused.failed"));
    expectPrivate(res);
    expect(stripeMock.create).toHaveBeenCalledTimes(1);
  });

  it("an offline entry → 409 and nothing minted (a stale tab's Pay press after the organiser switched the method)", async () => {
    const { rig, token } = await entry();
    await putRegistrationSettings(rig.owner, rig.division.id, { ...SETTINGS_BASE, payment_method: "offline", fee_cents: 1500 });
    const res = await press(token);
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(t(en, "regPay.refused.notPayable"));
    expect(stripeMock.create).not.toHaveBeenCalled();
  });
});
