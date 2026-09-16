// Lichess account linking: OAuth authorization-code + PKCE (S256), public
// client (no client_secret ever leaves lib/oauth.ts's config check). The
// callback reads /api/account, revokes the token in a `finally` (so a revoke
// happens even when the account read itself fails), stores identity only —
// never the token — and returns the caller to a re-validated `next`.
//
// next/headers is mocked with a real Map-backed jar (not the repo's usual
// no-op `{ get: () => undefined, set: () => {}, delete: () => {} }` stub —
// no existing test in this repo round-trips cookies SET during the request,
// and this suite needs to read back what the route wrote) so the start
// route's cookie writes are visible to the callback route's reads within one
// test, exactly like a browser carrying cookies between the two hops.
import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieJar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
    set: (name: string, value: string) => {
      cookieJar.set(name, value);
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
  }),
  headers: async () => new Headers(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    // safeNextPath is left as the REAL implementation (spread from `actual`)
    // — this suite proves the route reuses it, not a re-implementation.
    requireUser: async () => ({ id: "u1" }),
  };
});

const upsertLichessLink = vi.hoisted(() => vi.fn());
vi.mock("@/server/usecases/external-accounts", () => ({ upsertLichessLink }));

import { HttpError } from "@/lib/errors";
import { pkceChallenge } from "@/server/external-play/pkce";
import { GET } from "../route";
import { GET as CALLBACK } from "../callback/route";

const STATE_COOKIE = "seazn_lichess_oauth_state";
const VERIFIER_COOKIE = "seazn_lichess_oauth_verifier";
const NEXT_COOKIE = "seazn_lichess_oauth_next";

/** redirectLocal() emits a RELATIVE Location header on purpose (lib/http.ts —
 *  no origin to get wrong behind a proxy), so it needs a base to parse; the
 *  house pattern for this is `new URL(loc, "http://t")` — see
 *  app/refer/[code]/__tests__/route.test.ts. */
const path = (location: string) => new URL(location, "http://t");

beforeEach(() => {
  cookieJar.clear();
  upsertLichessLink.mockClear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubEnv("LICHESS_CLIENT_ID", "seazn-test");
});

describe("GET /api/auth/lichess — start", () => {
  it("redirects with code_challenge S256 and stores verifier + state + next cookies", async () => {
    const res = await GET(
      new Request("http://localhost/api/auth/lichess?next=/shared/o/c/d/fixtures/f1/play"),
    );
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://lichess.org/oauth");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toBe(pkceChallenge(cookieJar.get(VERIFIER_COOKIE)!));
    expect(loc.searchParams.has("client_secret")).toBe(false);
    expect(cookieJar.get(NEXT_COOKIE)).toBe("/shared/o/c/d/fixtures/f1/play");
  });

  it("omits scope — the token is only ever used to read /api/account", async () => {
    const res = await GET(new Request("http://localhost/api/auth/lichess"));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.has("scope")).toBe(false);
  });

  it("refuses a protocol-relative next", async () => {
    await GET(new Request("http://localhost/api/auth/lichess?next=//evil.example"));
    expect(cookieJar.has(NEXT_COOKIE)).toBe(false);
  });
});

