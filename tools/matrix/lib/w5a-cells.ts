// Which (row, sport) cells a W5A round-robin script is planned on (W5 app PR A, Task 24; T5-b). Derived, never typed per cell: a row
// is a TABLE row when its entry (first) stage is a league or a group (a root table is where a late player joins, RB5-L1, and where a
// withdrawal expunges, RB5-W2), a FED row when a second stage takes from it (a departure leaves its cut, RB5-K1; a correction stales its
// proposal, RB5-K6), a POOLED row when a group stage is among its stages (unequal pools, RB5-U1). Every sport of the registry plays them:
// a late player, a departure, a pinned rank and a correction read seats and tables, which no sport field reaches (the product's own
// roundrobin-late-entry-matrix sweeps a second sport for the same reason).
//
// The scripts are OPT-IN, as W2a's, W2b's, W2e's, W4A's and W4B's are: --set w1-driving plans them only when --scenario names one
// (w1-driving-set.ts), so no committed plan holds a cell of theirs. W5A_F4 and W5A_C5 are planned and NOT RUN (app PR B).
import { ROW_KEYS, SPORT_KEYS, stagesForRow, type RowKey } from "./catalogue.ts";
import type { W5aScenarioKey } from "./scenarios/types.ts";

const TABLE_KINDS: ReadonlySet<string> = new Set(["league", "group"]);

// Derived on FIRST USE, never at import (probe-set.test.ts, "the rows are derived when the set is BUILT, never at import"): this module
// is imported by run.ts's whole scenario graph, so a `stagesForRow` that throws for one row must refuse by name where the set is
// built, not take the import (and every other command) down with it. Memoised: the catalogue's rows are constant for a process.
interface Derived { readonly table: readonly RowKey[]; readonly fed: readonly RowKey[]; readonly pooled: readonly RowKey[] }
let derived: Derived | null = null;
function derive(): Derived {
  if (derived !== null) return derived;
  const table = Object.freeze(ROW_KEYS.filter((r) => TABLE_KINDS.has(stagesForRow(r)[0]?.kind ?? "")));
  derived = {
    table,
    fed: Object.freeze(table.filter((r) => (stagesForRow(r)[1]?.progression?.sources?.length ?? 0) > 0)),
    pooled: Object.freeze(table.filter((r) => stagesForRow(r).some((s) => s.kind === "group"))),
  };
  return derived;
}
/** The rows whose entry stage is a root league or group (the API-only and refused rows included: `stagesForRow` builds every one). */
export const w5aTableRows = (): readonly RowKey[] => derive().table;
/** The table rows a later stage is fed from (progression sources on stage 2). */
export const w5aFedRows = (): readonly RowKey[] => derive().fed;
/** The table rows with a pooled (group) stage. */
export const w5aPooledRows = (): readonly RowKey[] => derive().pooled;

/** The scripts that RUN, and the ones planned and not run (they wait for app PR B's engine major: unequal pools at k = size - min, adjust points). */
export const W5A_RUN_KEYS: readonly W5aScenarioKey[] = Object.freeze(["W5A_R2", "W5A_R4C", "W5A_Q2", "W5A_P7", "W5A_C6A", "W5A_SURF"] as const);
export const W5A_NOT_RUN_KEYS: readonly W5aScenarioKey[] = Object.freeze(["W5A_F4", "W5A_C5"] as const);

/** The rows each script plays. */
export function w5aRows(key: W5aScenarioKey): readonly RowKey[] {
  switch (key) {
    case "W5A_R2": case "W5A_R4C": case "W5A_P7": case "W5A_SURF": case "W5A_C5": return w5aTableRows();
    case "W5A_Q2": case "W5A_C6A": return w5aFedRows();
    case "W5A_F4": return w5aPooledRows();
  }
}

/** The catalogue atoms each script drives (scenario-catalogue.ts ATOMIC ids; the test pins every id to the atom list, so a rename there reds here). SURF is no atom: it is the
 *  "surfaces asserted after every scenario" of design 6.7 T5-b (the table's API shape), run on its own and appended to the others. */
export const W5A_ATOMS: Readonly<Record<Exclude<W5aScenarioKey, "W5A_SURF">, string>> = Object.freeze({
  W5A_R2: "R2", W5A_R4C: "R4c", W5A_Q2: "Q2", W5A_P7: "P7", W5A_C6A: "C6a", W5A_F4: "F4", W5A_C5: "C5",
});

/** How many pools the row's entry stage draws (1: a league). */
export function entryPools(row: RowKey): number {
  const first = stagesForRow(row)[0];
  const raw = first?.kind === "group" ? (first.config.pools as { count?: unknown } | undefined)?.count : undefined;
  return typeof raw === "number" ? raw : 1;
}

/** The field a script seeds on `row`: small, and shaped so the rule under test has something to act on. Pooled rows scale with the pool count
 *  (a pool of two plays one match, so "under half" needs pools of four; a cut of two per pool needs a third entrant to promote). */
export function w5aField(key: W5aScenarioKey, row: RowKey): number {
  const pools = entryPools(row);
  switch (key) {
    // an odd field, so a pool or the league has a bye for a newcomer to take (RB5-L3), and a pool one smaller than the rest (RB5-L9)
    case "W5A_R2": return pools === 1 ? 5 : 2 * pools + 1;
    // pools of four: the withdrawn entrant owes three matches, one played is under half (RB5-W2)
    case "W5A_R4C": return pools === 1 ? 6 : pools * 4;
    // a cut of four from six, or two per pool from pools of three or four: somebody is next in line
    case "W5A_Q2": case "W5A_C6A": return pools === 1 ? 6 : pools === 2 ? 8 : pools * 3;
    case "W5A_P7": return pools === 1 ? 6 : pools * 3;
    case "W5A_SURF": case "W5A_F4": case "W5A_C5": return 8;
  }
}

export interface W5aCell { readonly row: RowKey; readonly sport: string }

/** The scenario's cells, row-major in the registry's order, less the cells `isDropped` drops (the committed LIFECYCLE drops: a cell the product refuses). */
export function w5aCells(key: W5aScenarioKey, isDropped: (row: RowKey, sport: string) => boolean = () => false): W5aCell[] {
  const out: W5aCell[] = [];
  for (const row of w5aRows(key)) for (const sport of SPORT_KEYS) if (!isDropped(row, sport)) out.push({ row, sport });
  return out;
}
