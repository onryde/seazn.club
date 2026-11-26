// The help template at every width project here (320/360/375/390/430 phones, 768/834 tablets). Runs ONLY in the seven
// width projects (MOBILE_SPECS in playwright.config.ts); 1280 is e2e/help.spec.ts.
//
// What it pins, none of which the unit suite (no DOM) can see (AGENTS.md classes 2, 22, 23):
//  - one column, the blog post's: search, then the article (680px centred, or the page less its 16px gutters), with no
//    section list and no "On this page" in any form, folds included;
//  - the ways on from an article: previous, next, the breadcrumb;
//  - a link to another article's heading lands the heading in view below the sticky site nav;
//  - no horizontal page scroll, nothing clipped, and every box that scrolls sideways is one the reader can scroll
//    (a prose table or code block), on the help home, a long article and the format pages;
//  - axe finds nothing serious.
// Not serial: no test reads state another writes (AGENTS.md class 21).
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectNoHorizontalScroll, overflowingIn } from "../helpers";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { helpPageWithPosts } from "../blog-help-pages";
import { SERIF, style } from "../reading-font";
import { ARTICLE_PARTS, QUOTE_AND_CALLOUT, SANS, expectBodyType, expectNoSideMenus, expectOneColumn, followAnchorLinks, helpAnchorLinks, readingOverflow } from "../help-reading";
import { projectViewport } from "./_shared";

test.use({ storageState: { cookies: [], origins: [] } });

/** A long article with a table (content/help/registration/card-payments.md). */
const LONG = "/help/registration/card-payments";
/** A page a blog post names in its `help:` key, so it carries the "Read how it works" list (blog P2 Task 6); read from the posts. */
const WITH_POSTS = helpPageWithPosts();
/** The two Online Chess credits pages (content/help/sports/chess.md: a table of sizes and prices, wide pictures; content/help/billing/match-credits.md). */
const ONLINE_CHESS = ["/help/sports/chess", "/help/billing/match-credits"] as const;
const PAGES = ["/help", LONG, "/help/scoring/basics", "/help/formats", "/help/formats/knockout", WITH_POSTS, ...ONLINE_CHESS] as const;

/**
 * axe's serious and critical findings, none excused. A prose code block and a prose table both scroll sideways, and
 * the renderer gives each a tab stop, a role and a name (server/help-scroll-boxes.ts), so
 * `scrollable-region-focusable` is a real finding on any box (AGENTS.md class 23).
 */
