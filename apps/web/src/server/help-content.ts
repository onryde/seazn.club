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
import { rehypeHelpCallouts } from "@/server/help-callouts";
import type { HelpSectionEntry } from "@/lib/help";

export const HELP_ROOT = join(process.cwd(), "content", "help");

// Section order = the product's own hierarchy (v3/06 §3). `blurb` is the line under the section's
// card on the help home: what its pages cover, in the pages' own words. Every folder under
// content/help needs an entry here, or its pages are missing from the section list (the template
// test, app/help/__tests__/help-template.test.tsx, pins that against the folders on disk).
export const HELP_SECTIONS: { key: string; label: string; blurb: string }[] = [
  { key: "getting-started", label: "Getting started", blurb: "Set up an organisation, a competition and its first fixtures" },
  { key: "formats", label: "Formats", blurb: "League, knockout, groups, swiss and more, each with a diagram and an example" },
  { key: "entrants", label: "Entrants & clubs", blurb: "Teams, pairs, withdrawals and duplicate players" },
  { key: "players", label: "Players", blurb: "Player profiles, stats, match reports and duplicates" },
  { key: "registration", label: "Registration", blurb: "Sign-up, card entry fees, the waitlist and youth divisions" },
  { key: "scheduling", label: "Scheduling", blurb: "The schedule board, constraints, officials and match day" },
  { key: "scoring", label: "Scoring", blurb: "Scoring a match, fixing a mistake and scoring without signal" },
  { key: "sports", label: "Sports", blurb: "How each sport is scored: badminton, cricket, football, chess and the rest" },
  { key: "divisions", label: "Divisions", blurb: "Settings, stages, the bracket and discipline" },
  { key: "sharing", label: "Sharing & dashboards", blurb: "The public dashboard, embeds, sponsors and news" },
  { key: "directory", label: "Directory", blurb: "Clubs and teams in the directory" },
  { key: "billing", label: "Plans & billing", blurb: "Plans, the Event Pass, credits and add-ons" },
  { key: "api", label: "API & integrations", blurb: "API keys" },
];

export interface HelpArticle {
  /** "getting-started/create-your-organisation" */
  slug: string;
  section: string;
  title: string;
  description: string;
  order: number;
  markdown: string;
  /**
   * Front-matter `related:` — help slugs, comma-separated on ONE line (see parseHelpRelated). Each must be
   * an article or a redirect source (help-related.ts); an empty list shows no Related block.
   */
  related: string[];
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
    // its lazy loading are ours. See help-figures.ts. Callouts likewise (help-callouts.ts): the
    // sanitiser allows no div, role, class or data attribute, so only a labelled blockquote makes one.
    .use(rehypeHelpFigures, { publicRoot })
    .use(rehypeHelpCallouts)
    .use(rehypeHelpHeadingIds)
    .use(rehypeStringify);
}

const pipeline = buildPipeline(HELP_PUBLIC_ROOT);

export interface HelpRenderOptions {
  /** Directory that holds `help/<section>/<file>.webp`; defaults to `public/`. A seam for tests. */
  publicRoot?: string;
}

/** One run of the pipeline: the HTML and the heading list that run wrote into it. */
async function renderHelp(
  markdown: string,
  matrix: MatrixData | undefined,
  options: HelpRenderOptions,
): Promise<{ html: string; headings: HelpHeading[] }> {
  const resolved = matrix ? resolveHelpTokens(markdown, matrix) : markdown;
  const run = options.publicRoot ? buildPipeline(options.publicRoot) : pipeline;
  const file = await run.process(resolved);
  const headings = file.data.helpHeadings;
  // The heading step always sets this; a pipeline that stops doing so must fail loudly, not return [].
  if (!Array.isArray(headings)) throw new Error("help renderer did not report headings (rehypeHelpHeadingIds missing from the pipeline?)");
  return { html: String(file), headings: headings as HelpHeading[] };
}