describe("GET /api/auth/lichess/callback", () => {
  it("sends code_verifier (no secret), reads account, revokes, stores identity only, returns to next", async () => {
    cookieJar.set(STATE_COOKIE, "st");
    cookieJar.set(VERIFIER_COOKIE, "ver");
    cookieJar.set(NEXT_COOKIE, "/shared/o/c/d/fixtures/f1/play");
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push([url, init]);
        if (url.endsWith("/api/token") && init.method === "POST") return Response.json({ access_token: "tok" });
        if (url.endsWith("/api/account")) return Response.json({ id: "alice", username: "Alice" });
        if (url.endsWith("/api/token") && init.method === "DELETE") return new Response(null, { status: 204 });
        return new Response(null, { status: 500 });
      }),
    );

    const res = await CALLBACK(new Request("http://localhost/api/auth/lichess/callback?code=c&state=st"));

    const tokenBody = new URLSearchParams(String(calls[0][1].body));
    expect(tokenBody.get("code_verifier")).toBe("ver");
    expect(tokenBody.has("client_secret")).toBe(false);
    expect(calls.some(([u, i]) => u.endsWith("/api/token") && i.method === "DELETE")).toBe(true);
    expect(upsertLichessLink).toHaveBeenCalledWith("u1", { externalUserId: "alice", username: "Alice" });
    expect(path(res.headers.get("location")!).pathname).toBe("/shared/o/c/d/fixtures/f1/play");
    // The verifier/state/next cookies are single-use.
    expect(cookieJar.has(STATE_COOKIE)).toBe(false);
    expect(cookieJar.has(VERIFIER_COOKIE)).toBe(false);
    expect(cookieJar.has(NEXT_COOKIE)).toBe(false);
  });

  it("revokes even when the account read fails, and never links", async () => {
    cookieJar.set(STATE_COOKIE, "st");
    cookieJar.set(VERIFIER_COOKIE, "ver");
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push([url, init]);
        if (url.endsWith("/api/token") && init.method === "POST") return Response.json({ access_token: "tok" });
        if (url.endsWith("/api/account")) return new Response(null, { status: 500 });
        if (url.endsWith("/api/token") && init.method === "DELETE") return new Response(null, { status: 204 });
        return new Response(null, { status: 500 });
      }),
    );

    const res = await CALLBACK(new Request("http://localhost/api/auth/lichess/callback?code=c&state=st"));

    expect(calls.some(([u, i]) => u.endsWith("/api/token") && i.method === "DELETE")).toBe(true);
    expect(upsertLichessLink).not.toHaveBeenCalled();
    const loc = path(res.headers.get("location")!);
    expect(loc.pathname).toBe("/me");
    expect(loc.searchParams.get("lichess")).toBe("account");
  });

  it("refuses when the verifier cookie is missing, before any network call", async () => {
    cookieJar.set(STATE_COOKIE, "st");
    // No verifier cookie set.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await CALLBACK(new Request("http://localhost/api/auth/lichess/callback?code=c&state=st"));

    expect(fetchSpy).not.toHaveBeenCalled();
    const loc = path(res.headers.get("location")!);
    expect(loc.pathname).toBe("/me");
    expect(loc.searchParams.get("lichess")).toBe("oauth_state");
  });

  // Fix round 1 (review, minor #1): the CSRF-relevant half of the guard —
  // cookie state present but not equal to the query state — was reachable
  // only through the combined boolean; nothing pinned it in isolation.
  it("refuses on state mismatch, before any network call", async () => {
    cookieJar.set(STATE_COOKIE, "st");
    cookieJar.set(VERIFIER_COOKIE, "ver");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await CALLBACK(
      new Request("http://localhost/api/auth/lichess/callback?code=c&state=other"),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    const loc = path(res.headers.get("location")!);
    expect(loc.pathname).toBe("/me");
    expect(loc.searchParams.get("lichess")).toBe("oauth_state");
  });

  // Fix round 1 (review, minor #2): a THROWN fetch (network error / abort
  // timeout) is a different failure mode than a non-ok response and used to
  // reach neither `fail(...)` branch — it propagated as a raw 500.
  it("token fetch throwing (timeout) redirects lichess=token, and never calls /api/account", async () => {
    cookieJar.set(STATE_COOKIE, "st");
    cookieJar.set(VERIFIER_COOKIE, "ver");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(url);
        if (url.endsWith("/api/token") && init.method === "POST") {
          throw new DOMException("The operation timed out.", "TimeoutError");
        }
        return new Response(null, { status: 500 });
      }),
    );

    const res = await CALLBACK(new Request("http://localhost/api/auth/lichess/callback?code=c&state=st"));

    expect(calls.some((u) => u.endsWith("/api/account"))).toBe(false);
    const loc = path(res.headers.get("location")!);
    expect(loc.pathname).toBe("/me");
    expect(loc.searchParams.get("lichess")).toBe("token");
  });

  it("account fetch throwing (network error) still revokes and redirects lichess=account", async () => {
    cookieJar.set(STATE_COOKIE, "st");
    cookieJar.set(VERIFIER_COOKIE, "ver");
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push([url, init]);
        if (url.endsWith("/api/token") && init.method === "POST") return Response.json({ access_token: "tok" });
        if (url.endsWith("/api/account")) throw new TypeError("fetch failed");
        if (url.endsWith("/api/token") && init.method === "DELETE") return new Response(null, { status: 204 });
        return new Response(null, { status: 500 });
      }),
    );

    const res = await CALLBACK(new Request("http://localhost/api/auth/lichess/callback?code=c&state=st"));

    expect(calls.some(([u, i]) => u.endsWith("/api/token") && i.method === "DELETE")).toBe(true);
    expect(upsertLichessLink).not.toHaveBeenCalled();
    const loc = path(res.headers.get("location")!);
    expect(loc.pathname).toBe("/me");
    expect(loc.searchParams.get("lichess")).toBe("account");
  });

  // Fix round 1 (review, Important): V405's second unique constraint —
  // never let a second user steal an already-linked Lichess account.
  it("already_linked when upsert rejects with the collision code, and still revokes", async () => {
    cookieJar.set(STATE_COOKIE, "st");
    cookieJar.set(VERIFIER_COOKIE, "ver");
    upsertLichessLink.mockRejectedValueOnce(
      new HttpError(409, "That Lichess account is already linked to a different Seazn account.", "LICHESS_ALREADY_LINKED"),
    );
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push([url, init]);
        if (url.endsWith("/api/token") && init.method === "POST") return Response.json({ access_token: "tok" });
        if (url.endsWith("/api/account")) return Response.json({ id: "alice", username: "Alice" });
        if (url.endsWith("/api/token") && init.method === "DELETE") return new Response(null, { status: 204 });
        return new Response(null, { status: 500 });
      }),
    );

    const res = await CALLBACK(new Request("http://localhost/api/auth/lichess/callback?code=c&state=st"));

    expect(calls.some(([u, i]) => u.endsWith("/api/token") && i.method === "DELETE")).toBe(true);
    const loc = path(res.headers.get("location")!);
    expect(loc.pathname).toBe("/me");
    expect(loc.searchParams.get("lichess")).toBe("already_linked");
  });
});
