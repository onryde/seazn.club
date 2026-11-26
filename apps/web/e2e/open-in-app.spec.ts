import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { apiJson, expectNoHorizontalScroll } from "./helpers";
import { seedGenericDivision } from "./helpers/open-in-app-seeds";

// Open in app (spec 2026-11-25 §5.3): the bare fallback pages under /app, as a built server serves them. Seen only when
// the Android app did not take the link, and the URL FRAGMENT IS A LIVE CREDENTIAL. No sport reaches these pages, so
// there is no sport sweep. Only the real-link walk needs an account, and only to MINT the link (a generic fixture: the
// link and the page that opens it read no sport); the phone that opens it holds nothing. The one test about cookies
// carries a made-up session cookie, because the proxy reads only its presence.
test.use({ storageState: { cookies: [], origins: [] } });

const KINDS = ["stream", "score", "day"] as const;
// The brief's English, typed here; the other locales' titles are the dictionaries' own (unit test).
const TITLE = "Seazn Club isn't on this phone yet";
const PLAY = "https://play.google.com/store/apps/details?id=com.seazn.capture";
/** Shaped like a device-link token, and held by no link. */
const SECRET = `dl_${"a".repeat(43)}`;
const SCORE_IN_BROWSER = "Score in browser instead";
/** When set, the scoring page and the pad it opens are photographed at 320 into this directory. */
const SHOTS = process.env.E2E_OIA_SHOTS;

/** Console errors and uncaught exceptions. A CSP refusal, report-only included, arrives as a console error. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

/** Every directive the page's CSP refuses, report-only included, from the first byte of each later document. */
async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__violations.push(e.violatedDirective));
  });
  return () => page.evaluate(() => (window as unknown as { __violations: string[] }).__violations);
}

test("served headers and fragment handling", async ({ page, context, baseURL }) => {
  // Signed in as far as the proxy can tell, with no hint cookie: the case where it would set one.
  await context.addCookies([{ name: "seazn_session", value: "presence-only", url: baseURL! }]);
  // Premise: an ordinary app page DOES answer this browser with that cookie, so its absence below means something.
  const premise = await page.request.get("/legal/privacy");
  expect(premise.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value).join("\n"))
    .toContain("seazn_signed_in=1");
  await context.clearCookies({ name: "seazn_signed_in" });

  // Opened with nothing behind it, the way an in-app browser or a new-tab link opens it. (`page.goto` will not do: it
  // keeps the tab's first about:blank entry, so there would be something to go back to.)
  const opened = context.waitForEvent("page");
  const served = context.waitForEvent("response", (r) => new URL(r.url()).pathname === "/app/score");
  await page.evaluate((url) => void window.open(url, "_blank", "noopener"), `${baseURL}/app/score#${SECRET}`);
  const tab = await opened;
  const res = await served;
  expect(res.status()).toBe(200);
  const headers = await res.allHeaders();
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["x-robots-tag"]).toContain("noindex");
  expect(await res.headerValues("set-cookie")).toEqual([]);
  expect((await context.cookies()).map((c) => c.name)).toEqual(["seazn_session"]);

  await expect(tab).toHaveURL(/\/app\/score$/);
  await expect(tab.getByRole("heading", { level: 1 })).toHaveText(TITLE);
  expect(await tab.evaluate(() => history.length)).toBe(1);
  // Nothing behind it, and the button is there all the same: it opens the pad, it does not go back.
  await expect(tab.getByTestId("score-in-browser")).toBeVisible();
  await expect(tab.getByRole("link", { name: "Get it on Google Play" })).toHaveAttribute("href", PLAY);

  // What is served is the route handler's own bytes: one script, and nothing a layout or an edge added.
  const body = await res.text();
  expect(body.match(/<script/g)).toHaveLength(1);
  expect(body).not.toContain("/_next/");
});

interface Recorded {
  url: string;
  type: string;
  body: string;
  headers: Record<string, string>;
}

