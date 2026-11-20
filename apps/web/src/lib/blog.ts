// Blog link registry and post shape. Client-safe on purpose (no fs, no engine import): the nav, the
// index page and the footer import it. The reader of the files on disk is server/blog-content.ts, which
// also checks every key below against what it names (the sport registry, the help tree, the other posts).

/** The closed set of post topics (design: "Content: format and location"). */
export const BLOG_TOPICS = [
  "points",
  "tie-breaks",
  "swiss",
  "seeding",
  "round-robin",
  "groups",
  "knockout",
  "social",
  "ladder",
  "withdrawal",
  "forfeits",
] as const;
export type BlogTopic = (typeof BLOG_TOPICS)[number];

/** Meta-description length: the description is also the page's <meta name="description">. */
export const BLOG_DESCRIPTION_MIN = 50;
export const BLOG_DESCRIPTION_MAX = 160;

/** Every post is signed with this, never a person (owner, 2026-11-19). */
export const BLOG_AUTHOR = "Seazn" as const;

/**
 * An engine sport key ("football", "boardgame"). A plain string here because this file is client-safe
 * and must not import the engine; server/blog-content.ts checks each key against the sport registry.
 */
export type SportKey = string;

export interface BlogPostMeta {
  /** The file name without `.md`: lowercase words joined by hyphens. */
  slug: string;
  /** A question in organiser words; ends with "?". */
  title: string;
  /** The one-line answer; also the meta description. */
  description: string;
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** ISO `YYYY-MM-DD`, on or after `date`. */
  updated?: string;
  author: typeof BLOG_AUTHOR;
  topic: BlogTopic;
  sports: "all" | SportKey[];
  /** A help slug ("sports/chess") or "formats/<family>": the page that says how to do it in Seazn. */
  help: string;
  /** 2 to 4 other post slugs. */
  related: string[];
  /** Example ids the body uses, each exactly once. */
  examples: string[];
}

export const BLOG_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function blogUrl(slug: string): string {
  return `/blog/${slug}`;
}
