// The redesigned help template (Help audit Task 6, layout A) at every width project here (320/360/375/390/430
// phones, 768/834 tablets). Runs ONLY in the seven width projects (MOBILE_SPECS in playwright.config.ts); 1280 is
// e2e/help.spec.ts.
//
// What it pins, none of which the unit suite (no DOM) can see (AGENTS.md classes 2, 22, 23):
//  - below 768: search first, then ONE fold holding the section list, then the article; the fold opens;
//  - from 768: the section list is a column beside the article, no fold;
//  - below 1100 (every project here): "On this page" is folded under the lede; it opens, and an entry lands its
//    heading in view;
//  - no horizontal page scroll, nothing clipped, and every box that scrolls sideways is one the reader can scroll
//    (a prose table or code block), on the help home, a long article and the format pages;
//  - axe finds nothing serious.
// The folds are OPENED to check what is in them (class 22): waits are on `toBeAttached`, and each open is gated on
// its toggle being visible, never on a width literal.
//
// Not serial: no test reads state another writes (AGENTS.md class 21).
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectNoHorizontalScroll, overflowingIn } from "../helpers";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { projectViewport } from "./_shared";

test.use({ storageState: { cookies: [], origins: [] } });

/** A long article with six level-2 headings and a table (content/help/registration/card-payments.md). */
const LONG = "/help/registration/card-payments";
const PAGES = ["/help", LONG, "/help/scoring/basics", "/help/formats", "/help/formats/knockout"] as const;

/**
 * axe's serious and critical findings, less ONE known gap: a wide prose table scrolls sideways but has no tab
 * stop (`scrollable-region-focusable`), because the help renderer's sanitiser drops `tabindex` — recorded in
 * help-copy-truth.test.ts's KNOWN_GAPS (#303), not this template's to fix. Only a finding whose every node is a
 * prose table is dropped; the same rule on any other box still fails.
 */
function seriousAxe(violations: { id: string; impact?: string | null; nodes: { html: string; target: unknown[] }[] }[]): string[] {
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .filter((v) => !(v.id === "scrollable-region-focusable" && v.nodes.every((n) => n.html.startsWith("<table"))))
    .map((v) => `${v.id} - ${v.nodes[0]?.html}`);
}

async function visit(page: Page, path: string) {
  const res = await page.goto(path);
  expect(res?.status(), path).toBeLessThan(400);
  // The house helper: answers the prompt in storage first (the banner mounts after hydration, and only
  // once per context), so the second page in the same context is not left waiting for a banner.
  await dismissCookieBanner(page);
}

const width = () => {
  const vp = projectViewport();
  expect(vp, "this project declares a viewport").not.toBeNull();
  return vp!.width;
};

test("help article: search, then the section list (folded below 768), then the article; the fold opens on the current page", async ({ page }) => {
  const phone = width() < 768;
  await visit(page, LONG);
  const box = page.getByRole("searchbox", { name: "Search help" });
  const toggle = page.getByTestId("help-sections").getByRole("button");
  const sections = page.getByRole("navigation", { name: "Help sections" });
  const h1 = page.getByRole("heading", { level: 1 });
  await expect(box).toBeVisible();
  await expect(h1).toBeVisible();
  await expect(sections).toBeAttached();

  if (phone) {
    await expect(toggle, "below 768 the section list is behind one toggle").toBeVisible();
    await expect(sections).toBeHidden();
    // Order down the page: search, the fold, the article.
    const yBox = (await box.boundingBox())!.y;
    const yToggle = (await toggle.boundingBox())!.y;
    const yH1 = (await h1.boundingBox())!.y;
    expect(yBox).toBeLessThan(yToggle);
    expect(yToggle).toBeLessThan(yH1);
    await expect(toggle).toContainText("Registration");
  } else {
    await expect(toggle, "the toggle is in the page (positive pair)").toBeAttached();
    await expect(toggle, "from 768 there is no fold").toBeHidden();
    await expect(sections).toBeVisible();
    const s = (await sections.boundingBox())!;
    expect(s.x + s.width, "a column beside the article").toBeLessThanOrEqual((await h1.boundingBox())!.x);
  }

  if (await toggle.isVisible()) {
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
  await expect(sections).toBeVisible();
  const current = sections.locator('a[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute("href", LONG);
  await expect(current).toBeAttached();
  await expect(sections.getByRole("link", { name: "Format gallery" })).toBeAttached();
});

test("On this page is folded under the lede below 1100; it opens, and an entry lands its heading in view", async ({ page }) => {
  await visit(page, LONG);
  const toggle = page.getByTestId("help-toc").getByRole("button");
  const toc = page.getByRole("navigation", { name: "On this page" });
  await expect(toc).toBeAttached();
  await expect(toggle, "every width here is below 1100").toBeVisible();
  await expect(toc).toBeHidden();
  // Under the lede, above the body.
  const lede = page.locator("main header p").last();
  expect((await toggle.boundingBox())!.y).toBeGreaterThan((await lede.boundingBox())!.y);
  expect((await toggle.boundingBox())!.y).toBeLessThan((await page.locator(".help-prose h2").first().boundingBox())!.y);

  if (await toggle.isVisible()) await toggle.click();
  await expect(toc).toBeVisible();
  const links = toc.getByRole("link");
  expect(await links.count()).toBeGreaterThanOrEqual(5);
  const entry = links.nth(3);
  const href = (await entry.getAttribute("href"))!;
  await entry.click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(page.locator(`[id="${href.slice(1)}"]`)).toBeInViewport();
  // Choosing an entry folds the list again, so the reader is left on the section.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("search works at this width: results as you type, with the section shown, and one opens", async ({ page }) => {
  await visit(page, "/help");
  const box = page.getByRole("searchbox", { name: "Search help" });
  await box.fill("waitlist");
  const results = page.getByRole("list", { name: "Search results" });
  // By href, not by name: a link's name is its title AND its description, which another page's could share.
  const hit = results.locator('a[href="/help/registration/waitlist"]');
  await expect(hit).toBeVisible();
  await expect(hit).toContainText("Registration");
  await hit.click();
  await expect(page).toHaveURL(/\/help\/registration\/waitlist$/);
});

test("no horizontal scroll, nothing clipped, every sideways scroller reachable, and no serious axe finding", async ({ page }) => {
  let checked = 0;
  for (const path of PAGES) {
    await visit(page, path);
    // Open every fold this width has, so what is inside is measured too.
    for (const id of ["help-sections", "help-toc"]) {
      const t = page.getByTestId(id).getByRole("button");
      if ((await t.count()) > 0 && (await t.isVisible())) await t.click();
    }
    await expectNoHorizontalScroll(page);
    const over = await overflowingIn(page, "main", "*", `${path}: no <main>`);
    expect(over.clipped, `${path}: clipped boxes`).toEqual([]);
    // The only boxes allowed to scroll sideways are the prose's own scroll boxes (a wide table, a code block).
    for (const s of over.scrollable) expect(s, `${path}: an excused scroller is a prose table or code block`).toMatch(/^(table|pre) /);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(
      seriousAxe(axe.violations),
      `axe serious/critical on ${path}`,
    ).toEqual([]);
    checked += 1;
  }
  expect(checked, "anti-vacuity").toBe(PAGES.length);
});
