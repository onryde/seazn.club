// Lichess account linking: OAuth authorization-code + PKCE (S256), public
// client (no client_secret ever leaves lib/oauth.ts's config check). The
// callback reads /api/account, KEEPS the token (chess design §3.1 — our
// server submits this player's moves with it) and returns the caller to a
// re-validated `next`. The revoke now fires only on the paths that do NOT
// end in a stored link: an unusable grant must not be left live, and a
// usable one must not be thrown away.
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

const requireUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    // safeNextPath is left as the REAL implementation (spread from `actual`)
    // — this suite proves the route reuses it, not a re-implementation.
    requireUser,
  };
});

// T20: the start names the club (`?org=<slug>`) and asks the online-chess flag for it. The slug lookup needs a
// database, so it is doubled; the flag is asked through the REAL helper, with PostHog doubled at its boundary.
const CLUB = { id: "org-1", name: "Club", slug: "club" };
const orgBySlug = vi.hoisted(() => vi.fn());
vi.mock("@/server/slug-resolve", () => ({ orgBySlug }));
const flags = vi.hoisted(() => ({ isServerFeatureEnabled: vi.fn() }));
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: flags.isServerFeatureEnabled };
});

const upsertLichessLink = vi.hoisted(() => vi.fn());
// Only `upsertLichessLink` is faked (the real one needs a database). The
// module's `PLAY_SCOPES` is reproduced the way the real module derives it —
// from lib/oauth — rather than typed here, so the callback's `scopes` payload
// cannot pass against a list this test invented.
vi.mock("@/server/usecases/external-accounts", async () => {
  const { LICHESS_OAUTH_SCOPES } = await import("@/lib/oauth");
  return { upsertLichessLink, PLAY_SCOPES: LICHESS_OAUTH_SCOPES.split(" ") };
});

import { HttpError } from "@/lib/errors";
import { LICHESS_OAUTH_SCOPES } from "@/lib/oauth";
import { pkceChallenge } from "@/server/external-play/pkce";
import { lichessLinkStartHref } from "@/lib/lichess-link";
import { registerReturnPath } from "@/components/public-site/register/register-lichess-card";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
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
  requireUser.mockReset().mockResolvedValue({ id: "u1" });
  orgBySlug.mockReset().mockImplementation(async (slug: string) => (slug === CLUB.slug ? CLUB : null));
  // The override vitest.config sets (local / CI / e2e) stays on unless a case removes it; a flag asked while it is
  // on is a defect.
  forgetOnlineChessFlagCache();
  flags.isServerFeatureEnabled.mockReset().mockRejectedValue(new Error("flag asked while the override was on"));
});

/** The start a club page builds: the real href builder, so the route and the links cannot disagree. */
const start = (next?: string) => new Request(`http://localhost${lichessLinkStartHref(CLUB.slug, next)}`);

