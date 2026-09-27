// The sitemap's competition read, behind Next's data cache.
//
// app/sitemap.ts is request-time (`dynamic = "force-dynamic"`): prerendering it
// at `next build` froze the build's answer, and the build has no database, so
// production served a sitemap with no competition in it after every deploy.
// Request-time on its own would put a query behind every crawler hit, so the
// read is cached here instead — "unstable_cache for non-fetch functions" with a
// `revalidate` window, per node_modules/next/dist/docs/01-app/02-guides/
// caching-without-cache-components.md. A read that throws is not cached, so a
// DB error costs one request its competitions (sitemap.ts falls back to the
// static routes) and never pins an empty list for the whole window.
//
// Kept out of data.ts on purpose: the query itself (which competitions are
// listed) is owned there; this file only decides how often it runs.
import { unstable_cache } from "next/cache";
import { listPublicSitemapEntries } from "./data";

/** Shipped cache window for the sitemap's competition read: about an hour. */
export const SITEMAP_REVALIDATE_SECONDS = 3600;

/** Bump when the cached value's SHAPE changes: a live entry written under the
 *  old key would otherwise deserialise into the new reader as the old shape. */
export const SITEMAP_ENTRIES_CACHE_KEY = ["public-sitemap-entries-v1"];

/**
 * The window in force: `SITEMAP_REVALIDATE_SECONDS` from the environment when
 * it is a positive integer, the shipped default for anything else (unset,
 * empty, zero, negative, fractional, junk). The override exists so an e2e or
 * smoke server can prove a pick-up in seconds; production sets nothing.
 */
export function sitemapRevalidateSeconds(raw: string | undefined = process.env.SITEMAP_REVALIDATE_SECONDS): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : SITEMAP_REVALIDATE_SECONDS;
}

/** `listPublicSitemapEntries`, cached. The cache JSON-serialises its value;
 *  slugs and the slug array survive that as they are, and `updated` (which
 *  sitemap.ts does not read) comes back as a string whatever the driver gave. */
export const cachedPublicSitemapEntries = unstable_cache(
  () => listPublicSitemapEntries(),
  SITEMAP_ENTRIES_CACHE_KEY,
  { revalidate: sitemapRevalidateSeconds() },
);
