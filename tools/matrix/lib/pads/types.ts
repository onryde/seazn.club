// The matrix's pad adapter: the bench's TapAdapter (ruling 38 — its tap
// vocabulary, imported, never copied) plus what a matrix sport owes on top of
// it. The matrix GENERATES its streams (streams/<sport>.ts), so an adapter
// declares every event type that generator emits, and each one is either
// routed to taps one for one or declared a fallback: a type the pad cannot
// write as one equal row, whose rows its own judge compares with the event
// (fix round 1, I-1: a fallback is JUDGED, never waved through).
// pad-adapters.test.ts holds every registered adapter to that, from the
// generator's own output.
import type { TapAdapter, TapAdapterContext, TapStep } from "../../../bench/lib/drivers/scorer.ts";
import type { LedgerRow } from "../../../bench/lib/ledger.ts";
import type { Route } from "../routing.ts";
import type { StreamEvent } from "../streams/types.ts";

/** A judge's answer: ok, or not ok with `note` saying what differs. */
export interface FallbackJudgement { readonly ok: boolean; readonly note: string | null }

/** One event type the pad writes as some other number of rows, or as rows
 *  that are not the event's payload exactly. `why` cites the product's
 *  file:line; `rowsFor` is how many ledger rows the taps for `event` write;
 *  `writes` is every row type those taps store; `judge` compares the stored
 *  rows with the generated event. The replay answers a row of a type outside
 *  `writes`, or a refused judgement, as a mismatch. `judge` is optional in
 *  the type only so that an adapter built off the registry is answered by name
 *  (FallbackUnjudged) at replay; registerPads refuses a fallback without one. */
export interface Fallback {
  readonly eventType: string;
  readonly writes: readonly string[];
  readonly why: string;
  rowsFor(event: StreamEvent, ctx: TapAdapterContext): number;
  judge?(event: StreamEvent, stored: readonly LedgerRow[]): FallbackJudgement;
}

/** One tap as the replay timed it (W1d item 15a), so a tap-wait timeout can say
 *  what the last few taps did. `tap` counts every tap the replay made, from 1
 *  (a hold's release included); `clickedAtMs` is when it was issued, `waitedMs`
 *  how long its wait ran before it returned or threw, `budgetMs` the bound
 *  that wait was given (class 20: derived, never flat). `ledgerSeenAtMs` is when
 *  the rows of the EVENT this tap belongs to were read back, and null while
 *  they never were. Times come from the replay's clock, relative to its own
 *  zero (the driver's is the case start). */
export interface TapTiming {
  readonly tap: number;
  readonly clickedAtMs: number;
  readonly ledgerSeenAtMs: number | null;
  readonly waitedMs: number;
  readonly budgetMs: number;
}

/** Event types the pad offers no addressable control for (W1d item 16): no tap
 *  in the vocabulary can write them, so a stream holding one is not driven on
 *  the pad — the driver scores it over http and records `route`, which names
 *  the wave that owns the missing control. `stepsFor` of one throws (a replay
 *  called directly reads it as "no tap route"). One route per adapter: the
 *  mixed ledger refuses a second, different exemption for the same action. */
export interface NoControl { readonly eventTypes: readonly string[]; readonly route: Route }

export interface MatrixPadAdapter extends TapAdapter {
  /** The taps for ONE event. One-shot per event: the replay asks once, in
   *  stream order, and an adapter that keeps state across calls (cricket's
   *  innings taken since core.start) keeps it in the closure its factory
   *  returns — never at module scope, where a second adapter, or a second
   *  fixture's replay, would read the first's. Calling it twice for the same
   *  event is not supported: it may consume what it remembered. An event the
   *  pad cannot author throws (the TapAdapter contract). */
  stepsFor(event: { readonly type: string; readonly payload: unknown }, ctx: TapAdapterContext): readonly TapStep[];
  /** Every event type this sport's matrix generator emits (streams/<sport>.ts),
   *  core.forfeit aside (the organiser's, organiserStepsFor). Each is mapped by
   *  stepsFor or declared in fallbacks; pad-adapters.test.ts enforces it. */
  readonly emits: readonly string[];
  /** Types the pad cannot write one-for-one. stepsFor still returns the taps,
   *  which write `rowsFor` ledger rows of the `writes` types; the fallback's
   *  judge compares them with the event, and the fold judges the whole stream. */
  readonly fallbacks: readonly Fallback[];
  /** Types this sport's generator emits that the pad has no control for. Omitted ≡ none. */
  readonly noControl?: NoControl;
  /** Keys an expected payload carries as null that the pad omits (the fold
   *  reads absent ≡ null). Omitted ≡ none. */
  nullAsAbsentKeys?(eventType: string): readonly string[];
}
