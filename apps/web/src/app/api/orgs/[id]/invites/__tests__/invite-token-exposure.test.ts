// SECURITY (owner-approved 2026-11-07, "apply rec"). An EMAIL-bound org invite's token is a one-click sign-in: for a new or
// UNVERIFIED account, POST /api/invites/<token>/claim resolves the account, joins it to the org, marks the address verified
// and mints a session (`claimEmailInvite`, lib/invites.ts). That is sound only while the token reaches the invitee's
// mailbox and nobody else. It did not: the org's own editors read it back from the invite list (GET) and from the create
// answer (POST). So any editor could invite the address of an existing unverified account, read the token, claim it
// signed out, and walk away holding that person's session (or a fresh verified account for an address they do not own).
//
// The fix is the root cause: no editor-facing answer carries an email-bound token. A shareable link (no address) keeps
// its token, since copying it is the editor's whole job. Revoke, which was keyed by token, now takes the invite id, which
// the editor does hold.
//
// Driven through the REAL routes (list, create, revoke, and the signed-out claim) with real sessions through the real
// requireOrgRole. Stand-ins: `next/headers` (a cookie jar) and the outbox transport (the one network seam: captured, never
// sent). Expected tokens come from the invite's own row (`org_invites`), never from a route's answer.
//
// Sport: not applicable (an org invite does not vary by sport).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const jar = vi.hoisted(() => ({ values: new Map<string, string>(), ip: "203.0.113.70" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": jar.ip }),
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
}));
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));

import { sql } from "@/lib/db";
import { createSession } from "@/lib/auth";
import { makeUser, seedOrg } from "@/server/usecases/__tests__/_registration-fixtures";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { GET as listRoute, POST as createRoute } from "../route";
import { POST as revokeRoute } from "../[token]/revoke/route";
import { POST as claimRoute } from "@/app/api/invites/[token]/claim/route";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `itx-${randomUUID().slice(0, 8)}`;
const ORIGIN = "https://team.test";
const SESSION_COOKIE = "seazn_session";
const orgs: string[] = [];

/** An invite as an editor-facing answer shows it. */
type Shown = {
  id: string;
  email: string | null;
  token: string | null;
  role: string;
  revoked: boolean;
};
type Answer<T> = { status: number; data: T };

const address = (): string => `${RUN}-${randomUUID().slice(0, 8)}@x.test`;

/** A Pro org (no seat cap in the way of the attack), its owner, and a second EDITOR: an admin, not the owner. */
async function team(): Promise<{ orgId: string; ownerId: string; editorId: string }> {
  const { orgId, ownerId } = await seedOrg("pro");
  orgs.push(orgId);
  const editorId = await makeUser(`${RUN}-editor`);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${editorId}, 'admin')`;
  return { orgId, ownerId, editorId };
}

/** Someone else's account: it exists, and has never verified its address (a magic-link request or a registration's
 *  captain email creates exactly this). */
async function unverifiedAccount(): Promise<{ id: string; email: string }> {
  const email = address();
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${email}, 'victim', false) returning id`;
  return { id, email };
}

async function json<T>(res: Response): Promise<Answer<T>> {
  const body = (await res.json()) as { data: T };
  return { status: res.status, data: body.data };
}

/** Run one request as `userId`, through a real session, then sign out again. */
async function as<T>(userId: string, fn: () => Promise<Response>): Promise<Answer<T>> {
  jar.values.clear();
  await createSession(userId);
  try {
    return await json<T>(await fn());
  } finally {
    jar.values.clear();
  }
}