function seriousAxe(violations: { id: string; impact?: string | null; nodes: { html: string; target: unknown[] }[] }[]): string[] {
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} - ${v.nodes[0]?.html}`);
}

/**
 * Every label of every drawing on the page, and those standing outside their drawing. SVG text has no CSS box: Chrome
 * reports `scrollWidth > clientWidth` for it as soon as the drawing is scaled past its viewBox (the knockout bracket in the
 * 680px column: "305px content in 291px", the label well inside the drawing), and says nothing about a label that really
 * does run out of one. So the box scan leaves SVG internals out, and this measures where each label is.
 */
async function drawingLabels(page: Page): Promise<{ checked: number; outside: string[] }> {
  return page.evaluate(() => {
    let checked = 0;
    const outside: string[] = [];
    for (const label of document.querySelectorAll<SVGTextElement>("main svg text")) {
      const r = label.getBoundingClientRect();
      const d = label.ownerSVGElement!.getBoundingClientRect();
      if (r.width === 0 || d.width === 0) continue;
      checked++;
      if (r.left < d.left - 1 || r.right > d.right + 1) outside.push(`${label.textContent?.trim().slice(0, 40)}: ${Math.round(r.left)}-${Math.round(r.right)} in ${Math.round(d.left)}-${Math.round(d.right)}`);
    }
    return { checked, outside };
  });
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

test("help article: search, then the article, in one column with no side menu; the breadcrumb and pager are there", async ({ page }) => {
  await visit(page, LONG);
  expect(await expectOneColumn(page, ARTICLE_PARTS)).toBe(4);
  await expectNoSideMenus(page);
  const box = page.getByRole("searchbox", { name: "Search help" });
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  const h1 = page.getByRole("heading", { level: 1 });
  await expect(box).toBeVisible();
  await expect(crumbs).toBeVisible();
  // Order down the page: search, the breadcrumb, the title.
  expect((await box.boundingBox())!.y).toBeLessThan((await crumbs.boundingBox())!.y);
  expect((await crumbs.boundingBox())!.y).toBeLessThan((await h1.boundingBox())!.y);
  await expect(crumbs.getByRole("link", { name: "Help", exact: true })).toHaveAttribute("href", "/help");
  await expect(crumbs.getByRole("link", { name: "Registration" })).toHaveAttribute("href", "/help#registration");
  const pager = page.getByRole("navigation", { name: "Previous and next" });
  await expect(pager.getByRole("link", { name: /Previous/ })).toBeVisible();
  const next = pager.getByRole("link", { name: /Next/ });
  const href = (await next.getAttribute("href"))!;
  await next.click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
});

test("a link to another article's heading opens it with the heading in view below the site nav", async ({ page }) => {
  // One link per distinct heading: the 1280 spec follows every link from every article.
  const links = [...new Map(helpAnchorLinks().map((l) => [l.to, l])).values()];
  expect(links.length, "anti-vacuity: headings linked to").toBeGreaterThan(5);
  test.setTimeout(Math.max(90_000, links.length * 8_000));
  expect(await followAnchorLinks(page, links, (path) => visit(page, path))).toBe(links.length);
});

// The reading style (owner pick "H1", 2026-11-26) at this width; 1280 and the every-article sweep are e2e/help.spec.ts.
test("the article's type at this width: the serif body, the large title, sans everywhere else, nothing past the column", async ({ page }) => {
  const phone = width() < 600;
  await visit(page, QUOTE_AND_CALLOUT);
  expect(await expectBodyType(page, width(), ["paragraph", "item", "quote"])).toBe(3);
  expect((await style(page, "main article h1")).size).toBe(phone ? "31px" : "42px");
  expect((await style(page, ".reading-prose h2")).size).toBe(phone ? "21px" : "24px");
  expect((await style(page, ".reading-prose .help-callout p")).size).toBe("15px");
  let checked = 0;
  for (const { path, selectors } of SANS) {
    await visit(page, path);
    for (const selector of selectors) {
      await expect(page.locator(selector).first(), `anti-vacuity: ${selector}`).toBeAttached();
      expect((await style(page, selector)).family, selector).not.toMatch(SERIF);
      checked++;
    }
    const o = await readingOverflow(page);
    expect(o.checked, `${path}: anti-vacuity`).toBeGreaterThan(10);
    expect(o.over, path).toEqual([]);
    await expectNoHorizontalScroll(page);
  }
  expect(checked, "anti-vacuity: parts read").toBe(SANS.flatMap((s) => s.selectors).length);
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
  let labels = 0;
  for (const path of PAGES) {
    await visit(page, path);
    await expectNoHorizontalScroll(page);
    const over = await overflowingIn(page, "main", "*:not(svg *)", `${path}: no <main>`);
    expect(over.clipped, `${path}: clipped boxes`).toEqual([]);
    const drawn = await drawingLabels(page);
    expect(drawn.outside, `${path}: a label outside its drawing`).toEqual([]);
    labels += drawn.checked;
    // The only boxes allowed to scroll sideways are the prose's own scroll boxes (a code block, or the wrapper round a
    // wide table), and every one of them is a tab stop: the renderer writes the tabindex, so a bare scroller is a defect.
    for (const s of over.scrollable) expect(s, `${path}: an excused scroller is a prose code block or table wrapper, with a tab stop`).toMatch(/^(div|pre) \d+px content in \d+px tabindex=0$/);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(
      seriousAxe(axe.violations),
      `axe serious/critical on ${path}`,
    ).toEqual([]);
    checked += 1;
  }
  expect(checked, "anti-vacuity").toBe(PAGES.length);
  expect(labels, "anti-vacuity: drawing labels measured").toBeGreaterThan(0);
  console.log(`[help ${page.viewportSize()!.width}] pages ${checked}, drawing labels ${labels}`);
});
