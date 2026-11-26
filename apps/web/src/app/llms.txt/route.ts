// /llms.txt (llmstxt.org): the help centre and the blog, listed for answer engines. The body is built in
// server/llms-txt.ts from the content itself.
import { isStagingOrigin } from "@/lib/robots-policy";
import { siteOrigin } from "@/lib/site-origin";
import { llmsTxt } from "@/server/llms-txt";

// Request-time, never prerendered, for the reason robots.ts and sitemap.ts give: the origin, and so the staging decision,
// is read from the env, and a build-time copy would freeze whatever origin the BUILD saw. The content itself is cached by
// its loaders in production, and the response carries the Cache-Control Next sends with sitemap.xml.
export const dynamic = "force-dynamic";

export function GET(): Response {
  const origin = siteOrigin();
  // Staging is closed to crawlers (app/robots.ts, the same test), so it publishes no list that would invite one.
  if (isStagingOrigin(origin)) {
    return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return new Response(llmsTxt(origin), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" },
  });
}
