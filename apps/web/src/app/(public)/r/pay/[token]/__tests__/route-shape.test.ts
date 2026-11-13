// Player payment page, Task 4 (plan 2026-11-11-player-payment-page) - where /r/pay/<token> lands and how it is served, modelled on the
// sponsor invoice's route-shape suite. Judged by Next's OWN code, never by a rule typed here: the app's real page files under
// app/(public)/r in the order a server tries them (`getSortedRoutes`), each matched by `getRouteMatcher(getRouteRegex(...))`; the
// proxy matcher by `unstable_doesMiddlewareMatch`. Results:
//   - /r/pay/<token> is the payment page; /r/<ref> is still the registration lookup and /r/sponsor/<token> the sponsor report;
//   - proxy runs on the page and its Pay handler, and neither is CDN-cacheable;
//   - the page and the handler are `force-dynamic`, the page's head is noindex / no-referrer, and the Pay handler answers POST only
//     (a crawler, a link preview or a prefetch never opens a Checkout session).
// Sport: not applicable.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { getSortedRoutes } from "next/dist/shared/lib/router/utils/sorted-routes";
import { getRouteMatcher } from "next/dist/shared/lib/router/utils/route-matcher";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import { mintPayToken } from "@/server/usecases/registrations";
import { registrationPayPath } from "@/lib/registration-pay";
import { isCacheablePublicPath } from "@/proxy";

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
const { unstable_doesMiddlewareMatch } = await import("next/experimental/testing/server");
const { config } = await import("@/proxy");
const page = await import("../page");
const notFoundPage = await import("../not-found");
const pay = await import("../pay/route");

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

function resolve(pathname: string): { route: string; params: Record<string, unknown> } | null {
  for (const route of getSortedRoutes(pagesUnderR())) {
    const params = getRouteMatcher(getRouteRegex(route))(pathname);
    if (params) return { route, params };
  }
  return null;
}

describe("/r/pay/[token] beside the registration lookup and the sponsor report", () => {
  it("premise: the pages under /r include the lookup, the report and the payment page", () => {
    expect(pagesUnderR()).toEqual(expect.arrayContaining(["/r/[ref]", "/r/sponsor/[token]", "/r/pay/[token]"]));
  });

  it("a pay URL is the payment page; a reference is still the lookup and a sponsor token still the report (counted)", () => {
    const { token } = mintPayToken();
    expect(registrationPayPath(token), "premise: the link the mail carries").toBe(`/r/pay/${token}`);
    const cases: [string, string, Record<string, string>][] = [
      [registrationPayPath(token), "/r/pay/[token]", { token }],
      [`/r/sponsor/${token}`, "/r/sponsor/[token]", { token }],
      ["/r/RS-4K7Q2M", "/r/[ref]", { ref: "RS-4K7Q2M" }],
      // One segment with nothing after `pay` is a reference that reads "pay": the lookup's own answer, never this page.
      ["/r/pay", "/r/[ref]", { ref: "pay" }],
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
  it("proxy runs on the page and its Pay handler, and counts neither CDN-cacheable", () => {
    const base = registrationPayPath(mintPayToken().token);
    let checked = 0;
    for (const url of [base, `${base}/pay`]) {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url }), url).toBe(true);
      expect(isCacheablePublicPath(url), url).toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the page and the handler are force-dynamic, with no revalidate of their own", () => {
    for (const [name, mod] of [["page", page], ["pay", pay]] as const) {
      expect(mod.dynamic, name).toBe("force-dynamic");
      expect("revalidate" in mod, `${name}: no revalidate export`).toBe(false);
    }
  });

  it("Pay answers POST only: no GET that a crawler or a prefetch could follow into Stripe", () => {
    const verbs = (mod: object) => Object.keys(mod).filter((k) => /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(k)).sort();
    expect(verbs(pay)).toEqual(["POST"]);
  });
});

describe("the head: never indexed, never a Referer", () => {
  it("the page and its 404 are noindex, nofollow and no-referrer", async () => {
    for (const [name, generate] of [["page", page.generateMetadata], ["not-found", notFoundPage.generateMetadata]] as const) {
      const meta = await generate();
      expect(meta.robots, name).toEqual({ index: false, follow: false });
      expect(meta.referrer, name).toBe("no-referrer");
    }
  });
});
