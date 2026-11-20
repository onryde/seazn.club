// The blog's <head>: titles, share cards, structured data and the feed link, built from a post's front-matter by one
// pure function each so a test reads what a page declares without rendering it. Client-safe (no fs, no engine).
import type { Metadata } from "next";
import { breadcrumbLd, organizationLd } from "@/components/seo/json-ld";
import { BLOG_AUTHOR, blogUrl, type BlogPostMeta } from "@/lib/blog";
import { siteOrigin } from "@/lib/site-origin";

/** The same form as help's "%s — Seazn Club Help" (app/help/layout.tsx). */
export const BLOG_TITLE_TEMPLATE = "%s — Seazn Club Blog";
export const BLOG_SITE_TITLE = "Seazn Club Blog";
export const BLOG_INDEX_TITLE = "Seazn Club Blog — how points, tie-breaks and brackets work";
export const BLOG_INDEX_DESCRIPTION =
  "How points, tie-breaks, draws and brackets work in Seazn, sport by sport. Written for organisers.";
export const BLOG_FEED_PATH = "/blog/rss.xml";

/** `<link rel="alternate" type="application/rss+xml">`: a page's own `alternates` replaces its layout's, so each page spells it. */
const feedAlternate = { "application/rss+xml": BLOG_FEED_PATH };

export function blogIndexMetadata(): Metadata {
  return {
    title: { absolute: BLOG_INDEX_TITLE },
    description: BLOG_INDEX_DESCRIPTION,
    alternates: { canonical: "/blog", types: feedAlternate },
    openGraph: { type: "website", siteName: "Seazn Club", title: BLOG_SITE_TITLE, description: BLOG_INDEX_DESCRIPTION, url: "/blog" },
    twitter: { card: "summary_large_image", title: BLOG_SITE_TITLE, description: BLOG_INDEX_DESCRIPTION },
  };
}

export function blogPostMetadata(post: BlogPostMeta): Metadata {
  const url = blogUrl(post.slug);
  return {
    title: post.title,
    description: post.description,
    alternates: { canonical: url, types: feedAlternate },
    openGraph: {
      type: "article",
      siteName: "Seazn Club",
      title: post.title,
      description: post.description,
      url,
      publishedTime: post.date,
      ...(post.updated ? { modifiedTime: post.updated } : {}),
      authors: [BLOG_AUTHOR],
    },
    twitter: { card: "summary_large_image", title: post.title, description: post.description },
  };
}

/** The author is the organisation, never a person (owner, 2026-11-19). */
const author = { "@type": "Organization", name: BLOG_AUTHOR } as const;

function publisher() {
  const org = organizationLd();
  return { "@type": org["@type"], name: org.name, url: org.url, logo: org.logo };
}

export function blogPostingLd(post: BlogPostMeta) {
  const url = `${siteOrigin()}${blogUrl(post.slug)}`;
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    datePublished: post.date,
    dateModified: post.updated ?? post.date,
    author,
    publisher: publisher(),
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    url,
  };
}

export function blogPostBreadcrumbLd(post: BlogPostMeta) {
  return breadcrumbLd([
    { name: "Blog", path: "/blog" },
    { name: post.title, path: blogUrl(post.slug) },
  ]);
}

export function blogIndexLd(posts: readonly BlogPostMeta[]) {
  const origin = siteOrigin();
  return {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: BLOG_SITE_TITLE,
    description: BLOG_INDEX_DESCRIPTION,
    url: `${origin}/blog`,
    publisher: publisher(),
    blogPost: posts.map((p) => ({
      "@type": "BlogPosting",
      headline: p.title,
      url: `${origin}${blogUrl(p.slug)}`,
      datePublished: p.date,
      author,
    })),
  };
}

/** A question is long: the type steps down until it fits the card's 1072px box in at most four lines. */
export function blogOgTitleSize(title: string): number {
  return title.length <= 50 ? 68 : title.length <= 80 ? 58 : title.length <= 110 ? 50 : 42;
}

