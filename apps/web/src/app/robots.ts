import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site-origin";
import { AI_CRAWLERS } from "@/lib/robots-policy";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/pricing", "/use-cases/", "/legal/"],
        disallow: [
          "/o/", "/dashboard", "/admin", "/api/", "/settings", "/competitions/", "/divisions/", "/fixtures/", "/directory", "/players", "/people", "/clubs", "/orgs/",
          // PostHog's first-party proxy (next.config.js rewrites): beacons, not pages.
          "/ingest/",
          // Public player profiles, /shared/{org}/{competition}/players/{personId}:
          // a named person's page. `*` is the Google/Bing path wildcard.
          "/shared/*/*/players/",
        ],
      },
      // One rule per AI crawler, refusing the whole site (see AI_CRAWLERS).
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, disallow: "/" })),
    ],
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
