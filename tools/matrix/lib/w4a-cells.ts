// Which (row, sport) cells a W4A late-entry / lucky-loser scenario is planned on (W4 app PR A, Task 24). Derived, never typed
// per cell: the rows are the ones whose division ENTRY stage is a root knockout (R2, R10: the product's late entry joins it -
// usecases/knockout-late-entry.ts, X-LE-1) or a knockout that feeds a second knockout through a rank cut (R6: the lucky
// loser fills a departed qualifier's seat - usecases/lucky-loser.ts, X-LL-1), and every sport of the registry plays them -
// late entry and a lucky loser read seats, seeds and how a line was lost, which no sport field reaches (the product's own
// lucky-loser.test.ts sweeps three sports for the same reason).
//
// The scenarios are OPT-IN, as W2a's, W2b's and W2e's are: --set w1-driving plans them only when --scenario names one
// (w1-driving-set.ts), so no committed plan holds a cell of theirs.
import { SPORT_KEYS, type RowKey } from "./catalogue.ts";
import type { W4aScenarioKey } from "./scenarios/types.ts";

/** The rows each scenario plays. R2 / R10 join the root knockout of a plain knockout or one with a third-place match (the match
 *  every knockout owes before it can complete, F3); R6 needs a knockout feeding a knockout through a rank cut - qualifying_main. */
export const W4A_ROWS: Readonly<Record<W4aScenarioKey, readonly RowKey[]>> = Object.freeze({
  W4A_R2: Object.freeze<RowKey[]>(["knockout", "knockout_third_place"]),
  W4A_R10: Object.freeze<RowKey[]>(["knockout", "knockout_third_place"]),
  W4A_R6: Object.freeze<RowKey[]>(["qualifying_main"]),
});

export interface W4aCell { readonly row: RowKey; readonly sport: string }

/** The scenario's cells, row-major in the registry's order, less the cells `isDropped` drops (the committed LIFECYCLE drops: a cell
 *  the product refuses). */
export function w4aCells(key: W4aScenarioKey, isDropped: (row: RowKey, sport: string) => boolean = () => false): W4aCell[] {
  const out: W4aCell[] = [];
  for (const row of W4A_ROWS[key]) for (const sport of SPORT_KEYS) if (!isDropped(row, sport)) out.push({ row, sport });
  return out;
}
