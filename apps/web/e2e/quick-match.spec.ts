import { test as base, expect, type Page } from "@playwright/test";
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

// Playwright's `use` callback is named `provide`: react-hooks lints any call named `use` (own-account.ts).
const test = base.extend<{ guest: Page }>({
  guest: async ({ browser }, provide) => {
    const ctx = await browser.newContext({ storageState: await consentedAnonymousState() });
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
