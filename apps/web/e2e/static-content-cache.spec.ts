import { expect, test, type Page } from "@playwright/test";
import { dismissCookieBanner } from "./scorepad-a11y-kit";

// Blog P2 Task 5 (owner ruling 2026-11-19): /help and /blog are cached at Cloudflare's edge and handed to every visitor,
// so each response must be one that is correct for every visitor, and the page must still work under its fixed policy.
//
//   - the edge headers: `s-maxage` at the route's `revalidate` (typed from the design: 300 where the plan table is read,
//     3600 elsewhere), nothing private, no Set-Cookie even for a request carrying a session, and a CSP with no nonce that
//     is byte-identical from one request to the next; an app page keeps its per-request nonce;
//   - in a browser, the islands run under that policy with ZERO `securitypolicyviolation` events (a report-only policy
//     fires them too, so this holds in either CSP_MODE) and zero console errors: the nav's signed-in swap and the help
//     search;
//   - the hint cookie the swap reads still reaches a cached page (it is the browser's, path /), and signing out clears it.
//
// Run against a production build (CI's e2e serves the standalone server.js); `next dev` renders everything dynamically.
// Desktop only: this is response headers and hydration, not layout.

const ARTICLE = "/help/getting-started/start-scoring"; // a plain article (no plan token: prerendered), in the plan-reading route
const TOKEN_ARTICLE = "/help/registration/card-payments"; // carries a plan token: not prerendered, rendered on first request
const POST = "/blog/how-standings-points-work";
const EDGE: [path: string, sMaxage: number][] = [
  ["/help", 3600],
  [ARTICLE, 300],
  [TOKEN_ARTICLE, 300],
  ["/help/formats", 300],
  ["/help/formats/knockout", 300],
  ["/blog", 3600],
  [POST, 3600],
];

const cspOf = (h: Record<string, string>) => h["content-security-policy"] ?? h["content-security-policy-report-only"] ?? null;

test.describe("the edge response", () => {
  test("every help and blog page: s-maxage at its revalidate, no Set-Cookie for any visitor, one nonce-free policy", async ({ playwright, baseURL }) => {
    const ctx = await playwright.request.newContext({ baseURL: baseURL!, storageState: { cookies: [], origins: [] } });
    let checked = 0;
    let staleSeen = 0;
    for (const [path, sMaxage] of EDGE) {
      // A page older than its revalidate is first served STALE while Next regenerates it, and Next 16.3.6 sends that
      // answer with NO Cache-Control (measured, fix round 1b: the edge rule bypasses a response without one, so it is
      // never stored). Wait for the regenerated page, so the run does not depend on how long ago the build was.
      for (let tries = 0; ; tries++) {
        const warm = await ctx.get(path, { maxRedirects: 0 });
        if (warm.headers()["x-nextjs-cache"] !== "STALE") break;
        staleSeen++;
        expect(warm.headers()["cache-control"] ?? "", `${path}: a STALE answer is not stored`).not.toMatch(/s-maxage/);
        expect(warm.headers()["set-cookie"], `${path}: no Set-Cookie on a STALE answer`).toBeUndefined();
        expect(tries, `${path}: still STALE after regeneration`).toBeLessThan(20);
        await new Promise((r) => setTimeout(r, 250));
      }
      // A stranger, then a session with no hint: the request that gets a Set-Cookie on an app page.
      const anon = await ctx.get(path, { maxRedirects: 0 });
      const session = await ctx.get(path, { maxRedirects: 0, headers: { cookie: "seazn_session=e2e-probe" } });
      for (const [who, res] of [["anonymous", anon], ["session", session]] as const) {
        expect(res.status(), `${path} ${who}`).toBe(200);
        const h = res.headers();
        const cc = h["cache-control"] ?? "";
        expect(cc, `${path} ${who}: Cache-Control`).toMatch(new RegExp(`^s-maxage=${sMaxage}(,|$)`));
        expect(cc, `${path} ${who}`).not.toMatch(/private|no-store|no-cache/);
        expect(h["set-cookie"], `${path} ${who}: no Set-Cookie on a response the edge stores`).toBeUndefined();
        const csp = cspOf(h);
        expect(csp, `${path} ${who}: a policy`).not.toBeNull();
        expect(csp, `${path} ${who}`).not.toContain("nonce-");
        expect(csp, `${path} ${who}`).toMatch(/(^|; )script-src 'self' 'unsafe-inline'(;| |$)/);
      }
      expect(cspOf(session.headers()), `${path}: the same policy for every visitor`).toBe(cspOf(anon.headers()));
      checked++;
    }
    // A flight (RSC) request for the HTML URL never gets a cacheable flight payload under that URL: Cloudflare ignores
    // Vary, so it would be served to the next visitor as the page. Next checks the `_rsc` hash and redirects instead
    // (`experimental.validateRSCRequestHeaders`, set explicitly in next.config.js).
    for (const path of ["/help", POST]) {
      const flight = await ctx.get(path, { maxRedirects: 0, headers: { rsc: "1" } });
      expect(flight.status(), `${path} rsc:1 without _rsc`).toBe(307);
      // To `?_rsc=<hash>` (`?_rsc` alone when the request carries no router headers): a cache key of its own.
      expect(flight.headers()["location"] ?? "", `${path}: redirected to a hashed URL`).toMatch(/[?&]_rsc(=|$)/);
      expect(flight.headers()["content-type"] ?? "", `${path}: no flight body`).not.toContain("text/x-component");
      expect(flight.headers()["cache-control"] ?? "", `${path}: the redirect is not stored`).not.toMatch(/s-maxage/);
    }
    // A miss is never stored: the help article route renders its 404 with the route's `s-maxage=300`, and the writeHead
    // guard (server/public-site/error-no-store.ts, installed by instrumentation.ts register()) rewrites it. That needs
    // the compiled instrumentation.js, which the standalone trace drops: Dockerfile and CI overlay `.next/server`.
    for (const path of ["/help/no-such-page", "/blog/no-such-post"]) {
      const miss = await ctx.get(path, { maxRedirects: 0, headers: { cookie: "seazn_session=e2e-probe" } });
      expect(miss.status(), path).toBe(404);
      expect(miss.headers()["cache-control"], `${path}: a 404 is not stored`).toBe("private, no-cache, no-store, max-age=0, must-revalidate");
      expect(miss.headers()["set-cookie"], `${path}: no Set-Cookie on a 404 either`).toBeUndefined();
    }
    // The control: an app page keeps a fresh nonce per request and is not stored.
    const a = cspOf((await ctx.get("/login")).headers());
    const b = cspOf((await ctx.get("/login")).headers());
    expect(a, "/login: a nonce policy").toMatch(/'nonce-[^']+'/);
    expect(b, "/login: a new nonce per request").not.toBe(a);
    console.log(`[edge] help and blog pages checked: ${checked} (STALE answers waited out: ${staleSeen})`);
    expect(checked).toBe(EDGE.length);
    await ctx.dispose();
  });
});

