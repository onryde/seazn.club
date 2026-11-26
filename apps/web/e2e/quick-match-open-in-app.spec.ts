// "Score in app" on the quick match home (owner 2026-11-26, two taps; spec
// docs/superpowers/specs/2026-11-25-open-in-app-web-design.md §5.6), in a real browser against the real server. The unit
// suites hold the island's states (components/quick-match/__tests__/hero-score.test.tsx) and the route's two answers
// (app/q/[token]/__tests__/score-route.test.ts). This file holds what neither can see: who is shown the button once CSS
// and hydration have run, what the BROWSER sends between the two taps, what lands in the address bar, history and
// storage, that tap two is a real navigation of the same tab to the real /app/score page, and that the real server grants
// no other origin the header.
//
// THE LINK IS A LIVE SCORING CREDENTIAL: until the person's own second tap, no request this browser makes may carry it,
// anywhere.
//
// THE BUTTON IS BEHIND A BUILD FLAG (`NEXT_PUBLIC_OPEN_IN_APP`, baked into the client bundle). This runner reads the same
// variable. Under CI it must be "1": the beforeAll FAILS rather than skips, so a job that loses the variable cannot pass
// by testing nothing. Locally, against a build made without the flag, the same file asserts that no button exists.
//
// Sport: badminton, clicked explicitly, as quick-match-home.spec.ts does: the hero's controls read no sport.
import { test, expect, devices, type Browser, type BrowserContext, type Page, type Request } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectNoHorizontalScroll, TAG, withDb } from "./helpers";
import { consentedAnonymousState } from "./scorepad-a11y-kit";

const ENABLED = process.env.NEXT_PUBLIC_OPEN_IN_APP === "1";
/** When set, both states are photographed at every width into this directory, with the home token masked. */
const SHOTS = process.env.E2E_QM_APP_SHOTS;
const EN = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;

const ANDROID_UA = devices["Pixel 7"].userAgent;
const IPHONE_UA = devices["iPhone 14"].userAgent;
const DESKTOP_UA = devices["Desktop Chrome"].userAgent;
const STEP_MS = 20_000;
/** Long enough for any navigation or timer the page might start by itself after tap one. */
const IDLE_MS = 1_500;
const SECRET = /^dl_[A-Za-z0-9_-]{43}$/;
/** The route's request header, typed here: the wire name the home sends and the server reads. */
const APP_HEADER = "x-seazn-score-in-app";

test.beforeAll(() => {
  if (process.env.CI) {
    expect(ENABLED, "CI must build AND run with NEXT_PUBLIC_OPEN_IN_APP=1 (the e2e.yml job env): without it nothing here is tested").toBe(true);
  }
});

async function guest(browser: Browser, userAgent: string, width = 390): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    storageState: await consentedAnonymousState(),
    userAgent,
    viewport: { width, height: width < 768 ? 844 : 900 },
    hasTouch: width < 768,
  });
  return { ctx, page: await ctx.newPage() };
}

/** A league of 4 made the way a guest makes one: the setup form, posted by its Start button, followed to the home. */
async function createThroughSetup(page: Page) {
  await page.goto("/en/play");
  const form = page.getByTestId("qm-setup-form");
  await expect(form).toBeVisible();
  await form.getByText("Badminton", { exact: true }).click();
  await form.getByLabel("Name", { exact: true }).fill(`e2e app ${TAG}`);
  const sides = ["The Extraordinarily Long-Named Doubles Pair", "Priya & Tom", "Lee & Ana", "Jo & Max"];
  for (let n = 3; n <= sides.length; n++) await page.getByRole("button", { name: "+ Add a side" }).click();
  for (const [k, name] of sides.entries()) await form.getByLabel(`Side ${k + 1}`, { exact: true }).fill(name);
  await page.getByTestId("qm-start").click();
  await expect(page).toHaveURL(/\/q\/[^/?#]+$/);
}

const hero = (page: Page) => page.getByTestId("qm-hero");
const scoreButton = (page: Page) => hero(page).getByTestId("qm-score");
const startButton = (page: Page) => hero(page).getByTestId("qm-score-in-app");
const appAnchor = (page: Page) => hero(page).getByTestId("open-in-app");
const appBlock = (page: Page) => hero(page).getByTestId("open-in-app-block");
const failedLine = (page: Page) => hero(page).getByTestId("qm-score-in-app-failed");

/** The Score form's action: `/q/<token>/score/<fixtureId>`. */
const scorePath = async (page: Page) => (await hero(page).locator("form").getAttribute("action"))!;

/** A real tap target: 44px or more, and the element a tap at its centre actually hits. */
async function expectTappable(page: Page, testId: string, what: string) {
  const target = hero(page).getByTestId(testId);
  await target.scrollIntoViewIfNeeded();
  const seen = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { height: r.height, hit: top !== null && (top === el || el.contains(top)) };
  });
  expect(seen.height, `${what}: 44px or more`).toBeGreaterThanOrEqual(44);
  expect(seen.hit, `${what}: the tap lands on it`).toBe(true);
}

