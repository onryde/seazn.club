// Comparing a fallback's stored rows with its generated event (fix round 1,
// I-1: a fallback is JUDGED, never waved through). A fallback exists because
// the pad cannot write the event as one equal row, but what the pad DOES store
// is still the event's own content, so each adapter's judge compares that:
// every key the pad must write, stored and equal; any other generated key the
// pad stores, equal; and every key it stamps itself, of the shape it stamps.
// deepEqual moved here from replay.ts so that the adapters and the replay
// compare values the same way, and the adapters never load the replay.
import type { LedgerRow } from "../../../bench/lib/ledger.ts";
import type { StreamEvent } from "../streams/types.ts";
import type { FallbackJudgement } from "./types.ts";

export const JUDGED_OK: FallbackJudgement = Object.freeze({ ok: true, note: null });
const refused = (note: string): FallbackJudgement => ({ ok: false, note });

export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Structural equality; object keys in any order (the ledger's jsonb reorders them). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ak = Object.keys(a);
    const br = b as Record<string, unknown>;
    return ak.length === Object.keys(br).length && ak.every((k) => Object.hasOwn(br, k) && deepEqual((a as Record<string, unknown>)[k], br[k]));
  }
  return false;
}

export const show = (v: unknown): string => (v === undefined ? "(absent)" : JSON.stringify(v));

/** A key the pad stamps on its own (never generated): the shape it stamps. */
export interface Stamp { readonly shape: string; is(v: unknown): boolean }

/** One stored row against the generated event. Every `required` key is stored
 *  and equal to the generated value. Every other stored key is either
 *  generated and equal, or `stamped` and of the stamp's shape. A generated key
 *  the pad does not store passes: not writing it is why the event is a fallback. */
export function judgeKeys(expected: StreamEvent, row: LedgerRow, o: { required: readonly string[]; stamped?: Readonly<Record<string, Stamp>> }): FallbackJudgement {
  const want = asRecord(expected.payload);
  const got = asRecord(row.payload);
  for (const k of o.required) {
    if (!Object.hasOwn(got, k)) return refused(`${k}: stored (absent), generated ${show(want[k])}`);
  }
  for (const [k, v] of Object.entries(got)) {
    if (Object.hasOwn(want, k)) {
      if (!deepEqual(v, want[k])) return refused(`${k}: stored ${show(v)}, generated ${show(want[k])}`);
      continue;
    }
    const stamp = o.stamped?.[k];
    if (stamp === undefined) return refused(`untolerated key ${k}=${show(v)}`);
    if (!stamp.is(v)) return refused(`stamped ${k}=${show(v)} is not ${stamp.shape}`);
  }
  return JUDGED_OK;
}

/** A fallback whose taps write exactly one row: judge that row, and refuse any
 *  other count by name. The replay collects exactly `rowsFor` rows, so a
 *  second row reaches a judge only through a rowsFor that no longer matches it. */
export function judgeOneRow(rows: readonly LedgerRow[], writer: string, judge: (row: LedgerRow) => FallbackJudgement): FallbackJudgement {
  if (rows.length !== 1) return refused(`${rows.length} rows, where ${writer} writes 1`);
  return judge(rows[0]);
}
