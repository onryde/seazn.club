// Help pages link the blog posts that name them: a "Read how it works" list on the help page a post's `help:` key names
// (blog P2 Task 6). Driven through the REAL route modules: the article page for a help article, the family page for
// `formats/<family>`. The fixture posts (src/blog/__tests__/fixtures/content) stand in for a tree with many posts, through the
// same module-mock switch blog-pages.test.tsx uses; the real pilot is checked with no mock at all.
//
// Expected values come from the fixture posts' own front-matter (dates, help keys) and from the files on disk, never from the
// function under test. The list is passed BESIDE the help `related` list (help-related.ts keeps refusing a non-help slug), so
// a test here also pins that the two stay apart.
//
// Single-sport reason: no sport is involved; this is page wiring.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const sw = vi.hoisted(() => ({ posts: null as null | readonly unknown[] }));
vi.mock("@/lib/pricing-matrix-server", () => ({ loadPricingMatrix: vi.fn(async () => ({})) }));
vi.mock("@/server/blog-content", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/blog-content")>();
  return {
    ...real,
    blogPostsForHelp: (slug: string, posts?: readonly import("@/server/blog-content").BlogPost[]) =>
      real.blogPostsForHelp(slug, posts ?? (sw.posts as readonly import("@/server/blog-content").BlogPost[] | null) ?? undefined),
  };
});

import * as articleRoute from "@/app/help/[...slug]/page";
import * as familyRoute from "@/app/help/formats/[family]/page";
import { HelpRelated } from "@/components/help/help-related";
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import { blogUrl } from "@/lib/blog";
import { allBlogPosts, type BlogPost } from "@/server/blog-content";
import { allHelpArticles } from "@/server/help-content";
import { resolveHelpRelated } from "@/server/help-related";
import en from "@/dictionaries/en/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";

const FIXTURES = join(process.cwd(), "src", "blog", "__tests__", "fixtures", "content");
const fixturePosts = allBlogPosts(FIXTURES);
const realPosts = allBlogPosts();

const HEADING = "Read how it works";
const EN = en as Record<string, string>;
const SECTION = /<section[^>]*data-testid="help-blog-links".*?<\/section>/s;

/** The page a post's `help:` key names, rendered through the real route (a format family or a help article). */
async function renderHelp(helpSlug: string): Promise<string> {
  if (helpSlug.startsWith("formats/")) {
    const family = helpSlug.slice("formats/".length);
    return renderToStaticMarkup((await familyRoute.default({ params: Promise.resolve({ family }) })) as ReactElement);
  }
  return renderToStaticMarkup((await articleRoute.default({ params: Promise.resolve({ slug: helpSlug.split("/") }) })) as ReactElement);
}

/** The post slugs the "Read how it works" list links, in order; null when the page has no such list. */
function listedSlugs(markup: string): string[] | null {
  const section = SECTION.exec(markup)?.[0];
  if (!section) return null;
  return [...section.matchAll(/href="\/blog\/([^"]+)"/g)].map((m) => m[1]!);
}

/** A post written here, not read from disk: same shape as a parsed one. */
const post = (slug: string, date: string, help: string, topic: BlogPost["topic"] = "points"): BlogPost => ({
  ...fixturePosts[0]!,
  slug,
  title: `Question for ${slug}?`,
  date,
  updated: undefined,
  help,
  topic,
});

beforeEach(() => {
  sw.posts = null;
});
afterEach(() => {
  sw.posts = null;
});

