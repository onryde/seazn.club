// GET /api/auth/google/callback — Google sign-in must refuse an address Google
// itself has not verified (owner-approved security fix, 2026-10-19).
//
// The defect. The callback matched an existing Seazn account by the email on
// Google's userinfo response, wrote `google_sub` onto it and set
// `email_verified = true`, without ever reading the response's own
// `email_verified` claim. A Google account can carry an address Google never
// confirmed, so anyone able to register a Google account with a victim's
// address was signed into the victim's Seazn account.
//
// Driven through the REAL callback route, the REAL decode of the userinfo body,
// the REAL session minting and the REAL database. The only stand-ins are
// Google's two HTTP endpoints (`fetch`) and `next/headers` (a Map-backed jar,
// so the cookies the route SETS can be read back — the assertion "no session"
// is "nothing was written to the jar", not "a spy was not called").
//
// Every refusal is judged on four things at once, because any one of them alone
// passes on a half-fix: the redirect (login + the flash code), the jar (no
// session cookie), the users table (no new row, nothing written onto an
// existing one) and that the person is not carried on to an authenticated page.
//
// Sport: not applicable. Sign-in is sport-agnostic; there is no sport input.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.30" }),
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
}));

import { sql } from "@/lib/db";
import { warmDefaultLanding } from "../../__tests__/_verify-link";
import { GET } from "../callback/route";
import {
  NEXT_COOKIE,
  NOT_VERIFIED,
  SESSION_COOKIE,
  callbackRequest,
  claimsFor,
  locationOf,
  plantState,
  stubGoogle,
  type Claims,
} from "./_google-callback";

const HAS_DB = !!process.env.DATABASE_URL;

const made: string[] = [];
const madeSubs: string[] = [];
const madeEmails: string[] = [];

interface Row {
  id: string;
  email: string;
  email_verified: boolean;
  google_sub: string | null;
  display_name: string;
  avatar_url: string | null;
}

const fresh = () => ({
  sub: `g-sub-${randomUUID()}`,
  email: `google-verified-${randomUUID()}@example.test`,
});

async function insertUser(o: {
  email: string;
  emailVerified: boolean;
  googleSub?: string | null;
  displayName?: string;
  avatar?: string | null;
}): Promise<Row> {
  const [u] = await sql<Row[]>`
    insert into users (email, display_name, email_verified, google_sub, avatar_url)
    values (${o.email}, ${o.displayName ?? "Existing Person"}, ${o.emailVerified},
            ${o.googleSub ?? null}, ${o.avatar ?? null})
    returning id, email, email_verified, google_sub, display_name, avatar_url`;
  made.push(u.id);
  return u;
}

const byId = async (id: string): Promise<Row> =>
  (await sql<Row[]>`
    select id, email, email_verified, google_sub, display_name, avatar_url from users where id = ${id}`)[0]!;

/** Every users row this Google identity could have produced or touched. */
async function rowsFor(sub: string, email: string): Promise<Row[]> {
  return sql<Row[]>`
    select id, email, email_verified, google_sub, display_name, avatar_url
      from users where google_sub = ${sub} or email = ${email}`;
}

/** Run the callback as the browser would after Google's redirect. */
async function signIn(claims: Claims): Promise<Response> {
  jar.values.clear();
  plantState(jar.values);
  stubGoogle(claims);
  const res = await GET(callbackRequest());
  // Track anything the callback created so afterAll can remove it.
  const sub = typeof claims.sub === "string" ? claims.sub : null;
  if (sub) {
    madeSubs.push(sub);
    if (typeof claims.email === "string") madeEmails.push(claims.email);
  }
  return res;
}

/** The refusal contract, asserted in one place so no case can forget a leg. */
function expectRefusedWithFlash(res: Response) {
  const loc = locationOf(res);
  expect(res.status).toBe(307);
  expect(loc.pathname).toBe("/login");
  expect(loc.searchParams.get("google")).toBe("email_unverified");
  // Nothing was written to the cookie jar: no session, no signed-in hint, no
  // active-org cookie, and the one-shot state/next cookies were consumed.
  expect([...jar.values.keys()]).toEqual([]);
}

beforeAll(async () => {
  if (HAS_DB) await warmDefaultLanding();
});

beforeEach(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-id.apps.googleusercontent.test");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
  jar.values.clear();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (!HAS_DB) return;
  const created = await sql<{ id: string }[]>`
    select id from users where google_sub = any(${madeSubs}::text[]) or email = any(${madeEmails}::text[])`;
  const ids = [...new Set([...made, ...created.map((r) => r.id)])];
  if (ids.length === 0) return;
  await sql`delete from organizations where created_by = any(${ids})`;
  await sql`delete from subscriptions where owner_user_id = any(${ids})`;
  await sql`delete from users where id = any(${ids})`;
});