/** Press the island's button once React has claimed it (before that a press is lost), then read the answer to its post. */
async function tapStart(page: Page) {
  const button = startButton(page);
  await expect(button).toBeVisible({ timeout: STEP_MS });
  await expect
    .poll(() => button.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$"))), { timeout: STEP_MS })
    .toBe(true);
  const path = await scorePath(page);
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === path, { timeout: STEP_MS }),
    button.tap(),
  ]);
  return response;
}

/** The state-2 anchor's secret, once the block is up. */
async function linkOnScreen(page: Page): Promise<string> {
  await expect(appAnchor(page)).toBeVisible({ timeout: STEP_MS });
  const href = (await appAnchor(page).getAttribute("href"))!;
  const prefix = `${new URL(page.url()).origin}/app/score#`;
  expect(href.startsWith(prefix), `an app score link: ${href.slice(0, prefix.length)}`).toBe(true);
  const secret = href.slice(prefix.length);
  expect(secret).toMatch(SECRET);
  return secret;
}

/** State 1: the lime Score in the page's words, "Score in app" under it, no link. */
async function expectStateOne(page: Page) {
  await expect(startButton(page)).toBeVisible({ timeout: STEP_MS });
  await expect(startButton(page)).toHaveText(EN["openApp.scoreInApp"]!);
  await expect(startButton(page)).not.toHaveAttribute("aria-disabled", "true");
  await expect(scoreButton(page)).toHaveText(EN["quickMatch.home.score"]!);
  await expect(appBlock(page)).toHaveCount(0);
}

/** No request: not its URL, not any header (Referer among them), not its body. */
async function requestsCarrying(requests: readonly Request[], needle: string): Promise<string[]> {
  const carriers: string[] = [];
  for (const request of requests) {
    const sent = [request.url(), JSON.stringify(await request.allHeaders()), request.postData() ?? ""];
    if (sent.some((part) => part.includes(needle) || part.includes(encodeURIComponent(needle)))) {
      carriers.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  }
  return carriers;
}

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // The home token is a credential: no photograph shows it. The share field prints it, so the field is painted over, and
  // any text node holding it is a failure rather than a picture.
  const printed = await page.evaluate(() => /qm_[A-Za-z0-9_-]{20,}/.test(document.body.innerText));
  expect(printed, `${name}: the token is painted as text`).toBe(false);
  const fields = page.locator("input");
  const holding = await fields.evaluateAll((els) => els.flatMap((el, i) => ((el as HTMLInputElement).value.includes("/q/qm_") ? [i] : [])));
  expect(holding.length, `${name}: premise, the share field is found`).toBeGreaterThan(0);
  await page.screenshot({
    path: join(SHOTS, `${name}.png`),
    animations: "disabled",
    mask: holding.map((i) => fields.nth(i)),
    maskColor: "#2a1c5c",
  });
}

