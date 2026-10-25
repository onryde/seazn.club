// Security: a sign-in link issued BEFORE the account was deleted must not sign the person back in afterwards.
//
// A login link lives 15 minutes (lib/login-link.ts) and DELETE /api/users/me neither deletes `login_links` rows nor is
// it told about them, so a link issued just before deletion was still redeemable just after. consumeLoginLink then wrote
// `email_verified = true` on the anonymised row and returned its id; the consume route minted a cookie for it and
// postAuthLanding -> ensureActiveOrg provisioned a fresh "My organization" for the deleted user. The session resolver now
// refuses a deleted user (account-deletion-session-revoke.test.ts), so the cookie was inert, but the org was real and the
// deleted row was being written to.
//
// Driven through the real producer and consumer: createLoginLink issues the link, the REAL DELETE /api/users/me deletes the
// account (real createSession/destroySession on a cookie jar), the REAL POST /api/auth/magic-link/consume redeems it, all on
// real Postgres. The stand-ins are the outside world only: `next/headers`, the rate limiter, the deletion email, Stripe.
//
// "Refused" is not asserted against a number written in this file: the expected response is the one the route gives an
// UNKNOWN token, measured in the same test, so the claim is "exactly what an invalid link gets", with no new copy.
//
// Sport: not applicable. Sign-in and account deletion are sport-agnostic.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ subscriptions: { cancel: vi.fn(async () => ({})) } }) }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendAccountDeletionEmail: vi.fn(async () => {}),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.91" }),
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));
// A refused link is thrown as a plain Error, which the handler reports to Sentry and the log: keep both quiet.
vi.mock("@/server/logger", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@sentry/nextjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/nextjs")>()),
  captureException: vi.fn(),
}));

import { sql } from "@/lib/db";
import { createSession } from "@/lib/auth";
import { createLoginLink } from "@/lib/login-link";
import { DELETE } from "@/app/api/users/me/route";
import { POST as CONSUME } from "../consume/route";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `dlc-${randomUUID().slice(0, 8)}`;
const seeded: string[] = [];

async function seedUser(tag: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${RUN}-${tag}@test.local`}, ${`Link ${tag}`}, false) returning id`;
  seeded.push(id);
  return id;
}

const consume = async (token: string) => {
  const res = await CONSUME(
    new Request("https://signin.test/api/auth/magic-link/consume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  );
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; data?: { has_org?: boolean } } };
};

/** Delete `userId` through the real route, signed in on a jar that the deletion then clears (the link is opened on a fresh device). */
async function deleteAccount(userId: string): Promise<void> {
  await createSession(userId);
  const res = await DELETE(new Request("http://test.local/api/users/me", { method: "DELETE", body: JSON.stringify({ confirm: "DELETE" }) }));
  expect(res.status).toBe(200);
  expect(jar.has("seazn_session"), "the deleting device is signed out").toBe(false);
}

const verified = async (id: string) => (await sql<{ email_verified: boolean }[]>`select email_verified from users where id = ${id}`)[0]!.email_verified;
const orgsOf = async (id: string) =>
  (
    await sql<{ n: number }[]>`
      select (select count(*) from org_members where user_id = ${id})::int
           + (select count(*) from organizations where created_by = ${id})::int as n`
  )[0]!.n;
const linkState = async (token: string) =>
  (await sql<{ used: boolean; live: boolean }[]>`select used, expires_at > now() as live from login_links where token = ${token}`)[0];

beforeEach(() => {
  vi.clearAllMocks();
  jar.clear();
});
afterAll(async () => {
  if (HAS_DB) {
    await sql`delete from organizations where created_by = any(${seeded}::uuid[])`.catch(() => undefined);
    await sql`delete from users where id = any(${seeded}::uuid[])`.catch(() => undefined);
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
});

describe.skipIf(!HAS_DB)("redeeming a sign-in link after the account was deleted", () => {
  it("is refused exactly like an invalid link: no cookie, no verification, no organisation", async () => {
    const leaver = await seedUser("leaver");
    const token = await createLoginLink(leaver);
    expect(await linkState(token), "the link is issued, unspent and unexpired when the account is deleted").toEqual({ used: false, live: true });
    expect(await verified(leaver)).toBe(false);
    expect(await orgsOf(leaver)).toBe(0);

    await deleteAccount(leaver);
    expect(await linkState(token), "the deletion left the link redeemable").toMatchObject({ used: false, live: true });

    // What an invalid link gets, measured on the same route.
    const unknown = await consume(`nope-${randomUUID()}`);
    expect(unknown.body.ok).toBe(false);
    expect(unknown.status).toBeGreaterThanOrEqual(400);

    const refused = await consume(token);
    expect(refused.status).toBe(unknown.status);
    expect(refused.body).toEqual(unknown.body);
    expect(jar.has("seazn_session"), "no cookie is minted").toBe(false);
    expect(await verified(leaver), "the deleted row is not written to").toBe(false);
    expect(await orgsOf(leaver), "no organisation is provisioned for a deleted user").toBe(0);

    // And it stays refused: the second tap is no different.
    expect(await consume(token)).toEqual(refused);
    expect(await orgsOf(leaver)).toBe(0);
  });

  it("a live account's link still signs in, verifies and provisions an organisation — beside a deleted account's refused one", async () => {
    const leaver = await seedUser("gone");
    const stayer = await seedUser("stays");
    const leaverToken = await createLoginLink(leaver);
    const stayerToken = await createLoginLink(stayer);
    await deleteAccount(leaver);

    expect((await consume(leaverToken)).body.ok).toBe(false);

    const ok = await consume(stayerToken);
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.data?.has_org).toBe(true);
    expect(jar.has("seazn_session"), "the live account is signed in").toBe(true);
    expect(await verified(stayer)).toBe(true);
    expect(await orgsOf(stayer), "the live account got its organisation").toBeGreaterThan(0);
    expect(await orgsOf(leaver), "and the deleted one still has none").toBe(0);
  });
});
