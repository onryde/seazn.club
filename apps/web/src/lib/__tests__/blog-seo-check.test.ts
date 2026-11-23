// lib/blog-seo-check.ts is the parser behind CI's blog SEO step (src/blog/__tests__/blog-seo.live.test.ts runs it against the
// production server the smoke-e2e job starts). This file is the part that can run anywhere: the rules, over fixture HTML.
//
// The fixture is the REAL head of a prerendered post (Next's own serialisation, Blog P2 Task 13's build of
// /blog/swiss-chess-bye, trimmed to the title, meta, link and ld+json tags), re-pointed at other slugs. The feed comes from the
// real blogRssXml, the JSON-LD escaping from the real serializeJsonLd, and robots.txt's sitemap URL from the real robots(), so
// the parser is proven against what the product writes. The faults are the brief's: every one is a table row, and every row
// must be NAMED in a problem (not merely "something failed").
//
// Single-sport reason: no sport is involved; a post's SEO tags are sport-blind.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import { blogUrl } from "@/lib/blog";
import { blogPostingLd } from "@/lib/blog-seo";
import { blogPostProblems, checkBlogSeo, type BlogSeoSite, type Fetched } from "@/lib/blog-seo-check";
import { serializeJsonLd } from "@/components/seo/json-ld";
import { allBlogPosts } from "@/server/blog-content";
import { blogRssXml } from "@/server/blog-rss";

const REAL = readFileSync(join(import.meta.dirname, "fixtures", "blog-post-real.html"), "utf8");
const REAL_SLUG = "swiss-chess-bye";
const ORIGIN = "https://seazn.club";
const ok = (body: string): Fetched => ({ status: 200, body });

const posts = allBlogPosts().slice(0, 3);
const PATHS = posts.map((p) => blogUrl(p.slug));

/** The real page, re-pointed at `slug` (every URL in it names the slug). */
const pageFor = (slug: string, html = REAL): string => html.split(REAL_SLUG).join(slug);
/** Replace `from` with `to` in `html`, which must hold `from` exactly once: a mutation that misses would test nothing. */
function swap(html: string, from: string | RegExp, to: string): string {
  const n = typeof from === "string" ? html.split(from).length - 1 : (html.match(new RegExp(from, from.flags.includes("g") ? from.flags : `${from.flags}g`)) ?? []).length;
  expect(n, `premise: ${String(from)} occurs once in the fixture`).toBe(1);
  return html.replace(from, to);
}

