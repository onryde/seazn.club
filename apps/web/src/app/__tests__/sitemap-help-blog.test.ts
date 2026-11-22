// The sitemap's help and blog halves (app/sitemap.ts). The help half was owed since help shipped: no help URL was ever
// listed. Expected values come from the content on disk and the format gallery's own list, never from the sitemap.
import { describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn, revalidateTag: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("@/server/public-site/sitemap-cache", () => ({ cachedPublicSitemapEntries: async () => [], SITEMAP_ENTRIES_CACHE_KEY: ["x"] }));

import sitemap from "../sitemap";
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import { siteOrigin } from "@/lib/site-origin";
import { allBlogPosts } from "@/server/blog-content";
import { allHelpArticles } from "@/server/help-content";

const BASE = siteOrigin();

describe("sitemap: /blog, every post, /help, every help article and every format page", () => {
  it("lists the blog index and every post once, each post dated by `updated ?? date`", async () => {
    const entries = await sitemap();
    const posts = allBlogPosts();
    expect(posts.length, "premise: there are posts").toBeGreaterThan(0);
    expect(entries.filter((e) => e.url === `${BASE}/blog`)).toHaveLength(1);
    let checked = 0;
    for (const p of posts) {
      const hits = entries.filter((e) => e.url === `${BASE}/blog/${p.slug}`);
      expect(hits, p.slug).toHaveLength(1);
      expect(hits[0]!.lastModified, p.slug).toBe(p.updated ?? p.date);
      checked++;
    }
    expect(checked).toBe(posts.length);
    // And nothing else under /blog is listed.
    expect(entries.filter((e) => e.url.startsWith(`${BASE}/blog`)).length).toBe(posts.length + 1);
  });

  it("lists /help, every help article once and every format page (the overview and one per family)", async () => {
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    const articles = [...allHelpArticles().keys()];
    expect(articles.length, "premise: there are help articles").toBeGreaterThan(20);
    expect(FORMAT_FAMILIES.length, "premise: there are format families").toBeGreaterThan(3);
    expect(urls.filter((u) => u === `${BASE}/help`)).toHaveLength(1);
    for (const slug of articles) expect(urls.filter((u) => u === `${BASE}/help/${slug}`), slug).toHaveLength(1);
    expect(urls.filter((u) => u === `${BASE}/help/formats`)).toHaveLength(1);
    for (const f of FORMAT_FAMILIES) expect(urls.filter((u) => u === `${BASE}/help/formats/${f.slug}`), f.slug).toHaveLength(1);
    expect(urls.filter((u) => u.startsWith(`${BASE}/help`)).length).toBe(1 + articles.length + 1 + FORMAT_FAMILIES.length);
  });

  it("states no date for a help page (it has none), and no URL appears twice", async () => {
    const entries = await sitemap();
    for (const e of entries.filter((x) => x.url.startsWith(`${BASE}/help`))) expect(e.lastModified, e.url).toBeUndefined();
    const urls = entries.map((e) => e.url);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
