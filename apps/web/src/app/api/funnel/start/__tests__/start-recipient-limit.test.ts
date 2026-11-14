// POST /api/funnel/start, per RECIPIENT (T1 review m1, controller 2026-11-14): a start for an address replaces that address's live
// draft without any key, so anyone who knows an address could void its link and mail it again and again from rotating IPs. One inbox
// takes at most FUNNEL_RECIPIENT_LIMIT.max starts a day, however the address is spelled and whichever IP sends them; a refused start
// writes nothing and voids nothing. Fail-closed: a limiter outage refuses (the same 429 the IP limit answers, so the page's existing
// "too many tries" copy covers it).
//
// Driven through the REAL route and the REAL limiter (`rateLimit`), with the test seam's in-memory counter in place of Redis (without
// it the limiter is inert wherever Redis is unconfigured). Stand-ins: the outbox transport and `next/headers` (the caller's IP, which
// the test rotates). The limit's size is read from its declaration, never retyped.
// Sport: not applicable — the bucket is the address's; one payload throughout.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const caller = vi.hoisted(() => ({ ip: "203.0.113.90" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": caller.ip }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));

import { sql } from "@/lib/db";
import { FUNNEL_RECIPIENT_LIMIT, __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { POST as start } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `frl-${randomUUID().slice(0, 8)}`;
const ORIGIN = "https://funnel-limit.test";
const address = (): string => `${RUN}-${randomUUID().slice(0, 8)}@x.test`;

/** An in-memory fixed window: every key counts its own hits (the window never rolls inside a test). */
let counts = new Map<string, number>();
const memoryCounter = async (key: string) => {
  const count = (counts.get(key) ?? 0) + 1;
  counts.set(key, count);
  return { count, ttlMs: 60_000 };
};

let ipSeq = 0;
/** A start from a fresh IP each time: the per-IP limit never refuses here, so a refusal is the recipient's. */
async function startFrom(email: string): Promise<number> {
  caller.ip = `198.51.100.${++ipSeq % 250}`;
  const res = await start(
    new Request(`${ORIGIN}/api/funnel/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, name: `${RUN} Cup`, sport: "Badminton", entrants: 8 }),
    }),
  );
  return res.status;
}
const draftsOf = (email: string) =>
  sql<{ id: string; live: boolean }[]>`
    select id, (used_at is null and replaced_at is null) as live from funnel_drafts where lower(email) = lower(${email})
     order by created_at, id`;
const claimEmailsOf = async (email: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where kind = 'funnel_claim' and lower(recipient) = lower(${email})`)[0]!.n;

beforeEach(() => {
  counts = new Map();
  __setRateLimitCounterForTests(memoryCounter);
  transport.deliver.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_${RUN}_${randomUUID()}` }));
  stubOutboxEnv();
});
afterEach(() => {
  __setRateLimitCounterForTests(null);
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where kind = 'funnel_claim' and lower(recipient) like ${`${RUN}-%`}`;
  await sql`delete from funnel_drafts where lower(email) like ${`${RUN}-%`}`;
});

describe.skipIf(!HAS_DB)("POST /api/funnel/start: one inbox, a few starts a day (DB)", () => {
  it("premise: the limit is fail-closed, a day long, and lets a visitor resubmit more than once", () => {
    expect(FUNNEL_RECIPIENT_LIMIT.failClosed).toBe(true);
    expect(FUNNEL_RECIPIENT_LIMIT.windowSeconds).toBe(24 * 3600);
    expect(FUNNEL_RECIPIENT_LIMIT.max).toBeGreaterThanOrEqual(3);
  });

  it("the address's next start past the limit is a 429 — any spelling, any IP — and writes, mails and voids nothing", async () => {
    const email = address();
    const spellings = [email, email.toUpperCase(), email[0]!.toUpperCase() + email.slice(1)];
    const max = FUNNEL_RECIPIENT_LIMIT.max;
    const statuses: number[] = [];
    for (let i = 0; i < max; i++) statuses.push(await startFrom(spellings[i % 3]!));
    expect(statuses, "every start up to the limit is taken").toEqual(Array(max).fill(200));
    const before = await draftsOf(email);
    expect(before.length, "anti-vacuity: one draft per start").toBe(max);
    const liveBefore = before.filter((d) => d.live).map((d) => d.id);
    expect(liveBefore, "premise: one live draft").toHaveLength(1);

    expect(await startFrom(spellings[max % 3]!), "the next is refused").toBe(429);
    const after = await draftsOf(email);
    expect(after.length, "no draft written").toBe(max);
    expect(after.filter((d) => d.live).map((d) => d.id), "the live draft is still live: nothing voided").toEqual(liveBefore);
    expect(await claimEmailsOf(email), "no email queued").toBe(max);

    // Another inbox, from the same run of IPs, has its own bucket.
    expect(await startFrom(address())).toBe(200);
  });

  it("empty: the first start for an address is taken; a limiter outage refuses it (fail-closed) and writes nothing", async () => {
    expect(await startFrom(address()), "a first start").toBe(200);
    // Redis configured but unreachable: the counter answers nothing for the recipient's bucket. The per-IP bucket (keyed on the IP
    // the test sets) still counts, so only the recipient's outage can refuse.
    vi.stubEnv("REDIS_URL", "redis://outage.invalid:6379");
    __setRateLimitCounterForTests(async (key) => (key.includes(caller.ip) ? memoryCounter(key) : null));
    const email = address();
    expect(await startFrom(email), "an outage refuses").toBe(429);
    expect(await draftsOf(email), "no draft").toEqual([]);
    expect(await claimEmailsOf(email), "no email").toBe(0);
  });
});
