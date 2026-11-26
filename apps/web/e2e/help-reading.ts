// What both help specs (1280 here, the seven widths in e2e/mobile/help.spec.ts) check about the reading style on an
// article: which parts are drawn in the serif, which stay as they were, and that nothing runs past the reading column.
import { readdirSync } from "node:fs";
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
      '[data-testid="help-toc"] a',
      'nav[aria-label="Help sections"] a',
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
