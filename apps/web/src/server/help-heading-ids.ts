// Heading ids for help articles, so `[text](#section)` and `/help/a/b#section`
// land somewhere. The renderer's sanitiser strips every `id`, so ids are NOT an
// author feature: this rehype step runs AFTER sanitising and writes an id on
// h2 and h3 only, derived from the heading's own text. Nothing an author types
// (raw HTML, attributes) can name an id, and no other element ever gets one.
//
// CLOBBERING. Ids carry no prefix, because authors link to them as written
// (`#the-platform-fee`). A bare id can shadow a window global only for names the
// window does not already own (named access never overrides a built-in), and only
// code that reads an undeclared global would see it; help pages ship no script
// that does. The sanitiser's `user-content-` prefix is therefore not applied.
//
// Pure and dependency-free (no slug package is installed, and the hast walk is
// twelve lines). The same walk that assigns the ids also records the heading list
// (depth, text, id) on the file's data, so a table of contents reads ONE source
// (helpHeadings in help-content.ts), never a second regex over the rendered HTML.
import type { Element, Root } from "hast";

const HEADING_TAGS = new Set(["h2", "h3"]);

/** One h2/h3 of an article, as the renderer sees it. */
export interface HelpHeading {
  depth: 2 | 3;
  /** Visible text (code, emphasis and link text flattened). */
  text: string;
  /** The id the rendered heading carries; what `#anchor` links point at. */
  id: string;
}

/** Concatenated text of a hast node (code, emphasis and link text included). */
function textOf(node: Root | Element | { type: string; value?: string; children?: unknown[] }): string {
  if (node.type === "text") return (node as { value: string }).value;
  const children = (node as { children?: unknown[] }).children;
  if (!children) return "";
  return children.map((c) => textOf(c as Element)).join("");
}

/**
 * Heading text → id: lower-case; apostrophes (straight and curly) are dropped so a
 * contraction stays one word ("Don't" is `dont`, not `don-t`); letters, digits, `_`
 * and `-` kept; everything else (punctuation, emoji, markup already flattened to text)
 * becomes a break; breaks collapse to one hyphen and edge hyphens go.
 * "5. Disputes & chargebacks" is `5-disputes-chargebacks`. A heading with nothing
 * sluggable is `section`.
 */
export function slugifyHeading(text: string): string {
  const slug = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['\u2018\u2019]/g, "")
    .replace(/[^\p{L}\p{N}\p{M}_-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

function walk(node: Root | Element, seen: Set<string>, out: HelpHeading[]): void {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (HEADING_TAGS.has(child.tagName)) {
      const base = slugifyHeading(textOf(child));
      // Repeats within one article: x, x-2, x-3. The loop also steps over a
      // generated id that happens to equal a later heading's own slug.
      let id = base;
      for (let n = 2; seen.has(id); n += 1) id = `${base}-${n}`;
      seen.add(id);
      child.properties = { ...child.properties, id };
      out.push({ depth: child.tagName === "h2" ? 2 : 3, text: textOf(child), id });
    }
    walk(child, seen, out);
  }
}

/** rehype plugin: stable ids on h2/h3, in document order; the list is left on `file.data.helpHeadings`. */
export function rehypeHelpHeadingIds() {
  return (tree: Root, file: { data: Record<string, unknown> }): void => {
    const headings: HelpHeading[] = [];
    walk(tree, new Set(), headings);
    file.data.helpHeadings = headings;
  };
}