/** Every request the context makes from now on, in the order made, with its headers (the Referer among them) and body.
 *  `settled` waits for the headers, which arrive later than the request. */
function recordRequests(context: BrowserContext) {
  const all: Recorded[] = [];
  const pending: Promise<void>[] = [];
  context.on("request", (r) => {
    const entry: Recorded = { url: r.url(), type: r.resourceType(), body: r.postData() ?? "", headers: {} };
    all.push(entry);
    pending.push(r.allHeaders().then((headers) => void (entry.headers = headers)));
  });
  return { all, settled: () => Promise.all(pending) };
}

/** Everywhere the page itself could be holding `secret` where something else could read it. `globals` names any window
 *  property whose value spells it. */
const heldBy = (page: Page, secret: string) =>
  page.evaluate((wanted) => {
    const spells = (value: unknown) => String(value).includes(wanted);
    return {
      dom: spells(document.documentElement.outerHTML),
      stored: [localStorage.length, sessionStorage.length],
      cookie: document.cookie,
      state: history.state as unknown,
      referrer: document.referrer,
      address: spells(location.href),
      globals: Object.getOwnPropertyNames(window).filter((key) => {
        try {
          return spells((window as unknown as Record<string, unknown>)[key]);
        } catch {
          return false;
        }
      }),
    };
  }, secret);

/** A device link minted the way the organiser's panel mints one, for a match that is ready to be scored (its division
 *  started: before that the scan opens on a waiting screen). */
async function mintDeviceLink(request: APIRequestContext, label: string): Promise<string> {
  const seed = await seedGenericDivision(request, label);
  const started = await apiJson(request, `/api/v1/divisions/${seed.divisionId}/start`, "POST");
  expect(started.status, `division start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  const minted = await apiJson<{ secret: string }>(request, `/api/v1/fixtures/${seed.fixtureId}/device-links`, "POST", {});
  expect(minted.status, JSON.stringify(minted.error)).toBeLessThan(300);
  return minted.data!.secret;
}

/** A phone that has never seen this site: no session, no consent, nothing stored. */
const freshPhone = (browser: Browser, baseURL: string) =>
  browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, viewport: { width: 320, height: 700 }, hasTouch: true });

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}-320.png`), fullPage: true, animations: "disabled" });
}

