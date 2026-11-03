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

/** The status a competition is BORN with (V207's column default; `createCompetition`
 *  inserts none). The New competition form asks "who will find it" of a
 *  competition that is still this, and `competition-reach-db.test.ts` holds the
 *  two together by creating one. */
export const NEW_COMPETITION_STATUS = UNLISTED_STATUS;

/**
 * Visibilities a stranger can OPEN by direct link — the cap's "publicly
 * READABLE", not the listing rule's "LISTED". `private` is outside it: the view
 * does not admit it and the `/shared/...` page 404s.
 *
 * Lives here, and is re-exported by `server/usecases/entitlement-freeze.ts`
 * (which keeps the long rationale for why the cap counts this set), because the
 * "Who will find it" list in the New competition form is a client island and
 * `entitlement-freeze` is `server-only`. One tuple, two readers.
 */
export const PUBLICLY_READABLE_VISIBILITIES = ["public", "unlisted"] as const;
export type PubliclyReadableVisibility =
  (typeof PUBLICLY_READABLE_VISIBILITIES)[number];

/**
 * Will a create with this visibility come back PRIVATE because the org has no public slot left?
 *
 * The client's half of `resolveCreateVisibility` (usecases/competitions.ts), which NEVER refuses a create over
 * `dashboard.public.max`: a visibility the cap meters, with no slot left, is created private and the 201 says so. The New competition
 * form asks this before Create so its "Who will find it" list does not promise reach the create will not deliver.
 *
 * `slotsLeft` is `publicSlotsLeft(...).left`: `null` when the plan has no public cap (or the form could not read one), in which case
 * there is nothing to warn about. `public-slots-left.test.ts` holds this function to the real create at every point of a filling cap.
 */
export function createdPrivateOverCap(visibility: string, slotsLeft: number | null): boolean {
  return slotsLeft === 0 && (PUBLICLY_READABLE_VISIBILITIES as readonly string[]).includes(visibility);
}

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

/**
 * True when PUBLISHING would list this competition: it is a public draft. The
 * organiser-facing notes — the hint under Status in competition settings and
 * the note in the Start-tournament confirmation — say "not listed … until you
 * publish", which is true here and nowhere else: a private or unlisted draft is
 * no more listed once published, and anything past draft is listed already.
 */
export function publishWouldList(c: { visibility: string; status: string }): boolean {
  return c.visibility === "public" && c.status === UNLISTED_STATUS;
}

/** The audiences the New competition form names, in the order it lists them. */
export const REACH_AUDIENCES = ["team", "link", "org", "search", "showcase"] as const;
export type ReachAudience = (typeof REACH_AUDIENCES)[number];

/** `yes` now, `after_publish` (a public draft: listed once published), or `no`. */
export type ReachState = "yes" | "after_publish" | "no";

/**
 * WHO will find a competition, answered from the rules in this file — so the
 * form's checklist cannot drift from what the listing queries, the sitemap and
 * the pages' robots actually do. One reader has a floor this file does not
 * model (showcase, below), and the form's copy says so.
 *
 *  - team:     org members always see their own competition.
 *  - link:     anyone holding the URL, from the moment it exists —
 *              `PUBLICLY_READABLE_VISIBILITIES`.
 *  - org:      the org's public page — `competitionIsListed`; a public draft is
 *              listed once published (`publishWouldList`).
 *  - search:   crawlers — indexable exactly when `linkOnlyRobots` adds no
 *              `robots` key; the same "once published" for a public draft.
 *  - showcase: seazn.club's home and sport pages — opt-in (`discoverable`) AND
 *              listed (`public_discovery_v` excludes drafts, V419). Listed
 *              already implies public, which is the coupling the server
 *              enforces on the flag itself, so a stale flag on a non-public
 *              competition reads "no" without a second clause.
 *
 *              `after_publish` here is a CEILING, not a promise: the view also
 *              asks a quality floor of any showcased competition — a decided or
 *              finalized fixture, or a division past setup (a published
 *              schedule) — plus a verified owner email, an active org and no
 *              staff block (V306). That floor is about the competition's
 *              progress, not its visibility or status, so it is not modelled
 *              here; the form's row says "may appear once you publish and it has
 *              a published schedule or a result", and
 *              `competition-reach-db.test.ts` pins the floor against the real
 *              view so that sentence cannot outlive it.
 */
export function competitionReach(c: {
  visibility: string;
  status: string;
  discoverable: boolean;
}): Record<ReachAudience, ReachState> {
  const listing = { visibility: c.visibility, status: c.status };
  const listed: ReachState = competitionIsListed(listing)
    ? "yes"
    : publishWouldList(listing)
      ? "after_publish"
      : "no";
  const indexable = linkOnlyRobots(listing).robots === undefined;
  return {
    team: "yes",
    link: (PUBLICLY_READABLE_VISIBILITIES as readonly string[]).includes(c.visibility) ? "yes" : "no",
    org: listed,
    search: indexable ? "yes" : listed === "after_publish" ? "after_publish" : "no",
    showcase: c.discoverable ? listed : "no",
  };
}
