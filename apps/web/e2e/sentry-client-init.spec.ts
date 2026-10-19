/**
 * Browser Sentry on the PRODUCTION build (owner decision 2026-10-19: ON, session replay OFF).
 *
 * Until then no browser Sentry ran at all: the client options sat in sentry.client.config.ts, which @sentry/nextjs bundles
 * only under webpack, and this app builds with Turbopack. src/instrumentation-client.ts now holds the Sentry.init. Unit tests
 * prove the options (sentry-client-init.test.ts) and scripts/check-client-sentry.ts proves the bundle holds the init and no
 * replay recorder; this spec proves the part neither can see - that the built page RUNS the init without breaking:
 *
 *  - a public page, a public fixture page and the personal match room (the page that pulls in the most client code) each
 *    load on the standalone production server with a quiet console and no uncaught error;
 *  - on each, the SDK's client exists in the page and carries the options the init set: the scrub processor, the scrub
 *    hooks, a production sample rate, and NO Replay integration and NO replay sample rate;
 *  - a client-side navigation (the match room's way back, a Next Link) runs through the init's `onRouterTransitionStart`
 *    with a live client and still leaves the console quiet.
 *
 * This build has NEXT_PUBLIC_SENTRY_DSN blank (CI and the local recipe both), so the client is created but DISABLED: nothing
 * is sent anywhere, which the spec asserts rather than assumes. What the SDK does with an enabled client is
 * sentry-client-init.test.ts's real-BrowserClient half.
 *
 * The probe reads the SDK's own global carrier (`window.__SENTRY__`), the one window into the client a page without a
 * debugger has. It is an SDK internal: a bump that moves it fails the spec on the "carrier" line, loudly, not quietly green.
 */
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
  integrations: string[];
  tracesSampleRate: number | undefined;
  hooks: Record<"beforeSend" | "beforeSendTransaction" | "beforeBreadcrumb" | "beforeSendLog", string>;
  replayOptions: string[];
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
      integrations: (options.integrations ?? []).map((i) => i.name),
      tracesSampleRate: options.tracesSampleRate as number | undefined,
      hooks: {
        beforeSend: kind("beforeSend"),
        beforeSendTransaction: kind("beforeSendTransaction"),
        beforeBreadcrumb: kind("beforeBreadcrumb"),
        beforeSendLog: kind("beforeSendLog"),
      },
      replayOptions: Object.keys(options).filter((k) => /replay/i.test(k)),
    };
  });
}

/** The init's shape, asserted from outside on the page as built. */
async function expectInitialised(page: Page, where: string): Promise<void> {
  const view = await sentryClient(page);
  expect(view, `${where}: window.__SENTRY__ holds no client (carrier shape moved, or Sentry.init never ran)`).not.toBeNull();
  expect(view!.integrations, `${where}: the scrub processor is registered`).toContain("ScrubScoreTokens");
  expect(view!.integrations, `${where}: no Replay integration`).not.toContain("Replay");
  expect(view!.replayOptions, `${where}: no replay option of any kind`).toEqual([]);
  expect(view!.hooks, `${where}: every scrub hook is a function`).toEqual({
    beforeSend: "function",
    beforeSendTransaction: "function",
    beforeBreadcrumb: "function",
    beforeSendLog: "function",
  });
  expect(view!.tracesSampleRate, `${where}: a production sample rate (the dev rate is 1)`).toBeGreaterThan(0);
  expect(view!.tracesSampleRate).toBeLessThan(1);
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