const createInvite = (orgId: string, userId: string, body: Record<string, unknown>) =>
  as<Shown & { email_sent?: boolean }>(userId, () =>
    createRoute(
      new Request(`${ORIGIN}/api/orgs/${orgId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: orgId }) },
    ),
  );

const listInvites = (orgId: string, userId: string) =>
  as<Shown[]>(userId, () =>
    listRoute(new Request(`${ORIGIN}/api/orgs/${orgId}/invites`), { params: Promise.resolve({ id: orgId }) }),
  );

/** POST /api/orgs/<orgId>/invites/<ref>/revoke — `ref` is whatever the caller puts in the path segment. */
const revoke = (orgId: string, userId: string, ref: string) =>
  as<{ ok: boolean }>(userId, () =>
    revokeRoute(new Request(`${ORIGIN}/api/orgs/${orgId}/invites/${ref}/revoke`, { method: "POST" }), {
      params: Promise.resolve({ id: orgId, token: ref }),
    }),
  );

/** The signed-out one-click claim, from a fresh address each time (the rate limit is per IP). Reports whether a
 *  session was minted. */
async function claimSignedOut(token: string): Promise<{ status: number; session: boolean; body: unknown }> {
  jar.values.clear();
  jar.ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  const res = await claimRoute(new Request(`${ORIGIN}/api/invites/${token}/claim`, { method: "POST" }), {
    params: Promise.resolve({ token }),
  });
  const session = jar.values.has(SESSION_COOKIE);
  jar.values.clear();
  return { status: res.status, session, body: await res.json() };
}

/** The invite's own token, from its row: what the email carries. */
const tokenOf = async (inviteId: string): Promise<string> =>
  (await sql<{ token: string }[]>`select token from org_invites where id = ${inviteId}`)[0]!.token;
const revokedOf = async (inviteId: string): Promise<boolean> =>
  (await sql<{ revoked: boolean }[]>`select revoked from org_invites where id = ${inviteId}`)[0]!.revoked;
const accountState = async (orgId: string, userId: string) => {
  const [u] = await sql<{ email_verified: boolean }[]>`select email_verified from users where id = ${userId}`;
  const [m] = await sql<{ n: number }[]>`
    select count(*)::int as n from org_members where org_id = ${orgId} and user_id = ${userId}`;
  return { verified: u!.email_verified, member: m!.n > 0 };
};

beforeEach(() => {
  transport.deliver.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_${RUN}_${randomUUID()}` }));
  stubOutboxEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where org_id = any(${orgs}::uuid[])`;
  await sql`delete from organizations where id = any(${orgs}::uuid[])`; // org_invites, org_members cascade
});

describe.skipIf(!HAS_DB)("an email-bound invite's token never reaches an editor (DB, real routes)", () => {
  it("the exploit: an editor invites an existing UNVERIFIED account's address, reads the invite back, and has nothing to claim it with", async () => {
    const { orgId, editorId } = await team();
    const victim = await unverifiedAccount();

    const created = await createInvite(orgId, editorId, { role: "admin", email: victim.email });
    expect(created.status).toBe(200);
    const mailed = await tokenOf(created.data.id);
    expect(mailed, "premise: the stored invite has a token (the one its email carries)").toMatch(/^[A-Za-z0-9_-]{32}$/);

    const listed = await listInvites(orgId, editorId);
    expect(listed.status).toBe(200);
    const row = listed.data.find((i) => i.id === created.data.id);
    expect(row?.email, "premise: the editor sees the email invite in the list").toBe(victim.email);

    // The attacker's move: claim, signed out, with whatever the editor-facing answers handed over.
    const held = row!.token ?? created.data.token;
    const claim = held === null ? null : await claimSignedOut(held);
    expect(
      { ...(await accountState(orgId, victim.id)), session: claim?.session ?? false },
      `the editor claimed someone else's account: ${JSON.stringify(claim?.body)}`,
    ).toEqual({ verified: false, member: false, session: false });

    // And the token is in neither answer, under any field.
    expect(created.data.token, "the create answer carries the email-bound token").toBeNull();
    expect(row!.token, "the list carries the email-bound token").toBeNull();
    expect(JSON.stringify(created.data)).not.toContain(mailed);
    expect(JSON.stringify(listed.data)).not.toContain(mailed);
  });

  it("positive pair: a shareable link in the same org still carries its token, in the create answer and the list", async () => {
    const { orgId, editorId } = await team();
    const email = await createInvite(orgId, editorId, { role: "viewer", email: address() });
    const link = await createInvite(orgId, editorId, { role: "viewer", max_uses: 0, expires_in_days: 1 });
    expect(link.data.email, "premise: a shareable link, no address").toBeNull();
    const linkToken = await tokenOf(link.data.id);

    expect(link.data.token, "the create answer keeps the link's token").toBe(linkToken);
    const listed = (await listInvites(orgId, editorId)).data;
    expect(listed.find((i) => i.id === link.data.id)?.token, "the list keeps the link's token").toBe(linkToken);
    expect(listed.find((i) => i.id === email.data.id)?.token, "the email invite beside it is redacted").toBeNull();
  });

  it("the invitee still gets it: the email carries the token, and that token still signs a NEW invitee in", async () => {
    // The redaction must take the token away from the editor, not from the mailbox.
    const { orgId, editorId } = await team();
    const invitee = address();
    const created = await createInvite(orgId, editorId, { role: "viewer", email: invitee });
    const mailed = await tokenOf(created.data.id);

    const sent = transport.deliver.mock.calls.map((c) => c[0] as { to: string; text: string });
    expect(sent.filter((m) => m.to === invitee), "one email to the invitee").toHaveLength(1);
    expect(sent.find((m) => m.to === invitee)!.text, "the email carries the invite's join link").toContain(`/join/${mailed}`);

    const claim = await claimSignedOut(mailed);
    expect(claim.status).toBe(200);
    expect(claim.session, "the mailbox's token signs the invitee in").toBe(true);
  });

  it("revoke by invite id — what the Team panel sends — kills an email-bound invite, and only that one", async () => {
    const { orgId, editorId } = await team();
    const doomed = await createInvite(orgId, editorId, { role: "viewer", email: address() });
    const sibling = await createInvite(orgId, editorId, { role: "viewer", email: address() });

    const res = await revoke(orgId, editorId, doomed.data.id);

    expect(res).toEqual({ status: 200, data: { ok: true } });
    expect(await revokedOf(doomed.data.id), "the email invite is revoked").toBe(true);
    expect(await revokedOf(sibling.data.id), "its sibling is untouched").toBe(false);
    // The link in the mailbox is dead too.
    const claim = await claimSignedOut(await tokenOf(doomed.data.id));
    expect({ status: claim.status, session: claim.session }).toEqual({ status: 400, session: false });
  });

  it("revoke is scoped to the org: another org's editor cannot revoke this org's invite by its id", async () => {
    const a = await team();
    const b = await team();
    const target = await createInvite(a.orgId, a.editorId, { role: "viewer", email: address() });

    // B's editor, on B's own path (the one requireOrgRole lets them through), naming A's invite.
    const res = await revoke(b.orgId, b.editorId, target.data.id);

    expect(res.status).toBe(200);
    expect(await revokedOf(target.data.id), "another org's id matches nothing").toBe(false);
    // And on A's path they are not a member at all (requireOrgRole answers AuthError, a 401).
    expect((await revoke(a.orgId, b.editorId, target.data.id)).status).toBe(401);
    expect(await revokedOf(target.data.id)).toBe(false);
  });

  it("revoke still takes a shareable link's token (API callers that predate ids), and a ref that names nothing is a no-op, not a 500", async () => {
    const { orgId, editorId } = await team();
    const link = await createInvite(orgId, editorId, { role: "viewer", max_uses: 0, expires_in_days: 1 });
    const other = await createInvite(orgId, editorId, { role: "viewer", max_uses: 0, expires_in_days: 1 });

    expect(await revoke(orgId, editorId, await tokenOf(link.data.id))).toEqual({ status: 200, data: { ok: true } });
    expect(await revokedOf(link.data.id)).toBe(true);

    for (const ref of [randomUUID(), "not-a-real-ref", randomUUID().toUpperCase()]) {
      expect(await revoke(orgId, editorId, ref), `ref ${ref}`).toEqual({ status: 200, data: { ok: true } });
    }
    expect(await revokedOf(other.data.id), "nothing else was revoked").toBe(false);
  });

  it("sequence: one email-bound and one shareable invite — list, revoke each by id, list again", async () => {
    const { orgId, ownerId } = await team();
    const email = await createInvite(orgId, ownerId, { role: "admin", email: address() });
    const link = await createInvite(orgId, ownerId, { role: "viewer", max_uses: 0, expires_in_days: 1 });
    const linkToken = await tokenOf(link.data.id);
    const mailed = await tokenOf(email.data.id);

    /** Every row of the list, judged by kind; reports how many it checked so an empty list cannot pass. */
    const judge = (rows: Shown[]) => {
      let checked = 0;
      for (const r of rows) {
        if (r.email) expect(r.token, `email row ${r.id}`).toBeNull();
        else expect(r.token, `link row ${r.id}`).toEqual(r.id === link.data.id ? linkToken : expect.any(String));
        checked += 1;
      }
      return checked;
    };

    const before = (await listInvites(orgId, ownerId)).data;
    expect(judge(before), "rows checked").toBe(2);
    expect(before.map((r) => [r.id, r.revoked]).sort()).toEqual(
      [[email.data.id, false], [link.data.id, false]].sort(),
    );

    expect((await revoke(orgId, ownerId, email.data.id)).status).toBe(200);
    expect((await revoke(orgId, ownerId, link.data.id)).status).toBe(200);
    // A second tap on an already-revoked invite is harmless.
    expect((await revoke(orgId, ownerId, email.data.id)).status).toBe(200);

    const after = (await listInvites(orgId, ownerId)).data;
    expect(judge(after), "rows checked").toBe(2);
    expect(after.map((r) => [r.id, r.revoked]).sort()).toEqual(
      [[email.data.id, true], [link.data.id, true]].sort(),
    );
    expect(JSON.stringify(after), "the revoked email invite's token stays out too").not.toContain(mailed);
  });
});
