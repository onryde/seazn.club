import "server-only";
// Blog content layer: in-repo Markdown under apps/web/content/blog/<slug>.md → /blog/<slug>.
// Flat, one file per post, the file name is the slug. The front-matter is read by P1's parser (help-content.ts
// parseHelpFrontmatter / parseHelpRelated: one `key: value` per line, a YAML list throws) and THIS file only
// validates it: every rule in the design's front-matter table, collected per post so one error names the file
// and EVERY key that is wrong, not just the first.
//
// A post is checked in two scopes. parseBlogFrontmatter sees one file: its own keys, the sport registry, the
// help tree, its body's example and plan tokens, typed plan figures. blogRelatedProblems sees the whole set:
// each `related` slug must be another post. allBlogPosts runs both and throws on any problem.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { builtinModules } from "@seazn/engine/sports";
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import { helpUrl } from "@/lib/help";
import {
  BLOG_AUTHOR, BLOG_DESCRIPTION_MAX, BLOG_DESCRIPTION_MIN, BLOG_HELP_MAX, BLOG_SLUG, BLOG_TOPICS,
  type BlogPostMeta, type BlogTopic,
} from "@/lib/blog";
import type { HelpSearchRow } from "@/lib/help-search";
import {
  allHelpArticles, helpHeadings, parseHelpFrontmatter, parseHelpRelated,
} from "@/server/help-content";

export const BLOG_ROOT = join(process.cwd(), "content", "blog");

export type BlogPost = BlogPostMeta & { markdown: string };

/**
 * The approved topic list's slugs (design, "The first topic list") that are not written yet. A `related` link may
 * name one while the programme is being written; the DEFAULT root accepts them, an explicit root (the fixtures)
 * never does. The list shrinks as posts land: blog-tree.test.ts fails on an entry that is now a post, and the
 * pages that print related links must show only the slugs `blogPost()` resolves. It is deleted with the last batch.
 */
export const BLOG_PLANNED_SLUGS: ReadonlySet<string> = new Set([
  "shootout-win-league-points",
  "cricket-points-ties-no-results",
  "chess-points-and-half-points",
  "why-matches-won-come-first",
  "table-tennis-loss-still-scores",
  "level-on-points-who-finishes-higher",
  "three-way-tie-head-to-head",
  "net-run-rate-explained",
  "set-ratio-or-set-difference",
  "buchholz-and-sonneborn-berger",
  "when-lots-decide-a-tie",
  "how-swiss-pairing-works",
  "swiss-chess-bye",
  "joining-or-leaving-a-swiss",
  "knockout-seeds-and-byes",
  "page-playoff-and-stepladder",
  "double-elimination-explained",
  "what-is-a-plate",
  "how-americano-works",
  "how-mexicano-works",
  "how-a-ladder-works",
  "withdrawal-in-a-knockout",
  "forfeits-and-walkovers-by-sport",
  "double-walkover",
  "round-robin-schedule",
  "groups-into-knockout",
  "best-third-placed-teams",
  "clinched-or-eliminated",
  "withdrawal-in-a-league",
  "joining-a-league-late",
]);

/**
 * The link to a post's help page, or null when the page is not registered (never a dead link). The page that
 * prints "How Seazn handles it" renders the link only for a non-null answer.
 */
export function blogHelpHref(help: string): string | null {
  return helpUrl(help);
}

export interface BlogProblem {
  /** The front-matter key, or `body` for a problem in the post text. */
  key: string;
  message: string;
}

/** Thrown by parseBlogFrontmatter: names the file, and carries every problem found in it. */
export class BlogFrontmatterError extends Error {
  constructor(
    readonly where: string,
    readonly problems: BlogProblem[],
  ) {
    super(`${where}: ${problems.map((p) => `'${p.key}': ${p.message}`).join("; ")}`);
    this.name = "BlogFrontmatterError";
  }
}

export interface BlogParseOptions {
  /** "Today" as ISO `YYYY-MM-DD` (UTC); a date after it is in the future. A seam for tests. */
  today?: string;
}

