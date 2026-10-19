/**
 * Browser Sentry on the PRODUCTION build (owner decisions 2026-10-19: ON, session replay OFF, then ERRORS ONLY with the real
 * environment).
 *
 * Until then no browser Sentry ran at all: the client options sat in sentry.client.config.ts, which @sentry/nextjs bundles
 * only under webpack, and this app builds with Turbopack. src/instrumentation-client.ts now holds the Sentry.init. Unit tests
 * prove the options (sentry-client-init.test.ts) and scripts/check-client-sentry.ts proves the bundle holds the init and no
 * replay recorder or log forwarder; this spec proves the part neither can see - that the built page RUNS the init without
 * breaking:
 *
 *  - a public page, a public fixture page and the personal match room (the page that pulls in the most client code) each
 *    load on the standalone production server with a quiet console and no uncaught error;
 *  - on each, the SDK's client exists in the page and carries what the init set: the scrub processor and the scrub hooks, NO
 *    tracing option, NO log capture, NO Replay, and none of the SDK's performance/session default integrations, with the
 *    error-capture ones (global handlers, breadcrumbs, ...) still there;
 *  - the environment is the deployment's: the deploy config whose origin this build baked in (NEXT_PUBLIC_BASE_URL, read from
 *    the same env the build was made with) names it; a build with no origin (CI) is a production build, so "production";
 *  - a client-side navigation (the match room's way back, a Next Link) runs through the init's `onRouterTransitionStart`
 *    with a live client and still leaves the console quiet;
 *  - the privacy page and the sub-processors list name Sentry (what is sent, the EU data region, the legal basis) and carry
 *    the LEGAL_VERSION date, at 320, 768 and 1280 without sideways scroll.
 *
 * This build has NEXT_PUBLIC_SENTRY_DSN blank (CI and the local recipe both), so the client is created but DISABLED: nothing
 * is sent anywhere, which the spec asserts rather than assumes. What the SDK does with an enabled client is
 * sentry-client-init.test.ts's real-BrowserClient half.
 *
 * The probe reads the SDK's own global carrier (`window.__SENTRY__`), the one window into the client a page without a
 * debugger has. It is an SDK internal: a bump that moves it fails the spec on the "carrier" line, loudly, not quietly green.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { longName, seedMatchRoom } from "./match-room-kit";

test.describe.configure({ mode: "parallel" });

/** Chrome's notice about the SITE's report-only CSP header (proxy.ts, every page): not Sentry's to fix. Matched whole. */
const SITE_WIDE = new Set([
  "The Content Security Policy directive 'upgrade-insecure-requests' is ignored when delivered in a report-only policy.",
]);

