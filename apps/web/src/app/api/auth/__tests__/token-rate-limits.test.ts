// Bot hardening, 2026-09-25: the two token-consuming auth endpoints get the
// same per-IP AUTH_LIMIT bucket their siblings (login, signup, magic-link
// consume) already had. Without it a token could be guessed at wire speed.
//
// Driven through the REAL route handlers and the REAL limiter
// (`@/lib/rate-limit`); only Redis's INCR is an in-memory counter, as in
// app/api/v1/public/__tests__/poll-rate-limit.test.ts. The usecases behind
// each route are stubbed. Expected numbers come from AUTH_LIMIT itself.
import { beforeEach, describe, expect, it, vi } from "vitest";

const redis = vi.hoisted(() => ({ counters: new Map<string, number>(), windows: [] as number[], down: false }));
vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheEnabled: () => true,
  incrWindow: async (key: string, windowSeconds: number) => {
    if (redis.down) return null;
    redis.windows.push(windowSeconds);
    const next = (redis.counters.get(key) ?? 0) + 1;
    redis.counters.set(key, next);
    return { count: next, ttlMs: windowSeconds * 1000 };
  },
}));
const req = vi.hoisted(() => ({ ip: "203.0.113.1" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": `${req.ip}, 10.0.0.1` }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
const usecase = vi.hoisted(() => ({
  consumePasswordReset: vi.fn(async () => {}),
  consumeVerificationToken: vi.fn(async () => "u1"),
  createSession: vi.fn(async () => {}),
  postAuthLanding: vi.fn(async () => ({ hasOrg: false, orgId: null, redirect: "/onboarding" })),
  sql: vi.fn(async () => []),
}));
vi.mock("@/lib/password-reset", () => ({ consumePasswordReset: usecase.consumePasswordReset }));
vi.mock("@/lib/verification", () => ({ consumeVerificationToken: usecase.consumeVerificationToken }));
vi.mock("@/lib/auth", () => ({ createSession: usecase.createSession, postAuthLanding: usecase.postAuthLanding }));
vi.mock("@/lib/db", () => ({ sql: usecase.sql }));

import { AUTH_LIMIT } from "@/lib/rate-limit";
import { POST as resetPassword } from "../reset-password/route";
import { POST as verifyEmail } from "../verify-email/route";

const post = (body: unknown) =>
  new Request("http://x/api/auth/any", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const ROUTES = [
  {
    name: "POST /api/auth/reset-password",
    bucket: "reset-password",
    call: () => resetPassword(post({ token: "reset-token", password: "hunter22" })),
    work: usecase.consumePasswordReset,
  },
  {
    name: "POST /api/auth/verify-email",
    bucket: "verify-email",
    call: () => verifyEmail(post({ token: "verify-token-0123456789" })),
    work: usecase.consumeVerificationToken,
  },
] as const;

async function send(call: () => Promise<Response>, n: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await call()).status);
  return statuses;
}

beforeEach(() => {
  vi.clearAllMocks();
  redis.counters.clear();
  redis.windows = [];
  redis.down = false;
  req.ip = "203.0.113.1";
});

describe.each(ROUTES)("$name: AUTH_LIMIT per client IP", ({ bucket, call, work }) => {
  it(`serves AUTH_LIMIT.max from one IP, refuses the next with 429, and consumes no token once refused`, async () => {
    const statuses = await send(call, AUTH_LIMIT.max + 1);
    expect(statuses.slice(0, AUTH_LIMIT.max).filter((s) => s !== 200), "under the limit").toEqual([]);
    expect(statuses[AUTH_LIMIT.max], "one past the limit").toBe(429);
    const body = await (await call()).json();
    expect(body).toMatchObject({ ok: false, error: "Too many requests — slow down and try again." });
    expect(work).toHaveBeenCalledTimes(AUTH_LIMIT.max);
  });

  it("keys on the first x-forwarded-for hop with AUTH_LIMIT's window: another IP still gets through", async () => {
    await send(call, AUTH_LIMIT.max + 1);
    expect(redis.counters.get(`rl:${bucket}:203.0.113.1`)).toBe(AUTH_LIMIT.max + 1);
    expect(new Set(redis.windows)).toEqual(new Set([AUTH_LIMIT.windowSeconds]));
    req.ip = "198.51.100.2";
    expect((await call()).status).toBe(200);
  });

  it("fails closed: with Redis configured but unreachable, the request is refused", async () => {
    expect(AUTH_LIMIT.failClosed).toBe(true);
    redis.down = true;
    expect((await call()).status).toBe(429);
    expect(work).not.toHaveBeenCalled();
  });
});
