// Blog P2 Task 5 (owner ruling 2026-11-19: help and blog cached together at the edge, with a fixed CSP and no
// per-request nonce): the proxy's static-content carve-out. A response under /help or /blog is stored by Cloudflare
// and handed to every visitor, so it must be the same response for every visitor:
//   - no nonce anywhere: none forwarded to the render (`x-nonce`, the CSP request header) and none in the policy;
//   - the policy is `script-src 'self' 'unsafe-inline'` (Next's documented "without nonces" policy,
//     node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md "Without Nonces"), every other
//     directive as the app's, and byte-identical from one request to the next;
//   - no Set-Cookie, even for the request that gets one today (a session with no signed-in hint);
//   - the mode follows CSP_MODE like the app's (NOT forced report-only like /live and /embed).
// Lookalike paths (/helpdesk, /blogs, /help-centre) and every other route class keep exactly what they had.
//
// Expected values are typed here from the design (2026-11-19-blog-p2-design.md, "The proxy"), never read from
// cspHeader. Single-sport reason: no sport is involved; this is request handling.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy, isStaticContentPath } from "@/proxy";
import { SESSION_HINT_COOKIE } from "@/lib/session-hint";

afterEach(() => vi.unstubAllEnvs());

const STATIC = ["/help", "/help/", "/help/registration/waitlist", "/help/formats/league", "/blog", "/blog/", "/blog/how-standings-points-work", "/blog/rss.xml"];
/** Not static content: lookalikes first, then one of every other route class. */
const LOOKALIKES = ["/helpdesk", "/blogs", "/help-centre", "/helps/x", "/blogx/y", "/x/help", "/x/blog"];
const OTHERS = ["/live/a/b", "/embed/x", "/dashboard", "/"];

const req = (path: string, cookie = "", extra: Record<string, string> = {}) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: { host: "seazn.club", ...(cookie ? { cookie } : {}), ...extra } });

/** The policy on the response, by whichever name it carries; the marketing rewrite of `/` forwards it on the request. */
function cspOf(res: Response): { name: string; value: string } {
  for (const name of ["Content-Security-Policy", "Content-Security-Policy-Report-Only"]) {
    const v = res.headers.get(name) ?? res.headers.get(`x-middleware-request-${name.toLowerCase()}`);
    if (v !== null) return { name, value: v };
  }
  throw new Error("no CSP header on a page response");
}
const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? null;
/** What the proxy hands the render: the request headers it overrides. */
const forwarded = (res: Response) => (res.headers.get("x-middleware-override-headers") ?? "").split(",").map((h) => h.trim());
/** Headers a browser or a CDN sees: everything but Next's internal x-middleware-* hand-off. */
const publicHeaders = (res: Response) =>
  [...res.headers.entries()].filter(([k]) => !k.startsWith("x-middleware-")).sort(([a], [b]) => a.localeCompare(b));

describe("isStaticContentPath", () => {
  it("is /help and /blog, each with or without a sub-path, and nothing that only starts with the same letters", () => {
    let checked = 0;
    for (const p of STATIC) { expect(isStaticContentPath(p), p).toBe(true); checked++; }
    for (const p of [...LOOKALIKES, ...OTHERS]) { expect(isStaticContentPath(p), p).toBe(false); checked++; }
    console.log(`[isStaticContentPath] paths checked: ${checked}`);
    expect(checked).toBe(STATIC.length + LOOKALIKES.length + OTHERS.length);
  });
});

