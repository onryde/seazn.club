// The warning shown when a chess division is (being) switched to online play while players have no Lichess link (owner
// ruling 2026-10-25: warn, never block - clubs switch first and collect links later). Client-safe and pure: the division
// page summarises the server's list with `summariseUnlinkedLichess`, and Settings prints it with `unlinkedLichessWarning`.
//
// The summary caps how many NAMES cross to the browser, so a 500-player division does not ship 500 names to print five.
// `count` is always the true number of unlinked players; `names` is the first few, already in the server's order.

/** How many names the warning prints before folding the rest into "and N more". */
export const UNLINKED_NAMES_SHOWN = 5;

export type UnlinkedLichessSummary = {
  /** Every unlinked player in the field, not just the ones named. */
  count: number;
  /** The first `UNLINKED_NAMES_SHOWN` of them. */
  names: string[];
};

export function summariseUnlinkedLichess(players: readonly { full_name: string }[]): UnlinkedLichessSummary {
  return { count: players.length, names: players.slice(0, UNLINKED_NAMES_SHOWN).map((p) => p.full_name) };
}

/** The warning sentence in the viewer's language: the count (plural by the locale's own rules) and the names joined the
 *  way that locale joins a list, the unnamed remainder as the last item ("A, B, C, D, E, and 3 more"). `plural` is the
 *  dictionary's plural lookup (`useMsgPlural`), so the sentence is copy, never code. */
export function unlinkedLichessWarning(
  summary: UnlinkedLichessSummary,
  locale: string,
  plural: (key: string, count: number, vars?: Record<string, string | number>) => string,
): string {
  const unnamed = Math.max(0, summary.count - summary.names.length);
  const items = unnamed > 0 ? [...summary.names, plural("divset.onlinePlay.unlinkedMore", unnamed)] : summary.names;
  const names = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
  return plural("divset.onlinePlay.unlinked", summary.count, { names });
}
