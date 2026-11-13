import { test as base, expect, type Browser, type BrowserContextOptions, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expectNoHorizontalScroll, loginUi, TAG, withDb } from "./helpers";
import { consentedAnonymousState } from "./scorepad-a11y-kit";
import { HOLD_MS } from "../src/components/v2/scorepad/queue";
import { QUICK_MATCH_EXPIRY_DAYS, QUICK_MATCH_MAX_SIDES } from "../src/lib/quick-match-constants";

// Quick match plan 2 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5): the guest's surfaces in a real
// browser, at 1280 (the `parallel` project). Task 4 writes the setup screen's cases; Task 10 extends this file with the
// league flow (setup → home → Score → a rally → back) and the URL forms, and adds the seven-width case to mobile.spec.ts.
// A quick match is a league (owner 2026-11-12, "take out": League + Knockout comes later), so the setup screen offers no
// format at any number of sides, and a crafted knockout post is refused (the case after "a refused create").
//
// What the island's unit tests cannot see, and these do: the real form post and its 303 followed by the browser's own
// fetch (the visitor cookie set on a redirect, `res.url`), hydration (the suggested name dated in the BROWSER's zone),
// the real chips/radios under a click, and the page's width.
//
// A guest: no session, in a context of its own (a fixture rather than `test.use({ storageState })`, own-account.ts says
// why). It has already answered the cookie banner, so the banner never sits over the docked Start bar
// (scorepad-a11y-kit.ts, `consentedAnonymousState`).
//
// Sport: badminton, clicked explicitly (A11): the spec's own example, with two kinds. The full offer is swept in
// play-page.test.tsx against the real catalog.

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

/** No format to pick (owner 2026-11-12, League only): neither format's words name a radio in the form, and no draw is
 *  previewed. Returns how many formats it checked (anti-vacuity: never zero). */
async function expectNoFormatChoice(page: Page, why: string): Promise<number> {
  let checked = 0;
  for (const format of ["league", "knockout"] as const) {
    await expect(form(page).getByRole("radio", { name: ui(`quickMatch.format.${format}`), exact: true }), `${why}: no ${format} to pick`).toHaveCount(0);
    checked += 1;
  }
  await expect(page.getByTestId("qm-draw"), `${why}: no draw`).toHaveCount(0);
  expect(checked, `${why}: formats checked`).toBe(2);
  return checked;
}

