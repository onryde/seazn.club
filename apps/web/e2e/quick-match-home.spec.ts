import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { expectNoHorizontalScroll, TAG } from "./helpers";
import { expectQrDecodesAsPainted, expectQrEnlarges, expectWholeModuleScale } from "./helpers/qr-enlarge";
import { consentedAnonymousState } from "./scorepad-a11y-kit";

// Quick match plan 2 Task 5 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3, §8): the guest's home
// at `/q/<token>` in a real browser, at the three widths the task is verified at (320, 768, 1280), for a league, a knockout
// and the dead link. Task 10 owns the flow (`quick-match.spec.ts`: setup → home → Score → back) and the seven-width case
// (`mobile.spec.ts`); this file is the home's own width check, which no unit test can see: the page's real width with a
// 43-character side name, the hero, the table and the draw laid out by the browser.
//
// Every quick match here is made the way a guest makes one: the setup page's form, posted by its Start button, followed to
// the home (the real producer, never a seed). Measured with `expectNoHorizontalScroll` (helpers.ts), which lifts the
// `overflow-x: clip` backstop before it reads.
//
// Sport: badminton, clicked explicitly (A11), as quick-match.spec.ts does; the home has no sport-specific layout beyond its
// score line, which the page test (app/q/[token]/__tests__/page.test.tsx) covers for badminton and football.

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

const WIDTHS = [320, 768, 1280] as const;
/** A realistic long entrant name (AGENTS.md: the defect a short name hides), 43 characters. */
const LONG = "The Extraordinarily Long-Named Doubles Pair";

const form = (page: Page) => page.getByTestId("qm-setup-form");
const side = (page: Page, n: number) => form(page).getByLabel(`Side ${n}`, { exact: true });

/** Make a quick match through the setup page and land on its home. */
async function createThroughSetup(page: Page, sides: string[], format: "League" | "Knockout") {
  await page.goto("/en/play");
  await expect(form(page)).toBeVisible();
  await form(page).getByText("Badminton", { exact: true }).click();
  await form(page).getByLabel("Name", { exact: true }).fill(`e2e home ${TAG}`);
  for (let n = 3; n <= sides.length; n++) await page.getByRole("button", { name: "+ Add a side" }).click();
  for (const [k, name] of sides.entries()) await side(page, k + 1).fill(name);
  if (sides.length > 2) await form(page).getByText(format, { exact: true }).click();
  await page.getByTestId("qm-start").click();
  await expect(page).toHaveURL(/\/q\/[^/?#]+$/);
}

/** Each width in turn: reloaded by default (the page as it first paints there); `{ reload: false }` keeps the page on
 *  screen as it is and only resizes it, for a state a reload would not bring back (a flash whose `?e=` is spent). */
async function atEachWidth(page: Page, check: (width: number) => Promise<void>, { reload = true } = {}) {
  let checked = 0;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    if (reload) await page.reload();
    await check(width);
    await expectNoHorizontalScroll(page);
    checked++;
  }
  expect(checked).toBe(WIDTHS.length);
}

test("home (Task 5): a league of 4 with a 43-character side, at 320, 768 and 1280: hero, table and list, no sideways scroll", async ({ guest: page }) => {
  await createThroughSetup(page, [LONG, "Priya & Tom", "Lee & Ana", "Jo & Max"], "League");
  await atEachWidth(page, async (width) => {
    await expect(page.getByTestId("qm-played"), `${width}`).toHaveText("0 of 6 matches played · kept 7 days after the last score");
    await expect(page.getByTestId("qm-hero"), `${width}`).toContainText("Up next · match 1 of 6");
    await expect(page.getByTestId("qm-standings-row"), `${width}`).toHaveCount(4);
    await expect(page.getByTestId("qm-standings").getByText(LONG), `${width}`).toBeVisible();
    await expect(page.getByTestId("qm-match"), `${width}`).toHaveCount(6);
    await expect(page.getByTestId("qm-anyone"), `${width}`).toBeVisible();
    await expect(page.getByText("Save this match"), `${width}: no Save in plan 2 (D13)`).toHaveCount(0);
  });
});

test("home (Task 5): a knockout of 3 at 320, 768 and 1280: the draw with a lone 'Semi-final', the bye, the waiting final", async ({ guest: page }) => {
  await createThroughSetup(page, [LONG, "Priya & Tom", "Lee & Ana"], "Knockout");
  await atEachWidth(page, async (width) => {
    const draw = page.getByTestId("qm-draw");
    await expect(draw, `${width}`).toBeVisible();
    await expect(page.getByTestId("qm-standings"), `${width}`).toHaveCount(0);
    await expect(draw.getByTestId("qm-draw-card"), `${width}`).toHaveCount(3);
    await expect(draw.getByTestId("qm-draw-round"), `${width}`).toHaveText(["Semi-final", "Final"]);
    await expect(draw.locator('[data-bye="true"]'), `${width}`).toContainText("Bye");
    await expect(page.locator('[data-testid="qm-match"][data-state="waiting"]'), `${width}`).toContainText("Winner of the semi-final");
    await expect(page.getByTestId("qm-hero"), `${width}`).toContainText("Up next · Semi-final");
  });
});

// ── Task 6: Score ───────────────────────────────────────────────────────────────────────────────────────────────────
//
// The Score control is a plain form post (`POST /q/<token>/score/<fixture>`) answered with a 303 into the pad, or back to the
// home with a flash (app/q/[token]/score/[fixtureId]/route.ts). Its unit and DB tests prove the route and the island; this is
// what only a browser shows: the post followed to the pad, the Back button and a second tap that reopens the same link, a
// real refused post landing on the flash, and the buttons as real 44px targets at the three widths.

/** A real tap target: at least 44px tall, and the element a tap at its centre actually hits (`boundingBox()` measures paint,
 *  not hit area). Scrolled into view first: `elementFromPoint` is viewport-relative and reads null below the fold. */
async function expectTappable(locator: Locator, what: string) {
  await locator.scrollIntoViewIfNeeded();
  const seen = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { height: r.height, hit: top !== null && (top === el || el.contains(top)) };
  });
  expect(seen.height, `${what}: 44px or more`).toBeGreaterThanOrEqual(44);
  expect(seen.hit, `${what}: the tap lands on it`).toBe(true);
}

