import { SPORT_PAGES } from "@/lib/marketing/sport-pages";
import type { MetadataRoute } from "next";
import { cachedPublicSitemapEntries } from "@/server/public-site/sitemap-cache";
import { liveGames } from "@/games/registry";
import { siteOrigin } from "@/lib/site-origin";
import { routes } from "@/lib/routes";
import { LOCALES } from "@/lib/i18n-constants";
import { localizedPath } from "@/lib/seo-meta";
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import { blogUrl } from "@/lib/blog";
import { allBlogPosts } from "@/server/blog-content";
import { allHelpArticles } from "@/server/help-content";

// Request-time, never prerendered. A sitemap.ts is "cached by default unless
// it uses a Request-time API or dynamic config option" (node_modules/next/dist/
// docs/01-app/03-api-reference/03-file-conventions/01-metadata/sitemap.md), so
// it used to be rendered at `next build` — which has no database — and
// production served that competition-less copy after every deploy. The DB
// read is cached instead (sitemap-cache.ts), so a
// crawler request inside the window runs no query.
export const dynamic = "force-dynamic";

const BASE = siteOrigin();

/**
 * A marketing page lives under /{lang}. The /en URL is listed, with one hreflang
 * alternate per locale (the fr/es/nl URLs are reachable from it). The unprefixed
 * form is never listed: it rewrites to a /{lang} page that canonicalises elsewhere.
 */
function marketing(path: string, extra: { changeFrequency: "hourly" | "weekly" | "monthly"; priority: number }): MetadataRoute.Sitemap[number] {
  return {
    url: `${BASE}${localizedPath("en", path)}`,
    ...extra,
    alternates: {
      languages: {
        ...Object.fromEntries(LOCALES.map((l) => [l, `${BASE}${localizedPath(l, path)}`])),
        "x-default": `${BASE}${localizedPath("en", path)}`,
      },
    },
  };
}

/**
 * /help and /blog are English-canonical trees outside /{lang}: one URL each, no hreflang. The help half was never listed
 * before the blog (the programme owed it). Posts carry the one honest timestamp the sitemap has, `updated ?? date`;
 * help articles have none, so they carry none (see the lastmod ruling below).
 */
function contentEntries(): MetadataRoute.Sitemap {
  return [
    { url: `${BASE}/help`, changeFrequency: "weekly", priority: 0.6 },
    ...[...allHelpArticles().keys()].map((slug) => ({ url: `${BASE}/help/${slug}`, changeFrequency: "monthly" as const, priority: 0.5 })),
    { url: `${BASE}/help/formats`, changeFrequency: "monthly", priority: 0.5 },
    ...FORMAT_FAMILIES.map((f) => ({ url: `${BASE}/help/formats/${f.slug}`, changeFrequency: "monthly" as const, priority: 0.5 })),
    { url: `${BASE}/blog`, changeFrequency: "weekly", priority: 0.7 },
    ...allBlogPosts().map((p) => ({
      url: `${BASE}${blogUrl(p.slug)}`,
      lastModified: p.updated ?? p.date,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = [
    marketing("", { changeFrequency: "weekly", priority: 1 }),
    marketing("/live", { changeFrequency: "hourly", priority: 0.9 }),
    marketing("/pricing", { changeFrequency: "monthly", priority: 0.9 }),
    marketing("/product/streaming", { changeFrequency: "monthly", priority: 0.8 }),
    marketing("/product/remote-scoring", { changeFrequency: "monthly", priority: 0.8 }),
    marketing("/product/format", { changeFrequency: "monthly", priority: 0.8 }),
    marketing("/product/scheduling", { changeFrequency: "monthly", priority: 0.8 }),
    marketing("/product/sponsoring", { changeFrequency: "monthly", priority: 0.8 }),
    marketing("/product/match-day", { changeFrequency: "monthly", priority: 0.8 }),
    marketing("/product/registration", { changeFrequency: "monthly", priority: 0.8 }),
    marketing("/sports", { changeFrequency: "monthly", priority: 0.8 }),
    ...SPORT_PAGES.map((sport) => marketing(`/sports/${sport}`, { changeFrequency: "monthly", priority: 0.8 })),
    { url: `${BASE}/games`, changeFrequency: "weekly", priority: 0.8 },
    ...liveGames().map((g) => ({
      url: `${BASE}/games/${g.slug}`,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    { url: `${BASE}/legal/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE}/legal/terms`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE}/legal/cookie-policy`, changeFrequency: "yearly", priority: 0.2 },
    { url: `${BASE}/legal/dpa`, changeFrequency: "yearly", priority: 0.2 },
    { url: `${BASE}/legal/sub-processors`, changeFrequency: "monthly", priority: 0.2 },
    ...contentEntries(),
  ];

  // Public competitions + their divisions (doc 09 §3 — `public` only;
  // unlisted stays out of the sitemap AND carries noindex). The DB may be
  // unreachable: fall back to the static set rather than a 500. A failed read
  // is not cached, so the next request tries again.
  //
  // No entry carries `lastModified` (owner ruling 2026-09-28). A competition's
  // only timestamp is created_at — there is no updated_at column — which is
  // not a modification time, and the request time moves on every fetch; either
  // would mislead a crawler. So `updated` from the source is not read here.
  let publicEntries: MetadataRoute.Sitemap = [];
  try {
    const competitions = await cachedPublicSitemapEntries();
    publicEntries = competitions.flatMap((c) => [
      {
        url: `${BASE}${routes.publicHub(c.orgSlug, c.compSlug)}`,
        changeFrequency: "hourly" as const,
        priority: 0.7,
      },
      ...c.divisionSlugs.map((div) => ({
        url: `${BASE}${routes.publicHub(c.orgSlug, c.compSlug, div)}`,
        changeFrequency: "hourly" as const,
        priority: 0.6,
      })),
    ]);
  } catch {
    // DB unreachable — static entries only, this request
  }


  return [...staticEntries, ...publicEntries];
}
