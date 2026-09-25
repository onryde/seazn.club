// The slice of the public dictionary that crosses into the competition hub's
// CLIENT subtree.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// `CompetitionLanding` is a `"use client"` root and takes `dict` as a prop, so
// Next serialises whatever it is handed into the RSC payload in the HTML.
// Handed the whole `public.json`, that was **85 KB of a 131 KB page** — 65% of
// the document — and every string in it appeared in the body whether or not
// anything rendered it.
//
// Two costs, and the second is the one that found it:
//
//  • Every spectator downloads and parses the entire public dictionary on a
//    page that renders a fraction of it. A CDN in front removes the ORIGIN
//    fetch; it does not remove the bytes over the air to a phone on mobile
//    data at a ground, which is the surface this is built for.
//  • `scripts/smoke.ts:13611` asserts a free org's page does NOT contain
//    "Presented by" — correctly, because an un-tiered strip has no title row.
//    With the whole dictionary serialised, `landing.presentedBy` was in the
//    body of every page regardless, and the check failed on correct markup.
//    Any "this string must not appear" assertion on this page was unreliable.
//
// ── WHY PREFIXES, AND WHY THE TEST MATTERS MORE THAN THE LIST ──────────────
// A hand-written key list is the thing this repo has been bitten by twice: it
// cannot fail when a new key is used. So the list below is deliberately NOT
// the guarantee. The guarantee is `hub-dict.test.ts`, which renders every tab
// twice — once with the full dictionary, once with this slice — and requires
// the markup to be IDENTICAL. Drop a prefix something needs and that test
// fails with the missing copy visible in the diff, rather than a key string
// quietly rendering in production.
import type { Dict } from "@/lib/i18n-constants";

/**
 * Key prefixes the hub's client subtree reads.
 *
 * `division.` is here because the Teams tab reuses `division.entrantsEmpty`
 * rather than owning a duplicate `teams.empty` — the same sentence about the
 * same thing, translated once.
 *
 * `format.` is the Info tab's per-stage rules lines (`HubDivision.
 * stageFormatLines`), built server-side as `Msg` clauses and resolved here
 * (`rulesLineText`).
 */
export const HUB_DICT_PREFIXES = [
  "landing.",
  "matchesHub.",
  "table.",
  "knockout.",
  "leaders.",
  "teams.",
  "info.",
  "division.",
  "format.",
] as const;

/**
 * EXACT keys the hub's client subtree reads outside the prefixes above.
 *
 * The called-off status sentences (Knockout fix round, P2). `MatchCard` prints
 * `header.statusLine`, and `hubHeader` (`competition-hub.ts`) sets it only for
 * a called-off fixture: `matchCentre.status.<status>` for a member of
 * `STATUS_LINE_KEYS`, `matchCentre.status.other` for anything else. So these
 * six, and not the `matchCentre.` prefix — that is the match centre's whole
 * vocabulary, and would put most of it back on the page this slice exists to
 * keep small. Missing, a forfeited final printed `matchCentre.status.forfeited`
 * on the public Matches and Knockout tabs.
 *
 * Restated rather than imported: this module is read by client code, and
 * `competition-hub.ts` is server-only. `hub-dict.test.tsx` derives the same
 * list from `STATUS_LINE_KEYS` and fails on drift.
 */
export const HUB_DICT_KEYS = [
  "matchCentre.status.abandoned",
  "matchCentre.status.cancelled",
  "matchCentre.status.forfeited",
  "matchCentre.status.postponed",
  "matchCentre.status.walkover",
  "matchCentre.status.other",
] as const;

/**
 * Keys that match a prefix above but are rendered by a SERVER component this
 * page passes in as a slot, so they must not cross the boundary.
 *
 * All three belong to `SponsorsBoard`. They sit under `landing.` by naming
 * accident, not because the hub reads them — the hub's own `landing.*` usage is
 * the status ladder, the tab labels, the two rail headings and the two CTAs.
 *
 * This is the half that makes `scripts/smoke.ts:13611` pass HONESTLY. That
 * check asserts a free org's page does not contain "Presented by", which is
 * true of the markup — an un-tiered strip has no title row — and was false of
 * the body, because the string arrived as serialised dictionary data. Relaxing
 * the assertion would have hidden a page shipping copy it never renders.
 */
export const SERVER_ONLY_KEYS = [
  "landing.sponsors",
  "landing.presentedBy",
  "landing.partners",
] as const;

/** The subset of `dict` a client subtree reads: every key under one of
 *  `prefixes` or named in `keys`, minus `exclude`. */
function sliceDict(
  dict: Dict,
  prefixes: readonly string[],
  keys: readonly string[] = [],
  exclude: readonly string[] = [],
): Dict {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(dict)) {
    const read = prefixes.some((p) => key.startsWith(p)) || keys.includes(key);
    if (!read) continue;
    if (exclude.includes(key)) continue;
    out[key] = dict[key];
  }
  return out;
}

/** The subset of `dict` the hub's client subtree may read. */
export function hubDict(dict: Dict): Dict {
  return sliceDict(dict, HUB_DICT_PREFIXES, HUB_DICT_KEYS, SERVER_ONLY_KEYS);
}

/**
 * Key prefixes the org home's chip island (`components/public-site/
 * org-live-chips.tsx`, spectator W2 Task 15) reads: the three status-chip
 * labels and the in-play count sentence (`org.live.one` / `.other`), and
 * nothing else. The island renders the competitions list, whose only copy is
 * the chip; names and date lines arrive already resolved. The guarantee is the
 * same differential render as the hub's, in `org-live-chips.test.tsx`.
 */
export const ORG_LIVE_DICT_PREFIXES = ["chip.", "org.live."] as const;

/** EXACT keys the org home's chip island reads outside its prefixes: `empty`,
 *  the page's own "no public competitions" sentence, which the island shows
 *  when a poll drops every competition the page listed. */
export const ORG_LIVE_DICT_KEYS = ["empty"] as const;

/** The subset of `dict` the org home's chip island may read. */
export function orgLiveDict(dict: Dict): Dict {
  return sliceDict(dict, ORG_LIVE_DICT_PREFIXES, ORG_LIVE_DICT_KEYS);
}
