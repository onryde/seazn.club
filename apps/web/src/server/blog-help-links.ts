import "server-only";
// The "Read how it works" list at the foot of a help page: the posts whose front-matter `help:` names the page. It is
// handed to the page BESIDE the help `related` list and never through help front-matter (help-related.ts refuses a slug
// that is not a help page, and keeps doing so). Static on purpose: the help routes are prerendered (dynamic = "error"),
// so nothing here may read a cookie, a header or the session. The words come from the English dictionary, as the blog's
// own frame does (posts are English only).
import type { HelpBlogLinks } from "@/components/help/help-related";
import { BLOG_HELP_MAX, blogTopicKey, blogUrl } from "@/lib/blog";
import { getDictionary, t } from "@/lib/i18n";
import { blogNewestFirst, blogPostsForHelp } from "@/server/blog-content";

/** The list for one help page (a help slug, `formats/<family>` or `formats/overview`); null when no post names it, so no empty heading. */
export async function helpBlogLinks(helpSlug: string): Promise<HelpBlogLinks | null> {
  const posts = blogPostsForHelp(helpSlug).sort(blogNewestFirst).slice(0, BLOG_HELP_MAX);
  if (posts.length === 0) return null;
  const d = await getDictionary("en", "marketing");
  return {
    title: t(d, "blog.help.title"),
    posts: posts.map((p) => ({ href: blogUrl(p.slug), title: p.title, meta: `${t(d, "nav.blog")}, ${t(d, blogTopicKey(p.topic))}` })),
  };
}
