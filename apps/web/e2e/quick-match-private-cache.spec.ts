import { expect, request as apiRequest, test, type Page } from "@playwright/test";
import { TAG } from "./helpers";
import { consentedAnonymousState } from "./scorepad-a11y-kit";

// Owner 2026-11-13 ("ok add the test"). The marketing home (`/`, `/<lang>`) and `/<lang>/play` render THIS visitor's own
// quick-match links (the recent strip, the Continue card), and `/q/<token>` is a private match home. They are safe behind
// Cloudflare only because the origin answers them with `Cache-Control: private, no-cache, no-store` (verified on stg
// 2026-11-13; the zone has no rule caching these paths). If one ever turned ISR/static-cacheable (a `revalidate` export,
// `dynamic = "force-static"`, losing the per-request cookie read, a header override), a CDN could serve one visitor's
// links to the next. This test fails in that case. Its source-text twin, which catches the intent without a build, is
// src/app/__tests__/private-pages-dynamic.test.ts.
//
// Each page is checked twice over: (a) the HTML really carries the private thing — the visitor's own link, anchored on
// `="` (AGENTS.md: React serialises an omitted prop as "$undefined", so a bare probe can pass either way) — and a visitor
// without the cookie gets the same page WITHOUT it, which is what makes the page private at all; (b) the response's
// Cache-Control says `private` and `no-store` and never `public` or `s-maxage`.
//
// Server mode matters, and the dev case is NOT a trivial pass: in this Next (16.3), `next dev` answers EVERY page with
// `no-cache, must-revalidate` (`no-store` on an HMR refresh) — node_modules/next/dist/build/templates/app-page-runtime.js,
// the `routeModule.isDev` branch — so (b) would FAIL against a dev server, for want of `private`. This suite never runs
// one: playwright.config.ts requires a pre-compiled production server and e2e.yml builds and `next start`s one for every
// job (E2E_PROD_TARGET=1). This file is in the `parallel` project's catch-all "rest" slice (no SERIAL_SPECS or
// PARALLEL_HEAVY name), so CI's prod-build `rest` legs run it.

const NAV_MS = 20_000;

/** A guest makes a quick match through the setup form (badminton, as quick-match.spec.ts's `createFromSetup` does; a
 *  spec cannot import another spec) and lands on its home. Returns the home token. */
async function createAsGuest(page: Page, name: string): Promise<string> {
  await page.goto("/en/play");
  const form = page.getByTestId("qm-setup-form");
  await expect(form).toBeVisible();
  // The hydration signal: Start is live before the script runs (the no-script path); once it runs, blank rows disable it.
  await expect(page.getByTestId("qm-start")).toBeDisabled();
  await form.getByText("Badminton", { exact: true }).click();
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("Side 1", { exact: true }).fill("Ravi & Sam");
  await form.getByLabel("Side 2", { exact: true }).fill("Priya & Tom");
  await page.getByTestId("qm-start").click();
  await page.waitForURL(/\/q\/qm_[^/?#]+$/, { timeout: NAV_MS });
  return new URL(page.url()).pathname.replace(/^\/q\//, "");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The response's Cache-Control as its directives, lower-cased: `private, no-cache` → ["private", "no-cache"]. */
function directives(cacheControl: string): string[] {
  return cacheControl
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

test("private quick-match pages: the visitor's own link is in the HTML, and the response is never shared-cacheable (/, /en, /en/play, /q/<token>)", async ({ browser }, info) => {
  const baseURL = info.project.use.baseURL;
  const guest = await browser.newContext({ storageState: await consentedAnonymousState(), baseURL });
  // A second visitor: no visitor cookie, no session. The strip pages must NOT carry the guest's link for them.
  const stranger = await apiRequest.newContext({ baseURL });
  try {
    const page = await guest.newPage();
    const token = await createAsGuest(page, `e2e private cache ${TAG}`);
    expect(token, "the home token's shape (quick-match-tokens.ts: qm_ + 43 base64url)").toMatch(/^qm_[A-Za-z0-9_-]{43}$/);
    const visitor = (await guest.cookies()).find((c) => c.name === "seazn_qm_visitor");
    expect(visitor?.httpOnly, "the create left the visitor cookie the strip is read from").toBe(true);

    // The link the strip and the Continue card render (routes.quickMatch), as an attribute value.
    const ownLink = `href="/q/${token}"`;
    const pages = [
      { path: "/", shows: "the recent strip", carries: (html: string) => html.includes(ownLink), privateToVisitor: true },
      { path: "/en", shows: "the recent strip", carries: (html: string) => html.includes(ownLink), privateToVisitor: true },
      { path: "/en/play", shows: "the Continue card", carries: (html: string) => html.includes(ownLink), privateToVisitor: true },
      // The match's own home: its posts (Score, Save) are the home's path plus a step, so the token is in an attribute.
      // Not private to the visitor (the token IS the capability), so no stranger check; private to the URL's holder.
      {
        path: `/q/${token}`,
        shows: "its own posts",
        carries: (html: string) => new RegExp(`="/q/${escapeRe(token)}/`).test(html),
        privateToVisitor: false,
      },
    ] as const;

    let checked = 0;
    let strangerChecked = 0;
    for (const p of pages) {
      // page.request shares the guest context's cookies, so this is the guest's own request for the page.
      const res = await page.request.get(p.path, { maxRedirects: 0 });
      expect(res.status(), `${p.path}: served directly`).toBe(200);
      const html = await res.text();
      // (a) Anti-vacuity: the page really carries the private thing, or the header check below proves nothing.
      expect(p.carries(html), `${p.path}: ${p.shows} carries this match's link (${token})`).toBe(true);

      // (b) The header a CDN obeys. A dev server fails here, never passes trivially (see the header comment).
      const cc = res.headers()["cache-control"] ?? "";
      const d = directives(cc);
      const why = `${p.path} Cache-Control "${cc}" (a \`next dev\` server sends "no-cache, must-revalidate": run against a production build)`;
      expect(d, `${why}: must be private`).toContain("private");
      expect(d, `${why}: must be no-store`).toContain("no-store");
      expect(d, `${why}: never public`).not.toContain("public");
      expect(d.filter((x) => x.startsWith("s-maxage")), `${why}: never s-maxage (a shared-cache lifetime)`).toEqual([]);
      checked += 1;

      if (p.privateToVisitor) {
        // The pair of (a): the same page for someone else does not carry the guest's link, so the content IS per-visitor.
        const other = await stranger.get(p.path, { maxRedirects: 0 });
        expect(other.status(), `${p.path}: served directly to a stranger`).toBe(200);
        const otherHtml = await other.text();
        expect(otherHtml.length, `${p.path}: the stranger got a page`).toBeGreaterThan(1000);
        expect(p.carries(otherHtml), `${p.path}: a visitor without the cookie never sees this match's link`).toBe(false);
        strangerChecked += 1;
      }
    }
    expect(checked, "anti-vacuity: private pages checked").toBe(pages.length);
    expect(checked).toBeGreaterThan(0);
    expect(strangerChecked, "anti-vacuity: per-visitor pages checked from a second visitor").toBe(3);
  } finally {
    await stranger.dispose();
    await guest.close();
  }
});
