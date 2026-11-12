// Cloudflare Turnstile: the widget is a script from, and an iframe of, challenges.cloudflare.com
// (developers.cloudflare.com/turnstile/get-started/client-side-rendering). So the policy gains that one origin in script-src
// (the loader's `api.js`) and frame-src (the challenge iframe), and nowhere else: the iframe does its own network traffic, the
// parent page makes no request to Cloudflare, so connect-src, default-src and img-src stay as they were.
//
// The origin the policy must allow is read from the loader's own URL (lib/turnstile-client.ts `TURNSTILE_SCRIPT_SRC`), the one
// thing the page really requests, so a URL change and a policy that did not follow cannot both stay green (an inert seam: a widget
// that is declared, unit-green and blocked by the browser the day CSP_MODE=enforce is on).
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { cspHeader, proxy } from "../proxy";
import { TURNSTILE_SCRIPT_SRC } from "../lib/turnstile-client";

afterEach(() => vi.unstubAllEnvs());

const directives = (csp: string): Map<string, string[]> =>
  new Map(csp.split("; ").map((d) => { const [name, ...values] = d.replace(/'nonce-[^']+'/g, "'nonce-*'").split(" "); return [name!, values] as const; }));
const policy = () => directives(cspHeader("n").value);
const ORIGIN = new URL(TURNSTILE_SCRIPT_SRC).origin;

describe("CSP for the Turnstile widget", () => {
  it("the origin under test is Cloudflare's challenge host (a typed literal, so a wrong loader URL cannot make this vacuous)", () => {
    expect(ORIGIN).toBe("https://challenges.cloudflare.com");
  });

  it("script-src and frame-src carry it, and a host the page does not request is not there", () => {
    const p = policy();
    expect(p.get("script-src")).toContain(ORIGIN);
    expect(p.get("frame-src")).toContain(ORIGIN);
    expect(p.get("script-src")).not.toContain("https://evil.example");
    expect(p.get("frame-src")).not.toContain("https://evil.example");
    // 'strict-dynamic' is what actually admits the script the nonced bundle appends; the explicit origin must not displace it.
    expect(p.get("script-src")).toContain("'strict-dynamic'");
    expect(p.get("script-src")).toContain("'nonce-*'");
  });

  it("no other directive names it: connect-src, default-src, img-src, form-action and frame-ancestors stay put", () => {
    let checked = 0;
    for (const [name, values] of policy()) {
      checked++;
      if (name === "script-src" || name === "frame-src") continue;
      expect(values.filter((v) => /cloudflare\.com$/.test(v) && !/realtime\.cloudflare\.com$/.test(v)), `${name} must not move`).toEqual([]);
    }
    expect(checked, "anti-vacuity: every directive was inspected").toBeGreaterThanOrEqual(10);
  });

  it("the existing frame sources and the Stripe script origin survive beside it", () => {
    const p = policy();
    expect(p.get("script-src")).toContain("https://js.stripe.com");
    for (const origin of ["https://js.stripe.com", "https://*.stripe.com", "https://hooks.stripe.com", "https://www.youtube-nocookie.com", "https://youtube-nocookie.com"]) {
      expect(p.get("frame-src"), origin).toContain(origin);
    }
  });

  it("a real page response carries it through proxy() (the real call site), report-only and enforced", () => {
    const headerOf = (res: Response) =>
      res.headers.get("Content-Security-Policy") ?? res.headers.get("Content-Security-Policy-Report-Only") ?? "";
    let checked = 0;
    for (const mode of ["", "enforce"]) {
      vi.stubEnv("CSP_MODE", mode);
      // /start is not here: it is a marketing path that proxy() rewrites to /<locale>/start WITHOUT a response CSP header (the nonce
      // rides the request only), so no policy is enforced on it either way (proxy.ts, MARKETING_UNPREFIXED); not this change's to alter.
      for (const path of ["/login", "/live/riverside/summer-league/register", "/live/riverside/summer-league/register/status"]) {
        const csp = headerOf(proxy(new NextRequest(`http://localhost:3000${path}`)));
        const d = directives(csp);
        checked++;
        expect(d.get("script-src"), `${mode || "report-only"} ${path} script-src`).toContain(ORIGIN);
        expect(d.get("frame-src"), `${mode || "report-only"} ${path} frame-src`).toContain(ORIGIN);
      }
    }
    expect(checked, "anti-vacuity: 2 modes x 3 pages").toBe(6);
  });
});
