// Review T2-I1: since V451 the Lichess row holds a SEALED board:play token — a
// credential that can move pieces in any of the player's Lichess games. The
// consent copy promises that grant ends when the player unlinks; deleting the
// account is the stronger withdrawal, so DELETE /api/users/me must revoke it at
// Lichess and drop the row before the account is anonymised. Before this fix
// the handler soft-deleted `users` and never touched user_external_accounts.
//
// Real Postgres required; skipped without DATABASE_URL. The session half of
// auth and the email are stubbed (as account-deletion-billing.test.ts does);
// the link is written by the real upsertLichessLink, so the token is sealed
// under the real envelope and the revoke carries the OPENED token.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ subscriptions: { cancel: vi.fn(async () => ({})) } }),
}));
const authState = vi.hoisted(() => ({
  user: null as { id: string; email: string; locale: string | null } | null,
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireUser: vi.fn(async () => authState.user),
  destroySession: vi.fn(async () => {}),
  invalidateUser: vi.fn(async () => {}),
  invalidateUserOrgs: vi.fn(async () => {}),
}));
vi.mock("@/lib/email", () => ({ sendAccountDeletionEmail: vi.fn(async () => {}) }));

import { sql } from "@/lib/db";
import { DELETE } from "@/app/api/users/me/route";
import { PLAY_SCOPES, upsertLichessLink } from "@/server/usecases/external-accounts";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

type FetchCall = [string, RequestInit];
const fetchCalls = (): FetchCall[] =>
  (fetch as unknown as { mock: { calls: FetchCall[] } }).mock.calls;

async function seedUser(): Promise<string> {
  const s = uniq();
  const email = `lichess-del-${s}@test.local`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, 'Leaver', true) returning id`;
  authState.user = { id, email, locale: null };
  return id;
}

async function linkLichess(userId: string, token: string): Promise<void> {
  await upsertLichessLink(userId, {
    externalUserId: `del-${uniq()}`, username: "Leaver",
    scopes: [...PLAY_SCOPES], token,
  });
}

const linkRows = async (userId: string): Promise<number> => {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from user_external_accounts where user_id = ${userId}`;
  return n;
};
const deletedAt = async (userId: string): Promise<Date | null> =>
  (await sql<{ deleted_at: Date | null }[]>`
    select deleted_at from users where id = ${userId}`)[0]!.deleted_at;

const del = () =>
  DELETE(new Request("http://test.local/api/users/me", {
    method: "DELETE",
    body: JSON.stringify({ confirm: "DELETE" }),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LICHESS_TOKEN_KEK", randomBytes(32).toString("hex"));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("deleting an account that holds a Lichess link", () => {
  it("revokes the grant with the OPENED token and leaves no sealed token behind", async () => {
    const userId = await seedUser();
    await linkLichess(userId, "lio_deleted_account");
    expect(await linkRows(userId)).toBe(1);

    const res = await del();
    expect(res.status).toBe(200);
    expect(await deletedAt(userId)).not.toBeNull();
    expect(await linkRows(userId)).toBe(0);

    const revokes = fetchCalls().filter(([, init]) => init.method === "DELETE");
    expect(revokes).toHaveLength(1);
    expect(revokes[0]![0]).toBe("https://lichess.org/api/token");
    expect(new Headers(revokes[0]![1].headers).get("authorization"))
      .toBe("Bearer lio_deleted_account");
  });

  // The empty case: no link, nothing to revoke — deletion is unchanged.
  it("an account with no link deletes as before and sends nothing to Lichess", async () => {
    const userId = await seedUser();
    const res = await del();
    expect(res.status).toBe(200);
    expect(await deletedAt(userId)).not.toBeNull();
    expect(fetchCalls()).toEqual([]);
  });

  // Password sign-in was removed 2026-10-19, but `users.password_hash` still exists (the owner decides separately
  // about dropping it) and legacy password accounts still hold a bcrypt hash. Deleting such an account must not
  // leave a credential behind in the anonymised row; only the leaver's hash is erased.
  it("erases a legacy password hash on deletion, and leaves every other account's hash alone", async () => {
    const userId = await seedUser();
    const [{ id: otherId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`other-${uniq()}@test.local`}, 'Stays', true) returning id`;
    await sql`update users set password_hash = '$2b$10$legacyhashlegacyhashlegacyhashlegacyhashlegacyha' where id in (${userId}, ${otherId})`;

    const res = await del();
    expect(res.status).toBe(200);

    const hashes = await sql<{ id: string; password_hash: string | null }[]>`
      select id, password_hash from users where id in (${userId}, ${otherId})`;
    const byId = new Map(hashes.map((r) => [r.id, r.password_hash]));
    expect(byId.size, "both rows were read").toBe(2);
    expect(byId.get(userId), "the deleted account's hash is erased").toBeNull();
    expect(byId.get(otherId), "another account's hash is untouched").not.toBeNull();
  });

  // Ordering: a deletion the handler REFUSES must not have revoked anything —
  // the player keeps their account, so they keep their link. Sole owner of an
  // org with another member is the handler's own 409.
  it("a REFUSED deletion keeps the link and revokes nothing", async () => {
    const userId = await seedUser();
    await linkLichess(userId, "lio_refused_deletion");
    const s = uniq();
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by)
      values (${"Keep " + s}, ${"keep-" + s}, ${userId}) returning id`;
    const [{ id: memberId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`member-${s}@test.local`}, 'Member', true) returning id`;
    await sql`
      insert into org_members (org_id, user_id, role)
      values (${orgId}, ${userId}, 'owner'), (${orgId}, ${memberId}, 'viewer')`;

    const res = await del();
    expect(res.status).toBe(409);
    expect(await deletedAt(userId)).toBeNull();
    expect(await linkRows(userId)).toBe(1);
    expect(fetchCalls()).toEqual([]);
  });
});
