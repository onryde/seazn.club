import "server-only";
// Help centre content layer (v3/06 §3): in-repo Markdown under
// apps/web/content/help/<section>/<article>.md → /help/<section>/<article>.
// No CMS, no sync — versioned with the code it documents; the stale-doc test
// (help-content.test.ts) keeps articles, tips deep-links and the slug
// registry in lib/help.ts agreeing with each other.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Options as SanitizeSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import type { MatrixData } from "@/lib/pricing-matrix";
import { hasHelpTokens, resolveHelpTokens } from "@/server/help-tokens";
import { rehypeHelpHeadingIds, type HelpHeading } from "@/server/help-heading-ids";
import { HELP_PUBLIC_ROOT, rehypeHelpFigures } from "@/server/help-figures";

export const HELP_ROOT = join(process.cwd(), "content", "help");

// Section order = the product's own hierarchy (v3/06 §3).
export const HELP_SECTIONS: { key: string; label: string }[] = [
  { key: "getting-started", label: "Getting started" },
  { key: "formats", label: "Formats" },
  { key: "entrants", label: "Entrants & clubs" },
  { key: "registration", label: "Registration" },
  { key: "scheduling", label: "Scheduling" },
  { key: "scoring", label: "Scoring" },
  { key: "divisions", label: "Divisions" },
  { key: "sharing", label: "Sharing & dashboards" },
  { key: "billing", label: "Plans & billing" },
  { key: "api", label: "API & integrations" },
];

export interface HelpArticle {
  /** "getting-started/create-your-organisation" */
  slug: string;
  section: string;
  title: string;
  description: string;
  order: number;
  markdown: string;
}

// Help prose allows a little more than organiser prose: inline code and
// tables (for shortcut/limit tables), still no raw HTML survivors.
export const HELP_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    "h2", "h3", "p", "strong", "em", "ul", "ol", "li", "a", "img",
    "blockquote", "hr", "br", "del", "code", "pre",
    "table", "thead", "tbody", "tr", "th", "td",
  ],
  attributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title"],
    th: ["align"],
    td: ["align"],
    "*": [],
  },
  // No real protocol is allowed on a picture, so only a scheme-less path survives (an external,
  // javascript: or data: src is removed, and the figure step then refuses the picture). NOT `[]`:
  // hast-util-sanitize reads an empty list as "no restriction", so the list holds one scheme
  // that no URL uses.
  protocols: { href: ["http", "https", "mailto"], src: ["no-remote-src"] },
};

function buildPipeline(publicRoot: string) {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSanitize, HELP_SCHEMA)
    // AFTER the sanitiser, deliberately: HELP_SCHEMA still strips every `id` (so nothing an
    // author writes can name one), and this step then gives h2/h3 their own, derived from the
    // heading text. See help-heading-ids.ts. The figure step is after it for the same reason:
    // an author's image arrives with src/alt/title only, and the figure, its dimensions and
    // its lazy loading are ours. See help-figures.ts.
    .use(rehypeHelpFigures, { publicRoot })
    .use(rehypeHelpHeadingIds)
    .use(rehypeStringify);
}

const pipeline = buildPipeline(HELP_PUBLIC_ROOT);

export interface HelpRenderOptions {
  /** Directory that holds `help/<section>/<file>.webp`; defaults to `public/`. A seam for tests. */
  publicRoot?: string;
}

/**
 * Plan tokens (`{{plan:<feature>:<plan>}}`, help-tokens.ts) resolve when the
 * already-loaded plan matrix is passed; without one they are left as written.
 * The matrix is an argument, not loaded here, because loading it is async and
 * needs a database — see renderHelpArticleHtml for when it is loaded.
 */
export async function renderHelpMarkdown(
  markdown: string,
  matrix?: MatrixData,
  options: HelpRenderOptions = {},
): Promise<string> {
  const resolved = matrix ? resolveHelpTokens(markdown, matrix) : markdown;
  const run = options.publicRoot ? buildPipeline(options.publicRoot) : pipeline;
  return String(await run.process(resolved));
}

