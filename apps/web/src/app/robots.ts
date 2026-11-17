import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site-origin";
import { AI_CRAWLERS, AI_SEARCH_CRAWLERS, isStagingOrigin } from "@/lib/robots-policy";
import { routes } from "@/lib/routes";

// Request-time, never prerendered: the staging/production decision reads the
// origin env, and a build-time copy would freeze whatever origin the BUILD saw
// (same reason as sitemap.ts).
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const origin = siteOrigin();
  // Staging (a `stg.` origin): closed to every crawler. robots.txt alone does not
  // drop pages already indexed, so staging also wants an X-Robots-Tag header.
  // Fails OPEN: an unrecognised origin env never closes production.
  if (isStagingOrigin(origin)) {
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  }
  const PRIVATE = [
          "/o/", "/dashboard", "/admin", "/api/", "/settings", "/competitions/", "/divisions/", "/fixtures/", "/directory", "/streaming", "/players", "/people", "/clubs", "/orgs/",
          // PostHog's first-party proxy (next.config.js rewrites): beacons, not pages.
          "/ingest/",
          // Public player profiles, /live/{org}/{competition}/players/{personId}
          // (routes.publicPlayer): a named person's page. `*` is the Google/Bing
          // path wildcard. An old /shared/… profile URL 308s here, and a crawler
          // checks the target against these rules.
          routes.publicPlayer("*", "*", ""),
  ];
  return {
    rules: [
      { userAgent: "*", allow: ["/", "/pricing", "/product/", "/sports/", "/legal/"], disallow: PRIVATE },
      // Named AI crawlers — search and training alike (owner, 2026-11-17) — are allowed the public site. A crawler
      // that matches a named group ignores the `*` group, so they carry the private paths too.
      { userAgent: [...AI_SEARCH_CRAWLERS, ...AI_CRAWLERS], allow: "/", disallow: PRIVATE },
    ],
    sitemap: `${origin}/sitemap.xml`,
  };
}
