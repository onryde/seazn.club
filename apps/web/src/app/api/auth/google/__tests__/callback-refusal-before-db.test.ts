// GET /api/auth/google/callback — the unverified-email refusal happens BEFORE
// the database is touched, and this suite needs no database to prove it.
//
// `callback-email-verified.test.ts` proves the outcomes (no row, no google_sub,
// no session) against a real Postgres and is skipped without one. This file
// proves the ORDER, which is what makes those outcomes hold on every path at
// once — a new account, an email match and a google_sub match all sit behind
// the same gate — and it runs in a no-DB environment (`DATABASE_URL=`), where
// the DB-backed file contributes nothing.
//
// `@/lib/db`'s `sql` is replaced by a tag that records the call and throws a
// sentinel. A refusal must therefore (a) redirect to /login with the flash and
// (b) have made ZERO queries. The positive pair then proves the sentinel is
// reachable: a verified sign-in DOES query, and surfaces the sentinel. Without
// that pair "zero queries" could be a stub that is never consulted.
//
// Sport: not applicable. Sign-in is sport-agnostic; there is no sport input.
import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
}));

const db = vi.hoisted(() => ({ queries: [] as string[], SENTINEL: "DB_REACHED_BY_THE_CALLBACK" }));
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray) => {
    db.queries.push(strings.join("?").replace(/\s+/g, " ").trim());
    throw new Error(db.SENTINEL);
  },
}));

import { GET } from "../callback/route";
import {
  NEXT_COOKIE,
  NOT_VERIFIED,
  callbackRequest,
  claimsFor,
  locationOf,
  plantState,
  stubGoogle,
} from "./_google-callback";

beforeEach(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-id.apps.googleusercontent.test");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
  db.queries.length = 0;
  jar.values.clear();
  plantState(jar.values);
});

describe("GET /api/auth/google/callback — refusal precedes every query", () => {
  it("each not-verified shape redirects to /login with the flash and queries nothing", async () => {
    expect(NOT_VERIFIED.length).toBeGreaterThanOrEqual(9);
    let checked = 0;
    for (const v of NOT_VERIFIED) {
      db.queries.length = 0;
      jar.values.clear();
      plantState(jar.values);
      stubGoogle(v.apply(claimsFor("g-sub-1", "someone@example.test")));

      const res = await GET(callbackRequest());

      const loc = locationOf(res);
      expect(loc.pathname, v.label).toBe("/login");
      expect(loc.searchParams.get("google"), v.label).toBe("email_unverified");
      expect(db.queries, `${v.label}: the callback queried the database`).toEqual([]);
      expect([...jar.values.keys()], `${v.label}: a cookie was written`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(NOT_VERIFIED.length);
  });

  it("a response with no email is refused before any query, even marked verified", async () => {
    stubGoogle(claimsFor("g-sub-1", null));

    const res = await GET(callbackRequest());

    expect(locationOf(res).searchParams.get("google")).toBe("email_unverified");
    expect(db.queries).toEqual([]);
    expect([...jar.values.keys()]).toEqual([]);
  });

  it("the refusal carries a valid next to /login and clears the one-shot next cookie", async () => {
    jar.values.set(NEXT_COOKIE, "/invite/abc123");
    stubGoogle(NOT_VERIFIED[0]!.apply(claimsFor("g-sub-1", "someone@example.test")));

    const loc = locationOf(await GET(callbackRequest()));

    expect(loc.searchParams.get("next")).toBe("/invite/abc123");
    expect([...jar.values.keys()]).toEqual([]);
  });

  it("positive pair: a VERIFIED response does reach the database (so the zero above is not a dead stub)", async () => {
    stubGoogle(claimsFor("g-sub-1", "someone@example.test"));

    await expect(GET(callbackRequest())).rejects.toThrow(db.SENTINEL);

    expect(db.queries.length).toBeGreaterThan(0);
    expect(db.queries[0]).toContain("google_sub");
  });

  it("the other ways Google can fail keep their existing codes and never reach the database either", async () => {
    // No sub: a malformed userinfo body, not an unverified email.
    stubGoogle({ email: "someone@example.test", email_verified: true });
    const res = await GET(callbackRequest());
    expect(locationOf(res).searchParams.get("error")).toBe("oauth_userinfo");
    expect(locationOf(res).searchParams.has("google")).toBe(false);
    expect(db.queries).toEqual([]);
  });
});
