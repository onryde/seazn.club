// Quick match (spec 2026-11-03 §7.1): the platform system user (V492, QUICK_MATCH_SYSTEM_USER_ID) is the actor for every
// guest-created row and "can never sign in". This file is the sign-in-LINK half of that: the request route and the token
// minter both refuse it. The session half (createSession itself, and the doors that mint one) is
// lib/__tests__/quick-match-system-user-session.test.ts.
//
// Two guards, deliberately: the route treats the system user's address as no account (the branch a soft-deleted account's
// address takes), BEFORE `stampTermsAcceptance`, so the system user is never stamped as having accepted the terms; and
// `issueLoginLink`, which the route and `createLoginLink` both call, refuses the id with a 403 before writing. Each case
// below has its positive pair (an ordinary account still gets its link), so a guard that refused everyone would be seen.
//
// Driven through the REAL route, the REAL minter and the REAL outbox on real Postgres; the stand-ins are the rate limiter,
// `next/headers` and the logger. Resend is off (no API key), so the positive pair's row ends dead without a network call.
//
// READ-ONLY on the system user's row and its links. Vitest runs files in parallel, and this file runs beside others that
// read the same seeded row (quick-match-system-user-session.test.ts, quick-match-migration.test.ts). So nothing here
// writes it, not even a "restore": every case is one whose guard refuses before any write, and a polluted row is a FAILED
// premise here, never healed.
//
// Sport: not applicable. Sign-in is sport-agnostic.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { QUICK_MATCH_SYSTEM_USER_EMAIL, QUICK_MATCH_SYSTEM_USER_ID } from "@/lib/quick-match-constants";

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.92" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
vi.mock("@/server/logger", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@sentry/nextjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/nextjs")>()),
  captureException: vi.fn(),
}));

import { POST } from "../route";
import { createLoginLink, issueLoginLink } from "@/lib/login-link";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `sur-${randomUUID().slice(0, 8)}`;
const KEK = "cd".repeat(32);
const ORIGIN = "https://signin.test";
/** The route's answer to every address it will not say anything about. It is the contract, copied from route-outbox.test.ts. */
const MESSAGE = "Check your email — a sign-in link is on its way.";

type Envelope = { ok: boolean; error?: string; data?: { message?: string; login_url?: string } };
type SystemRow = { email_verified: boolean; terms_accepted_at: Date | null; terms_version: string | null };

