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
import { asRecord, deepEqual, show } from "./judge.ts";
import { redact } from "../redact.ts";
import type { Fallback, FallbackJudgement, MatrixPadAdapter, TapTiming } from "./types.ts";

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
  /** The clock the tap timings read, in ms from the caller's zero (the driver:
   *  the case's start). Absent: ms since the replay began. */
  readonly now?: () => number;
}

/** How many tap timings a tap-wait timeout carries (W1d item 15a). */
export const TAP_TIMING_KEEP = 5;

/** A tap's wait ran out (Playwright's TimeoutError). Its message is the
 *  timeout's first line, then the timings of the last TAP_TIMING_KEEP taps as
 *  JSON — everything redacted, since a driver error can quote an env value. */
export class TapWaitTimeout extends Error {
  readonly timings: readonly TapTiming[];
  constructor(first: string, timings: readonly TapTiming[]) {
    super(withTimings(first, timings));
    this.name = "TapWaitTimeout";
    this.timings = timings.map((t) => ({ ...t }));
  }
}

/** `<text> — last taps: <JSON of the timings>`, redacted as one string (the
 *  timings are numbers, so what redaction guards is `text`). */
export function withTimings(text: string, timings: readonly TapTiming[]): string {
  return redact(`${text} — last taps: ${JSON.stringify(timings)}`);
}

/** Playwright's own: `locator.waitFor: Timeout 15000ms exceeded.` is a
 *  TimeoutError. The name is the contract; the message shape is the fallback
 *  for a page object that wraps it. */
function isWaitTimeout(e: unknown): e is Error {
  return e instanceof Error && (e.name === "TimeoutError" || /\bTimeout \d+ms exceeded\b/.test(e.message.split("\n")[0]));
}

export type RowVerdict = "equal" | "tolerated" | "fallback" | "mismatch" | "missing";
export interface ReplayRow { expected: StreamEvent; stored: readonly LedgerRow[]; verdict: RowVerdict; note: string | null }
/** `stored`: every row the replay read, as the product holds it, in seq order —
 *  what the fold judges. `findings`: why the replay stopped early, if it did. */
export interface ReplayResult { rows: ReplayRow[]; stored: LedgerRow[]; findings: string[] }

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

/** The rows an event's taps write: 1, or a declared fallback's rowsFor — which
 *  must be a whole number ≥ 1. Anything else (or a throw) is answered as the
 *  text the finding quotes. */
function rowsWanted(fallback: Fallback | null, ev: StreamEvent, ctx: TapAdapterContext): number | string {
  if (fallback === null) return 1;
  let n: number;
  try {
    n = fallback.rowsFor(ev, ctx);
  } catch (e) {
    return `a throw (${errorLine(e)})`;
  }
  return Number.isInteger(n) && n >= 1 ? n : String(n);
}

/** Fix round 1 (I-1): a fallback is JUDGED, never waved through. Its rows
 *  must be of a type it declares it writes, and its judge must accept them
 *  against the generated event. Answers null when they pass, or the note the
 *  mismatch carries: a wrong type (the judge is not asked), no judge (an
 *  adapter built off the registry, which registerPads would refuse), a judge
 *  that throws, or a judge's refusal. */
function judgeFallback(f: Fallback, ev: StreamEvent, rows: readonly LedgerRow[]): string | null {
  const alien = [...new Set(rows.filter((r) => !f.writes.includes(r.type)).map((r) => r.type))];
  if (alien.length > 0) return `FallbackRowType — stored ${alien.join(", ")}; the ${f.eventType} fallback writes ${f.writes.join(", ")}`;
  if (f.judge === undefined) return `FallbackUnjudged — the ${f.eventType} fallback declares no judge; a fallback is judged, never waved through`;
  let j: FallbackJudgement;
  try {
    j = f.judge(ev, rows);
  } catch (e) {
    return `FallbackMismatch — the ${f.eventType} judge threw (${errorLine(e)})`;
  }
  if (j.ok) return null;
  // W1d Mn-2: a judge that refuses and says nothing still owes both sides — a
  // bare "refused" leaves the reader to refetch what was stored and what was generated.
  const note = typeof j.note === "string" && j.note.trim() !== "" ? j.note
    : `the judge refused ${rows.length} stored row(s) without a note: stored ${rows.map((r) => `${r.type} ${JSON.stringify(r.payload)}`).join(", ")}; generated ${ev.type} ${JSON.stringify(ev.payload)}`;
  return `FallbackMismatch — ${note}`;
}

/** An error's name and first line — Playwright's messages carry a multi-line
 *  call log after it. A non-Error throw is quoted as it is. */
