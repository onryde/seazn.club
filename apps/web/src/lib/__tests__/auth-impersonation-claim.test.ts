// Quick match plan 3, Task 5 (ledger carry m5): an impersonated session is now something the SERVER can tell apart.
//
// Before this, app/admin/impersonate signed the target user in with an ordinary session and set only the readable
// `seazn_no_analytics` cookie, which any page script can set or clear, so no server action could refuse what staff must
// never do as the user (quick match Save is the first such action: app/q/[token]/save/confirm/route.ts). Now
// `createSession(userId, { impersonatedBy })` signs the staff member into the cookie as the `imp` claim, and
// `getCurrentSession()` reads the user and the flag from ONE verify of the cookie (review m6: the route read them with two).
//
// The states, and each refusal the helpers carry as a guard:
//   - no cookie: no session (so no impersonation);
//   - the user's own session (every sign-in door): not one; staff's: is one, and it is still the TARGET's session;
//   - an `imp` of ANY value counts (fail closed): a malformed claim never reads as the user's own session;
//   - a token not signed by this app (another key) is no session at all;
//   - an empty `impersonatedBy` is refused before any cookie is written (an `imp` nobody can trace).
// The tokens are signed by the REAL createSession on a Map-backed jar; the one hand-signed token (the malformed claim) uses
// the session's own audience and algorithm, read from a real session's header and payload, never typed.
//
// No database: the user lookup is a stand-in that answers the one id (as auth-session-audience.test.ts does).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, decodeJwt, decodeProtectedHeader } from "jose";

// Every verify the auth module makes, counted: the session's two facts must come from one.
const verifies = vi.hoisted(() => ({ count: 0 }));
vi.mock("jose", async (orig) => {
  const real = await orig<typeof import("jose")>();
  return {
    ...real,
    jwtVerify: (async (...args: Parameters<typeof real.jwtVerify>) => {
      verifies.count++;
      return real.jwtVerify(...args);
    }) as typeof real.jwtVerify,
  };
});

const AUTH = "auth-secret-for-impersonation-claim-test-0123456789-0123456789-01";
const USER = { id: "22222222-3333-4444-8555-666666666666", display_name: "Bea", email: "bea@example.com" };
const STAFF = "33333333-4444-4555-8666-777777777777";
const COOKIE = "seazn_session";

const h = vi.hoisted(() => ({ jar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
      set: (name: string, value: string) => void h.jar.set(name, value),
      delete: (name: string) => void h.jar.delete(name),
    }),
}));
vi.mock("@/lib/db", () => ({
  sql: (_s: TemplateStringsArray, ...values: unknown[]) => Promise.resolve(values[0] === USER.id ? [USER] : []),
  withTenant: vi.fn(),
}));
vi.mock("@/lib/cache", () => ({
  cacheGet: () => Promise.resolve(null),
  cacheSet: () => Promise.resolve(),
  cacheDel: () => Promise.resolve(),
  cacheDelPattern: () => Promise.resolve(),
  cacheEnabled: () => false,
}));

const { createSession, getCurrentSession, getCurrentUser } = await import("../auth");
/** The flag as the route reads it: null with no session. */
const impersonated = async () => (await getCurrentSession())?.impersonated ?? null;

const saved = process.env.AUTH_SECRET;
beforeAll(() => {
  process.env.AUTH_SECRET = AUTH;
});
afterAll(() => {
  if (saved === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = saved;
});
beforeEach(() => {
  h.jar.clear();
  verifies.count = 0;
});

/** A token with the real session's audience, algorithm and expiry, but these claims, signed with `secret`. */
async function signedLikeASession(claims: Record<string, unknown>, secret = AUTH): Promise<string> {
  await createSession(USER.id);
  const real = h.jar.get(COOKIE)!;
  const { alg } = decodeProtectedHeader(real);
  const { aud, exp } = decodeJwt(real);
  h.jar.clear();
  return new SignJWT(claims)
    .setProtectedHeader({ alg: alg! })
    .setIssuedAt()
    .setExpirationTime(exp!)
    .setAudience(aud as string)
    .sign(new TextEncoder().encode(secret));
}

describe("getCurrentSession: the user and whether staff is impersonating them", () => {
  it("no cookie: no session at all", async () => {
    expect(h.jar.size).toBe(0);
    expect(await getCurrentSession()).toBeNull();
  });

  it("review m6: the user and the flag come from ONE verify of the cookie", async () => {
    await createSession(USER.id, { impersonatedBy: STAFF });
    verifies.count = 0;
    const session = await getCurrentSession();
    expect([session?.user.id, session?.impersonated]).toEqual([USER.id, true]);
    expect(verifies.count, "one jwtVerify for both").toBe(1);
  });

  it("the user's own session is not one; staff's is, and it is still the target's session", async () => {
    await createSession(USER.id);
    expect(decodeJwt(h.jar.get(COOKIE)!).imp, "an ordinary session carries no imp").toBeUndefined();
    expect(await impersonated()).toBe(false);
    expect((await getCurrentUser())?.id).toBe(USER.id);

    h.jar.clear();
    await createSession(USER.id, { impersonatedBy: STAFF });
    expect(decodeJwt(h.jar.get(COOKIE)!).imp, "staff's id is signed in").toBe(STAFF);
    expect(await impersonated()).toBe(true);
    expect((await getCurrentSession())?.user.id, "the target is the signed-in user").toBe(USER.id);

    // A second session on the same jar, by the user's own door, replaces staff's: no longer an impersonation.
    await createSession(USER.id);
    expect(await impersonated()).toBe(false);
  });

  it("fails closed: an imp claim of any value counts, a session from another key counts as no session", async () => {
    let checked = 0;
    for (const imp of [123, "", null, { id: STAFF }, true]) {
      h.jar.set(COOKIE, await signedLikeASession({ uid: USER.id, imp }));
      expect(await impersonated(), JSON.stringify(imp)).toBe(true);
      checked++;
    }
    expect(checked).toBe(5);
    // The positive pair for the helper itself: the same hand-signed shape with no imp is the user's own session.
    h.jar.set(COOKIE, await signedLikeASession({ uid: USER.id }));
    expect(await impersonated()).toBe(false);
    expect((await getCurrentUser())?.id).toBe(USER.id);
    // Another key: no session at all.
    h.jar.set(COOKIE, await signedLikeASession({ uid: USER.id, imp: STAFF }, `${AUTH}-other`));
    expect(await getCurrentSession()).toBeNull();
    expect(await getCurrentUser()).toBeNull();
  });
});

describe("createSession({ impersonatedBy })", () => {
  it("refuses an empty actor before writing any cookie", async () => {
    await expect(createSession(USER.id, { impersonatedBy: "" })).rejects.toThrow(/impersonatedBy/);
    expect(h.jar.size, "no cookie written").toBe(0);
  });
});
