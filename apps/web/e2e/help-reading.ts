// What both help specs (1280 here, the seven widths in e2e/mobile/help.spec.ts) check about the reading style on an
// article: which parts are drawn in the serif, which stay as they were, and that nothing runs past the reading column.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { SERIF, style } from "./reading-font";

/** One callout, a quote without a label, lists, a table and pictures (content/help/scheduling/ai-several-divisions.md). */
export const QUOTE_AND_CALLOUT = "/help/scheduling/ai-several-divisions";
/** Sub-headings, inline code and a code block (content/help/divisions/groups-to-knockout.md). */
export const CODE_AND_H3 = "/help/divisions/groups-to-knockout";

/** A table (content/help/registration/card-payments.md). */
export const TABLE = "/help/registration/card-payments";

/** Body text: a paragraph, a list item and a quote's paragraph, each OUTSIDE a callout. */
export const BODY = {
  paragraph: ".reading-prose > p",
  item: ".reading-prose li:not(.help-callout li)",
  quote: ".reading-prose blockquote > p",
} as const;

/** The size the approved style gives at a viewport width: 20px, and 18px below 600. Typed from the style. */
export const bodyPx = (width: number) => (width < 600 ? 18 : 20);

/** Parts of an article that are NOT body text, with the page each is found on. */
export const SANS: { path: string; selectors: string[] }[] = [
  {
    path: QUOTE_AND_CALLOUT,
    selectors: [
      "main article h1",
      "main article header p",
      'main article nav[aria-label="Breadcrumb"] a',
      ".reading-prose h2",
      ".reading-prose .help-callout p",
      ".reading-prose .help-callout > p:first-child > strong",
      ".reading-prose figcaption",
      'input[type="search"]',
      'main article footer nav[aria-label="Previous and next"] a span',
    ],
  },
  { path: TABLE, selectors: [".reading-prose th", ".reading-prose td"] },
  { path: CODE_AND_H3, selectors: [".reading-prose h3", ".reading-prose pre", ".reading-prose pre code", ".reading-prose p code, .reading-prose li code"] },
];

/** Every article's path, from the disk. */
export function helpArticlePaths(): string[] {
  const root = join(process.cwd(), "content", "help");
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(join(root, d.name)).filter((f) => f.endsWith(".md")).map((f) => `/help/${d.name}/${f.replace(/\.md$/, "")}`));
}

/** The body text on this page: the serif at this width's size, at 1.6, #242424. Returns how many kinds were read. */
export async function expectBodyType(page: Page, width: number, kinds: (keyof typeof BODY)[]): Promise<number> {
  let checked = 0;
  for (const kind of kinds) {
    const selector = BODY[kind];
    await expect(page.locator(selector).first(), `anti-vacuity: ${kind}`).toBeAttached();
    const s = await style(page, selector);
    expect(s.size, `${kind} size at ${width}`).toBe(`${bodyPx(width)}px`);
    expect(Math.abs(s.line - bodyPx(width) * 1.6), `${kind} line height ${s.line}`).toBeLessThan(0.5);
    expect(s.family.split(",")[0], kind).toMatch(SERIF);
    expect(s.color, kind).toBe("rgb(36, 36, 36)");
    checked++;
  }
  return checked;
}

/**
 * What runs past the reading column: any element of the header or the body whose right edge is beyond it, and any text
 * block whose own text is wider than its box (a long word overflows without moving the box). The two prose scrollers, a
 * code block and a table's wrapper, are the boxes that may hold wider content; what is inside them is not measured.
 */
export async function readingOverflow(page: Page): Promise<{ checked: number; over: string[] }> {
  return page.evaluate(() => {
    const prose = document.querySelector<HTMLElement>(".reading-prose");
    const header = document.querySelector<HTMLElement>("main article header");
    if (!prose || !header) return { checked: 0, over: ["no reading prose or header on this page"] };
    const right = Math.min(prose.getBoundingClientRect().right, document.documentElement.clientWidth);
    const over: string[] = [];
    let checked = 0;
    const name = (el: Element) => `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 50)}"`;
    for (const el of [header, ...header.querySelectorAll<HTMLElement>("*"), prose, ...prose.querySelectorAll<HTMLElement>("*")]) {
      if (el.parentElement?.closest(".help-scroll, pre")) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0) continue;
      checked++;
      if (box.right > right + 1) over.push(`${name(el)} ends ${Math.round(box.right - right)}px past the column`);
      if (el.matches("h1, h2, h3, p, li, blockquote, figcaption, .help-callout") && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
        over.push(`${name(el)} text is ${el.scrollWidth - el.clientWidth}px wider than its box`);
      }
    }
    return { checked, over };
  });
}

