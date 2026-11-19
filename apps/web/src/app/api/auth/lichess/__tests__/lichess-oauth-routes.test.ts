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

// T17B fix 2 (D6): the logger, observed — a key failure is logged, and never with the token.
const logged = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@/server/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/logger")>();
  return { ...actual, log: new Proxy(actual.log, { get: (t, k) => (k === "error" ? logged.error : Reflect.get(t, k)) }) };
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
import { sealPlayerToken } from "@/server/external-play/secrets";

const STATE_COOKIE = "seazn_lichess_oauth_state";
const VERIFIER_COOKIE = "seazn_lichess_oauth_verifier";
const NEXT_COOKIE = "seazn_lichess_oauth_next";

/** redirectLocal() emits a RELATIVE Location header on purpose (lib/http.ts —
 *  no origin to get wrong behind a proxy), so it needs a base to parse; the
 *  house pattern for this is `new URL(loc, "http://t")`. */
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
    const res = await GET(start("/live/o/c/d/fixtures/f1/play"));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://lichess.org/oauth");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toBe(pkceChallenge(cookieJar.get(VERIFIER_COOKIE)!));
    expect(loc.searchParams.has("client_secret")).toBe(false);
    expect(cookieJar.get(NEXT_COOKIE)).toBe("/live/o/c/d/fixtures/f1/play");
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
    expect(cookieJar.get(NEXT_COOKIE)).toBe("/live/club/autumn-rapid/register?join=AB12");
    let checked = 0;
    for (const hostile of ["https://evil.example/live/club/autumn-rapid/register", "//evil.example/register", "/\\evil.example", "/\tevil", "javascript:alert(1)"]) {
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

// T20: a start that NAMES a club (the registration form, the match room) is for that club's online chess, so it is
// offered only when the club is offered online chess (the PostHog flag `online-chess`, fallback off), the flag asked
// for the signed-in user in the club's group. The refusal is a redirect onto a page with `?lichess=unavailable`
// (controller ruling, fix round 1 m5 — the brief's 403 ONLINE_CHESS_DISABLED is for API callers; this route is a
// browser navigation).
//
// Owner 2026-11-18: a start that names NO club is the player's own — the /me and Settings card, shown to every
// signed-in player. No club's flag is asked (there is no club), and every other check stays: sign-in first, the
// Lichess configuration, a validated `next`, and the state + PKCE cookies.
describe("GET /api/auth/lichess — a start naming a club needs online chess offered to it; one naming none is the player's own", () => {
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

  it("a start naming an unknown club, or a rename to a club that is gone, is refused onto a page — /me when it carried no next — even with the override on, and the flag is never asked", async () => {
    orgBySlug.mockImplementation(async (slug: string) => (slug === "gone-club" ? { renamedTo: "vanished" } : null));
    const cases: Array<{ url: string; pathname: string; query: Record<string, string> }> = [
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

  // ---- owner 2026-11-18: the player's own start names no club -----------------------------------------------------

  /** The start the /me and Settings card builds: the real href builder, naming no club. */
  const startOwn = (next?: string) => new Request(`http://localhost${lichessLinkStartHref(null, next)}`);
  /** Every spelling of "no club": the bare path, a next only, and an empty `org=` (a blank slug names nothing). */
  const OWN_STARTS: ReadonlyArray<{ label: string; req: () => Request; next: string | null }> = [
    { label: "bare", req: () => new Request("http://localhost/api/auth/lichess"), next: null },
    { label: "next only", req: () => startOwn("/me"), next: "/me" },
    { label: "settings next", req: () => startOwn("/settings?tab=account"), next: "/settings?tab=account" },
    { label: "empty org=", req: () => new Request("http://localhost/api/auth/lichess?org=&next=%2Fme"), next: "/me" },
  ];
  /** The override the suite runs under, plus every state of the flag: none of them may matter to a start naming no club. */
  const EVERY_FLAG_WORLD: ReadonlyArray<{ label: string; arm: () => void }> = [
    { label: "override ON", arm: () => undefined },
    ...FLAG_STATES.map((s) => ({ label: s.label, arm: () => flagIs(s) })),
  ];

  it("a start naming no club goes ahead whatever any club's flag says — and never asks it, never looks up a club", async () => {
    let checked = 0;
    for (const world of EVERY_FLAG_WORLD) {
      for (const own of OWN_STARTS) {
        cookieJar.clear();
        orgBySlug.mockClear();
        world.arm();
        const label = `${world.label} / ${own.label}`;
        const res = await GET(own.req());
        const loc = new URL(res.headers.get("location")!);
        expect(loc.origin + loc.pathname, `${label}: on to Lichess`).toBe("https://lichess.org/oauth");
        // The same protection as a named start: a state, a PKCE challenge of the stored verifier, no secret.
        const state = loc.searchParams.get("state");
        expect(state, `${label}: a state`).toBeTruthy();
        expect(cookieJar.get(STATE_COOKIE), `${label}: the state is stored for the callback`).toBe(state);
        expect(loc.searchParams.get("code_challenge"), label).toBe(pkceChallenge(cookieJar.get(VERIFIER_COOKIE)!));
        expect(loc.searchParams.get("code_challenge_method"), label).toBe("S256");
        expect(loc.searchParams.has("client_secret"), label).toBe(false);
        expect(loc.searchParams.get("scope"), label).toBe(LICHESS_OAUTH_SCOPES);
        expect(cookieJar.get(NEXT_COOKIE) ?? null, `${label}: next kept`).toBe(own.next);
        expect(flags.isServerFeatureEnabled, `${label}: no flag asked`).not.toHaveBeenCalled();
        expect(orgBySlug, `${label}: no club looked up`).not.toHaveBeenCalled();
        checked += 1;
      }
    }
    expect(checked).toBe(EVERY_FLAG_WORLD.length * OWN_STARTS.length);
    // The positive pair, so the "no flag asked" above is not the route having stopped asking for everyone: a NAMED
    // start still asks it, and is still refused with it off.
    cookieJar.clear();
    flagIs(FLAG_STATES[1]!);
    expect(landedOn(await GET(start())), "a named start, flag OFF, is still refused").toMatchObject({ query: { lichess: "unavailable" } });
    expect(flags.isServerFeatureEnabled).toHaveBeenCalledTimes(1);
  });

  // The redirect validation is exactly as strict without a club: only a same-origin relative path is ever kept.
  it("a start naming no club drops every off-site next, and still goes ahead", async () => {
    let checked = 0;
    for (const hostile of [
      "https://evil.example/me",
      "//evil.example/me",
      "/\\evil.example",
      "/\tevil",
      "javascript:alert(1)",
    ]) {
      cookieJar.clear();
      const res = await GET(startOwn(hostile));
      expect(new URL(res.headers.get("location")!).origin, hostile).toBe("https://lichess.org");
      expect(cookieJar.has(NEXT_COOKIE), hostile).toBe(false);
      expect(cookieJar.has(STATE_COOKIE), `${hostile}: the start itself went ahead`).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(5);
    // Not configured: the refusal onto a page also never leaves the site, and never stores anything.
    vi.stubEnv("LICHESS_CLIENT_ID", undefined);
    cookieJar.clear();
    const res = await GET(startOwn("//evil.example"));
    expect(landedOn(res)).toMatchObject({ pathname: "/me", query: { lichess: "not_configured" } });
    expect(res.headers.get("location")!.startsWith("/")).toBe(true);
    expect([...cookieJar.keys()]).toEqual([]);
  });

  it("signed out: a start naming no club goes to the login page FIRST, keeping the whole start, and stores nothing", async () => {
    requireUser.mockRejectedValueOnce(new Error("unauthenticated"));
    const href = lichessLinkStartHref(null, "/settings?tab=account");
    const res = await GET(new Request(`http://localhost${href}`));
    const loc = path(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next"), "the whole start, query included").toBe(href);
    expect([...cookieJar.keys()]).toEqual([]);
  });

  it("not configured: a start naming no club lands on next, else /me, with lichess=not_configured", async () => {
    vi.stubEnv("LICHESS_CLIENT_ID", undefined);
    let checked = 0;
    for (const [next, landing] of [
      ["/settings?tab=account", { pathname: "/settings", query: { tab: "account", lichess: "not_configured" } }],
      [undefined, { pathname: "/me", query: { lichess: "not_configured" } }],
    ] as const) {
      const res = await GET(startOwn(next));
      expect(isRedirect(res.status), String(next)).toBe(true);
      expect(landedOn(res), String(next)).toMatchObject(landing);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  // The seam, end to end: the callback is driven with the state the start ITSELF stored, not a hand-set cookie.
  it("round trip: the state a start naming no club stored is the one the callback accepts, and it lands on the validated next", async () => {
    const res = await GET(startOwn("/settings?tab=account"));
    const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/api/token") && init.method === "POST") return Response.json({ access_token: "tok" });
        if (url.endsWith("/api/account")) return Response.json({ id: "alice", username: "Alice" });
        return new Response(null, { status: 500 });
      }),
    );
    const back = await CALLBACK(new Request(`http://localhost/api/auth/lichess/callback?code=c&state=${state}`));
    expect(upsertLichessLink).toHaveBeenCalledWith("u1", expect.objectContaining({ externalUserId: "alice", token: "tok" }));
    expect(landedOn(back)).toMatchObject({ pathname: "/settings", query: { tab: "account", lichess: "linked" } });
    // And a callback carrying any other state is still refused: the start did not loosen the CSRF check.
    cookieJar.clear();
    upsertLichessLink.mockClear();
    await GET(startOwn("/me"));
    const refused = await CALLBACK(new Request("http://localhost/api/auth/lichess/callback?code=c&state=not-the-one"));
    expect(upsertLichessLink).not.toHaveBeenCalled();
    expect(landedOn(refused)).toMatchObject({ pathname: "/me", query: { lichess: "oauth_state" } });
  });

  // Final review M-3: the not_configured exit was hard-coded to /settings?tab=account, which bounces an org-less player
  // through /orgs/new. It lands where every other exit does: back on `next`, else /me.
  it("M-3: an unconfigured start lands like every other exit — on `next` (its own query kept), else /me — never on settings", async () => {
    vi.stubEnv("LICHESS_CLIENT_ID", undefined);
    flagIs(FLAG_STATES[0]!);
    const cases: [string | undefined, { pathname: string; query: Record<string, string> }][] = [
      ["/live/o/c/d/fixtures/f1/play", { pathname: "/live/o/c/d/fixtures/f1/play", query: { lichess: "not_configured" } }],
      ["/live/o/c/d/fixtures/f1/play?t=tok", { pathname: "/live/o/c/d/fixtures/f1/play", query: { t: "tok", lichess: "not_configured" } }],
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
    cookieJar.set(NEXT_COOKIE, "/live/o/c/d/fixtures/f1/play");
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
    expect(path(res.headers.get("location")!).pathname).toBe("/live/o/c/d/fixtures/f1/play");
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

  // Owner requirement (match-room silent-link fix, 2026-10-19): the collision names NOBODY. The page the player lands on says
  // "that Lichess account is already linked to another Seazn account" and what to do - it never shows the Lichess username
  // or anything about the other account (name, email, id) - so the callback's landing carries the CODE alone. A param
  // added to the redirect (the Lichess name, the other user's id) would be a way for the page to show it; this pins
  // that there is none, against an account whose id, name and collision error are all recognisable.
  it("already_linked lands with the code alone: next's own query plus lichess=, never the Lichess username or any id of the other account", async () => {
    cookieJar.set(STATE_COOKIE, "st");
    cookieJar.set(VERIFIER_COOKIE, "ver");
    cookieJar.set(NEXT_COOKIE, "/live/o/c/d/fixtures/f1/play?t=tok.en");
    upsertLichessLink.mockRejectedValueOnce(
      new HttpError(409, "That Lichess account is already linked to a different Seazn account (user u-other-9, mallory@other.example).", "LICHESS_ALREADY_LINKED"),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/api/token") && init.method === "POST") return Response.json({ access_token: "tok" });
        if (url.endsWith("/api/account")) return Response.json({ id: "ada_plays", username: "Ada_Plays" });
        if (url.endsWith("/api/token") && init.method === "DELETE") return new Response(null, { status: 204 });
        return new Response(null, { status: 500 });
      }),
    );

    const res = await CALLBACK(new Request("http://localhost/api/auth/lichess/callback?code=c&state=st"));

    const raw = res.headers.get("location")!;
    const loc = path(raw);
    expect(loc.pathname).toBe("/live/o/c/d/fixtures/f1/play");
    expect([...loc.searchParams.keys()].sort(), "the personal link's own t= and the outcome, nothing else").toEqual(["lichess", "t"]);
    expect(loc.searchParams.get("t")).toBe("tok.en");
    expect(loc.searchParams.get("lichess")).toBe("already_linked");
    expect(raw, "the Lichess username").not.toMatch(/ada_plays/i);
    expect(raw, "the other account's id or email").not.toMatch(/u-other-9|mallory|other\.example/i);
  });

  // T17B fix 2 (D6), measured on stg: a LICHESS_TOKEN_KEK that is not 64 hex made the seal throw a plain Error, which
  // the callback rethrew — the player saw a raw 500. The seal here is the REAL one (sealPlayerToken over the real
  // envelope), so the error is the one production throws, not one this test invented.
  it("D6: a malformed or missing LICHESS_TOKEN_KEK lands on next with key_unavailable — never a 500 — is logged without the token, and still revokes — swept", async () => {
    const BAD = { unset: undefined, short: "ab".repeat(31), "not hex": "zz".repeat(32), "too long": "ab".repeat(33) };
    let checked = 0;
    for (const [label, value] of Object.entries(BAD)) {
      cookieJar.clear();
      cookieJar.set(STATE_COOKIE, "st");
      cookieJar.set(VERIFIER_COOKIE, "ver");
      cookieJar.set(NEXT_COOKIE, "/live/o/c/d/fixtures/f1/play");
      if (value === undefined) vi.stubEnv("LICHESS_TOKEN_KEK", undefined as unknown as string);
      else vi.stubEnv("LICHESS_TOKEN_KEK", value);
      upsertLichessLink.mockImplementationOnce(async (_userId: string, link: { token: string }) => {
        await sealPlayerToken(link.token);
      });
      logged.error.mockClear();
      const calls: [string, RequestInit][] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          calls.push([url, init]);
          if (url.endsWith("/api/token") && init.method === "POST") return Response.json({ access_token: "secret-grant-tok" });
          if (url.endsWith("/api/account")) return Response.json({ id: "alice", username: "Alice" });
          if (url.endsWith("/api/token") && init.method === "DELETE") return new Response(null, { status: 204 });
          return new Response(null, { status: 500 });
        }),
      );

      const res = await CALLBACK(new Request("http://localhost/api/auth/lichess/callback?code=c&state=st"));

      expect(res.status, `${label}: a redirect, never a 500`).toBeGreaterThanOrEqual(300);
      expect(res.status, label).toBeLessThan(400);
      const loc = path(res.headers.get("location")!);
      expect(loc.pathname, `${label}: back where the flow started`).toBe("/live/o/c/d/fixtures/f1/play");
      expect(loc.searchParams.get("lichess"), label).toBe("key_unavailable");
      expect(calls.some(([u, i]) => u.endsWith("/api/token") && i.method === "DELETE"), `${label}: the unstored grant is revoked`).toBe(true);
      expect(logged.error, `${label}: logged once`).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logged.error.mock.calls), `${label}: never the token`).not.toContain("secret-grant-tok");
      checked++;
    }
    expect(checked).toBe(Object.keys(BAD).length);
  });

  it("D6's positive pair: under a VALID key, another failure of the link (the database) is still the caller's error — never relabelled key_unavailable", async () => {
    cookieJar.set(STATE_COOKIE, "st");
    cookieJar.set(VERIFIER_COOKIE, "ver");
    vi.stubEnv("LICHESS_TOKEN_KEK", "ab".repeat(32));
    upsertLichessLink.mockRejectedValueOnce(new Error("connection refused"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/api/token") && init.method === "POST") return Response.json({ access_token: "tok" });
        if (url.endsWith("/api/account")) return Response.json({ id: "alice", username: "Alice" });
        return new Response(null, { status: 204 });
      }),
    );
    await expect(CALLBACK(new Request("http://localhost/api/auth/lichess/callback?code=c&state=st"))).rejects.toThrow("connection refused");
  });
});
