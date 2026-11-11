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

  // Nothing clipped at 1280: every tab's right edge sits inside the strip's own box (the fade's 24px is padded clear).
  const clipped = await strip.locator("nav").evaluate((nav) => {
    const box = nav.getBoundingClientRect();
    const links = [...nav.querySelectorAll("a")];
    return { checked: links.length, over: links.filter((a) => a.getBoundingClientRect().right > box.right - 0.5).length, scrolls: nav.scrollWidth > nav.clientWidth, left: box.left };
  });
  expect(clipped.checked, "anti-vacuity: links were checked").toBeGreaterThan(0);
  expect(clipped.over, "no tab clipped at 1280").toBe(0);
  expect(clipped.scrolls, "the strip does not even need to scroll at 1280").toBe(false);
  expect(Math.abs(clipped.left - cardBox.x), "the band aligns with the cards, no overhang").toBeLessThanOrEqual(1);

  await strip.getByRole("link", { name: "Preferences", exact: true }).click();
  await page.waitForURL(/tab=preferences/);
  await expect(page.locator('[data-nav-shape="rail"]'), "Preferences keeps the rail").toBeVisible();
  await expect(page.locator('[data-nav-shape="strip"]')).toHaveCount(0);
});

test("organisation tab at 768: the strip either fits or is a reachable scrolling rail (focusable, named)", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  const org = await activeOrg(page);
  await page.goto(routes.orgSettings(org.slug));
  const strip = page.locator('[data-nav-shape="strip"] nav');
  await expect(strip).toBeVisible();
  const r = await strip.evaluate((nav) => {
    const box = nav.getBoundingClientRect();
    const links = [...nav.querySelectorAll("a")];
    return {
      checked: links.length,
      over: links.filter((a) => a.getBoundingClientRect().right > box.right + 0.5).length,
      overflowX: getComputedStyle(nav).overflowX,
      tabindex: nav.getAttribute("tabindex"),
      label: nav.getAttribute("aria-label"),
    };
  });
  expect(r.checked, "anti-vacuity: links were checked").toBeGreaterThan(0);
  // Either everything fits, or the overflow is the REACHABLE kind (rule 23): auto, focusable, named.
  expect(r.over === 0 || r.overflowX === "auto", `over=${r.over} overflow-x=${r.overflowX}`).toBe(true);
  expect(r.overflowX).toBe("auto");
  expect(r.tabindex).toBe("0");
  expect((r.label ?? "").length).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal page scroll").toBe(true);
});
