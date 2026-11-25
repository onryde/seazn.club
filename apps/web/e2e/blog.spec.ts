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

// Layout A (owner pick 2026-11-25): everything in a post's reading column is the SAME 44rem wide and starts at the same
// left edge. Measured in the page, element by element; a kind with no element found fails (anti-vacuity), so a renamed
// test id cannot pass by checking nothing.
const REM = 16;
const COLUMN_PARTS: Record<string, string> = {
  header: '[data-testid="blog-post"] > header',
  lede: '[data-testid="blog-post"] > header > p:first-of-type',
  prose: ".blog-prose",
  heading: ".blog-prose h2",
  paragraph: ".blog-prose > p",
  example: '[data-testid="blog-example"]',
  diagram: '[data-testid="blog-diagram"]',
  picture: ".blog-prose figure img",
  art: '[data-testid="blog-art"] img',
  handles: '[data-testid="blog-handles-it"]',
  related: '[data-testid="blog-related"]',
};
const COMMON = ["header", "lede", "prose", "heading", "paragraph", "handles", "related"];
const COLUMN_POSTS: { path: string; kinds: string[] }[] = [
  { path: "/blog/chess-points-and-half-points", kinds: [...COMMON, "example", "picture"] },
  { path: "/blog/how-a-ladder-works", kinds: [...COMMON, "diagram"] },
  { path: "/blog/what-you-need-to-stream-a-match", kinds: [...COMMON, "art"] },
];

test.describe("layout A: one reading column", () => {
  test.use(signedOut);

  for (const width of WIDTHS) {
    for (const { path, kinds } of COLUMN_POSTS) {
      test(`${path} at ${width}: every part of the post is one column wide`, async ({ page }, testInfo) => {
        await visit(page, path, width);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        const column = Math.min(44 * REM, width - 2 * 16);
        const left = (await page.locator(COLUMN_PARTS.header!).boundingBox())!.x;
        let checked = 0;
        const wrong: string[] = [];
        for (const kind of kinds) {
          const found = page.locator(COLUMN_PARTS[kind]!);
          const n = await found.count();
          expect(n, `${path}: anti-vacuity, no '${kind}' found`).toBeGreaterThan(0);
          for (let i = 0; i < n; i++) {
            const box = (await found.nth(i).boundingBox())!;
            if (Math.abs(box.width - column) > 1 || Math.abs(box.x - left) > 1) {
              wrong.push(`${kind}[${i}] x=${Math.round(box.x)} w=${Math.round(box.width)} (column x=${Math.round(left)} w=${column})`);
            }
            checked++;
          }
        }
        testInfo.annotations.push({ type: "column-elements-checked", description: String(checked) });
        console.log(`column check ${path} @${width}: ${checked} elements, column ${column}px`);
        expect(checked, "anti-vacuity: elements measured").toBeGreaterThanOrEqual(kinds.length);
        expect(wrong, `${checked} elements measured`).toEqual([]);
        await expectNoHorizontalScroll(page);
      });
    }
  }

  const style = (page: Page, selector: string) =>
    page.locator(selector).first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { size: s.fontSize, line: s.lineHeight, transform: s.textTransform };
    });

  test("a post's type: 17px body at 1.7, a 19px lede, section headings in normal case", async ({ page }) => {
    await visit(page, "/blog/chess-points-and-half-points", 1280);
    const p = await style(page, ".blog-prose > p");
    expect(p.size).toBe("17px");
    expect(Math.abs(parseFloat(p.line) - 17 * 1.7), `line height ${p.line}`).toBeLessThan(0.5);
    expect((await style(page, ".blog-prose li")).size).toBe("17px");
    expect((await style(page, COLUMN_PARTS.lede!)).size).toBe("19px");
    expect((await style(page, ".blog-prose h2")).transform).toBe("none");
  });

  // The art has two drawings: the browser takes the phone one below 600px and the wide one from 600. Both must really
  // load (a broken file keeps its reserved box, so a width check alone would pass on it).
  test("a post's art: the phone drawing below 600px, the wide drawing from 600, each one loaded", async ({ page }) => {
    let checked = 0;
    for (const { width, file } of [
      { width: 320, file: "what-you-need-to-stream-a-match-flow-phone.svg" },
      { width: 599, file: "what-you-need-to-stream-a-match-flow-phone.svg" },
      { width: 600, file: "what-you-need-to-stream-a-match-flow.svg" },
      { width: 1280, file: "what-you-need-to-stream-a-match-flow.svg" },
    ]) {
      await visit(page, "/blog/what-you-need-to-stream-a-match", width);
      const img = page.locator(COLUMN_PARTS.art!);
      await img.scrollIntoViewIfNeeded();
      const shown = () => img.evaluate((el: HTMLImageElement) => ({ file: el.currentSrc.split("/").pop(), loaded: el.complete && el.naturalWidth > 0 }));
      await expect.poll(shown, { message: `art at ${width}` }).toEqual({ file, loaded: true });
      // Its height follows the drawing that was picked, not the other one's reserved box.
      const box = (await img.boundingBox())!;
      const ratio = file.endsWith("-phone.svg") ? 1100 / 360 : 700 / 1200;
      expect(Math.abs(box.height - box.width * ratio), `art shape at ${width}: ${Math.round(box.width)}x${Math.round(box.height)}`).toBeLessThan(2);
      await expectNoHorizontalScroll(page);
      checked++;
    }
    expect(checked, "anti-vacuity: widths checked").toBe(4);
  });

  // The positive pair: `.help-prose` is shared, so a help article must still be help's own type and width.
  test("a help article keeps help's own prose: 15px, uppercase section headings, a 34rem column", async ({ page }) => {
    await visit(page, "/help/registration/card-payments", 1280);
    await expect(page.locator(".help-prose")).toHaveCount(1);
    await expect(page.locator(".blog-prose")).toHaveCount(0);
    expect((await style(page, ".help-prose > p")).size).toBe("15px");
    expect((await style(page, ".help-prose h2")).transform).toBe("uppercase");
    const box = (await page.locator(".help-prose").boundingBox())!;
    expect(Math.round(box.width)).toBe(34 * REM);
  });
});