const sitemapOf = (paths: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
    .map((p) => `<url><loc>${ORIGIN}${p}</loc><lastmod>2026-11-23</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>`)
    .join("")}</urlset>`;
const robotsTxt = (): string => `User-Agent: *\nAllow: /\nDisallow: /o/\n\nSitemap: ${robots().sitemap as string}\n`;

/** A site that passes: the real page for every post, a sitemap and the real feed that list them all, and robots.txt. */
function site(over: Partial<BlogSeoSite> = {}): BlogSeoSite {
  return {
    posts: posts.map((p) => ({ path: blogUrl(p.slug), page: ok(pageFor(p.slug)) })),
    sitemap: ok(sitemapOf(PATHS)),
    rss: ok(blogRssXml(posts, ORIGIN)),
    robots: ok(robotsTxt()),
    ...over,
  };
}
const withPage = (i: number, page: Fetched): BlogSeoSite => {
  const s = site();
  return { ...s, posts: s.posts.map((p, j) => (j === i ? { ...p, page } : p)) };
};

describe("premises: the fixture and the real producers say what the checker will be told", () => {
  it("the real head carries what the brief lists (canonical, og:title, og:description, a BlogPosting)", () => {
    expect(REAL).toContain('rel="canonical"');
    expect(REAL).toContain('property="og:title"');
    expect(REAL).toContain('property="og:description"');
    expect(REAL).toContain('"@type":"BlogPosting"');
    expect(posts.length, "anti-vacuity: the loader gave posts to build a site from").toBe(3);
    expect(new Set(PATHS).size).toBe(3);
  });
});

describe("blogPostProblems: one post's page", () => {
  it("the real prerendered head passes, and answers its canonical", () => {
    const r = blogPostProblems(`/blog/${REAL_SLUG}`, ok(REAL));
    expect(r.problems).toEqual([]);
    expect(r.canonical).toBe(`${ORIGIN}/blog/${REAL_SLUG}`);
  });

  const path = `/blog/${REAL_SLUG}`;
  // [fault, the page with it, a word the problem must carry]
  const faults: [string, Fetched, RegExp][] = [
    ["HTTP 404", { status: 404, body: REAL }, /404/],
    ["HTTP 500", { status: 500, body: REAL }, /500/],
    ["a redirect", { status: 308, body: REAL }, /308/],
    ["no JSON-LD at all", ok(REAL.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "")), /JSON-LD/],
    ["JSON-LD that does not parse", ok(swap(REAL, '{"@context":"https://schema.org","@type":"BlogPosting"', '{"@context":"https://schema.org","@type":"BlogPosting",')), /JSON-LD.*pars|pars.*JSON-LD/i],
    ["no BlogPosting among the JSON-LD", ok(swap(REAL, '"@type":"BlogPosting"', '"@type":"Article"')), /BlogPosting/],
    ["an empty headline", ok(swap(REAL, /"headline":"[^"]*"/, '"headline":""')), /headline/],
    ["a missing headline", ok(swap(REAL, /"headline":"[^"]*",/, "")), /headline/],
    ["datePublished 'yesterday'", ok(swap(REAL, '"datePublished":"2026-11-23"', '"datePublished":"yesterday"')), /datePublished/],
    ["datePublished an impossible date", ok(swap(REAL, '"datePublished":"2026-11-23"', '"datePublished":"2026-13-45"')), /datePublished/],
    // V8's Date.parse rolls 2026-02-30 over to March 2, so only a calendar check can refuse it.
    ["datePublished a day that does not exist (Feb 30)", ok(swap(REAL, '"datePublished":"2026-11-23"', '"datePublished":"2026-02-30"')), /datePublished/],
    ["no datePublished", ok(swap(REAL, '"datePublished":"2026-11-23",', "")), /datePublished/],
    ["a person as the author", ok(swap(REAL, '"author":{"@type":"Organization","name":"Seazn"}', '"author":{"@type":"Person","name":"Seazn"}')), /author/],
    ["another name as the author", ok(swap(REAL, '"author":{"@type":"Organization","name":"Seazn"}', '"author":{"@type":"Organization","name":"Ana"}')), /author/],
    ["no author", ok(swap(REAL, '"author":{"@type":"Organization","name":"Seazn"},', "")), /author/],
    ["a relative BlogPosting url", ok(swap(REAL, `"url":"${ORIGIN}${path}"`, `"url":"${path}"`)), /url/],
    ["no BlogPosting url", ok(swap(REAL, `"url":"${ORIGIN}${path}",`, "")), /url/],
    ["a BlogPosting url that is not the canonical", ok(swap(REAL, `"url":"${ORIGIN}${path}"`, `"url":"${ORIGIN}/blog/other"`)), /canonical/],
    ["no canonical", ok(swap(REAL, `<link rel="canonical" href="${ORIGIN}${path}"/>`, "")), /canonical/],
    ["a relative canonical", ok(swap(REAL, `<link rel="canonical" href="${ORIGIN}${path}"/>`, `<link rel="canonical" href="${path}"/>`)), /canonical/],
    ["two canonicals", ok(swap(REAL, `<link rel="canonical" href="${ORIGIN}${path}"/>`, `<link rel="canonical" href="${ORIGIN}${path}"/><link rel="canonical" href="${ORIGIN}${path}"/>`)), /canonical/],
    // The BlogPosting url follows it, so the url-equals-canonical rule is satisfied and only the own-path rule can refuse it
    // (two guards covering for each other are each untested).
    ["a canonical naming another post (BlogPosting url agrees)", ok(swap(swap(REAL, `<link rel="canonical" href="${ORIGIN}${path}"/>`, `<link rel="canonical" href="${ORIGIN}/blog/other-post"/>`), `"url":"${ORIGIN}${path}"`, `"url":"${ORIGIN}/blog/other-post"`)), /does not name this post/],
    ["no og:title", ok(swap(REAL, /<meta property="og:title" content="[^"]*"\/>/, "")), /og:title/],
    ["an empty og:title", ok(swap(REAL, /<meta property="og:title" content="[^"]*"\/>/, '<meta property="og:title" content=""/>')), /og:title/],
    ["no og:description", ok(swap(REAL, /<meta property="og:description" content="[^"]*"\/>/, "")), /og:description/],
    ["an empty og:description", ok(swap(REAL, /<meta property="og:description" content="[^"]*"\/>/, '<meta property="og:description" content=" "/>')), /og:description/],
  ];

  it.each(faults)("%s fails, and the problem names the path and the fault", (_name, page, word) => {
    const r = blogPostProblems(path, page);
    expect(r.problems.length, "at least one problem").toBeGreaterThan(0);
    expect(r.problems.join("\n")).toContain(path);
    expect(r.problems.join("\n")).toMatch(word);
  });

  it("the table has teeth: more than a dozen faults, each over a page that passes without it", () => {
    expect(faults.length).toBeGreaterThan(12);
    expect(blogPostProblems(path, ok(REAL)).problems).toEqual([]);
  });

  it("reads attributes in any order and any quoting position (a meta whose content comes first)", () => {
    const flipped = REAL.replace(/<meta property="og:title" content="([^"]*)"\/>/, '<meta content="$1" property="og:title"/>')
      .replace(/<link rel="canonical" href="([^"]*)"\/>/, '<link href="$1" rel="canonical"/>');
    expect(flipped).not.toBe(REAL);
    expect(blogPostProblems(path, ok(flipped)).problems).toEqual([]);
  });

  it("reads JSON-LD the way the product serialises it (< escaped as \\u003c), from the real builders", () => {
    const post = { ...posts[0]!, title: "Is a < b the same as b > a?" };
    // siteOrigin() reads the env at the call: pin it to the fixture's origin so a developer's .env.local cannot move the url.
    const prior = process.env.OAUTH_BASE_URL;
    process.env.OAUTH_BASE_URL = ORIGIN;
    let ld: string;
    try {
      ld = serializeJsonLd(blogPostingLd(post));
    } finally {
      if (prior === undefined) delete process.env.OAUTH_BASE_URL;
      else process.env.OAUTH_BASE_URL = prior;
    }
    expect(ld, "premise: the real serialiser escaped the <").toContain("\\u003c");
    const html = REAL.replace(/<script type="application\/ld\+json">\{"@context":"https:\/\/schema.org","@type":"BlogPosting"[\s\S]*?<\/script>/, `<script type="application/ld+json">${ld}</script>`)
      .split(`${ORIGIN}/blog/${REAL_SLUG}`).join(`${ORIGIN}${blogUrl(post.slug)}`);
    expect(html).toContain("\\u003c");
    expect(blogPostProblems(blogUrl(post.slug), ok(html)).problems).toEqual([]);
  });
});

describe("checkBlogSeo: the whole site", () => {
  it("a site of real-shaped pages, a sitemap and feed that list them, and a robots.txt passes, over the posts given", () => {
    const r = checkBlogSeo(site());
    expect(r.problems).toEqual([]);
    expect(r.posts).toBe(3);
  });

  it("zero posts is a failure, not a pass", () => {
    const r = checkBlogSeo(site({ posts: [] }));
    expect(r.posts).toBe(0);
    expect(r.problems.join("\n")).toMatch(/no posts/i);
  });

  it("a broken post fails the site and is named; the others are not blamed", () => {
    const bad = pageFor(posts[1]!.slug, swap(REAL, '"author":{"@type":"Organization","name":"Seazn"}', '"author":{"@type":"Organization","name":"Ana"}'));
    const r = checkBlogSeo(withPage(1, ok(bad)));
    expect(r.problems.length).toBeGreaterThan(0);
    expect(r.problems.every((p) => p.includes(PATHS[1]!))).toBe(true);
  });

  it("two posts that share a canonical fail, and say the canonical is shared", () => {
    const s = withPage(1, ok(pageFor(posts[0]!.slug)));
    const r = checkBlogSeo(s);
    expect(r.problems.join("\n")).toMatch(/canonical.*(shared|same|distinct|duplicate)|(shared|same|distinct|duplicate).*canonical/i);
    expect(r.problems.join("\n")).toContain(PATHS[0]!);
    expect(r.problems.join("\n")).toContain(PATHS[1]!);
  });

  it("a post missing from the sitemap fails, naming it; a sitemap that lists nothing fails", () => {
    const r = checkBlogSeo(site({ sitemap: ok(sitemapOf(PATHS.slice(1))) }));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain(PATHS[0]!);
    expect(r.problems[0]).toContain("sitemap");
    expect(checkBlogSeo(site({ sitemap: ok(sitemapOf([])) })).problems.join("\n")).toMatch(/sitemap.*(no |nothing|empty)/i);
  });

  it("a sitemap that answers 500 fails", () => {
    expect(checkBlogSeo(site({ sitemap: { status: 500, body: sitemapOf(PATHS) } })).problems.join("\n")).toMatch(/sitemap.*500/);
  });

  it("reads a sitemap URL with an XML-escaped query and surrounding whitespace", () => {
    const xml = `<urlset>${PATHS.map((p) => `<url><loc>\n  ${ORIGIN}${p}\n</loc></url>`).join("")}<url><loc>${ORIGIN}/x?a=1&amp;b=2</loc></url></urlset>`;
    expect(checkBlogSeo(site({ sitemap: ok(xml) })).problems).toEqual([]);
  });

  it("a post missing from the feed fails, naming it; a feed with no items fails", () => {
    const r = checkBlogSeo(site({ rss: ok(blogRssXml(posts.slice(1), ORIGIN)) }));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain(PATHS[0]!);
    expect(r.problems[0]).toMatch(/rss|feed/i);
    expect(checkBlogSeo(site({ rss: ok(blogRssXml([], ORIGIN)) })).problems.join("\n")).toMatch(/(rss|feed).*(no |nothing|empty)/i);
  });

  it("a feed that answers 404 fails", () => {
    expect(checkBlogSeo(site({ rss: { status: 404, body: "" } })).problems.join("\n")).toMatch(/(rss|feed).*404/i);
  });

  it("robots.txt: 404 fails; no Sitemap line fails; a Sitemap line naming another file fails; a lower-case 'sitemap:' passes", () => {
    expect(checkBlogSeo(site({ robots: { status: 404, body: robotsTxt() } })).problems.join("\n")).toMatch(/robots.*404/);
    expect(checkBlogSeo(site({ robots: ok("User-Agent: *\nAllow: /\n") })).problems.join("\n")).toMatch(/robots.*sitemap/i);
    expect(checkBlogSeo(site({ robots: ok(`User-Agent: *\nAllow: /\nSitemap: ${ORIGIN}/other.xml\n`) })).problems.join("\n")).toMatch(/robots.*sitemap/i);
    expect(checkBlogSeo(site({ robots: ok(robotsTxt().replace("Sitemap:", "sitemap:")) })).problems).toEqual([]);
  });

  it("robots.txt is read from the real robots(): its sitemap URL is the one the checker accepts", () => {
    expect(robotsTxt()).toMatch(/Sitemap: https?:\/\/[^\s/]+\/sitemap\.xml/);
    expect(checkBlogSeo(site()).problems).toEqual([]);
  });
});
