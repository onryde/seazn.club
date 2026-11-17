// The crawler policy app/robots.ts renders. It lives here rather than in
// robots.ts because a metadata route's loader re-exports EVERY named export of
// its module into the generated route handler; robots.ts keeps only its
// default export, and the test reads this list instead of retyping it.

/**
 * AI search and assistant-fetch crawlers: ALLOWED, named explicitly so a future
 * blanket rule cannot silently exclude the site from answer engines. A crawler
 * that matches a named group ignores the `*` group, so app/robots.ts repeats the
 * private-path disallows on this group. PerplexityBot used to sit in
 * AI_CRAWLERS (fully refused), which removed the site from Perplexity answers.
 */
export const AI_SEARCH_CRAWLERS = [
  "OAI-SearchBot",
  "ChatGPT-User",
  "PerplexityBot",
  "Perplexity-User",
  "Claude-SearchBot",
  "Claude-User",
] as const;

/** Staging hosts (stg.seazn.club) are closed to crawlers; app/robots.ts and proxy.ts both decide through isStagingOrigin. */
export const STAGING_HOST_PREFIX = "stg.";

/** True when the configured site origin (env, never a request header a client can send) is a staging host. */
export function isStagingOrigin(origin: string): boolean {
  try {
    return new URL(origin).hostname.startsWith(STAGING_HOST_PREFIX);
  } catch {
    return false;
  }
}

/**
 * AI-training crawlers: ALLOWED the public site (owner, 2026-11-17: "Let's AI scrape our site"), with the private
 * paths closed like everyone else. Until then each carried a `Disallow: /` of its own. They stay NAMED so the choice
 * is explicit and reversible in one place. `Google-Extended` and `Applebot-Extended` are AI-use tokens only: they
 * never affected Googlebot or Applebot search crawling.
 *
 * robots.txt is half of it: Cloudflare can still block these user agents at the edge (a custom rule did, as of
 * 2026-11-17), and a blocked crawler never reads this file.
 */
export const AI_CRAWLERS = [
  "GPTBot",
  "ClaudeBot",
  "anthropic-ai",
  "CCBot",
  "Bytespider",
  "Amazonbot",
  "Google-Extended",
  "Applebot-Extended",
  "cohere-ai",
  "Diffbot",
  "ImagesiftBot",
] as const;
