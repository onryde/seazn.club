// The /shared org door (doc 09 §1), shared by the two org layouts: the
// chrome one (`(public)/shared/[orgSlug]/layout.tsx`, every public page) and
// the bare kiosk one (`(public)/shared/(kiosk)/[orgSlug]/layout.tsx`, the
// /present boards). One copy, so the two trees cannot drift apart on who 404s.
//
// Reserved slugs 404 before the DB is touched; a missing org 404s identically
// (no existence leak); a renamed org's old slug redirects permanently (v3/01 §2).
import { notFound, permanentRedirect } from "next/navigation";
import { isReservedSlug } from "@/lib/public-site";
import { getPublicOrg } from "@/server/public-site/data";
import { sharedRenameTarget } from "@/server/slug-resolve";

export async function publicOrgOr404(orgSlug: string) {
  if (isReservedSlug(orgSlug)) notFound();
  const data = await getPublicOrg(orgSlug);
  if (!data) {
    const renamed = await sharedRenameTarget(orgSlug);
    if (renamed) permanentRedirect(renamed);
    notFound();
  }
  return data;
}
