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
//  - staff impersonation is refused where it starts (`createImpersonationToken`), so no token for the system user exists
//    to open; `createSession` would refuse the page that opens one too, but only after the token was spent.
// The Google callback cannot reach it (it signs in only an address Google verified; `.invalid` never verifies, and the
// system user has no google_sub), and the other doors need a secret that is only ever mailed to the `.invalid` address.
//
// READ-ONLY on the system user's row. Vitest runs files in parallel, and this file runs beside two that assert the row's
// seed values (system-user-refused.test.ts, quick-match-migration.test.ts). So nothing here may write it, not even a
// "restore": a door is only driven where its guard refuses before any write, and a polluted row is a FAILED premise here,
// never healed. (A door that writes before it reaches `createSession`, such as consume, is therefore not driven with the
// system user; the createSession unit case below is what witnesses that guard.)
//
// Each refusal has its positive pair: an ordinary account still gets through the same door.
//
// Sport: not applicable. Sign-in is sport-agnostic.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

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
import { createImpersonationToken } from "@/lib/admin";
import { HttpError } from "@/lib/errors";
import { QUICK_MATCH_SYSTEM_USER_EMAIL, QUICK_MATCH_SYSTEM_USER_ID } from "@/lib/quick-match-constants";
import { createInvite } from "@/server/usecases/invites";
import { POST as INVITE_CLAIM } from "@/app/api/invites/[token]/claim/route";
import { POST as IMPERSONATE } from "@/app/api/admin/users/[id]/impersonate/route";

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
  const seedUser = async (tag: string, verified = false): Promise<{ id: string; email: string }> => {
    const email = `${RUN}-${tag}-${randomUUID().slice(0, 8)}@test.local`;
    const [{ id }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${email}, ${tag}, ${verified}) returning id`;
    users.push(id);
    return { id, email };
  };
  const seedOrg = async (): Promise<{ orgId: string; ownerId: string }> => {
    const suffix = randomUUID().slice(0, 8);
    const { id: ownerId } = await seedUser("owner");
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
  const membership = async (orgId: string, userId: string): Promise<number> =>
    (await sql<{ n: number }[]>`select count(*)::int as n from org_members where org_id = ${orgId} and user_id = ${userId}`)[0]!.n;
  const impersonations = async (actorId: string, targetId: string): Promise<number> =>
    (await sql<{ n: number }[]>`
      select count(*)::int as n from impersonation_sessions where actor_id = ${actorId} and target_id = ${targetId}`)[0]!.n;
  const audits = async (actorId: string, targetId: string): Promise<number> =>
    (await sql<{ n: number }[]>`
      select count(*)::int as n from staff_audit_log
      where actor_id = ${actorId} and action = 'impersonate_start' and target_id = ${targetId}`)[0]!.n;

  beforeAll(async () => {
    // Premise, not a comment: the system user exists under its address. Without the row, the invite claim would create an
    // ordinary account for the address and the refusal below would pass for the wrong reason.
    const rows = await sql<{ id: string }[]>`select id from users where email = ${QUICK_MATCH_SYSTEM_USER_EMAIL} and deleted_at is null`;
    expect(rows.map((r) => r.id), "premise: V492 seeded the system user under its address").toEqual([QUICK_MATCH_SYSTEM_USER_ID]);
  });
  afterAll(async () => {
    if (users.length > 0) {
      await sql`delete from impersonation_sessions where actor_id = any(${users}) or target_id = any(${users})`;
      await sql`delete from staff_audit_log where actor_id = any(${users})`;
    }
    if (orgs.length > 0) await sql`delete from organizations where id = any(${orgs})`; // members, invites cascade
    if (users.length > 0) await sql`delete from users where id = any(${users})`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });

  // ---- the email-invite claim: reachable by any org editor ----------------------------------------------------------

  it("an email invite to the system address: needs_signin, no cookie, not joined, not verified, invite unspent", async () => {
    const { orgId, ownerId } = await seedOrg();
    // Premise: the seed state, the case the claim would auto-sign-in. Were it verified, the refusal would be the old
    // verified-account branch and prove nothing about the guard.
    expect(await systemRow(), "premise: the system user is at its V492 seed").toEqual({ email_verified: false, terms_accepted_at: null });
    const invite = await createInvite(orgId, ownerId, { role: "admin", max_uses: 1, email: QUICK_MATCH_SYSTEM_USER_EMAIL });

    const res = await claimInvite(invite.token);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: { needs_signin: true } });
    expect(h.jar.has(SESSION_COOKIE), "no session").toBe(false);
    expect(await membership(orgId, QUICK_MATCH_SYSTEM_USER_ID), "not joined to the editor's org").toBe(0);
    expect(await systemRow(), "not verified, no terms stamp").toEqual({ email_verified: false, terms_accepted_at: null });
    const [{ used_count }] = await sql<{ used_count: number }[]>`select used_count from org_invites where id = ${invite.id}`;
    expect(used_count).toBe(0);
  });

  it("positive pair: an email invite to an ordinary unverified address still signs in and joins through the same door", async () => {
    const { orgId, ownerId } = await seedOrg();
    const invitee = await seedUser("invitee");
    const invite = await createInvite(orgId, ownerId, { role: "admin", max_uses: 1, email: invitee.email });

    const res = await claimInvite(invite.token);

    expect(res.status).toBe(200);
    expect(res.body.data?.needs_signin).toBe(false);
    expect(h.jar.has(SESSION_COOKIE), "a session").toBe(true);
    expect(await membership(orgId, invitee.id)).toBe(1);
  });

  // ---- staff impersonation: refused where it starts -----------------------------------------------------------------

  it("staff cannot start impersonating the system user: 403, no impersonation token, no audit entry", async () => {
    const staff = await seedUser("staff");

    const err = await createImpersonationToken(staff.id, QUICK_MATCH_SYSTEM_USER_ID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect(await impersonations(staff.id, QUICK_MATCH_SYSTEM_USER_ID), "no token row").toBe(0);
    expect(await audits(staff.id, QUICK_MATCH_SYSTEM_USER_ID), "no impersonate_start entry").toBe(0);
  });

  it("positive pair: staff still get a token for an ordinary user, with its row and audit entry", async () => {
    const staff = await seedUser("staff");
    const target = await seedUser("target");

    const token = await createImpersonationToken(staff.id, target.id);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await impersonations(staff.id, target.id)).toBe(1);
    expect(await audits(staff.id, target.id)).toBe(1);
  });

  // ---- the impersonate route, as staff reach it: the URL's id is free text -----------------------------------------
  // Postgres reads an uppercase uuid as the same row, so the route must hand the guard the DATABASE's id. Handed the raw
  // URL id, `createImpersonationToken`'s string compare misses the system user and writes a token row and an audit entry
  // before `createSession` refuses the page that opens it (review D9).

  const seedStaff = async (): Promise<{ id: string }> => {
    const staff = await seedUser("staff");
    await sql`update users set is_staff = true, staff_role = 'support' where id = ${staff.id}`;
    return staff;
  };
  const impersonateViaRoute = async (staffId: string, targetId: string) => {
    h.jar.clear();
    await createSession(staffId);
    const res = await IMPERSONATE(new Request(`https://signin.test/api/admin/users/${targetId}/impersonate`, { method: "POST" }), {
      params: Promise.resolve({ id: targetId }),
    });
    h.jar.clear();
    return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; data?: { url: string } } };
  };
  /** Everything this staff member's impersonations wrote, whatever case the target id was written in: the audit log's
   *  `target_id` is text, so a count keyed on the lowercase id would miss an uppercase write and read zero. */
  const startedBy = async (actorId: string) => ({
    tokens: (await sql<{ n: number }[]>`
      select count(*)::int as n from impersonation_sessions where actor_id = ${actorId}`)[0]!.n,
    audits: (await sql<{ n: number }[]>`
      select count(*)::int as n from staff_audit_log where actor_id = ${actorId} and action = 'impersonate_start'`)[0]!.n,
  });

  it("the route refuses the system user's id written in uppercase: 403, no impersonation token, no audit entry", async () => {
    const staff = await seedStaff();
    const upper = QUICK_MATCH_SYSTEM_USER_ID.toUpperCase();
    expect(upper, "premise: the uppercase id is a different string from the constant").not.toBe(QUICK_MATCH_SYSTEM_USER_ID);

    const res = await impersonateViaRoute(staff.id, upper);

    expect(res).toEqual({ status: 403, body: { ok: false, error: "Cannot impersonate the system user" } });
    expect(await startedBy(staff.id)).toEqual({ tokens: 0, audits: 0 });
  });

  it("positive pair: the same route, given an ordinary user's id in uppercase, still starts one impersonation", async () => {
    const staff = await seedStaff();
    const target = await seedUser("target");

    const res = await impersonateViaRoute(staff.id, target.id.toUpperCase());

    expect(res.status).toBe(200);
    expect(res.body.data?.url).toMatch(/\/admin\/impersonate\?token=[0-9a-f]{64}$/);
    expect(await startedBy(staff.id)).toEqual({ tokens: 1, audits: 1 });
    expect(await impersonations(staff.id, target.id), "the token row names the database's id").toBe(1);
    expect(await audits(staff.id, target.id), "the audit entry names the database's id, not the URL's").toBe(1);
  });
});
