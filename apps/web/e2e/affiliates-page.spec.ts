import { test, expect, type Browser } from "@playwright/test";
import { expectNoHorizontalScroll } from "./helpers";
import { AFFILIATE_PORTAL_URL, AFFILIATE_TERMS } from "../src/lib/affiliate-terms";

// The public /affiliates page and its footer link (Revshare program). Like
// revshare-attribution.spec.ts it needs a server BUILT with
// NEXT_PUBLIC_REVSHARE_ENABLED=1 (baked at build time; e2e.yml leaves it off).
// A visitor is genuinely anonymous — the project storageState is the Pro owner.
const anon = (b: Browser) => b.newContext({ storageState: { cookies: [], origins: [] } });

// Phone floor, tablet, desktop: the three widths the UI rule names.
const WIDTHS = [320, 768, 1280] as const;

test.describe("affiliates page", () => {
  test.skip(
    process.env.NEXT_PUBLIC_REVSHARE_ENABLED !== "1",
    "needs a server built with NEXT_PUBLIC_REVSHARE_ENABLED=1 (and the same value in this process)",
  );

  for (const width of WIDTHS) {
    test(`renders the terms and the portal CTA at ${width}px with no horizontal scroll`, async ({ browser }, testInfo) => {
      const ctx = await anon(browser);
      const page = await ctx.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/en/affiliates");

      const h1 = page.getByRole("heading", { level: 1 });
      await expect(h1).toContainText(`${AFFILIATE_TERMS.percent}%`);
      await expect(h1).toContainText(`${AFFILIATE_TERMS.years} years`);

      const payout = page.getByTestId("affiliates-payout");
      await expect(payout).toContainText(`${AFFILIATE_TERMS.payoutDelayDays} days`);
      await expect(payout).toContainText(AFFILIATE_TERMS.payoutMinimum);
      await expect(payout).toContainText(AFFILIATE_TERMS.payoutMethod);

      const cta = page.getByTestId("affiliates-join");
      await expect(cta).toBeVisible();
      await expect(cta).toHaveAttribute("href", AFFILIATE_PORTAL_URL);
      await expect(cta).toHaveAttribute("target", "_blank");
      await expect(cta).toHaveAttribute("rel", "noopener noreferrer");
      // A phone tap needs a real target, not just a visible one.
      const box = await cta.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);

      await expectNoHorizontalScroll(page);
      await page.screenshot({ path: testInfo.outputPath(`affiliates-${width}.png`), fullPage: true });
      await ctx.close();
    });
  }

  test("the footer links to the page, and the link works", async ({ browser }) => {
    const ctx = await anon(browser);
    const page = await ctx.newPage();
    await page.goto("/en/pricing");
    const link = page.locator('footer a[href="/affiliates"]');
    await expect(link).toHaveCount(1);
    await link.click();
    await expect(page).toHaveURL(/\/affiliates$/);
    await expect(page.getByTestId("affiliates-join")).toBeVisible();
    await ctx.close();
  });

  test("the page is wired in other locales too (no raw keys leak)", async ({ browser }) => {
    const ctx = await anon(browser);
    const page = await ctx.newPage();
    for (const lang of ["fr", "es", "nl"]) {
      await page.goto(`/${lang}/affiliates`);
      const body = await page.locator("main").innerText();
      expect(body, lang).not.toMatch(/affiliates\.[a-z]/);
      expect(body, lang).toContain(String(AFFILIATE_TERMS.percent));
    }
    await ctx.close();
  });
});
