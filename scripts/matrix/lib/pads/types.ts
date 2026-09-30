// The matrix's pad adapter: the bench's TapAdapter (ruling 38 — its tap
// vocabulary, imported, never copied) plus what a matrix sport owes on top of
// it. The matrix GENERATES its streams (streams/<sport>.ts), so an adapter
// declares every event type that generator emits, and each one is either
// routed to taps one for one or declared a fallback: a type the pad cannot
// write as one equal row, whose rows its own judge compares with the event
// (fix round 1, I-1: a fallback is JUDGED, never waved through).
// pad-adapters.test.ts holds every registered adapter to that, from the
// generator's own output.
import type { TapAdapter, TapAdapterContext } from "../../../bench/lib/drivers/scorer.ts";
import type { LedgerRow } from "../../../bench/lib/ledger.ts";
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

export interface MatrixPadAdapter extends TapAdapter {
  /** Every event type this sport's matrix generator emits (streams/<sport>.ts),
   *  core.forfeit aside (the organiser's, organiserStepsFor). Each is mapped by
   *  stepsFor or declared in fallbacks; pad-adapters.test.ts enforces it. */
  readonly emits: readonly string[];
  /** Types the pad cannot write one-for-one. stepsFor still returns the taps,
   *  which write `rowsFor` ledger rows of the `writes` types; the fallback's
   *  judge compares them with the event, and the fold judges the whole stream. */
  readonly fallbacks: readonly Fallback[];
  /** Keys an expected payload carries as null that the pad omits (the fold
   *  reads absent ≡ null). Omitted ≡ none. */
  nullAsAbsentKeys?(eventType: string): readonly string[];
}
