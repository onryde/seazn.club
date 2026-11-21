// W5 stress fix F1: THE way a bulk writer inserts fixture rows. Start, Generate, Rebuild, the round-robin and Swiss reconciles,
// the Swiss round shells and a late entrant's catch-up lines all wrote every new line in ONE `insert into fixtures`, and the
// driver refuses a statement past its bind-parameter ceiling: a 17-column line stopped a stage at 3,854 lines (a league at 88
// entrants; no 500-entrant round-robin could start). The rows now go in as many statements as the ceiling needs, on the
// CALLER's transaction, so a failure in any batch still rolls back every row (all or nothing, as one statement was).
import type postgres from "postgres";

type Tx = postgres.TransactionSql;

/**
 * The most bind parameters one statement carries through this app's driver. Postgres counts a Bind message's parameters in an
 * Int16 (65,535), and postgres.js refuses a statement before sending it once the count reaches 65,534 (`connection.js`:
 * `q.parameters.length >= 65534` -> MAX_PARAMETERS_EXCEEDED), so 65,533 is the most that goes through. Pinned against the real
 * driver by `fixture-insert-batches.test.ts` (this many binds are accepted, one more is refused by name).
 */
export const MAX_BIND_PARAMETERS = 65_533;

/** Rows per statement for a multi-row insert whose rows bind `columns` parameters each. */
export function rowsPerInsert(columns: number): number {
  if (!Number.isInteger(columns) || columns < 1 || columns > MAX_BIND_PARAMETERS) {
    throw new Error(`rowsPerInsert: ${columns} columns is not a row shape`);
  }
  return Math.floor(MAX_BIND_PARAMETERS / columns);
}

/** A row value the driver expands into more than one bind, read exactly as its `stringifyValue` (`types.js`) branches: a query
 *  fragment (`tx\`...\``, a `Query`, which is a Promise), an array of them, or a helper `Builder` (`tx(obj)`, which `build`s).
 *  Every other value binds exactly one: a scalar, null, a Date, an array, and `tx.json(...)` - the driver's `Parameter`, which
 *  carries the same `then` a query does (both extend its `NotTagged`), so a `then` probe cannot tell them apart. */
function isFragment(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  if (v instanceof Promise) return true;
  if (Array.isArray(v)) return v[0] instanceof Promise;
  return typeof (v as { build?: unknown }).build === "function";
}

/**
 * Insert `rows` into `fixtures` in batches of `rowsPerInsert(columns)`, in order, on the caller's transaction. The columns are
 * the FIRST row's keys, as the driver's own `tx(rows)` reads them, and are passed to every batch, so each batch writes the
 * same column list. A row value that would bind more than one parameter is refused before any statement is sent.
 */
export async function insertFixtureRows(tx: Tx, rows: readonly Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]!);
  for (const row of rows) {
    for (const c of columns) {
      if (isFragment(row[c])) throw new Error(`insertFixtureRows: column ${c} holds an SQL fragment, which binds more than one parameter`);
    }
  }
  const size = rowsPerInsert(columns.length);
  for (let i = 0; i < rows.length; i += size) {
    await tx`insert into fixtures ${tx(rows.slice(i, i + size) as never, columns)}`;
  }
}