describe("static content: one response for every visitor", () => {
  for (const mode of ["report-only", "enforce"] as const) {
    it(`${mode}: no nonce, the fixed policy, byte-identical, under the ${mode === "enforce" ? "enforcing" : "report-only"} header`, () => {
      if (mode === "enforce") vi.stubEnv("CSP_MODE", "enforce");
      const appScript = directive(cspOf(proxy(req("/dashboard"))).value, "script-src");
      expect(appScript, "the app keeps its nonce policy (the baseline this compares against)").toMatch(/'nonce-/);
      const appOthers = cspOf(proxy(req("/dashboard"))).value.split("; ").filter((d) => !d.startsWith("script-src "));
      let checked = 0;
      for (const path of STATIC) {
        const a = proxy(req(path));
        const b = proxy(req(path));
        const csp = cspOf(a);
        expect(csp.name, path).toBe(mode === "enforce" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only");
        expect(csp.value, `${path}: no nonce`).not.toContain("nonce-");
        expect(csp.value, `${path}: no strict-dynamic (it would void 'self' and 'unsafe-inline')`).not.toContain("strict-dynamic");
        expect(directive(csp.value, "script-src"), path).toBe("script-src 'self' 'unsafe-inline'");
        expect(csp.value.split("; ").filter((d) => !d.startsWith("script-src ")), `${path}: every other directive is the app's`).toEqual(appOthers);
        expect(cspOf(b), `${path}: byte-identical on a second request`).toEqual(csp);
        expect(a.headers.get("x-middleware-request-x-nonce"), path).toBeNull();
        expect(forwarded(a), `${path}: nothing nonce-shaped forwarded to the render`).not.toContain("x-nonce");
        expect(forwarded(a).filter((h) => h.startsWith("content-security-policy")), path).toEqual([]);
        checked++;
      }
      console.log(`[${mode}] static paths checked: ${checked}`);
      expect(checked).toBe(STATIC.length);
    });
  }

  it("no Set-Cookie and no per-visitor header, whoever asks: anonymous, signed in without the hint, a stale hint, another language", () => {
    const visitors: [string, string, Record<string, string>][] = [
      ["anonymous", "", {}],
      ["session, no hint (the request that gets a Set-Cookie on an app page)", "seazn_session=tok", {}],
      ["hint, no session (the request that gets a clearing Set-Cookie on an app page)", `${SESSION_HINT_COOKIE}=1`, {}],
      ["both", `seazn_session=tok; ${SESSION_HINT_COOKIE}=1`, {}],
      ["French, by cookie and header", "seazn_locale=fr", { "accept-language": "fr-FR,fr;q=0.9" }],
    ];
    let checked = 0;
    for (const path of STATIC) {
      const baseline = publicHeaders(proxy(req(path)));
      for (const [who, cookie, extra] of visitors) {
        const res = proxy(req(path, cookie, extra));
        expect(res.headers.getSetCookie(), `${path} ${who}`).toEqual([]);
        expect(publicHeaders(res), `${path} ${who}: the same headers as an anonymous visitor's`).toEqual(baseline);
        checked++;
      }
    }
    console.log(`[no Set-Cookie] path x visitor pairs checked: ${checked}`);
    expect(checked).toBe(STATIC.length * visitors.length);
  });

  it("the root layout's external script loads ride the fixed policy: revshare when it is on, the PostHog origin when set", () => {
    vi.stubEnv("NEXT_PUBLIC_REVSHARE_ENABLED", "0");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_API_HOST", "");
    expect(directive(cspOf(proxy(req("/blog"))).value, "script-src")).toBe("script-src 'self' 'unsafe-inline'");
    expect(directive(cspOf(proxy(req("/blog"))).value, "connect-src"), "revshare off: not in connect-src").not.toContain("revshare");
    vi.stubEnv("NEXT_PUBLIC_REVSHARE_ENABLED", "1");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_API_HOST", "https://e.example.test");
    expect(directive(cspOf(proxy(req("/help"))).value, "script-src")).toBe(
      "script-src 'self' 'unsafe-inline' https://www.revshare.so https://e.example.test",
    );
    // tracking.js posts to https://www.revshare.so/api/tracking/* (click, ip hash): the fixed policy lets it connect.
    const connect = directive(cspOf(proxy(req("/blog/how-standings-points-work"))).value, "connect-src")!.split(" ");
    expect(connect).toContain("https://www.revshare.so");
    expect(connect.filter((o) => o === "https://www.revshare.so"), "listed once").toHaveLength(1);
    // The app's nonce policy is not this task's: its connect-src is unchanged.
    expect(directive(cspOf(proxy(req("/dashboard"))).value, "connect-src")).not.toContain("revshare");
  });
});

describe("everything else keeps what it had", () => {
  it("the games host: /help and /blog there are game slugs (rewritten under /games), never the static-content carve-out", () => {
    vi.stubEnv("CSP_MODE", "enforce");
    let checked = 0;
    for (const host of ["games.seazn.club", "games.localhost:3000"]) {
      for (const path of ["/help", "/blog"]) {
        const res = proxy(new NextRequest(`http://localhost:3000${path}`, { headers: { host, cookie: "seazn_session=tok" } }));
        expect(res.headers.get("x-middleware-rewrite") ?? "", `${host}${path}: still the games rewrite`).toContain(`/games${path}`);
        expect(directive(cspOf(res).value, "script-src"), `${host}${path}`).toMatch(/'nonce-[^']+' 'strict-dynamic'/);
        expect(res.headers.get("x-middleware-request-x-nonce"), `${host}${path}`).toBeTruthy();
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("lookalikes and app pages: a fresh nonce in the policy and forwarded to the render, and the hint still synced", () => {
    vi.stubEnv("CSP_MODE", "enforce");
    let checked = 0;
    for (const path of [...LOOKALIKES, "/dashboard"]) {
      const a = proxy(req(path, "seazn_session=tok"));
      const csp = cspOf(a);
      expect(csp.name, path).toBe("Content-Security-Policy");
      expect(directive(csp.value, "script-src"), path).toMatch(/^script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
      expect(cspOf(proxy(req(path))).value, `${path}: a new nonce per request`).not.toBe(csp.value);
      expect(a.headers.get("x-middleware-request-x-nonce"), path).toBeTruthy();
      expect(a.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_HINT_COOKIE}=1`)), `${path}: hint set`).toBe(true);
      checked++;
    }
    // `/` is the marketing rewrite: the nonce policy rides the forwarded request.
    expect(directive(cspOf(proxy(req("/"))).value, "script-src"), "/").toMatch(/'nonce-/);
    checked++;
    console.log(`[unchanged: nonce classes] paths checked: ${checked}`);
    expect(checked).toBe(LOOKALIKES.length + 2);
  });

  it("/live and /embed: still forced report-only with their nonce policy, still no Set-Cookie", () => {
    vi.stubEnv("CSP_MODE", "enforce");
    let checked = 0;
    for (const path of ["/live/a/b", "/embed/x"]) {
      const res = proxy(req(path, "seazn_session=tok"));
      const csp = cspOf(res);
      expect(csp.name, path).toBe("Content-Security-Policy-Report-Only");
      expect(directive(csp.value, "script-src"), path).toMatch(/'nonce-[^']+' 'strict-dynamic'/);
      expect(res.headers.getSetCookie(), path).toEqual([]);
      checked++;
    }
    expect(checked).toBe(2);
  });
});
