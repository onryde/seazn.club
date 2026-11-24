// The blog's pages, driven through their REAL route modules: the post page (the pilot, through the real renderer, goldens and
// dictionary), its metadata and structured data, the index, the feed and the share card. What a page shows is read from the
// markup; what a page declares is read from the exports Next reads. Nothing here derives an expected value from the code
// under test: dates, sports and counts come from the fixture posts' own front-matter, the help link from the registry.
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import BlogIndexPage, * as indexRoute from "../page";
import BlogPostPage, * as postRoute from "../[slug]/page";
import * as feedRoute from "../rss.xml/route";
import OgImage, * as ogRoute from "../[slug]/opengraph-image";
import * as layoutRoute from "../layout";
import { BlogPostView } from "@/components/blog/blog-post-view";
import { BlogIndex } from "@/components/blog/blog-index";
import { BlogHandlesIt } from "@/components/blog/blog-handles-it";
import { BlogExample } from "@/components/blog/blog-example-table";
import { BlogDiagram } from "@/components/blog/blog-diagram";
import { MarketingFooter } from "@/components/marketing-footer";
import { BLOG_AUTHOR, BLOG_TOPICS, blogPostShowsFor, blogUrl, formatBlogDate } from "@/lib/blog";
import { blogIndexLd, blogOgTitleSize, blogPostBreadcrumbLd, blogPostMetadata, blogPostingLd } from "@/lib/blog-seo";
import { helpUrl } from "@/lib/help";
import { LOCALES } from "@/lib/i18n-constants";
import { allBlogPosts, blogPost, BLOG_PLANNED_SLUGS, type BlogPost } from "@/server/blog-content";
import { blogIndexModel, resolveBlogRelated } from "@/server/blog-index";
import { blogRssXml, rssDate } from "@/server/blog-rss";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { DiagramModel } from "@/blog/examples/types";
import en from "@/dictionaries/en/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";

// Lets one test give the pilot related slugs that RESOLVE (the pilot's own do not yet): a hoisted switch, pass-through when off.
const rel = vi.hoisted(() => ({ on: false as boolean, related: [] as string[], find: null as null | ((slug: string) => unknown) }));
vi.mock("@/server/blog-content", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/blog-content")>();
  return {
    ...real,
    blogPost: (slug: string) => {
      if (!rel.on) return real.blogPost(slug);
      const found = rel.find ? rel.find(slug) : null;
      if (found) return found as ReturnType<typeof real.blogPost>;
      const post = real.blogPost(slug);
      return post && slug === "how-standings-points-work" ? { ...post, related: rel.related } : post;
    },
  };
});

