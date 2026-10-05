// Bot hardening, 2026-09-25: two public registration POSTs get a per-IP bucket
// of their own ON TOP of the 60/min public budget (`publicRateLimit`), because
// each call has a side effect the read budget was never sized for:
//   - checkout mints a Stripe Checkout Session  → CHECKOUT_LIMIT
//   - groups/{id}/resend sends an email          → EMAIL_LIMIT (fail-closed)
//
// Driven through the REAL route handlers and the REAL limiter; only Redis's
// INCR is an in-memory counter and the usecases are stubbed, as in
// ../../__tests__/poll-rate-limit.test.ts (which still pins the 60 bucket for
// both routes). Expected numbers come from the presets themselves.
import { beforeEach, describe, expect, it, vi } from "vitest";

const redis = vi.hoisted(() => ({ counters: new Map<string, number>(), windows: new Map<string, number>(), down: false }));
vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheEnabled: () => true,
  incrWindow: async (key: string, windowSeconds: number) => {
    if (redis.down) return null;
    redis.windows.set(key, windowSeconds);
    const next = (redis.counters.get(key) ?? 0) + 1;
    redis.counters.set(key, next);
    return { count: next, ttlMs: windowSeconds * 1000 };
  },
}));
const usecase = vi.hoisted(() => ({
  resumeRegistrationCheckout: vi.fn(async () => ({ url: "https://checkout.example" })),
  resendRegistrationConfirmationPublic: vi.fn(async () => ({ sent: true })),
}));
vi.mock("@/server/usecases/registrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/registrations")>()),
  resumeRegistrationCheckout: usecase.resumeRegistrationCheckout,
  resendRegistrationConfirmationPublic: usecase.resendRegistrationConfirmationPublic,
}));

import { CHECKOUT_LIMIT, EMAIL_LIMIT } from "@/lib/rate-limit";
import { POST as checkout } from "../[id]/checkout/route";
import { POST as resend } from "../groups/[id]/resend/route";

const REG = "00000000-0000-4000-8000-000000000001";
const TOKEN = "registrant-token-0123456789";
const posted = (headers: Record<string, string>) =>
  new Request("http://x/api/v1/public/any", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ token: TOKEN }),
  });
const ctx = { params: Promise.resolve({ id: REG }) };
/** The public read budget both routes also spend (server/usecases/public.ts). */
const PUBLIC_MAX = 60;

const ROUTES = [
  {
    name: "POST /public/registrations/{id}/checkout",
    bucket: "regcheckout",
    limit: CHECKOUT_LIMIT,
    handler: checkout,
    work: usecase.resumeRegistrationCheckout,
  },
  {
    name: "POST /public/registrations/groups/{id}/resend",
    bucket: "regresend",
    limit: EMAIL_LIMIT,
    handler: resend,
    work: usecase.resendRegistrationConfirmationPublic,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  redis.counters.clear();
  redis.windows.clear();
  redis.down = false;
});

describe.each(ROUTES)("$name: its own per-IP bucket", ({ bucket, limit, handler, work }) => {
  const IP = "203.0.113.30";
  const call = (ip = IP) => handler(posted({ "x-forwarded-for": `${ip}, 10.0.0.1` }), ctx);

  it("premise: the route's bucket is tighter than the 60/min public budget, so its refusal is its own", () => {
    expect(limit.max).toBeLessThan(PUBLIC_MAX);
  });

  it("serves the preset's max from one IP, refuses the next with 429 RATE_LIMITED, and does no work once refused", async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= limit.max; i++) statuses.push((await call()).status);
    expect(statuses.slice(0, limit.max).filter((s) => s !== 200), "under the limit").toEqual([]);
    expect(statuses[limit.max], "one past the limit").toBe(429);
    const refused = await call();
    expect(await refused.json()).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    expect(work).toHaveBeenCalledTimes(limit.max);
  });

  it("keys on the first x-forwarded-for hop with the preset's window, alongside the public bucket; another IP still gets through", async () => {
    for (let i = 0; i <= limit.max; i++) await call();
    expect(redis.counters.get(`rl:${bucket}:${IP}`)).toBe(limit.max + 1);
    expect(redis.windows.get(`rl:${bucket}:${IP}`)).toBe(limit.windowSeconds);
    expect(redis.counters.get(`rl:pubv1:${IP}`), "the 60 bucket is still spent").toBe(limit.max + 1);
    expect((await call("198.51.100.30")).status).toBe(200);
  });

  it("falls back to x-real-ip when there is no x-forwarded-for", async () => {
    await handler(posted({ "x-real-ip": "198.51.100.31" }), ctx);
    expect(redis.counters.get(`rl:${bucket}:198.51.100.31`)).toBe(1);
  });

  it(`with Redis configured but unreachable: ${limit.failClosed ? "fails closed" : "fails open"}, as the preset declares`, async () => {
    redis.down = true;
    expect((await call()).status).toBe(limit.failClosed ? 429 : 200);
    expect(work).toHaveBeenCalledTimes(limit.failClosed ? 0 : 1);
  });
});
