// Quick match (spec 2026-11-03 §7.1): the platform system user (V492, QUICK_MATCH_SYSTEM_USER_ID) "can never sign in". This
// file is the SESSION half; the sign-in-link half is app/api/auth/magic-link/__tests__/system-user-refused.test.ts.
//
// Every door that signs a person in ends in `createSession` (grep of its call sites, 2026-11-07): magic-link consume,
// verify-email, the Google callback, the player-claim accept, the funnel claim, the email-invite claim and staff
// impersonation. `createSession` is the only place a session cookie is signed (the `seazn-session` audience appears
// nowhere else), so its refusal covers every door at once, including a door added later. Two doors get more than that:
//  - the email-invite claim is reachable by ANY org editor: invite the system address, read the invite's token back from
//    GET /api/orgs/[id]/invites, POST the claim signed out. The system user is unverified (V492), which is exactly the
//    case that claim auto-signs-in. `claimEmailInvite` therefore treats it as it treats a verified account (`needs_signin`,
//    nothing written), so the system user is not joined to the editor's org or marked verified on the way to the refusal.
//  - magic-link consume is driven with a link planted by hand (the minter refuses to make one), to show the refusal
//    reaches through a real door as a 403 and no cookie.
// The Google callback cannot reach it (it signs in only an address Google verified; `.invalid` never verifies, and the
// system user has no google_sub), and the other doors need a secret that is only ever mailed to the `.invalid` address.
//
// Each refusal has its positive pair: an ordinary account still gets its session through the same door.
//
// Sport: not applicable. Sign-in is sport-agnostic.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));
const h = vi.hoisted(() => ({ jar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.93" }),
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    set: (name: string, value: string) => void h.jar.set(name, value),
    delete: (name: string) => void h.jar.delete(name),
  }),
}));
vi.mock("@/server/logger", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@sentry/nextjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/nextjs")>()),
  captureException: vi.fn(),
}));

import { sql } from "@/lib/db";
import { createSession } from "@/lib/auth";
import { HttpError } from "@/lib/errors";
import { QUICK_MATCH_SYSTEM_USER_EMAIL, QUICK_MATCH_SYSTEM_USER_ID } from "@/lib/quick-match-constants";
import { createInvite } from "@/server/usecases/invites";
import { POST as CONSUME } from "@/app/api/auth/magic-link/consume/route";
import { POST as INVITE_CLAIM } from "@/app/api/invites/[token]/claim/route";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `sus-${randomUUID().slice(0, 8)}`;
const SESSION_COOKIE = "seazn_session";
const ORDINARY_ID = "11111111-2222-4333-8444-999999999999";

beforeAll(() => {
  process.env.AUTH_SECRET ??= "auth-secret-for-system-user-session-test-0123456789-0123456789";
});
beforeEach(() => h.jar.clear());

