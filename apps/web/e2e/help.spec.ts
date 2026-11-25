// The redesigned help template (Help audit Task 6, layout A) at 1280, in a browser: what the unit suite
// (src/app/help/__tests__/help-template.test.tsx, no DOM) cannot see — the three columns, the "On this page"
// rail that stays in view and marks the section being read, a click landing its heading in view below the
// sticky site nav, search loading its index only when asked and working from the keyboard, no sideways
// scroll, and axe. The seven narrower widths are e2e/mobile/help.spec.ts.
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectNoHorizontalScroll } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { helpPageWithPosts, helpPageWithoutPosts } from "./blog-help-pages";

test.use({ storageState: { cookies: [], origins: [] } });

/** A long article with six level-2 headings (content/help/registration/card-payments.md). */
const LONG = "/help/registration/card-payments";
/** A heading of content/help/billing/hand-over-a-bill.md: in the search index, never on the help home's own page. */
const INDEX_ONLY = "What happens to your invoices when the bill changes hands";
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

/** Open as a first-time visitor and answer the cookie banner (it sits over the page's lower left). */
async function visit(page: Page, path: string) {
  await page.setViewportSize({ width: 1280, height: 900 });
  const res = await page.goto(path);
  expect(res?.status(), path).toBeLessThan(400);
  // The house helper: answers the prompt in storage first (the banner mounts after hydration, and only
  // once per context), so the second page in the same context is not left waiting for a banner.
  await dismissCookieBanner(page);
}

const toc = (page: Page) => page.getByRole("navigation", { name: "On this page" });

test("1280: three columns — section list, reading column, On this page rail — with the current page marked", async ({ page }) => {
  await visit(page, LONG);
  const sections = page.getByRole("navigation", { name: "Help sections" });
  await expect(sections).toBeVisible();
  await expect(sections.locator('a[aria-current="page"]')).toHaveCount(1);
  await expect(sections.locator('a[aria-current="page"]')).toHaveAttribute("href", LONG);
  await expect(toc(page)).toBeVisible();
  // Both folds' toggles are for narrower widths only: in the page (the positive pair), but not shown. Located by
  // CSS, not role: a hidden element is not in the accessibility tree, so a role locator never finds it. Their
  // accessible names are proven where they show (e2e/mobile/help.spec.ts).
  for (const id of ["help-toc", "help-sections"]) {
    const toggle = page.getByTestId(id).locator("button");
    await expect(toggle, `${id} toggle exists`).toBeAttached();
    await expect(toggle, `${id} toggle hidden at 1280`).toBeHidden();
  }

  const left = (await sections.boundingBox())!;
  const h1 = (await page.getByRole("heading", { level: 1 }).boundingBox())!;
  const rail = (await toc(page).boundingBox())!;
  expect(left.x + left.width, "section list left of the article").toBeLessThanOrEqual(h1.x);
  expect(h1.x + h1.width, "article left of the rail").toBeLessThanOrEqual(rail.x);
});

// The reading column (34rem, app/help/[...slug]/page.tsx) holds about 70 characters a line. Measured in the page:
// the characters on each rendered line of the article's longest paragraph, from the text's own glyph boxes.
async function longestLine(page: Page): Promise<{ lines: number; maxChars: number }> {
  return page.evaluate(() => {
    const paras = [...document.querySelectorAll(".help-prose > p")];
    const para = paras.sort((a, b) => (b.textContent ?? "").length - (a.textContent ?? "").length)[0]!;
    const perLine = new Map<number, number>();
    const range = document.createRange();
    const walk = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode() as Text | null; t; t = walk.nextNode() as Text | null) {
      for (let i = 0; i < t.length; i += 1) {
        range.setStart(t, i);
        range.setEnd(t, i + 1);
        const r = range.getClientRects()[0];
        if (r) perLine.set(Math.round(r.top), (perLine.get(Math.round(r.top)) ?? 0) + 1);
      }
    }
    return { lines: perLine.size, maxChars: Math.max(...perLine.values()) };
  });
}

