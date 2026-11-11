import { test, expect } from "@playwright/test";
import { activeOrg } from "./helpers";
import { routes } from "../src/lib/routes";

// Settings -> Organisation (owner 2026-11-11, option 1): the left rail is gone on THIS tab only, so the Organisation card
// and the Organisation defaults card use the full content width; the compact nav (the phone strip, one tree) sits above
// them and keeps every other tab one tap away. Every other tab keeps the rail. Desktop only: the phone strip is the
// unchanged <768 layout and `mobile.spec.ts` walks it.
test.use({ viewport: { width: 1280, height: 900 } });

test("organisation tab: no rail, the card runs to the content's left edge, Preferences is one click away and keeps the rail", async ({ page }) => {
  const org = await activeOrg(page);
  await page.goto(routes.orgSettings(org.slug));

  const card = page.getByTestId("org-profile-card");
  await expect(card).toBeVisible();
  const strip = page.locator('[data-nav-shape="strip"]');
  await expect(strip, "the compact nav is drawn").toHaveCount(1);
  await expect(page.locator('[data-nav-shape="rail"]'), "no rail on this tab").toHaveCount(0);

  const cardBox = (await card.boundingBox())!;
  const firstLink = (await strip.getByRole("link").first().boundingBox())!;
  expect(Math.abs(cardBox.x - firstLink.x), "card's left edge vs the nav's inner left edge").toBeLessThanOrEqual(8);
  // A rail would leave ~912px; the full content width at 1280 is ~1120px.
  expect(cardBox.width, "the card uses the full content width").toBeGreaterThan(1050);
  const defaultsBox = (await page.getByTestId("org-defaults").boundingBox())!;
  expect(Math.abs(defaultsBox.x - cardBox.x), "the defaults card shares the card's left edge").toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal page scroll").toBe(true);

  await strip.getByRole("link", { name: "Preferences", exact: true }).click();
  await page.waitForURL(/tab=preferences/);
  await expect(page.locator('[data-nav-shape="rail"]'), "Preferences keeps the rail").toBeVisible();
  await expect(page.locator('[data-nav-shape="strip"]')).toHaveCount(0);
});