describe("createSession refuses the system user", () => {
  it("rejects with a 403 and writes no cookie", async () => {
    const err = await createSession(QUICK_MATCH_SYSTEM_USER_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect([(err as HttpError).status, (err as HttpError).message]).toEqual([403, "system user"]);
    expect([...h.jar.keys()], "neither the session nor the signed-in hint").toEqual([]);
  });

  it("positive pair: an ordinary id still gets its session cookie", async () => {
    await createSession(ORDINARY_ID);
    expect(h.jar.get(SESSION_COOKIE), "a signed session").toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });
});

type SystemRow = { email_verified: boolean; terms_accepted_at: Date | null };

describe.skipIf(!HAS_DB)("the doors that mint a session refuse the system user (DB)", () => {
  const users: string[] = [];
  const orgs: string[] = [];

  const systemRow = async (): Promise<SystemRow> =>
    (await sql<SystemRow[]>`select email_verified, terms_accepted_at from users where id = ${QUICK_MATCH_SYSTEM_USER_ID}`)[0]!;
  /** Back to V492's seed (unverified, no terms, no link, no membership), only these columns, never the row. A refused door
   *  can still flip `email_verified` on its way to the refusal (consume does, by design, before the session), and a
   *  mutated run of this file can do more; the shared local database would otherwise carry it into the next premise. */
  const restoreSystemUser = async () => {
    await sql`delete from login_links where user_id = ${QUICK_MATCH_SYSTEM_USER_ID}`;
    if (orgs.length > 0) await sql`delete from org_members where user_id = ${QUICK_MATCH_SYSTEM_USER_ID} and org_id = any(${orgs})`;
    await sql`
      update users set email_verified = false, terms_accepted_at = null, terms_version = null
      where id = ${QUICK_MATCH_SYSTEM_USER_ID}`;
  };
  const seedOrg = async (): Promise<{ orgId: string; ownerId: string }> => {
    const suffix = randomUUID().slice(0, 8);
    const [{ id: ownerId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name) values (${`${RUN}-owner-${suffix}@test.local`}, 'Owner') returning id`;
    users.push(ownerId);
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by) values (${`Org ${suffix}`}, ${`${RUN}-${suffix}`}, ${ownerId}) returning id`;
    orgs.push(orgId);
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
    return { orgId, ownerId };
  };
  const claimInvite = async (token: string) => {
    const res = await INVITE_CLAIM(new Request(`https://signin.test/api/invites/${token}/claim`, { method: "POST" }), {
      params: Promise.resolve({ token }),
    });
    return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; data?: { needs_signin?: boolean } } };
  };
  const consume = async (token: string) => {
    const res = await CONSUME(
      new Request("https://signin.test/api/auth/magic-link/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // A `next` lands on it rather than provisioning a default org for the positive pair's new account.
        body: JSON.stringify({ token, next: "/me" }),
      }),
    );
    return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string } };
  };
  const plantLink = async (userId: string): Promise<string> => {
    const token = randomBytes(32).toString("base64url");
    await sql`insert into login_links (user_id, token, expires_at) values (${userId}, ${token}, now() + interval '10 minutes')`;
    return token;
  };
  const membership = async (orgId: string, userId: string): Promise<number> =>
    (await sql<{ n: number }[]>`select count(*)::int as n from org_members where org_id = ${orgId} and user_id = ${userId}`)[0]!.n;

  beforeAll(async () => {
    // Premise, not a comment: the system user exists under its address and is UNVERIFIED, which is the case the invite
    // claim auto-signs-in. Were it verified, the invite case below would pass for the wrong reason.
    const rows = await sql<{ id: string }[]>`select id from users where email = ${QUICK_MATCH_SYSTEM_USER_EMAIL} and deleted_at is null`;
    expect(rows.map((r) => r.id), "premise: V492 seeded the system user under its address").toEqual([QUICK_MATCH_SYSTEM_USER_ID]);
    await restoreSystemUser();
  });
  afterAll(async () => {
    await restoreSystemUser();
    if (orgs.length > 0) await sql`delete from organizations where id = any(${orgs})`; // members, invites cascade
    if (users.length > 0) await sql`delete from users where id = any(${users})`; // login_links cascade
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });

  // ---- the email-invite claim: reachable by any org editor ----------------------------------------------------------

  it("an email invite to the system address: needs_signin, no cookie, not joined, not verified, invite unspent", async () => {
    const { orgId, ownerId } = await seedOrg();
    expect((await systemRow()).email_verified, "premise: the system user is unverified").toBe(false);
    const invite = await createInvite(orgId, ownerId, { role: "admin", max_uses: 1, email: QUICK_MATCH_SYSTEM_USER_EMAIL });

    const res = await claimInvite(invite.token);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: { needs_signin: true } });
    expect(h.jar.has(SESSION_COOKIE), "no session").toBe(false);
    expect(await membership(orgId, QUICK_MATCH_SYSTEM_USER_ID), "not joined to the editor's org").toBe(0);
    const row = await systemRow();
    expect([row.email_verified, row.terms_accepted_at]).toEqual([false, null]);
    const [{ used_count }] = await sql<{ used_count: number }[]>`select used_count from org_invites where id = ${invite.id}`;
    expect(used_count).toBe(0);
  });

  it("positive pair: an email invite to an ordinary unverified address still signs in and joins through the same door", async () => {
    const { orgId, ownerId } = await seedOrg();
    const email = `${RUN}-invitee-${randomUUID().slice(0, 8)}@club.test`;
    const [{ id: inviteeId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${email}, 'Invitee', false) returning id`;
    users.push(inviteeId);
    const invite = await createInvite(orgId, ownerId, { role: "admin", max_uses: 1, email });

    const res = await claimInvite(invite.token);

    expect(res.status).toBe(200);
    expect(res.body.data?.needs_signin).toBe(false);
    expect(h.jar.has(SESSION_COOKIE), "a session").toBe(true);
    expect(await membership(orgId, inviteeId)).toBe(1);
  });

  // ---- magic-link consume: the createSession refusal through a real door -------------------------------------------

  it("a planted sign-in link for the system user is refused at the session: 403, no cookie", async () => {
    const token = await plantLink(QUICK_MATCH_SYSTEM_USER_ID);
    try {
      const res = await consume(token);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ ok: false, error: "system user" });
      expect(h.jar.has(SESSION_COOKIE), "no session").toBe(false);
    } finally {
      await restoreSystemUser(); // consume verifies the address before the session is asked for
    }
  });

  it("positive pair: a link for an ordinary account still signs it in through the same door", async () => {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${`${RUN}-consume@test.local`}, 'Consumer', false) returning id`;
    users.push(id);
    const token = await plantLink(id);

    const res = await consume(token);

    expect(res.status).toBe(200);
    expect(h.jar.has(SESSION_COOKIE), "a session").toBe(true);
  });
});
