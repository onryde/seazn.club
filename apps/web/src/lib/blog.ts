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
  "streaming",
] as const;
export type BlogTopic = (typeof BLOG_TOPICS)[number];

/** Meta-description length: the description is also the page's <meta name="description">. */
export const BLOG_DESCRIPTION_MIN = 50;
export const BLOG_DESCRIPTION_MAX = 160;

/** A help page lists at most this many posts under "Read how it works". The content layer refuses a fourth on one page. */
export const BLOG_HELP_MAX = 3;

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
  /** Example ids the body uses, each exactly once. Empty only in a post that places art (blog/art.ts). */
  examples: string[];
}

export const BLOG_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function blogUrl(slug: string): string {
  return `/blog/${slug}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/**
 * An ISO `YYYY-MM-DD` the way a person reads it: "20 November 2026" (`long`) or "20 Nov 2026" (`short`).
 * Hand-built from the ISO parts, never `Intl`: the short month's spelling ("Sept" or "Sep") differs between ICU
 * releases, and a date is stated in UTC, so a reader in another time zone never sees the day before.
 */
export function formatBlogDate(iso: string, style: "long" | "short" = "long"): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  if (!m || !month) throw new Error(`blog date: '${iso}' is not YYYY-MM-DD`);
  return `${Number(m[3])} ${style === "short" ? month.slice(0, 3) : month} ${m[1]}`;
}

/** The dictionary key (marketing namespace) of a topic's name. */
export const blogTopicKey = (topic: BlogTopic): string => `blog.topic.${topic}`;

/** One post as the index draws it. Everything a reader sees is already text here. */
export interface BlogIndexPost {
  slug: string;
  title: string;
  /** ISO date, for the `datetime` attribute. */
  date: string;
  dateLabel: string;
  /** `"all"`: shown under every sport chip. */
  sports: "all" | SportKey[];
  /** The sport names the post is tagged with; empty for an every-sport post (the index prints one "Every sport" mark). */
  tags: string[];
}

export interface BlogIndexGroup {
  topic: BlogTopic;
  label: string;
  posts: BlogIndexPost[];
}

export interface BlogSportChip {
  key: SportKey;
  label: string;
  /** Posts shown under the chip: the ones that name the sport, and every every-sport post. */
  count: number;
}

/** The words the index island prints; resolved on the server from the marketing dictionary. */
export interface BlogIndexLabels {
  filterLabel: string;
  allSports: string;
  everySport: string;
  topics: string;
  postOne: string;
  postMany: string;
  empty: string;
  none: string;
}

/** Whether a post shows under a sport chip: a post for every sport shows under all of them. */
export function blogPostShowsFor(post: Pick<BlogIndexPost, "sports">, sport: SportKey): boolean {
  return post.sports === "all" || post.sports.includes(sport);
}
