// The catalogue cells the PRODUCT refuses, stated from the ruling — the oracle
// the matrix tests count against, independent of the derivation they judge
// (lib/catalogue.ts refusedCell; TEST-STRATEGY: never derive an expected value
// from the code under test).
//
// Chess is individual-only (owner ruling 2026-10-26, PR #1027 and its
// follow-up): an americano or mexicano stage rotates its players into pair
// entrants, so the division builder offers chess (sport key `boardgame`)
// neither format, and creating such a stage answers 422 CHESS_INDIVIDUAL_ONLY.
// Those two cells are planned in no layer; every other cell of the 231 is.

/** Every refused cell, `row|sport`. */
export const REFUSED_CELLS: readonly string[] = Object.freeze(["americano|boardgame", "mexicano|boardgame"]);

/** Is this `row|sport` cell one the product refuses? */
export function isRefusedCell(cell: string): boolean {
  return REFUSED_CELLS.includes(cell);
}

/** The rows → sports grid in its order (row-major), refused cells left out. */
export function offeredCells(rows: readonly string[], sports: readonly string[]): string[] {
  return rows.flatMap((r) => sports.map((s) => `${r}|${s}`)).filter((c) => !isRefusedCell(c));
}

/** The rows one sport is offered, in row order. */
export function offeredRows(rows: readonly string[], sport: string): string[] {
  return rows.filter((r) => !isRefusedCell(`${r}|${sport}`));
}

/** A refused cell's drop reason names the ruling and the refusal code. */
export const REFUSED_REASON = /chess is individual-only \(owner ruling 2026-10-26\)[\s\S]*CHESS_INDIVIDUAL_ONLY/;

// Match Day C9 review I5, option 2 (controller ruling 2026-11-03): the same two formats are not OFFERED to a sport
// whose engine entrant model holds no individuals or no pairs - the stage rotates individual players into pair
// entrants. Football, cricket, ice hockey and hockey hold teams only and volleyball teams and pairs
// (`entrantModel.kinds`). The stage create does not refuse them yet, so these cells stay offered and planned: every
// browser case on them is 🚫 (no screen reaches them) and their HTTP cases run as before.

/** Every cell with no organiser path, `row|sport`, row-major in the grid's order. */
export const NO_ORGANISER_PATH_CELLS: readonly string[] = Object.freeze([
  "americano|football", "americano|cricket", "americano|volleyball", "americano|icehockey", "americano|hockey",
  "mexicano|football", "mexicano|cricket", "mexicano|volleyball", "mexicano|icehockey", "mexicano|hockey",
]);

/** Is this `row|sport` cell one the builder does not offer although the product does not refuse it? */
export function isNoOrganiserPathCell(cell: string): boolean {
  return NO_ORGANISER_PATH_CELLS.includes(cell);
}
