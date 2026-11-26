import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { footerCols } from "@/components/marketing-footer";
import { LOCALES } from "@/lib/i18n-constants";

/**
 * The footer's /affiliates link is UN-prefixed, and only an allow-list of
 * marketing paths in proxy.ts is rewritten under /[lang]. A link nobody
 * rewrites is a 404 — which shipped once, past a green footer test that only
 * checked the link EXISTED. So the href is taken from the footer itself and
 * driven through the real proxy, per locale.
 */
const req = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: cookie ? { cookie } : {} });
const rewriteTarget = (res: Response) =>
  new URL(res.headers.get("x-middleware-rewrite") ?? "http://x/none").pathname;

describe("footer /affiliates link resolves through the proxy", () => {
  const href = footerCols(true).flatMap((c) => c.links).find((l) => l.requiresRevshare)?.href;

  it("the footer has exactly one revshare-gated link to drive (anti-vacuity)", () => {
    expect(href).toBeTruthy();
    expect(footerCols(true).flatMap((c) => c.links).filter((l) => l.requiresRevshare)).toHaveLength(1);
  });

  it("is rewritten under the resolved locale for every locale, keeping the path", () => {
    let checked = 0;
    for (const lang of LOCALES) {
      expect(rewriteTarget(proxy(req(href!, `seazn_locale=${lang}`)))).toBe(`/${lang}${href}`);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("an unprefixed path that is NOT on the allow-list is not rewritten (negative pair)", () => {
    expect(rewriteTarget(proxy(req("/definitely-not-a-marketing-page", "seazn_locale=fr")))).toBe("/none");
  });
});

// tracking.js runs on affiliate landings only (lib/revshare-script.ts) and posts to its own API. The marketing pages
// carry the nonce policy, so that policy must let it connect there - and nowhere the script cannot run.
describe("connect-src names revshare.so exactly where the tracking script may run", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const connect = (path: string) => {
    const res = proxy(req(path));
    const csp = res.headers.get("content-security-policy") ?? res.headers.get("content-security-policy-report-only") ?? "";
    return csp.split("; ").find((d) => d.startsWith("connect-src "))?.split(" ") ?? [];
  };
  const LANDINGS = ["/en", "/fr/pricing", "/nl/start", "/es/sports/cricket", "/fr/product/streaming", "/en/affiliates", "/blog", "/help/a"];
  // The unprefixed marketing paths are answered by the [lang] rewrite, which sets no policy on this first pass. The
  // built server runs the proxy AGAIN on the URL it rewrote to, and that pass writes the policy the browser gets (seen on
  // a local prod build; e2e/revshare-attribution.spec.ts's `/` landing covers it). So both passes are driven here.
  const REWRITTEN = ["/", "/pricing", "/start", "/sports/cricket", "/product/streaming", "/affiliates"];
  const ELSEWHERE = ["/dashboard", "/admin/capture-records", "/login", "/magic-link", "/score/tok", "/claim/tok", "/start/claim", "/live/club/cup"];

  it.each(["enforce", "report-only"])("revshare on, CSP_MODE=%s: landings only, listed once", (mode) => {
    vi.stubEnv("CSP_MODE", mode);
    vi.stubEnv("NEXT_PUBLIC_REVSHARE_ENABLED", "1");
    let checked = 0;
    for (const path of LANDINGS) {
      expect(connect(path).filter((o) => o === "https://www.revshare.so"), path).toHaveLength(1);
      checked++;
    }
    for (const path of ELSEWHERE) {
      expect(connect(path).length, `${path}: a connect-src was read`).toBeGreaterThan(1);
      expect(connect(path), path).not.toContain("https://www.revshare.so");
      checked++;
    }
    for (const path of REWRITTEN) {
      const target = rewriteTarget(proxy(req(path)));
      expect(target, `${path}: premise, it is rewritten`).toMatch(/^\/en(\/|$)/);
      expect(connect(target), `${path} -> ${target}`).toContain("https://www.revshare.so");
      checked++;
    }
    expect(checked).toBe(LANDINGS.length + ELSEWHERE.length + REWRITTEN.length);
  });

  it("revshare off: nowhere", () => {
    vi.stubEnv("NEXT_PUBLIC_REVSHARE_ENABLED", "0");
    let checked = 0;
    for (const path of [...LANDINGS, ...ELSEWHERE]) {
      expect(connect(path).length, path).toBeGreaterThan(1);
      expect(connect(path), path).not.toContain("https://www.revshare.so");
      checked++;
    }
    expect(checked).toBe(LANDINGS.length + ELSEWHERE.length);
  });
});
