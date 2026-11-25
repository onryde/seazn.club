// The blog and the marketing bar at every width project here (320/360/375/390/430 phones, 768/834 tablets), Blog P2 Task 4.
// Runs ONLY in the seven width projects (MOBILE_SPECS in playwright.config.ts); 1280 is e2e/blog.spec.ts.
//
// What it pins, none of which the unit suite (no DOM) can see (AGENTS.md classes 2, 22, 23):
//  - the bar's fifth item (Blog between Sports and Pricing) and the Help icon do not wrap or overflow it at 768 and 834;
//    below 768 the same two are rows of the phone panel (class 22: the panel is OPENED, gated on the toggle being visible);
//  - the Help icon's tap area is at least 44px and is what a tap at its centre HITS (elementFromPoint, not paint);
//  - /blog and a post: no sideways page scroll, nothing clipped, axe finds nothing serious;
//  - the example table scrolls inside a focusable, named region that fits the page column;
//  - "On this page" is folded under the lede below 1100 and opens;
//  - a signed-in visitor sees Dashboard in the bar (tablets) or the panel (phones), and a signed-out one does not.
// Not serial: no test reads state another writes (AGENTS.md class 21).
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectNoHorizontalScroll, overflowingIn } from "../helpers";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { CHECKLIST_POST, expectChecklist } from "../blog-checklist";
import { projectViewport } from "./_shared";

const POST = "/blog/how-standings-points-work";
const signedOut = { storageState: { cookies: [], origins: [] } };

const width = () => {
  const vp = projectViewport();
  expect(vp, "this project declares a viewport").not.toBeNull();
  return vp!.width;
};

async function visit(page: Page, path: string) {
  const res = await page.goto(path);
  expect(res?.status(), path).toBeLessThan(400);
  await dismissCookieBanner(page);
}

/** Open the phone panel when its toggle is shown (below md); true when it was opened. Gated on the toggle, never a width literal. */
async function openPanel(page: Page): Promise<boolean> {
  const toggle = page.getByRole("button", { name: "Open menu" });
  if (!(await toggle.isVisible())) return false;
  await toggle.click();
  await expect(page.getByRole("menu")).toBeVisible();
  return true;
}

