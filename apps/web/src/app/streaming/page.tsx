export const dynamic = "force-dynamic";
// The old, org-less Streaming address (owner, 2026-11-18): the page now lives under the org's own path, `/o/{slug}/streaming`, so
// the address decides the org. A bookmark or an old link lands on the org the cookie names (else the first membership - what this
// page always showed), with the query kept (`?youtube=` is the connect round trip's landing). A visitor with no org gets what
// `requirePageAuth` has always given them.
import { redirect } from "next/navigation";
import { routes, searchOf } from "@/lib/routes";
import { requirePageAuth } from "@/server/page-auth";

export default async function LegacyStreamingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const { org } = await requirePageAuth();
  redirect(routes.orgStreaming(org.slug, searchOf(query)));
}
