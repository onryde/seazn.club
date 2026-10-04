// The browser a case runs in. One chromium per run (openBrowser), one fresh
// context per case (newCaseBrowser): the case's session cookies, its width's
// viewport, en, and the bench's consent pre-answer (ruling 38: imported from
// tap-play.ts, not copied), which keeps the banner off the controls and stops
// a local server reporting the harness's clicks to the live PostHog project.
//
// Its environment failures (no chromium installed, a refused cookie) are the
// runner's to report as an ABORT, never a case red. session.test.ts proves the
// wiring against a structural fake Browser; the launch is proven live (Task 8).
import { chromium, type Browser, type Page } from "playwright";
import { CONSENT_SEED, seedConsent } from "../../../../scripts/bench/lib/tap-play.ts";
import type { BrowserWidth } from "../widths.ts";
import { viewportFor } from "./viewports.ts";

/** apps/web/src/lib/auth.ts COOKIE_NAME (text-pinned by session.test.ts). */
export const SESSION_COOKIE = "seazn_session";
/** Where a fresh sign-in lands (auth.ts postAuthLanding; app/onboarding). */
export const ONBOARDING_PATH = "/onboarding";

export class NoSessionCookie extends Error {
  constructor(names: readonly string[]) {
    super(`browser: the session jar carries no ${SESSION_COOKIE} (it holds: ${names.length === 0 ? "nothing" : names.join(", ")}) — the case would click as nobody`);
    this.name = "NoSessionCookie";
  }
}

export class OnboardingRefused extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`browser: POST /api/onboarding/complete answered HTTP ${status} — the case's user cannot leave onboarding`);
    this.name = "OnboardingRefused";
    this.status = status;
  }
}

export interface CaseBrowser { page: Page; close(): Promise<void> }

export async function openBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

/** Every cookie in the jar, scoped to the base's ORIGIN (a base with a path
 *  would otherwise scope the cookies to that path). Refuses a jar without the
 *  session cookie. */
export function contextCookies(base: string, jar: Readonly<Record<string, string>>): { name: string; value: string; url: string }[] {
  const session = jar[SESSION_COOKIE];
  if (typeof session !== "string" || session === "") throw new NoSessionCookie(Object.keys(jar));
  const url = new URL(base).origin;
  return Object.entries(jar).map(([name, value]) => ({ name, value, url }));
}

export async function newCaseBrowser(browser: Browser, o: { base: string; cookies: Readonly<Record<string, string>>; width: BrowserWidth }): Promise<CaseBrowser> {
  // Both refusals happen before anything opens.
  const cookies = contextCookies(o.base, o.cookies);
  const viewport = { ...viewportFor(o.width) };
  const context = await browser.newContext({ viewport, locale: "en", baseURL: o.base });
  try {
    await context.addCookies(cookies);
    await context.addInitScript(seedConsent, CONSENT_SEED);
    const page = await context.newPage();
    return { page, close: () => context.close() };
  } catch (e) {
    await context.close().catch(() => undefined);
    throw e;
  }
}

/** The page surface ensureOnboarded uses; a Playwright Page meets it. */
export interface OnboardPage {
  url(): string;
  request: { post(url: string, o: { data: unknown }): Promise<{ ok(): boolean; status(): number }> };
}

/** When a navigation landed on the onboarding route, performs e2e's own
 *  onboarding step (apps/web/e2e/auth.setup.ts:46-47: complete, then the
 *  tour) through the page's request context, which shares the case's cookies
 *  and baseURL. Returns whether it did, so the caller navigates again. */
export async function ensureOnboarded(page: OnboardPage): Promise<boolean> {
  if (new URL(page.url()).pathname !== ONBOARDING_PATH) return false;
  const done = await page.request.post("/api/onboarding/complete", { data: {} });
  if (!done.ok()) throw new OnboardingRefused(done.status());
  await page.request.post("/api/tour", { data: {} }).catch(() => undefined);
  return true;
}
