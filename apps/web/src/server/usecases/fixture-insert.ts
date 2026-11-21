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
 *
 * W5 B4 (stress F8): rows that arrive unnumbered are numbered HERE, once per call, exactly as the V263 trigger
 * (`assign_fixture_no`) numbers them one row at a time: under the trigger's own advisory key (`fixture_no:<division>`), the
 * division's max, then max+1 onward in row order. The trigger skips a row that arrives numbered. Its per-row `max()` ran under
 * the app's role with the tenant policy's org filter, and that read grew with the rows already written: a 4,950-line Start spent
 * 9.6 s of its 10.4 s numbering lines (the same insert, numbered in advance: 0.8 s). One call writes one division's lines (every
 * caller inserts one stage's), and rows of two divisions are refused before anything is sent. Rows a caller numbered itself
 * (the first row carries `fixture_no`) go in as they are.
 */
export async function insertFixtureRows(tx: Tx, rows: readonly Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const numbered = Object.hasOwn(rows[0]!, "fixture_no");
  const columns = numbered ? Object.keys(rows[0]!) : [...Object.keys(rows[0]!), "fixture_no"];
  for (const row of rows) {
    for (const c of columns) {
      if (isFragment(row[c])) throw new Error(`insertFixtureRows: column ${c} holds an SQL fragment, which binds more than one parameter`);
    }
  }
  const out = numbered ? rows : await numberRows(tx, rows);
  const size = rowsPerInsert(columns.length);
  for (let i = 0; i < out.length; i += size) {
    await tx`insert into fixtures ${tx(out.slice(i, i + size) as never, columns)}`;
  }
}

/** The rows with `fixture_no` max+1 onward, read once under the trigger's own key; refused before any statement when they name
 *  no division or two. */
async function numberRows(tx: Tx, rows: readonly Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const division = rows[0]!.division_id;
  if (typeof division !== "string") throw new Error("insertFixtureRows: a row names no division, so its line cannot be numbered");
  const other = rows.find((r) => r.division_id !== division);
  if (other !== undefined) {
    throw new Error(`insertFixtureRows: rows of two divisions (${division}, ${String(other.division_id)}) in one call; one division's lines are numbered per call`);
  }
  // The trigger's own key and order (V263): lock first, then read, so a concurrent writer's committed lines are counted.
  await tx`select pg_advisory_xact_lock(hashtext('fixture_no:' || ${division}::uuid::text))`;
  const [{ max }] = await tx<{ max: number }[]>`select coalesce(max(fixture_no), 0)::int as max from fixtures where division_id = ${division}`;
  return rows.map((r, i) => ({ ...r, fixture_no: max + i + 1 }));
}