test.describe("Android phone, flag on", () => {
  test.skip(!ENABLED, "needs a build made with NEXT_PUBLIC_OPEN_IN_APP=1 (under CI the beforeAll insists)");

  test("two taps: the link comes back in a no-store answer, nothing carries it until the person taps it, and the browser's Score still works", async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const { ctx, page } = await guest(browser, ANDROID_UA);
    try {
      const requests: Request[] = [];
      ctx.on("request", (r) => void requests.push(r));
      const hydration: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error" && /hydrat|did not match|#418|#423|#425/i.test(m.text())) hydration.push(m.text());
      });
      page.on("pageerror", (e) => hydration.push(String(e)));

      await createThroughSetup(page);
      const homeUrl = page.url();
      // What the server sends a visitor who has not tapped: the browser's Score, no second button, no link.
      const html = await (await page.request.get(homeUrl, { headers: { "user-agent": ANDROID_UA } })).text();
      expect(html, "premise: this is the live home").toContain('data-testid="qm-score"');
      expect(html).not.toContain("dl_");
      expect(html).not.toContain('data-testid="qm-score-in-app"');
      expect(html).not.toContain("/app/score");

      await expectStateOne(page);
      await expectTappable(page, "qm-score-in-app", "Score in app");
      const [score, start] = [await scoreButton(page).boundingBox(), await startButton(page).boundingBox()];
      expect(start!.y, "Score in app sits under Score").toBeGreaterThanOrEqual(score!.y + score!.height);
      const lime = await scoreButton(page).evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(await startButton(page).evaluate((el) => getComputedStyle(el).backgroundColor), "the second button is the quieter one").not.toBe(lime);
      const historyBefore = await page.evaluate(() => history.length);

      // ── tap one ──
      const response = await tapStart(page);
      expect(response.status()).toBe(200);
      expect(response.headers()["cache-control"]).toBe("no-store");
      expect(response.headers()["content-type"]).toMatch(/^application\/json/);
      expect(response.headers()["location"]).toBeUndefined();
      const sent = await response.request().allHeaders();
      expect(sent[APP_HEADER], "the header the route answers as JSON").toBe("1");
      expect(sent["sec-fetch-site"], "premise: a browser says this fetch is same-origin").toBe("same-origin");
      expect(response.request().postData() ?? "").toBe("");

      const secret = await linkOnScreen(page);
      expect(((await response.json()) as { secret: string }).secret).toBe(secret);
      await expect(startButton(page)).toHaveCount(0);
      await expect(appAnchor(page)).toHaveText(EN["openApp.button"]!);
      await expect(appAnchor(page)).toHaveAttribute("rel", "noreferrer");
      expect(await appAnchor(page).getAttribute("target"), "same tab: Chrome hands it to the app").toBeNull();
      const hint = hero(page).getByTestId("open-in-app-hint");
      await expect(hint).toHaveText(EN["openApp.tapAgain"]!);
      await expect(appAnchor(page)).toHaveAttribute("aria-describedby", (await hint.getAttribute("id"))!);
      await expect(appAnchor(page)).toBeFocused();
      await expect(hero(page).getByText(EN["openApp.orScan"]!)).toHaveCount(0);
      expect(await appAnchor(page).evaluate((el) => el.closest(".ph-no-capture") !== null), "replay and autocapture see none of it").toBe(true);
      await expect(scoreButton(page)).toHaveText(EN["openApp.scoreInBrowser"]!);
      expect(await scoreButton(page).evaluate((el) => getComputedStyle(el).backgroundColor), "no longer the lime action").not.toBe(lime);
      await expectTappable(page, "open-in-app", "Open in app");
      await expectTappable(page, "qm-score", "Score in browser");
      await expectNoHorizontalScroll(page);

      // Nothing happens by itself, and the link is nowhere but the anchor.
      await page.waitForTimeout(IDLE_MS);
      expect(page.url(), "no navigation without the person's tap").toBe(homeUrl);
      expect(await page.evaluate(() => history.length)).toBe(historyBefore);
      expect((await page.content()).split(secret), "painted once: the anchor's href").toHaveLength(2);
      const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie, history.state]));
      expect(stored).not.toContain(secret);
      expect((await ctx.cookies()).map((c) => c.value).join(" ")).not.toContain(secret);
      const posts = requests.filter((r) => r.method() === "POST" && r.headers()[APP_HEADER] === "1");
      expect(posts, "one tap, one ask").toHaveLength(1);
      expect(requests.length, "anti-vacuity: requests inspected").toBeGreaterThan(1);
      expect(await requestsCarrying(requests, secret), "before tap two, no request carries the link").toEqual([]);

      // ── tap two: the person's own, to the real /app/score page (what a phone without the app gets) ──
      const tabs = ctx.pages().length;
      await appAnchor(page).tap();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(EN["openApp.fallback.title"]!, { timeout: STEP_MS });
      await expect(page).toHaveURL(`${new URL(homeUrl).origin}/app/score`);
      expect(ctx.pages(), "no new tab").toHaveLength(tabs);
      await expect(page.getByTestId("score-in-browser")).toBeVisible();

      // ── back: the home starts again, with no link held ──
      await page.goBack();
      await expect(page).toHaveURL(homeUrl);
      await expectStateOne(page);

      // The same match's link again; a reload drops it; the browser's Score in state two opens the very same pad.
      await tapStart(page);
      expect(await linkOnScreen(page), "the same link, reopened").toBe(secret);
      await page.reload();
      await expectStateOne(page);
      await tapStart(page);
      expect(await linkOnScreen(page)).toBe(secret);
      await scoreButton(page).tap();
      await expect(page).toHaveURL(`${new URL(homeUrl).origin}/score/${secret}`, { timeout: STEP_MS });
      // The real pad takes the link: a match nobody has started opens on its pre-match card.
      await expect(page.getByTestId("score-start-match")).toBeVisible({ timeout: STEP_MS });
      // The detector's own proof: the pad's request does carry the link in its path, and the same search finds it.
      expect((await requestsCarrying(requests, secret)).length, "the search can see a carrier").toBeGreaterThan(0);

      // Back from the pad: no dead control.
      await page.goBack();
      await expect(page).toHaveURL(homeUrl);
      await expect(startButton(page).or(appAnchor(page))).toBeVisible({ timeout: STEP_MS });
      expect(hydration).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  test("a tap one that fails leaves both ways in; a real refusal goes to the home's own flash", async ({ browser }) => {
    test.setTimeout(120_000);
    const { ctx, page } = await guest(browser, ANDROID_UA);
    try {
      await createThroughSetup(page);
      const homeUrl = page.url();
      await expectStateOne(page);
      const path = await scorePath(page);
      const fixtureId = path.split("/").at(-1)!;

      // A server error, once.
      await page.route(`**${path}`, (route) => route.fulfill({ status: 500, body: "boom" }), { times: 1 });
      await tapStart(page);
      await expect(failedLine(page)).toHaveText(EN["quickMatch.flash.generic"]!);
      await expect(failedLine(page)).toHaveAttribute("role", "alert");
      await expectStateOne(page);
      await expectNoHorizontalScroll(page);
      // The same button, again: it works.
      await tapStart(page);
      await linkOnScreen(page);
      await expect(failedLine(page)).toHaveCount(0);

      // A refusal for real: the match is marked Not played behind this page's back (the status the home's skip writes).
      await page.reload();
      await expectStateOne(page);
      await withDb((sql) => sql`update fixtures set status = 'cancelled' where id = ${fixtureId}`);
      // The page leaves as soon as it has the answer, so the body is read on its way through.
      let answered = "";
      await page.route(
        `**${path}`,
        async (route) => {
          const real = await route.fetch();
          answered = await real.text();
          await route.fulfill({ response: real, body: answered });
        },
        { times: 1 },
      );
      await tapStart(page);
      expect(JSON.parse(answered)).toEqual({ location: `${new URL(homeUrl).pathname}?e=QUICK_MATCH_NOT_PLAYED` });
      await expect(page.getByTestId("qm-flash")).toHaveText(EN["quickMatch.flash.notPlayed"]!, { timeout: STEP_MS });
      await expect(page.getByTestId("open-in-app")).toHaveCount(0);
      expect((await scorePath(page)).split("/").at(-1), "the hero has moved on").not.toBe(fixtureId);
      await expectStateOne(page);
    } finally {
      await ctx.close();
    }
  });

  test("only below md: from 768 up the home is exactly the lime Score, and a held link comes back when it narrows again", async ({ browser }) => {
    test.setTimeout(120_000);
    const { ctx, page } = await guest(browser, ANDROID_UA);
    try {
      await createThroughSetup(page);
      await expectStateOne(page);
      let checked = 0;
      for (const width of [320, 390, 767]) {
        await page.setViewportSize({ width, height: 844 });
        await expectStateOne(page);
        await expectTappable(page, "qm-score-in-app", `Score in app at ${width}`);
        await expectNoHorizontalScroll(page);
        await shoot(page, `state1-${width}`);
        checked++;
      }
      for (const width of [768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.reload();
        await expect(scoreButton(page)).toHaveText(EN["quickMatch.home.score"]!);
        await expect(startButton(page), `${width}: no second button`).toHaveCount(0);
        await expectNoHorizontalScroll(page);
        await shoot(page, `state1-${width}`);
        checked++;
      }
      expect(checked).toBe(5);

      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await tapStart(page);
      const secret = await linkOnScreen(page);
      let states = 0;
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(appAnchor(page)).toBeVisible();
        await expectTappable(page, "open-in-app", `Open in app at ${width}`);
        await expectNoHorizontalScroll(page);
        await shoot(page, `state2-${width}`);
        states++;
      }
      for (const width of [768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(appBlock(page), `${width}: no app block`).toHaveCount(0);
        await expect(startButton(page)).toHaveCount(0);
        await expect(scoreButton(page), `${width}: the page's own Score`).toHaveText(EN["quickMatch.home.score"]!);
        await expectNoHorizontalScroll(page);
        await shoot(page, `state2-${width}`);
        states++;
      }
      expect(states).toBe(4);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await linkOnScreen(page)).toBe(secret);
    } finally {
      await ctx.close();
    }
  });

  test("the real server grants no other origin the header: no CORS answer to a preflight, and a cross-site ask is a 403", async ({ browser }) => {
    const { ctx, page } = await guest(browser, ANDROID_UA);
    try {
      await createThroughSetup(page);
      const url = new URL(await scorePath(page), page.url()).toString();
      const preflight = await page.request.fetch(url, {
        method: "OPTIONS",
        headers: {
          origin: "https://evil.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": APP_HEADER,
        },
      });
      const granted = Object.keys(preflight.headers()).filter((k) => k.startsWith("access-control-"));
      expect(granted, `preflight ${preflight.status()}`).toEqual([]);
      const crossSite = await page.request.post(url, {
        headers: { [APP_HEADER]: "1", "sec-fetch-site": "cross-site", origin: "https://evil.example" },
        maxRedirects: 0,
      });
      expect(crossSite.status()).toBe(403);
      expect(await crossSite.text()).not.toContain("dl_");
      // The pair: the same post as the home's own page is answered.
      const own = await page.request.post(url, { headers: { [APP_HEADER]: "1", "sec-fetch-site": "same-origin" }, maxRedirects: 0 });
      expect(own.status()).toBe(200);
      expect(((await own.json()) as { secret: string }).secret).toMatch(SECRET);
    } finally {
      await ctx.close();
    }
  });
});