describe.skipIf(!HAS_DB)("GET /api/auth/google/callback — a verified Google address signs in", () => {
  it("creates a new account, verified, linked to the sub, with a session", async () => {
    const { sub, email } = fresh();
    expect(await rowsFor(sub, email)).toHaveLength(0);

    const res = await signIn(claimsFor(sub, email));

    expect(res.status).toBe(307);
    expect(locationOf(res).pathname).not.toBe("/login");
    expect(jar.values.has(SESSION_COOKIE), "the verified sign-in set a session").toBe(true);
    const rows = await rowsFor(sub, email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email, google_sub: sub, email_verified: true });
  });

  it("signs an existing account in by email, links the sub and marks the email verified", async () => {
    const { sub, email } = fresh();
    // The account a magic-link request leaves behind: inert, never verified.
    const existing = await insertUser({ email, emailVerified: false });

    const res = await signIn(claimsFor(sub, email));

    expect(locationOf(res).pathname).not.toBe("/login");
    expect(jar.values.has(SESSION_COOKIE)).toBe(true);
    const after = await byId(existing.id);
    expect(after.google_sub).toBe(sub);
    expect(after.email_verified).toBe(true);
    expect(await rowsFor(sub, email), "linked, not duplicated").toHaveLength(1);
  });

  it("signs a linked account in by google_sub", async () => {
    const { sub, email } = fresh();
    const linked = await insertUser({ email, emailVerified: true, googleSub: sub });

    const res = await signIn(claimsFor(sub, email));

    expect(locationOf(res).pathname).not.toBe("/login");
    expect(jar.values.has(SESSION_COOKIE)).toBe(true);
    expect((await rowsFor(sub, email)).map((r) => r.id)).toEqual([linked.id]);
  });
});

