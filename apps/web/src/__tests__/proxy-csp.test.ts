import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy, isCacheablePublicPath } from "@/proxy";

afterEach(() => vi.unstubAllEnvs());

const page = (path: string) => new NextRequest(`http://localhost:3000${path}`);

describe("CSP vs cacheable public routes", () => {
  it("classifies the cacheable public tree", () => {
    expect(isCacheablePublicPath("/shared/riverside/summer-league")).toBe(true);
    expect(isCacheablePublicPath("/shared")).toBe(true);
    expect(isCacheablePublicPath("/embed/divisions/x/standings")).toBe(true);
    expect(isCacheablePublicPath("/dashboard")).toBe(false);
    expect(isCacheablePublicPath("/r/AB12CD")).toBe(false); // force-dynamic registration-ref tree excluded
    expect(isCacheablePublicPath("/register")).toBe(false);
    expect(isCacheablePublicPath("/magic-link")).toBe(false);
  });

  it("keeps report-only CSP on cacheable public pages even in enforce mode", () => {
    vi.stubEnv("CSP_MODE", "enforce");
    const res = proxy(page("/shared/riverside/summer-league"));
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toContain("default-src 'self'");
  });

  it("enforces on app pages when CSP_MODE=enforce", () => {
    vi.stubEnv("CSP_MODE", "enforce");
    const res = proxy(page("/dashboard"));
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("skips nonce request headers on cacheable public paths to preserve ISR", () => {
    vi.stubEnv("CSP_MODE", "enforce");
    const res = proxy(page("/shared/riverside/summer-league"));
    // x-middleware-override-headers should be null or not contain x-nonce
    const overrideHeaders = res.headers.get("x-middleware-override-headers");
    if (overrideHeaders) {
      expect(overrideHeaders).not.toContain("x-nonce");
    }
    // x-middleware-request-x-nonce should not be forwarded
    expect(res.headers.get("x-middleware-request-x-nonce")).toBeNull();
  });

  it("forwards nonce request headers on app pages for per-request CSP stamping", () => {
    vi.stubEnv("CSP_MODE", "enforce");
    const res = proxy(page("/dashboard"));
    // x-middleware-request-x-nonce should be forwarded (non-empty string)
    const nonceHeader = res.headers.get("x-middleware-request-x-nonce");
    expect(nonceHeader).toBeTruthy();
    expect(typeof nonceHeader).toBe("string");
  });
});

// R2005 A5 (change 8; compositor F-009, coordinator decision 2026-10-16): the overlay page's `connect-src` allows the
// compositor's loopback phase endpoint, on the `/overlay` tree ONLY. Driven through `proxy()` — the real call site — so
// the pathname wiring is what is proven, not `cspHeader` alone. The origin is TYPED from spec §4.3 (port 7419), never
// read from RELAY_PHASE_PORT.
describe("A5 — connect-src carries the loopback phase endpoint on /overlay only", () => {
  const LOOPBACK = "http://127.0.0.1:7419";
  const UUID = "8c4f7a52-1f3e-4b9a-9d2c-3e5f6a7b8c9d";
  // "Whichever CSP header is present": the response's own, or — on a marketing path, which `proxy()` REWRITES with the
  // policy on the forwarded request headers only (pre-existing, unchanged here) — the forwarded copy.
  const cspOf = (res: Response): string => {
    const v =
      res.headers.get("Content-Security-Policy") ??
      res.headers.get("Content-Security-Policy-Report-Only") ??
      res.headers.get("x-middleware-request-content-security-policy") ??
      res.headers.get("x-middleware-request-content-security-policy-report-only");
    if (v === null) throw new Error("no CSP header on a page response");
    return v;
  };
  const directives = (csp: string): string[] => csp.split("; ").map((d) => d.replace(/'nonce-[^']+'/g, "'nonce-*'"));
  const connectSrc = (csp: string): string[] => {
    const d = directives(csp).find((x) => x.startsWith("connect-src "));
    if (d === undefined) throw new Error(`no connect-src in ${csp}`);
    return d.split(" ").slice(1);
  };
  const OVERLAY = [`/overlay/fixtures/${UUID}`, `/overlay/fixtures/${UUID}?host=compositor`];
  const OTHERS = ["/", "/dashboard", "/shared/riverside", "/embed/divisions/x/standings", "/score/tok123", `/overlayx/fixtures/${UUID}`];

  for (const mode of ["report-only", "enforce"] as const) {
    it(`${mode}: every /overlay route carries it; no other route class does; every other directive is byte-identical`, () => {
      if (mode === "enforce") vi.stubEnv("CSP_MODE", "enforce");
      let checked = 0;
      const classes = new Set<string>();
      const dashboard = directives(cspOf(proxy(page("/dashboard")))).filter((d) => !d.startsWith("connect-src "));
      for (const path of OVERLAY) {
        const res = proxy(page(path));
        if (mode === "enforce") expect(res.headers.get("Content-Security-Policy"), `${path}: enforced`).not.toBeNull();
        const csp = cspOf(res);
        expect(connectSrc(csp), path).toContain(LOOPBACK);
        expect(directives(csp).filter((d) => !d.startsWith("connect-src ")), `${path}: other directives`).toEqual(dashboard);
        // The addition is the ONLY difference inside connect-src too.
        expect(connectSrc(csp).filter((s) => s !== LOOPBACK), path).toEqual(connectSrc(cspOf(proxy(page("/dashboard")))));
        classes.add("overlay");
        checked++;
      }
      for (const path of OTHERS) {
        const csp = cspOf(proxy(page(path)));
        expect(connectSrc(csp), path).not.toContain(LOOPBACK);
        expect(csp.includes("127.0.0.1"), `${path}: no loopback anywhere in the policy`).toBe(false);
        classes.add(path.split("/")[1] || "root");
        checked++;
      }
      console.log(`[${mode}] routes checked: ${checked}`);
      expect(checked).toBe(OVERLAY.length + OTHERS.length);
      expect([...classes].sort()).toEqual(["dashboard", "embed", "overlay", "overlayx", "root", "score", "shared"]);
    });
  }
});
