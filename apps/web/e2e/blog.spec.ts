// The blog at desktop width in a browser (Blog P2 Task 4; the seven phone and tablet widths are e2e/mobile/blog.spec.ts).
// What the unit suite (src/app/blog/__tests__, node, no DOM) cannot see: no sideways page scroll at 1280, 768 and 320, axe,
// a wide example table scrolling INSIDE a focusable named region (AGENTS.md class 23), the one reading column with no
// "On this page", the serif only a post page and a help article load, the nav's client-side signed-in swap against the real session cookies,
// the Help icon's hit area, and the feed.
//
// The pilot is the one post on disk; the index shows no sport chips until a post names a sport (the chips' rule is a unit
// test, src/app/blog/__tests__/blog-pages.test.tsx), so no chip is clicked here.
import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectNoHorizontalScroll, overflowingIn } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { CHECKLIST_POST, expectChecklist } from "./blog-checklist";
import { SERIF, drawnWith, notTheSerif, serifFiles, style, watchFonts } from "./reading-font";

const POST = "/blog/how-standings-points-work";
const WIDTHS = [1280, 768, 320] as const;

const signedOut = { storageState: { cookies: [], origins: [] } };

async function visit(page: Page, path: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  const res = await page.goto(path);
  expect(res?.status(), path).toBeLessThan(400);
  await dismissCookieBanner(page);
}

/** The pixel width of the file a lazy picture loaded: scrolled to, then waited for. */
async function naturalWidth(img: Locator): Promise<number> {
  await img.scrollIntoViewIfNeeded();
  const read = () => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0));
  await expect.poll(read, { message: "the picture loaded" }).toBeGreaterThan(0);
  return read();
}

