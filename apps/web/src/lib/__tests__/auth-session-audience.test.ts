// Review I2: the session cookie and the relay page token are signed with the
// SAME key (AUTH_SECRET), and `getCurrentUser` used to call jwtVerify with NO
// options — no audience, no algorithm list. So the session verifier ACCEPTED a
// relay page token. Nothing escalated only because a relay token carries no
// `uid` (String(undefined) → "undefined", and the lookup finds nobody), which
// is one added claim away from a real escalation, and the same hole admitted
// every other AUTH_SECRET-signed token in the repo.
//
// The relay token here is minted by the REAL mintRelayToken, not a hand-rolled
// fixture: a fixture on both ends would only prove the fixture.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";

const AUTH = "auth-secret-for-session-audience-test-0123456789-0123456789-0123";
const USER = { id: "11111111-2222-4333-8444-999999999999", display_name: "Ada", email: "ada@example.com" };

// `vi.mock` factories are hoisted above module consts, so the jar and the query
// log have to come through `vi.hoisted` or the factory reads them uninitialised.
const h = vi.hoisted(() => ({ jar: new Map<string, string>(), sqlCalls: [] as unknown[][] }));

// The cookie jar `next/headers` hands the module, backed by a Map so the REAL
// createSession writes into it and the REAL getCurrentUser reads it back.
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
      set: (name: string, value: string) => void h.jar.set(name, value),
      delete: (name: string) => void h.jar.delete(name),
    }),
}));

// Only the users lookup matters here; return the row iff the id matches. Every
// call is LOGGED, because "getCurrentUser returned null" is true for two very
// different reasons — the verifier refused the token, or the verifier accepted
// it and the row lookup missed — and only the first is what this file claims.
vi.mock("@/lib/db", () => ({
  sql: (_s: TemplateStringsArray, ...values: unknown[]) => {
    h.sqlCalls.push(values);
    return Promise.resolve(values[0] === USER.id ? [USER] : []);
  },
  withTenant: vi.fn(),
}));

// Cache OFF, or a hit would answer before the verifier is even consulted and
// every assertion below would be about the cache.
vi.mock("@/lib/cache", () => ({
  cacheGet: () => Promise.resolve(null),
  cacheSet: () => Promise.resolve(),
  cacheDel: () => Promise.resolve(),
  cacheDelPattern: () => Promise.resolve(),
  cacheEnabled: () => false,
}));

const { createSession, getCurrentUser } = await import("../auth");
const { mintRelayToken } = await import("@/server/relay/tokens");

