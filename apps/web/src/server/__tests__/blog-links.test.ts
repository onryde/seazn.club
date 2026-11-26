// Links typed into a post's body. The front-matter keys are checked by the content layer; a `/help/...` or `/blog/...`
// link in the prose is not, and the help tree is rewritten on another branch. blog-links.ts checks each one resolves, and the
// post page runs that check at build, so a dead link fails the build.
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ override: null as null | { slug: string; markdown: string } }));
vi.mock("@/server/blog-content", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/blog-content")>();
  return {
    ...real,
    blogPost: (slug: string) => {
      const post = real.blogPost(slug);
      return post && h.override && h.override.slug === slug ? { ...post, markdown: h.override.markdown } : post;
    },
  };
});

// The post page's serif is next/font, which only exists inside a Next build.
vi.mock("next/font/google", () => ({ Source_Serif_4: () => ({ variable: "--reading-serif", className: "" }) }));

import BlogPostPage from "@/app/blog/[slug]/page";
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import { allBlogPosts, BLOG_PLANNED_SLUGS } from "@/server/blog-content";
import { allHelpArticles } from "@/server/help-content";
import { assertBlogLinks, blogBodyLinks, blogLinkProblems, liveLinkResolvers, type LinkResolvers } from "../blog-links";

const stub: LinkResolvers = { help: (p) => p === "/help/divisions/settings" || p === "/help", post: (s) => s === "how-standings-points-work" };

describe("which links are read", () => {
  it("takes Markdown targets and href attributes under /help and /blog, and nothing that only starts like them", () => {
    const md = [
      "See [the help](/help/divisions/settings), [a post](/blog/how-standings-points-work#reading) and [home](/help).",
      '<a href="/blog/x">x</a> [titled](/help/a "a title") [out](https://example.com/help/zzz) [near](/helpdesk) [near2](/blogs/zz) [bare](/blog)',
      "A bare /help/not-a-link in prose is text, not a link.",
    ].join("\n");
    expect(blogBodyLinks(md)).toEqual(["/help/divisions/settings", "/blog/how-standings-points-work#reading", "/help", "/blog/x", "/help/a", "/blog"]);
  });
});

describe("a picture is a file, not a link", () => {
  it("skips a picture's target (with or without a caption) and still reads a link on either side of it", () => {
    const md = [
      "See [the help](/help/divisions/settings).",
      "",
      '![A stage card](/help/blog/some-post-1.webp "A caption")',
      "",
      "![No caption](/help/blog/some-post-2.webp)",
      "",
      "And [a post](/blog/how-standings-points-work).",
    ].join("\n");
    expect(blogBodyLinks(md)).toEqual(["/help/divisions/settings", "/blog/how-standings-points-work"]);
    expect(blogLinkProblems(md, stub)).toEqual([]);
  });

  it("every picture the real posts carry is skipped, and there are some (anti-vacuity)", () => {
    const posts = allBlogPosts();
    let pictures = 0;
    for (const p of posts) {
      const found = [...p.markdown.matchAll(/!\[[^\]\n]*\]\(([^)\s]+)/g)].map((m) => m[1]!);
      pictures += found.length;
      for (const f of found) expect(blogBodyLinks(p.markdown), `${p.slug}: ${f}`).not.toContain(f);
    }
    expect(pictures, "pictures in the posts").toBeGreaterThanOrEqual(5);
  });
});

describe("the other spellings of a link", () => {
  it("reads an absolute link to our own origin and a reference-style definition, and still skips another site's /help", () => {
    const md = [
      "[abs](https://seazn.club/help/divisions/settings#x) [www](https://www.seazn.club/blog/a-post) [other](https://example.com/help/zzz)",
      "[lookalike](https://seazn.club.evil.example/help/zzz)",
      "See [the guide][g] and [another][b].",
      "",
      "[g]: /help/divisions/settings",
      "  [b]: <https://seazn.club/blog/never-written> \"title\"",
      "[ext]: https://example.com/help/zzz",
    ].join("\n");
    expect(blogBodyLinks(md)).toEqual(["/help/divisions/settings#x", "/blog/a-post", "/help/divisions/settings", "/blog/never-written"]);
  });

  it("a dead link in either spelling fails the check", () => {
    const problems = blogLinkProblems("[a](https://seazn.club/help/gone)\n\n[r]: /blog/never-written", stub);
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).toContain("/help/gone");
    expect(problems.join(" ")).toContain("never-written");
  });
});