/** Console errors and uncaught page errors a page logs from now on. */
function listen(page: Page): string[] {
  const seen: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !SITE_WIDE.has(m.text())) seen.push(`console: ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => seen.push(`pageerror: ${e.message.slice(0, 300)}`));
  return seen;
}

interface SentryView {
  enabled: boolean | undefined;
  environment: string | undefined;
  integrations: string[];
  /** Option keys that mean tracing, profiling, logs or replay, whatever their value. */
  forbiddenOptionKeys: string[];
  hooks: Record<"beforeSend" | "beforeSendTransaction" | "beforeBreadcrumb" | "beforeSendLog", string>;
}

/** What a deploy config says its environment is: its app ends in -prod or -stg; the origin it bakes is NEXT_PUBLIC_BASE_URL. */
function deployConfig(file: string): { environment: string; baseUrl: string } {
  const text = readFileSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url)), "utf8");
  const app = /^app\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? "";
  const baseUrl = /^\s*NEXT_PUBLIC_BASE_URL\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? "";
  const environment = app.endsWith("-prod") ? "production" : app.endsWith("-stg") ? "staging" : "";
  if (!environment || !baseUrl) throw new Error(`${file}: cannot read the app name / origin (${app} / ${baseUrl})`);
  return { environment, baseUrl };
}

/** The environment this build must report: the deployment whose origin it baked in, else a plain production build. */
function expectedEnvironment(): string {
  const baked = process.env.NEXT_PUBLIC_BASE_URL;
  const known = ["fly.toml", "fly.stg.toml"].map(deployConfig);
  return known.find((c) => c.baseUrl === baked)?.environment ?? "production";
}

/** The Sentry client as the page holds it, read from the SDK's carrier; null when the page has no Sentry client at all. */
async function sentryClient(page: Page): Promise<SentryView | null> {
  return page.evaluate(() => {
    type Opts = Record<string, unknown> & { integrations?: { name: string }[] };
    type Scope = { getClient?: () => { getOptions?: () => Opts } | undefined };
    const carrier = (globalThis as unknown as { __SENTRY__?: Record<string, unknown> }).__SENTRY__;
    if (!carrier) return null;
    const versioned = carrier[String(carrier.version)] as { defaultCurrentScope?: Scope } | undefined;
    const options = versioned?.defaultCurrentScope?.getClient?.()?.getOptions?.();
    if (!options) return null;
    const kind = (key: string) => typeof options[key];
    return {
      enabled: options.enabled as boolean | undefined,
      environment: options.environment as string | undefined,
      integrations: (options.integrations ?? []).map((i) => i.name),
      forbiddenOptionKeys: Object.keys(options).filter((k) => /trac|profil|replay|enableLogs|beforeSendLog|beforeSendTransaction/i.test(k) && options[k] !== undefined),
      hooks: {
        beforeSend: kind("beforeSend"),
        beforeSendTransaction: kind("beforeSendTransaction"),
        beforeBreadcrumb: kind("beforeBreadcrumb"),
        beforeSendLog: kind("beforeSendLog"),
      },
    };
  });
}

/** The init's shape, asserted from outside on the page as built. */
async function expectInitialised(page: Page, where: string): Promise<void> {
  const view = await sentryClient(page);
  expect(view, `${where}: window.__SENTRY__ holds no client (carrier shape moved, or Sentry.init never ran)`).not.toBeNull();
  const live = view!.integrations;
  expect(live, `${where}: the scrub processor is registered`).toContain("ScrubScoreTokens");
  // Errors only: nothing for performance, sessions, AI chats, logs or replay...
  for (const name of ["BrowserTracing", "BrowserSession", "ConversationId", "ConsoleLogs", "Replay"]) expect(live, `${where}: no ${name}`).not.toContain(name);
  expect(view!.forbiddenOptionKeys, `${where}: no tracing, profiling, log or replay option is set`).toEqual([]);
  // ...and everything that captures an error is still there.
  for (const name of ["GlobalHandlers", "BrowserApiErrors", "LinkedErrors", "Breadcrumbs", "Dedupe", "HttpContext", "NextjsClientStackFrameNormalization"]) {
    expect(live, `${where}: ${name} still captures errors`).toContain(name);
  }
  expect(view!.hooks, `${where}: both scrub hooks are functions, and there is no transaction or log hook to set`).toEqual({
    beforeSend: "function",
    beforeSendTransaction: "undefined",
    beforeBreadcrumb: "function",
    beforeSendLog: "undefined",
  });
  expect(view!.environment, `${where}: the environment is the deployment's, not NODE_ENV`).toBe(expectedEnvironment());
  expect(view!.enabled, `${where}: no DSN in this build, so the client is disabled and sends nothing`).toBe(false);
}

test("a page with no Sentry has no client for the probe to find (the probe can say no)", async ({ page }) => {
  await page.goto("about:blank");
  expect(await sentryClient(page)).toBeNull();
});

