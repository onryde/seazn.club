import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectNoHorizontalScroll } from "./helpers";
// Prices from the seed, never a literal — see price-kit.ts's own header for
// why a VALUE import of src/lib/currency here would collect ZERO TESTS
// (Node's ESM loader refuses currency.ts's bare `stripe-plans.json` import).
import { HIDDEN_PASS_RUNGS, SELLABLE_PASS_RUNGS, passLabel } from "./price-kit";
// Pure — zero runtime imports of its own (both of its own imports are
// `import type`), so this is safe to pull into the Playwright runtime
// directly, unlike currency.ts/pricing-matrix.ts.
import { PRICING_RAIL_SPORTS } from "../src/lib/pricing-rail";

// R14 (entitlements v18 W3): the /pricing redesign — a sport rail, an Event
// Pass TICKET (a two-slot stub: the price card + the pass/Pro crossover,
// replacing the retired M/L ladder), and a 320 per-plan ACCORDION beside the
// unchanged ≥768 comparison table. This spec REPLACES the deleted
// e2e/pricing-pro-plus.spec.ts — it is owed by this wave.
//
// W3 fix round 2: the rail is NINE sports now (carrom folded into "Board
// games", 3x3 at every width below 1280); the stub's two slots stack as
// full-width row cards, never a 2-up phone comparison; and "Size M" /
// "Event Pass M" are gone — both surfaces read "Event Pass" plainly, since
// one sellable rung leaves no L to contrast against.
//
// Anonymous throughout: /pricing is a marketing page, and every assertion
// here is about what an anonymous visitor sees with no interaction.
test.use({ storageState: { cookies: [], origins: [] } });

// Derived from the same authority pricing-v3.spec.ts already restates here
// for the same ESM reason — never re-typed as an independent literal.
const PRICING_PLAN_KEYS = ["community", ...SELLABLE_PASS_RUNGS, "pro"];

