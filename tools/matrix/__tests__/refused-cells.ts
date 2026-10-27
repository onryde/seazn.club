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
