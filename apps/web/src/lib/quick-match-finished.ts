// Quick match skip (plan docs/superpowers/plans/2026-11-13-quick-match-4-skip-match.md, D4; spec
// docs/superpowers/specs/2026-11-12-quick-match-cancel-and-skip-design.md §3, §6): when a quick match is finished. ONE
// predicate, read by the home, Put back's server check, the setup page's Continue card, the account list and
// /admin/quick-matches, so no two of them can disagree.
//
// Client-safe on purpose (no import at all): the Continue card lives under components/quick-match/**, where eslint refuses
// any value import of @/server/**, so the predicate lives here and `server/usecases/quick-match-home.ts` re-exports it
// beside `playedOf`, the count it reads.

/** A quick match's counts, `playedOf`'s: its matches are its non-bye fixtures, `played` the settled ones, `notPlayed` the
 *  ones marked Not played (status `cancelled`), and `total` all of them, played or not (§6: M stays the full total). */
export interface QuickMatchCounts {
  played: number;
  notPlayed: number;
  total: number;
}

/**
 * Finished: there is at least one match, and every one is played or Not played (§3 Edge: skipping every remaining match
 * finishes the league). The empty case first: a quick match with no match is not finished (no winner, nothing to continue).
 * Derived from the counts on every read, never stored: an Edit result that reopens a played match, or an added match,
 * un-finishes it.
 */
export function isQuickMatchFinished(c: QuickMatchCounts): boolean {
  return c.total > 0 && c.played + c.notPlayed === c.total;
}
