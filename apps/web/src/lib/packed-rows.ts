// W5 follow-ups B5 (perf-measure-report P3/P4): a list of flat records sent as COLUMNS - each key written once, and a column
// whose values are strings that repeat (entrant ids, statuses, pool ids, dates of a round) written as a dictionary plus one
// small index per row. The public division doc and the hub doc carry ~5,000 fixtures at the caps; as an array of objects that
// is 5 MB of JSON, over Next's 2 MB `unstable_cache` item limit (an entry over it is logged and never stored), and the same
// bytes again in the page's RSC flight. Packed, the same rows are well under half.
//
// LOSSLESS for what JSON and the RSC flight carry: every row comes back with the same keys and the same values, in the same
// order of rows. Nested values (an outcome, a summary, a slot label) are kept as they are, by reference. Two things are not
// kept, on purpose, because neither wire keeps them either: a key whose value is `undefined` reads as absent (JSON drops it),
// and the order of keys inside one row is the column order (first seen across the rows).
//
// Pure and dependency-free: it runs on the server (packing a cache entry, a client prop) and in the browser (unpacking it).

/** One column: `d`/`i` a dictionary of strings (`i[row]` its index, {@link ABSENT} or {@link NULL}); else `v` the raw values
 *  with `a` the rows that do not carry the key. */
export type PackedColumn = { k: string; d: string[]; i: number[] } | { k: string; v: unknown[]; a?: number[] };

/** Rows of `T`, packed. The type parameter only travels with the value, so an unpack names what it gets back. */
export interface PackedRows<T> {
  /** Row count - a list with no column (rows that are all `{}`) still has its length. */
  n: number;
  c: PackedColumn[];
  /** Phantom: never set. */
  readonly __rows?: T;
}

const ABSENT = -1;
const NULL = -2;

/** A string column is a dictionary when its distinct values are at most this share of its rows; a column of unique strings
 *  (fixture ids) costs more as a dictionary than as itself. */
const DICTIONARY_SHARE = 0.5;

export function packRows<T extends object>(rows: readonly T[]): PackedRows<T> {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  const columns = keys.map((k): PackedColumn => {
    let allStrings = true;
    const distinct = new Set<string>();
    for (const row of rows) {
      const v = (row as Record<string, unknown>)[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== "string") {
        allStrings = false;
        break;
      }
      distinct.add(v);
    }
    if (allStrings && distinct.size <= rows.length * DICTIONARY_SHARE) {
      const d = [...distinct];
      const at = new Map(d.map((s, idx) => [s, idx]));
      const i = rows.map((row) => {
        const v = (row as Record<string, unknown>)[k];
        if (v === undefined) return ABSENT;
        if (v === null) return NULL;
        return at.get(v as string)!;
      });
      return { k, d, i };
    }
    const v: unknown[] = [];
    const a: number[] = [];
    rows.forEach((row, r) => {
      const value = (row as Record<string, unknown>)[k];
      if (value === undefined) {
        a.push(r);
        v.push(null);
      } else v.push(value);
    });
    return a.length > 0 ? { k, v, a } : { k, v };
  });
  return { n: rows.length, c: columns };
}

export function unpackRows<T>(packed: PackedRows<T>): T[] {
  const rows: Record<string, unknown>[] = Array.from({ length: packed.n }, () => ({}));
  for (const col of packed.c) {
    if ("d" in col) {
      col.i.forEach((idx, r) => {
        if (idx === ABSENT) return;
        rows[r]![col.k] = idx === NULL ? null : col.d[idx];
      });
    } else {
      const absent = col.a === undefined ? null : new Set(col.a);
      col.v.forEach((value, r) => {
        if (absent?.has(r)) return;
        rows[r]![col.k] = value;
      });
    }
  }
  return rows as T[];
}