const saved = process.env.AUTH_SECRET;
beforeAll(() => {
  process.env.AUTH_SECRET = AUTH;
});
afterAll(() => {
  // `= undefined` would store the STRING "undefined".
  if (saved === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = saved;
});
beforeEach(() => {
  h.jar.clear();
  h.sqlCalls.length = 0;
});

const asCookie = (token: string) => void h.jar.set("seazn_session", token);
const key = () => new TextEncoder().encode(AUTH);

describe("the session cookie pins an audience (review I2)", () => {
  it("a relay PAGE token is refused by getCurrentUser — the finding", async () => {
    const relay = await mintRelayToken({
      sid: "55555555-2222-4333-8444-555555555555",
      scope: "relay-page",
      expiresAt: new Date(Date.now() + 600_000),
    });
    asCookie(relay);
    expect(await getCurrentUser()).toBeNull();
    // …and refused BY THE VERIFIER, which is the claim. `toBeNull()` alone is
    // satisfied for a second, accidental reason: a relay token carries no
    // `uid`, so even when the verifier ACCEPTS it, `String(payload.uid)` is
    // "undefined" and the row lookup misses. Asserting only null passes with
    // the audience pin deleted — measured, it did. The witness is that the
    // users query is never reached at all.
    expect(h.sqlCalls, "the verifier must refuse before any user lookup").toHaveLength(0);

    // The job token is the same key and the same seam — pin both directions of
    // the scope so neither becomes a session either.
    asCookie(
      await mintRelayToken({
        sid: "55555555-2222-4333-8444-555555555555",
        scope: "relay-job",
        expiresAt: new Date(Date.now() + 600_000),
      }),
    );
    expect(await getCurrentUser()).toBeNull();
    expect(h.sqlCalls).toHaveLength(0);
  });

  it("the ESCALATION shape — our own secret, a uid, and the relay audience — is refused", async () => {
    // What the finding is one claim away from. If the audience were unpinned
    // this token would verify, `uid` would resolve to a real person, and an
    // anonymous viewer would be signed in as them.
    const escalation = await new SignJWT({ uid: USER.id, sid: "55555555-2222-4333-8444-555555555555", scope: "relay-page" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .setAudience("seazn-relay")
      .sign(key());
    asCookie(escalation);
    expect(await getCurrentUser()).toBeNull();
    expect(h.sqlCalls, "no lookup — the token never got past the verifier").toHaveLength(0);
  });

  it("its positive pair: a cookie from the REAL createSession still signs the user in", async () => {
    await createSession(USER.id);
    expect(h.jar.get("seazn_session"), "createSession must have written the cookie").toBeTruthy();
    expect(await getCurrentUser()).toMatchObject({ id: USER.id, email: USER.email });
    // The mirror of the negatives above: here the lookup IS reached, so those
    // zero-call assertions are measuring something that can be non-zero.
    expect(h.sqlCalls).toHaveLength(1);
  });

  it("an HS512 token carrying a VALID session shape, signed with our own secret, is refused", async () => {
    const shape = { uid: USER.id };
    const hs512 = await new SignJWT(shape)
      .setProtectedHeader({ alg: "HS512" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .setAudience("seazn-session")
      .sign(key());
    asCookie(hs512);
    expect(await getCurrentUser()).toBeNull();

    // Positive pair: byte-for-byte the same claims under HS256 DO sign in, so
    // the refusal above is about the algorithm and not about the claims.
    const hs256 = await new SignJWT(shape)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .setAudience("seazn-session")
      .sign(key());
    asCookie(hs256);
    expect(await getCurrentUser()).toMatchObject({ id: USER.id });
  });

  it("a token with NO audience is refused — this is the INTENDED breaking change", async () => {
    // Every cookie issued before this deploy has exactly this shape: correct
    // secret, correct claims, no `aud`. They all stop verifying, everyone is
    // logged out once, and the owner accepted that on 2026-09-20. If this test
    // is ever seen failing, the fix is NOT to relax the audience pin.
    const legacy = await new SignJWT({ uid: USER.id })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(key());
    asCookie(legacy);
    expect(await getCurrentUser()).toBeNull();

    // …and a token bearing somebody ELSE's audience is refused too, which is
    // what stops the check-in QR token from being a session.
    const otherAudience = await new SignJWT({ uid: USER.id })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .setAudience("seazn-relay")
      .sign(key());
    asCookie(otherAudience);
    expect(await getCurrentUser()).toBeNull();
  });

  it("a non-string `uid` is refused — never String()'d into a lookup key", async () => {
    // Correct secret, correct audience, correct algorithm: only the claim's
    // TYPE is wrong. Without the guard each of these is stringified into a user
    // id — `{}` becomes "[object Object]" — and queried. It only MISSES today,
    // which is exactly what "harmless" looked like for the relay token before
    // a `uid` was imagined onto it.
    for (const uid of [{}, 42, null, ["x"], true, { id: USER.id }] as unknown[]) {
      h.sqlCalls.length = 0;
      asCookie(
        await new SignJWT({ uid })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuedAt()
          .setExpirationTime("30d")
          .setAudience("seazn-session")
          .sign(key()),
      );
      expect(await getCurrentUser(), `uid ${JSON.stringify(uid)}`).toBeNull();
      expect(h.sqlCalls, `uid ${JSON.stringify(uid)} must never reach the query`).toHaveLength(0);
    }

    // The empty string is the boundary: present, a string, and still nobody.
    h.sqlCalls.length = 0;
    asCookie(
      await new SignJWT({ uid: "" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("30d")
        .setAudience("seazn-session")
        .sign(key()),
    );
    expect(await getCurrentUser()).toBeNull();
    expect(h.sqlCalls).toHaveLength(0);

    // Positive pair: a real string uid DOES reach the query and sign in, so the
    // zero-call assertions above are measuring something that can be non-zero.
    h.sqlCalls.length = 0;
    asCookie(
      await new SignJWT({ uid: USER.id })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("30d")
        .setAudience("seazn-session")
        .sign(key()),
    );
    expect(await getCurrentUser()).toMatchObject({ id: USER.id });
    expect(h.sqlCalls).toHaveLength(1);
  });

  it("no cookie at all → null (the empty case)", async () => {
    expect(await getCurrentUser()).toBeNull();
  });
});