async function seriousAxe(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} - ${v.nodes[0]?.html}`);
}

test.describe("signed out", () => {
  test.use(signedOut);

  // The streaming guide is the post with art (a tall phone drawing) and a Markdown checklist rather than an example table.
  for (const path of ["/blog", POST, CHECKLIST_POST]) {
    test(`${path}: no horizontal scroll, nothing clipped, a tab stop on every scrolling box, axe clean`, async ({ page }) => {
      await visit(page, path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoHorizontalScroll(page);
      const { clipped, scrollable } = await overflowingIn(page, "main", "div,section,table,figure,nav,ul,a,time", "main was not in the DOM");
      expect(clipped).toEqual([]);
      for (const box of scrollable) expect(box).toMatch(/tabindex=0$/);
      expect(await seriousAxe(page)).toEqual([]);
    });
  }

  test("the streaming guide's checklist: a card per row on a phone, an ordinary table on a tablet", async ({ page }) => {
    await visit(page, CHECKLIST_POST);
    await expectChecklist(page, width());
    await expectNoHorizontalScroll(page);
  });

  test("the example table is a focusable, named region that fits the page column, scrolling inside itself", async ({ page }) => {
    await visit(page, POST);
    const region = page.getByRole("region", { name: /What one finished match is worth/ });
    await expect(region).toBeVisible();
    await expect(region).toHaveAttribute("tabindex", "0");
    const vw = width();
    const box = (await region.boundingBox())!;
    const m = await region.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    // The table is 40rem (640px) wide at least. A phone column is narrower, so the box scrolls; from 768 the column is 44rem
    // minus the gutters (702px), the table fits, and the box has nothing to scroll.
    if (vw < 768) {
      expect(m.scroll).toBeGreaterThan(m.client);
      // Inside the page gutters (16px a side), never wider than the screen: the box scrolls, the page does not.
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vw);
      await expect(page.getByText("Swipe sideways to see the whole table")).toBeVisible();
    } else {
      await expect(page.getByText("Swipe sideways to see the whole table")).toBeHidden();
    }
    if (vw < 768) {
      await region.focus();
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    } else {
      expect(m.scroll, "nothing hidden: the table fits its box").toBeLessThanOrEqual(m.client + 1);
    }
    await expectNoHorizontalScroll(page);
  });

  test("'On this page' is folded under the lede at this width; it opens and an entry lands its heading in view", async ({ page }) => {
    await visit(page, POST);
    const toc = page.getByTestId("help-toc");
    const toggle = toc.locator("button");
    const nav = toc.locator("nav");
    await expect(toggle).toBeVisible();
    await expect(nav).toBeAttached();
    await expect(nav).toBeHidden();
    await toggle.click();
    await expect(nav).toBeVisible();
    const first = nav.locator("a").first();
    const id = (await first.getAttribute("href"))!.slice(1);
    await first.click();
    await expect(page.locator(`#${id}`)).toBeInViewport();
  });

  test("the bar: Blog and Help are reachable at this width and the bar stays one row", async ({ page }) => {
    await visit(page, "/blog");
    const bar = page.locator("[data-mk-nav]");
    const vw = width();
    if (vw < 768) {
      // Phones: the bar is the wordmark and the toggle; Blog and Help are rows of the panel.
      await expect(bar.getByRole("link", { name: "Help", exact: true })).toBeHidden();
      expect(await openPanel(page)).toBe(true);
      const panel = page.getByRole("menu");
      await expect(panel.getByRole("menuitem", { name: "Blog", exact: true })).toBeVisible();
      const help = panel.getByRole("menuitem", { name: "Help", exact: true });
      await expect(help).toBeVisible();
      await expect(help).toHaveAttribute("href", "/help");
      // Panel order: the groups, then Blog, Pricing, Live, Help.
      const rows = await panel.getByRole("menuitem").evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
      const tail = rows.slice(rows.indexOf("Blog"));
      expect(tail.slice(0, 4)).toEqual(["Blog", "Pricing", "Live", "Help"]);
    } else {
      // Tablets: Product, Sports, Blog, Pricing, Live, the Help icon, then the sign-in actions, all on ONE row and inside the bar.
      const items = bar.locator("nav > *:visible");
      const rects = await items.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { y: r.y + r.height / 2, right: r.right, left: r.left, h: r.height, t: (e.textContent ?? "").trim() || e.getAttribute("aria-label") }; }));
      // Product, Sports, Blog, Pricing, Live, Help, and the sign-in slot (Log in + Start free, one box that also holds "Dashboard").
      expect(rects.length, "six bar items and the sign-in slot").toBe(7);
      const rowY = rects[0]!.y;
      for (const r of rects) expect(Math.abs(r.y - rowY), `${r.t} sits on the bar's one row`).toBeLessThanOrEqual(2);
      for (const r of rects) {
        expect(r.right, `${r.t} stays inside the viewport`).toBeLessThanOrEqual(vw);
        expect(r.left).toBeGreaterThanOrEqual(0);
      }
      // No two controls overlap.
      for (let i = 1; i < rects.length; i++) expect(rects[i]!.left, `${rects[i]!.t} clear of ${rects[i - 1]!.t}`).toBeGreaterThanOrEqual(rects[i - 1]!.right - 1);
      const barBox = (await bar.boundingBox())!;
      expect(barBox.height, "the bar did not wrap onto a second row").toBeLessThan(90);
      const overflow = await bar.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      // Help: an icon link, 44px, and what a tap at its centre hits.
      const help = bar.getByRole("link", { name: "Help", exact: true });
      const hb = (await help.boundingBox())!;
      expect(hb.width).toBeGreaterThanOrEqual(44);
      expect(hb.height).toBeGreaterThanOrEqual(44);
      const hit = await help.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return top === el || el.contains(top);
      });
      expect(hit, "a tap at the icon's centre lands on the Help link").toBe(true);
    }
    await expectNoHorizontalScroll(page);
  });

  test("a signed-out visitor sees the sign-in actions, never Dashboard", async ({ page }) => {
    await visit(page, "/blog");
    const bar = page.locator("[data-mk-nav]");
    if (await openPanel(page)) {
      await expect(page.getByRole("menu").getByRole("menuitem", { name: "Log in" })).toBeVisible();
      await expect(page.getByRole("menu").getByRole("menuitem", { name: /Dashboard/ })).toHaveCount(0);
    } else {
      await expect(bar.getByRole("link", { name: "Log in" })).toBeVisible();
    }
    await expect(bar.getByRole("link", { name: /Dashboard/ })).toHaveCount(0);
  });
});

// The project's default state is a real signed-in session (both cookies set by the magic-link login).
test("a signed-in visitor sees Dashboard in the phone panel, or in the bar from sm, and no sign-in actions", async ({ page }) => {
  await visit(page, "/blog");
  const bar = page.locator("[data-mk-nav]");
  if (await openPanel(page)) {
    const panel = page.getByRole("menu");
    await expect(panel.getByRole("menuitem", { name: /Dashboard/ })).toBeVisible();
    await expect(panel.getByRole("menuitem", { name: "Log in" })).toHaveCount(0);
    await expect(panel.getByRole("menuitem", { name: "Start free" })).toHaveCount(0);
  } else {
    await expect(bar.getByRole("link", { name: /Dashboard/ })).toBeVisible();
    await expect(bar.getByRole("link", { name: "Log in" })).toHaveCount(0);
  }
});
