import { test as base, expect, type Page } from "@playwright/test";
import { expectNoHorizontalScroll, TAG } from "./helpers";
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

async function atEachWidth(page: Page, check: (width: number) => Promise<void>) {
  let checked = 0;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
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

test("home (Task 5): an unknown link is the dead screen at 320, 768 and 1280, and it offers a new quick match", async ({ guest: page }) => {
  await page.goto(`/q/qm_${TAG}NotAHomeTokenAtAll0000000000`);
  await atEachWidth(page, async (width) => {
    await expect(page.getByTestId("qm-dead-title"), `${width}`).toHaveText("This link has ended or doesn't exist");
    await expect(page.getByTestId("qm-dead-start"), `${width}`).toHaveAttribute("href", "/en/play");
    await expect(page.getByTestId("qm-home"), `${width}`).toHaveCount(0);
  });
});
