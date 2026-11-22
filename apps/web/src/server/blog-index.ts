import "server-only";
// The index page's model: the posts grouped by topic (the closed topic order, not alphabetical), and one chip per
// sport that at least one post names. Pure given its label functions, so a test passes stubs and the page passes
// the product's own labels. The sport words come from blog/labels.ts, which is why this lives under server/: a page
// or component must not import that file (it pulls the dictionary into the module graph).
import { sportLabel } from "@/blog/labels";
import {
  BLOG_TOPICS, blogPostShowsFor, formatBlogDate,
  type BlogIndexGroup, type BlogIndexPost, type BlogSportChip, type BlogTopic,
} from "@/lib/blog";
import type { BlogPost } from "@/server/blog-content";

export interface BlogIndexModel {
  total: number;
  groups: BlogIndexGroup[];
  chips: BlogSportChip[];
}

export function blogIndexModel(
  posts: readonly BlogPost[],
  topicLabel: (topic: BlogTopic) => string,
  sport: (key: string) => string = sportLabel,
): BlogIndexModel {
  const row = (p: BlogPost): BlogIndexPost => ({
    slug: p.slug,
    title: p.title,
    date: p.date,
    dateLabel: formatBlogDate(p.date, "short"),
    sports: p.sports,
    tags: p.sports === "all" ? [] : p.sports.map(sport),
  });
  // `posts` arrives newest first (allBlogPosts); a topic keeps that order.
  const groups = BLOG_TOPICS.map((topic) => ({ topic, label: topicLabel(topic), posts: posts.filter((p) => p.topic === topic).map(row) })).filter(
    (g) => g.posts.length > 0,
  );
  const named = [...new Set(posts.flatMap((p) => (p.sports === "all" ? [] : p.sports)))];
  const chips = named
    .map((key) => ({ key, label: sport(key), count: posts.filter((p) => blogPostShowsFor(p, key)).length }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { total: posts.length, groups, chips };
}

/**
 * The posts a post's front-matter `related:` names, in that order, keeping only those that RESOLVE. A planned slug
 * (BLOG_PLANNED_SLUGS) is accepted by the content layer while the programme is written, but it is not a page: it never
 * becomes a card, so the page can never link to a 404.
 */
export function resolveBlogRelated(post: Pick<BlogPost, "related">, find: (slug: string) => BlogPost | null): BlogPost[] {
  return post.related.map(find).filter((p): p is BlogPost => p !== null);
}
