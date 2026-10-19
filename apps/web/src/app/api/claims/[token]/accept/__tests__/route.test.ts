// POST /api/claims/[token]/accept, through its REAL handler and the REAL usecase over a real
// database; only the cookie door is faked one layer down (`getCurrentUser` / `createSession`),
// the device-links route test's pattern. person-claims-email-signin.test.ts proves the usecase;
// this file proves the ROUTE carries it:
//   - signed OUT with the EMAIL secret → a session is minted for the invited address's account
//     and the answer is the redirect to /me?claimed=1;
//   - signed OUT with the CONSOLE secret → 401, no session, nothing created (what it always did);
//   - a double tap mints ONE session;
//   - SIGNED IN is unchanged for both secrets (strict email match, no new session);
//   - the new session-minting branch is rate limited, the signed-in branch is not;
//   - the session-minting branch also refuses a request that cannot show it came from our own page
//     (no Sec-Fetch-Site: same-origin and no Origin) — the signed-in branch, which mints nothing, is not asked;
//   - the terms stamp rides the SAME transaction as the claim: a stamp that fails leaves nothing consumed,
//     no account, and no session (PR #991 review).
// Skipped without DATABASE_URL (CI unit shards have none; nothing here touches `sql` at module level).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const auth = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; display_name: string },
  sessions: [] as string[],
  ip: "203.0.113.7",
  failTermsStamp: false,
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
vi.mock("@/lib/legal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/legal")>();
  return {
    ...actual,
    // The real stamp, unless a test arms the failure — whichever db handle the caller passes is honoured.
    stampTermsAcceptance: async (...args: Parameters<typeof actual.stampTermsAcceptance>) => {
      if (auth.failTermsStamp) throw new Error("terms stamp failed");
      return actual.stampTermsAcceptance(...args);
    },
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers({ "x-forwarded-for": `${auth.ip}, 10.0.0.1` }),
}));

import { CLAIM_EMAIL_SIGNIN_MS } from "@/lib/claim-signin-window";
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

/** What a browser sends from our own page: every modern one sets Sec-Fetch-Site on a same-origin fetch. */
const OUR_PAGE = { "sec-fetch-site": "same-origin" };

