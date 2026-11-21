// The /blog sport-chip rail at every width project (Blog P2 Task 4 fix round 1, review item I2). The rail scrolls sideways
// below md, so it owes a tab stop, a role and a name (AGENTS.md class 23), and every chip is a touch target of 44px.
//
// It needs a blog with at least one post that NAMES a sport; the only committed post is written for every sport, so on a
// stock build there are no chips and this file has nothing to look at. It therefore runs only when the server under test was
// built with such posts (E2E_BLOG_CHIPS=1: copies of the pilot with `sports:` set, placed in content/blog for the build and
// never committed), and says so when it does not. The markup rules are pinned in the unit suite either way.
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectNoHorizontalScroll, overflowingIn } from "../helpers";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { projectViewport } from "./_shared";

test.skip(!process.env.E2E_BLOG_CHIPS, "needs a build whose posts name sports (E2E_BLOG_CHIPS=1); the stock blog has no chips");
test.use({ storageState: { cookies: [], origins: [] } });

test("the sport chips: a focusable named rail, 44px targets, and a chip narrows the list", async ({ page }) => {
  const vp = projectViewport();
  expect(vp, "this project declares a viewport").not.toBeNull();
  await page.goto("/blog");
  await dismissCookieBanner(page);

  const rail = page.getByRole("group", { name: "Show posts for" });
  await expect(rail).toBeVisible();
  await expect(rail).toHaveAttribute("tabindex", "0");
  const chips = rail.getByRole("button");
  const n = await chips.count();
  expect(n, "anti-vacuity: chips on the page (All sports plus at least one sport)").toBeGreaterThan(1);

  await expectNoHorizontalScroll(page);
  const { clipped, scrollable } = await overflowingIn(page, "main", "div,section,table,figure,nav,ul,a,time", "main was not in the DOM");
  expect(clipped).toEqual([]);
  for (const box of scrollable) expect(box).toMatch(/tabindex=0$/);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);

  // Every chip is at least 44px tall, and a tap at its centre lands on it (the rail scrolls: bring each into view first).
  for (let i = 0; i < n; i++) {
    const chip = chips.nth(i);
    await chip.scrollIntoViewIfNeeded();
    const box = (await chip.boundingBox())!;
    expect(box.height, `chip ${i} height`).toBeGreaterThanOrEqual(44);
    const hit = await chip.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return top === el || el.contains(top);
    });
    expect(hit, `a tap at chip ${i}'s centre lands on it`).toBe(true);
  }

  // A chip narrows the list: fewer posts than "All sports", and the chip reads as pressed.
  const posts = page.locator('[data-testid="blog-index"] a[href^="/blog/"]');
  const all = await posts.count();
  expect(all, "anti-vacuity: posts listed").toBeGreaterThan(1);
  const sportChip = chips.nth(1);
  await sportChip.scrollIntoViewIfNeeded();
  await sportChip.click();
  await expect(sportChip).toHaveAttribute("aria-pressed", "true");
  await expect(chips.nth(0)).toHaveAttribute("aria-pressed", "false");
  expect(await posts.count()).toBeLessThan(all);
  await expectNoHorizontalScroll(page);
});
