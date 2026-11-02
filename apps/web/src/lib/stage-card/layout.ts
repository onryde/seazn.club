// Match Day Phase C, Task C3 (spec 2026-10-31-match-day-design.md §12 Phase C items 1, 8, 9, 12) - the stage card's layout
// decisions, pure and client-safe (no JSX, no `@/server` import). The card (`stages-panel.tsx`) renders what these answer.
import { foldTiebreaks } from "@/lib/stage-card/summaries";

/** A stage kind as a person says it: `double_elim` is "double elim". The pill prints the same words. */
const spoken = (s: string): string => s.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Item 1: "1. League" next to a "league" pill says the same word twice. The pill is shown only when the stage's name does not
 * already say its kind. "Says" is: the kind's words open a word of the name (case-insensitive), so "League", "1. League",
 * "Group A", "Double elimination" (kind `double_elim`) all say theirs, and "Pool A" (a `group`) and "Finals" (a `knockout`)
 * do not. An empty name keeps the pill: it is then the only thing naming the stage.
 */
export function showKindPill(name: string, kind: string): boolean {
  const words = spoken(kind);
  if (words === "") return false;
  return !` ${spoken(name)}`.includes(` ${words}`);
}

/**
 * Item 6 as one clause: the first two real criteria of the tie-break order ("wins, then game difference…"), with an
 * ellipsis when more follow. The two-way head-to-head rung is not a criterion (the Tie-breaks panel says it once, as a
 * sentence), so it is taken out first. `nameOf` words a rung in the sport's own unit (`unitLabelKey`); `joiner` is the
 * locale's ", then ". Null for an order with no real criterion, so the line says nothing rather than "Ties: ".
 */
export function tiesSummary(keys: readonly string[], nameOf: (key: string) => string, joiner: string): string | null {
  const { steps } = foldTiebreaks(keys);
  if (steps.length === 0) return null;
  const head = steps.slice(0, 2).map(nameOf).join(joiner);
  return steps.length > 2 ? `${head}…` : head;
}
