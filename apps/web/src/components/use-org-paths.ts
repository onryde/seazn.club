"use client";
// The org's own pages from a client component that holds no slug (owner, 2026-11-18: Streaming and Directory live under the org's
// path, so the address decides the org). Every console surface that links to them renders under `/o/{slug}/...`, so the slug is read
// from the address it is on - never from the seazn_org cookie. Off an org path (a test, a page outside the tree) there is no slug and
// the link is the legacy `/streaming` / `/directory`, which redirect to the cookie's org.
import { usePathname } from "next/navigation";
import { orgSlugFromPath } from "@/lib/org-scope";
import { streamingHref } from "@/lib/youtube";

/** The org slug of the page being shown, or null off an org path. */
export function useOrgSlug(): string | null {
  return orgSlugFromPath(usePathname());
}

export function useStreamingHref(search = ""): string {
  return streamingHref(useOrgSlug(), search);
}

export function useDirectoryHref(tab?: string): string {
  const slug = useOrgSlug();
  const q = tab ? `?tab=${tab}` : "";
  return slug ? `/o/${slug}/directory${q}` : `/directory${q}`;
}