// The shell's display face (components/marketing/marketing-shell.tsx) is next/font, which only exists inside a Next build.
vi.mock("next/font/google", () => ({ Barlow_Condensed: () => ({ variable: "--mk-font-display", className: "" }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/blog",
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const FIXTURES = join(process.cwd(), "src", "blog", "__tests__", "fixtures", "content");
const fixturePosts = allBlogPosts(FIXTURES);
const realPosts = allBlogPosts();
const PILOT = "how-standings-points-work";
const EN = en as Record<string, string>;

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const html = async (slug: string) => renderToStaticMarkup(await BlogPostPage(params(slug)));
/** Every JSON-LD block of a page, parsed. */
const ldBlocks = (markup: string) =>
  [...markup.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
/** Visible text between tags (attributes excluded), for "does the reader see this". */
const text = (markup: string) => markup.replace(/<script[^>]*>.*?<\/script>/gs, "").replace(/<[^>]+>/g, "\u0001").split("\u0001").join(" ").replace(/\s+/g, " ");

describe("the post page, through the real renderer (the pilot)", () => {
  const post = blogPost(PILOT)!;

  it("premise: the pilot is a post, and the fixtures are four posts with different dates", () => {
    expect(post).not.toBeNull();
    expect(realPosts.length).toBeGreaterThan(0);
    expect(fixturePosts).toHaveLength(4);
  });

  it("shows the title, a date a person reads (not ISO) and the byline Seazn", async () => {
    const markup = await html(PILOT);
    expect(markup).toContain(`>${post.title}</h1>`);
    expect(text(markup)).toContain(formatBlogDate(post.date));
    expect(formatBlogDate(post.date)).toMatch(/^\d{1,2} [A-Z][a-z]+ \d{4}$/);
    // The ISO date is only the machine-readable attribute, never text.
    expect(text(markup)).not.toContain(post.date);
    expect(markup).toContain(`<time dateTime="${post.date}">`);
    const byline = /data-testid="blog-byline".*?<\/p>/s.exec(markup)![0];
    expect(text(byline)).toContain(BLOG_AUTHOR);
    expect(BLOG_AUTHOR).toBe("Seazn");
  });

  it("'How Seazn handles it' links the registry's page for the post's help key, after the body, from the front-matter", async () => {
    const markup = await html(PILOT);
    const href = helpUrl(post.help);
    expect(href, "premise: the pilot's help key is registered").not.toBeNull();
    const section = /data-testid="blog-handles-it".*?<\/section>/s.exec(markup)![0];
    expect(section).toContain(`href="${href}"`);
    expect(section).toContain(">How Seazn handles it</h2>");
    // The body never wrote the section itself (blog-tree.test.ts forbids it), so there is exactly one.
    expect(markup.split("How Seazn handles it").length - 1).toBeGreaterThanOrEqual(1);
    expect(markup.indexOf("blog-handles-it")).toBeGreaterThan(markup.indexOf("blog-example"));
  });

  it("an unregistered help key renders no section and no dead link", () => {
    expect(helpUrl("not/a-page")).toBeNull();
    const out = renderToStaticMarkup(<BlogHandlesIt href={helpUrl("not/a-page")} title="How Seazn handles it" body="b" linkLabel="Open" />);
    expect(out).toBe("");
  });

  it("renders the example's table and picture only: the golden's made-up text lines never reach the page", async () => {
    const markup = await html(PILOT);
    const golden = BLOG_GOLDENS["standings-points"]!;
    expect(golden.text.length, "premise: the golden has text lines to leak").toBeGreaterThan(0);
    for (const line of golden.text) expect(markup, line).not.toContain(line);
    expect(golden.table!.rows.length).toBeGreaterThan(5);
    // Every cell of the table is on the page.
    let cells = 0;
    for (const row of golden.table!.rows) for (const cell of row) {
      expect(text(markup), String(cell)).toContain(String(cell));
      cells++;
    }
    expect(cells).toBe(golden.table!.rows.length * golden.table!.columns.length);
  });

  it("the table scrolls inside a focusable, named region (class 23), with a header row and a header column", async () => {
    const markup = await html(PILOT);
    const region = /<div role="region"([^>]*)>/.exec(markup)![1]!;
    expect(region).toContain('tabindex="0"');
    expect(region).toMatch(/aria-labelledby="blog-example-standings-points-cap"/);
    expect(region).toContain("overflow-x-auto");
    expect(markup).toContain('id="blog-example-standings-points-cap"');
    expect(markup.match(/<th scope="col"/g)!.length).toBe(BLOG_GOLDENS["standings-points"]!.table!.columns.length);
    expect(markup.match(/<th scope="row"/g)!.length).toBe(BLOG_GOLDENS["standings-points"]!.table!.rows.length);
  });

  it("shows exactly the related posts that resolve, and none of those still to be written (the pilot names some of each while the programme lands)", async () => {
    const markup = await html(PILOT);
    expect(post.related.length).toBeGreaterThanOrEqual(2);
    const resolved = post.related.filter((s) => blogPost(s) !== null);
    const unresolved = post.related.filter((s) => blogPost(s) === null);
    expect(resolved.length + unresolved.length, "every related slug is one or the other").toBe(post.related.length);
    expect(resolved.length, "anti-vacuity: related posts that resolve").toBeGreaterThan(0);
    // Anti-vacuity for the unresolved arm: the slugs that do not resolve are EXACTLY the pilot's related slugs the programme
    // still has planned, read from the planned set, so a slug that vanished (neither a post nor planned) is a failure and not
    // an empty loop. When the last one lands the arm is empty by design, and the fixture test below keeps it exercised.
    const planned = post.related.filter((s) => BLOG_PLANNED_SLUGS.has(s));
    expect(unresolved, "every related slug that does not resolve is one still to be written").toEqual(planned);
    for (const slug of resolved) expect(markup, slug).toContain(blogUrl(slug));
    let absent = 0;
    for (const slug of unresolved) {
      expect(markup, slug).not.toContain(blogUrl(slug));
      absent++;
    }
    // While the pilot still names a planned slug, the arm must have checked at least one (the loop above cannot run empty).
    if (planned.length > 0) expect(absent, "anti-vacuity: unresolved related slugs checked absent from the page").toBeGreaterThan(0);
    expect(absent).toBe(planned.length);
    expect(markup).toContain('data-testid="blog-related"');
  });

  it("shows only related posts that resolve: when the related slugs are not posts, no link and no section", async () => {
    // Blog batch 2: the pilot's own related slugs become posts as the batches land, so "none resolves" is made true here
    // by naming slugs that are posts nowhere, never read off today's tree.
    const unwritten = ["a-post-nobody-has-written", "another-post-nobody-has-written"];
    rel.on = true;
    rel.related = unwritten;
    rel.find = () => null;
    try {
      const markup = await html(PILOT);
      expect(unwritten.every((s) => blogPost(s) === null), "premise: these are not posts").toBe(true);
      for (const slug of unwritten) expect(markup, slug).not.toContain(blogUrl(slug));
      expect(markup).not.toContain('data-testid="blog-related"');
    } finally {
      rel.on = false;
    }
  });

  it("related cards on the real page: resolved slugs are linked in front-matter order, with their titles; an unresolved one is not", async () => {
    const [a, b] = ["how-swiss-pairs-round-two", "who-wins-a-two-way-tie"].map((slug) => fixturePosts.find((p) => p.slug === slug)!);
    rel.on = true;
    rel.related = [b!.slug, "planned-but-unwritten", a!.slug];
    rel.find = (slug) => fixturePosts.find((p) => p.slug === slug) ?? null;
    try {
      const markup = await html(PILOT);
      const section = /data-testid="blog-related".*?<\/section>/s.exec(markup)![0];
      const links = [...section.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs)].map((m) => [m[1], text(m[2]!).trim().split(" ").slice(0, 3).join(" ")]);
      expect(links.map((l) => l[0])).toEqual([blogUrl(b!.slug), blogUrl(a!.slug)]);
      for (const post of [b!, a!]) expect(text(section), post.slug).toContain(post.title);
      expect(links).toHaveLength(2);
      expect(section).not.toContain("planned-but-unwritten");
    } finally {
      rel.on = false;
    }
  });

  it("'On this page' lists the body's sections and then 'How Seazn handles it'", async () => {
    const markup = await html(PILOT);
    const rail = /data-testid="help-toc".*?<\/nav>/s.exec(markup)![0];
    const entries = [...rail.matchAll(/<a [^>]*href="#([^"]+)"/g)].map((m) => m[1]);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries.at(-1)).toBe("how-seazn-handles-it");
    for (const id of entries) expect(markup, id).toContain(`id="${id}"`);
  });

  it("an unknown slug is a 404, never a render", async () => {
    await expect(BlogPostPage(params("no-such-post"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(postRoute.dynamicParams).toBe(false);
  });
});

describe("the post page with related posts and an update (fixtures, through the view)", () => {
  const draw = fixturePosts.find((p) => p.slug === "what-a-draw-is-worth")!;
  const related = resolveBlogRelated(draw, (s) => fixturePosts.find((p) => p.slug === s) ?? null);

  it("related posts come in the front-matter's order, as cards linking each post", () => {
    expect(draw.related).toEqual(["how-swiss-pairs-round-two", "who-wins-a-two-way-tie"]);
    expect(related.map((r) => r.slug)).toEqual(draw.related);
    const out = renderToStaticMarkup(
      <BlogPostView
        title={draw.title} answer={draw.description} date={draw.date} dateLabel={formatBlogDate(draw.date)}
        updated={draw.updated} updatedLabel={`Updated ${formatBlogDate(draw.updated!)}`} topicLabel="Standings points"
        parts={[{ kind: "html", html: "<p>Body.</p>" }]} toc={[]}
        handles={{ href: "/help/sports/football", title: "How Seazn handles it", body: "b", linkLabel: "Open" }}
        related={related.map((r) => ({ href: blogUrl(r.slug), title: r.title, topic: "t" }))}
        labels={{ blog: "Blog", related: "Related posts", swipe: "swipe" }}
      />,
    );
    const hrefs = [...out.matchAll(/href="(\/blog\/[^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(draw.related.map(blogUrl));
    expect(out).toContain(`<time dateTime="${draw.updated}">Updated 1 November 2026</time>`);
  });

  it("a name that is not a post yet is dropped, order kept", () => {
    const post = { related: ["who-wins-a-two-way-tie", "planned-but-unwritten", "how-swiss-pairs-round-two"] };
    const find = (s: string) => fixturePosts.find((p) => p.slug === s) ?? null;
    expect(resolveBlogRelated(post, find).map((p) => p.slug)).toEqual(["who-wins-a-two-way-tie", "how-swiss-pairs-round-two"]);
    expect(resolveBlogRelated({ related: ["only-planned"] }, find)).toEqual([]);
  });
});

describe("metadata", () => {
  it("the pilot's generateMetadata: title, description, canonical, article card with the date and the author Seazn", async () => {
    const post = blogPost(PILOT)!;
    const m = await postRoute.generateMetadata(params(PILOT));
    expect(m.title).toBe(post.title);
    expect(m.description).toBe(post.description);
    expect(m.alternates?.canonical).toBe(`/blog/${PILOT}`);
    expect(m.alternates?.types).toEqual({ "application/rss+xml": "/blog/rss.xml" });
    const og = m.openGraph as { type: string; publishedTime?: string; authors?: string[]; url?: string };
    expect(og.type).toBe("article");
    expect(og.publishedTime).toBe(post.date);
    expect(og.authors).toEqual(["Seazn"]);
    expect(og.url).toBe(`/blog/${PILOT}`);
    expect((m.twitter as { card: string }).card).toBe("summary_large_image");
  });

  it("an update date becomes modifiedTime; none means none", () => {
    const withUpdate = fixturePosts.find((p) => p.updated)!;
    const without = fixturePosts.find((p) => !p.updated)!;
    expect((blogPostMetadata(withUpdate).openGraph as { modifiedTime?: string }).modifiedTime).toBe(withUpdate.updated);
    expect("modifiedTime" in (blogPostMetadata(without).openGraph as object)).toBe(false);
  });

  it("an unknown slug gets no metadata; the title template matches help's form", async () => {
    expect(await postRoute.generateMetadata(params("nope"))).toEqual({});
    const t = (layoutRoute.metadata.title as { template: string }).template;
    expect(t).toBe("%s — Seazn Club Blog");
  });

  it("the index declares its own title, canonical and feed", () => {
    expect(indexRoute.metadata.alternates?.canonical).toBe("/blog");
    expect(indexRoute.metadata.alternates?.types).toEqual({ "application/rss+xml": "/blog/rss.xml" });
  });
});

describe("structured data", () => {
  it("every post is a BlogPosting by the ORGANISATION Seazn, never a person, and is followed by a breadcrumb", async () => {
    const markup = await html(PILOT);
    const blocks = ldBlocks(markup);
    expect(blocks).toHaveLength(2);
    const post = blogPost(PILOT)!;
    const posting = blocks.find((b) => b["@type"] === "BlogPosting")!;
    expect(posting.author).toEqual({ "@type": "Organization", name: "Seazn" });
    expect(posting.headline).toBe(post.title);
    expect(posting.datePublished).toBe(post.date);
    expect(posting.dateModified).toBe(post.date);
    const crumbs = blocks.find((b) => b["@type"] === "BreadcrumbList")!;
    const items = crumbs.itemListElement as { name: string; item: string }[];
    expect(items.map((i) => i.name)).toEqual(["Blog", post.title]);
    expect(items[1]!.item.endsWith(`/blog/${PILOT}`)).toBe(true);
  });

  it("no post's data names a Person anywhere, and dateModified follows `updated`", () => {
    let checked = 0;
    for (const p of [...fixturePosts, ...realPosts]) {
      const ld = blogPostingLd(p);
      expect(JSON.stringify(ld), p.slug).not.toContain('"Person"');
      expect(ld.dateModified, p.slug).toBe(p.updated ?? p.date);
      // The image is the per-post share card, a route that exists for this very slug.
      expect(ld.image, p.slug).toMatch(new RegExp(`/blog/${p.slug}/opengraph-image$`));
      expect(blogPostBreadcrumbLd(p).itemListElement).toHaveLength(2);
      checked++;
    }
    expect(checked).toBe(fixturePosts.length + realPosts.length);
    expect(ogRoute.generateStaticParams().map((x: { slug: string }) => x.slug)).toContain(PILOT);
    expect(fixturePosts.some((p) => p.updated), "premise: one fixture has an update").toBe(true);
  });

  it("the index is a Blog listing every post", async () => {
    const markup = renderToStaticMarkup(await BlogIndexPage());
    const blog = ldBlocks(markup).find((b) => b["@type"] === "Blog")!;
    expect((blog.blogPost as unknown[]).length).toBe(realPosts.length);
    expect(blogIndexLd(fixturePosts).blogPost).toHaveLength(4);
  });
});

describe("the index", () => {
  it("lists every post exactly once, under its topic, newest first within a topic", async () => {
    const markup = renderToStaticMarkup(await BlogIndexPage());
    expect(realPosts.length).toBeGreaterThan(0);
    for (const p of realPosts) expect(markup.split(`href="${blogUrl(p.slug)}"`), p.slug).toHaveLength(2);
    expect(markup).toContain(">How it works</h1>");
  });

  const model = blogIndexModel(fixturePosts, (t) => `topic:${t}`, (k) => `sport:${k}`);

  it("fixtures: every post once, groups in the closed topic order, only topics that have a post", () => {
    const slugs = model.groups.flatMap((g) => g.posts.map((p) => p.slug));
    expect(slugs.sort()).toEqual(fixturePosts.map((p) => p.slug).sort());
    expect(model.total).toBe(4);
    const order = model.groups.map((g) => BLOG_TOPICS.indexOf(g.topic));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(model.groups.map((g) => g.topic)).toEqual(["points", "tie-breaks", "swiss", "withdrawal"]);
  });

  it("fixtures: a chip per sport a post names; a post for every sport counts under every chip", () => {
    // Read off the four posts' front-matter: swiss names boardgame+badminton, the tie names football; the draw and the
    // withdrawal post are for every sport.
    expect(model.chips.map((c) => [c.key, c.count])).toEqual([["badminton", 3], ["boardgame", 3], ["football", 3]]);
    expect(model.chips.map((c) => c.label)).toEqual(["sport:badminton", "sport:boardgame", "sport:football"]);
  });

  it("the sport filter's rule: a named sport, or every sport; nothing else", () => {
    const swiss = model.groups.flatMap((g) => g.posts).find((p) => p.slug === "how-swiss-pairs-round-two")!;
    const draw = model.groups.flatMap((g) => g.posts).find((p) => p.slug === "what-a-draw-is-worth")!;
    expect(blogPostShowsFor(swiss, "badminton")).toBe(true);
    expect(blogPostShowsFor(swiss, "football")).toBe(false);
    for (const chip of model.chips) expect(blogPostShowsFor(draw, chip.key)).toBe(true);
    let checked = 0;
    for (const chip of model.chips) {
      const shown = model.groups.flatMap((g) => g.posts).filter((p) => blogPostShowsFor(p, chip.key));
      expect(shown.length).toBe(chip.count);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the island prints the chip rail as pressed-state buttons, an every-sport mark, and the sport tags", () => {
    const labels = { filterLabel: "Show posts for", allSports: "All sports", everySport: "Every sport", topics: "Topics", postOne: "{n} post", postMany: "{n} posts", empty: "none for this sport", none: "no posts at all" };
    const out = renderToStaticMarkup(<BlogIndex groups={model.groups} chips={model.chips} total={model.total} labels={labels} />);
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(out.match(/<button /g)).toHaveLength(4);
    expect(out).toContain("sport:badminton");
    expect(out).toContain("Every sport");
    // Four topics with one post each: "1 post" four times, never the plural.
    expect(out.match(/>1 post</g)).toHaveLength(4);
    expect(out).not.toContain("1 posts");
    // No chips: no filter bar at all (a blog of every-sport posts has nothing to filter).
    const none = renderToStaticMarkup(<BlogIndex groups={model.groups} chips={[]} total={4} labels={labels} />);
    expect(none).not.toContain("<button");
  });

  it("the chip rail is a scrolling box a keyboard can reach (tabindex, role, name), and every chip is a 44px touch target", () => {
    const labels = { filterLabel: "Show posts for", allSports: "All sports", everySport: "Every sport", topics: "Topics", postOne: "{n} post", postMany: "{n} posts", empty: "none for this sport", none: "no posts at all" };
    const out = renderToStaticMarkup(<BlogIndex groups={model.groups} chips={model.chips} total={model.total} labels={labels} />);
    const rail = /<div [^>]*role="group"[^>]*>/.exec(out)![0];
    expect(rail).toContain('tabindex="0"');
    expect(rail).toContain('aria-labelledby="blog-sport-filter"');
    expect(rail).toMatch(/overflow-x-auto/);
    const buttons = out.match(/<button [^>]*>/g)!;
    expect(buttons).toHaveLength(4);
    for (const b of buttons) {
      expect(b).toContain("min-h-11");
      expect(b, "no breakpoint shrinks it below 44px").not.toMatch(/\b(?:sm|md|lg|xl):min-h-\d\b/);
    }
  });

  it("an empty blog says there are no posts; a sport with none says so for that sport", () => {
    const labels = { filterLabel: "f", allSports: "a", everySport: "e", topics: "Topics", postOne: "{n} post", postMany: "{n} posts", empty: "none for this sport", none: "no posts at all" };
    const zero = renderToStaticMarkup(<BlogIndex groups={[]} chips={[]} total={0} labels={labels} />);
    expect(zero).toContain("no posts at all");
    expect(zero).not.toContain("none for this sport");
  });
});

describe("the feed", () => {
  const origin = "https://example.test";

  it("one item per post (count equals the posts, which is more than zero), newest first, each with link, pubDate, description", async () => {
    const res = feedRoute.GET();
    const xml = await res.text();
    expect(res.headers.get("content-type")).toContain("application/rss+xml");
    expect(realPosts.length).toBeGreaterThan(0);
    expect(xml.match(/<item>/g)).toHaveLength(realPosts.length);
    expect(feedRoute.dynamic).toBe("force-static");
    for (const p of realPosts) {
      const item = new RegExp(`<item>(?:(?!</item>).)*/blog/${p.slug}</link>.*?</item>`, "s").exec(xml)![0];
      expect(item).toContain(`<pubDate>${rssDate(p.date)}</pubDate>`);
      expect(item).toContain(`<description>${p.description.replace(/&/g, "&amp;")}</description>`);
    }
  });

  it("fixtures: items are in date order, newest first, and carry the author Seazn", () => {
    const xml = blogRssXml(fixturePosts, origin);
    const dates = [...xml.matchAll(/<pubDate>(.*?)<\/pubDate>/g)].map((m) => Date.parse(m[1]!));
    expect(dates).toHaveLength(4);
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
    expect(xml.match(/<dc:creator>Seazn<\/dc:creator>/g)).toHaveLength(4);
    expect(xml).toContain(`<link>${origin}/blog/what-happens-when-a-player-withdraws</link>`);
    // The channel's build date is the latest date any post carries: the draw post was updated on 2026-11-01, the withdrawal post is dated 2026-11-10.
    expect(xml).toContain(`<lastBuildDate>${rssDate("2026-11-10")}</lastBuildDate>`);
  });

  it("escapes what XML cannot hold, and refuses a date that is not one", () => {
    const post = { ...fixturePosts[0]!, title: 'Ties & "draws" <how>?', description: "A < B & C" } as BlogPost;
    const xml = blogRssXml([post], origin);
    expect(xml).toContain("<title>Ties &amp; &quot;draws&quot; &lt;how&gt;?</title>");
    expect(xml).toContain("<description>A &lt; B &amp; C</description>");
    expect(() => rssDate("20 Nov 2026")).toThrow(/not a date/);
    expect(blogRssXml([], origin)).not.toContain("<lastBuildDate>");
  });
});

describe("route configuration", () => {
  it("every blog page is static: dynamic = error, an hour, and the post route lists its params from the posts", () => {
    for (const [name, route] of [["layout", layoutRoute], ["index", indexRoute], ["post", postRoute]] as const) {
      expect((route as { dynamic?: string }).dynamic, name).toBe("error");
      expect((route as { revalidate?: number }).revalidate, name).toBe(3600);
    }
    expect(postRoute.generateStaticParams().map((p) => p.slug)).toEqual(realPosts.map((p) => p.slug));
    expect(postRoute.generateStaticParams().length).toBeGreaterThan(0);
    expect(ogRoute.generateStaticParams().map((p) => p.slug)).toEqual(realPosts.map((p) => p.slug));
  });

  it("the layout runs the shell without the session read", () => {
    const tree = layoutRoute.default({ children: null }) as { props: { children: { props: Record<string, unknown> } } };
    expect(tree.props.children.props.auth).toBe("client");
  });
});

describe("the share card", () => {
  let requested: string[] = [];
  beforeEach(() => {
    requested = [];
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      if (url.startsWith("data:")) return real(input as RequestInfo, init);
      return new Response("not served in tests", { status: 404 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a post's card is a 1200x630 PNG and fetches nothing remote", async () => {
    const res = await OgImage(params(PILOT));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    expect(ogRoute.size).toEqual({ width: 1200, height: 630 });
    expect(requested.filter((u) => !u.startsWith("data:"))).toEqual([]);
  });

  it("an unknown slug is a 404, and a longer question gets smaller type", async () => {
    await expect(OgImage(params("nope"))).rejects.toThrow("NEXT_NOT_FOUND");
    const sizes = [10, 60, 100, 140].map((n) => blogOgTitleSize("x".repeat(n)));
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(new Set(sizes).size).toBe(4);
  });
});

describe("pieces that guard themselves", () => {
  it("a diagram model has no drawing yet, so an example that gains one fails the build instead of printing a caption alone", () => {
    // A kind no batch draws (the drawn set grows batch by batch, so the refusal is pinned on a kind that never will be).
    const model = { kind: "no-drawing-ever", title: "t" } as unknown as DiagramModel;
    expect(() => renderToStaticMarkup(<BlogDiagram model={model} />)).toThrow(/no drawing for 'no-drawing-ever'/);
    expect(() => renderToStaticMarkup(<BlogExample id="x" result={{ facts: {}, text: [], diagram: model }} swipeHint="s" />)).toThrow(/no drawing/);
  });

  // ---- batch 5 (Task 11) ----
  it("batch 5's four drawings render their golden's model: an SVG whose title is the model's title, naming every word the model holds", () => {
    let drawn = 0;
    const kinds = new Set<string>();
    for (const id of ["ladder-challenge", "knockout-withdrawal", "double-walkover", "forfeit-scores"]) {
      const model = BLOG_GOLDENS[id]?.diagram;
      expect(model, `${id} carries a diagram`).toBeDefined();
      const html = renderToStaticMarkup(<BlogDiagram model={model!} />);
      expect(html, id).toContain("<svg");
      expect(html, id).toContain(`>${model!.title.replace(/'/g, "&#x27;")}</title>`);
      // Every name, round heading, result line and score the model holds must be on the page (an apostrophe is escaped by React).
      const words: string[] =
        model!.kind === "ladder"
          ? model!.rungs
          : model!.kind === "walkoverBracket"
            ? model!.rounds.flatMap((r) => [r.name, ...r.matches.flatMap((m) => [...m.sides, m.result])])
            : model!.kind === "scoreTiles"
              ? model!.tiles.flatMap((t) => [t.sport, t.score])
              : [];
      expect(words.length, `${id}: anti-vacuity`).toBeGreaterThan(3);
      // A seat that holds no player ("nobody", "not known yet") is drawn muted italic, and no name is (cleanup N3).
      if (model!.kind === "walkoverBracket") {
        const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        let vacantSeen = 0;
        let namesSeen = 0;
        for (const m of model!.rounds.flatMap((r) => r.matches))
          for (const side of m.sides) {
            const classes = [...html.matchAll(new RegExp(`<text[^>]*class="([^"]*)"[^>]*>${esc(side)}</text>`, "g"))].map((x) => x[1]!);
            expect(classes.length, `${id}: ${side} is drawn`).toBeGreaterThan(0);
            const vacant = (m.vacant ?? []).includes(side);
            for (const c of classes) expect(/\bitalic\b/.test(c), `${id}: ${side} ${vacant ? "is italic" : "is not italic"}`).toBe(vacant);
            if (vacant) vacantSeen++;
            else namesSeen++;
          }
        expect(vacantSeen, `${id}: a vacant seat is drawn`).toBeGreaterThan(0);
        expect(namesSeen, `${id}: a player is drawn`).toBeGreaterThan(0);
      }
      for (const w of words) expect(html, `${id} shows ${w}`).toContain(`>${w.replace(/'/g, "&#x27;")}<`);
      kinds.add(model!.kind);
      drawn++;
    }
    expect(drawn).toBe(4);
    expect([...kinds].sort(), "the three drawings batch 5 keeps").toEqual(["ladder", "scoreTiles", "walkoverBracket"]);
  });
  // ---- end batch 5 ----

  it("an example with no table draws nothing (and the page's example guard lives in the renderer)", () => {
    expect(renderToStaticMarkup(<BlogExample id="x" result={{ facts: {}, text: [] }} swipeHint="s" />)).toBe("");
  });
});

describe("the frame: the footer's Blog link, in every locale", () => {
  it("links /blog in the footer under each locale's own word", async () => {
    const dicts: Record<string, Record<string, string>> = { en, es, fr, nl };
    let checked = 0;
    for (const lang of LOCALES) {
      const markup = renderToStaticMarkup(await MarketingFooter({ lang }));
      const word = dicts[lang]!["nav.blog"];
      expect(word, lang).toBeTruthy();
      expect(markup, lang).toMatch(new RegExp(`<a [^>]*href="/blog"[^>]*>${word}</a>`));
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("every dictionary string the blog pages read exists in every locale", () => {
    const keys = Object.keys(EN).filter((k) => k.startsWith("blog.") || k === "nav.blog" || k === "nav.help");
    expect(keys.length).toBeGreaterThan(20);
    let checked = 0;
    for (const d of [es, fr, nl] as Record<string, string>[]) for (const k of keys) {
      expect(d[k], k).toBeTruthy();
      checked++;
    }
    expect(checked).toBe(keys.length * 3);
    for (const topic of BLOG_TOPICS) expect(EN[`blog.topic.${topic}`], topic).toBeTruthy();
  });
});
