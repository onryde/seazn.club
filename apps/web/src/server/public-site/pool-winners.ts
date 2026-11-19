// W5 T14b (owner 2026-11-18) — a finished multi-pool Groups only division names each pool's winner. The RULE is
// `poolWinnersOf` (`./champion.ts`); this is its display half, shared by the division page's banner and the hub's Table tab so
// the two print the same pool names and the same names: a pool is labelled from its KEY through the reader's dictionary
// (`lib/pool-label.ts`, never the stored English name), and an entrant by the caller's own (already masked) lookup.
//
// PURE: no `sql`, no React, no `server-only`.
import type { Dict } from "@/lib/i18n-constants";
import { poolLabel } from "@/lib/pool-label";
import type { PoolWinner } from "./champion";

/** One line of the pool-winners display: the pool's label, and the winner's name - null for a pool with no single winner. */
export interface PoolWinnerLine {
  poolId: string;
  label: string;
  name: string | null;
}

export function poolWinnerLines(
  winners: readonly PoolWinner[] | null,
  dict: Dict,
  nameOf: (entrantId: string) => string,
): PoolWinnerLine[] {
  if (winners === null) return [];
  return winners.map((w) => ({
    poolId: w.poolId,
    label: poolLabel(dict, w.key),
    name: w.entrantId === null ? null : nameOf(w.entrantId),
  }));
}
