// The catalogue cells the PRODUCT refuses, stated from the ruling — the oracle
// the matrix tests count against, independent of the derivation they judge
// (lib/catalogue.ts refusedCell; TEST-STRATEGY: never derive an expected value
// from the code under test).
//
// Chess is individual-only (owner ruling 2026-10-26, PR #1027 and its
// follow-up): an americano or mexicano stage rotates its players into pair
// entrants, so the division builder offers chess (sport key `boardgame`)
// neither format, and creating such a stage answers 422 CHESS_INDIVIDUAL_ONLY.
// Those two cells are planned in no layer.
//
// W4 T16 (owner ruling 269, W4 rulebook RB4-S6): a stepladder or page playoff is not offered standalone — it needs a
// table to seed from, so the stage create answers 422 STEPLADDER_NEEDS_TABLE_SOURCE / PAGE_PLAYOFF_NEEDS_TABLE_SOURCE
// on every sport. The two API-only rows that build one standalone (`stepladder_only`, `page_playoff_only`) are refused
// on all 11 sports: 22 cells, ⛔ refused, not 🚫 missing (RB4-S6). Every other cell of the 231 is planned.

import { builtinModules } from "@seazn/engine/sports";

/** The 11 sports, in the grid's (engine registry) order, as the rulings name them. */
const SPORTS_11 = ["football", "cricket", "boardgame", "carrom", "generic", "volleyball", "badminton", "tabletennis", "tennis", "icehockey", "hockey"] as const;

/** The chess cells (ruling 2026-10-26). */
export const CHESS_REFUSED_CELLS: readonly string[] = Object.freeze(["americano|boardgame", "mexicano|boardgame"]);
/** The standalone cells (ruling 269), row-major. */
export const STANDALONE_REFUSED_CELLS: readonly string[] = Object.freeze(
  (["page_playoff_only", "stepladder_only"] as const).flatMap((row) => SPORTS_11.map((s) => `${row}|${s}`)),
);

/** Every refused cell, `row|sport`. */
export const REFUSED_CELLS: readonly string[] = Object.freeze([...CHESS_REFUSED_CELLS, ...STANDALONE_REFUSED_CELLS]);

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

/** A refused cell's drop reason names the ruling and the refusal code: the chess one, */
export const REFUSED_REASON = /chess is individual-only \(owner ruling 2026-10-26\)[\s\S]*CHESS_INDIVIDUAL_ONLY/;
/** and the standalone one. */
export const STANDALONE_REASON = /not offered standalone[\s\S]*ruling 269[\s\S]*STEPLADDER_NEEDS_TABLE_SOURCE[\s\S]*PAGE_PLAYOFF_NEEDS_TABLE_SOURCE/;

/** The reason pattern the oracle expects on a refused cell. */
export function refusedReasonOf(cell: string): RegExp {
  return CHESS_REFUSED_CELLS.includes(cell) ? REFUSED_REASON : STANDALONE_REASON;
}

// Match Day C9 review I5, option 2 (controller ruling 2026-11-03): the same two formats are not OFFERED to a sport
// whose engine entrant model holds no individuals (round 3's shared rule) - the stage rotates individual players into pair
// entrants. Football, cricket, ice hockey and hockey hold teams only and volleyball teams and pairs
// (`entrantModel.kinds`). The stage create does not refuse them yet, so these cells stay offered and planned: every
// browser case on them is 🚫 (no screen reaches them) and their HTTP cases run as before.

/** The pair-format cells with no organiser path (C9 review I5), `row|sport`, row-major in the grid's order. */
export const PAIR_NO_PATH_CELLS: readonly string[] = Object.freeze([
  "americano|football", "americano|cricket", "americano|volleyball", "americano|icehockey", "americano|hockey",
  "mexicano|football", "mexicano|cricket", "mexicano|volleyball", "mexicano|icehockey", "mexicano|hockey",
]);

// Owner ruling 2026-11-01 (Match Day D1 legs Option A): the Triple round robin is offered to NO sport (STAGE_TEMPLATES
// marks it `retired`), yet nothing refuses it - the stage create still takes three legs and a stored division still plays
// it. So its row is a no-organiser-path row on EVERY sport: each browser case is 🚫 (the picker has no such radio to tick,
// the 14 harness errors of CI run 42356855670) and its HTTP cases run.

/** The template rows the builder offers to no sport: the ruling's literal (applicability.test.ts pins the product's own
 *  `retired` marks to it). */
export const RETIRED_ROWS: readonly string[] = Object.freeze(["triple_rr"]);
/** The retired rows' cells on every sport the ENGINE registers, in its registry order (the grid's column order). */
export const RETIRED_ROW_CELLS: readonly string[] = Object.freeze(RETIRED_ROWS.flatMap((r) => builtinModules.map((m) => `${r}|${m.key}`)));

/** Every cell with no organiser path, `row|sport`, row-major in the grid's order: triple_rr is the second row, so its
 *  cells come before the pair formats'. */
export const NO_ORGANISER_PATH_CELLS: readonly string[] = Object.freeze([...RETIRED_ROW_CELLS, ...PAIR_NO_PATH_CELLS]);

/** Is this `row|sport` cell one the builder does not offer although the product does not refuse it? */
export function isNoOrganiserPathCell(cell: string): boolean {
  return NO_ORGANISER_PATH_CELLS.includes(cell);
}

/** The wave a no-organiser-path cell routes to, from the rulings: the retired Triple round robin is the round-robin
 *  wave's triple_rr question (format-matrix _INDEX.md, W1a Task 6), the pair formats the americano wave's (controller
 *  ruling 2026-11-03). Any other cell is refused by name. */
export function noPathWaveOf(cell: string): "W5" | "W7" {
  if (RETIRED_ROW_CELLS.includes(cell)) return "W5";
  if (PAIR_NO_PATH_CELLS.includes(cell)) return "W7";
  throw new Error(`refused-cells: ${cell} is no no-organiser-path cell`);
}
