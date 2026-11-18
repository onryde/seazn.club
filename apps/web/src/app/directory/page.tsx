export const dynamic = "force-dynamic";
// The old, org-less Directory address (owner, 2026-11-18): the page now lives under the org's own path, `/o/{slug}/directory`.
// A bookmark or an old link lands on the org the cookie names (else the first membership), with its `?tab=` kept.
import { redirect } from "next/navigation";
import { searchOf } from "@/lib/routes";
import { requirePageAuth } from "@/server/page-auth";

export default async function LegacyDirectoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const { org } = await requirePageAuth();
  redirect(`/o/${org.slug}/directory${searchOf(query)}`);
}