test("a public page, a public fixture page and the personal match room load on the production build with the client Sentry initialised and a quiet console", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [longName(), longName()] });
  let checked = 0;

  // A cold context for the pages a visitor sees: no session, no history.
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL: test.info().project.use.baseURL });
  const visitor = await ctx.newPage();
  const visitorErrors = listen(visitor);

  const home = await visitor.goto("/");
  expect(home?.status(), "the public home page renders").toBe(200);
  await expect(visitor.locator("main, body").first()).toBeVisible();
  await expectInitialised(visitor, "home");
  checked += 1;

  const fixture = await visitor.goto(room.fixturePath);
  expect(fixture?.status(), "the public fixture page renders").toBe(200);
  await expectInitialised(visitor, "public fixture page");
  checked += 1;

  // The personal match room, entered from the invite's link.
  const player = await ctx.newPage();
  const playerErrors = listen(player);
  const entered = await player.goto(`${room.roomPath}?t=${encodeURIComponent(room.white.token)}`);
  expect(entered?.status(), "the room renders").toBe(200);
  await expect(player.getByTestId("match-room")).toBeVisible();
  await expectInitialised(player, "match room");
  checked += 1;

  // A client-side navigation: the room's way back is a Next Link, so it goes through onRouterTransitionStart.
  await player.getByTestId("room-back").click();
  await player.waitForURL((u) => u.pathname === room.fixturePath);
  await expectInitialised(player, "after the room's client-side navigation");
  checked += 1;

  expect(checked, "anti-vacuity: four probes ran").toBe(4);
  expect(visitorErrors, "the public pages' browser console stays quiet").toEqual([]);
  expect(playerErrors, "the match room's browser console stays quiet").toEqual([]);
  await ctx.close();
});

// The privacy page and the sub-processors list name Sentry (owner ruling 2026-10-19: errors only, disclosed). The date each
// page shows is LEGAL_VERSION, read from the source that stamps consents, so a bump that forgets the page is red here too.
const LEGAL_VERSION = /LEGAL_VERSION\s*=\s*"(\d{4}-\d{2}-\d{2})"/.exec(
  readFileSync(fileURLToPath(new URL("../src/lib/legal.ts", import.meta.url)), "utf8"),
)![1]!;
const shownDate = (() => {
  const [y, m, d] = LEGAL_VERSION.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
})();

test("the privacy page and the sub-processors list name Sentry, dated with LEGAL_VERSION, without sideways scroll at 320, 768 and 1280", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL: test.info().project.use.baseURL });
  const page = await ctx.newPage();
  const errors = listen(page);
  let checked = 0;
  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });

    const privacy = await page.goto("/legal/privacy");
    expect(privacy?.status(), "the privacy page renders").toBe(200);
    await expect(page.getByText(`Last updated: ${shownDate}`)).toBeVisible();
    const report = page.locator("li", { hasText: "Error reports:" });
    await expect(report).toHaveCount(1);
    for (const phrase of ["Sentry (Functional Software, Inc.)", "EU data region", "stack trace", "We do not record your sessions"]) await expect(report).toContainText(phrase);
    await expect(page.locator("li", { hasText: "Legitimate interests" })).toContainText("error monitoring");
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `privacy at ${width}: no sideways scroll`).toBeLessThanOrEqual(width);
    checked += 1;

    const list = await page.goto("/legal/sub-processors");
    expect(list?.status(), "the sub-processors list renders").toBe(200);
    await expect(page.getByText(`Last updated: ${shownDate}`)).toBeVisible();
    const row = page.locator("tr", { hasText: "Sentry (Functional Software, Inc.)" });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Error monitoring");
    await expect(row).toContainText("EU");
    await expect(row.getByRole("link", { name: /Policy/ })).toHaveAttribute("href", "https://sentry.io/privacy/");
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `sub-processors at ${width}: no sideways scroll`).toBeLessThanOrEqual(width);
    checked += 1;
  }
  expect(checked, "anti-vacuity: both pages at three widths").toBe(6);
  expect(errors, "the legal pages' console stays quiet").toEqual([]);
  await ctx.close();
});
