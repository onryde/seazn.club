// W5 app PR A, Task 10 (X-RP-2, X-RP-3; RB5-R2, RB5-R3, ruling 282): how a pair's roster edit is judged once play has started.
// Pure and client-safe — the server's `patchEntrant` reads it, and a screen may say the same words from the same verdict.
//
// The pair IS the entrant. A partner who leaves with nobody joining dissolves the pair, which then withdraws as the entrant
// (R12b, rule `drops`); anyone who joins is a substitute partner (R12a, rule `substitutes`, refused — lineup substitution is the
// deferred lineup work). Nothing else changes partners: the same people again, in any order, with a captain flag or a squad
// number edited, is `same`. A swap is a join, so a swap is a substitute, and an edit that drops one and adds another is too:
// the join decides, never the count.

export type PairRosterChange = "same" | "drops" | "substitutes";

/** The verdict on replacing the roster `current` (person ids) with `next`. */
export function classifyPairRosterChange(current: readonly string[], next: readonly string[]): PairRosterChange {
  const had = new Set(current);
  const has = new Set(next);
  for (const id of has) if (!had.has(id)) return "substitutes";
  for (const id of had) if (!has.has(id)) return "drops";
  return "same";
}
