// The rules CI's blog SEO step holds every post to, as pure functions over fetched text (no network, no fs). The step is
// src/blog/__tests__/blog-seo.live.test.ts: it fetches each post the content loader lists from the production server the
// smoke-e2e job starts, plus /sitemap.xml, /blog/rss.xml and /robots.txt, and hands the answers here.
//
// What a post must have (Blog P2 Task 13b brief; Task 13 measured all 31 posts clean):
//   - HTTP 200 (a redirect is not a 200: the post's own URL must answer);
//   - JSON-LD that parses, with a BlogPosting carrying a non-empty headline, an ISO datePublished, the Organization author
//     "Seazn" (owner ruling 2026-11-19: never a person) and an absolute url equal to the canonical;
//   - exactly one absolute <link rel="canonical"> that names this post's own path, and distinct across posts;
//   - og:title and og:description;
//   - a place in /sitemap.xml and in the RSS feed.
// And robots.txt answers 200 and names the sitemap.
//
// Tags are read with regexes over Next's own serialisation (one tag per element, double-quoted attributes). Attribute order does
// not matter. The tests run it over a real prerendered head, so a change in how Next writes a tag fails there, not silently here.

export interface Fetched {
  status: number;
  body: string;
}

export interface BlogSeoSite {
  /** The posts the loader lists: each one's path (`/blog/<slug>`) and the page its URL answered. */
  posts: readonly { path: string; page: Fetched }[];
  sitemap: Fetched;
  rss: Fetched;
  robots: Fetched;
}

export interface BlogSeoReport {
  /** How many posts were checked: the caller compares it with what the loader listed. */
  posts: number;
  problems: string[];
}

/** The author every post is signed with (owner ruling 2026-11-19). Typed here on purpose: it is the rule, not the product's constant. */
export const EXPECTED_AUTHOR = "Seazn";
const SITEMAP_PATH = "/sitemap.xml";

const ATTR = /([a-zA-Z_:][-\w:.]*)\s*=\s*"([^"]*)"/g;

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR)) out[m[1]!.toLowerCase()] = m[2]!;
  return out;
}

const tagsOf = (html: string, name: "meta" | "link"): Record<string, string>[] =>
  [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((m) => attrsOf(m[0]));

const LD_BLOCK = /<script\b[^>]*\btype="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;

function absoluteUrl(v: unknown): URL | null {
  if (typeof v !== "string" || !/^https?:\/\/[^/\s]+/i.test(v)) return null;
  try {
    return new URL(v);
  } catch {
    return null;
  }
}

/** `2026-11-23`, or a full ISO date-time, and a day that exists (not 2026-13-45, not 2026-02-30). */
export function isIsoDate(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d && !Number.isNaN(Date.parse(v));
}

const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";

/** One post's page: its problems (each prefixed with the path), and the canonical it declares (null unless exactly one absolute one). */
export function blogPostProblems(path: string, page: Fetched): { problems: string[]; canonical: string | null } {
  const problems: string[] = [];
  const bad = (msg: string): void => {
    problems.push(`${path}: ${msg}`);
  };
  if (page.status !== 200) bad(`answered HTTP ${page.status}, not 200`);
  const html = page.body;

  // canonical: exactly one, absolute, and this post's own path.
  const canonicals = tagsOf(html, "link").filter((t) => (t.rel ?? "").toLowerCase().split(/\s+/).includes("canonical"));
  let canonical: string | null = null;
  if (canonicals.length === 0) bad("no <link rel=\"canonical\">");
  else if (canonicals.length > 1) bad(`${canonicals.length} <link rel="canonical"> tags, expected one`);
  else {
    const u = absoluteUrl(canonicals[0]!.href);
    if (!u) bad(`canonical '${canonicals[0]!.href ?? ""}' is not an absolute URL`);
    else {
      // Kept even when it names another post: two posts pointing at one canonical is its own fault (distinctness, below).
      canonical = u.href;
      if (u.pathname !== path) bad(`canonical '${u.href}' does not name this post (path ${u.pathname})`);
    }
  }

  // og:title and og:description
  const metas = tagsOf(html, "meta");
  for (const key of ["og:title", "og:description"]) {
    const m = metas.find((t) => t.property === key);
    if (!m) bad(`no ${key} meta tag`);
    else if (!nonEmpty(m.content)) bad(`${key} is empty`);
  }

  // JSON-LD: every block parses, and one is the BlogPosting.
  const blocks = [...html.matchAll(LD_BLOCK)].map((m) => m[1]!);
  if (blocks.length === 0) bad("no JSON-LD block");
  const parsed: unknown[] = [];
  blocks.forEach((raw, i) => {
    try {
      parsed.push(JSON.parse(raw));
    } catch (e) {
      bad(`JSON-LD block ${i + 1} does not parse (${(e as Error).message})`);
    }
  });
  const postings = parsed.flat().filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null && (d as { "@type"?: unknown })["@type"] === "BlogPosting");
  if (blocks.length > 0 && parsed.length === blocks.length && postings.length !== 1) bad(`${postings.length} BlogPosting JSON-LD objects, expected one`);
  const post = postings[0];
  if (post) {
    if (!nonEmpty(post.headline)) bad("BlogPosting headline is empty or missing");
    if (!isIsoDate(post.datePublished)) bad(`BlogPosting datePublished '${String(post.datePublished)}' is not an ISO date`);
    const author = post.author as { "@type"?: unknown; name?: unknown } | undefined;
    if (!author || author["@type"] !== "Organization" || author.name !== EXPECTED_AUTHOR) {
      bad(`BlogPosting author is not the Organization "${EXPECTED_AUTHOR}" (${JSON.stringify(post.author) ?? "missing"})`);
    }
    const url = absoluteUrl(post.url);
    if (!url) bad(`BlogPosting url '${String(post.url)}' is not an absolute URL`);
    else if (canonical !== null && url.href !== canonical) bad(`BlogPosting url '${url.href}' is not the canonical '${canonical}'`);
  }
  return { problems, canonical };
}

