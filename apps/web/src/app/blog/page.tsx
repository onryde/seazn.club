import type { Metadata } from "next";
import { JsonLd } from "@/components/seo/json-ld";
import { BlogIndex } from "@/components/blog/blog-index";
import { blogTopicKey, type BlogIndexLabels } from "@/lib/blog";
import { blogIndexLd, blogIndexMetadata } from "@/lib/blog-seo";
import { getDictionary, t } from "@/lib/i18n";
import { allBlogPosts } from "@/server/blog-content";
import { blogIndexModel } from "@/server/blog-index";

export const dynamic = "error";
export const revalidate = 3600;

export const metadata: Metadata = blogIndexMetadata();

export default async function BlogIndexPage() {
  const d = await getDictionary("en", "marketing");
  const posts = allBlogPosts();
  const model = blogIndexModel(posts, (topic) => t(d, blogTopicKey(topic)));
  const labels: BlogIndexLabels = {
    filterLabel: t(d, "blog.index.filterLabel"),
    allSports: t(d, "blog.index.allSports"),
    everySport: t(d, "blog.index.everySport"),
    topics: t(d, "blog.index.topics"),
    postOne: t(d, "blog.index.postOne"),
    postMany: t(d, "blog.index.postMany"),
    empty: t(d, "blog.index.empty"),
    none: t(d, "blog.index.none"),
  };
  return (
    <main>
      <JsonLd data={blogIndexLd(posts)} />
      <header className="max-w-2xl">
        <h1 className="mk-display text-[40px] font-bold leading-none tracking-wide text-slate-900 md:text-[52px]">{t(d, "blog.index.title")}</h1>
        <p className="mt-3 text-base leading-relaxed text-slate-600">{t(d, "blog.index.lede")}</p>
      </header>
      <BlogIndex groups={model.groups} chips={model.chips} total={model.total} labels={labels} />
    </main>
  );
}
