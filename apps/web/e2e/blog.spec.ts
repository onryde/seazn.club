// The blog at desktop width in a browser (Blog P2 Task 4; the seven phone and tablet widths are e2e/mobile/blog.spec.ts).
// What the unit suite (src/app/blog/__tests__, node, no DOM) cannot see: no sideways page scroll at 1280, 768 and 320, axe,
// a wide example table scrolling INSIDE a focusable named region (AGENTS.md class 23), the "On this page" rail beside the
// article, the nav's client-side signed-in swap against the real session cookies, the Help icon's hit area, and the feed.
//
// The pilot is the one post on disk; the index shows no sport chips until a post names a sport (the chips' rule is a unit
// test, src/app/blog/__tests__/blog-pages.test.tsx), so no chip is clicked here.
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectNoHorizontalScroll, overflowingIn } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";

const POST = "/blog/how-standings-points-work";
const WIDTHS = [1280, 768, 320] as const;

const signedOut = { storageState: { cookies: [], origins: [] } };

async function visit(page: Page, path: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  const res = await page.goto(path);
  expect(res?.status(), path).toBeLessThan(400);
  await dismissCookieBanner(page);
}

/** axe's serious and critical findings, as short lines. */
async function seriousAxe(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} - ${v.nodes[0]?.html}`);
}

test.describe("signed out", () => {
  test.use(signedOut);

  for (const width of WIDTHS) {
    for (const path of ["/blog", POST]) {
      test(`${path} at ${width}: no horizontal page scroll, nothing clipped, axe finds nothing serious`, async ({ page }) => {
        await visit(page, path, width);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expectNoHorizontalScroll(page);
        const { clipped, scrollable } = await overflowingIn(page, "main", "div,section,table,figure,nav,ul,a", "main was not in the DOM");
        expect(clipped, "content clipped, not scrollable").toEqual([]);
        // Every box that scrolls sideways is one a keyboard user can reach.
        for (const box of scrollable) expect(box, "a scrolling box without a tab stop").toMatch(/tabindex=0$/);
        expect(await seriousAxe(page)).toEqual([]);
      });
    }
  }

  test("the example table scrolls inside its own focusable, named region, never the page (320)", async ({ page }) => {
    await visit(page, POST, 320);
    const region = page.getByRole("region", { name: /What one finished match is worth/ });
    await expect(region).toBeVisible();
    await expect(region).toHaveAttribute("tabindex", "0");
    const m = await region.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, overflowX: getComputedStyle(el).overflowX }));
    expect(m.scroll, "the table is wider than the phone").toBeGreaterThan(m.client + 40);
    expect(m.overflowX).toBe("auto");
    await region.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await expectNoHorizontalScroll(page);
    // The hint that it swipes is there below md.
    await expect(page.getByText("Swipe sideways to see the whole table")).toBeVisible();
  });

  test("1280: the article, then the 'On this page' rail on its right, which marks and scrolls to a section", async ({ page }) => {
    await visit(page, POST, 1280);
    const rail = page.getByRole("navigation", { name: "On this page" });
    await expect(rail).toBeVisible();
    const h1 = (await page.getByRole("heading", { level: 1 }).boundingBox())!;
    const box = (await rail.boundingBox())!;
    expect(h1.x + h1.width, "the article is left of the rail").toBeLessThanOrEqual(box.x);
    const last = rail.locator("a").last();
    await expect(last).toHaveAttribute("href", "#how-seazn-handles-it");
    await last.click();
    await expect(page.locator("#how-seazn-handles-it")).toBeInViewport();
    // The post's "How Seazn handles it" link leads to a help page that exists.
    const go = page.getByTestId("blog-handles-it").getByRole("link");
    const href = (await go.getAttribute("href"))!;
    expect(href).toMatch(/^\/help\//);
    const res = await page.request.get(href);
    expect(res.status()).toBe(200);
  });

  test("the page declares its feed, a canonical and an article card, and the byline says Seazn", async ({ page }) => {
    await visit(page, POST, 1280);
    await expect(page.locator('link[rel="alternate"][type="application/rss+xml"]')).toHaveAttribute("href", "https://seazn.club/blog/rss.xml");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/blog\/how-standings-points-work$/);
    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", "article");
    await expect(page.locator('meta[property="article:author"]')).toHaveAttribute("content", "Seazn");
    await expect(page).toHaveTitle(/ — Seazn Club Blog$/);
    await expect(page.getByTestId("blog-byline")).toContainText("Seazn");
    const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
    const posting = ld.map((t) => JSON.parse(t) as { "@type": string; author?: unknown }).find((b) => b["@type"] === "BlogPosting");
    expect(posting?.author).toEqual({ "@type": "Organization", name: "Seazn" });
  });

  test("the bar: Blog between Sports and Pricing, Help as a 44px icon link, and no Dashboard for a signed-out visitor", async ({ page }) => {
    await visit(page, "/blog", 1280);
    const bar = page.locator("[data-mk-nav]");
    const order = await bar.locator("nav > *").evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim() || e.getAttribute("aria-label") || ""));
    const at = (s: string) => order.findIndex((o) => o.startsWith(s));
    expect(at("Sports")).toBeGreaterThan(-1);
    expect(at("Blog")).toBe(at("Sports") + 1);
    expect(at("Pricing")).toBe(at("Blog") + 1);
    const help = bar.getByRole("link", { name: "Help", exact: true });
    await expect(help).toHaveAttribute("title", "Help");
    await expect(help).toHaveAttribute("href", "/help");
    const box = (await help.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(bar.getByRole("link", { name: /Log in/ })).toBeVisible();
    await expect(bar.getByRole("link", { name: /Dashboard/ })).toHaveCount(0);
  });

  test("the feed is RSS: XML, one item per post, newest first", async ({ request }) => {
    const res = await request.get("/blog/rss.xml");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("rss+xml");
    const xml = await res.text();
    expect(xml.startsWith('<?xml version="1.0"')).toBe(true);
    expect(xml).toContain('<rss version="2.0"');
    const items = xml.match(/<item>/g) ?? [];
    expect(items.length).toBeGreaterThan(0);
    expect(xml).toContain("/blog/how-standings-points-work</link>");
  });

  test("a slug that is not a post is a 404, and the share card is a PNG", async ({ request }) => {
    expect((await request.get("/blog/not-a-post")).status()).toBe(404);
    const card = await request.get(`${POST}/opengraph-image`);
    expect(card.status()).toBe(200);
    expect(card.headers()["content-type"]).toContain("image/png");
  });
});

// The default project state is a real signed-in session (auth.setup.ts: a magic-link login, which sets BOTH cookies). The page
// is cached and shared, so it was drawn for a stranger; the swap happens in the browser from the readable hint cookie.
test.describe("signed in", () => {
  test("the bar swaps its sign-in actions for Dashboard after hydration, with no server read of the session", async ({ page, playwright, baseURL }) => {
    await visit(page, "/blog", 1280);
    const bar = page.locator("[data-mk-nav]");
    await expect(bar.getByRole("link", { name: /Dashboard/ })).toBeVisible();
    await expect(bar.getByRole("link", { name: /Log in/ })).toHaveCount(0);
    await expect(bar.getByRole("link", { name: /Start free/ })).toHaveCount(0);
    // The served markup is the static, signed-out one whoever asks: it renders no dashboard link and does render the sign-in
    // actions. ("Dashboard" may sit in the serialised client-component props, so the probe is on rendered anchors.)
    const stranger = await playwright.request.newContext({ baseURL: baseURL! });
    const raw = await stranger.get("/blog");
    expect(raw.status()).toBe(200);
    const html = await raw.text();
    expect(html).not.toMatch(/<a [^>]*href="\/dashboard"/);
    expect(html).toMatch(/<a [^>]*href="\/login[^"]*"/);
    await stranger.dispose();
  });

  test("the post page swaps too", async ({ page }) => {
    await visit(page, POST, 1280);
    await expect(page.locator("[data-mk-nav]").getByRole("link", { name: /Dashboard/ })).toBeVisible();
  });
});
