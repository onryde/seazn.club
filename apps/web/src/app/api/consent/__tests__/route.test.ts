// Bot hardening, 2026-09-25: POST /api/consent writes a row per call and
// takes no auth, so it gets a per-IP CONSENT_LIMIT bucket. Fail-OPEN, unlike
// the auth buckets: the banner calls it best-effort, and a Redis blip must not
// refuse a person's consent choice.
//
// Driven through the REAL route handler and the REAL limiter; only Redis's
// INCR is an in-memory counter (same harness as
// app/api/v1/public/__tests__/poll-rate-limit.test.ts). Expected numbers come
// from CONSENT_LIMIT itself.
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
const db = vi.hoisted(() => ({ sql: vi.fn(async () => []) }));
vi.mock("@/lib/db", () => ({ sql: db.sql }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => null }));

import { AUTH_LIMIT, CONSENT_LIMIT } from "@/lib/rate-limit";
import { POST } from "../route";

const from = (headers: Record<string, string>) =>
  new Request("http://x/api/consent", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ choice: "accepted" }),
  });
const IP = "203.0.113.20";

async function send(req: () => Request, n: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await POST(req())).status);
  return statuses;
}

beforeEach(() => {
  vi.clearAllMocks();
  redis.counters.clear();
  redis.windows = [];
  redis.down = false;
});

describe("POST /api/consent: CONSENT_LIMIT per client IP", () => {
  it("premise: the budget differs from AUTH_LIMIT's, so a mis-wired preset cannot pass", () => {
    expect(CONSENT_LIMIT.max).not.toBe(AUTH_LIMIT.max);
  });

  it("records CONSENT_LIMIT.max from one IP, refuses the next with 429, and writes no row once refused", async () => {
    const statuses = await send(() => from({ "x-forwarded-for": `${IP}, 10.0.0.1` }), CONSENT_LIMIT.max + 1);
    expect(statuses.slice(0, CONSENT_LIMIT.max).filter((s) => s !== 200), "under the limit").toEqual([]);
    expect(statuses[CONSENT_LIMIT.max], "one past the limit").toBe(429);
    expect(db.sql).toHaveBeenCalledTimes(CONSENT_LIMIT.max);
  });

  it("keys on the client IP with CONSENT_LIMIT's window: another IP still gets through", async () => {
    await send(() => from({ "x-forwarded-for": IP }), CONSENT_LIMIT.max + 1);
    expect(redis.counters.get(`rl:consent:${IP}`)).toBe(CONSENT_LIMIT.max + 1);
    expect(new Set(redis.windows)).toEqual(new Set([CONSENT_LIMIT.windowSeconds]));
    expect((await POST(from({ "x-forwarded-for": "198.51.100.20" }))).status).toBe(200);
  });

  // Task 25d m1 (Phase 3 review m7): the LIMITER keys an IPv6 client by its /64; the consent RECORD is GDPR proof of who chose
  // and from where, so it keeps the address the client came from. A "finish the job" edit that passed the /64 to the insert would
  // store a network, not an address (and Postgres `inet` would take it). Addresses and the /64 are written by hand (RFC 4291).
  it("Task 25d m1: two IPv6 visitors in ONE /64 spend ONE consent bucket, and each recorded row keeps its OWN full address, never the /64", async () => {
    const A = "2001:db8:1::7";
    const B = "2001:db8:1:0:aaaa:bbbb:cccc:dddd";
    expect((await POST(from({ "x-forwarded-for": `${A}, 10.0.0.1` }))).status).toBe(200);
    expect((await POST(from({ "x-forwarded-for": B }))).status).toBe(200);
    expect([...redis.counters], "one bucket, the /64's").toEqual([["rl:consent:2001:db8:1:0::/64", 2]]);
    const inserts = (db.sql.mock.calls as unknown as [TemplateStringsArray, ...unknown[]][])
      .filter(([strings]) => strings.join("?").includes("insert into cookie_consents"));
    expect(inserts, "PREMISE: both choices were recorded").toHaveLength(2);
    const ipOf = ([strings, ...values]: [TemplateStringsArray, ...unknown[]]) => {
      // the value bound to the `ip_address` column: the insert's last placeholder (its column list ends with ip_address)
      expect(strings.join("?")).toMatch(/ip_address\)\s*values \(\?, \?, \?, \?, \?\)/);
      return values.at(-1);
    };
    expect(inserts.map(ipOf)).toEqual([A, B]);
  });

  it("fails open: with Redis configured but unreachable, the choice is still recorded", async () => {
    expect(CONSENT_LIMIT.failClosed).toBeFalsy();
    redis.down = true;
    expect((await POST(from({ "x-forwarded-for": IP }))).status).toBe(200);
    expect(db.sql).toHaveBeenCalledTimes(1);
  });
});
