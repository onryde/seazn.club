import "server-only";
// Every `/help/...` and `/blog/...` link a post's own text carries must land on a page that exists. Front-matter keys
// are checked by the content layer (blog-content.ts); a link typed into the body is not, and the help tree is
// rewritten on another branch, so a moved page would leave a dead link no test noticed. The post page calls
// `assertBlogLinks` while it renders, which makes a dead link a BUILD failure (generateStaticParams renders every
// post), and blog-links.test.ts runs the same check over every post on disk.
//
// A link is the target of Markdown `[text](/help/...)`, an HTML `href="/help/..."` or a reference definition. The path decides; a `#fragment`
// is not checked (a heading's id moves with its text, and help's ids are P1's to own).
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import { blogUrl } from "@/lib/blog";
import { helpUrl } from "@/lib/help";
import { allBlogPosts, type BlogPost } from "@/server/blog-content";

// Three spellings of a link: inline `[t](target)`, an HTML `href`, and a reference definition `[ref]: target` on its own
// line. The target may carry this site's own origin (an absolute link to our own page is still a link to check); another
// site's /help/... is somebody else's page and is left alone.
const LINK = /(?:\]\(\s*|href=["']|^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*<?)(?:https?:\/\/(?:www\.)?seazn\.club)?(\/(?:help|blog)(?:[/?#][^)\s"'>]*)?)(?=[)\s"'>]|$)/gm;

// A picture, `![alt](/help/blog/x.webp "Caption")`. Its target is a FILE under public/, not a page: the help renderer
// refuses a picture that is missing, not a webp or over budget (help-figures.ts, and every post is rendered in
// blog-tree.test.ts), so the link check leaves it alone rather than ask the help registry for a page named x.webp.
const PICTURE = /!\[[^\]\n]*\]\([^)\n]*\)/g;

/** The `/help` and `/blog` targets a body links to, as written (query and fragment kept). A picture's target is not one. */
export function blogBodyLinks(markdown: string): string[] {
  return [...markdown.replace(PICTURE, " ").matchAll(LINK)].map((m) => m[1]!);
}

export interface LinkResolvers {
  /** A help path ("/help/formats/knockout") that is a page. */
  help(path: string): boolean;
  /** A post slug that is a post. */
  post(slug: string): boolean;
}

/** The real resolvers: the help registry, the format gallery's families, and the posts on disk. */
export function liveLinkResolvers(posts: readonly Pick<BlogPost, "slug">[] = allBlogPosts()): LinkResolvers {
  const slugs = new Set(posts.map((p) => p.slug));
  return {
    help(path) {
      const slug = path.replace(/^\/help\/?/, "");
      // The help home and the format gallery's overview are pages with no article behind them.
      if (slug === "" || slug === "formats") return true;
      if (slug.startsWith("formats/")) return FORMAT_FAMILIES.some((f) => `formats/${f.slug}` === slug);
      return helpUrl(slug) === `/help/${slug}`;
    },
    post: (slug) => slugs.has(slug),
  };
}

/** One message per dead link; none when every link resolves. */
export function blogLinkProblems(markdown: string, resolve: LinkResolvers): string[] {
  const problems: string[] = [];
  for (const link of blogBodyLinks(markdown)) {
    const path = link.split(/[?#]/)[0]!.replace(/(.)\/$/, "$1");
    if (path === "/blog") continue;
    if (path.startsWith("/blog/")) {
      const slug = path.slice("/blog/".length);
      if (!resolve.post(slug)) problems.push(`${link}: there is no post '${slug}'`);
    } else if (!resolve.help(path)) {
      problems.push(`${link}: there is no such help page`);
    }
  }
  return problems;
}

/** Throws, naming the post and each dead link. */
export function assertBlogLinks(post: Pick<BlogPost, "slug" | "markdown">, resolve: LinkResolvers = liveLinkResolvers()): void {
  const problems = blogLinkProblems(post.markdown, resolve);
  if (problems.length > 0) throw new Error(`${blogUrl(post.slug)}: dead link in the body: ${problems.join("; ")}`);
}