test("the reading column holds about 70 characters a line, never more than 80, at 1024 and 1280", async ({ page }) => {
  await visit(page, LONG);
  let checked = 0;
  for (const width of [1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    const m = await longestLine(page);
    expect(m.lines, `${width}: premise, a paragraph of several lines`).toBeGreaterThan(3);
    expect(m.maxChars, `${width}: characters on the longest line`).toBeLessThanOrEqual(80);
    expect(m.maxChars, `${width}: still a reading line, not a squeezed one`).toBeGreaterThanOrEqual(55);
    checked += 1;
  }
  expect(checked, "anti-vacuity").toBe(2);
});

test("1280: clicking an On this page entry lands its heading in view below the nav, marks it, and the rail stays in view", async ({ page }) => {
  await visit(page, LONG);
  const links = toc(page).getByRole("link");
  expect(await links.count(), "the long page lists its sections").toBeGreaterThanOrEqual(5);
  const third = links.nth(2);
  const href = (await third.getAttribute("href"))!;
  expect(href).toMatch(/^#/);
  await third.click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  const heading = page.locator(`[id="${href.slice(1)}"]`);
  await expect(heading).toBeInViewport();
  const navBottom = await page.locator("[data-mk-nav]").evaluate((n) => n.getBoundingClientRect().bottom);
  const top = await heading.evaluate((h) => h.getBoundingClientRect().top);
  expect(top, "the heading is not hidden under the sticky site nav").toBeGreaterThanOrEqual(navBottom);
  await expect(third).toHaveAttribute("aria-current", "location");
  await expect(toc(page).locator('[aria-current="location"]')).toHaveCount(1);

  // Down at the foot of the page the rail is still on screen, and the marking has moved on.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(toc(page)).toBeInViewport();
  await expect(links.last()).toHaveAttribute("aria-current", "location");
});

test("search loads its index only when asked, offers the matching page with the word marked, and opens it", async ({ page }) => {
  const indexRequests: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/help-index") indexRequests.push(r.url());
  });
  await visit(page, "/help");
  // The index is not in the page: no request yet, and the HTML does not carry a string only an index row has (a
  // heading of the hand-over-a-bill page, which /help never shows). The positive pair is below: the index response carries it.
  expect(indexRequests, "no index request before the box is used").toEqual([]);
  expect(await page.content()).not.toContain(INDEX_ONLY);

  const box = page.getByRole("searchbox", { name: "Search help" });
  await expect(box).toHaveCount(1);
  const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/help-index");
  await box.fill("waitlist");
  const indexResponse = await loaded;
  expect(indexResponse.ok()).toBe(true);
  expect(await indexResponse.text(), "premise: the probe string is an index row's").toContain(INDEX_ONLY);
  const results = page.getByRole("list", { name: "Search results" });
  // By href, not by name: a link's name is its title AND its description, which another page's could share.
  const hit = results.locator('a[href="/help/registration/waitlist"]');
  await expect(hit).toBeVisible();
  await expect(hit.locator("mark").first()).toHaveText(/waitlist/i);
  await expect(results.getByRole("link").first()).toHaveAttribute("href", "/help/registration/waitlist");
  expect(indexRequests, "loaded once").toHaveLength(1);

  // Escape clears the box and the results.
  await box.press("Escape");
  await expect(box).toHaveValue("");
  await expect(results).toHaveCount(0);
  await expect(box).toBeFocused();

  // Keyboard all the way: type, Down to the first result, Enter opens it.
  await box.pressSequentially("waitlist");
  await expect(hit).toBeVisible();
  await box.press("ArrowDown");
  await expect(results.getByRole("link").first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/help\/registration\/waitlist$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("The waitlist");
  expect(indexRequests, "never fetched again on this page").toHaveLength(1);
});

test("the search in the section column works on an article page too, and a word that matches nothing says so", async ({ page }) => {
  await visit(page, LONG);
  const box = page.getByRole("searchbox", { name: "Search help" });
  await box.fill("zzqqxx");
  // The visible message, not the screen-reader status that carries the same words.
  await expect(page.getByTestId("help-search-message")).toHaveText("No pages match. Try another word.");
  await expect(page.getByTestId("help-search-message")).toBeVisible();
  await box.fill("waitlist");
  await expect(page.getByRole("list", { name: "Search results" }).locator('a[href="/help/registration/waitlist"]')).toBeVisible();
});

test("1280: no horizontal scroll and no serious axe finding on the help home, articles and format pages", async ({ page }) => {
  let checked = 0;
  for (const path of PAGES) {
    await visit(page, path);
    await expectNoHorizontalScroll(page);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(
      seriousAxe(axe.violations),
      `axe serious/critical on ${path}`,
    ).toEqual([]);
    checked += 1;
  }
  expect(checked, "anti-vacuity").toBe(PAGES.length);
});

test("1280: a page a post names lists it under Read how it works, and the link opens the post", async ({ page }) => {
  await visit(page, WITH_POSTS);
  const list = page.getByTestId("help-blog-links");
  await expect(list.getByRole("heading", { name: "Read how it works" })).toBeVisible();
  const links = list.getByRole("link");
  expect(await links.count(), "anti-vacuity: the page lists a post").toBeGreaterThan(0);
  expect(await links.count()).toBeLessThanOrEqual(3);
  const href = await links.first().getAttribute("href");
  expect(href).toMatch(/^\/blog\/[a-z0-9-]+$/);
  await links.first().click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // A page no post names has no such list, and no empty heading.
  await visit(page, helpPageWithoutPosts());
  await expect(page.getByTestId("help-blog-links")).toHaveCount(0);
  await expect(page.getByText("Read how it works")).toHaveCount(0);
});