// The two patterns below are P1's typed-plan-figure detector, held here because P1 keeps them private to its
// sweep test (lib/__tests__/help-no-typed-plan-figures.test.ts). blog-content.test.ts reads that file and fails
// if either literal drifts, so the two copies cannot disagree unnoticed.
export const TYPED_FIGURE = /\d+(?:\.\d+)?\s?%|[$£€]\s?\d/;
export const PLAN_WORD = /\b(?:Community|Event Pass|Pro|Enterprise)\b|platform fee/i;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXAMPLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXAMPLE_LINE = /^\{\{example:([a-z0-9-]+)\}\}$/;
const FACT_TOKEN = /\{\{fact:[a-z0-9-]+\.[A-Za-z0-9_]+\}\}/g;

/** A real calendar date in ISO form (2026-02-30 is not one). */
function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const SPORT_KEYS: ReadonlySet<string> = new Set(builtinModules.map((m) => m.key));

/** True when `help` names a help article that exists, or a format family page. */
function helpResolves(help: string): boolean {
  if (help === "formats/overview") return true;
  if (help.startsWith("formats/")) return FORMAT_FAMILIES.some((f) => `formats/${f.slug}` === help);
  return allHelpArticles().has(help);
}

function bodyProblems(body: string, examples: string[]): BlogProblem[] {
  const problems: BlogProblem[] = [];
  const lines = body.split("\n");

  // Example tokens: alone on their own line, each declared id exactly once, no undeclared id.
  const used: string[] = [];
  lines.forEach((line, i) => {
    const m = EXAMPLE_LINE.exec(line.trim());
    if (m) used.push(m[1]!);
    else if (line.includes("{{example:")) {
      problems.push({ key: "body", message: `line ${i + 1}: an example token must stand alone on its own line` });
    }
  });
  for (const id of new Set(used)) {
    if (used.filter((u) => u === id).length > 1) problems.push({ key: "examples", message: `example '${id}' is placed more than once` });
    if (!examples.includes(id)) problems.push({ key: "examples", message: `the body uses example '${id}', which 'examples' does not list` });
  }
  for (const id of examples) {
    if (!used.includes(id)) problems.push({ key: "examples", message: `example '${id}' is listed but the body never places it` });
  }

  // Plan tokens never belong in a post (a post states no plan figure); any other brace pair is a hole.
  if (body.includes("{{plan:")) problems.push({ key: "body", message: "a {{plan:...}} token: a post states no plan figure, link the help page instead" });
  const rest = lines
    .filter((l) => !EXAMPLE_LINE.test(l.trim()))
    .join("\n")
    .replace(FACT_TOKEN, "")
    .replace(/\{\{plan:[^}]*\}\}/g, "")
    // An example token that is not alone on its line is already reported above; not a second time here.
    .replace(/\{\{example:[^}]*\}\}/g, "");
  const stray = rest.indexOf("{{");
  if (stray !== -1) {
    problems.push({ key: "body", message: `'${rest.slice(stray, stray + 40)}' is not a fact token or an example token` });
  }

  // Posts are for organisers and carry no code: a fenced block would also show a reader what the leak scan skips.
  const fence = lines.findIndex((line) => /^\s{0,3}(?:```|~~~)/.test(line));
  if (fence !== -1) problems.push({ key: "body", message: `line ${fence + 1}: a fenced code block; posts carry no code` });

  // A fact token in a heading would ship raw into the contents list and the search index.
  lines.forEach((line, i) => {
    if (/^#{1,6}\s/.test(line) && line.includes("{{")) {
      problems.push({ key: "body", message: `line ${i + 1}: a heading carries a token; headings are plain text` });
    }
  });

  return problems;
}

function figureProblems(key: string, text: string): BlogProblem[] {
  const out: BlogProblem[] = [];
  text.split("\n").forEach((line, i) => {
    if (TYPED_FIGURE.test(line) && PLAN_WORD.test(line)) {
      out.push({ key, message: `line ${i + 1} types a plan figure ('${line.trim().slice(0, 60)}'); a post states none, link the help page` });
    }
  });
  return out;
}

/**
 * One post's front-matter and body, validated. `where` names the file in every error and its basename, minus
 * `.md`, is the slug. Throws BlogFrontmatterError listing every problem; P1's parser throws its own error for
 * a YAML list.
 */
export function parseBlogFrontmatter(
  raw: string,
  where: string,
  opts: BlogParseOptions = {},
): BlogPostMeta & { markdown: string } {
  const { meta, body } = parseHelpFrontmatter(raw, where);
  const problems: BlogProblem[] = [];
  const bad = (key: string, message: string) => problems.push({ key, message });
  const need = (key: string): string | null => {
    const v = meta[key];
    if (v === undefined) {
      bad(key, "is required");
      return null;
    }
    return v;
  };

  const slug = basename(where).replace(/\.md$/, "");
  if (!BLOG_SLUG.test(slug)) bad("slug", `the file name '${slug}' must be lowercase words joined by hyphens`);

  const title = need("title");
  if (title !== null) {
    if (!title.endsWith("?")) bad("title", "must be a question and end with '?'");
    if (title.includes("{{")) bad("title", "must not carry a token (front-matter is never resolved)");
    problems.push(...figureProblems("title", title));
  }

  const description = need("description");
  if (description !== null) {
    if (description.length < BLOG_DESCRIPTION_MIN || description.length > BLOG_DESCRIPTION_MAX) {
      bad("description", `must be ${BLOG_DESCRIPTION_MIN} to ${BLOG_DESCRIPTION_MAX} characters, is ${description.length}`);
    }
    if (description.includes("{{")) bad("description", "must not carry a token (front-matter is never resolved)");
    problems.push(...figureProblems("description", description));
  }

  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const date = need("date");
  if (date !== null) {
    if (!isIsoDate(date)) bad("date", `'${date}' is not an ISO date (YYYY-MM-DD)`);
    else if (date > today) bad("date", `'${date}' is in the future (today is ${today}, UTC)`);
  }
  const updated = meta.updated;
  if (updated !== undefined) {
    if (!isIsoDate(updated)) bad("updated", `'${updated}' is not an ISO date (YYYY-MM-DD)`);
    else if (date !== null && isIsoDate(date) && updated < date) bad("updated", `'${updated}' is before 'date' (${date})`);
    else if (updated > today) bad("updated", `'${updated}' is in the future (today is ${today}, UTC)`);
  }

  const author = need("author");
  if (author !== null && author !== BLOG_AUTHOR) bad("author", `must be exactly '${BLOG_AUTHOR}', is '${author}'`);

  const topic = need("topic");
  if (topic !== null && !(BLOG_TOPICS as readonly string[]).includes(topic)) {
    bad("topic", `'${topic}' is not one of: ${BLOG_TOPICS.join(", ")}`);
  }

  const sportsRaw = need("sports");
  let sports: "all" | string[] = "all";
  if (sportsRaw !== null) {
    const keys = parseHelpRelated(sportsRaw);
    if (keys.length === 0) bad("sports", "is empty; write 'all' or sport keys");
    else if (keys.includes("all")) {
      if (keys.length > 1) bad("sports", "'all' must stand alone");
    } else {
      sports = keys;
      for (const k of keys) if (!SPORT_KEYS.has(k)) bad("sports", `'${k}' is not a sport in the registry (${[...SPORT_KEYS].join(", ")})`);
    }
  }

  const help = need("help");
  if (help !== null && !helpResolves(help)) bad("help", `'${help}' is not a help article or a format family page`);

  const relatedRaw = need("related");
  const related = relatedRaw === null ? [] : parseHelpRelated(relatedRaw);
  if (relatedRaw !== null) {
    if (related.length < 2 || related.length > 4) bad("related", `lists ${related.length} posts; it needs 2 to 4`);
    if (related.includes(slug)) bad("related", "lists the post itself");
    if (new Set(related).size !== related.length) bad("related", "lists a post twice");
    for (const r of related) if (!BLOG_SLUG.test(r)) bad("related", `'${r}' is not a post slug`);
  }

  const examplesRaw = need("examples");
  const examples = examplesRaw === null ? [] : parseHelpRelated(examplesRaw);
  if (examplesRaw !== null) {
    if (examples.length === 0) bad("examples", "is empty; every post carries at least one generated example");
    for (const id of examples) if (!EXAMPLE_ID.test(id)) bad("examples", `'${id}' is not an example id`);
    if (new Set(examples).size !== examples.length) bad("examples", "lists an example twice");
  }

  problems.push(...bodyProblems(body, examples));
  problems.push(...figureProblems("body", body));

  if (problems.length > 0) throw new BlogFrontmatterError(where, problems);

  const post: BlogPostMeta & { markdown: string } = {
    slug,
    title: title!,
    description: description!,
    date: date!,
    author: BLOG_AUTHOR,
    topic: topic as BlogTopic,
    sports,
    help: help!,
    related,
    examples,
    markdown: body,
  };
  if (updated !== undefined) post.updated = updated;
  return post;
}

/**
 * Every bad `related` slug across `posts`, one readable line each; empty means sound. A slug in `planned` (a post
 * still to be written, BLOG_PLANNED_SLUGS) is accepted; the post itself never is.
 */
export function blogRelatedProblems(
  posts: ReadonlyMap<string, Pick<BlogPostMeta, "slug" | "related">>,
  planned: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  for (const p of posts.values()) {
    for (const r of p.related) {
      if (r === p.slug) out.push(`${p.slug}: related '${r}' is the post itself`);
      else if (!posts.has(r) && !planned.has(r)) out.push(`${p.slug}: related '${r}' is not a post`);
    }
  }
  return out;
}

/** Newest first; two posts on the same day sort by slug, so the order never depends on how the files were read. */
export const blogNewestFirst = (a: Pick<BlogPostMeta, "date" | "slug">, b: Pick<BlogPostMeta, "date" | "slug">) => (a.date === b.date ? a.slug.localeCompare(b.slug) : a.date < b.date ? 1 : -1);

/**
 * One readable line per help page that more than BLOG_HELP_MAX posts name; empty means sound. The help page lists only
 * the newest few, so a fourth post would be dropped from it silently: refused here, at build, instead.
 */
export function blogHelpCapProblems(posts: readonly Pick<BlogPostMeta, "slug" | "help">[]): string[] {
  const byPage = new Map<string, string[]>();
  for (const p of posts) byPage.set(p.help, [...(byPage.get(p.help) ?? []), p.slug]);
  return [...byPage.entries()]
    .filter(([, slugs]) => slugs.length > BLOG_HELP_MAX)
    .map(([help, slugs]) => `help page '${help}' is named by ${slugs.length} posts (${slugs.join(", ")}); at most ${BLOG_HELP_MAX} per page: point one at another page`);
}

function loadPosts(root: string, opts: BlogParseOptions, planned?: ReadonlySet<string>): BlogPost[] {
  const posts = new Map<string, BlogPost>();
  for (const file of readdirSync(root).filter((f) => f.endsWith(".md")).sort()) {
    const where = relative(process.cwd(), join(root, file));
    const post = parseBlogFrontmatter(readFileSync(join(root, file), "utf8"), where, opts);
    posts.set(post.slug, post);
  }
  const problems = blogRelatedProblems(posts, planned);
  if (problems.length > 0) throw new Error(`blog related: ${problems.join("; ")}`);
  const capped = blogHelpCapProblems([...posts.values()]);
  if (capped.length > 0) throw new Error(`blog help: ${capped.join("; ")}`);
  return [...posts.values()].sort(blogNewestFirst);
}

let cache: BlogPost[] | null = null;

/** Every post, newest first. The default root is cached in production (the content is part of the build). */
export function allBlogPosts(root?: string, opts: BlogParseOptions = {}): BlogPost[] {
  if (root !== undefined) return loadPosts(root, opts);
  if (cache && process.env.NODE_ENV === "production") return cache;
  cache = loadPosts(BLOG_ROOT, opts, BLOG_PLANNED_SLUGS);
  return cache;
}

export function blogPost(slug: string): BlogPost | null {
  return allBlogPosts().find((p) => p.slug === slug) ?? null;
}

/** The posts whose `help:` names `helpSlug` (a help slug or `formats/<family>`), newest first; [] when none does. */
export function blogPostsForHelp(helpSlug: string, posts: readonly BlogPost[] = allBlogPosts()): BlogPost[] {
  return posts.filter((p) => p.help === helpSlug);
}

let indexCache: Promise<HelpSearchRow[]> | null = null;

async function buildIndex(posts: readonly BlogPost[]): Promise<HelpSearchRow[]> {
  return Promise.all(
    posts.map(async (p) => ({
      slug: p.slug,
      title: p.title,
      section: "Blog",
      description: p.description,
      headings: (await helpHeadings(p.markdown)).map((h) => h.text),
    })),
  );
}

/** Search rows shaped like helpSearchIndex's, `section` "Blog". Newest post first. */
export function blogSearchIndex(posts?: readonly BlogPost[]): Promise<HelpSearchRow[]> {
  if (posts !== undefined) return buildIndex(posts);
  if (indexCache && process.env.NODE_ENV === "production") return indexCache;
  indexCache = buildIndex(allBlogPosts());
  indexCache.catch(() => {
    indexCache = null;
  });
  return indexCache;
}
