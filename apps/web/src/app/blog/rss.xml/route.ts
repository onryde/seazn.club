import { siteOrigin } from "@/lib/site-origin";
import { allBlogPosts } from "@/server/blog-content";
import { blogRssXml } from "@/server/blog-rss";

// A static route handler (Next docs 01-app/01-getting-started/15-route-handlers.md): rendered at build, regenerated on the
// same hour as the pages, cached like one. Reads no request.
export const dynamic = "force-static";
export const revalidate = 3600;

export function GET(): Response {
  return new Response(blogRssXml(allBlogPosts(), siteOrigin()), {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
}
