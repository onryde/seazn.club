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

/** Staging hosts (stg.seazn.club) are closed to crawlers; app/proxy.ts keys its noindex header on the same prefix. */
export const STAGING_HOST_PREFIX = "stg.";

/**
 * AI-training and answer-engine crawlers, each refused the whole site with a
 * rule of its own. Search engines (Googlebot, Bingbot) and link-preview bots
 * (facebookexternalhit, WhatsApp, Twitterbot, Slackbot, TelegramBot,
 * Discordbot, LinkedInBot) are deliberately NOT listed: they fall under the
 * `*` rule, so shared links keep their previews and public pages stay indexed.
 * `Google-Extended` and `Applebot-Extended` are opt-out tokens for AI use
 * only — blocking them does not touch Googlebot or Applebot search crawling.
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