/**
 * Plan tokens (`{{plan:<feature>:<plan>}}`, help-tokens.ts) resolve when the
 * already-loaded plan matrix is passed; without one they are left as written.
 * The matrix is an argument, not loaded here, because loading it is async and
 * needs a database — see renderHelpArticle for when it is loaded.
 */
export async function renderHelpMarkdown(
  markdown: string,
  matrix?: MatrixData,
  options: HelpRenderOptions = {},
): Promise<string> {
  return (await renderHelp(markdown, matrix, options)).html;
}

/**
 * An article's h2/h3 headings (depth, text, id), in document order, from the SAME tree walk
 * that writes the ids into the rendered HTML — there is no second reading to drift from it.
 * Headings cannot carry plan tokens (help-tree-shape pins that), so this needs no matrix.
 */
export async function helpHeadings(markdown: string, options: HelpRenderOptions = {}): Promise<HelpHeading[]> {
  return (await renderHelp(markdown, undefined, options)).headings;
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
export async function renderHelpArticle(
  article: Pick<HelpArticle, "markdown">,
  loadMatrix: () => Promise<MatrixData>,
): Promise<{ html: string; headings: HelpHeading[] }> {
  if (!hasHelpTokens(article.markdown)) return renderHelp(article.markdown, undefined, {});
  return renderHelp(article.markdown, await loadMatrix(), {});
}

/** renderHelpArticle's HTML alone. */
export async function renderHelpArticleHtml(
  article: Pick<HelpArticle, "markdown">,
  loadMatrix: () => Promise<MatrixData>,
): Promise<string> {
  return (await renderHelpArticle(article, loadMatrix)).html;
}

/** Slugs safe to prerender at build: those that need no plan table. */
export function staticHelpSlugs(articles: Iterable<Pick<HelpArticle, "slug" | "markdown">>): string[] {
  return [...articles].filter((a) => !hasHelpTokens(a.markdown)).map((a) => a.slug);
}

/**
 * Minimal frontmatter: `---\nkey: value\n---` — deliberate, no dependency. One `key: value` per
 * line; a YAML list item (a line starting with `-`) is refused rather than silently dropped, since
 * `related:` is the field an author would be tempted to write as a list.
 */
export function parseHelpFrontmatter(raw: string, where: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    if (/^\s*-/.test(line)) {
      throw new Error(`${where}: front-matter line '${line.trim()}' is a YAML list item; write lists on one line, e.g. related: section/page, section/other`);
    }
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: raw.slice(m[0].length) };
}

/** `related:`'s value: slugs separated by commas, optionally inside `[` `]`. */
export function parseHelpRelated(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
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
      const { meta, body } = parseHelpFrontmatter(raw, `content/help/${section.name}/${file}`);
      const slug = `${section.name}/${file.replace(/\.md$/, "")}`;
      articles.set(slug, {
        slug,
        section: section.name,
        title: meta.title ?? file.replace(/\.md$/, ""),
        description: meta.description ?? "",
        order: Number(meta.order ?? 99),
        markdown: body,
        related: parseHelpRelated(meta.related ?? ""),
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

export type { HelpSectionEntry } from "@/lib/help";

/**
 * The section list every help page shows (sections as headings, their pages beneath): the Markdown
 * sections in HELP_SECTIONS order, then Formats, whose one page is the generated format gallery
 * (`/help/formats` and its family pages are not Markdown), at the end as before the redesign.
 */
export function helpSectionList(): HelpSectionEntry[] {
  return [
    ...helpNav().map((s) => ({
      key: s.section,
      label: s.label,
      pages: s.articles.map((a) => ({ href: `/help/${a.slug}`, title: a.title })),
    })),
    { key: "formats", label: "Formats", pages: [{ href: "/help/formats", title: "Format gallery" }] },
  ];
}

/** A section's display label (its key when it has none). */
export function helpSectionLabel(key: string): string {
  return HELP_SECTIONS.find((s) => s.key === key)?.label ?? key;
}