describe("which links resolve", () => {
  it("passes live links (fragment, query and trailing slash ignored; the blog index is always there)", () => {
    const md = "[a](/help/divisions/settings#top) [b](/blog/how-standings-points-work/) [c](/help) [d](/blog) [e](/help?x=1)";
    expect(blogLinkProblems(md, stub)).toEqual([]);
  });

  it("names each dead link, help and blog alike, and says which kind it is", () => {
    const problems = blogLinkProblems("[a](/help/gone/page) [b](/blog/never-written) [c](/help/divisions/settings)", stub);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("/help/gone/page");
    expect(problems[0]).toContain("no such help page");
    expect(problems[1]).toContain("/blog/never-written");
    expect(problems[1]).toContain("no post 'never-written'");
  });

  it("assertBlogLinks throws naming the post and every dead link; a clean post does not throw", () => {
    expect(() => assertBlogLinks({ slug: "p", markdown: "[a](/help/gone) [b](/blog/gone)" }, stub)).toThrow(/\/blog\/p: dead link in the body: .*\/help\/gone.*\/blog\/gone/s);
    expect(() => assertBlogLinks({ slug: "p", markdown: "[a](/help)" }, stub)).not.toThrow();
  });
});

describe("the real resolvers", () => {
  const live = liveLinkResolvers();
  it("a help article, the help home, the formats overview and each family resolve; an invented page, a bad family and a bare section do not", () => {
    const articles = [...allHelpArticles().keys()];
    expect(articles.length, "premise: there are articles").toBeGreaterThan(20);
    for (const slug of articles) expect(live.help(`/help/${slug}`), slug).toBe(true);
    expect(live.help("/help")).toBe(true);
    expect(live.help("/help/formats")).toBe(true);
    expect(FORMAT_FAMILIES.length).toBeGreaterThan(3);
    for (const f of FORMAT_FAMILIES) expect(live.help(`/help/formats/${f.slug}`), f.slug).toBe(true);
    expect(live.help("/help/formats/not-a-family")).toBe(false);
    expect(live.help("/help/nothing/here")).toBe(false);
    expect(live.help("/help/divisions")).toBe(false);
  });
  it("only posts that exist are posts", () => {
    const posts = allBlogPosts();
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) expect(live.post(p.slug), p.slug).toBe(true);
    // A planned slug (named in `related:` while the programme is written) is NOT a page, so a body link to it is dead.
    expect(BLOG_PLANNED_SLUGS.size, "anti-vacuity: planned slugs").toBeGreaterThan(0);
    for (const planned of BLOG_PLANNED_SLUGS) expect(live.post(planned), planned).toBe(false);
  });
});

describe("every post on disk", () => {
  it("has no dead link in its body (counts the posts scanned)", () => {
    const posts = allBlogPosts();
    let scanned = 0;
    for (const p of posts) {
      expect(blogLinkProblems(p.markdown, liveLinkResolvers(posts)), p.slug).toEqual([]);
      scanned++;
    }
    expect(scanned).toBe(posts.length);
    expect(scanned, "anti-vacuity: posts scanned").toBeGreaterThan(0);
    // The pilot links nothing in its body, so "links checked" can be zero today; what proves the check bites is the cases
    // above (stub and real resolvers) and the page test below, which feeds a real post a dead link.
  });
});

describe("the post page runs the check, so a dead link fails the build", () => {
  const slug = "how-standings-points-work";
  const real = allBlogPosts().find((p) => p.slug === slug)!;
  it("renders with live links and throws with a dead one", async () => {
    h.override = { slug, markdown: `${real.markdown}\n\nSee [the setup page](/help/divisions/settings).\n` };
    await expect(BlogPostPage({ params: Promise.resolve({ slug }) })).resolves.toBeTruthy();
    h.override = { slug, markdown: `${real.markdown}\n\nSee [a page](/help/no/such-page).\n` };
    await expect(BlogPostPage({ params: Promise.resolve({ slug }) })).rejects.toThrow(/dead link in the body: \/help\/no\/such-page/);
    h.override = { slug, markdown: `${real.markdown}\n\nSee [a post](/blog/not-written-yet).\n` };
    await expect(BlogPostPage({ params: Promise.resolve({ slug }) })).rejects.toThrow(/no post 'not-written-yet'/);
    h.override = null;
  });
});
