import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { JsonLd } from "@/components/seo/json-ld";
import { BlogPostView } from "@/components/blog/blog-post-view";
import { readingSerif } from "@/components/reading/reading-serif";
import { blogTopicKey, blogUrl, formatBlogDate } from "@/lib/blog";
import { blogPostBreadcrumbLd, blogPostMetadata, blogPostingLd } from "@/lib/blog-seo";
import { getDictionary, t } from "@/lib/i18n";
import { allBlogPosts, blogHelpHref, blogPost } from "@/server/blog-content";
import { resolveBlogRelated } from "@/server/blog-index";
import { assertBlogLinks } from "@/server/blog-links";
import { renderBlogPost } from "@/server/blog-render";

// An unknown slug is a 404, never a render (`dynamicParams = false`); every post is prerendered at build, which is also
// where a dead body link, an unresolved fact token or a leftover `{{` fails the build (assertBlogLinks, renderBlogPost).
export const dynamic = "error";
export const revalidate = 3600;
export const dynamicParams = false;


type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams(): { slug: string }[] {
  return allBlogPosts().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = blogPost(slug);
  return post ? blogPostMetadata(post) : {};
}

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params;
  const post = blogPost(slug);
  if (!post) notFound();
  assertBlogLinks(post);
  const [{ parts }, d] = await Promise.all([renderBlogPost(post), getDictionary("en", "marketing")]);

  // "How Seazn handles it" comes from the front-matter, after the body: a help page the registry does not know leaves no
  // section and no dead link.
  const helpHref = blogHelpHref(post.help);
  const handles = {
    href: helpHref,
    title: t(d, "blog.post.handlesTitle"),
    body: t(d, "blog.post.handlesBody"),
    linkLabel: t(d, "blog.post.handlesLink"),
  };
  const related = resolveBlogRelated(post, blogPost).map((r) => ({ href: blogUrl(r.slug), title: r.title, topic: t(d, blogTopicKey(r.topic)) }));

  return (
    <main className={readingSerif.variable}>
      <JsonLd data={blogPostingLd(post)} />
      <JsonLd data={blogPostBreadcrumbLd(post)} />
      <BlogPostView
        title={post.title}
        answer={post.description}
        date={post.date}
        dateLabel={formatBlogDate(post.date)}
        updated={post.updated}
        updatedLabel={post.updated ? t(d, "blog.post.updated", { date: formatBlogDate(post.updated) }) : undefined}
        topicLabel={t(d, blogTopicKey(post.topic))}
        parts={parts}
        handles={handles}
        related={related}
        labels={{ blog: t(d, "nav.blog"), related: t(d, "blog.post.related"), swipe: t(d, "blog.example.swipe") }}
      />
    </main>
  );
}