test("Score (Task 6): a league of 4 at 320, 768 and 1280: Score on the hero and on each of the 6 matches, real 44px targets", async ({ guest: page }) => {
  await createThroughSetup(page, [LONG, "Priya & Tom", "Lee & Ana", "Jo & Max"], "League");
  await atEachWidth(page, async (width) => {
    const hero = page.getByTestId("qm-hero").getByTestId("qm-score");
    await expect(hero, `${width}`).toHaveText("Score this match");
    const rows = page.getByTestId("qm-match").getByTestId("qm-score");
    await expect(rows, `${width}`).toHaveCount(6);
    await expectTappable(hero, `${width}: the hero's Score`);
    await expectTappable(rows.first(), `${width}: a row's Score`);
    await expectTappable(rows.last(), `${width}: the last row's Score`);
  });
});

test("Score (Task 6): the hero's Score lands in the pad on its match; Back, then Score again, reopens the same link", async ({ guest: page }) => {
  await createThroughSetup(page, ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max"], "League");
  const home = new URL(page.url()).pathname;
  await page.getByTestId("qm-hero").getByTestId("qm-score").click();
  // The secret alone in the path (O3): no query, no fragment.
  await expect(page).toHaveURL(/\/score\/dl_[A-Za-z0-9_-]{43}$/);
  const pad = new URL(page.url()).pathname;
  await expect(page.getByTestId("quick-match-back-link")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${home}$`));
  // The home is no-store (force-dynamic), so Back RELOADS it rather than restoring it from the back-forward cache: this proves
  // the second post and the reopened link, not the island's bfcache unlock. That unlock is proven by its unit test
  // (components/quick-match/__tests__/score-form.test.tsx, "back from the pad (bfcache)").
  await page.getByTestId("qm-hero").getByTestId("qm-score").click();
  await expect(page).toHaveURL(/\/score\/dl_/);
  expect(new URL(page.url()).pathname, "the same link, reopened (not a second one)").toBe(pad);
});

test("Score (Task 6): a post for the waiting final lands back on the home with the 'not yet' flash, at 320, 768 and 1280", async ({ guest: page }) => {
  await createThroughSetup(page, ["Ravi & Sam", "Priya & Tom", "Lee & Ana"], "Knockout");
  const home = new URL(page.url()).pathname;
  const waiting = page.locator('[data-testid="qm-match"][data-state="waiting"]');
  await expect(waiting).toHaveCount(1);
  await expect(waiting.getByTestId("qm-score"), "the home offers no Score on a waiting match (C18)").toHaveCount(0);
  const finalId = await waiting.getAttribute("data-fixture-id");
  expect(finalId).toMatch(/^[0-9a-f-]{36}$/);
  // A stale page or a crafted post: the same form the home draws, submitted for the final. Its 303 is caught as the
  // redirected GET: the URL holds `?e=` only until the home's ClearFlashParam takes the spent parameter out (T6 m2).
  const refusal = `${home}?e=QUICK_MATCH_SIDES_UNKNOWN`;
  const landed = page.waitForRequest((r) => r.method() === "GET" && r.url().endsWith(refusal));
  await page.evaluate((action) => {
    const form = document.createElement("form");
    form.method = "post";
    form.action = action;
    document.body.append(form);
    form.submit();
  }, `${home}/score/${finalId}`);
  expect((await landed).redirectedFrom()?.method(), "the post's 303 landed on the refusal").toBe("POST");
  // The spent ?e= leaves the URL, and the flash stays on screen: a plain replaceState, which Next's router mirrors from
  // its own history state without asking the server again. So the widths are checked by resizing, never by a reload.
  await expect(page).toHaveURL(new RegExp(`${home}$`));
  await atEachWidth(
    page,
    async (width) => {
      const flash = page.getByTestId("qm-flash");
      await expect(flash, `${width}`).toHaveText("That match can't be scored yet: it waits for earlier results.");
      await expect(flash, `${width}`).toHaveAttribute("role", "alert");
      await expect(flash, `${width}: in view at the top`).toBeInViewport();
      await expect(page.getByTestId("qm-hero"), `${width}`).toContainText("Up next · Semi-final");
      await expect(page, `${width}: the URL stays clean`).toHaveURL(new RegExp(`${home}$`));
    },
    { reload: false },
  );
  // What m2 is for: a reload of the page (or a shared or bookmarked copy of its URL) prints no stale refusal.
  await page.reload();
  await expect(page.getByTestId("qm-hero"), "the home itself is there").toContainText("Up next · Semi-final");
  await expect(page.getByTestId("qm-flash")).toHaveCount(0);
});

// ── Task 7: Share ───────────────────────────────────────────────────────────────────────────────────────────────────
//
// The island's unit test (components/quick-match/__tests__/share.test.tsx) proves its wiring with doubles; this is what only
// a browser shows: the link built on the page's real origin, the real clipboard, the Seazn QR as painted (it must decode to
// exactly the home link, logo and all), the row's width with a 43-character side on the page, and the share sheet handed
// the home link. The link, Copy and the share sheet are on first paint (one tap to WhatsApp); only the QR is behind "Show
// QR" (controller ruling 2026-11-08). Desktop Chrome on Linux has no `navigator.share`, so each case sets it explicitly:
// removed for the first, a recording stand-in for the second (the real sheet is the operating system's).

test("Share (Task 7): the link and Copy on first paint, the QR closed; Copy fills the clipboard, Show QR draws exactly the link, at 320, 768 and 1280", async ({ guest: page }) => {
  await page.addInitScript(() => {
    delete (Navigator.prototype as { share?: unknown }).share;
  });
  await createThroughSetup(page, [LONG, "Priya & Tom", "Lee & Ana", "Jo & Max"], "League");
  // The home link a guest shares is the page's own address: `/q/<token>` on this origin, never the pad's device link.
  const homeUrl = page.url();
  expect(new URL(homeUrl).pathname).toMatch(/^\/q\/qm_[A-Za-z0-9_-]+$/);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(homeUrl).origin });
  await atEachWidth(page, async (width) => {
    // First paint, no tap: the link and Copy are there; the QR is not.
    const field = page.getByTestId("qm-share-url");
    await expect(field, `${width}: the home link on this origin`).toHaveValue(homeUrl);
    await expect(field, `${width}`).toBeVisible();
    await expect(field, `${width}`).toHaveClass(/\bph-no-capture\b/);
    const copy = page.getByTestId("qm-share-copy");
    await expect(copy, `${width}`).toBeVisible();
    await expect(copy, `${width}`).toHaveText("Copy link");
    const toggle = page.getByTestId("qm-share-toggle");
    await expect(toggle, `${width}`).toHaveText("Show QR");
    await expect(toggle, `${width}: the QR is closed on first paint`).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("qm-share-qr"), `${width}: no QR before the tap`).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Share on WhatsApp" }), `${width}: no share sheet on this browser`).toHaveCount(0);
    await expectTappable(copy, `${width}: Copy link`);
    await expectTappable(toggle, `${width}: Show QR`);

    // One tap copies, without opening anything.
    await copy.click();
    await expect(copy, `${width}`).toHaveText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText()), `${width}: the clipboard holds the home link`).toBe(homeUrl);
    await expect(toggle, `${width}: Copy never opens the QR`).toHaveAttribute("aria-expanded", "false");

    // Show QR: the Seazn QR, drawn on the tap, painted sensitive, whole device px per module, decoding to exactly the link.
    await toggle.click();
    await expect(toggle, `${width}`).toHaveAttribute("aria-expanded", "true");
    const qr = page.getByTestId("qm-share-qr");
    await expect(qr, `${width}`).toBeVisible();
    await expect(qr, `${width}`).toHaveClass(/\bph-no-capture\b/);
    await expectWholeModuleScale(page, qr, { minPerModule: 3, what: `${width}: the share QR` });
    await expectQrDecodesAsPainted(qr, homeUrl, `${width}: the share QR`);
  });
  // One tap enlarges it (D10), and the enlarged QR is blocked from replay too.
  await expectQrEnlarges(page, "qm-share-qr", { sensitive: true });
});

test("Share (Task 7): where the phone has a share sheet, 'Share on WhatsApp' is on first paint and ONE tap hands it the home link, the name and the message", async ({ guest: page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "share", {
      configurable: true,
      value: async function share(data: ShareData) {
        const w = window as unknown as { __qmShared?: ShareData[] };
        (w.__qmShared ??= []).push(data);
      },
    });
  });
  await createThroughSetup(page, ["Ravi & Sam", "Priya & Tom"], "League");
  const homeUrl = page.url();
  const name = `e2e home ${TAG}`;
  await atEachWidth(page, async (width) => {
    const native = page.getByRole("button", { name: "Share on WhatsApp" });
    await expect(native, `${width}: on first paint, no toggle`).toBeVisible();
    await expect(page.getByTestId("qm-share-copy"), `${width}`).toBeVisible();
    await expect(page.getByTestId("qm-share-qr"), `${width}: the QR stays closed`).toHaveCount(0);
    await expectTappable(native, `${width}: Share on WhatsApp`);
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("button", { name: "Share on WhatsApp" }).click();
  // `ShareButton` hands the sheet `{ title, text, url }` (share-button.tsx); the text is quickMatch.home.shareNative (en).
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __qmShared?: ShareData[] }).__qmShared ?? []))
    .toEqual([{ title: name, text: `${name}: our quick match on Seazn. Open the link to score or follow the results.`, url: homeUrl }]);
});

test("home (Task 5): an unknown link is the dead screen at 320, 768 and 1280, and it offers a new quick match", async ({ guest: page }) => {
  await page.goto(`/q/qm_${TAG}NotAHomeTokenAtAll0000000000`);
  await atEachWidth(page, async (width) => {
    await expect(page.getByTestId("qm-dead-title"), `${width}`).toHaveText("This link has ended or doesn't exist");
    await expect(page.getByTestId("qm-dead-start"), `${width}`).toHaveAttribute("href", "/en/play");
    await expect(page.getByTestId("qm-home"), `${width}`).toHaveCount(0);
  });
});