test("setup (C16, C17): two sides and no format to pick; Start waits for both names and counts one match; no sideways scroll", async ({ guest: page }) => {
  await openSetup(page);
  await expect(side(page, 1)).toBeVisible();
  await expect(side(page, 2)).toBeVisible();
  await expect(side(page, 3)).toHaveCount(0);
  await expectNoFormatChoice(page, "two sides");
  await expect(page.getByText("Each pair plays")).toBeVisible();
  await expect(start(page)).toBeDisabled();
  await side(page, 1).fill("Ravi & Sam");
  await side(page, 2).fill("Priya & Tom");
  await expect(start(page)).toBeEnabled();
  await expect(page.getByRole("button", { name: "Start playing · 1 match", exact: true })).toBeVisible();
  // The pair of the no-script test's line (review m3): with the script on, the <noscript> line never shows.
  await expect(page.getByText("Starting a quick match needs JavaScript.", { exact: true })).toBeHidden();
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

test("setup (owner 2026-11-12, League only): at 3 to 6 sides there is no Knockout or League to pick, the league's help is on screen, and Start counts the round robin", async ({ guest: page }) => {
  await openSetup(page);
  const names = ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max", "Kim & Raj", "Ana & Leo"];
  await side(page, 1).fill(names[0]!);
  await side(page, 2).fill(names[1]!);
  let checked = 0;
  for (let n = 3; n <= QUICK_MATCH_MAX_SIDES; n++) {
    await form(page).getByRole("button", { name: mk("quickMatch.setup.addSide") }).click();
    await side(page, n).fill(names[n - 1]!);
    await expectNoFormatChoice(page, `${n} sides`);
    await expect(form(page).getByTestId("qm-league-help"), `${n} sides`).toHaveText(mk("quickMatch.setup.leagueHelp"));
    await expect(form(page).getByText(mk("quickMatch.setup.plays"), { exact: true }), `${n} sides: how often each pair plays`).toBeVisible();
    // The rulebook's count, never the page's: a single round robin of n sides plays n(n-1)/2 matches ("Once" is the default).
    const matches = (n * (n - 1)) / 2;
    await expect(page.getByTestId("qm-start-count"), `${n} sides`).toHaveText(plural(mk, "quickMatch.setup.startCount", matches));
    await expectNoHorizontalScroll(page);
    checked += 1;
  }
  expect(checked, "anti-vacuity: side counts checked, 3 to the most a quick match takes").toBe(QUICK_MATCH_MAX_SIDES - 2);
  expect(checked).toBeGreaterThan(0);
  // Owner 2026-11-12: just above Start, said plainly, that an unsaved quick match is deleted, after the sweep's own days.
  const note = page.getByTestId("qm-keep-note");
  await expect(note).toHaveText(mk("quickMatch.setup.keepNote", { days: QUICK_MATCH_EXPIRY_DAYS }));
  const [noteBox, startBox] = [await note.boundingBox(), await start(page).boundingBox()];
  expect(noteBox && startBox && noteBox.y + noteBox.height <= startBox.y, "the line sits above Start").toBe(true);
  await expect(form(page).getByRole("button", { name: mk("quickMatch.setup.addSide") }), "at the most sides there is no row to add").toHaveCount(0);
});

test("setup (D5): the × on side 3 removes it and the count goes back with it; sides 1 and 2 have no ×", async ({ guest: page }) => {
  await openSetup(page);
  await page.getByRole("button", { name: "+ Add a side" }).click();
  await expect(side(page, 3)).toBeVisible();
  // A round robin of 3 plays 3, of 2 plays 1 (n(n-1)/2).
  await expect(page.getByTestId("qm-start-count")).toHaveText(plural(mk, "quickMatch.setup.startCount", 3));
  await expect(page.getByRole("button", { name: "Remove side 1" })).toHaveCount(0);
  await page.getByRole("button", { name: "Remove side 3" }).click();
  await expect(side(page, 3)).toHaveCount(0);
  await expect(page.getByTestId("qm-start-count")).toHaveText(plural(mk, "quickMatch.setup.startCount", 1));
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

test("a crafted knockout post is refused (owner 2026-11-12, League only): it lands on /en/play?e=QUICK_MATCH_FORMAT_NOT_OFFERED and the page says so", async ({ guest: page }) => {
  // A stale page or a hand-made post: the setup form's own fields, the format alone changed to a knockout, posted by the
  // browser itself as a plain form post (quick-match-home.spec.ts posts its crafted forms the same way). It reaches the
  // create because this harness skips the bot check (the no-script case below says why); nothing is stubbed.
  await openSetup(page);
  await side(page, 1).fill("Ravi & Sam");
  await side(page, 2).fill("Priya & Tom");
  // The positive pair: the form the guest sees names a league, and only the crafted copy says otherwise.
  await expect(form(page).locator('input[name="format"]')).toHaveValue("league");
  // The refusal is caught as the redirected GET: `?e=` stays in the URL only until the page's ClearFlashParam takes it out.
  const landed = page.waitForRequest((r) => {
    if (r.method() !== "GET") return false;
    const url = new URL(r.url());
    return url.pathname === "/en/play" && url.searchParams.get("e") === "QUICK_MATCH_FORMAT_NOT_OFFERED";
  });
  const sent = await page.evaluate(() => {
    const real = document.querySelector<HTMLFormElement>('[data-testid="qm-setup-form"]')!;
    const fields = new FormData(real);
    fields.set("format", "knockout");
    const crafted = document.createElement("form");
    crafted.method = "post";
    crafted.action = real.action;
    fields.forEach((value, name) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = String(value);
      crafted.append(input);
    });
    document.body.append(crafted);
    crafted.submit();
    return { format: fields.getAll("format").map(String), sides: fields.getAll("sides").length };
  });
  expect(sent, "the crafted post asks for one knockout of the two typed sides").toEqual({ format: ["knockout"], sides: 2 });
  expect((await landed).redirectedFrom()?.method(), "the post's 303 landed on the refusal").toBe("POST");
  await expect(page.getByTestId("qm-setup-error")).toHaveText(mk("quickMatch.errors.formatNotOffered"));
  await expect(page, "no home was made: the guest is still on the setup page").toHaveURL(/\/en\/play$/);
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

test("Continue (owner 2026-11-12): back on /play after a Start, the unfinished match is met first, above the form, and Continue lands on its home; the form is still there", async ({ guest: page }) => {
  const name = `e2e continue ${TAG}`;
  const home = await createFromSetup(page, name, ["Ravi & Sam", "Priya & Tom"]);
  await page.goto("/en/play");
  const card = page.getByTestId("qm-continue");
  await expect(card).toBeVisible();
  await expect(card.getByRole("heading", { level: 2 })).toHaveText(name);
  // A league of two sides, once: the rulebook's one match, none played yet.
  await expect(page.getByTestId("qm-continue-played")).toHaveText(ui("quickMatch.home.playedSaved.one", { played: 0, count: 1 }));
  await expect(page.getByTestId("qm-start-new")).toHaveText(mk("quickMatch.continue.startNew"));
  // Met first: the card sits above the heading, and the heading above the form, which never goes away.
  const [c, h, f] = await Promise.all([card, page.getByTestId("qm-start-new"), form(page)].map((l) => l.boundingBox()));
  expect(c && h && f && c.y + c.height <= h.y && h.y + h.height <= f.y, "card, then the heading, then the form").toBe(true);
  await expect(start(page)).toBeVisible();
  // Its one row is the card now: the strip below has nothing left to list.
  await expect(page.getByTestId("qm-recent")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await page.getByTestId("qm-continue-link").click();
  await page.waitForURL((url) => url.pathname === home, { timeout: NAV_MS });
  await expect(page.getByTestId("qm-name")).toHaveText(name);
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

test("without the script: the page says it needs JavaScript, Start is live, only the chosen sport can be picked, and on this harness (bot check skipped; a deployed server refuses the post) the plain post lands on the home (I1)", async ({ browser }, info) => {
  // The plain post carries no bot-check token. It lands here because e2e's server is a harness (ENV_NAME ci), which skips
  // Cloudflare Turnstile (server/turnstile.ts `turnstileMode`); a deployed server refuses it with
  // QUICK_MATCH_TURNSTILE_FAILED, as #1136's forms are refused without the script (create-route.test.ts, the bot-check block).
  const ctx = await guestContext(browser, info, { javaScriptEnabled: false });
  try {
    const page = await ctx.newPage();
    await page.goto("/en/play");
    await expect(form(page)).toBeVisible();
    // Review m3: the server's HTML says, in the Start bar, that a quick match needs the script, since a deployed server refuses
    // this plain post. Asserted on the element's DOM text, not on its visibility: Playwright's per-context JS-off still parses
    // <noscript> as raw text in Chromium and WebKit (and its text matchers skip a noscript's contents), while Blink's own
    // scripting switch, which does render the line, also stops Playwright's locators. The rendered line was checked by eye
    // with that switch (task-TS report, round 3).
    await expect(page.getByTestId("qm-start-bar").locator("noscript")).toHaveJSProperty(
      "textContent",
      "Starting a quick match needs JavaScript.",
    );
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

// ── Save (plan 3 Task 5) ────────────────────────────────────────────────────────────────────────────────────────────
//
// The save page (`/q/<token>/save`) and the Save post (`/q/<token>/save/confirm`): the route's every answer and the page's
// every state are proven in app/q/[token]/__tests__/save-route.test.ts and save-page.test.tsx; this is what only a browser
// shows: the page's width with a real name at 320, 768 and 1280, the 44px targets, the plain post without the script, and
// the sign-in's real round trip back to the save page. The full journey (a typed address, a second account, a second guest)
// is the walkthrough's (D).

const SAVE_WIDTHS = [320, 768, 1280] as const;

test("Save (plan 3 Task 5): the save page at 320, 768 and 1280; without the script and signed out it posts to the sign-in; signed in it saves", async ({ guest: page, browser }, info) => {
  const name = `e2e save ${TAG}`;
  await openSetup(page);
  await form(page).getByLabel("Name", { exact: true }).fill(name);
  await side(page, 1).fill("Ravi & Sam");
  await side(page, 2).fill("Priya & Tom");
  await start(page).click();
  await expect(page).toHaveURL(/\/q\/qm_[^/?#]+$/);
  const home = new URL(page.url()).pathname;
  const savePage = `${home}/save`;

  // The save page, signed out, at each width: the name, what saving does, one button and the way back, each a 44px target.
  await page.goto(savePage);
  let checked = 0;
  for (const width of SAVE_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByTestId("qm-save-title"), `${width}`).toHaveText(`Keep ${name} in your account?`);
    await expect(page.getByTestId("qm-save-hint"), `${width}`).toHaveText("It stays until you delete it. Anyone with the link can still score.");
    for (const id of ["qm-save", "qm-save-back"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box?.height ?? 0, `${width}: ${id} is a 44px target`).toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalScroll(page);
    checked++;
  }
  expect(checked).toBe(SAVE_WIDTHS.length);

  // Without the script: the same page's plain post reaches the route, which sends a signed-out guest to sign in.
  const noScript = await guestContext(browser, info, { javaScriptEnabled: false });
  try {
    const plain = await noScript.newPage();
    await plain.goto(savePage);
    await plain.getByTestId("qm-save").click();
    await expect(plain).toHaveURL(/\/login\?next=/);
    expect(new URL(plain.url()).searchParams.get("next"), "no script: the sign-in carries the save page").toBe(savePage);
  } finally {
    await noScript.close();
  }

  // Signed out, from the home: Save goes to the sign-in, carrying the save page.
  await page.goto(home);
  await page.getByTestId("qm-save").click();
  await page.waitForURL((u) => u.pathname === "/login");
  expect(new URL(page.url()).searchParams.get("next")).toBe(savePage);

  // Signed in by the real magic link: back on the save page; Save lands on the home, which says Saved at every width.
  await loginUi(page, `delivered+e2e-qm-save-${TAG}-${Math.random().toString(36).slice(2, 7)}@resend.dev`, savePage);
  await expect(page.getByTestId("qm-save-title")).toHaveText(`Keep ${name} in your account?`);
  await page.getByTestId("qm-save").click();
  await page.waitForURL((u) => u.pathname === home && u.search === "");
  checked = 0;
  for (const width of SAVE_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByTestId("qm-saved"), `${width}`).toHaveText("Saved");
    await expect(page.getByTestId("qm-save"), `${width}: no button once saved`).toHaveCount(0);
    // Plan 3 Task 6: beside "Saved", the way to the account's Quick matches.
    const inAccount = page.getByTestId("qm-in-account");
    await expect(inAccount, `${width}`).toHaveText("In your account");
    await expect(inAccount, `${width}`).toHaveAttribute("href", "/me#quick-matches");
    expect((await inAccount.boundingBox())?.height ?? 0, `${width}: In your account is a 44px target`).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalScroll(page);
    checked++;
  }
  expect(checked).toBe(SAVE_WIDTHS.length);
});

// The account's Quick matches on /me (quick match plan 3 Task 6): the list's every answer is proven in
// app/me/__tests__/quick-matches-section.test.tsx and the requests' in app/api/quick-match/__tests__/owner-routes.test.ts;
// this is what only a browser shows: the row with the longest name the create allows at 320, 768 and 1280, Rename's form
// and Delete's confirmation opened at each, every control a 44px target, nothing sideways; and a match deleted from another
// tab while this one's Rename form was open: Save name drops the row, the list's live region says it is no longer in the
// account, and focus lands on the list's own root rather than the page's body (T6 review m1, m2). The full journey (the rename read back
// on the home, the delete for everyone, the dead link) is the walkthrough's (D).
test("the account's Quick matches (plan 3 Task 6): /me at 320, 768 and 1280 with an 80-character name; Rename's form and Delete's confirmation; a match deleted in another tab drops the row on Save name and says why", async ({ guest: page }) => {
  // A setup, a magic-link sign-in and a save before three widths of two opened panels and a second tab: past the 60s default.
  test.slow();
  // The longest name the create allows, its tail one unbroken word: the hardest to fit at 320.
  const name = `e2e me ${TAG} ${"Longwordwithoutanybreak".repeat(4)}`.slice(0, 80);
  await openSetup(page);
  await form(page).getByLabel("Name", { exact: true }).fill(name);
  await side(page, 1).fill("Ravi & Sam");
  await side(page, 2).fill("Priya & Tom");
  await start(page).click();
  await expect(page).toHaveURL(/\/q\/qm_[^/?#]+$/);
  const home = new URL(page.url()).pathname;
  await loginUi(page, `delivered+e2e-qm-me-${TAG}-${Math.random().toString(36).slice(2, 7)}@resend.dev`, `${home}/save`);
  await page.getByTestId("qm-save").click();
  await page.waitForURL((u) => u.pathname === home && u.search === "");

  await page.goto("/me");
  const row = page.getByTestId("me-quick-matches").locator("li[data-qm-id]");
  await expect(row).toHaveCount(1);
  const tall = async (id: string, width: number) => {
    const box = await row.getByTestId(id).boundingBox();
    expect(box?.height ?? 0, `${width}: ${id} is a 44px target`).toBeGreaterThanOrEqual(44);
  };
  let checked = 0;
  for (const width of SAVE_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect(row.getByTestId("me-qm-name"), `${width}`).toHaveText(name);
    await expect(row.getByTestId("me-qm-name"), `${width}`).toHaveAttribute("href", home);
    for (const id of ["me-qm-name", "me-qm-rename", "me-qm-delete"]) await tall(id, width);
    await expectNoHorizontalScroll(page);

    await row.getByTestId("me-qm-rename").click();
    await expect(row.getByTestId("me-qm-rename-input"), `${width}`).toHaveValue(name);
    for (const id of ["me-qm-rename-input", "me-qm-rename-save", "me-qm-rename-cancel"]) await tall(id, width);
    await expectNoHorizontalScroll(page);
    await row.getByTestId("me-qm-rename-cancel").click();
    await expect(row.getByTestId("me-qm-rename-form"), `${width}: Cancel closes the form`).toHaveCount(0);

    await row.getByTestId("me-qm-delete").click();
    await expect(row.getByTestId("me-qm-delete-question"), `${width}`).toHaveText("Delete this quick match for everyone? The link stops working.");
    for (const id of ["me-qm-delete-yes", "me-qm-delete-cancel"]) await tall(id, width);
    await expectNoHorizontalScroll(page);
    await row.getByTestId("me-qm-delete-cancel").click();
    await expect(row.getByTestId("me-qm-delete-confirm"), `${width}: Cancel keeps the match`).toHaveCount(0);
    checked++;
  }
  expect(checked).toBe(SAVE_WIDTHS.length);

  // A second tab of the same account deletes the match while this tab's Rename form is open: Save name is refused as not in
  // the account, so the row goes, the live region says why, and focus stays on the list (the heading went with the row).
  await row.getByTestId("me-qm-rename").click();
  const other = await page.context().newPage();
  try {
    await other.goto("/me");
    const there = other.getByTestId("me-quick-matches").locator("li[data-qm-id]");
    await there.getByTestId("me-qm-delete").click();
    await there.getByTestId("me-qm-delete-yes").click();
    await expect(other.getByTestId("me-quick-matches"), "the other tab's list is empty, so gone").toHaveCount(0);
  } finally {
    await other.close();
  }
  await row.getByTestId("me-qm-rename-input").fill(`Too late ${TAG}`);
  await row.getByTestId("me-qm-rename-save").click();
  await expect(page.getByTestId("me-quick-matches"), "the gone row is dropped, and the section with it").toHaveCount(0);
  await expect(page.getByTestId("me-qm-status")).toHaveText("This quick match is no longer in your account.");
  await expect(page.getByTestId("me-qm-status")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("me-qm-root"), "focus on a stable target, not the page's body").toBeFocused();
  await expectNoHorizontalScroll(page);
  // The page's own read: no Quick matches left.
  await page.reload();
  await expect(page.locator("h1.page-title")).toBeVisible();
  await expect(page.getByTestId("me-quick-matches")).toHaveCount(0);
});

// T-ADM review m5: Delete with OTHER rows left. The list moves focus to its heading when rows remain and to its own root when
// the last one goes (my-list.tsx `settle`); the case above loses the LAST row, so only this one sees the heading branch.
test("the account's Quick matches (plan 3 Task 6, review m5): two saved, one deleted, the other stays and focus lands on the list's heading", async ({ guest: page }) => {
  // Two setups, a magic-link sign-in and two saves: past the 60s default.
  test.slow();
  const names = [`e2e me two A ${TAG}`, `e2e me two B ${TAG}`];
  const homes: string[] = [];
  for (const [i, name] of names.entries()) {
    await openSetup(page);
    await form(page).getByLabel("Name", { exact: true }).fill(name);
    await side(page, 1).fill("Ravi & Sam");
    await side(page, 2).fill("Priya & Tom");
    await start(page).click();
    await expect(page).toHaveURL(/\/q\/qm_[^/?#]+$/);
    const home = new URL(page.url()).pathname;
    homes.push(home);
    // The first save signs in by the real magic link, back on the save page; the second is already signed in.
    if (i === 0) await loginUi(page, `delivered+e2e-qm-me-two-${TAG}-${Math.random().toString(36).slice(2, 7)}@resend.dev`, `${home}/save`);
    else await page.goto(`${home}/save`);
    await expect(page.getByTestId("qm-save-title")).toHaveText(`Keep ${name} in your account?`);
    await page.getByTestId("qm-save").click();
    await page.waitForURL((u) => u.pathname === home && u.search === "");
  }
  expect(homes).toHaveLength(2);

  await page.goto("/me");
  const rows = page.getByTestId("me-quick-matches").locator("li[data-qm-id]");
  await expect(rows).toHaveCount(2);
  const doomed = rows.filter({ hasText: names[0]! });
  await doomed.getByTestId("me-qm-delete").click();
  await doomed.getByTestId("me-qm-delete-yes").click();

  await expect(rows, "the deleted row goes, the other stays").toHaveCount(1);
  await expect(rows.getByTestId("me-qm-name")).toHaveText(names[1]!);
  await expect(page.getByTestId("me-qm-status")).toHaveText(`${names[0]} was deleted.`);
  await expect(page.locator("#me-quick-matches-title"), "rows remain: focus on the list's heading").toBeFocused();
  await expect(page.getByTestId("me-qm-root"), "not the root (that is for the last row)").not.toBeFocused();
  await expectNoHorizontalScroll(page);
  // The page's own read agrees: one left, the one not deleted.
  await page.reload();
  await expect(page.getByTestId("me-quick-matches").locator("li[data-qm-id]")).toHaveCount(1);
  await expect(page.getByTestId("me-quick-matches").getByTestId("me-qm-name")).toHaveText(names[1]!);
});

// ── Task 10: the league flow, the URL forms ─────────────────────────────────────────────────────────────────────────
//
// The plan's own Task 10 cases, at 1280 (pre-flight amendment B10/D7). What they add over the cases above, the home spec
// (quick-match-home.spec.ts) and the walkthrough (walkthrough/quick-match.spec.ts, which plays whole matches at 390 and
// always leaves the pad by its own link): the BROWSER's Back from the pad after a rally reads the home fresh, and the home
// opens from the link forms a guest really pastes. The seven widths are mobile.spec.ts's quick match cases. (Task 10's
// knockout of four left with the owner's "take out" of 2026-11-12: a guest cannot make one; the knockout home stays
// covered by its unit tests for League + Knockout.)
//
// Every line the home is expected to read is the en dictionary's (never retyped); the score after one rally is the
// rulebook's (rally-point scoring: the side that wins a rally adds one point); the match counts are the format's (a round
// robin of n plays n(n-1)/2).

type Words = Record<string, string>;
const readWords = (rel: string): Words => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as Words;
const UI = readWords("../src/dictionaries/en/ui.json");
const MK = readWords("../src/dictionaries/en/marketing.json");
/** An en line of `dict` with its `{name}` slots filled; a missing key or slot throws rather than reading "undefined". */
function words(dict: Words, which: string, key: string, vars: Record<string, string | number> = {}): string {
  const text = dict[key];
  if (typeof text !== "string") throw new Error(`the en ${which} dictionary has no "${key}"`);
  return text.replace(/\{(\w+)\}/g, (_, slot: string) => {
    if (!Object.hasOwn(vars, slot)) throw new Error(`"${key}" needs {${slot}}`);
    return String(vars[slot]);
  });
}
/** An en ui line (ui.json). */
function ui(key: string, vars: Record<string, string | number> = {}): string {
  return words(UI, "ui", key, vars);
}
/** An en marketing line (marketing.json: the setup screen's copy). */
function mk(key: string, vars: Record<string, string | number> = {}): string {
  return words(MK, "marketing", key, vars);
}
const EN_PLURAL = new Intl.PluralRules("en");
/** A plural line: `key.one` / `key.other` by the en rules, `{count}` filled. */
function plural(say: (key: string, vars?: Record<string, string | number>) => string, key: string, count: number): string {
  return say(`${key}.${EN_PLURAL.select(count)}`, { count });
}

/** A page load or a redirect followed (the flow's budget is built from it and the hold, AGENTS.md class 20). */
const NAV_MS = 20_000;

/** Make a quick match through the setup form (badminton, clicked) and land on its home; returns the home's path. A quick
 *  match is a league (owner 2026-11-12): there is no format to pick. */
async function createFromSetup(page: Page, name: string, sides: readonly string[]) {
  await openSetup(page);
  await form(page).getByLabel("Name", { exact: true }).fill(name);
  for (let n = 3; n <= sides.length; n += 1) await form(page).getByRole("button", { name: "+ Add a side" }).click();
  for (const [i, s] of sides.entries()) await side(page, i + 1).fill(s);
  await start(page).click();
  await page.waitForURL(/\/q\/qm_[^/?#]+$/, { timeout: NAV_MS });
  return new URL(page.url()).pathname;
}

/** The ledger's rallies on one fixture: the record, never the pad's own fold. */
async function ralliesOn(fixtureId: string): Promise<number> {
  const [row] = await withDb(
    (sql) => sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId} and type = 'badminton.rally'`,
  );
  return row!.n;
}

/** Badminton's live score reads as its levels in seat order (`compactScore`, lib/match-day/view.ts): the games won, then the
 *  game's points ("0–0 · 1–0"). One rally to the home side is a point and no game, so the games stay 0–0 and the points read
 *  1–0. Before that rally the last level reads 0–0, which this does not match. */
const AFTER_ONE_HOME_RALLY = /^\s*0\D+0\D+1\D+0\s*$/;

/** The hero as a person reads it: live, match 1 of `total`, and the score after ONE rally to the home side (seat order). */
async function expectHeroAfterOneHomeRally(page: Page, total: number, why: string) {
  const hero = page.getByTestId("qm-hero");
  await expect(hero.getByTestId("qm-hero-kicker"), why).toHaveText(ui("quickMatch.home.liveMatch", { n: 1, total }));
  await expect(hero.getByTestId("qm-hero-score"), `${why}: no game yet; one point to the home side, none to the away side`).toHaveText(
    AFTER_ONE_HOME_RALLY,
  );
}

/** The hero's match is the list's next one (by its sides, the names a person reads), and the list names exactly one. */
async function nextMatchIsTheHeros(page: Page): Promise<string> {
  const hero = page.getByTestId("qm-hero");
  const next = page.locator('[data-testid="qm-match"][data-next="true"]');
  await expect(next).toHaveCount(1);
  const sides = next.getByTestId("qm-match-sides");
  for (const who of ["qm-hero-home", "qm-hero-away"]) {
    const name = (await hero.getByTestId(who).textContent())?.trim() ?? "";
    expect(name, `the hero names its ${who === "qm-hero-home" ? "home" : "away"} side`).not.toBe("");
    await expect(sides, "the list's next match is the hero's").toContainText(name);
  }
  return (await next.getAttribute("data-fixture-id"))!;
}

/** The record holds `n` rallies and keeps holding them for longer than the pad's hold: a rally queued on the way out and
 *  sent late would land inside the window. Returns how many reads it took (anti-vacuity: never zero). */
async function ralliesStayAt(fixtureId: string, n: number, why: string): Promise<number> {
  const until = Date.now() + HOLD_MS + 1_000;
  let reads = 0;
  do {
    expect(await ralliesOn(fixtureId), `${why} (read ${reads + 1})`).toBe(n);
    reads += 1;
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < until);
  expect(reads, "the record was read across the whole window").toBeGreaterThan(1);
  return reads;
}

test("the league flow (Task 10, Review Focus 2): Score → Start → one rally; Back re-requests the home and is not served stale from the HTTP cache (live, the rally's score); Forward, then 'Back to the quick match', reads it too", async ({ guest: page }) => {
  // Seven page loads or redirects, the rally's hold before it is sent, the record read back, and the late-send window after:
  // derived, never a flat literal.
  test.setTimeout(7 * NAV_MS + HOLD_MS + NAV_MS + (HOLD_MS + 1_000 + NAV_MS));
  const home = await createFromSetup(page, `e2e flow ${TAG}`, ["Ravi & Sam", "Priya & Tom"]);
  // Fresh, before anything is scored: up next, no score. The negative pair of what Back must read below.
  const hero = page.getByTestId("qm-hero");
  await expect(hero.getByTestId("qm-hero-kicker")).toHaveText(ui("quickMatch.home.upNext", { n: 1, total: 1 }));
  await expect(hero.getByTestId("qm-hero-score"), "nothing scored yet: no score on the hero").toHaveCount(0);
  await expectNoHorizontalScroll(page);
  const fixtureId = await nextMatchIsTheHeros(page);

  // Score → the pad's Confirm card → Start match → one rally to the home side, in the record before anything leaves the pad.
  await hero.getByTestId("qm-score").click();
  await page.waitForURL(/\/score\/dl_[A-Za-z0-9_-]+$/, { timeout: NAV_MS });
  const pad = new URL(page.url()).pathname;
  await page.getByTestId("score-start-match").click();
  const homeHalf = page.locator('[data-role="pad-v3"] button[data-role="v3-scorebug-half"][data-side="home"]');
  await expect(homeHalf, "Start opens the pad, its halves tappable").toBeVisible({ timeout: NAV_MS });
  await homeHalf.click();
  // The pad soft-commits: the rally is sent only after the hold (queue.ts), so the record is polled past it.
  await expect.poll(() => ralliesOn(fixtureId), { timeout: HOLD_MS + NAV_MS, message: "the rally never reached the ledger" }).toBe(1);

  // The browser's own Back. Playwright's Chromium runs with its back-forward cache OFF (`--disable-back-forward-cache`), so
  // this Back is always a request: what it proves is that the HTTP cache does not hand the home back stale (no-store). A
  // restore from the back-forward cache, what a phone does, is the review I-1 case below.
  await page.goBack();
  await page.waitForURL((u) => u.pathname === home, { timeout: NAV_MS });
  await expectHeroAfterOneHomeRally(page, 1, "after the browser's Back");
  await expectNoHorizontalScroll(page);

  // Forward to the pad again, then its own way back.
  await page.goForward();
  await page.waitForURL((u) => u.pathname === pad, { timeout: NAV_MS });
  await page.getByTestId("quick-match-back-link").click();
  await page.waitForURL((u) => u.pathname === home && u.search === "", { timeout: NAV_MS });
  await expectHeroAfterOneHomeRally(page, 1, "after 'Back to the quick match'");
  await ralliesStayAt(fixtureId, 1, "nothing more was sent on the way, nor late");
});

// Review I-1. A phone's browser (iOS Safari above all) keeps the home whole in its back-forward cache when the guest taps
// Score, and Back shows that copy without asking the server; no-store does not stop it. `QuickMatchRefreshOnRestore`
// reloads the page on the restore's `pageshow` (persisted). This case launches a Chromium of its own WITH the cache (the
// project's carries `--disable-back-forward-cache`) and records every pageshow of the tab in sessionStorage, which outlives
// both a restore and a reload: Back that RESTORES reads [persisted, then the island's reload], one that reloads reads
// [a plain load]. On the restore path the hero can read the rally only because the island reloaded (remove it and the
// restored page is the "Up next" home the guest left). When this Chromium declines to keep the page (a no-store page enters
// its cache only behind a feature switch), Back is the league case's plain load again and proves nothing about the island:
// the case SKIPS, with Chromium's reasons, so the skip count says the restore never ran (review I-3), and the handler's proof
// is its unit test (refresh-on-restore.test.tsx). Only the restore path passes. A goBack that hangs under a real cache times
// out at NAV_MS: read that as the harness (Playwright disables the cache partly for this), not the product (review m7).
test("Back from the pad on a browser WITH a back-forward cache (review I-1): the restored home reads the rally, not the page it left", async ({ playwright }, info) => {
  test.setTimeout(8 * NAV_MS + HOLD_MS + NAV_MS);
  const browser = await playwright.chromium.launch({ ignoreDefaultArgs: ["--disable-back-forward-cache"] });
  try {
    const ctx = await guestContext(browser, info);
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.addEventListener("pageshow", (e) => {
        const seen = JSON.parse(sessionStorage.getItem("qm-e2e-shows") ?? "[]") as boolean[];
        sessionStorage.setItem("qm-e2e-shows", JSON.stringify([...seen, e.persisted]));
      });
    });
    const home = await createFromSetup(page, `e2e bfcache ${TAG}`, ["Ravi & Sam", "Priya & Tom"]);
    const hero = page.getByTestId("qm-hero");
    await expect(hero.getByTestId("qm-hero-kicker"), "the page Back would restore: up next").toHaveText(
      ui("quickMatch.home.upNext", { n: 1, total: 1 }),
    );
    await expect(hero.getByTestId("qm-hero-score"), "and no score").toHaveCount(0);
    const fixtureId = await nextMatchIsTheHeros(page);

    await hero.getByTestId("qm-score").click();
    await page.waitForURL(/\/score\/dl_[A-Za-z0-9_-]+$/, { timeout: NAV_MS });
    await page.getByTestId("score-start-match").click();
    const homeHalf = page.locator('[data-role="pad-v3"] button[data-role="v3-scorebug-half"][data-side="home"]');
    await expect(homeHalf, "Start opens the pad, its halves tappable").toBeVisible({ timeout: NAV_MS });
    await homeHalf.click();
    await expect.poll(() => ralliesOn(fixtureId), { timeout: HOLD_MS + NAV_MS, message: "the rally never reached the ledger" }).toBe(1);

    // From here, only Back's pageshows are recorded.
    await page.evaluate(() => sessionStorage.removeItem("qm-e2e-shows"));
    // A restore fires no load event: Back waits for the commit only.
    await page.goBack({ waitUntil: "commit", timeout: NAV_MS });
    await page.waitForURL((u) => u.pathname === home, { timeout: NAV_MS, waitUntil: "commit" });
    await expectHeroAfterOneHomeRally(page, 1, "after Back on a browser with a back-forward cache");

    // `pageshow` follows the load event, which can trail the hero's text: poll the record until it settles. (A read during
    // the island's reload meets a torn-down context and is simply read again.)
    const readShows = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("qm-e2e-shows") ?? "[]") as boolean[]);
    await expect.poll(async () => (await readShows()).length, { timeout: NAV_MS, message: "Back's pageshow was never recorded" }).toBeGreaterThan(0);
    if ((await readShows())[0] !== true) {
      await expect.poll(readShows, { timeout: NAV_MS, message: "not restored: one plain load" }).toEqual([false]);
      // Why Chromium did not keep the page, in its own words only: the entries also carry the page's URL, which is its token.
      const reasons = await page.evaluate(() => {
        const out: string[] = [];
        const walk = (node: unknown) => {
          const n = node as { reasons?: { reason?: unknown }[] | null; children?: unknown[] | null } | null;
          for (const r of n?.reasons ?? []) if (typeof r?.reason === "string") out.push(r.reason);
          for (const c of n?.children ?? []) walk(c);
        };
        const nav = performance.getEntriesByType("navigation")[0] as (PerformanceEntry & { notRestoredReasons?: unknown }) | undefined;
        walk(nav?.notRestoredReasons ?? null);
        return out;
      });
      test.skip(true, `Chromium did not restore the home from its back-forward cache: ${reasons.join(", ") || "no reason given"}`);
    }
    // Restored: then the island's reload, whose own pageshow is a plain load (and no loop after it).
    await expect.poll(readShows, { timeout: NAV_MS, message: "restored, then the island's reload: one plain load" }).toEqual([true, false]);
    info.annotations.push({
      type: "bfcache",
      description: "restored from the back-forward cache (pageshow.persisted); the island reloaded it and the hero read the rally",
    });
    await ctx.close();
  } finally {
    await browser.close();
  }
});

test("the URL forms (Task 10, Review Focus 3): the home opens from its link with a trailing slash and with a ?utm suffix", async ({ guest: page }) => {
  const name = `e2e url forms ${TAG}`;
  const home = await createFromSetup(page, name, ["Ravi & Sam", "Priya & Tom"]);
  // The positive pair first: the bare link reads the home.
  await expect(page.getByTestId("qm-name")).toHaveText(name);
  // `skipTrailingSlashRedirect` (next.config.js) serves both forms as written, so each must read the token from the path alone.
  // Each form is named in a message by its label, never by its URL: the URL is the home's token (O3).
  const forms: [string, string][] = [
    ["trailing slash", `${home}/`],
    ["utm", `${home}?utm_source=whatsapp`],
    ["both", `${home}/?utm_source=whatsapp&utm_medium=social`],
  ];
  for (const [label, url] of forms) {
    await page.goto(url);
    await expect(page.getByTestId("qm-dead-link"), `${label}: not the dead screen`).toHaveCount(0);
    await expect(page.getByTestId("qm-name"), `${label}: the same home`).toHaveText(name);
    await expect(page.getByTestId("qm-hero").getByTestId("qm-hero-kicker"), label).toHaveText(ui("quickMatch.home.upNext", { n: 1, total: 1 }));
  }
});
