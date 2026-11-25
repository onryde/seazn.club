import "server-only";
// /llms.txt's body (llmstxt.org): an H1, a one-line summary in a blockquote, then H2 sections of
// "- [title](absolute url): description". It lists the help centre and the blog, built from the same loaders and the same
// words their pages use, so a new article or post appears here with no edit. What it may list is what app/sitemap.ts lists
// under /help and /blog: app/llms.txt/__tests__/route.test.ts holds the two equal, and fails on any other page. Organiser,
// competition, player, token and app pages are never listed, and nothing here reads the database.
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import { blogUrl } from "@/lib/blog";
import { BLOG_INDEX_DESCRIPTION, BLOG_SITE_TITLE } from "@/lib/blog-seo";
import { familyDescription, FORMAT_GALLERY_DESCRIPTION, FORMAT_GALLERY_TITLE, HELP_DESCRIPTION } from "@/lib/help-seo";
import { allBlogPosts } from "@/server/blog-content";
import { allHelpArticles, HELP_SECTIONS, helpSectionLabel, type HelpArticle } from "@/server/help-content";

const SUMMARY =
  "Seazn Club runs tournaments and leagues for sports clubs. The help centre says how to do each thing; the blog explains how points, tie-breaks, draws and brackets work.";

interface Entry {
  title: string;
  /** A path on this site, from its leading slash. */
  path: string;
  description: string;
}

/** One line per page: a title's brackets are escaped, and no value may break the line. */
function line(origin: string, e: Entry): string {
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  const link = `- [${oneLine(e.title).replace(/[\\[\]]/g, "\\$&")}](${origin}${e.path})`;
  return e.description ? `${link}: ${oneLine(e.description)}` : link;
}

/** The help articles by section, in HELP_SECTIONS' order and each section's own page order. Grouped from the articles
 *  themselves, so a folder HELP_SECTIONS does not name yet is listed last and never dropped. */
function helpSections(): { heading: string; entries: Entry[] }[] {
  const articles = [...allHelpArticles().values()];
  const keys = new Set([...HELP_SECTIONS.map((s) => s.key), ...articles.map((a) => a.section)]);
  const order = (a: HelpArticle, b: HelpArticle) => a.order - b.order || a.title.localeCompare(b.title);
  return [...keys].map((key) => ({
    heading: `Help: ${helpSectionLabel(key)}`,
    entries: articles
      .filter((a) => a.section === key)
      .sort(order)
      .map((a) => ({ title: a.title, path: `/help/${a.slug}`, description: a.description })),
  }));
}

export function llmsTxt(origin: string): string {
  const sections: { heading: string; entries: Entry[] }[] = [
    { heading: "Help centre", entries: [{ title: "Help centre", path: "/help", description: HELP_DESCRIPTION }] },
    ...helpSections(),
    {
      heading: "Format guides",
      entries: [
        { title: FORMAT_GALLERY_TITLE, path: "/help/formats", description: FORMAT_GALLERY_DESCRIPTION },
        ...FORMAT_FAMILIES.map((f) => ({ title: f.title, path: `/help/formats/${f.slug}`, description: familyDescription(f) })),
      ],
    },
    {
      heading: "Blog",
      entries: [
        { title: BLOG_SITE_TITLE, path: "/blog", description: BLOG_INDEX_DESCRIPTION },
        ...allBlogPosts().map((p) => ({ title: p.title, path: blogUrl(p.slug), description: p.description })),
      ],
    },
  ];
  const blocks = sections
    .filter((s) => s.entries.length > 0)
    .map((s) => [`## ${s.heading}`, "", ...s.entries.map((e) => line(origin, e))].join("\n"));
  return `${["# Seazn Club", `> ${SUMMARY}`, ...blocks].join("\n\n")}\n`;
}
