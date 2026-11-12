import { test as base, expect, type Browser, type BrowserContextOptions, type Page, type TestInfo } from "@playwright/test";
import { expectNoHorizontalScroll, TAG } from "./helpers";
import { consentedAnonymousState } from "./scorepad-a11y-kit";

// Quick match plan 2 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5): the guest's surfaces in a real
// browser, at 1280 (the `parallel` project). Task 4 writes the setup screen's cases; Task 10 extends this file with the
// league flow (setup → home → Score → a rally → back), the knockout home, and the URL forms, and adds the seven-width case
// to mobile.spec.ts.
//
// What the island's unit tests cannot see, and these do: the real form post and its 303 followed by the browser's own
// fetch (the visitor cookie set on a redirect, `res.url`), hydration (the suggested name dated in the BROWSER's zone),
// the real chips/radios under a click, and the page's width.
//
// A guest: no session, in a context of its own (a fixture rather than `test.use({ storageState })`, own-account.ts says
// why). It has already answered the cookie banner, so the banner never sits over the docked Start bar
// (scorepad-a11y-kit.ts, `consentedAnonymousState`).
//
// Sport: badminton, clicked explicitly (A11): the spec's own example, two kinds and a knockout it allows. The full offer is
// swept in play-page.test.tsx against the real catalog.

/** A guest's own browser: no session; consent already answered unless the case needs the banner. */
async function guestContext(browser: Browser, info: TestInfo, options: BrowserContextOptions = {}) {
  return browser.newContext({
    storageState: await consentedAnonymousState(),
    baseURL: info.project.use.baseURL,
    ...options,
  });
}

// Playwright's `use` callback is named `provide`: react-hooks lints any call named `use` (own-account.ts).
const test = base.extend<{ guest: Page }>({
  guest: async ({ browser }, provide, info) => {
    const ctx = await guestContext(browser, info);
    try {
      await provide(await ctx.newPage());
    } finally {
      await ctx.close();
    }
  },
});

const form = (page: Page) => page.getByTestId("qm-setup-form");
const side = (page: Page, n: number) => form(page).getByLabel(`Side ${n}`, { exact: true });
const start = (page: Page) => page.getByTestId("qm-start");
/** A chip or a segment, by its words, inside the form (the footer may name a sport too). */
const choice = (page: Page, words: string) => form(page).getByText(words, { exact: true });

async function openSetup(page: Page) {
  await page.goto("/en/play");
  await expect(form(page)).toBeVisible();
  // The hydration signal: the server's Start is live (the no-script path); once the script runs, blank rows disable it.
  // Typing before then would race React taking over the inputs.
  await expect(start(page)).toBeDisabled();
  await choice(page, "Badminton").click();
}

