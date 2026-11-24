// LIVE, opt-in: the blog's SEO tags against a RUNNING production server. ci.yml's smoke-e2e job runs this file against the
// standalone server it starts on :3000 (step "Blog SEO"), once, after the smoke suites:
//
//   BLOG_SEO_BASE=http://localhost:3000 npx vitest run src/blog/__tests__/blog-seo.live.test.ts
//
// Which posts is the CONTENT LOADER's answer (allBlogPosts, the same call the build's generateStaticParams, the sitemap and the
// feed make), never a typed number: a post added or removed moves the count with the tree, and a loader that lists none is a
// failure. The rules are lib/blog-seo-check.ts (unit-tested over fixture HTML in lib/__tests__/blog-seo-check.test.ts); this
// file only fetches and hands the answers over.
//
// Without BLOG_SEO_BASE the suite skips (it reads no network); CI asserts from the JSON report that it did NOT skip.
// Single-sport reason: no sport is involved; a post's SEO tags are sport-blind.
import { describe, expect, it } from "vitest";
import { blogUrl } from "@/lib/blog";
import { checkBlogSeo, type Fetched } from "@/lib/blog-seo-check";
import { allBlogPosts } from "@/server/blog-content";

const BASE = process.env.BLOG_SEO_BASE;

/** One GET. A redirect is not followed: a post's own URL must answer 200 itself. */
async function get(path: string): Promise<Fetched> {
  const res = await fetch(new URL(path, BASE), { redirect: "manual", headers: { accept: "text/html,application/xml,text/plain" } });
  return { status: res.status, body: await res.text() };
}

describe.skipIf(!BASE)(`blog SEO against ${BASE ?? "(BLOG_SEO_BASE unset)"}`, () => {
  it("every post the loader lists passes, and is in the sitemap and the feed; robots.txt names the sitemap", async () => {
    const posts = allBlogPosts();
    expect(posts.length, "the content loader lists at least one post").toBeGreaterThan(0);

    const pages = await Promise.all(posts.map(async (p) => ({ path: blogUrl(p.slug), page: await get(blogUrl(p.slug)) })));
    const [sitemap, rss, robots] = await Promise.all([get("/sitemap.xml"), get("/blog/rss.xml"), get("/robots.txt")]);

    const report = checkBlogSeo({ posts: pages, sitemap, rss, robots });
    console.log(`blog SEO: ${report.posts} posts checked against ${BASE}; ${report.problems.length} problem(s)`);
    expect(report.posts, "every post the loader lists was fetched and checked").toBe(posts.length);
    expect(report.problems).toEqual([]);
  }, 180_000);
});
