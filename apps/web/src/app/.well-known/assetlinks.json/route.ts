import { assetLinksFor } from "@/lib/assetlinks";
import { siteOrigin } from "@/lib/site-origin";

// siteOrigin() is a runtime variable: a response prerendered at build time would serve the build's origin everywhere.
export const dynamic = "force-dynamic";

/** Android App Links statement list (spec 2026-11-25 §5.2): public, no auth, no redirect. */
export function GET(): Response {
  return Response.json(assetLinksFor(siteOrigin()));
}
