// Which competitions a LISTING surface may enumerate — owner decision
// 2026-09-27, "a draft is unlisted until published".
//
// A competition is created `status = 'draft'` (V207) with `visibility =
// 'public'` by default (V396). It is readable by direct link from the moment it
// exists — hub, divisions, fixtures, poster, kiosk, embed and registration all
// work — but NO surface that enumerates competitions shows it until it is
// published: the org home and its chip poll, the sitemap, discovery, and
// another competition's player card. For listing purposes a draft behaves
// exactly like `unlisted`. `archived` (and `completed`) stay listed, as
// "Finished" — the help's "nothing is lost" promise.
//
// This is the TypeScript half of the rule, for the places that decide in code
// (a page's `robots`, the write path's cache expiry). The SQL listing queries
// carry the same two conditions inline — `visibility = 'public' and status <>
// 'draft'` — because a query cannot call this function; `draft-unlisted-db.test.ts`
// is what holds the two halves to one answer.
//
// Dependency-free on purpose: the public pages, the competition use-case and
// the tests all import it.

/** The one status that keeps a publicly-readable competition off every listing. */
export const UNLISTED_STATUS = "draft";

/** True when a listing surface may enumerate this competition: public
 *  visibility AND past draft. Unlisted and private are never listed; a draft
 *  is not listed whatever its visibility. */
export function competitionIsListed(c: { visibility: string; status: string }): boolean {
  return c.visibility === "public" && c.status !== UNLISTED_STATUS;
}

/**
 * The `robots` metadata of a competition-scoped public page (hub, division,
 * fixture, player card): link-only pages keep crawlers out but stay up (doc 09
 * §1). A draft is link-only exactly as an unlisted competition is, so it takes
 * the SAME value the unlisted pages have always carried — `index: false,
 * follow: false` — rather than a second, draft-only variant. Spread it into a
 * page's metadata; a listed competition gets nothing (the default: indexable).
 */
export function linkOnlyRobots(c: { visibility: string; status: string }): {
  robots?: { index: false; follow: false };
} {
  return competitionIsListed(c) ? {} : { robots: { index: false, follow: false } };
}
