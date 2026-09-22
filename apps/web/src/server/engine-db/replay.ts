import "server-only";
// W2 (design §6) — reconstruct the answer a past append gave, from the ledger.
//
// The duplicate-write path needs the ORIGINAL outcome, and the only durable
// record of it is the ledger itself. `match_states` is not that record: it
// holds the CURRENT state, which is a different answer the moment one more
// event lands. Handing a retrying pad the current state instead of the answer
// its write produced would silently regress what it is showing.
import { withTenant } from "@/lib/db";
import { loadFoldInputs, foldFrom } from "./fold";
import { nextStatus } from "./append-event";

export interface ReplayedOutcome {
  seq: number;
  state_summary: unknown;
  outcome: unknown;
  status: string;
}

/**
 * The outcome the append carrying `idempotencyKey` returned, or null when this
 * fixture holds no such event.
 *
 * Folds the ledger UP TO that event's seq — the same fold the original write
 * performed, over the same inputs — and derives the status through
 * `nextStatus`, the write path's OWN rule, so a replay and a write can never
 * disagree about what a stream means.
 *
 * Scoped to the fixture in the lookup, not only in the index: the unique index
 * is `(fixture_id, idempotency_key)` precisely so two courts may mint the same
 * key, so a query on the key alone would hand one fixture another's score.
 */
export async function replayOutcomeFor(
  orgId: string,
  fixtureId: string,
  idempotencyKey: string,
): Promise<ReplayedOutcome | null> {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx<{ seq: number; type: string }[]>`
      select seq, type from score_events
      where fixture_id = ${fixtureId} and idempotency_key = ${idempotencyKey}`;
    if (!row) return null;

    const inputs = await loadFoldInputs(tx, fixtureId);
    // Unreachable in practice — the row above IS an event on this fixture, so
    // the ledger is non-empty. Null rather than a throw anyway: the caller
    // falls back to the original error, and inventing an outcome is the one
    // outcome worse than a 409.
    if (inputs === null) return null;

    // Everything the original write could see, and nothing it could not.
    const upTo = inputs.envelopes.filter((e) => e.seq <= row.seq);
    if (upTo.length === 0) return null;
    const folded = foldFrom(fixtureId, { ...inputs, envelopes: upTo });

    return {
      seq: row.seq,
      state_summary: folded.summary,
      outcome: folded.outcome,
      // The candidate's own TYPE, not the fold alone: `fixtureStatusFromFold`
      // can never answer "finalized", and only `nextStatus` knows that rule.
      status: nextStatus(row.type, folded.outcome, folded.active),
    };
  });
}
