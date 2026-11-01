// R4 sponsors on stream, S14 - where /r/sponsor/<token> lands and how it is served (controller addendum 2026-11-01: "check
// the static `sponsor` segment does not break /r/[ref] for a ref named sponsor; check proxy.ts treats it dynamic and
// uncached, so a revoke takes effect immediately").
//
// Judged by Next's OWN code, never by a rule typed here: the routes are the app's real page files under app/(public)/r, put in
// the order a server tries them by Next's `getSortedRoutes` (the default route matcher manager sorts dynamic routes with it,
// next/dist/server/route-matcher-managers/default-route-matcher-manager.js), each matched by `getRouteMatcher(getRouteRegex(…))`;
// the proxy matcher by `unstable_doesMiddlewareMatch`. Results:
//   - /r/sponsor/<token> is the report; /r/sponsor (a registration reference that reads "sponsor") and every other /r/<ref>
//     is still the registration lookup - `sponsor/` has no page of its own, so nothing at /r/sponsor is taken from [ref];
//   - proxy runs on the report (a per-request nonce CSP) and does NOT treat it as CDN-cacheable;
//   - the page is `force-dynamic` with no revalidate: Next's header for that is `private, no-cache, no-store, max-age=0,
//     must-revalidate` (getCacheControlHeader, revalidate 0) - nothing caches it, so a revoked link 404s on the next load.
// Sport: not applicable.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { getSortedRoutes } from "next/dist/shared/lib/router/utils/sorted-routes";
import { getRouteMatcher } from "next/dist/shared/lib/router/utils/route-matcher";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import { getCacheControlHeader } from "next/dist/server/lib/cache-control";
import { mintReportToken } from "@/server/sponsors/report-token";
import { isCacheablePublicPath } from "@/proxy";

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
const { unstable_doesMiddlewareMatch } = await import("next/experimental/testing/server");
const { config } = await import("@/proxy");
// The page module, loaded at collection (its import graph is the whole report reader: under a loaded run it outlasts a test's
// own timeout when imported inside one).
const page = await import("../page");

const R_DIR = fileURLToPath(new URL("../../../", import.meta.url)); // app/(public)/r/

/** Every page under app/(public)/r, as its route (route groups dropped). */
function pagesUnderR(): string[] {
  const found: string[] = [];
  const walk = (dir: string, route: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === "__tests__") continue;
      const sub = /^\(.*\)$/.test(e.name) ? route : `${route}/${e.name}`;
      if (fs.existsSync(path.join(dir, e.name, "page.tsx"))) found.push(sub);
      walk(path.join(dir, e.name), sub);
    }
  };
  walk(R_DIR, "/r");
  return found;
}

/** The route a server serves `pathname` with: the first of the sorted routes whose matcher takes it, and its params. */
function resolve(pathname: string): { route: string; params: Record<string, unknown> } | null {
  for (const route of getSortedRoutes(pagesUnderR())) {
    const params = getRouteMatcher(getRouteRegex(route))(pathname);
    if (params) return { route, params };
  }
  return null;
}

describe("/r/sponsor/[token] beside /r/[ref]", () => {
  it("premise: the two pages under /r are the registration lookup and the report, and `sponsor/` has no page of its own", () => {
    expect(pagesUnderR().sort()).toEqual(["/r/[ref]", "/r/sponsor/[token]"]);
  });

  it("a report URL is the report; /r/sponsor and every other reference is still the registration lookup (counted)", () => {
    const token = mintReportToken();
    const cases: [string, string, Record<string, string>][] = [
      [`/r/sponsor/${token}`, "/r/sponsor/[token]", { token }],
      ["/r/sponsor", "/r/[ref]", { ref: "sponsor" }],
      ["/r/RS-4K7Q2M", "/r/[ref]", { ref: "RS-4K7Q2M" }],
      ["/r/sponsorship", "/r/[ref]", { ref: "sponsorship" }],
    ];
    let checked = 0;
    for (const [url, route, params] of cases) {
      expect(resolve(url), url).toEqual({ route, params });
      checked++;
    }
    expect(checked).toBe(cases.length);
    // Two segments after /r/sponsor are nothing (no page takes them): Next's own 404.
    expect(resolve(`/r/sponsor/${token}/more`)).toBeNull();
  });
});

describe("served per request, never cached", () => {
  it("proxy runs on the report (its per-request CSP) and does not count it as a CDN-cacheable public path", () => {
    const url = `/r/sponsor/${mintReportToken()}`;
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true);
    expect(isCacheablePublicPath(url)).toBe(false);
    // The positive pair: the public site IS cacheable, so the predicate is live.
    expect(isCacheablePublicPath("/shared/riverside")).toBe(true);
  });

  it("the page is force-dynamic with no revalidate of its own, which Next serves as private, no-store", () => {
    expect(page.dynamic).toBe("force-dynamic");
    expect("revalidate" in page, "no revalidate export").toBe(false);
    expect(getCacheControlHeader({ revalidate: 0, expire: undefined })).toBe("private, no-cache, no-store, max-age=0, must-revalidate");
  });
});
