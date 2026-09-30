// The matrix's pad adapter: the bench's TapAdapter (ruling 38 — its tap
// vocabulary, imported, never copied) plus what a matrix sport owes on top of
// it. The matrix GENERATES its streams (streams/<sport>.ts), so an adapter
// declares every event type that generator emits, and each one is either
// routed to taps one for one or declared a fallback: a type the pad cannot
// write as one row, whose rows are judged by the fold instead of by payload.
// pad-adapters.test.ts holds every registered adapter to that, from the
// generator's own output.
import type { TapAdapter, TapAdapterContext } from "../../../bench/lib/drivers/scorer.ts";
import type { StreamEvent } from "../streams/types.ts";

/** One event type the pad writes as some other number of rows. `why` cites
 *  the product's file:line; `rowsFor` is how many ledger rows the taps for
 *  `event` write. */
export interface Fallback {
  readonly eventType: string;
  readonly why: string;
  rowsFor(event: StreamEvent, ctx: TapAdapterContext): number;
}

export interface MatrixPadAdapter extends TapAdapter {
  /** Every event type this sport's matrix generator emits (streams/<sport>.ts),
   *  core.forfeit aside (the organiser's, organiserStepsFor). Each is mapped by
   *  stepsFor or declared in fallbacks; pad-adapters.test.ts enforces it. */
  readonly emits: readonly string[];
  /** Types the pad cannot write one-for-one. stepsFor still returns the taps,
   *  which write `rowsFor` ledger rows; those rows are judged by fold, not by
   *  payload. */
  readonly fallbacks: readonly Fallback[];
  /** Keys an expected payload carries as null that the pad omits (the fold
   *  reads absent ≡ null). Omitted ≡ none. */
  nullAsAbsentKeys?(eventType: string): readonly string[];
}