// Owner, 2026-11-26: without the app, score remotely in the browser. The button opens the REMOTE pad for the code the
// link carried, where it used to go back to the organiser's screen.
test.describe("Score in browser instead, with a real device link", () => {
  // The organiser's session, for the mint alone.
  test.use({ storageState: "e2e/.auth/pro.json" });

  test("on a phone with no session: nothing carries the token until the tap, which opens the remote pad; Back skips the emptied page", async ({
    browser,
    baseURL,
    request,
  }) => {
    test.setTimeout(120_000);
    const secret = await mintDeviceLink(request, "fallback tap");
    expect(secret).toMatch(/^dl_[A-Za-z0-9_-]{43}$/);
    const phone = await freshPhone(browser, baseURL!);
    const requests = recordRequests(phone);
    const page = await phone.newPage();
    const errors = watchErrors(page);
    const logged: string[] = [];
    page.on("console", (m) => logged.push(m.text()));

    // Something behind the link, so Back from the pad has somewhere to go: a bare page, which asks for nothing else.
    await page.goto("/app/stream");
    await page.goto(`/app/score#${secret}`, { waitUntil: "networkidle" });
    const button = page.getByRole("button", { name: SCORE_IN_BROWSER });
    await expect(button).toBeVisible();
    await expect(page).toHaveURL(`${baseURL}/app/score`);
    await expectNoHorizontalScroll(page);
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await shoot(page, "score-fallback-with-code");
    // Time for anything delayed (a beacon, a prefetch) to show itself before the tap.
    await page.waitForTimeout(1_500);

    // Held in the script's closure and nowhere else.
    expect(await heldBy(page, secret)).toEqual({
      dom: false,
      stored: [0, 0],
      cookie: "",
      state: null,
      referrer: "",
      address: false,
      globals: [],
    });
    // Premise: the probe does find a token that was left lying about.
    await page.evaluate((value) => Object.assign(window, { probeHeld: value }), secret);
    expect((await heldBy(page, secret)).globals).toEqual(["probeHeld"]);
    await page.evaluate(() => void delete (window as unknown as { probeHeld?: string }).probeHeld);

    await requests.settled();
    const before = requests.all.length;
    expect(requests.all.map((r) => new URL(r.url).pathname)).toEqual(["/app/stream", "/app/score"]);
    for (const r of requests.all) expect(JSON.stringify(r), r.url).not.toContain(secret);
    expect(await phone.cookies()).toEqual([]);
    expect(logged.filter((line) => line.includes(secret))).toEqual([]);
    expect(errors).toEqual([]);

    await button.tap();
    await expect(page).toHaveURL(`${baseURL}/score/${secret}`);
    // The remote pad: the account-less screen for this one match. `score-pad` is the signed-in console's alone.
    await expect(page.getByTestId("scan-headline")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("score-start-match")).toBeVisible();
    await expect(page.getByTestId("scan-dead-link")).toHaveCount(0);
    await expect(page.locator('[data-testid="score-pad"]')).toHaveCount(0);
    await shoot(page, "score-remote-pad-after-tap");

    // It arrives as a scan of the QR does: no referrer, and the first thing ever to carry the token is the pad's own
    // document, on this origin.
    expect(await page.evaluate(() => document.referrer)).toBe("");
    await requests.settled();
    const carrying = requests.all.filter((r) => JSON.stringify(r).includes(secret));
    expect(carrying.length).toBeGreaterThan(0);
    expect(requests.all.indexOf(carrying[0]!)).toBe(before);
    expect([carrying[0]!.url, carrying[0]!.type]).toEqual([`${baseURL}/score/${secret}`, "document"]);
    expect(carrying[0]!.headers["referer"]).toBeUndefined();
    for (const r of carrying) expect(new URL(r.url).origin, r.type).toBe(new URL(baseURL!).origin);

    // `replace`: the page whose token is gone is no longer behind the pad.
    await page.goBack();
    await expect(page).toHaveURL(`${baseURL}/app/stream`);
    await phone.close();
  });

  test("a reload after the strip has no code left: the button stays hidden and nothing ever carries the token", async ({
    browser,
    baseURL,
    request,
  }) => {
    test.setTimeout(120_000);
    const secret = await mintDeviceLink(request, "fallback reload");
    const phone = await freshPhone(browser, baseURL!);
    const requests = recordRequests(phone);
    const page = await phone.newPage();
    const errors = watchErrors(page);
    await page.goto(`/app/score#${secret}`);
    const button = page.getByTestId("score-in-browser");
    await expect(button, "premise: with the code, the button is there").toBeVisible();

    await page.reload({ waitUntil: "networkidle" });
    await expect(page).toHaveURL(`${baseURL}/app/score`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(TITLE);
    await expect(button).toBeAttached();
    await expect(button).toBeHidden();
    await shoot(page, "score-fallback-after-reload");
    await requests.settled();
    expect(requests.all.map((r) => new URL(r.url).pathname)).toEqual(["/app/score", "/app/score"]);
    for (const r of requests.all) expect(JSON.stringify(r), r.url).not.toContain(secret);
    expect(errors).toEqual([]);
    await phone.close();
  });
});

test("back from Google Play: restored or reloaded, the button is never a dead one", async ({ page, context, baseURL }, testInfo) => {
  await page.addInitScript(() => {
    window.addEventListener("pageshow", (e) => Object.assign(window, { shownFromCache: e.persisted }));
  });
  await context.route("https://play.google.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>play stub</title>" }),
  );
  await page.goto(`/app/score#${SECRET}`);
  const button = page.getByTestId("score-in-browser");
  await expect(button).toBeVisible();
  await page.getByTestId("app-fallback-play").click();
  await expect(page).toHaveTitle("play stub");
  await page.goBack();
  await expect(page).toHaveURL(`${baseURL}/app/score`);
  await expect(button).toBeAttached();
  const restored = await page.evaluate(() => (window as unknown as { shownFromCache?: boolean }).shownFromCache === true);
  testInfo.annotations.push({ type: "came back", description: restored ? "from the back/forward cache" : "as a new load" });
  console.log(`back from Play: ${restored ? "restored from the back/forward cache" : "loaded anew"}`);
  if (restored) {
    // The script's closure came back with the page: the button still opens the pad.
    await button.click();
    await expect(page).toHaveURL(`${baseURL}/score/${SECRET}`);
  } else {
    await expect(button).toBeHidden();
  }
});

