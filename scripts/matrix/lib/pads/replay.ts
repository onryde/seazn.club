// One generated event → the adapter's taps → the ledger rows those taps wrote,
// compared with the event (W1c Task 7). Ruling 38: the bench's
// one-event-one-row contract and its exact bidirectional payload comparison
// (scorer.ts:465-496, comparePayload + isPlausibleTolerableValue), rebuilt
// here without the bench match loop's fixed widths and unconditional finalize
// (ruling 38 refuses that loop by name) — the matrix finalizes from the
// console as its own step (PADPROOF).
//
// The ledger is read after the SERVER's tip, never a count of taps: a held
// tap is not sequenced until its hold releases (bench ledger.ts:1-17), so only
// the product can say where the next row lands. Each event's rows are the
// first ones after the previous event's last seq.
//
// Every wait is derived (AGENTS class 20; browser-budget.test.ts scans this
// file for a flat timeout): a tap's own bound is one step's budget, and the
// ledger is polled for as long as the event's taps plus one hold window cost.
import type { LedgerRow } from "../../../bench/lib/ledger.ts";
import { TAP_WAIT_TIMEOUT_MS, type PadPage, type TapAdapterContext, type TapStep } from "../../../bench/lib/drivers/scorer.ts";
import { TAP_PACE_MS, budgetMs } from "../browser/budget.ts";
import type { StreamEvent } from "../streams/types.ts";
import { executeStep } from "./execute.ts";
import type { MatrixPadAdapter } from "./types.ts";

/** The ledger's poll spacing: the bench's LEDGER_POLL_INTERVAL_MS (scorer.ts:197). */
export const POLL_MS = 200;

export interface ReplayDeps {
  /** The fixture's ledger rows after `sinceSeq` (exclusive). */
  ledger(sinceSeq: number): Promise<readonly LedgerRow[]>;
  /** The server's last seq for the fixture, read once before the first tap. */
  tip(): Promise<number>;
  sleep(ms: number): Promise<void>;
  /** The build's hold window (holdMsFromEnv). */
  holdMs: number;
  /** Called after each tap an event's route makes, with the event's index —
   *  the driver's mid-sheet picture rides it. */
  onTap?(eventIndex: number, step: TapStep): Promise<void>;
}

export type RowVerdict = "equal" | "tolerated" | "fallback" | "mismatch" | "missing";
export interface ReplayRow { expected: StreamEvent; stored: readonly LedgerRow[]; verdict: RowVerdict; note: string | null }
/** `stored`: every row the replay read, as the product holds it, in seq order —
 *  what the fold judges. `findings`: why the replay stopped early, if it did. */
export interface ReplayResult { rows: ReplayRow[]; stored: LedgerRow[]; findings: string[] }

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Structural equality; object keys in any order (the ledger's jsonb reorders them). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ak = Object.keys(a);
    const br = b as Record<string, unknown>;
    return ak.length === Object.keys(br).length && ak.every((k) => Object.hasOwn(br, k) && deepEqual((a as Record<string, unknown>)[k], br[k]));
  }
  return false;
}

const show = (v: unknown): string => (v === undefined ? "(absent)" : JSON.stringify(v));

/** The bench's rule for a tolerated key (scorer.ts isPlausibleTolerableValue):
 *  every tolerated key names a person id the pad stamps, so only a non-empty
 *  string is one (class 19 — pin what a tolerated key opens AT). */
function isPlausibleTolerableValue(v: unknown): boolean {
  return typeof v === "string" && v.length > 0;
}

/** Exact in both directions: every generated key stored with an equal value
 *  (a declared nullAsAbsent key may be absent where null was generated), and
 *  every stored key generated — or tolerated by the adapter, as a plausible id. */
export function compareRow(expected: StreamEvent, row: LedgerRow, adapter: MatrixPadAdapter): { verdict: "equal" | "tolerated" | "mismatch"; note: string | null } {
  if (row.type !== expected.type) return { verdict: "mismatch", note: `type ${row.type}, expected ${expected.type}` };
  const want = asRecord(expected.payload);
  const got = asRecord(row.payload);
  const nullOk = new Set(adapter.nullAsAbsentKeys?.(expected.type) ?? []);
  const tolerable = new Set(adapter.tolerableExtraKeys?.(expected.type) ?? []);
  for (const [k, v] of Object.entries(want)) {
    if (!Object.hasOwn(got, k) && v === null && nullOk.has(k)) continue;
    if (!Object.hasOwn(got, k) || !deepEqual(got[k], v)) return { verdict: "mismatch", note: `${k}: stored ${show(got[k])}, generated ${show(v)}` };
  }
  const extra = Object.keys(got).filter((k) => !Object.hasOwn(want, k));
  const bad = extra.filter((k) => !(tolerable.has(k) && isPlausibleTolerableValue(got[k])));
  if (bad.length > 0) return { verdict: "mismatch", note: `untolerated key(s) ${bad.join(", ")}` };
  return extra.length > 0 ? { verdict: "tolerated", note: `tolerated ${extra.map((k) => `${k}=${JSON.stringify(got[k])}`).join(", ")}` } : { verdict: "equal", note: null };
}

