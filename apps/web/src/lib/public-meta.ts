// Meta-description builders for the public /shared tree. A page must always
// return a non-empty description: this Next build does not fall back to the
// root layout's description, so `undefined` here means NO meta description,
// og:description or twitter:description at all (caught by a link-preview
// inspector on stg).
/**
 * The competition page's `<meta name="description">`.
 *
 * ── WHY THIS TAKES A SENTENCE AND NOT A NAME AND AN ORG ────────────────────
 * It used to build the fallback itself:
 *
 *     `Live scores, standings and brackets for ${name} — hosted by ${org}…`
 *
 * which is English, in all four locales, on a route whose entire body is
 * rendered in the org's own language. There was no competition twin of
 * `division.metaDescription` and now there is (`landing.metaDescription`), so
 * the copy has moved into the dictionaries where the rest of the page's copy
 * lives.
 *
 * The RESOLVED sentence is passed in rather than a dictionary being reached for
 * here, and that is the deliberate half: this module is `lib/`, it is imported
 * by the player page as well, and it has no locale of its own to resolve
 * against. The page already has one — it resolved the org's locale to render
 * everything else — so the i18n decision stays at the page and this helper
 * stays a pure two-line string choice with no dictionary in its tests.
 *
 * A page must always return a non-empty description: this Next build does not
 * fall back to the root layout's, so `undefined` here means NO meta
 * description, og:description or twitter:description at all.
 */
export function competitionMetaDescription(
  competitionDescription: string | null | undefined,
  fallback: string,
): string {
  const own = competitionDescription?.trim();
  // 160 caps the ORGANISER's prose, which is free text of any length. The
  // fallback is dictionary copy this repo controls and is returned whole — a
  // cap applied to it would cut a translated sentence mid-word in whichever
  // locale happens to be longest, for no gain.
  if (own) return own.slice(0, 160);
  return fallback;
}

export function playerMetaDescription(
  playerName: string,
  competitionName: string,
): string {
  return `${playerName}'s player card at ${competitionName} — appearances, results and stats on Seazn Club.`;
}
