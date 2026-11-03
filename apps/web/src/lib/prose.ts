// Markdown → sanitized HTML — THE one pipeline for organiser-authored prose
// (v3/06 §2). Deliberately isomorphic (no "server-only"): the editor's
// Preview tab runs this exact function in the browser, so preview === public
// render by construction, org branding included (both sit inside the same
// --ps-* themed subtree).
//
// Restricted grammar: h2/h3, bold/italic, lists, links, images, blockquote,
// divider. Raw HTML never survives — remark parses it to `html` nodes that
// remark-rehype drops (no allowDangerousHtml), and rehype-sanitize is belt
// and braces on the element level.
//
// Sponsor/CTA button (v3/06 §2): a paragraph that is ONLY a bold link —
// **[Label](https://…)** — renders as a branded button. Chosen over a custom
// directive so the stored Markdown stays portable (round-trips through any
// Markdown tool, degrades to a bold link in emails/exports).
// The other nesting, [**Label**](https://…), is the same button (PEF round 2,
// 2026-11-03): the editor's Button tool wrote it (TipTap ranks the link mark
// outside bold), so descriptions saved that way render right with no data
// migration. `ctaParts` is the ONE rule for both nestings, read by the
// renderer here and by `canonicalCtaMarkdown`, which the editor runs on every
// change so what it stores is the documented shape. Safety is unchanged and
// shared: the sanitizer below runs after the button step, whichever nesting.
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Options as SanitizeSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import type { Element, Root as HastRoot } from "hast";

export const DESCRIPTION_MAX = 20_000;

const SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    "h2", "h3", "p", "strong", "em", "ul", "ol", "li",
    "a", "img", "blockquote", "hr", "br", "del",
  ],
  attributes: {
    a: [["className", "prose-cta"], "href", "title"],
    img: ["src", "alt", "title"],
    "*": [],
  },
  protocols: { href: ["http", "https", "mailto"], src: ["http", "https"] },
};

/** The node shape both syntax trees share — Markdown (mdast) and HTML (hast). */
interface CtaNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: CtaNode[];
}

/** How one tree spells a paragraph, a link and bold. */
interface CtaGrammar {
  paragraph(n: CtaNode): boolean;
  link(n: CtaNode): boolean;
  bold(n: CtaNode): boolean;
}

const HTML_GRAMMAR: CtaGrammar = {
  paragraph: (n) => n.type === "element" && n.tagName === "p",
  link: (n) => n.type === "element" && n.tagName === "a",
  bold: (n) => n.type === "element" && n.tagName === "strong",
};

const MD_GRAMMAR: CtaGrammar = {
  paragraph: (n) => n.type === "paragraph",
  link: (n) => n.type === "link",
  bold: (n) => n.type === "strong",
};

/**
 * THE sponsor-button rule: a paragraph whose only content is a bold link, in either nesting — bold around the link
 * (`**[Label](url)**`, the documented shape) or the link around bold (`[**Label**](url)`). Exactly one element inside
 * the outer one, so `[**Label** today](url)` or `**Book [here](url)**` stay ordinary bold links. `null` when the
 * paragraph is not a button.
 */
function ctaParts<N extends CtaNode>(
  p: N,
  g: CtaGrammar,
): { link: N; bold: N; boldOutside: boolean } | null {
  if (!g.paragraph(p)) return null;
  const kids = (p.children ?? []).filter((c) => !(c.type === "text" && (c.value ?? "").trim() === ""));
  const only = kids.length === 1 ? kids[0] : undefined;
  const inner = only?.children?.length === 1 ? only.children[0] : undefined;
  if (!only || !inner) return null;
  if (g.bold(only) && g.link(inner)) return { link: inner as N, bold: only as N, boldOutside: true };
  if (g.link(only) && g.bold(inner)) return { link: only as N, bold: inner as N, boldOutside: false };
  return null;
}

/** Paragraph that is exactly one bold link (either nesting) → the branded CTA button. */
function ctaButtons() {
  return (tree: HastRoot) => {
    for (const node of tree.children) {
      if (node.type !== "element") continue;
      const cta = ctaParts<Element>(node, HTML_GRAMMAR);
      if (!cta) continue;
      const { link, bold, boldOutside } = cta;
      // The button is the link, holding the label itself: drop the bold, whichever side of the link it sat on.
      if (!boldOutside) link.children = bold.children;
      link.properties = { ...link.properties, className: ["prose-cta"] };
      node.children = [link];
    }
  };
}

const pipeline = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(ctaButtons)
  .use(rehypeSanitize, SCHEMA)
  .use(rehypeStringify);

/**
 * Render organiser Markdown to safe HTML. Empty/whitespace input → "".
 * `maxChars` (default {@link DESCRIPTION_MAX}, the description boxes' cap) is the
 * longest input drawn; a surface whose own store allows more (a news post body)
 * passes its bound so nothing it saved is cut.
 */
export async function renderProse(
  markdown: string | null | undefined,
  { maxChars = DESCRIPTION_MAX }: { maxChars?: number } = {},
): Promise<string> {
  const src = (markdown ?? "").slice(0, maxChars);
  if (!src.trim()) return "";
  const file = await pipeline.process(src);
  return String(file);
}

const markdownParser = unified().use(remarkParse).use(remarkGfm);

type Positioned = CtaNode & { position?: { start: { offset?: number }; end: { offset?: number } } };

/**
 * The editor's output in the shape this file documents: every sponsor button written `[**Label**](url)` becomes
 * `**[Label](url)**`. Only those spans move — every other byte, and the length, stay the same — and the result draws
 * exactly what the input drew (the renderer reads both nestings as the button). Idempotent; a paragraph that is not a
 * button by {@link ctaParts}, or one written any way this cannot rewrite in place, is left alone.
 */
export function canonicalCtaMarkdown(md: string): string {
  if (!md.includes("[**")) return md;
  const tree = markdownParser.parse(md) as unknown as { children: Positioned[] };
  const edits: { from: number; to: number; text: string }[] = [];
  for (const node of tree.children) {
    const cta = ctaParts<Positioned>(node, MD_GRAMMAR);
    if (!cta || cta.boldOutside) continue;
    const ls = cta.link.position?.start.offset;
    const le = cta.link.position?.end.offset;
    const bs = cta.bold.position?.start.offset;
    const be = cta.bold.position?.end.offset;
    if (ls === undefined || le === undefined || bs === undefined || be === undefined) continue;
    // In place only when the source is literally `[**…**](…)`: the bold opens right after the bracket and closes
    // right before it, with `**` on both sides.
    if (bs !== ls + 1 || md[ls] !== "[" || md[be] !== "]") continue;
    if (md.slice(bs, bs + 2) !== "**" || md.slice(be - 2, be) !== "**" || be - bs < 5) continue;
    edits.push({ from: ls, to: le, text: `**[${md.slice(bs + 2, be - 2)}${md.slice(be, le)}**` });
  }
  let out = md;
  for (const e of edits.reverse()) out = out.slice(0, e.from) + e.text + out.slice(e.to);
  return out;
}
