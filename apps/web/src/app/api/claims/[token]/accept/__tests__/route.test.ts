// POST /api/claims/[token]/accept, through its REAL handler and the REAL usecase over a real
// database; only the cookie door is faked one layer down (`getCurrentUser` / `createSession`),
// the device-links route test's pattern. person-claims-email-signin.test.ts proves the usecase;
// this file proves the ROUTE carries it:
//   - signed OUT with the EMAIL secret → a session is minted for the invited address's account
//     and the answer is the redirect to /me?claimed=1;
//   - signed OUT with the CONSOLE secret → 401, no session, nothing created (what it always did);
//   - a double tap mints ONE session;
//   - SIGNED IN is unchanged for both secrets (strict email match, no new session);
//   - the new session-minting branch is rate limited, the signed-in branch is not.
// Skipped without DATABASE_URL (CI unit shards have none; nothing here touches `sql` at module level).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const auth = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; display_name: string },
  sessions: [] as string[],
  ip: "203.0.113.7",
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getCurrentUser: async () => auth.user,
    createSession: async (userId: string) => {
      auth.sessions.push(userId);
    },
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers({ "x-forwarded-for": `${auth.ip}, 10.0.0.1` }),
}));

import { sql } from "@/lib/db";
import { AUTH_LIMIT, __setRateLimitCounterForTests } from "@/lib/rate-limit";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createClaimInvite, revokeClaimInvite } from "@/server/usecases/person-claims";
import { createPerson } from "@/server/usecases/persons";
import { POST } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

interface Envelope {
  ok: boolean;
  data?: { person_id: string; person_name: string; org_name: string; signed_in: boolean; redirect: string };
  error?: string;
  code?: string;
}

async function post(token: string): Promise<{ status: number; body: Envelope }> {
  const res = await POST(new Request(`http://localhost/api/claims/${token}/accept`, { method: "POST" }), {
    params: Promise.resolve({ token }),
  });
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function rig() {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`owner-${suffix}@test.local`}, 'owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Accept Org " + suffix}, ${"accept-org-" + suffix}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  const owner: AuthCtx = { orgId, via: "session", userId: ownerId, role: "owner", keyId: null };
  const person = await createPerson(owner, { full_name: "Route Player", consent: {} } as never);
  const email = `route-${suffix}@test.local`;
  const invite = await createClaimInvite(owner, person.id, email);
  return { owner, person, email, invite };
}

const usersWithEmail = async (email: string) =>
  sql<{ id: string; email_verified: boolean; terms_accepted_at: string | null }[]>`
    select id, email_verified, terms_accepted_at from users where lower(email) = lower(${email}) and deleted_at is null`;
const personUser = async (id: string) =>
  (await sql<{ user_id: string | null }[]>`select user_id from persons where id = ${id}`)[0]!.user_id;