/** Taps `events` in order and reads back the rows each one wrote. Stops at the
 *  first event that has no route, a row that differs, or rows that never came:
 *  every later tap would build on a state the stream never meant. */
export async function replayEvents(page: PadPage, adapter: MatrixPadAdapter, events: readonly StreamEvent[], ctx: TapAdapterContext, deps: ReplayDeps): Promise<ReplayResult> {
  const out: ReplayResult = { rows: [], stored: [], findings: [] };
  if (events.length === 0) return out;
  let tip = await deps.tip();
  let tapped = false;
  const waitMs = Math.max(TAP_WAIT_TIMEOUT_MS, budgetMs({ taps: 1, holds: 0, holdMs: deps.holdMs }));
  for (const [i, ev] of events.entries()) {
    const at = `event ${i + 1} of ${events.length} (${ev.type})`;
    const fallback = adapter.fallbacks.find((f) => f.eventType === ev.type) ?? null;
    let steps: readonly TapStep[];
    try {
      steps = adapter.stepsFor(ev, ctx);
    } catch (e) {
      out.findings.push(`${at}: no tap route — ${e instanceof Error ? e.message : String(e)}`);
      break;
    }
    // A route with no taps writes nothing; a row read after it would be someone else's.
    if (steps.length === 0) {
      out.findings.push(`${at}: no tap route — the adapter answered no steps`);
      break;
    }
    for (const step of steps) {
      if (tapped && step.kind !== "releaseHold") await deps.sleep(TAP_PACE_MS);
      tapped = true;
      await executeStep(page, step, waitMs);
      await deps.onTap?.(i, step);
    }
    await executeStep(page, { kind: "releaseHold" }, waitMs);
    const want = fallback?.rowsFor(ev, ctx) ?? 1;
    const deadline = budgetMs({ taps: steps.length, holds: 1, holdMs: deps.holdMs });
    // Read at once, then every POLL_MS until the rows are there or the whole
    // deadline has been waited — never a poll short of it.
    let rows = await deps.ledger(tip);
    for (let waited = 0; rows.length < want && waited < deadline; waited += POLL_MS) {
      await deps.sleep(POLL_MS);
      rows = await deps.ledger(tip);
    }
    if (rows.length < want) {
      out.rows.push({ expected: ev, stored: rows, verdict: "missing", note: `${rows.length} of ${want} row(s) within ${deadline}ms` });
      out.stored.push(...rows);
      out.findings.push(`stopped after event ${i + 1} of ${events.length}: row missing`);
      break;
    }
    // No other tap ran since `tip`, so a row past `want` is this event's too:
    // the product wrote more than its route declares.
    if (rows.length > want) {
      const note = `${rows.length} row(s) after seq ${tip}, the route writes ${want}`;
      out.rows.push({ expected: ev, stored: rows, verdict: "mismatch", note });
      out.stored.push(...rows);
      out.findings.push(`stopped after event ${i + 1} of ${events.length}: ${note}`);
      break;
    }
    const mine = rows;
    tip = mine.at(-1)!.seq;
    out.stored.push(...mine);
    if (fallback !== null) {
      out.rows.push({ expected: ev, stored: mine, verdict: "fallback", note: fallback.why });
      continue;
    }
    const c = compareRow(ev, mine[0], adapter);
    out.rows.push({ expected: ev, stored: mine, verdict: c.verdict, note: c.note });
    if (c.verdict === "mismatch") {
      out.findings.push(`stopped after event ${i + 1} of ${events.length}: ${c.note}`);
      return out;
    }
  }
  if (out.findings.length > 0) return out;
  // Every event landed: one closing read, so a row the pad wrote past the last
  // event's is never left unread (the bench's NB4, unreadRowsAfterFinalize).
  const late = await deps.ledger(tip);
  if (late.length > 0) {
    out.stored.push(...late);
    out.findings.push(`${late.length} row(s) after the last event's (seq ${tip}): ${late.map((r) => r.type).join(", ")}`);
  }
  return out;
}