describe("every post is on the page its help key names, and every post on a page names that page", () => {
  it("fixture posts: both directions over every post and every page, counted", async () => {
    sw.posts = fixturePosts;
    expect(fixturePosts, "premise: fixture posts exist").toHaveLength(4);
    const helpKeys = [...new Set(fixturePosts.map((p) => p.help))];
    expect(helpKeys.length, "premise: more than one page, a format family among them").toBeGreaterThanOrEqual(3);
    expect(helpKeys.some((k) => k.startsWith("formats/"))).toBe(true);

    let postToPage = 0;
    let pageToPost = 0;
    for (const key of helpKeys) {
      const listed = listedSlugs(await renderHelp(key));
      expect(listed, `${key} has the list`).not.toBeNull();
      // post -> page: every post that names this page is listed (none of these pages has more than the cap)
      const named = fixturePosts.filter((p) => p.help === key);
      expect(named.length, `premise: ${key} names at most the cap`).toBeLessThanOrEqual(3);
      for (const p of named) {
        expect(listed, `${p.slug} is on ${key}`).toContain(p.slug);
        postToPage++;
      }
      // page -> post: every listed post names this page
      for (const slug of listed!) {
        const found = fixturePosts.find((p) => p.slug === slug);
        expect(found, `${slug} listed on ${key} is a post`).toBeDefined();
        expect(found!.help, `${slug} listed on ${key} names it`).toBe(key);
        pageToPost++;
      }
    }
    expect(postToPage, "every fixture post checked once").toBe(fixturePosts.length);
    expect(pageToPost, "links checked page to post equal the posts").toBe(fixturePosts.length);
  });

  it("the real tree: every real post, on the real page, with the real route (counted)", async () => {
    expect(realPosts.length, "premise: at least the pilot").toBeGreaterThan(0);
    let checked = 0;
    for (const key of new Set(realPosts.map((p) => p.help))) {
      const listed = listedSlugs(await renderHelp(key));
      expect(listed, `${key} has the list`).not.toBeNull();
      // Expected: the newest three that name this page, from the files' own dates (never the function under test).
      const named = realPosts
        .filter((p) => p.help === key)
        .sort((a, b) => (a.date === b.date ? a.slug.localeCompare(b.slug) : b.date.localeCompare(a.date)))
        .slice(0, 3);
      expect(listed).toEqual(named.map((p) => p.slug));
      for (const slug of listed!) expect(realPosts.find((p) => p.slug === slug)!.help).toBe(key);
      checked += named.length;
    }
    expect(checked, "anti-vacuity: links checked").toBeGreaterThan(0);
  });

  it("the pilot's own help page lists the pilot, with its question as the link text and the blog's name and its topic under it", async () => {
    const pilot = realPosts.find((p) => p.slug === "how-standings-points-work")!;
    expect(pilot, "premise: the pilot exists").toBeDefined();
    const section = SECTION.exec(await renderHelp(pilot.help))![0];
    expect(section).toContain(`href="${blogUrl(pilot.slug)}"`);
    expect(section).toContain(pilot.title);
    expect(section).toContain(`>${HEADING}</h2>`);
    expect(section).toContain(`${EN["nav.blog"]}, ${EN[`blog.topic.${pilot.topic}`]}`);
  });
});

describe("at most three, newest first", () => {
  it("five posts name one page: the three newest are listed, in date order, the two oldest are not", async () => {
    const KEY = "sports/football";
    sw.posts = [
      post("p-2026-03", "2026-03-01", KEY),
      post("p-2026-11", "2026-11-01", KEY),
      post("p-2026-01", "2026-01-01", KEY),
      post("p-2026-09", "2026-09-01", KEY),
      post("p-2026-06", "2026-06-01", KEY),
    ];
    const listed = listedSlugs(await renderHelp(KEY));
    // Typed by hand from the dates above: November, September, June.
    expect(listed).toEqual(["p-2026-11", "p-2026-09", "p-2026-06"]);
  });

  it("exactly three are all shown, and a same-day pair orders by slug", async () => {
    const KEY = "sports/football";
    sw.posts = [post("b-post", "2026-05-05", KEY), post("a-post", "2026-05-05", KEY), post("c-post", "2026-04-01", KEY)];
    expect(listedSlugs(await renderHelp(KEY))).toEqual(["a-post", "b-post", "c-post"]);
  });

  it("a format family page is capped and ordered the same way", async () => {
    const family = FORMAT_FAMILIES[0]!.slug;
    sw.posts = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"].map((d) => post(`f-${d}`, d, `formats/${family}`));
    expect(listedSlugs(await renderHelp(`formats/${family}`))).toEqual(["f-2026-04-01", "f-2026-03-01", "f-2026-02-01"]);
  });
});