async function post(
  token: string,
  headers: Record<string, string> = OUR_PAGE,
): Promise<{ status: number; body: Envelope }> {
  const res = await POST(new Request(`http://localhost/api/claims/${token}/accept`, { method: "POST", headers }), {
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
  auth.failTermsStamp = false;
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
    expect(body.code).toBeUndefined(); // only a past-window EMAILED link carries CLAIM_SIGNIN_EXPIRED
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

describe.skipIf(!HAS_DB)("signed OUT: only a request from our own page may start a session", () => {
  // `proxy.ts` already refuses a FOREIGN Origin on every mutating /api call. What it lets through is a request
  // with NO Origin at all, and this route now mints a session — so the route itself asks for proof.
  const REFUSED: [string, Record<string, string>][] = [
    ["neither Origin nor Sec-Fetch-Site", {}],
    ["Sec-Fetch-Site: cross-site", { "sec-fetch-site": "cross-site" }],
    ["Sec-Fetch-Site: same-site (a sibling subdomain)", { "sec-fetch-site": "same-site" }],
    ["Sec-Fetch-Site: none (typed into the address bar)", { "sec-fetch-site": "none" }],
    ["Origin present but Sec-Fetch-Site says cross-site", { origin: "http://localhost", "sec-fetch-site": "cross-site" }],
  ];
  const ALLOWED: [string, Record<string, string>][] = [
    ["Sec-Fetch-Site: same-origin", { "sec-fetch-site": "same-origin" }],
    ["an Origin header (older browsers; proxy.ts has already matched its host)", { origin: "http://localhost" }],
  ];

  it.each(REFUSED)("refuses %s: 403, no session, nothing consumed, no account", async (_name, headers) => {
    const { person, email, invite } = await rig();

    const { status, body } = await post(invite.emailSecret, headers);

    expect(status).toBe(403);
    expect(body).toMatchObject({ ok: false });
    expect(auth.sessions).toEqual([]);
    expect(await usersWithEmail(email)).toHaveLength(0);
    expect(await personUser(person.id)).toBeNull();
    // Positive pair: the SAME link from our own page signs in — the refusal consumed nothing.
    expect((await post(invite.emailSecret)).status).toBe(200);
    expect(auth.sessions).toHaveLength(1);
  });

  it.each(ALLOWED)("allows %s", async (_name, headers) => {
    const { invite } = await rig();
    expect((await post(invite.emailSecret, headers)).status).toBe(200);
    expect(auth.sessions).toHaveLength(1);
  });

  it("the signed-in branch mints nothing and is not asked for the proof (smoke, bench and API clients send neither header)", async () => {
    const { person, email, invite } = await rig();
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${email}, 'Me', true) returning id`;
    auth.user = { id: u!.id, email, display_name: "Me" };

    const { status } = await post(invite.secret, {});

    expect(status).toBe(200);
    expect(await personUser(person.id)).toBe(u!.id);
    expect(auth.sessions).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("signed OUT: the terms stamp is part of the claim, not an afterthought", () => {
  it("a stamp that fails rolls the claim back: 500, no session, claim still open, no account — and the retry works", async () => {
    const { person, email, invite } = await rig();
    auth.failTermsStamp = true;

    const failed = await post(invite.emailSecret);

    expect(failed.status).toBe(500);
    expect(auth.sessions).toEqual([]); // no cookie to go with the error
    expect(await personUser(person.id)).toBeNull(); // not consumed
    expect(await usersWithEmail(email)).toHaveLength(0); // the new account rolled back with it
    auth.failTermsStamp = false;
    const retry = await post(invite.emailSecret); // not CLAIM_CLAIMED: the failed tap left the link intact
    expect(retry.status).toBe(200);
    expect(auth.sessions).toHaveLength(1);
    expect((await usersWithEmail(email))[0]!.terms_accepted_at).not.toBeNull();
  });

  it("an existing UNVERIFIED account stays unverified and keeps its password when the stamp fails", async () => {
    const { person, email, invite } = await rig();
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified, password_hash)
      values (${email}, 'Held', false, 'squatter-hash') returning id`;
    auth.failTermsStamp = true;

    expect((await post(invite.emailSecret)).status).toBe(500);

    const [after] = await sql<{ email_verified: boolean; password_hash: string | null }[]>`
      select email_verified, password_hash from users where id = ${u!.id}`;
    expect(after).toEqual({ email_verified: false, password_hash: "squatter-hash" });
    expect(await personUser(person.id)).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("the emailed secret's sign-in window (CLAIM_EMAIL_SIGNIN_MS)", () => {
  /** Mint the email secret `ms` ago: the window is measured from the row's creation. */
  const age = (claimId: string, ms: number) =>
    sql`update person_claims set created_at = created_at - ${`${ms} milliseconds`}::interval where id = ${claimId}`;

  it("past the window the emailed link no longer signs in: 401 CLAIM_SIGNIN_EXPIRED (not a console link's bare 401), no session, no account, claim open", async () => {
    const { person, email, invite } = await rig();
    await age(invite.id, CLAIM_EMAIL_SIGNIN_MS + 60_000);

    const { status, body } = await post(invite.emailSecret);

    expect(status).toBe(401);
    // The code is what the page's card acts on (switches to the normal sign-in); a console link carries none.
    expect(body).toMatchObject({ ok: false, code: "CLAIM_SIGNIN_EXPIRED" });
    expect(body.error).not.toBe("Not authenticated");
    expect(auth.sessions).toEqual([]);
    expect(await usersWithEmail(email)).toHaveLength(0);
    expect(await personUser(person.id)).toBeNull();
  });

  it("inside the window the same request signs in (the positive pair of the row above)", async () => {
    const { person, invite } = await rig();
    await age(invite.id, CLAIM_EMAIL_SIGNIN_MS - 60_000);

    expect((await post(invite.emailSecret)).status).toBe(200);
    expect(auth.sessions).toHaveLength(1);
    expect(await personUser(person.id)).not.toBeNull();
  });

  it("past the window a signed-in account with the matching email still accepts, and a different one is still refused", async () => {
    const { person, email, invite } = await rig();
    await age(invite.id, CLAIM_EMAIL_SIGNIN_MS + 60_000);

    const otherEmail = `other-${randomUUID().slice(0, 8)}@test.local`;
    const [other] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${otherEmail}, 'Other', true) returning id`;
    auth.user = { id: other!.id, email: otherEmail, display_name: "Other" };
    expect((await post(invite.emailSecret)).status).toBe(403);
    expect(await personUser(person.id)).toBeNull();

    const [me] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${email}, 'Me', true) returning id`;
    auth.user = { id: me!.id, email, display_name: "Me" };
    const accepted = await post(invite.emailSecret, {});
    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toMatchObject({ signed_in: false, redirect: "/me?claimed=1" });
    expect(await personUser(person.id)).toBe(me!.id);
    expect(auth.sessions).toEqual([]);
  });
});