describe("GET /api/auth/lichess — start", () => {
  it("redirects with code_challenge S256 and stores verifier + state + next cookies", async () => {
    const res = await GET(start("/shared/o/c/d/fixtures/f1/play"));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://lichess.org/oauth");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toBe(pkceChallenge(cookieJar.get(VERIFIER_COOKIE)!));
    expect(loc.searchParams.has("client_secret")).toBe(false);
    expect(cookieJar.get(NEXT_COOKIE)).toBe("/shared/o/c/d/fixtures/f1/play");
  });

  it("asks for exactly board:play, challenge:write and challenge:read — the grant that submits moves and recovers a crashed create", async () => {
    const res = await GET(start());
    const loc = new URL(res.headers.get("location")!);
    // Anti-vacuity first: an EMPTY constant (the state this task reverses)
    // would make the equality below pass against a missing grant.
    expect(LICHESS_OAUTH_SCOPES.split(" ")).toContain("board:play");
    // Spec §3.1 amended 2026-10-10: the crash-recovery lookup lists White's
    // challenges, which a grant without challenge:read is refused (403).
    expect(LICHESS_OAUTH_SCOPES.split(" ")).toContain("challenge:read");
    // Then derived from the declaration, never retyped: a change to the scope
    // list moves this assertion with it. The list itself is pinned against
    // design §3.1 by external-accounts.test.ts ("PLAY_SCOPES is what the
    // design asks for"), which is also why this file reads the constant from
    // lib/oauth — it mocks the usecase module wholesale.
    expect(loc.searchParams.get("scope")).toBe(LICHESS_OAUTH_SCOPES);
  });

  // I5 (T16 fix round 1): the registration's consent step starts here with `next` = its own path (join code kept), so
  // the player comes back to the form — and only a same-origin relative path is ever kept (safeNextPath's origin
  // check, not a prefix check): each hostile shape in that slot is dropped and the start still goes ahead.
  it("I5: a registration's own path is kept as next; an off-site one in its place is dropped", async () => {
    const back = registerReturnPath("club", "autumn-rapid", "AB12");
    await GET(start(back));
    expect(cookieJar.get(NEXT_COOKIE)).toBe("/shared/club/autumn-rapid/register?join=AB12");
    let checked = 0;
    for (const hostile of ["https://evil.example/shared/club/autumn-rapid/register", "//evil.example/register", "/\\evil.example", "/\tevil", "javascript:alert(1)"]) {
      cookieJar.clear();
      const res = await GET(start(hostile));
      expect(new URL(res.headers.get("location")!).origin, hostile).toBe("https://lichess.org");
      expect(cookieJar.has(NEXT_COOKIE), hostile).toBe(false);
      checked += 1;
    }
    expect(checked).toBe(5);
  });

  it("refuses a protocol-relative next", async () => {
    const res = await GET(start("//evil.example"));
    // The positive pair: the start itself went ahead — only the `next` was dropped.
    expect(new URL(res.headers.get("location")!).origin).toBe("https://lichess.org");
    expect(cookieJar.has(NEXT_COOKIE)).toBe(false);
  });
});

