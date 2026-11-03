// Match Day PB3 item 7 - which competitions are billing-frozen, as the Match Day banner names them.
//
// The banner tells an over-limit organisation that it is over its plan's limit on active competitions. Saying WHICH competitions are
// read-only is what lets the organiser choose what to archive. The set is the persisted one (`frozenCompetitionIds`, chosen once and
// stored in `competitions.frozen_at`), never a recomputation: a recomputed "who would freeze" can name a different competition from
// the one the server really refuses, which is worse than naming none.
//
// Pure and import-free so the page, the shell and their tests all lean on the same rule.

/** How many names the banner spells out before it says "+N more". */
export const FROZEN_NAMES_SHOWN = 3;

export type FrozenCompetitionRef = { id: string; name: string; slug: string };

export type FrozenNames = {
  /** At most `FROZEN_NAMES_SHOWN`, the competition being viewed first. */
  shown: FrozenCompetitionRef[];
  /** How many more are frozen than are named. */
  more: number;
};

export const NO_FROZEN_NAMES: FrozenNames = { shown: [], more: 0 };

/**
 * Shapes the org's frozen competitions for the banner. `rows` arrive in the server's order (name, then id); the competition the
 * organiser is standing in goes FIRST so it is never the one hiding behind "+N more".
 */
export function frozenNamesFor(rows: readonly FrozenCompetitionRef[], currentId: string): FrozenNames {
  const here = rows.filter((r) => r.id === currentId);
  const others = rows.filter((r) => r.id !== currentId);
  const ordered = [...here, ...others];
  return { shown: ordered.slice(0, FROZEN_NAMES_SHOWN), more: Math.max(0, ordered.length - FROZEN_NAMES_SHOWN) };
}