test.describe("pricing v18 — the box office redesign (R14)", () => {
  test("a card per purchasable plan, with its price and a matching comparison column — no click needed", async ({
    page,
  }) => {
    await page.goto("/pricing");

    // The three offers, visible with no interaction: the ticket (Event Pass),
    // Community and Pro.
    await expect(page.locator("[data-pass-stub]")).toBeVisible();
    await expect(page.getByText(passLabel("event_pass"))).toBeVisible();
    await expect(page.getByText("Community", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Pro", { exact: true }).first()).toBeVisible();

    // The comparison table, unchanged markup — `data-pricing-matrix`, and
    // `data-pricing-column` per PRICING_PLAN_KEYS.
    const matrix = page.locator("[data-pricing-matrix]");
    await expect(matrix).toBeVisible();
    const columns = await matrix
      .locator("thead th[data-pricing-column]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-pricing-column")!));
    expect(columns).toEqual(PRICING_PLAN_KEYS);
  });

  test("the sport rail renders exactly the nine-sport board, plus its foot line — no click needed", async ({
    page,
  }) => {
    await page.goto("/pricing");
    const rail = page.locator("[data-pricing-rail]");
    await expect(rail).toBeVisible();
    const sports = await rail
      .locator("[data-rail-sport]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-rail-sport")!));
    expect(sports).toEqual([...PRICING_RAIL_SPORTS]);
    expect(sports.length).toBe(9);
    // `generic` is the board's foot line, never an eleventh rail slot;
    // `carrom` no longer has its own slot at all (W3 fix round 2 — folded
    // into "Board games").
    expect(sports).not.toContain("generic");
    expect(sports).not.toContain("carrom");
    await expect(rail.locator("[data-rail-footer]")).toBeVisible();
  });

  // W3 fix round 2, item 5: below 1280 the rail is an EVEN 3x3 grid, not the
  // old ragged wrap — asserted on layout, which only a browser can see.
  test("the sport rail lays out as an even 3x3 grid below 1280, nine across from 1280", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto("/pricing");
    const rail = page.locator("[data-pricing-rail]");
    const columns375 = await rail.evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
    );
    expect(columns375).toBe(3);
    await expectNoHorizontalScroll(page);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    const columns1280 = await rail.evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
    );
    expect(columns1280).toBe(9);
  });

  test("no 'Pro Plus' and no 'Event Pass L' text anywhere on the route", async ({ page }) => {
    await page.goto("/pricing");
    const body = page.locator("body");
    // Positive pair first: the page really rendered, so the negative checks
    // below cannot be satisfied by a blank page.
    await expect(body).toContainText(passLabel("event_pass"));
    await expect(body).not.toContainText("Pro Plus");
    for (const hidden of HIDDEN_PASS_RUNGS) {
      await expect(body).not.toContainText(passLabel(hidden));
    }
    const matrixColumns = await page
      .locator("[data-pricing-matrix] thead th[data-pricing-column]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-pricing-column")!));
    for (const hidden of HIDDEN_PASS_RUNGS) expect(matrixColumns).not.toContain(hidden);
    expect(HIDDEN_PASS_RUNGS.length).toBeGreaterThan(0);
  });

  test("/pricing reads the [lang] PATH, not the cookie — a non-en locale renders non-English copy", async ({
    page,
  }) => {
    await page.goto("/es/pricing");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    // The positive: real Spanish copy the English page never carries.
    await expect(page.getByText("Gratis", { exact: true }).first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Community plan is free forever");
    // The rail's own Spanish names — proves the NEW R14 copy is translated,
    // not just the pre-existing chrome around it.
    await expect(page.locator('[data-rail-sport="football"]')).toHaveText("Fútbol");
    await expect(page.locator('[data-rail-sport="tabletennis"]')).toHaveText("Tenis de mesa");
  });

  test("at 320 the comparison is a per-plan accordion, never a horizontally-scrolling desktop table", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto("/pricing");

    // The accordion is really there, attached AND visible — this is the
    // regression: a class present is not a class in effect.
    const accordion = page.locator("[data-pricing-accordion]");
    await expect(accordion).toBeVisible();
    const plans = await accordion
      .locator("[data-pricing-accordion-plan]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-pricing-accordion-plan")!));
    expect(plans).toEqual(PRICING_PLAN_KEYS);

    // The desktop table is not merely scrolled off-screen — it is `display:
    // none` at this width (`hidden md:block`), so it can contribute no
    // horizontal overflow at all. Asserted on the COMPUTED style, never the
    // class name.
    const tableDisplay = await page
      .locator("[data-pricing-matrix]")
      .evaluate((el) => getComputedStyle(el.closest(".scroll-x")!).display);
    expect(tableDisplay).toBe("none");

    // …and the page itself never scrolls sideways — the property a hidden
    // table and a native <details> accordion should jointly guarantee.
    await expectNoHorizontalScroll(page);

    // Opening one plan's accordion reveals its own values — proving the
    // disclosure is functional, not just present.
    const first = accordion.locator("[data-pricing-accordion-plan]").first();
    await first.locator("summary").click();
    await expect(first.locator("[data-pricing-accordion-row]").first()).toBeVisible();
  });

  test("axe: no serious/critical violations at desktop or 320 (the new scroll region carries tabindex + role + name)", async ({
    page,
  }) => {
    await page.goto("/pricing");
    const desktop = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const desktopBlocking = desktop.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(desktopBlocking.map((v) => `${v.id} — ${v.nodes[0]?.html}`)).toEqual([]);

    await page.setViewportSize({ width: 320, height: 900 });
    await page.reload();
    const mobile = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const mobileBlocking = mobile.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(mobileBlocking.map((v) => `${v.id} — ${v.nodes[0]?.html}`)).toEqual([]);
  });

  // W3 fix round 2, item 1: the crossover paragraph was unreadable in an
  // 84px phone column (a 2-up stub grid). The fix stacks both slots as
  // full-width row cards at every width — proven here on the actual box
  // height at 320, which only a browser can measure.
  test("at 320 the ticket's stub slots stack as full-width row cards, never 2-up", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto("/pricing");
    const priceSlot = page.locator('[data-pass-stub-slot="m"]');
    const crossoverBox = page.locator("[data-pass-crossover]");
    await expect(priceSlot).toBeVisible();

    const priceBox = await priceSlot.boundingBox();
    expect(priceBox, "the price slot's box").not.toBeNull();
    // A row card spans (nearly) the full 320-wide viewport, minus the page's
    // own horizontal padding — a 2-up column would be roughly half this.
    expect(priceBox!.width).toBeGreaterThan(260);

    // The crossover card sits BELOW the price card (stacked), not beside it.
    if (await crossoverBox.count()) {
      const cBox = await crossoverBox.boundingBox();
      expect(cBox, "the crossover box").not.toBeNull();
      expect(cBox!.y).toBeGreaterThan(priceBox!.y + priceBox!.height - 5);
    }
    await expectNoHorizontalScroll(page);

    // The price and its "/ event" suffix hold on one line — no orphaned
    // suffix two lines below the number.
    const priceLine = page.locator("[data-pass-price]");
    const priceLineBox = await priceLine.boundingBox();
    expect(priceLineBox, "the price line's box").not.toBeNull();
    // A single text line at this font size is well under 40px tall; an
    // orphaned wrap would roughly double it.
    expect(priceLineBox!.height).toBeLessThan(45);
  });

  // W3 fix round 2, item 2: "Size M" and "Event Pass M" named a distinction
  // no customer can act on with one sellable rung. Both surfaces now read
  // "Event Pass" plainly.
  test("names the pass plainly — no 'Size M' or 'Event Pass M' anywhere on the page", async ({
    page,
  }) => {
    await page.goto("/pricing");
    const body = page.locator("body");
    // Positive pair: the page really rendered the ticket.
    await expect(body).toContainText(passLabel("event_pass"));
    await expect(body).not.toContainText("Size M");
    await expect(body).not.toContainText("Event Pass M");
    await expect(
      page.locator('[data-pass-stub-slot="m"]').getByText("Event Pass", { exact: true }),
    ).toBeVisible();
  });

  // W3 fix round 2, item 3: "Write API access" is the one row where every
  // purchasable-plan cell is dashed — it now routes to the Enterprise
  // conversation instead of reading as a flat "no".
  test("the enterprise-only 'Write API access' row carries a routing note, at desktop and 320", async ({
    page,
  }) => {
    await page.goto("/pricing");
    const desktopRow = page
      .locator("[data-pricing-matrix] tbody tr")
      .filter({ hasText: "Write API access" });
    await expect(desktopRow).toContainText("Enterprise only");

    await page.setViewportSize({ width: 320, height: 900 });
    await page.reload();
    const accordionRow = page.locator(
      '[data-pricing-accordion-row="pricing.matrix.api.write"]',
    );
    const firstDetails = page.locator("[data-pricing-accordion-plan]").first();
    await firstDetails.locator("summary").click();
    await expect(accordionRow.first()).toContainText("Enterprise only");
  });

  // W3 fix round 2, item 6: a dedicated Platform fee FAQ entry, naming live
  // rates and stating the fee is additive to Stripe's own processing.
  test("the FAQ has a dedicated Platform fee entry naming the live rates", async ({ page }) => {
    await page.goto("/pricing");
    await page.getByRole("heading", { name: "Frequently asked questions" }).scrollIntoViewIfNeeded();
    const faq = page.locator("text=What's the platform fee");
    await expect(faq).toBeVisible();
    const answerCard = faq.locator("xpath=ancestor::div[contains(@class,'card')][1]");
    await expect(answerCard).toContainText("on top of");
  });
});
