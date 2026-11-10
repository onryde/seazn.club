// X-TP-3: a bracket's places can be SHARED (RB4-T2/T3/T6, X-FR-1) - two semi-final losers both 3rd, a joint 1st, a
// vacant title's 2nd. This is the one place that says which rows share a place, read from the RANK the engine stored
// (C8: the 4th row of a list may hold an entrant ranked 3rd - copy never reads the slot or the index).
// Pure and client-safe: no `server-only` import.
import { BRACKET_KINDS } from "@/server/public-site/champion";

export interface PlaceLabel {
  /** The place the engine stored for this entrant. */
  rank: number;
  /** Another row holds the same place. */
  shared: boolean;
}

/** Is `stageKind` a bracket kind, whose rows are PLACES (rank only) rather than a table's counts? */
export function isBracketPlacement(stageKind: string): boolean {
  return BRACKET_KINDS.has(stageKind);
}

/**
 * The place label of every row, keyed by entrant. Throws by name on an assumption the engine's `assertBracketPlaces`
 * also holds: a row without a rank, or three rows on one rank (a bracket shares a place between TWO at most).
 */
export function bracketPlaceLabels(rows: readonly { entrantId: string; rank?: number }[]): Map<string, PlaceLabel> {
  const holders = new Map<number, number>();
  for (const row of rows) {
    if (row.rank === undefined) throw new Error(`bracketPlaceLabels: row ${row.entrantId} is a bracket place without a rank`);
    holders.set(row.rank, (holders.get(row.rank) ?? 0) + 1);
  }
  for (const [rank, n] of holders) {
    if (n > 2) throw new Error(`bracketPlaceLabels: rank ${rank} is held by ${n} rows; a bracket shares a place between two at most`);
  }
  return new Map(rows.map((row) => [row.entrantId, { rank: row.rank!, shared: holders.get(row.rank!)! > 1 }]));
}