describe("a help page with no posts", () => {
  it("renders no heading, no section and no empty list: an article, a format family, with none and with posts only elsewhere", async () => {
    sw.posts = [];
    for (const key of ["sports/football", `formats/${FORMAT_FAMILIES[0]!.slug}`]) {
      const markup = await renderHelp(key);
      expect(markup, key).not.toContain(HEADING);
      expect(markup, key).not.toContain("help-blog-links");
    }
    // posts exist, none names this page
    sw.posts = fixturePosts;
    expect(fixturePosts.some((p) => p.help === "registration/waitlist"), "premise: no fixture post names the page").toBe(false);
    expect(allHelpArticles().has("registration/waitlist"), "premise: the page exists").toBe(true);
    const markup = await renderHelp("registration/waitlist");
    expect(markup).not.toContain(HEADING);
    expect(markup).not.toContain("help-blog-links");
    // The real tree: a real page no real post names
    sw.posts = null;
    expect(realPosts.some((p) => p.help === "registration/waitlist")).toBe(false);
    expect(await renderHelp("registration/waitlist")).not.toContain(HEADING);
  });

  it("the component alone: an empty list draws nothing, and with no related, no prev and no next the footer is gone too", () => {
    expect(renderToStaticMarkup(<HelpRelated related={[]} prev={null} next={null} blogLinks={{ title: HEADING, posts: [] }} />)).toBe("");
    expect(renderToStaticMarkup(<HelpRelated related={[]} prev={null} next={null} />)).toBe("");
  });

  it("the component alone: only a blog list still draws the footer (a page with posts but no related or neighbours)", () => {
    const out = renderToStaticMarkup(
      <HelpRelated related={[]} prev={null} next={null} blogLinks={{ title: HEADING, posts: [{ href: "/blog/x", title: "X?", meta: "Blog, Points" }] }} />,
    );
    expect(out).toContain(`>${HEADING}</h2>`);
    expect(out).toContain('href="/blog/x"');
  });
});

describe("beside the Related list, never through it", () => {
  it("the page keeps both lists: Related first with the article's own related, then the blog list; both are lists of links", async () => {
    sw.posts = fixturePosts;
    const article = allHelpArticles().get("sports/football")!;
    const related = resolveHelpRelated(article, allHelpArticles());
    expect(related.length, "premise: football names related help pages").toBeGreaterThan(0);
    const markup = await renderHelp("sports/football");
    const relatedAt = markup.indexOf('aria-label="Related"');
    const blogAt = markup.indexOf('data-testid="help-blog-links"');
    expect(relatedAt).toBeGreaterThan(0);
    expect(blogAt).toBeGreaterThan(relatedAt);
    // The blog posts are not in the Related section
    const relatedSection = /<section aria-label="Related".*?<\/section>/s.exec(markup)![0];
    expect(relatedSection).not.toContain('href="/blog/');
    for (const r of related) expect(relatedSection).toContain(`href="/help/${r.slug}"`);
  });

  it("help's own front-matter is still not a way to name a blog post (resolveHelpRelated refuses it)", () => {
    const articles = allHelpArticles();
    const base = articles.get("sports/football")!;
    expect(() => resolveHelpRelated({ ...base, related: ["blog/how-standings-points-work"] }, articles)).toThrow(/blog\/how-standings-points-work/);
  });
});

describe("the heading is translated", () => {
  it("'blog.help.title' is in all four dictionaries and the English one is the heading the page prints", () => {
    expect((en as Record<string, string>)["blog.help.title"]).toBe(HEADING);
    for (const [name, dict] of Object.entries({ en, es, fr, nl })) {
      const v = (dict as Record<string, string>)["blog.help.title"];
      expect(v, name).toBeTruthy();
    }
    for (const dict of [es, fr, nl]) expect((dict as Record<string, string>)["blog.help.title"]).not.toBe(HEADING);
  });
});