test("no request carries the fragment and no analytics loads", async ({ page, context }) => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const pending: Promise<void>[] = [];
  context.on("request", (r) => {
    pending.push(r.allHeaders().then((headers) => void seen.push({ url: r.url(), headers })));
  });
  await page.goto(`/app/score#${SECRET}`, { waitUntil: "networkidle" });
  await expect(page).toHaveURL(/\/app\/score$/);
  await expect(page.getByTestId("score-in-browser"), "premise: the page is holding the code").toBeVisible();
  await Promise.all(pending);
  expect(seen.map((r) => new URL(r.url).pathname)).toEqual(["/app/score"]);
  for (const r of seen) expect(JSON.stringify(r.headers)).not.toContain(SECRET);
  expect(await context.cookies()).toEqual([]);

  // Leaving for Play tells Play nothing about where the person was.
  await context.route("https://play.google.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>play stub</title>" }),
  );
  const toPlay = page.waitForRequest((r) => r.url().startsWith("https://play.google.com/"));
  await page.getByTestId("app-fallback-play").click();
  const request = await toPlay;
  expect(request.url()).toBe(PLAY);
  expect((await request.allHeaders())["referer"]).toBeUndefined();
});

test("no fragment, a garbled one and one that is no device link: the same page, no button, no error — counted", async ({ page }) => {
  const errors = watchErrors(page);
  let checked = 0;
  for (const url of [
    "/app/stream",
    "/app/stream#%%%",
    "/app/score",
    "/app/score#%%%",
    `/app/score#md_${"a".repeat(43)}`,
    `/app/score#${SECRET}/../../dashboard`,
    `/app/score#${SECRET}%2F`,
    `/app/score#${SECRET.slice(0, -1)}`,
  ]) {
    const res = await page.goto(url);
    expect(res!.status(), url).toBe(200);
    await expect(page.getByRole("heading", { level: 1 }), url).toHaveText(TITLE);
    await expect(page, url).toHaveURL(new RegExp(`${url.split("#")[0]}$`));
    const button = page.getByTestId("score-in-browser");
    await expect(button, url).toHaveCount(url.startsWith("/app/score") ? 1 : 0);
    await expect(button, url).toBeHidden();
    // A second visit with only the fragment changed does not reload; start each case from a fresh document.
    await page.goto("about:blank");
    checked += 1;
  }
  expect(checked).toBe(8);
  expect(errors).toEqual([]);
});

