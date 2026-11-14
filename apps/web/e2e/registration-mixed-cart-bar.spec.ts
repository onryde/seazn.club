// Walk-fix F6: a cart that mixes a card division with a pay-the-organiser one is refused on the ENTRIES step. The refusal used to sit
// under the cart: on a phone it was below the fold and, after Continue, still half under the sticky action bar, while Continue looked
// enabled and did nothing. It now sits IN the bar, directly above Continue; Continue is aria-disabled and described by it; tapping
// Continue reveals and focuses it and stays on the step. Removing the conflict lifts all of it and Continue advances.
//
// Driven in a browser against a prod build: what a phone SEES (the notice inside the viewport, not covered - an elementFromPoint
// hit-test at its centre and at Continue's) is not provable in node. Widths 320 and 390 (the walkthrough's), plus 1280 (one DOM: the
// desktop row carries the same notice). Seeded the way an organiser sets it up: a Pro org with card payments on, one card division and
// one pay-the-organiser division, both written through the real settings API.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apiJson, TAG } from "./helpers";
import { noHorizontalScroll, putSettings, seedRig } from "./pay-page-kit";

const enUi = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
] as const;

/** What sits at the centre of `testId`'s box: the element itself (or inside it), or what covers it. */
async function hitAtCentre(page: Page, testId: string): Promise<{ hit: boolean; inViewport: boolean; covering: string }> {
  return page.getByTestId(testId).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const at = document.elementFromPoint(x, y);
    return {
      hit: at !== null && (at === el || el.contains(at)),
      inViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
      covering: at ? `${at.tagName.toLowerCase()}[data-testid=${at.getAttribute("data-testid")}]` : "nothing",
    };
  });
}

test.describe("a mixed-method cart is refused in the action bar, above Continue (walk-fix F6)", () => {
  test("phone and desktop: the notice is on screen above Continue, Continue says it is unavailable and reveals it; removing an entry lifts it", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const rig = await seedRig(browser);
    const offlineName = `Social ${TAG.slice(-4)}`;
    const off = await apiJson<{ id: string }>(rig.owner.request, `/api/v1/competitions/${rig.competitionId}/divisions`, "POST", {
      name: offlineName,
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    expect(off.status, JSON.stringify(off.error)).toBeLessThan(300);
    await putSettings(rig.owner, off.data!.id, "offline");
    const sentence = enUi["register.entries.cart.mixedPayment"]!
      .replace("{cardDivision}", rig.divName)
      .replace("{offlineDivision}", offlineName);
    const shots = process.env.WALKFIX_SHOTS;

    let checked = 0;
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: vp });
      const page = await ctx.newPage();
      await page.goto(`/live/${rig.orgSlug}/${rig.compSlug}/register`, { waitUntil: "load" });
      await page.getByRole("button", { name: /^accept$/i }).click({ timeout: 3000 }).catch(() => {});
      await page.locator("#reg-who-name").fill(`Mixed Cart ${TAG}`);
      await page.locator("#reg-who-email").fill(`delivered+mixed-cart-${TAG}@resend.dev`);
      const add = page.getByRole("button", { name: enUi["register.entries.add.individual"]! });
      // A click before hydration is a no-script no-op: retry until the step really moved.
      await expect(async () => {
        await page.getByTestId("reg-next").click();
        await expect(add.first()).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 30_000 });

      // The empty case first: one division, nothing blocks.
      await add.nth(0).click();
      await expect(page.getByTestId("reg-bar-blocked")).toHaveCount(0);
      await expect(page.getByTestId("reg-next")).not.toHaveAttribute("aria-disabled", "true");

      // The second division (divisions list by name: the card one first, then the pay-the-organiser one) makes the cart mixed.
      await add.nth(1).click();
      const notice = page.getByTestId("reg-bar-blocked");
      const next = page.getByTestId("reg-next");
      await expect(notice).toHaveText(sentence);
      await expect(notice).toHaveAttribute("role", "alert");
      await expect(page.getByTestId("reg-cart-mixed-payment"), "the cart's old copy is gone").toHaveCount(0);
      await expect(next).toHaveAttribute("aria-disabled", "true");
      await expect(next).toHaveAttribute("aria-describedby", (await notice.getAttribute("id"))!);
      expect(Number(await next.evaluate((el) => getComputedStyle(el).opacity)), `${vp.width}: Continue looks unavailable`).toBeLessThan(1);

      if (vp.width < 768) {
        // On a phone, with no scrolling: the notice is in the pinned bar, inside the viewport, and nothing covers it or Continue.
        const n = await hitAtCentre(page, "reg-bar-blocked");
        expect(n.inViewport, `${vp.width}: the notice is on screen`).toBe(true);
        expect(n.hit, `${vp.width}: the notice is covered by ${n.covering}`).toBe(true);
      } else {
        await notice.scrollIntoViewIfNeeded();
      }
      const c = await hitAtCentre(page, "reg-next");
      expect(c.hit, `${vp.width}: Continue is covered by ${c.covering}`).toBe(true);
      const nBox = (await notice.boundingBox())!;
      const cBox = (await next.boundingBox())!;
      expect(nBox.y + nBox.height, `${vp.width}: the notice is above Continue`).toBeLessThanOrEqual(cBox.y + 1);
      await noHorizontalScroll(page, `mixed cart @${vp.width}`);
      if (shots) await page.screenshot({ path: `${shots}/B-F6-mixed-cart-bar-${vp.width}.png` });

      // A real tap at Continue's centre (Playwright's click refuses an aria-disabled button, as a screen reader would announce it):
      // the notice gets focus, and the step does not move.
      await page.mouse.click(cBox.x + cBox.width / 2, cBox.y + cBox.height / 2);
      await expect(notice).toBeFocused();
      await expect(add.first(), `${vp.width}: still on ENTRIES`).toBeVisible();
      const after = await hitAtCentre(page, "reg-bar-blocked");
      expect(after.inViewport && after.hit, `${vp.width}: the revealed notice is on screen and uncovered (${after.covering})`).toBe(true);

      // Remove the second entry: the refusal lifts, and Continue advances to DETAILS.
      await page.getByRole("button", { name: enUi["register.entries.cart.remove"]! }).last().click();
      await expect(notice).toHaveCount(0);
      await expect(next).not.toHaveAttribute("aria-disabled", "true");
      await next.click();
      await expect(page.getByLabel(/Player 1 — Full name/).first(), `${vp.width}: on DETAILS`).toBeVisible();
      await ctx.close();
      checked++;
    }
    expect(checked).toBe(VIEWPORTS.length);
    await rig.owner.context().close();
  });
});
