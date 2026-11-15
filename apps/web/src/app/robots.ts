import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site-origin";
import { AI_CRAWLERS, AI_SEARCH_CRAWLERS, STAGING_HOST_PREFIX } from "@/lib/robots-policy";
import { routes } from "@/lib/routes";

// Keyed on the staging prefix, not "anything but seazn.club": a wrong or missing
// origin env on production must fail OPEN (indexable), never close the live site.
function isStaging(origin: string): boolean {
  try {
    return new URL(origin).hostname.startsWith(STAGING_HOST_PREFIX);
  } catch {
    return false;
  }
}

export default function robots(): MetadataRoute.Robots {
  const origin = siteOrigin();
  // Staging and previews: closed to every crawler. robots.txt alone does not
  // drop pages already indexed, so staging also wants an X-Robots-Tag header.
  if (isStaging(origin)) {
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
      { userAgent: "*", allow: ["/", "/pricing", "/use-cases/", "/legal/"], disallow: PRIVATE },
      // Named AI search crawlers ignore the `*` group, so they carry the private paths too.
      { userAgent: [...AI_SEARCH_CRAWLERS], allow: "/", disallow: PRIVATE },
      // One rule per AI crawler, refusing the whole site (see AI_CRAWLERS).
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, disallow: "/" })),
    ],
    sitemap: `${origin}/sitemap.xml`,
  };
}