test("the nonce'd script and the inline style run under the served CSP with no violation", async ({ page }) => {
  const violations = await watchViolations(page);
  const errors = watchErrors(page);
  let checked = 0;
  for (const kind of KINDS) {
    const res = await page.goto(`/app/${kind}#${SECRET}`);
    const headers = await res!.allHeaders();
    const csp = headers["content-security-policy"] ?? headers["content-security-policy-report-only"];
    expect(csp, kind).toMatch(/'nonce-[^']+'/);
    // The script ran (it dropped the fragment) and the style applied (the Play control is a block button).
    await expect(page, kind).toHaveURL(new RegExp(`/app/${kind}$`));
    await expect(page.getByTestId("app-fallback-play"), kind).toHaveCSS("display", "block");
    expect(await violations(), kind).toEqual([]);
    await page.goto("about:blank");
    checked += 1;
  }
  expect(checked).toBe(3);
  expect(errors).toEqual([]);

  // Positive control: the listener does hear a refusal (an inline handler has no nonce), in either CSP mode.
  await page.goto("/app/day");
  await page.evaluate(() => {
    document.body.setAttribute("onclick", "void 0");
    document.body.click();
  });
  await expect.poll(violations).not.toEqual([]);
});

test("each page at 320, 768 and 1280: no horizontal scroll, a thumb-sized Play button — counted", async ({ page }) => {
  let checked = 0;
  for (const kind of KINDS) {
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`/app/${kind}`);
      await expectNoHorizontalScroll(page);
      const box = await page.getByTestId("app-fallback-play").boundingBox();
      expect(box!.height, `${kind} ${width}`).toBeGreaterThanOrEqual(44);
      expect(box!.x + box!.width, `${kind} ${width}`).toBeLessThanOrEqual(width);
      checked += 1;
    }
  }
  expect(checked).toBe(9);
});

// Every OTHER path under /app. Left to Next, each is the not-found page inside the root layout, which loads analytics and
// a third-party tracking script while the fragment is still in the address. A real page's trailing-slash form
// (next.config's skipTrailingSlashRedirect serves it as typed) may be that page. `games`: the games subdomain, where a
// one-segment path is otherwise a game's slug.
const STRAY_PATHS: { path: string; status: number; scores: boolean; games?: true }[] = [
  { path: "/app", status: 404, scores: false },
  { path: "/app/", status: 404, scores: false },
  { path: "/app/other", status: 404, scores: false },
  { path: "/app/other/", status: 404, scores: false },
  { path: "/app/score/deeper", status: 404, scores: false },
  { path: "/app/score/deeper/", status: 404, scores: false },
  { path: "/app/a/b/c", status: 404, scores: false },
  { path: "/app/day.json", status: 404, scores: false },
  { path: "/app", status: 404, scores: false, games: true },
  { path: "/app/stream/", status: 200, scores: false },
  { path: "/app/score/", status: 200, scores: true },
  { path: "/app/day/", status: 200, scores: false },
];

/** Opens `url` in a context of its own, signed in as far as the proxy can tell, and returns what was served and every
 *  request the page then made. */
async function openRecorded(browser: Browser, baseURL: string, url: string, headers: Record<string, string> = {}) {
  const context = await browser.newContext({ baseURL, extraHTTPHeaders: headers });
  await context.addCookies([{ name: "seazn_session", value: "presence-only", url: baseURL }]);
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const pending: Promise<void>[] = [];
  context.on("request", (r) => {
    pending.push(r.allHeaders().then((all) => void requests.push({ url: r.url(), headers: all })));
  });
  const page = await context.newPage();
  const res = (await page.goto(url, { waitUntil: "networkidle" }))!;
  await Promise.all(pending);
  return { context, page, res, body: await res.text(), requests };
}

