import { test, expect, type Page } from "@playwright/test";
import { expectNoHorizontalScroll } from "./helpers";

// Open in app (spec 2026-11-25 §5.3): the bare fallback pages under /app, as a built server serves them. Seen only when
// the Android app did not take the link, and the URL FRAGMENT IS A LIVE CREDENTIAL. No sport reaches these pages, so
// there is no sport sweep. Nothing here needs an account: the one test about cookies carries a made-up session cookie,
// because the proxy reads only its presence.
test.use({ storageState: { cookies: [], origins: [] } });

const KINDS = ["stream", "score", "day"] as const;
// The brief's English, typed here; the other locales' titles are the dictionaries' own (unit test).
const TITLE = "Seazn Club isn't on this phone yet";
const PLAY = "https://play.google.com/store/apps/details?id=com.seazn.capture";
const SECRET = `dl_${"a".repeat(43)}`;

/** Console errors and uncaught exceptions. A CSP refusal, report-only included, arrives as a console error. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
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
  await expect(tab.getByTestId("score-in-browser")).toBeAttached();
  await expect(tab.getByTestId("score-in-browser")).toBeHidden();
  await expect(tab.getByRole("link", { name: "Get it on Google Play" })).toHaveAttribute("href", PLAY);

  // What is served is the route handler's own bytes: one script, and nothing a layout or an edge added.
  const body = await res.text();
  expect(body.match(/<script/g)).toHaveLength(1);
  expect(body).not.toContain("/_next/");
});

test("score in browser instead goes back", async ({ page }) => {
  await page.goto("/");
  const home = page.url();
  expect(new URL(home).pathname).toBe("/");
  await page.goto(`/app/score#${SECRET}`);
  const back = page.getByRole("button", { name: "Score in browser instead" });
  await expect(back).toBeVisible();
  await expect(page).toHaveURL(/\/app\/score$/);
  await back.click();
  await expect(page).toHaveURL(home);
  // The history entry itself lost the fragment, not just the address bar at the time.
  await page.goForward();
  await expect(page).toHaveURL(/\/app\/score$/);
});

test("no request carries the fragment and no analytics loads", async ({ page, context }) => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const pending: Promise<void>[] = [];
  context.on("request", (r) => {
    pending.push(r.allHeaders().then((headers) => void seen.push({ url: r.url(), headers })));
  });
  await page.goto(`/app/score#${SECRET}`, { waitUntil: "networkidle" });
  await expect(page).toHaveURL(/\/app\/score$/);
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

test("no fragment and a garbled one: the same page, no error", async ({ page }) => {
  const errors = watchErrors(page);
  let checked = 0;
  for (const url of ["/app/stream", "/app/stream#%%%"]) {
    const res = await page.goto(url);
    expect(res!.status(), url).toBe(200);
    await expect(page.getByRole("heading", { level: 1 }), url).toHaveText(TITLE);
    await expect(page, url).toHaveURL(/\/app\/stream$/);
    // A second visit with only the fragment changed does not reload; start each case from a fresh document.
    await page.goto("about:blank");
    checked += 1;
  }
  expect(checked).toBe(2);
  expect(errors).toEqual([]);
});

test("the nonce'd script and the inline style run under the served CSP with no violation", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__violations.push(e.violatedDirective));
  });
  const violations = () => page.evaluate(() => (window as unknown as { __violations: string[] }).__violations);
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