function errorLine(e: unknown): string {
  if (!(e instanceof Error)) return String(e).split("\n")[0];
  return `${e.name}: ${firstLine(e)}`;
}

const firstLine = (e: Error): string => e.message.split("\n")[0];

/** Taps `events` in order and reads back the rows each one wrote. Stops at the
 *  first event that has no route, a row that differs, or rows that never came:
 *  every later tap would build on a state the stream never meant. */
export async function replayEvents(page: PadPage, adapter: MatrixPadAdapter, events: readonly StreamEvent[], ctx: TapAdapterContext, deps: ReplayDeps): Promise<ReplayResult> {
  const out: ReplayResult = { rows: [], stored: [], findings: [] };
  if (events.length === 0) return out;
  let tip = await deps.tip();
  let tapped = false;
  const zero = performance.now();
  const now = deps.now ?? ((): number => performance.now() - zero);
  /** The last TAP_TIMING_KEEP taps, oldest first; `count` is every tap made. */
  const ring: TapTiming[] = [];
  let count = 0;
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
    // Carry (d): how many rows the taps write is known before the first tap. A
    // fallback writes at least one; 0, NaN or a fraction would crash the tip
    // read below or pass whatever rows came, so it is refused by name, untapped.
    const want = rowsWanted(fallback, ev, ctx);
    if (typeof want === "string") {
      out.findings.push(`${at}: FallbackRowsInvalid — rowsFor answered ${want}; a fallback writes a whole number ≥ 1 of rows`);
      break;
    }
    // Carry (e): a tap that fails is this event's finding, never a raw throw
    // that takes the case's other checks with it. The rows the product wrote
    // before it failed are still read, so the fold judges what it holds.
    const all: readonly TapStep[] = [...steps, { kind: "releaseHold" }];
    let failed: string | null = null;
    // 15a: this event's timings, kept in the ring; the event's rows being read
    // stamps them all `ledgerSeenAtMs`.
    const evTimings: Array<{ -readonly [K in keyof TapTiming]: TapTiming[K] }> = [];
    for (const [k, step] of all.entries()) {
      const release = k === steps.length;
      if (tapped && step.kind !== "releaseHold") await deps.sleep(TAP_PACE_MS);
      tapped = true;
      const timing: { -readonly [K in keyof TapTiming]: TapTiming[K] } = { tap: ++count, clickedAtMs: now(), ledgerSeenAtMs: null, waitedMs: 0, budgetMs: waitMs };
      evTimings.push(timing);
      ring.push(timing);
      if (ring.length > TAP_TIMING_KEEP) ring.shift();
      try {
        await executeStep(page, step, waitMs);
        timing.waitedMs = now() - timing.clickedAtMs;
      } catch (e) {
        timing.waitedMs = now() - timing.clickedAtMs;
        failed = `tap ${k + 1} of ${all.length} (${step.kind}) failed: ${errorLine(isWaitTimeout(e) ? new TapWaitTimeout(firstLine(e), ring) : e)}`;
        break;
      }
      if (!release) await deps.onTap?.(i, step);
    }
    if (failed !== null) {
      const rows = await deps.ledger(tip);
      out.rows.push({ expected: ev, stored: rows, verdict: "missing", note: failed });
      out.stored.push(...rows);
      out.findings.push(`stopped after event ${i + 1} of ${events.length}: ${failed}`);
      break;
    }
    const deadline = budgetMs({ taps: steps.length, holds: 1, holdMs: deps.holdMs });
    // Read at once, then every POLL_MS until the rows are there or the whole
    // deadline has been waited — never a poll short of it.
    let rows = await deps.ledger(tip);
    for (let waited = 0; rows.length < want && waited < deadline; waited += POLL_MS) {
      await deps.sleep(POLL_MS);
      rows = await deps.ledger(tip);
    }
    if (rows.length < want) {
      out.rows.push({ expected: ev, stored: rows, verdict: "missing", note: withTimings(`${rows.length} of ${want} row(s) within ${deadline}ms`, ring) });
      out.stored.push(...rows);
      out.findings.push(`stopped after event ${i + 1} of ${events.length}: row missing`);
      break;
    }
    const seenAt = now();
    for (const t of evTimings) t.ledgerSeenAtMs = seenAt;
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
      const refused = judgeFallback(fallback, ev, mine);
      if (refused === null) {
        out.rows.push({ expected: ev, stored: mine, verdict: "fallback", note: fallback.why });
        continue;
      }
      out.rows.push({ expected: ev, stored: mine, verdict: "mismatch", note: refused });
      out.findings.push(`stopped after event ${i + 1} of ${events.length}: ${refused}`);
      return out;
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