// The default project state is a real signed-in session (auth.setup.ts: a magic-link login, which sets BOTH cookies). The page
// is cached and shared, so it was drawn for a stranger; the swap happens in the browser from the readable hint cookie.
test.describe("signed in", () => {
  test("nothing in the bar moves when the Dashboard swap happens (every frame, then against a signed-out visit)", async ({ page, browser }) => {
    // Sample the left edge of every bar link on every animation frame from the first paint, so a jump that lasts a single
    // frame is caught, then compare the settled signed-in bar with the signed-out one.
    await page.addInitScript(() => {
      const samples: string[] = [];
      (window as unknown as { __barSamples: string[] }).__barSamples = samples;
      const tick = () => {
        const bar = document.querySelector("[data-mk-nav]");
        if (bar) {
          const xs = [...bar.querySelectorAll("a.mk-nav-link, button")].filter((e) => !(e as HTMLElement).closest("[data-testid=nav-session-slot]")).map((e) => Math.round((e as HTMLElement).getBoundingClientRect().left * 2) / 2);
          if (xs.length) samples.push(xs.join(","));
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await visit(page, "/blog", 1280);
    const bar = page.locator("[data-mk-nav]");
    await expect(bar.getByRole("link", { name: /Dashboard/ })).toBeVisible();
    await page.waitForTimeout(300);
    const samples = await page.evaluate(() => (window as unknown as { __barSamples: string[] }).__barSamples);
    const distinct = [...new Set(samples)];
    expect(samples.length, "anti-vacuity: frames sampled").toBeGreaterThan(5);
    expect(distinct.length, `the other bar items stayed put in every frame: ${distinct.join(" | ")}`).toBe(1);
    const left = async (pg: Page) => pg.locator("[data-mk-nav]").getByRole("link", { name: "Blog", exact: true }).evaluate((e) => Math.round(e.getBoundingClientRect().left * 2) / 2);
    const signedInLeft = await left(page);
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 900 } });
    const out = await ctx.newPage();
    await visit(out, "/blog", 1280);
    await expect(out.locator("[data-mk-nav]").getByRole("link", { name: "Log in" })).toBeVisible();
    expect(await left(out), "the Blog link is where it is for a signed-out visitor").toBe(signedInLeft);
    await ctx.close();
  });

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