test("setup (C16, C17): two sides and no format row; Start waits for both names and counts one match; no sideways scroll", async ({ guest: page }) => {
  await openSetup(page);
  await expect(side(page, 1)).toBeVisible();
  await expect(side(page, 2)).toBeVisible();
  await expect(side(page, 3)).toHaveCount(0);
  await expect(page.getByTestId("qm-format-row")).toHaveCount(0);
  await expect(page.getByText("Each pair plays")).toBeVisible();
  await expect(start(page)).toBeDisabled();
  await side(page, 1).fill("Ravi & Sam");
  await side(page, 2).fill("Priya & Tom");
  await expect(start(page)).toBeEnabled();
  await expect(page.getByRole("button", { name: "Start playing · 1 match", exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("setup (B4h): after hydration the name is the sport and the browser's own date, and it follows the sport until edited", async ({ guest: page }) => {
  await openSetup(page);
  const name = form(page).getByLabel("Name", { exact: true });
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "short" }).format(new Date()),
  );
  await expect(name).toHaveValue(`Badminton · ${today}`);
  await choice(page, "Tennis").click();
  await expect(name).toHaveValue(`Tennis · ${today}`);
  await name.fill("Friday night");
  await choice(page, "Badminton").click();
  await expect(name).toHaveValue("Friday night");
});

test("setup (C22): four sides and Knockout show the generator's draw, two semi-finals then the winners meet, and count 3", async ({ guest: page }) => {
  await openSetup(page);
  for (let n = 3; n <= 4; n++) await page.getByRole("button", { name: "+ Add a side" }).click();
  const names = ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max"];
  for (const [k, n] of names.entries()) await side(page, k + 1).fill(n);
  await expect(page.getByTestId("qm-format-row")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start playing · 6 matches", exact: true })).toBeVisible();
  await choice(page, "Knockout").click();
  const draw = page.getByTestId("qm-draw");
  await expect(draw).toBeVisible();
  // Seed i meets seed N+1−i (spec C22): 1 v 4 and 2 v 3, in whichever order the generator lists them.
  await expect(draw.getByText(/Ravi & Sam v Jo & Max|Jo & Max v Ravi & Sam/)).toBeVisible();
  await expect(draw.getByText(/Priya & Tom v Lee & Ana|Lee & Ana v Priya & Tom/)).toBeVisible();
  await expect(draw.getByText("Winners meet")).toBeVisible();
  await expect(page.getByText("Each pair plays")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start playing · 3 matches", exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("setup (D5): the × on side 3 removes it, and the format row goes with the third side", async ({ guest: page }) => {
  await openSetup(page);
  await page.getByRole("button", { name: "+ Add a side" }).click();
  await expect(page.getByTestId("qm-format-row")).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove side 1" })).toHaveCount(0);
  await page.getByRole("button", { name: "Remove side 3" }).click();
  await expect(side(page, 3)).toHaveCount(0);
  await expect(page.getByTestId("qm-format-row")).toHaveCount(0);
});

test("a refusal read on the server (?e=, the no-script path) shows its line", async ({ guest: page }) => {
  await page.goto("/en/play?e=QUICK_MATCH_RATE_LIMITED");
  await expect(page.getByTestId("qm-setup-error")).toContainText("Too many new matches from this network.");
});

test("a refused create shows its line and KEEPS the typed sides (the fetch follows the 303 back to /play?e=)", async ({ guest: page }) => {
  // The route's own refusal is a 303 to /<locale>/play?e=<code> (create-route.test.ts); the cap it stands for needs five
  // live matches on one visitor, so the answer is stubbed here and everything after it is real: the browser follows the
  // 303, the page renders, and the island reads `res.url`.
  await page.route("**/api/quick-match", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 303, headers: { location: "/en/play?e=QUICK_MATCH_TOO_MANY_ALIVE" } })
      : route.continue(),
  );
  await openSetup(page);
  await side(page, 1).fill("Ravi & Sam");
  await side(page, 2).fill("Priya & Tom");
  await start(page).click();
  await expect(page.getByTestId("qm-setup-error")).toContainText("You have 5 quick matches on the go on this device.");
  await expect(page).toHaveURL(/\/en\/play$/);
  await expect(side(page, 1)).toHaveValue("Ravi & Sam");
  await expect(side(page, 2)).toHaveValue("Priya & Tom");
  await expect(start(page), "unlocked for another try").toBeEnabled();
});

test("Start creates the quick match: the browser lands on its home, /q/qm_…, with no query, and holds a visitor key", async ({ guest: page }) => {
  await openSetup(page);
  await form(page).getByLabel("Name", { exact: true }).fill(`e2e setup ${TAG}`);
  await side(page, 1).fill("Ravi & Sam");
  await side(page, 2).fill("Priya & Tom");
  await start(page).click();
  await expect(page).toHaveURL(/\/q\/qm_[^/?#]+$/);
  const cookies = await page.context().cookies();
  expect(cookies.some((c) => c.name === "seazn_qm_visitor" && c.httpOnly)).toBe(true);
});

test("the real cap: five live quick matches on one visitor, and the sixth Start reads the cap's line and keeps the names (m10)", async ({ guest: page }) => {
  // Five REAL creates through the form's own fields (the page's fetch, so the visitor cookie the first one sets is the
  // one the next four carry), then a sixth through the Start button. QUICK_MATCH_MAX_ALIVE_PER_VISITOR is 5 (spec §7.9);
  // the per-IP create limit (20 per 10 minutes) leaves room for this spec's eight creates.
  await openSetup(page);
  await side(page, 1).fill(`Cap A ${TAG}`);
  await side(page, 2).fill(`Cap B ${TAG}`);
  for (let k = 1; k <= 5; k++) {
    const landed = await page.evaluate(async () => {
      const form = document.querySelector<HTMLFormElement>('[data-testid="qm-setup-form"]')!;
      const res = await fetch(form.action, { method: "POST", body: new URLSearchParams(new FormData(form) as never) });
      return res.url;
    });
    expect(landed, `create ${k} lands on its home`).toMatch(/\/q\/qm_[^/?#]+$/);
  }
  const refusedPage = page.waitForResponse((r) => r.url().includes("/en/play?e=QUICK_MATCH_TOO_MANY_ALIVE"));
  await start(page).click();
  expect((await refusedPage).status()).toBe(200);
  await expect(page.getByTestId("qm-setup-error")).toContainText("You have 5 quick matches on the go on this device.");
  await expect(page).toHaveURL(/\/en\/play$/);
  await expect(side(page, 1)).toHaveValue(`Cap A ${TAG}`);
  await expect(side(page, 2)).toHaveValue(`Cap B ${TAG}`);
});

test("without the script the page still works: Start is live, only the chosen sport can be picked, and the plain post lands on the home (I1)", async ({ browser }, info) => {
  // The plain post carries no bot-check token. It lands here because e2e's server is a harness (ENV_NAME ci), which skips
  // Cloudflare Turnstile (server/turnstile.ts `turnstileMode`); a deployed server refuses it with
  // QUICK_MATCH_TURNSTILE_FAILED, as #1136's forms are refused without the script (create-route.test.ts, the bot-check block).
  const ctx = await guestContext(browser, info, { javaScriptEnabled: false });
  try {
    const page = await ctx.newPage();
    await page.goto("/en/play");
    await expect(form(page)).toBeVisible();
    await expect(start(page)).toBeEnabled();
    await expect(form(page).getByRole("radio", { name: "Badminton", exact: true })).toBeChecked();
    await expect(form(page).getByRole("radio", { name: "Tennis", exact: true })).toBeDisabled();
    await side(page, 1).fill("Ravi & Sam");
    await side(page, 2).fill("Priya & Tom");
    await start(page).click();
    await expect(page).toHaveURL(/\/q\/qm_[^/?#]+$/);
  } finally {
    await ctx.close();
  }
});

test("every control a thumb taps is at least 44px tall, the × at least 44px wide (m3)", async ({ guest: page }) => {
  await openSetup(page);
  await page.getByRole("button", { name: "+ Add a side" }).click();
  const boxes: { what: string; h: number; w: number }[] = [];
  const measure = async (what: string, locator: ReturnType<Page["locator"]>) => {
    for (const el of await locator.all()) {
      const box = await el.boundingBox();
      expect(box, `${what} has a box`).not.toBeNull();
      boxes.push({ what, h: box!.height, w: box!.width });
    }
  };
  // The radios are sr-only; their visible faces are the labels' spans.
  await measure("chip/segment", form(page).locator("label:has(input[type=radio]) > span"));
  await measure("side", form(page).locator('input[name="sides"]'));
  await measure("remove", form(page).getByRole("button", { name: "Remove side 3" }));
  await measure("add", form(page).getByRole("button", { name: "+ Add a side" }));
  await measure("rules", form(page).locator("select"));
  await measure("email", form(page).locator("summary"));
  for (const b of boxes) expect(b.h, `${b.what} height`).toBeGreaterThanOrEqual(44);
  for (const b of boxes.filter((x) => x.what === "remove")) expect(b.w).toBeGreaterThanOrEqual(44);
  expect(boxes.length, "controls measured").toBeGreaterThanOrEqual(15);
});

test("first visit on a phone: the cookie banner's buttons stay tappable and the Start bar un-docks under it, then docks again (m4, m5)", async ({ browser }, info) => {
  const ctx = await guestContext(browser, info, { storageState: { cookies: [], origins: [] }, viewport: { width: 375, height: 667 } });
  try {
    const page = await ctx.newPage();
    await page.goto("/en/play");
    const banner = page.getByTestId("cookie-consent");
    await expect(banner).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-consent-open", "");
    const bar = page.getByTestId("qm-start-bar");
    await expect(bar).toHaveCSS("position", "static");
    // Hit-test the banner's Accept at its centre: nothing of the page sits on top of it.
    const accept = page.getByTestId("cookie-accept");
    const box = (await accept.boundingBox())!;
    const onTop = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="cookie-accept"]') !== null,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(onTop, "Accept is the element under its own centre").toBe(true);
    await accept.click();
    await expect(banner).toHaveCount(0);
    await expect(page.locator("html")).not.toHaveAttribute("data-consent-open");
    await expect(bar).toHaveCSS("position", "sticky");
    await expectNoHorizontalScroll(page);
  } finally {
    await ctx.close();
  }
});