test("everyone else sees the home as it was: the lime Score alone (iPhone, a narrow desktop browser, Android at md and up; every browser with the flag off)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const viewers: [string, string, number][] = [
    ["iPhone", IPHONE_UA, 390],
    ["desktop browser, narrow", DESKTOP_UA, 390],
    ["desktop browser", DESKTOP_UA, 1280],
    ["Android at 768", ANDROID_UA, 768],
    ...(ENABLED ? [] : ([["Android phone, flag off", ANDROID_UA, 390]] as [string, string, number][])),
  ];
  let checked = 0;
  for (const [who, ua, width] of viewers) {
    const { ctx, page } = await guest(browser, ua, width);
    try {
      await createThroughSetup(page);
      await expect(scoreButton(page), who).toBeVisible();
      await expect(scoreButton(page), who).toHaveText(EN["quickMatch.home.score"]!);
      // After hydration, which is when the button would appear: the share island has claimed its field by then.
      await expect
        .poll(() => scoreButton(page).evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$"))), { timeout: STEP_MS })
        .toBe(true);
      await expect(page.getByTestId("qm-score-in-app"), who).toHaveCount(0);
      await expect(page.getByTestId("open-in-app-block"), who).toHaveCount(0);
      await expect(page.getByText(EN["openApp.scoreInApp"]!), who).toHaveCount(0);
      checked++;
    } finally {
      await ctx.close();
    }
  }
  expect(checked).toBe(viewers.length);
});