/** Records every CSP violation (report-only ones included) and every console error from the first script on. */
async function watch(page: Page): Promise<() => Promise<{ violations: string[]; errors: string[] }>> {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (e) => seen.push(`${e.disposition} ${e.effectiveDirective} ${e.blockedURI}`));
  });
  return async () => ({ violations: await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations), errors });
}

async function visit(page: Page, path: string) {
  await page.setViewportSize({ width: 1280, height: 900 });
  const res = await page.goto(path);
  expect(res?.status(), path).toBe(200);
  await dismissCookieBanner(page);
}

// The default project state is a real signed-in session (auth.setup.ts), so both cookies are in the browser.
test.describe("in a browser, under the fixed policy", () => {
  test("help and blog hydrate with no CSP violation and no console error: the Dashboard swap and the help search run", async ({ page }) => {
    const read = await watch(page);
    let checked = 0;
    for (const path of ["/help", TOKEN_ARTICLE, "/blog", POST]) {
      await visit(page, path);
      await expect(page.locator("[data-mk-nav]").getByRole("link", { name: /Dashboard/ }), `${path}: the swap ran`).toBeVisible();
      checked++;
    }
    await visit(page, "/help");
    const box = page.getByRole("searchbox", { name: "Search help" });
    await box.fill("waitlist");
    await expect(page.getByRole("list", { name: "Search results" }).locator('a[href="/help/registration/waitlist"]'), "the search island ran").toBeVisible();
    const { violations, errors } = await read();
    expect(violations, "CSP violations").toEqual([]);
    expect(errors, "console errors").toEqual([]);
    console.log(`[browser] pages hydrated: ${checked + 1}`);
    expect(checked).toBe(4);
  });

  test("the hint reaches a cached page, and signing out clears it: Dashboard, then Log in", async ({ page }) => {
    await visit(page, "/blog");
    const bar = page.locator("[data-mk-nav]");
    await expect(bar.getByRole("link", { name: /Dashboard/ })).toBeVisible();
    expect((await page.context().cookies()).some((c) => c.name === "seazn_signed_in" && c.value === "1"), "the hint is in the browser").toBe(true);
    // Sign out the way the app does (POST /api/auth/logout), in this test's own context: the stored state is untouched.
    const out = await page.request.post("/api/auth/logout");
    expect(out.ok()).toBe(true);
    expect((await page.context().cookies()).some((c) => c.name === "seazn_signed_in"), "the hint is gone").toBe(false);
    await visit(page, "/help");
    await expect(page.locator("[data-mk-nav]").getByRole("link", { name: "Log in" })).toBeVisible();
    await expect(page.locator("[data-mk-nav]").getByRole("link", { name: /Dashboard/ })).toHaveCount(0);
  });
});