test("every other path under /app is bare: no external script, nothing but the document, no cookie, no referrer — counted", async ({
  browser,
  baseURL,
}, testInfo) => {
  // Premise: the same probe DOES see an ordinary not-found page's scripts, requests and cookie.
  const premise = await openRecorded(browser, baseURL!, "/zz-no-such-page");
  expect(premise.body).toMatch(/<script\b[^>]*\ssrc=/);
  expect(premise.requests.length).toBeGreaterThan(1);
  expect((await premise.context.cookies()).map((c) => c.name).sort()).toEqual(["seazn_session", "seazn_signed_in"]);
  await premise.context.close();

  let checked = 0;
  for (const stray of STRAY_PATHS) {
    const at = `${stray.path}${stray.games ? " (games host)" : ""}`;
    const { context, page, res, body, requests } = await openRecorded(
      browser,
      baseURL!,
      `${stray.path}#${SECRET}`,
      stray.games ? { "x-forwarded-host": "games.localhost" } : {},
    );
    const headers = await res.allHeaders();
    expect(res.status(), at).toBe(stray.status);
    expect(headers["content-type"], at).toBe("text/html; charset=utf-8");
    expect(headers["referrer-policy"], at).toBe("no-referrer");
    expect(headers["cache-control"], at).toBe("no-store");
    expect(headers["x-robots-tag"], at).toContain("noindex");
    expect(await res.headerValues("set-cookie"), at).toEqual([]);
    expect((await context.cookies()).map((c) => c.name), at).toEqual(["seazn_session"]);

    // One script, the inline one: no external or analytics script, and nothing of the app bundle.
    expect(body.match(/<script/g), at).toHaveLength(1);
    expect(body, at).not.toMatch(/<script\b[^>]*[\s/"']src\s*=/);
    expect(body, at).not.toContain("/_next/");
    // The document is the only request (its icon is an inline data: URI), and none carries the fragment.
    const asked = requests.map((r) => new URL(r.url).pathname).filter((p) => p !== "/favicon.ico");
    expect(asked, at).toEqual([stray.path]);
    for (const r of requests) expect(JSON.stringify(r.headers), at).not.toContain(SECRET);

    // The fragment is dropped, and only a scoring page offers scoring in the browser.
    expect(page.url(), at).toBe(`${baseURL}${stray.path}`);
    await expect(page.getByRole("heading", { level: 1 }), at).toHaveText(TITLE);
    await expect(page.getByTestId("score-in-browser"), at).toHaveCount(stray.scores ? 1 : 0);
    if (stray.scores) await expect(page.getByTestId("score-in-browser"), at).toBeVisible();
    await context.close();
    checked += 1;
  }
  expect(checked).toBe(12);
  testInfo.annotations.push({ type: "paths checked", description: String(checked) });
  console.log(`stray /app paths checked: ${checked}`);
});

/** The fonts Chromium actually drew `selector`'s text with, from the DevTools protocol: `document.fonts` says a face
 *  loaded, not that this text used it, and a glyph the face lacks is drawn by some other font. */
async function drawnWith(page: Page, selector: string): Promise<{ isCustomFont: boolean; glyphCount: number }[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  await cdp.detach();
  return fonts;
}

test("the inlined logo and condensed face render under the served CSP, every locale's accents included — counted", async ({
  page,
  context,
  baseURL,
}) => {
  const violations = await watchViolations(page);
  const errors = watchErrors(page);
  const logo = readFileSync("public/brand/seazn-logo-night-tight.png");
  let checked = 0;
  let accented = 0;
  for (const locale of ["en", "es", "fr", "nl"]) {
    await context.addCookies([{ name: "seazn_locale", value: locale, url: baseURL! }]);
    for (const kind of KINDS) {
      const at = `${kind}/${locale}`;
      await page.goto(`/app/${kind}`);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const image = page.getByRole("img", { name: "Seazn Club" });
      expect(
        await image.evaluate((e: HTMLImageElement) => [e.complete, e.naturalWidth, e.naturalHeight, e.height]),
        at,
      ).toEqual([true, logo.readUInt32BE(16), logo.readUInt32BE(20), 30]);
      for (const selector of ["h1", '[data-testid="app-fallback-play"]']) {
        const text = await page.locator(selector).innerText();
        const fonts = await drawnWith(page, selector);
        expect(fonts.length, `${at} ${selector}`).toBeGreaterThan(0);
        expect(fonts.filter((f) => !f.isCustomFont), `${at} ${selector}: "${text}"`).toEqual([]);
        accented += [...text].filter((c) => c.charCodeAt(0) > 127).length;
      }
      // Positive control: the same probe tells a system font apart.
      expect((await drawnWith(page, ".retry")).map((f) => f.isCustomFont), at).toContain(false);
      expect(await violations(), at).toEqual([]);
      checked += 1;
    }
  }
  expect(checked).toBe(12);
  expect(accented).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test.describe("the approved look", () => {
  test.use({ viewport: { width: 320, height: 700 } });

  /** The house theme's own declaration of a colour, as a computed style spells it. */
  const houseColour = (name: string) => {
    const hex = readFileSync("src/app/globals.css", "utf8").match(new RegExp(`${name}:\\s*#([0-9a-f]{6});`, "i"))![1]!;
    return `rgb(${[0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
  };

  test("night page, logo, one dashed lime box, and scoring in the browser below it — counted", async ({ page }) => {
    const [night, lime, cream] = ["--mk-night", "--mk-lime", "--mk-cream"].map(houseColour) as [string, string, string];
    // With a code, so the scoring page shows its second way in.
    await page.goto(`/app/score#${SECRET}`);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const box = page.locator(".box");
    const heading = page.getByRole("heading", { level: 1 });
    const play = page.getByTestId("app-fallback-play");
    const retry = page.locator(".retry");
    const browserWay = page.getByTestId("score-in-browser");
    const logo = page.getByRole("img", { name: "Seazn Club" });

    const styles: [string, Locator, Record<string, string>][] = [
      ["body", page.locator("body"), { "background-color": night }],
      ["box", box, {
        "border-top-style": "dashed",
        "border-top-color": lime,
        "border-top-left-radius": "12px",
        "padding-top": "20px",
        "padding-left": "16px",
      }],
      ["heading", heading, { color: cream, "text-transform": "uppercase", "font-size": "25px", "line-height": "27.5px" }],
      ["play", play, {
        "background-color": lime,
        color: night,
        "font-size": "16px",
        "font-weight": "700",
        "text-transform": "uppercase",
      }],
      ["retry", retry, { color: "rgb(201, 191, 238)", "font-size": "13px" }],
      ["browser way", browserWay, { color: cream, "font-size": "13.5px", "text-decoration-line": "underline" }],
    ];
    let checked = 0;
    for (const [name, locator, expected] of styles) {
      for (const [property, value] of Object.entries(expected)) {
        await expect(locator, `${name} ${property}`).toHaveCSS(property, value);
        checked += 1;
      }
    }
    expect(checked).toBe(20);
    // As DECLARED: the computed width is snapped to the screen's pixels (headless Chromium answers 1px).
    expect(
      await page.evaluate(() =>
        [...document.styleSheets]
          .flatMap((sheet) => [...sheet.cssRules])
          .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText === ".box")
          .map((rule) => rule.style.borderTopWidth),
      ),
    ).toEqual(["1.5px"]);

    const rect = async (l: Locator) => (await l.boundingBox())!;
    const [b, h, p, r, w, l] = await Promise.all([box, heading, play, retry, browserWay, logo].map(rect));
    expect(l!.height).toBe(30);
    expect(l!.y + l!.height).toBeLessThanOrEqual(b!.y);
    expect(p!.height).toBe(44);
    for (const inside of [h!, p!, r!]) {
      expect(inside.y).toBeGreaterThan(b!.y);
      expect(inside.y + inside.height).toBeLessThan(b!.y + b!.height);
    }
    expect(w!.y).toBeGreaterThanOrEqual(b!.y + b!.height);
    expect(w!.height).toBeGreaterThanOrEqual(44);
  });
});

test("the visitor's picked language is the page's, through the real proxy — counted", async ({ page, context, baseURL }) => {
  const titles = new Set<string>();
  for (const locale of ["en", "es", "fr", "nl"]) {
    await context.addCookies([{ name: "seazn_locale", value: locale, url: baseURL! }]);
    await page.goto("/app/stream");
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    titles.add(await page.getByRole("heading", { level: 1 }).innerText());
  }
  expect(titles.size).toBe(4);
});