/**
 * An article's h2/h3 headings (depth, text, id), in document order, from the SAME tree walk
 * that writes the ids into the rendered HTML — there is no second reading to drift from it.
 * Headings cannot carry plan tokens (help-tree-shape pins that), so this needs no matrix.
 */
export async function helpHeadings(markdown: string, options: HelpRenderOptions = {}): Promise<HelpHeading[]> {
  const run = options.publicRoot ? buildPipeline(options.publicRoot) : pipeline;
  const headings = (await run.process(markdown)).data.helpHeadings;
  // The heading step always sets this; a pipeline that stops doing so must fail loudly, not return [].
  if (!Array.isArray(headings)) throw new Error("help renderer did not report headings (rehypeHelpHeadingIds missing from the pipeline?)");
  return headings as HelpHeading[];
}

/**
 * FRESHNESS of plan figures in help. The /help routes are ISR
 * (`revalidate = 3600`) and `next build` has no database (the Dockerfile's
 * builder stage and ci.yml's docker build carry no DATABASE_URL), while
 * `loadPricingMatrix` rejects without one. So:
 *  - an article WITHOUT a token never loads the matrix, and is prerendered at
 *    build exactly as before (staticHelpSlugs keeps it);
 *  - an article WITH a token is left out of generateStaticParams, renders on its
 *    first request (a DB exists then), and is regenerated by the route's
 *    `revalidate = 3600`, so a changed fee shows within the hour, no redeploy.
 * A failed matrix load propagates: the page errors rather than print a hole.
 */
export async function renderHelpArticleHtml(
  article: Pick<HelpArticle, "markdown">,
  loadMatrix: () => Promise<MatrixData>,
): Promise<string> {
  if (!hasHelpTokens(article.markdown)) return renderHelpMarkdown(article.markdown);
  return renderHelpMarkdown(article.markdown, await loadMatrix());
}

/** Slugs safe to prerender at build: those that need no plan table. */
export function staticHelpSlugs(articles: Iterable<Pick<HelpArticle, "slug" | "markdown">>): string[] {
  return [...articles].filter((a) => !hasHelpTokens(a.markdown)).map((a) => a.slug);
}

/** Minimal frontmatter: `---\nkey: value\n---` — deliberate, no dependency. */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: raw.slice(m[0].length) };
}

let cache: Map<string, HelpArticle> | null = null;

export function allHelpArticles(): Map<string, HelpArticle> {
  if (cache && process.env.NODE_ENV === "production") return cache;
  const articles = new Map<string, HelpArticle>();
  for (const section of readdirSync(HELP_ROOT, { withFileTypes: true })) {
    if (!section.isDirectory()) continue;
    for (const file of readdirSync(join(HELP_ROOT, section.name))) {
      if (!file.endsWith(".md")) continue;
      const raw = readFileSync(join(HELP_ROOT, section.name, file), "utf8");
      const { meta, body } = parseFrontmatter(raw);
      const slug = `${section.name}/${file.replace(/\.md$/, "")}`;
      articles.set(slug, {
        slug,
        section: section.name,
        title: meta.title ?? file.replace(/\.md$/, ""),
        description: meta.description ?? "",
        order: Number(meta.order ?? 99),
        markdown: body,
      });
    }
  }
  cache = articles;
  return articles;
}

export function helpArticle(slug: string): HelpArticle | null {
  return allHelpArticles().get(slug) ?? null;
}

export function helpNav(): { section: string; label: string; articles: HelpArticle[] }[] {
  const all = [...allHelpArticles().values()];
  return HELP_SECTIONS.map((s) => ({
    section: s.key,
    label: s.label,
    articles: all
      .filter((a) => a.section === s.key)
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)),
  })).filter((s) => s.articles.length > 0);
}

/**
 * Plain text of an article for the search index (strip markdown syntax).
 * Synchronous: plan tokens resolve only when the loaded matrix is passed,
 * otherwise they stay as written (the search-index route passes none).
 */
export function helpPlainText(markdown: string, matrix?: MatrixData): string {
  return (matrix ? resolveHelpTokens(markdown, matrix) : markdown)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
