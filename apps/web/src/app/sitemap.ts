import type { MetadataRoute } from "next";
import { cachedPublicSitemapEntries } from "@/server/public-site/sitemap-cache";
import { listDiscoverySports } from "@/server/public-site/discovery";
import { liveGames } from "@/games/registry";
import { siteOrigin } from "@/lib/site-origin";

// Request-time, never prerendered. A sitemap.ts is "cached by default unless
// it uses a Request-time API or dynamic config option" (node_modules/next/dist/
// docs/01-app/03-api-reference/03-file-conventions/01-metadata/sitemap.md), so
// it used to be rendered at `next build` — which has no database — and
// production served that competition-less copy after every deploy. The DB
// reads are cached instead (sitemap-cache.ts, listDiscoverySports), so a
// crawler request inside the window runs no query.
export const dynamic = "force-dynamic";

const BASE = siteOrigin();

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = [
    { url: BASE, changeFrequency: "weekly", priority: 1 },
    { url: `${BASE}/discover`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${BASE}/live`, changeFrequency: "hourly", priority: 0.8 },
    { url: `${BASE}/pricing`, changeFrequency: "monthly", priority: 0.9 },
    { url: `${BASE}/games`, changeFrequency: "weekly", priority: 0.8 },
    ...liveGames().map((g) => ({
      url: `${BASE}/games/${g.slug}`,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    { url: `${BASE}/use-cases/clubs`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/use-cases/events`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/use-cases/schools`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/legal/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE}/legal/terms`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE}/legal/cookie-policy`, changeFrequency: "yearly", priority: 0.2 },
    { url: `${BASE}/legal/dpa`, changeFrequency: "yearly", priority: 0.2 },
    { url: `${BASE}/legal/sub-processors`, changeFrequency: "monthly", priority: 0.2 },
  ];

  // Public competitions + their divisions (doc 09 §3 — `public` only;
  // unlisted stays out of the sitemap AND carries noindex). The DB may be
  // unreachable: fall back to the static set rather than a 500. A failed read
  // is not cached, so the next request tries again.
  //
  // `lastModified` is the competition's own timestamp, on its hub and its
  // divisions alike, never the request time: a lastmod that moves on every
  // fetch tells a crawler nothing, and teaches it to ignore the field. Static
  // pages carry none at all. (`updated` is the competition's created_at —
  // competitions have no updated_at column — as an ISO string.)
  let publicEntries: MetadataRoute.Sitemap = [];
  try {
    const competitions = await cachedPublicSitemapEntries();
    publicEntries = competitions.flatMap((c) => [
      {
        url: `${BASE}/shared/${c.orgSlug}/${c.compSlug}`,
        lastModified: c.updated,
        changeFrequency: "hourly" as const,
        priority: 0.7,
      },
      ...c.divisionSlugs.map((div) => ({
        url: `${BASE}/shared/${c.orgSlug}/${c.compSlug}/${div}`,
        lastModified: c.updated,
        changeFrequency: "hourly" as const,
        priority: 0.6,
      })),
    ]);
  } catch {
    // DB unreachable — static entries only, this request
  }

  // Per-sport discovery landings (doc 15 §2): only sports that currently have
  // discoverable competitions — no empty SEO shells.
  let sportEntries: MetadataRoute.Sitemap = [];
  try {
    const sports = await listDiscoverySports();
    sportEntries = sports.map((s) => ({
      url: `${BASE}/discover/${s.key}`,
      changeFrequency: "hourly" as const,
      priority: 0.8,
    }));
  } catch {
    // DB unreachable — no sport landings, this request
  }

  return [...staticEntries, ...sportEntries, ...publicEntries];
}
