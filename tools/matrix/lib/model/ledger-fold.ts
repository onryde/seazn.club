// The model's view of one fixture's ledger, folded by the engine exactly as
// the product folds it: foldMatchWithStoppage resolves voids first
// (core/events.ts resolveVoids), and only then do modules reduce. The product
// lifts a core.void's `payload.event_id` into the envelope's `voids`
// (usecases/scoring.ts); the kernel never validates a void's payload (it
// validates ACTIVE events only), so the envelope carries `{}`.
import { foldMatchWithStoppage, outcomeOf, type EventEnvelope, type MatchOutcome } from "@seazn/engine/core";
import { FOLD_OPTIONS, OFFLINE_RECORDED_AT, lineupsFor } from "../fold.ts";
import { sportModule } from "../sport-cfg.ts";

export interface LedgerEntry { readonly id: string; readonly seq: number; readonly type: string; readonly payload: unknown; readonly voids?: string }

export function ledgerEnvelopes(fixtureId: string, entries: readonly LedgerEntry[]): EventEnvelope[] {
  return entries.map((e) => ({
    id: e.id,
    fixtureId,
    seq: e.seq,
    type: e.type,
    payload: e.type === "core.void" ? {} : e.payload,
    recordedAt: OFFLINE_RECORDED_AT,
    recordedBy: null,
    ...(e.voids === undefined ? {} : { voids: e.voids }),
  }));
}

/** Entries neither voided nor themselves a void — the ledger's ACTIVE events. */
export function liveEntries(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const voided = new Set(entries.flatMap((e) => (e.voids === undefined ? [] : [e.voids])));
  return entries.filter((e) => e.type !== "core.void" && !voided.has(e.id));
}

/** The engine's outcome for this ledger, voids resolved; null for an empty
 *  ledger. An invalid ledger throws the engine's own EngineError. */
export function foldLedger(sport: string, cfg: unknown, home: string, away: string, entries: readonly LedgerEntry[]): MatchOutcome | null {
  if (entries.length === 0) return null;
  const m = sportModule(sport);
  // W2a finding 1: a settle lives beside module state (outcomeOf).
  const folded = foldMatchWithStoppage(m, cfg as never, lineupsFor(home, away), ledgerEnvelopes("model", entries), FOLD_OPTIONS);
  return outcomeOf(m, folded);
}