const decodeXml = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function pathsOf(urls: Iterable<string>): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    const u = absoluteUrl(decodeXml(raw).trim());
    if (u) out.push(u.pathname);
  }
  return out;
}

/** The path of every `<loc>` in a sitemap. */
export function sitemapPaths(xml: string): string[] {
  return pathsOf([...xml.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/g)].map((m) => m[1]!));
}

/** The path of every item's `<link>` in an RSS feed. */
export function rssPaths(xml: string): string[] {
  return pathsOf(
    [...xml.matchAll(/<item\b[\s\S]*?<\/item>/g)].map((m) => /<link>\s*([^<]*?)\s*<\/link>/.exec(m[0])?.[1] ?? ""),
  );
}

/** The path of every `Sitemap:` line in a robots.txt. */
export function robotsSitemapPaths(text: string): string[] {
  return pathsOf([...text.matchAll(/^\s*sitemap\s*:\s*(\S+)\s*$/gim)].map((m) => m[1]!));
}

export function checkBlogSeo(site: BlogSeoSite): BlogSeoReport {
  const problems: string[] = [];
  if (site.posts.length === 0) problems.push("no posts to check: the content loader listed none, so nothing was verified");

  const byCanonical = new Map<string, string[]>();
  for (const p of site.posts) {
    const r = blogPostProblems(p.path, p.page);
    problems.push(...r.problems);
    if (r.canonical !== null) byCanonical.set(r.canonical, [...(byCanonical.get(r.canonical) ?? []), p.path]);
  }
  for (const [canonical, paths] of byCanonical) {
    if (paths.length > 1) problems.push(`canonical ${canonical} is shared by ${paths.join(", ")}: it must be distinct per post`);
  }

  const listed = (label: string, f: Fetched, paths: (body: string) => string[], unit: string): void => {
    if (f.status !== 200) {
      problems.push(`${label} answered HTTP ${f.status}, not 200`);
      return;
    }
    const have = new Set(paths(f.body));
    if (have.size === 0) problems.push(`${label} lists no ${unit} at all`);
    else for (const p of site.posts) if (!have.has(p.path)) problems.push(`${p.path}: missing from ${label}`);
  };
  listed("/sitemap.xml", site.sitemap, sitemapPaths, "URLs");
  listed("the RSS feed (/blog/rss.xml)", site.rss, rssPaths, "items");

  if (site.robots.status !== 200) problems.push(`robots.txt answered HTTP ${site.robots.status}, not 200`);
  else if (!robotsSitemapPaths(site.robots.body).includes(SITEMAP_PATH)) problems.push(`robots.txt names no Sitemap: line for ${SITEMAP_PATH}`);

  return { posts: site.posts.length, problems };
}