describe.skipIf(!HAS_DB)("GET /api/auth/google/callback — an unverified Google address is refused", () => {
  // Anti-vacuity: the table is the cases. Zero rows would make every loop below
  // a pass over nothing.
  it("the not-verified table is non-empty and holds neither `true` nor a boolean true", () => {
    expect(NOT_VERIFIED.length).toBeGreaterThanOrEqual(9);
    for (const v of NOT_VERIFIED) {
      expect(v.apply(claimsFor("s", "a@b.test")).email_verified, v.label).not.toBe(true);
    }
  });

  it("an address that matches an existing account: no session, no google_sub, no verification written", async () => {
    let checked = 0;
    for (const v of NOT_VERIFIED) {
      const { sub, email } = fresh();
      // Unverified inert account: the attack target. Prior values are chosen so
      // a write of ANY of the three columns the attach path touches is visible.
      const victim = await insertUser({ email, emailVerified: false, avatar: null });

      const res = await signIn(v.apply(claimsFor(sub, email)));

      expectRefusedWithFlash(res);
      const after = await byId(victim.id);
      expect(after.google_sub, `${v.label}: google_sub written`).toBeNull();
      expect(after.email_verified, `${v.label}: email_verified flipped`).toBe(false);
      expect(after.avatar_url, `${v.label}: avatar written`).toBeNull();
      expect(await rowsFor(sub, email), `${v.label}: a second row appeared`).toHaveLength(1);
      checked++;
    }
    expect(checked).toBe(NOT_VERIFIED.length);
  });

  it("an address nobody has used: no account is created", async () => {
    let checked = 0;
    for (const v of NOT_VERIFIED) {
      const { sub, email } = fresh();

      const res = await signIn(v.apply(claimsFor(sub, email)));

      expectRefusedWithFlash(res);
      expect(await rowsFor(sub, email), `${v.label}: a user row was created`).toHaveLength(0);
      checked++;
    }
    expect(checked).toBe(NOT_VERIFIED.length);
  });

  it("a response with no email at all is refused the same way, even marked verified", async () => {
    const { sub } = fresh();

    const res = await signIn(claimsFor(sub, null));

    expectRefusedWithFlash(res);
    expect(await sql`select 1 from users where google_sub = ${sub}`).toHaveLength(0);
  });

  it("an already-linked account whose Google email is now unverified is refused, and nothing on it is refreshed", async () => {
    let checked = 0;
    for (const v of NOT_VERIFIED) {
      const { sub, email } = fresh();
      const linked = await insertUser({
        email,
        emailVerified: true,
        googleSub: sub,
        displayName: "Before",
        avatar: "https://example.test/before.png",
      });

      // A claim set that WOULD refresh the display name and avatar on the
      // sign-in path, so a write on the refused path is visible.
      const res = await signIn(v.apply(claimsFor(sub, email, { name: "After", picture: "https://example.test/after.png" })));

      expectRefusedWithFlash(res);
      const after = await byId(linked.id);
      expect(after, `${v.label}: the linked row was touched`).toEqual(linked);
      checked++;
    }
    expect(checked).toBe(NOT_VERIFIED.length);
  });

  it("an already-linked account whose Google response lost its email is refused", async () => {
    const { sub, email } = fresh();
    const linked = await insertUser({ email, emailVerified: true, googleSub: sub });

    const res = await signIn(claimsFor(sub, null));

    expectRefusedWithFlash(res);
    expect(await byId(linked.id)).toEqual(linked);
  });

  it("the sub is matched BEFORE the email: a linked account is not re-pointed at a different Seazn account that owns the Google email", async () => {
    // Account A is linked to the sub. Account B owns the address Google now
    // reports (A's owner changed their Google address to B's, and Google has
    // verified it). Sub-first signs A in and links nothing onto B; email-first
    // would sign B in and steal the sub from A (google_sub is unique: it would
    // be an error or a re-point, both wrong).
    const sub = `g-sub-${randomUUID()}`;
    const a = await insertUser({ email: `a-${randomUUID()}@example.test`, emailVerified: true, googleSub: sub });
    const b = await insertUser({ email: `b-${randomUUID()}@example.test`, emailVerified: false });
    madeSubs.push(sub);

    const res = await signIn(claimsFor(sub, b.email));

    expect(locationOf(res).pathname).not.toBe("/login");
    expect(jar.values.has(SESSION_COOKIE)).toBe(true);
    expect((await byId(a.id)).google_sub).toBe(sub);
    expect(await byId(b.id), "B was neither linked nor verified").toEqual(b);
  });

  it("the sequence: a refusal does not poison the next attempt, and a retry that IS verified signs in", async () => {
    const { sub, email } = fresh();
    const victim = await insertUser({ email, emailVerified: false });

    expectRefusedWithFlash(await signIn(NOT_VERIFIED[0]!.apply(claimsFor(sub, email))));
    expect((await byId(victim.id)).google_sub).toBeNull();

    const res = await signIn(claimsFor(sub, email));
    expect(locationOf(res).pathname).not.toBe("/login");
    expect(jar.values.has(SESSION_COOKIE)).toBe(true);
    expect((await byId(victim.id)).google_sub).toBe(sub);
  });

  it("an invite destination survives the refusal: next rides to /login (re-validated), and the cookie is cleared", async () => {
    const { sub, email } = fresh();
    jar.values.clear();
    plantState(jar.values);
    jar.values.set(NEXT_COOKIE, "/invite/abc123");
    stubGoogle(NOT_VERIFIED[0]!.apply(claimsFor(sub, email)));

    const res = await GET(callbackRequest());

    const loc = locationOf(res);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("google")).toBe("email_unverified");
    expect(loc.searchParams.get("next")).toBe("/invite/abc123");
    expect([...jar.values.keys()]).toEqual([]);
  });

  it("a hostile next is dropped, not carried: only a same-site path rides to /login", async () => {
    let checked = 0;
    for (const hostile of ["//evil.example/x", "https://evil.example/x", "/a\\b", "javascript:alert(1)"]) {
      const { sub, email } = fresh();
      jar.values.clear();
      plantState(jar.values);
      jar.values.set(NEXT_COOKIE, hostile);
      stubGoogle(NOT_VERIFIED[0]!.apply(claimsFor(sub, email)));

      const loc = locationOf(await GET(callbackRequest()));

      expect(loc.pathname, hostile).toBe("/login");
      expect(loc.searchParams.has("next"), `${hostile} was carried`).toBe(false);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("a malformed response (no sub) keeps its existing refusal: error=oauth_userinfo, not the verified flash", async () => {
    const { email } = fresh();

    jar.values.clear();
    plantState(jar.values);
    stubGoogle({ email, email_verified: true });
    const res = await GET(callbackRequest());

    const loc = locationOf(res);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("error")).toBe("oauth_userinfo");
    expect(loc.searchParams.has("google")).toBe(false);
    expect([...jar.values.keys()]).toEqual([]);
  });
});
