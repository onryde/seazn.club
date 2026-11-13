// Sponsor deals T22 - where /r/sponsor/invoice/<token> lands and how it is served, modelled on the report's
// (../../../[token]/__tests__/route-shape.test.ts). Judged by Next's OWN code, never by a rule typed here: the app's real page
// files under app/(public)/r in the order a server tries them (`getSortedRoutes`), each matched by
// `getRouteMatcher(getRouteRegex(…))`; the proxy matcher by `unstable_doesMiddlewareMatch`. Results:
//   - /r/sponsor/invoice/<token> is the invoice; /r/sponsor/<report token> is still the report and /r/<ref> the registration
//     lookup - the static `invoice` segment takes nothing from either;
//   - proxy runs on the invoice page and its two handlers, and none of them is CDN-cacheable;
//   - the page and both handlers are `force-dynamic`, and the pay handler answers POST only (a crawler, a link preview or a
//     prefetch never opens a Checkout session).
// Sport: not applicable.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { getSortedRoutes } from "next/dist/shared/lib/router/utils/sorted-routes";
import { getRouteMatcher } from "next/dist/shared/lib/router/utils/route-matcher";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import { mintReportToken } from "@/server/sponsors/report-token";
import { invoicePath } from "@/lib/sponsor-invoice";
import { isCacheablePublicPath } from "@/proxy";

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
const { unstable_doesMiddlewareMatch } = await import("next/experimental/testing/server");
const { config } = await import("@/proxy");
// Loaded at collection: their import graphs are the invoice reader and the Stripe usecase.
const page = await import("../page");
const pdf = await import("../pdf/route");
const pay = await import("../pay/route");

const R_DIR = fileURLToPath(new URL("../../../../", import.meta.url)); // app/(public)/r/

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

function resolve(pathname: string): { route: string; params: Record<string, unknown> } | null {
  for (const route of getSortedRoutes(pagesUnderR())) {
    const params = getRouteMatcher(getRouteRegex(route))(pathname);
    if (params) return { route, params };
  }
  return null;
}

describe("/r/sponsor/invoice/[token] beside the report and the registration lookup", () => {
  it("premise: the pages under /r are the lookup, the payment page, the report and the invoice", () => {
    expect(pagesUnderR().sort()).toEqual(["/r/[ref]", "/r/pay/[token]", "/r/sponsor/[token]", "/r/sponsor/invoice/[token]"]);
  });

  it("an invoice URL is the invoice; a report URL is still the report and a reference still the lookup (counted)", () => {
    const token = mintReportToken();
    expect(invoicePath(token), "premise: the link the email carries").toBe(`/r/sponsor/invoice/${token}`);
    const cases: [string, string, Record<string, string>][] = [
      [invoicePath(token), "/r/sponsor/invoice/[token]", { token }],
      [`/r/sponsor/${token}`, "/r/sponsor/[token]", { token }],
      // Two segments with nothing after `invoice` is a report token that reads "invoice": the report's own opaque 404.
      ["/r/sponsor/invoice", "/r/sponsor/[token]", { token: "invoice" }],
      ["/r/RS-4K7Q2M", "/r/[ref]", { ref: "RS-4K7Q2M" }],
    ];
    let checked = 0;
    for (const [url, route, params] of cases) {
      expect(resolve(url), url).toEqual({ route, params });
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("served per request, never cached", () => {
  it("proxy runs on the page and its two handlers, and counts none of them CDN-cacheable", () => {
    const base = invoicePath(mintReportToken());
    let checked = 0;
    for (const url of [base, `${base}/pdf`, `${base}/pay`]) {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url }), url).toBe(true);
      expect(isCacheablePublicPath(url), url).toBe(false);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the page and both handlers are force-dynamic, with no revalidate of their own", () => {
    for (const [name, mod] of [["page", page], ["pdf", pdf], ["pay", pay]] as const) {
      expect(mod.dynamic, name).toBe("force-dynamic");
      expect("revalidate" in mod, `${name}: no revalidate export`).toBe(false);
    }
  });

  it("the PDF answers GET only and pay answers POST only: no GET that a crawler or a prefetch could follow into Stripe", () => {
    const verbs = (mod: object) => Object.keys(mod).filter((k) => /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(k)).sort();
    expect(verbs(pdf)).toEqual(["GET"]);
    expect(verbs(pay)).toEqual(["POST"]);
  });
});