/** The column a blog post and a help page share: 680px, centred, inside the page's 16px gutters. Typed from the layout. */
export const COLUMN_PX = 680;
export const columnWidth = (viewport: number) => Math.min(COLUMN_PX, viewport - 32);

/** What the frame's two side menus drew, at any width: the lists, their phone toggles and their words. */
export async function expectNoSideMenus(page: Page): Promise<void> {
  await expect(page.locator('nav[aria-label="Help sections"], nav[aria-label="On this page"], [data-testid="help-sections"], [data-testid="help-toc"], main aside')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Help sections|On this page)/ })).toHaveCount(0);
  await expect(page.getByText("On this page", { exact: true })).toHaveCount(0);
}

/** Each of `parts` is exactly the shared column: its width, centred in the window. Returns how many were measured. */
export async function expectOneColumn(page: Page, parts: string[]): Promise<number> {
  const viewport = await page.evaluate(() => document.documentElement.clientWidth);
  const width = columnWidth(viewport);
  let checked = 0;
  for (const selector of parts) {
    await expect(page.locator(selector), `anti-vacuity: one ${selector}`).toHaveCount(1);
    const box = (await page.locator(selector).boundingBox())!;
    expect(Math.abs(box.width - width), `${selector}: ${box.width}px wide, the column is ${width}px at ${viewport}`).toBeLessThanOrEqual(1);
    expect(Math.abs(box.x - (viewport - width) / 2), `${selector}: left edge ${box.x}px, centred is ${(viewport - width) / 2}px`).toBeLessThanOrEqual(1);
    checked++;
  }
  return checked;
}

/** An article's parts that must each be the column. */
export const ARTICLE_PARTS = ['[role="search"]', "main article header", ".reading-prose", "main article footer"];

/** Every link in an article that lands on ANOTHER article's heading (`/help/a/b#section`), read from the Markdown. */
export function helpAnchorLinks(): { from: string; to: string }[] {
  const root = join(process.cwd(), "content", "help");
  return helpArticlePaths().flatMap((from) =>
    [...readFileSync(join(root, `${from.slice("/help/".length)}.md`), "utf8").matchAll(/\]\((\/help\/[a-z0-9/-]+#[a-z0-9-]+)\)/g)].map((m) => ({ from, to: m[1]! })),
  );
}

/**
 * Open each anchor link from its own article, as a reader does, and check the heading is on screen below the sticky site
 * nav. One link per source and target. Returns how many were followed.
 */
export async function followAnchorLinks(page: Page, links: { from: string; to: string }[], visit: (path: string) => Promise<void>): Promise<number> {
  let followed = 0;
  for (const { from, to } of [...new Map(links.map((l) => [`${l.from} ${l.to}`, l])).values()]) {
    await visit(from);
    await page.locator(`.help-prose a[href="${to}"]`).first().click();
    await expect(page, `${from} -> ${to}`).toHaveURL((u) => `${u.pathname}${u.hash}` === to);
    const heading = page.locator(`.help-prose [id="${to.split("#")[1]}"]`);
    await expect(heading, `${from} -> ${to}: on screen`).toBeInViewport();
    // Polled: a soft navigation scrolls after the new page is drawn.
    await expect
      .poll(async () => (await heading.evaluate((h) => h.getBoundingClientRect().top)) - (await page.locator("[data-mk-nav]").evaluate((n) => n.getBoundingClientRect().bottom)), { message: `${from} -> ${to}: below the sticky nav` })
      .toBeGreaterThanOrEqual(0);
    followed++;
  }
  return followed;
}
