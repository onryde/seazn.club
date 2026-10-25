// The warning shown when a chess division is (being) switched to online play while players cannot be paired online yet
// (owner ruling 2026-10-25: warn, never block - clubs switch first and collect links later; fix round 1: the warning's
// purpose is "these players can't be paired online", so it covers a link that cannot play as well as no link at all).
// Client-safe and pure: the division page summarises the server's two lists with `summariseLinkGaps`, and Settings
// prints each with `linkGapSentence`.
//
// The summary caps how many NAMES cross to the browser, so a 500-player division does not ship 500 names to print five.
// `count` is always the true number in that list; `names` is the first few, already in the server's order.

/** How many names a sentence prints before folding the rest into "and N more". Both sentences share it. */
export const LINK_GAP_NAMES_SHOWN = 5;

/** The two gaps, which are two sentences with two fixes: no Lichess link at all, and a link that cannot play. */
export type LinkGapKind = "unlinked" | "reconnect";

export type LinkGapList = {
  /** Everybody in the field with this gap, not just the ones named. */
  count: number;
  /** The first `LINK_GAP_NAMES_SHOWN` of them. */
  names: string[];
};

export type LinkGapsSummary = Record<LinkGapKind, LinkGapList>;

export function summariseLinkGaps(gaps: Record<LinkGapKind, readonly { name: string }[]>): LinkGapsSummary {
  const one = (rows: readonly { name: string }[]): LinkGapList => ({
    count: rows.length,
    names: rows.slice(0, LINK_GAP_NAMES_SHOWN).map((r) => r.name),
  });
  return { unlinked: one(gaps.unlinked), reconnect: one(gaps.reconnect) };
}

/** Whether there is anything to say at all (either sentence). */
export function hasLinkGaps(summary: LinkGapsSummary): boolean {
  return summary.unlinked.count > 0 || summary.reconnect.count > 0;
}

/** One sentence in the viewer's language: the count (plural by the locale's own rules) and the names joined the way that
 *  locale joins a list, the unnamed remainder as the last item ("A, B, C, D, E, and 3 more"). `plural` is the
 *  dictionary's plural lookup (`useMsgPlural`), so the sentence is copy, never code. The sentence for `kind` is the
 *  `divset.onlinePlay.<kind>` key family; the "N more" tail (`divset.onlinePlay.gapMore`) is shared. */
export function linkGapSentence(
  kind: LinkGapKind,
  list: LinkGapList,
  locale: string,
  plural: (key: string, count: number, vars?: Record<string, string | number>) => string,
): string {
  const unnamed = Math.max(0, list.count - list.names.length);
  const items = unnamed > 0 ? [...list.names, plural("divset.onlinePlay.gapMore", unnamed)] : list.names;
  const names = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
  return plural(`divset.onlinePlay.${kind}`, list.count, { names });
}
