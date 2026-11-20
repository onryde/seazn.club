// The RSS 2.0 feed (/blog/rss.xml): one <item> per post, newest first. The description is the post's own front-matter
// description, never a rendering of the body (the body carries example tables a feed reader cannot draw). Pure: the
// route passes the posts and the origin, a test passes fixtures.
import { BLOG_AUTHOR, blogUrl, type BlogPostMeta } from "@/lib/blog";
import { BLOG_FEED_PATH, BLOG_INDEX_DESCRIPTION, BLOG_SITE_TITLE } from "@/lib/blog-seo";

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** A post's date as RFC 822, at midnight UTC: the date is all a post has. */
export function rssDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`rss: '${iso}' is not a date`);
  return d.toUTCString();
}

export function blogRssXml(posts: readonly BlogPostMeta[], origin: string): string {
  const items = posts
    .map((p) => {
      const link = `${origin}${blogUrl(p.slug)}`;
      return [
        "    <item>",
        `      <title>${xml(p.title)}</title>`,
        `      <link>${xml(link)}</link>`,
        `      <guid isPermaLink="true">${xml(link)}</guid>`,
        `      <pubDate>${rssDate(p.date)}</pubDate>`,
        `      <dc:creator>${xml(BLOG_AUTHOR)}</dc:creator>`,
        `      <description>${xml(p.description)}</description>`,
        "    </item>",
      ].join("\n");
    })
    .join("\n");
  // The latest date any post carries, not the build time: the same posts always give the same bytes.
  const latest = posts.map((p) => p.updated ?? p.date).sort().at(-1);
  const built = latest ? `\n    <lastBuildDate>${rssDate(latest)}</lastBuildDate>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${xml(BLOG_SITE_TITLE)}</title>
    <link>${xml(`${origin}/blog`)}</link>
    <description>${xml(BLOG_INDEX_DESCRIPTION)}</description>
    <language>en</language>${built}
    <atom:link href="${xml(`${origin}${BLOG_FEED_PATH}`)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;
}
