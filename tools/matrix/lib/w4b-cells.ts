// Which (row, sport) cells a W4B third-place / joint-winners / plate scenario is planned on (W4 app PR B, Task 15). Derived, never typed per cell: the rows
// are the ones whose division holds the bracket the script reads - the lone knockout in its two Third place settings (Q3: the `knockout` row is Shared, the
// `knockout_third_place` row Play-off), the same two rows for the joint-winners declaration (Q4a: the plain one completes on the declaration and takes the
// Undo, the Play-off one waits for its third-place line), and ko_plate for the plate (Q5a, Q5b). Every sport of the registry plays them - a third place, a joint
// title and a plate read seats, results and withdrawals, which no sport field reaches.
//
// The scenarios are OPT-IN, as W2a's, W2b's, W2e's and W4A's are: --set w1-driving plans them only when --scenario names one (w1-driving-set.ts), so no committed
// plan holds a cell of theirs.
import { SPORT_KEYS, type RowKey } from "./catalogue.ts";
import type { W4bScenarioKey } from "./scenarios/types.ts";

export const W4B_ROWS: Readonly<Record<W4bScenarioKey, readonly RowKey[]>> = Object.freeze({
  W4B_Q3: Object.freeze<RowKey[]>(["knockout", "knockout_third_place"]),
  W4B_Q3_OUT: Object.freeze<RowKey[]>(["knockout_third_place"]),
  W4B_Q4A: Object.freeze<RowKey[]>(["knockout", "knockout_third_place"]),
  W4B_Q5A: Object.freeze<RowKey[]>(["ko_plate"]),
  W4B_Q5B: Object.freeze<RowKey[]>(["ko_plate"]),
});

/** The catalogue atoms each script drives (scenario-catalogue.ts ATOMIC ids): Q3 the third-place atom, Q4a joint winners, Q5a / Q5b the plate's two. Q3_OUT is Q3's
 *  Play-off arm with both sides out (RB4-T6). The test pins every id to the atom list, so a rename there reds here. */
export const W4B_ATOMS: Readonly<Record<W4bScenarioKey, string>> = Object.freeze({
  W4B_Q3: "Q3", W4B_Q3_OUT: "Q3", W4B_Q4A: "Q4a", W4B_Q5A: "Q5a", W4B_Q5B: "Q5b",
});

export interface W4bCell { readonly row: RowKey; readonly sport: string }

/** The scenario's cells, row-major in the registry's order, less the cells `isDropped` drops (the committed LIFECYCLE drops: a cell the product refuses). */
export function w4bCells(key: W4bScenarioKey, isDropped: (row: RowKey, sport: string) => boolean = () => false): W4bCell[] {
  const out: W4bCell[] = [];
  for (const row of W4B_ROWS[key]) for (const sport of SPORT_KEYS) if (!isDropped(row, sport)) out.push({ row, sport });
  return out;
}
