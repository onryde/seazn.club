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
// listed) is owned there; this file only decides how often it runs. The window
// and its override are parsed in lib/sitemap-window.ts, shared with the e2e
// spec and smoke.
import { unstable_cache } from "next/cache";
import { sitemapRevalidateSeconds } from "@/lib/sitemap-window";
import { listPublicSitemapEntries } from "./data";

/** Bump when the cached value's SHAPE changes: a live entry written under the
 *  old key would otherwise deserialise into the new reader as the old shape. */
export const SITEMAP_ENTRIES_CACHE_KEY = ["public-sitemap-entries-v1"];

/** `listPublicSitemapEntries`, cached. The cache JSON-serialises its value, so
 *  a reader sees a hit and a miss alike only for fields that are already JSON:
 *  the slugs and the slug array, which are all sitemap.ts reads. `updated`
 *  rides along unread (the sitemap states no lastmod): it is the driver's Date
 *  on a miss and a string on a hit, so a reader that ever wants it must first
 *  make the source return a string. */
export const cachedPublicSitemapEntries = unstable_cache(
  () => listPublicSitemapEntries(),
  SITEMAP_ENTRIES_CACHE_KEY,
  { revalidate: sitemapRevalidateSeconds() },
);
