// The /shared org door (doc 09 §1), shared by the two org layouts: the
// chrome one (`(public)/shared/[orgSlug]/layout.tsx`, every public page) and
// the bare kiosk one (`(public)/shared/(kiosk)/[orgSlug]/layout.tsx`, the
// /present boards). One copy, so the two trees cannot drift apart on who 404s.
//
// Reserved slugs 404 before the DB is touched; a missing org 404s identically
// (no existence leak); a renamed org's old slug redirects permanently (v3/01 §2).
//
// The two trees diverge on exactly ONE thing, deliberately (K fix round, F2):
// WHO answers for an org slug that nothing live matches. A layout only ever
// receives its own param, so the redirect it can build is `sharedRenameTarget(
// orgSlug)` = `/shared/<new>` — and `/shared/<old>/<comp>/present` was measured
// landing on the org hub instead of the board, which kills a printed or QR'd
// kiosk URL on a rename. The kiosk layout therefore takes `publicOrgOrNull` and
// decides nothing; its board pages hold the whole path and redirect with the
// tail intact. The chrome layout keeps `publicOrgOr404` — its pages ARE the
// org hub, so a tail-less answer is the right one there.
// The reserved-slug rule stays in one copy below, which is what must not drift.
import { notFound, permanentRedirect } from "next/navigation";
import { isReservedSlug } from "@/lib/public-site";
import { getPublicOrg } from "@/server/public-site/data";
import { sharedRenameTarget } from "@/server/slug-resolve";

/**
 * Reserved slug → 404 before the database is touched. Otherwise the org, or
 * null when nothing live answers to this slug — renamed, deleted, or never
 * there. The caller decides which, because telling them apart usefully needs
 * the rest of the path, which a layout does not have.
 */
export async function publicOrgOrNull(orgSlug: string) {
  if (isReservedSlug(orgSlug)) notFound();
  return await getPublicOrg(orgSlug);
}

export async function publicOrgOr404(orgSlug: string) {
  const data = await publicOrgOrNull(orgSlug);
  if (!data) {
    const renamed = await sharedRenameTarget(orgSlug);
    if (renamed) permanentRedirect(renamed);
    notFound();
  }
  return data;
}