describe.skipIf(!HAS_DB)("the quick-match system user never gets a sign-in link (DB)", () => {
  const emails: string[] = [];

  const post = async (email: string): Promise<{ status: number; json: Envelope }> => {
    const res = await POST(
      new Request(`${ORIGIN}/api/auth/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      }),
    );
    return { status: res.status, json: (await res.json()) as Envelope };
  };
  const outboxCount = async (email: string): Promise<number> =>
    (await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where lower(recipient) = lower(${email})`)[0]!.n;
  const linkCount = async (userId: string): Promise<number> =>
    (await sql<{ n: number }[]>`select count(*)::int as n from login_links where user_id = ${userId}`)[0]!.n;
  const systemRow = async (): Promise<SystemRow> =>
    (await sql<SystemRow[]>`
      select email_verified, terms_accepted_at, terms_version from users where id = ${QUICK_MATCH_SYSTEM_USER_ID}`)[0]!;
  /** A fresh ordinary account, the positive pair for every refusal. */
  const ordinaryUser = async (): Promise<{ id: string; email: string }> => {
    const email = `${RUN}-${randomUUID().slice(0, 8)}@x.test`;
    emails.push(email);
    const [{ id }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${email}, 'Ordinary', false) returning id`;
    return { id, email };
  };
  beforeAll(async () => {
    // Premise, not a comment: the system user exists, under its address, so the route's lookup really resolves to it.
    // Without the row the address is an unknown one and the route would create an ordinary account for it.
    const rows = await sql<{ id: string }[]>`select id from users where email = ${QUICK_MATCH_SYSTEM_USER_EMAIL} and deleted_at is null`;
    expect(rows.map((r) => r.id), "premise: V492 seeded the system user under its address").toEqual([QUICK_MATCH_SYSTEM_USER_ID]);
  });
  afterAll(async () => {
    if (emails.length > 0) {
      await sql`delete from email_outbox where lower(recipient) = any(${emails.map((e) => e.toLowerCase())})`;
      await sql`delete from users where email = any(${emails})`; // login_links cascade
    }
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });
  beforeEach(() => {
    vi.stubEnv("EMAIL_OUTBOX_KEK", KEK);
    vi.stubEnv("RESEND_API_KEY", undefined);
    vi.stubEnv("OAUTH_BASE_URL", ORIGIN);
    vi.stubEnv("AUTH_DEV_LINKS", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ---- the request route ------------------------------------------------------------------------------------------

  it("the system address gets the ordinary 200 and nothing else: no token, no email row, no terms stamp", async () => {
    const before = { outbox: await outboxCount(QUICK_MATCH_SYSTEM_USER_EMAIL), row: await systemRow() };
    // Premise: the V492 seed. A stamp already there would hide B10; a link already there would hide the minter's refusal.
    expect(before.row, "premise: the system user is at its V492 seed").toEqual({ email_verified: false, terms_accepted_at: null, terms_version: null });
    expect(await linkCount(QUICK_MATCH_SYSTEM_USER_ID), "premise: the system user holds no sign-in link").toBe(0);

    const res = await post(QUICK_MATCH_SYSTEM_USER_EMAIL);

    expect(res.status).toBe(200);
    // Exactly the body an address held by a deleted account gets. Not even the dev link (this box would expose one: the
    // positive pair below receives it), so no token for the system user can have been minted.
    expect(res.json).toEqual({ ok: true, data: { message: MESSAGE } });
    expect(await linkCount(QUICK_MATCH_SYSTEM_USER_ID), "no login_links row").toBe(0);
    expect(await outboxCount(QUICK_MATCH_SYSTEM_USER_EMAIL), "no email row").toBe(before.outbox);
    const after = await systemRow();
    expect(after.terms_accepted_at, "B10: the system user is never stamped as having accepted the terms").toBeNull();
    expect(after.terms_version).toBeNull();
    expect(after.email_verified).toBe(false);
    // And no account was made for the address on the way (the soft-deleted branch, not the unknown-address one).
    const holders = await sql<{ id: string }[]>`select id from users where email = ${QUICK_MATCH_SYSTEM_USER_EMAIL}`;
    expect(holders.map((h) => h.id)).toEqual([QUICK_MATCH_SYSTEM_USER_ID]);
  });

  it("positive pair: an ordinary account gets its link, its email row and its terms stamp from the same route", async () => {
    const user = await ordinaryUser();

    const res = await post(user.email);

    expect(res.status).toBe(200);
    expect(res.json.data?.login_url, "the dev link a non-production box exposes").toMatch(new RegExp(`^${ORIGIN}/magic-link\\?token=`));
    expect(await linkCount(user.id)).toBe(1);
    expect(await outboxCount(user.email)).toBe(1);
    const [stamp] = await sql<{ terms_accepted_at: Date | null }[]>`select terms_accepted_at from users where id = ${user.id}`;
    expect(stamp!.terms_accepted_at).not.toBeNull();
  });

  // ---- the minter -------------------------------------------------------------------------------------------------

  it("issueLoginLink refuses the system user with a 403 and writes no login_links row", async () => {
    const err = await issueLoginLink(QUICK_MATCH_SYSTEM_USER_ID, sql).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect([(err as HttpError).status, (err as HttpError).message]).toEqual([403, "system user"]);
    expect(await linkCount(QUICK_MATCH_SYSTEM_USER_ID)).toBe(0);
  });

  it("issueLoginLink refuses it inside the caller's transaction too (the route's shape), and the transaction writes nothing", async () => {
    const err = await sql.begin((tx) => issueLoginLink(QUICK_MATCH_SYSTEM_USER_ID, tx)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect(await linkCount(QUICK_MATCH_SYSTEM_USER_ID)).toBe(0);
  });

  it("createLoginLink refuses the system user with a 403 and writes no login_links row", async () => {
    const err = await createLoginLink(QUICK_MATCH_SYSTEM_USER_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect([(err as HttpError).status, (err as HttpError).message]).toEqual([403, "system user"]);
    expect(await linkCount(QUICK_MATCH_SYSTEM_USER_ID)).toBe(0);
  });

  it("positive pair: issueLoginLink and createLoginLink still mint for an ordinary account", async () => {
    const user = await ordinaryUser();
    const issued = await issueLoginLink(user.id, sql);
    expect(issued.token.length).toBeGreaterThan(20);
    const token = await createLoginLink(user.id);
    expect(token).not.toBe(issued.token);
    // One live link per user: the second replaced the first.
    const rows = await sql<{ token: string }[]>`select token from login_links where user_id = ${user.id}`;
    expect(rows.map((r) => r.token)).toEqual([token]);
  });
});