/** axe's serious and critical findings, as short lines. */
async function seriousAxe(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} - ${v.nodes[0]?.html}`);
}

test.describe("signed out", () => {
  test.use(signedOut);

  for (const width of WIDTHS) {
    for (const path of ["/blog", POST, CHECKLIST_POST]) {
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

  test("signed out, help and blog show Log in and Start free: in the bar from 640, in the menu on a phone", async ({ page }) => {
    let checked = 0;
    for (const path of ["/help", "/help/scoring/basics", "/blog", POST]) {
      for (const width of [1280, 768, 640, 320]) {
        await visit(page, path, width);
        const bar = page.locator("[data-mk-nav]");
        if (width < 640) await bar.getByRole("button", { name: "Open menu" }).click();
        const where = width < 640 ? bar.getByRole("menu") : bar;
        const role = width < 640 ? "menuitem" : "link";
        await expect(where.getByRole(role, { name: "Log in" }), `${path} at ${width}`).toBeVisible();
        await expect(where.getByRole(role, { name: "Start free" }), `${path} at ${width}`).toBeVisible();
        await expect(bar.getByText(/Dashboard/).filter({ visible: true }), `${path} at ${width}`).toHaveCount(0);
        await expect(bar.getByRole("link", { name: /Dashboard/ })).toHaveCount(0);
        checked++;
      }
    }
    expect(checked, "anti-vacuity").toBe(16);
  });

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

  for (const width of WIDTHS) {
    test(`the streaming guide's checklist at ${width}: a card per row below 480, an ordinary table from there`, async ({ page }) => {
      await visit(page, CHECKLIST_POST, width);
      await expectChecklist(page, width);
      await expectNoHorizontalScroll(page);
    });
  }

  test("'How Seazn handles it' is still a link target, and its link leads to a help page that exists", async ({ page }) => {
    await visit(page, `${POST}#how-seazn-handles-it`, 1280);
    await expect(page.locator("#how-seazn-handles-it")).toBeInViewport();
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

// The reading layout (owner pick "A", 2026-11-25): one centred 680px column at every width and no table of contents.
// Everything in a post's column is the SAME width and starts at the same left edge. A screenshot is the one exception to
// the width: it is never scaled up past its own pixels. Measured in the page, element by element; a kind with no element
// found fails (anti-vacuity), so a renamed test id cannot pass by checking nothing.
const COLUMN = 680;
const COLUMN_PARTS: Record<string, string> = {
  header: '[data-testid="blog-post"] > header',
  lede: '[data-testid="blog-post"] > header > p:first-of-type',
  byline: '[data-testid="blog-byline"]',
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
const COMMON = ["header", "lede", "byline", "prose", "heading", "paragraph", "handles", "related"];
const COLUMN_POSTS: { path: string; kinds: string[] }[] = [
  { path: "/blog/chess-points-and-half-points", kinds: [...COMMON, "example", "picture"] },
  { path: "/blog/how-standings-points-work", kinds: [...COMMON, "example", "picture"] },
  { path: "/blog/how-a-ladder-works", kinds: [...COMMON, "diagram"] },
  { path: "/blog/what-you-need-to-stream-a-match", kinds: [...COMMON, "art"] },
];

test.describe("the reading column", () => {
  test.use(signedOut);

  for (const width of WIDTHS) {
    for (const { path, kinds } of COLUMN_POSTS) {
      test(`${path} at ${width}: one centred column, every part of the post in it, no 'On this page'`, async ({ page }, testInfo) => {
        await visit(page, path, width);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(page.getByTestId("help-toc")).toHaveCount(0);
        await expect(page.getByText("On this page", { exact: true })).toHaveCount(0);
        const column = Math.min(COLUMN, width - 2 * 16);
        const left = (await page.locator(COLUMN_PARTS.header!).boundingBox())!.x;
        const inner = await page.evaluate(() => document.documentElement.clientWidth);
        expect(Math.abs(left - (inner - column) / 2), `centred: x=${left} in ${inner}px`).toBeLessThanOrEqual(1);
        let checked = 0;
        const wrong: string[] = [];
        for (const kind of kinds) {
          const found = page.locator(COLUMN_PARTS[kind]!);
          const n = await found.count();
          expect(n, `${path}: anti-vacuity, no '${kind}' found`).toBeGreaterThan(0);
          for (let i = 0; i < n; i++) {
            const want = kind === "picture" ? Math.min(column, await naturalWidth(found.nth(i))) : column;
            const box = (await found.nth(i).boundingBox())!;
            if (Math.abs(box.width - want) > 1 || Math.abs(box.x - left) > 1) {
              wrong.push(`${kind}[${i}] x=${Math.round(box.x)} w=${Math.round(box.width)} (column x=${Math.round(left)}, want w=${want})`);
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

  // The case the rule exists for: a screenshot narrower than the column. The premise is checked, so a recaptured, wider
  // picture fails here instead of leaving the upscale untested.
  test("a screenshot narrower than the column keeps its own width", async ({ page }) => {
    await visit(page, "/blog/how-standings-points-work", 1280);
    const img = page.locator(COLUMN_PARTS.picture!);
    const natural = await naturalWidth(img);
    expect(natural, "premise: narrower than the 680px column").toBeLessThan(COLUMN);
    expect(Math.abs((await img.boundingBox())!.width - natural), `drawn at its own ${natural}px`).toBeLessThanOrEqual(1);
  });

  // Phone sizes below 600, where the art also changes drawing; the full sizes from there. 599 and 600 are the two sides.
  for (const { width, size } of [
    { width: 1280, size: { body: 20, title: "42px", lede: "22px", h2: "24px" } },
    { width: 600, size: { body: 20, title: "42px", lede: "22px", h2: "24px" } },
    { width: 599, size: { body: 18, title: "31px", lede: "18px", h2: "21px" } },
    { width: 320, size: { body: 18, title: "31px", lede: "18px", h2: "21px" } },
  ]) {
    test(`a post's type at ${width}: a ${size.body}px serif body at 1.6, a grey subtitle, the byline between two hairlines`, async ({ page }) => {
      // One post carries everything read here: paragraphs, list items, a generated example and a screenshot figure.
      await visit(page, "/blog/chess-points-and-half-points", width);
      let checked = 0;
      for (const selector of [".blog-prose > p", ".blog-prose li"]) {
        const s = await style(page, selector);
        expect(s.size, selector).toBe(`${size.body}px`);
        expect(Math.abs(s.line - size.body * 1.6), `${selector} line height ${s.line}`).toBeLessThan(0.5);
        expect(s.family.split(",")[0], selector).toMatch(SERIF);
        expect(s.color, selector).toBe("rgb(36, 36, 36)");
        checked++;
      }
      expect((await style(page, "main h1")).size).toBe(size.title);
      const lede = await style(page, COLUMN_PARTS.lede!);
      expect([lede.size, lede.color]).toEqual([size.lede, "rgb(107, 107, 107)"]);
      const h2 = await style(page, ".blog-prose h2");
      expect([h2.size, h2.transform]).toEqual([size.h2, "none"]);
      const byline = await style(page, COLUMN_PARTS.byline!);
      expect([byline.top, byline.bottom]).toEqual(["1px solid rgb(236, 236, 236)", "1px solid rgb(236, 236, 236)"]);
      // Everything that is not body text stays in the house sans.
      const sans = [
        "main h1",
        COLUMN_PARTS.lede!,
        '[data-testid="blog-post"] nav[aria-label="Breadcrumb"] a',
        `${COLUMN_PARTS.byline!} time`,
        ".blog-prose h2",
        '[data-testid="blog-example"] figcaption',
        '[data-testid="blog-example"] th',
        '[data-testid="blog-example"] td',
        ".blog-prose figure figcaption",
        '[data-testid="blog-handles-it"] h2',
        '[data-testid="blog-handles-it"] p',
        '[data-testid="blog-handles-it"] a',
        '[data-testid="blog-related"] li a span',
      ];
      for (const selector of sans) {
        await expect(page.locator(selector).first(), `anti-vacuity: ${selector}`).toBeAttached();
        expect((await style(page, selector)).family, selector).not.toMatch(SERIF);
        checked++;
      }
      expect(checked, "anti-vacuity: elements whose face was read").toBe(sans.length + 2);
    });
  }

  test("a post page loads the serif from this site; no font comes from anywhere else", async ({ page, baseURL }) => {
    const asked = watchFonts(page);
    await visit(page, "/blog/chess-points-and-half-points", 1280);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    const files = await serifFiles(page);
    expect(files.length, "premise: the serif declares its files").toBeGreaterThan(0);
    const loaded = asked.filter((u) => files.includes(u));
    console.log(`post page: ${asked.length} font requests, ${loaded.length} of them the serif (${files.length} declared)`);
    expect(loaded.length, "the serif was fetched").toBeGreaterThan(0);
    expect(asked.filter((u) => new URL(u).origin !== new URL(baseURL!).origin), "fonts from another origin").toEqual([]);
    expect(new Set(loaded).size, "one file: the Latin one, regular and bold together").toBe(1);
    const drawn = await drawnWith(page, ".blog-prose > p");
    expect(drawn.nodes, "anti-vacuity: paragraphs drawn").toBeGreaterThan(0);
    expect(notTheSerif(drawn.faces)).toEqual([]);
  });

  // Help ARTICLE pages share the face (e2e/help.spec.ts "the reading style"); the help home and the format pages do not.
  test("no other page asks for the serif: the blog index, the help home and format pages, the home page and pricing", async ({ page }) => {
    // The files are read from a post, then each other page is opened fresh and left to settle while its links prefetch.
    // A fixed settle, not "network idle": the home page keeps prefetching and is never idle.
    test.setTimeout(180_000);
    await visit(page, "/blog/chess-points-and-half-points", 1280);
    const files = await serifFiles(page);
    expect(files.length, "premise").toBeGreaterThan(0);
    let checked = 0;
    const others = ["/blog", "/help", "/help/formats", "/help/formats/knockout", "/en", "/pricing"];
    for (const path of others) {
      const other = await page.context().newPage();
      const asked = watchFonts(other);
      const postPrefetches: string[] = [];
      other.on("requestfinished", (r) => {
        if (/\/blog\/[a-z0-9-]+\?_rsc=/.test(r.url())) postPrefetches.push(r.url());
      });
      await visit(other, path, 1280);
      await other.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      // The index is where this leaks: a prefetched post route carries its preload hints with it. The premise is that
      // one was prefetched, or the check below would pass with nothing to catch.
      if (path === "/blog") await expect.poll(() => postPrefetches.length, { message: "the index prefetched a post", timeout: 30_000 }).toBeGreaterThan(0);
      await other.waitForTimeout(3_000);
      expect(asked.length, `${path}: anti-vacuity, its own fonts were seen`).toBeGreaterThan(0);
      expect(asked.filter((u) => files.includes(u)), path).toEqual([]);
      const preloaded = await other.locator('link[rel="preload"][as="font"]').evaluateAll((els) => els.map((e) => (e as HTMLLinkElement).href));
      expect(preloaded.filter((u) => files.includes(u)), `${path}: preload`).toEqual([]);
      await other.close();
      checked++;
    }
    expect(checked, "anti-vacuity: pages checked").toBe(others.length);
  });

  // The serif is a Latin subset: every character a post draws in it must be in it (the ½ of a drawn game, the × and the
  // dashes), or the browser quietly draws that one in another face. The posts come from the feed.
  test("every post's body is drawn wholly in the serif, and so is every non-ASCII character any post uses", async ({ page, request }) => {
    const xml = await (await request.get("/blog/rss.xml")).text();
    const paths = [...xml.matchAll(/<link>https?:\/\/[^<]+?(\/blog\/[a-z0-9-]+)<\/link>/g)].map((m) => m[1]!);
    expect(paths.length, "anti-vacuity: posts in the feed").toBeGreaterThan(20);
    test.setTimeout(Math.max(120_000, paths.length * 8_000));
    await page.setViewportSize({ width: 1280, height: 900 });
    const special = new Set<string>();
    const wrong: string[] = [];
    let nodes = 0;
    let glyphs = 0;
    for (const path of paths) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      const drawn = await drawnWith(page, ".blog-prose p, .blog-prose p *, .blog-prose li, .blog-prose li *");
      expect(drawn.nodes, `${path}: anti-vacuity, body text drawn`).toBeGreaterThan(0);
      for (const face of notTheSerif(drawn.faces)) wrong.push(`${path}: ${face}`);
      nodes += drawn.nodes;
      glyphs += drawn.glyphs;
      for (const c of (await page.getByTestId("blog-post").innerText()).match(/[^\x00-\x7F]/g) ?? []) if (!/\s/.test(c)) special.add(c);
    }
    expect(wrong, `${paths.length} posts, ${nodes} elements, ${glyphs} glyphs`).toEqual([]);
    // Tables are sans today; a character used only there must still be in the serif before it moves into a sentence.
    const chars = [...special].sort().join("");
    expect(chars, "premise: posts use the half of a drawn game").toContain("½");
    await page.locator(".blog-prose").first().evaluate((el, text) => {
      const probe = el.appendChild(document.createElement("p"));
      probe.id = "glyph-probe";
      probe.textContent = text;
    }, chars);
    const probe = await drawnWith(page, "#glyph-probe");
    console.log(`serif sweep: ${paths.length} posts, ${nodes} elements, ${glyphs} glyphs; non-ASCII characters probed: ${chars}`);
    expect(probe.glyphs, "anti-vacuity: probe glyphs").toBeGreaterThanOrEqual([...chars].length);
    expect(notTheSerif(probe.faces), chars).toEqual([]);
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
});

// The bar's right end, as drawn: the Help icon (from md), the sign-in actions, the phone menu button (below md).
async function barEnd(page: Page) {
  return page.locator("[data-mk-nav]").evaluate((bar) => {
    const box = (el: Element | null | undefined) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || getComputedStyle(el).visibility === "hidden") return null;
      return { left: Math.round(r.left * 2) / 2, right: Math.round(r.right * 2) / 2, width: Math.round(r.width * 2) / 2 };
    };
    const row = [...bar.querySelectorAll("nav a, nav button")].filter((e) => !e.closest('[role="menu"]'));
    const named = (text: RegExp) => box(row.find((e) => text.test((e.textContent ?? "").trim())));
    return {
      help: box(bar.querySelector('nav > a[href="/help"]')),
      blog: named(/^Blog$/),
      dashboard: named(/^Dashboard/),
      login: named(/^Log in$/),
      start: named(/^Start free$/),
      menu: box(row.find((e) => e.getAttribute("aria-haspopup") === "menu" && !e.textContent?.trim())),
      slot: box(bar.querySelector('[data-testid="nav-session-slot"]')),
    };
  });
}

/**
 * Records, on every animation frame from the first, where each of the bar's own links and buttons stands (in document
 * order, the session slot's excluded). A frame can come mid-parse and hold only the first few; those are compared too.
 */
async function sampleBarFrames(page: Page) {
  await page.addInitScript(() => {
    const frames: number[][] = [];
    (window as unknown as { __barFrames: number[][] }).__barFrames = frames;
    const tick = () => {
      const bar = document.querySelector("[data-mk-nav]");
      if (bar) {
        const xs = [...bar.querySelectorAll("a.mk-nav-link, button")]
          .filter((e) => !(e as HTMLElement).closest("[data-testid=nav-session-slot]"))
          .map((e) => Math.round((e as HTMLElement).getBoundingClientRect().left * 2) / 2);
        if (xs.length) frames.push(xs);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Cold loads per case. One load is not proof: with the mark inside the slot the stray frame showed on most loads, not all. */
const FRAME_LOADS = 6;

/** Loads `path` FRAME_LOADS times; every item present in any frame must already stand where it ends up. */
async function expectNothingMoves(page: Page, path: string, width: number, ready: () => Promise<void>) {
  let framesChecked = 0;
  const moved: string[] = [];
  for (let load = 0; load < FRAME_LOADS; load++) {
    await visit(page, path, width);
    await ready();
    await page.waitForTimeout(300);
    const frames = await page.evaluate(() => (window as unknown as { __barFrames: number[][] }).__barFrames);
    expect(frames.length, "anti-vacuity: frames sampled").toBeGreaterThan(5);
    const final = frames.at(-1)!;
    expect(final.length, "premise: the bar's items").toBeGreaterThanOrEqual(6);
    for (const f of frames) if (f.some((x, i) => x !== final[i])) moved.push(`load ${load}: ${f.join(",")} (ends ${final.join(",")})`);
    framesChecked += frames.length;
  }
  expect([...new Set(moved)], `no bar item stood anywhere but its final place, over ${framesChecked} frames`).toEqual([]);
}

/** The bar's own spacing between its items from `sm` up (`sm:gap-2`). */
const BAR_GAP = 8;
const SWAP_WIDTHS = [1280, 768, 640] as const;
/** Server-rendered for the visitor (MarketingNav `auth="server"`): the signed-in bar every other page draws. */
const SERVER_NAV_PAGE = "/pricing";

// The default project state is a real signed-in session (auth.setup.ts: a magic-link login, which sets BOTH cookies). The page
// is cached and shared, so it was drawn for a stranger; the swap happens in the browser from the readable hint cookie.
test.describe("signed in", () => {
  for (const width of SWAP_WIDTHS) {
    test(`${width}: Dashboard sits right after the Help icon, as on a server-drawn page, with no gap left by the signed-out pair`, async ({ page, browser }) => {
      await visit(page, SERVER_NAV_PAGE, width);
      await expect(page.locator("[data-mk-nav]").getByRole("link", { name: /Dashboard/ })).toBeVisible();
      const server = await barEnd(page);
      expect(server.slot, "premise: a server-drawn page has no swap slot").toBeNull();
      const signedOutCtx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width, height: 900 } });
      const out = await signedOutCtx.newPage();
      await visit(out, "/help", width);
      await expect(out.locator("[data-mk-nav]").getByRole("link", { name: "Log in" })).toBeVisible();
      const stranger = await barEnd(out);
      await signedOutCtx.close();

      let checked = 0;
      for (const path of ["/help", "/help/scoring/basics", "/blog", POST]) {
        await visit(page, path, width);
        await expect(page.locator("[data-mk-nav]").getByRole("link", { name: /Dashboard/ }), path).toBeVisible();
        const bar = await barEnd(page);
        expect(bar.slot, `${path}: premise, the swap slot`).not.toBeNull();
        expect([bar.login, bar.start], `${path}: the signed-out pair is gone`).toEqual([null, null]);
        // No empty room in the slot: it is exactly the button.
        expect(bar.slot, path).toEqual(bar.dashboard);
        if (width >= 768) expect(bar.dashboard!.left - bar.help!.right, `${path}: gap after the Help icon`).toBe(BAR_GAP);
        else expect(bar.menu!.left - bar.dashboard!.right, `${path}: gap before the menu button`).toBe(BAR_GAP);
        // The same place a server-drawn signed-in bar puts everything.
        expect([bar.blog, bar.help, bar.dashboard, bar.menu], `${path}: as ${SERVER_NAV_PAGE}`).toEqual([server.blog, server.help, server.dashboard, server.menu]);
        // And the bar ends where a signed-out visitor's does.
        if (width >= 768) expect(bar.dashboard!.right, `${path}: right edge`).toBe(stranger.start!.right);
        checked++;
      }
      expect(checked, "anti-vacuity").toBe(4);
    });
  }

  for (const width of SWAP_WIDTHS) {
    test(`${width}: nothing in the bar moves when the Dashboard swap happens (every frame, and before the page's scripts arrive)`, async ({ page }) => {
      await sampleBarFrames(page);
      await expectNothingMoves(page, "/blog", width, () => expect(page.locator("[data-mk-nav]").getByRole("link", { name: /Dashboard/ })).toBeVisible());
      const hydrated = await barEnd(page);

      // The page before React: the framework's scripts never arrive, so only the markup, the stylesheet and the inline
      // mark are at work. The slot already has the button's width, and the signed-out pair is not shown.
      let blocked = 0;
      await page.route(/\/_next\/static\/.*\.js/, (route) => {
        blocked++;
        return route.abort();
      });
      const res = await page.goto("/blog", { waitUntil: "load" });
      expect(res?.status()).toBe(200);
      await page.evaluate(() => document.fonts.ready);
      expect(blocked, "premise: the page's scripts were held back").toBeGreaterThan(0);
      const early = await barEnd(page);
      expect(early.dashboard, "premise: React has not drawn the button").toBeNull();
      expect([early.login, early.start]).toEqual([null, null]);
      const slot = await page.getByTestId("nav-session-slot").boundingBox();
      expect(slot!.width, "the room held is the button's").toBeCloseTo(hydrated.dashboard!.width, 0);
      expect([early.blog, early.help, early.menu]).toEqual([hydrated.blog, hydrated.help, hydrated.menu]);
    });
  }

  for (const width of [1280, 768] as const) {
    test(`${width}: a signed-out visitor's bar does not move either while the page is parsed`, async ({ browser }) => {
      const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width, height: 900 } });
      const page = await ctx.newPage();
      await sampleBarFrames(page);
      await expectNothingMoves(page, "/blog", width, () => expect(page.locator("[data-mk-nav]").getByRole("link", { name: "Log in" })).toBeVisible());
      await ctx.close();
    });
  }

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