beforeEach(() => {
  auth.user = null;
  auth.sessions = [];
  auth.ip = "203.0.113.7";
  __setRateLimitCounterForTests(null);
});
afterEach(() => {
  __setRateLimitCounterForTests(null);
});
afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("signed OUT: the emailed secret signs in", () => {
  it("mints a session for the invited address, links the profile, answers with the redirect to /me?claimed=1", async () => {
    const { person, email, invite } = await rig();

    const { status, body } = await post(invite.emailSecret);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      data: { person_id: person.id, person_name: "Route Player", signed_in: true, redirect: "/me?claimed=1" },
    });
    const users = await usersWithEmail(email);
    expect(users).toHaveLength(1);
    expect(auth.sessions).toEqual([users[0]!.id]); // exactly one session, for THAT account
    expect(users[0]!.email_verified).toBe(true);
    // The button sits under the clickwrap notice, so acceptance is recorded (GDPR spec 2026-07-14).
    expect(users[0]!.terms_accepted_at).not.toBeNull();
    expect(await personUser(person.id)).toBe(users[0]!.id);
  });

  it("the CONSOLE secret without a session is 401 'Not authenticated': no session, no account, claim still open", async () => {
    const { person, email, invite } = await rig();

    const { status, body } = await post(invite.secret);

    expect(status).toBe(401);
    expect(body).toMatchObject({ ok: false, error: "Not authenticated" });
    expect(auth.sessions).toEqual([]);
    expect(await usersWithEmail(email)).toHaveLength(0);
    expect(await personUser(person.id)).toBeNull();
    // Positive pair: the same claim's EMAIL secret does sign in.
    expect((await post(invite.emailSecret)).status).toBe(200);
    expect(auth.sessions).toHaveLength(1);
  });

  it("a dead emailed link answers with its own code and mints no session", async () => {
    const expired = await rig();
    await sql`update person_claims set expires_at = now() - interval '1 minute' where id = ${expired.invite.id}`;
    const revoked = await rig();
    await revokeClaimInvite(revoked.owner, revoked.person.id);
    const claimed = await rig();
    await post(claimed.invite.emailSecret);
    auth.sessions = [];

    const answers = [
      { r: await post(expired.invite.emailSecret), status: 401, code: "CLAIM_EXPIRED" },
      { r: await post(revoked.invite.emailSecret), status: 401, code: "CLAIM_REVOKED" },
      { r: await post(claimed.invite.emailSecret), status: 409, code: "CLAIM_CLAIMED" },
      { r: await post("pc_not-a-real-link"), status: 401, code: undefined },
    ];
    for (const a of answers) {
      expect(a.r.status).toBe(a.status);
      expect(a.r.body.code).toBe(a.code);
    }
    expect(auth.sessions).toEqual([]);
    expect(answers).toHaveLength(4);
  });

  it("a double tap: one 200 with ONE session, the other 409 CLAIM_CLAIMED", async () => {
    const { email, invite } = await rig();

    const taps = await Promise.all([post(invite.emailSecret), post(invite.emailSecret)]);

    expect(taps.map((t) => t.status).sort()).toEqual([200, 409]);
    expect(taps.find((t) => t.status === 409)!.body).toMatchObject({ ok: false });
    expect(auth.sessions).toHaveLength(1);
    expect(await usersWithEmail(email)).toHaveLength(1);
  });

  it("is rate limited per IP on AUTH_LIMIT, and a refused request consumes nothing", async () => {
    const counters = new Map<string, number>();
    __setRateLimitCounterForTests(async (key, windowSeconds) => {
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      return { count: n, ttlMs: windowSeconds * 1000 };
    });
    // AUTH_LIMIT.max garbage taps use the bucket up (each is a refused attempt, not a claim)...
    for (let i = 0; i < AUTH_LIMIT.max; i++) expect((await post("pc_garbage")).status).toBe(401);
    const { person, invite } = await rig();
    // ...so the real link is turned away with 429 before any work is done.
    const limited = await post(invite.emailSecret);
    expect(limited.status).toBe(429);
    expect(auth.sessions).toEqual([]);
    expect(await personUser(person.id)).toBeNull();
    // Another address still gets through.
    auth.ip = "198.51.100.9";
    expect((await post(invite.emailSecret)).status).toBe(200);
  });
});

describe.skipIf(!HAS_DB)("signed IN: unchanged for both secrets", () => {
  it.each(["secret", "emailSecret"] as const)(
    "the invited account taps %s: linked, the answer says it was not a sign-in, no new session, not rate limited",
    async (kind) => {
      const { person, email, invite } = await rig();
      const [u] = await sql<{ id: string }[]>`
        insert into users (email, display_name, email_verified) values (${email}, 'Me', true) returning id`;
      auth.user = { id: u!.id, email, display_name: "Me" };
      // A counter that refuses everything: the signed-in branch must never consult it.
      __setRateLimitCounterForTests(async (_k, w) => ({ count: 9999, ttlMs: w * 1000 }));

      const { status, body } = await post(invite[kind]);

      expect(status).toBe(200);
      expect(body.data).toMatchObject({ person_id: person.id, signed_in: false, redirect: "/me?claimed=1" });
      expect(auth.sessions).toEqual([]);
      expect(await personUser(person.id)).toBe(u!.id);
    },
  );

  it.each(["secret", "emailSecret"] as const)("a DIFFERENT account taps %s: 403 CLAIM_EMAIL_MISMATCH, nothing linked", async (kind) => {
    const { person, invite } = await rig();
    const email = `other-${randomUUID().slice(0, 8)}@test.local`;
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${email}, 'Other', true) returning id`;
    auth.user = { id: u!.id, email, display_name: "Other" };

    const { status, body } = await post(invite[kind]);

    expect(status).toBe(403);
    expect(body).toMatchObject({ ok: false, code: "CLAIM_EMAIL_MISMATCH" });
    expect(auth.sessions).toEqual([]);
    expect(await personUser(person.id)).toBeNull();
  });
});