// T20: linking a Lichess account is how online chess STARTS for a player, so the start is offered only to a club
// offered online chess (the PostHog flag `online-chess`, fallback off), the flag asked for the signed-in user in the
// club's group. The refusal is a redirect onto a page with `?lichess=unavailable` (controller ruling, fix round 1 m5 —
// the brief's 403 ONLINE_CHESS_DISABLED is for API callers; this route is a browser navigation).
describe("GET /api/auth/lichess — online chess must be offered to the club", () => {
  type FlagState = { label: string; offered: boolean; arm: () => void };
  const FLAG_STATES: readonly FlagState[] = [
    { label: "flag ON", offered: true, arm: () => flags.isServerFeatureEnabled.mockResolvedValue(true) },
    { label: "flag OFF", offered: false, arm: () => flags.isServerFeatureEnabled.mockResolvedValue(false) },
    {
      label: "PostHog throws",
      offered: false,
      arm: () => flags.isServerFeatureEnabled.mockRejectedValue(new Error("posthog unreachable")),
    },
  ];
  const flagIs = (s: FlagState) => {
    vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
    forgetOnlineChessFlagCache();
    flags.isServerFeatureEnabled.mockReset();
    s.arm();
  };
  /** Fix round 1, m5: a refused start is a browser navigation, so it lands on a PAGE — back where it started (the
   *  validated `next`) or the player home `/me`, carrying `?lichess=unavailable` — exactly as the callback reports
   *  its own failures. Never raw JSON. */
  function landedOn(res: Response): { status: number; pathname: string; query: Record<string, string> } {
    const loc = path(res.headers.get("location") ?? "");
    return { status: res.status, pathname: loc.pathname, query: Object.fromEntries(loc.searchParams) };
  }
  const isRedirect = (status: number) => status >= 300 && status < 400;

  it("flag ON starts the OAuth round trip; flag OFF or PostHog throwing lands back on the page it started from with ?lichess=unavailable, and sets no cookie", async () => {
    let checked = 0;
    for (const s of FLAG_STATES) {
      cookieJar.clear();
      flagIs(s);
      const res = await GET(start("/settings?tab=account"));
      if (s.offered) {
        expect(new URL(res.headers.get("location")!).origin + new URL(res.headers.get("location")!).pathname, s.label).toBe(
          "https://lichess.org/oauth",
        );
        expect(cookieJar.has(STATE_COOKIE), s.label).toBe(true);
      } else {
        const landed = landedOn(res);
        expect(isRedirect(landed.status), `${s.label}: a redirect, not a JSON body (${landed.status})`).toBe(true);
        expect(landed, s.label).toMatchObject({ pathname: "/settings", query: { tab: "account", lichess: "unavailable" } });
        expect([...cookieJar.keys()], `${s.label}: nothing stored`).toEqual([]);
      }
      expect(flags.isServerFeatureEnabled, s.label).toHaveBeenCalledWith("online-chess", "u1", { orgId: CLUB.id, fallback: false });
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  it("a start naming no club, an unknown one, or a rename to a club that is gone is refused onto a page — /me when it carried no next — even with the override on, and the flag is never asked", async () => {
    orgBySlug.mockImplementation(async (slug: string) => (slug === "gone-club" ? { renamedTo: "vanished" } : null));
    const cases: Array<{ url: string; pathname: string; query: Record<string, string> }> = [
      { url: "http://localhost/api/auth/lichess", pathname: "/me", query: { lichess: "unavailable" } },
      { url: "http://localhost/api/auth/lichess?next=/settings", pathname: "/settings", query: { lichess: "unavailable" } },
      { url: "http://localhost/api/auth/lichess?org=", pathname: "/me", query: { lichess: "unavailable" } },
      { url: "http://localhost/api/auth/lichess?org=nobody", pathname: "/me", query: { lichess: "unavailable" } },
      { url: "http://localhost/api/auth/lichess?org=gone-club", pathname: "/me", query: { lichess: "unavailable" } },
      // An off-site next is dropped by the same `safeNextPath` the start uses: the refusal never leaves the site.
      { url: "http://localhost/api/auth/lichess?org=nobody&next=//evil.example", pathname: "/me", query: { lichess: "unavailable" } },
    ];
    let checked = 0;
    for (const c of cases) {
      cookieJar.clear();
      const res = await GET(new Request(c.url));
      const landed = landedOn(res);
      expect(isRedirect(landed.status), `${c.url}: a redirect (${landed.status})`).toBe(true);
      expect(res.headers.get("location")!.startsWith("/"), `${c.url}: a same-site, relative Location`).toBe(true);
      expect(landed, c.url).toMatchObject({ pathname: c.pathname, query: c.query });
      expect([...cookieJar.keys()], `${c.url}: nothing stored`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(flags.isServerFeatureEnabled).not.toHaveBeenCalled();
  });

  it("a renamed club's old slug is followed — once — to the club it names now, and THAT club's flag decides", async () => {
    // slug_history answers a renamed slug with the club's live slug (slug-resolve.ts `renamedTo`).
    orgBySlug.mockImplementation(async (slug: string) =>
      slug === "old-club" ? { renamedTo: CLUB.slug } : slug === CLUB.slug ? CLUB : null,
    );
    const renamed = () => new Request(`http://localhost${lichessLinkStartHref("old-club", "/settings?tab=account")}`);
    let checked = 0;
    for (const s of FLAG_STATES) {
      cookieJar.clear();
      flagIs(s);
      const res = await GET(renamed());
      if (s.offered) {
        expect(new URL(res.headers.get("location")!).origin, s.label).toBe("https://lichess.org");
      } else {
        expect(landedOn(res), s.label).toMatchObject({ pathname: "/settings", query: { lichess: "unavailable" } });
      }
      expect(flags.isServerFeatureEnabled, `${s.label}: asked for the club the old slug names`).toHaveBeenCalledWith(
        "online-chess",
        "u1",
        { orgId: CLUB.id, fallback: false },
      );
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);

    // Once, not a chain: a rename that answers with another rename is refused, after exactly two lookups.
    orgBySlug.mockReset().mockImplementation(async (slug: string) =>
      slug === "a" ? { renamedTo: "b" } : slug === "b" ? { renamedTo: CLUB.slug } : slug === CLUB.slug ? CLUB : null,
    );
    const res = await GET(new Request(`http://localhost${lichessLinkStartHref("a")}`));
    expect(landedOn(res)).toMatchObject({ pathname: "/me", query: { lichess: "unavailable" } });
    expect(orgBySlug.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });

  it("signed out: to the login page FIRST, keeping the club and the next — so the start works on the way back", async () => {
    requireUser.mockRejectedValueOnce(new Error("unauthenticated"));
    flagIs(FLAG_STATES[1]!);
    const href = lichessLinkStartHref(CLUB.slug, "/settings?tab=account");
    const res = await GET(new Request(`http://localhost${href}`));
    const loc = path(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next"), "the whole start, query included").toBe(href);
    expect(flags.isServerFeatureEnabled, "nobody to ask for yet").not.toHaveBeenCalled();
  });

  it("the club's refusal comes before Lichess being unconfigured: with both, the start lands with lichess=unavailable, not not_configured", async () => {
    vi.stubEnv("LICHESS_CLIENT_ID", undefined);
    flagIs(FLAG_STATES[1]!);
    expect(landedOn(await GET(start()))).toMatchObject({ pathname: "/me", query: { lichess: "unavailable" } });
    // The positive pair: offered, the same unconfigured start is told Lichess is not configured.
    flagIs(FLAG_STATES[0]!);
    const res = await GET(start());
    expect(path(res.headers.get("location")!).searchParams.get("lichess")).toBe("not_configured");
  });

  // Final review M-3: the not_configured exit was hard-coded to /settings?tab=account, which bounces an org-less player
  // through /orgs/new. It lands where every other exit does: back on `next`, else /me.
  it("M-3: an unconfigured start lands like every other exit — on `next` (its own query kept), else /me — never on settings", async () => {
    vi.stubEnv("LICHESS_CLIENT_ID", undefined);
    flagIs(FLAG_STATES[0]!);
    const cases: [string | undefined, { pathname: string; query: Record<string, string> }][] = [
      ["/shared/o/c/d/fixtures/f1/play", { pathname: "/shared/o/c/d/fixtures/f1/play", query: { lichess: "not_configured" } }],
      ["/shared/o/c/d/fixtures/f1/play?t=tok", { pathname: "/shared/o/c/d/fixtures/f1/play", query: { t: "tok", lichess: "not_configured" } }],
      [undefined, { pathname: "/me", query: { lichess: "not_configured" } }],
    ];
    let checked = 0;
    for (const [next, landing] of cases) {
      const res = await GET(start(next));
      expect(isRedirect(res.status), String(next)).toBe(true);
      expect(landedOn(res), String(next)).toMatchObject(landing);
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});

describe("GET /api/auth/lichess/callback", () => {
  it("sends code_verifier (no secret), reads account, KEEPS the token, returns to next", async () => {
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
    // §3.1: a link that SUCCEEDED keeps its grant — the revoke-on-every-exit
    // `finally` this task replaces would have sent one here.
    expect(calls.some(([u, i]) => u.endsWith("/api/token") && i.method === "DELETE")).toBe(false);
    // The positive pair: the token reached the usecase. Asserting only "no
    // DELETE" would pass if the callback had stopped calling Lichess at all.
    expect(upsertLichessLink).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        externalUserId: "alice",
        username: "Alice",
        scopes: LICHESS_OAUTH_SCOPES.split(" "),
        token: "tok",
      }),
    );
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
