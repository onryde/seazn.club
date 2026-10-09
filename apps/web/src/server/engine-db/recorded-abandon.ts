import "server-only";
import type postgres from "postgres";
import { isLevelOutcome } from "@seazn/engine/core";
import type { FixtureStatus } from "@seazn/engine/competition";
import { engineFixtureStatus } from "@/lib/fixture-engine-status";

type Tx = postgres.TransactionSql;

/**
 * W2a NEW-H1 / D-G1 — the ONE place that tells a recorded abandon from the generator's void.
 *
 * Both are `fixtures.status = 'abandoned'`, and in eight sports both carry `outcome: null`. What separates them is
 * the ledger: a scorer's (or a withdrawal's) abandon is a `core.abandon` event; the generator and the bracket
 * cascade write their voids with no event at all. A `core.abandon` that a `core.void` targets is gone — the match
 * is live again — so only an ACTIVE one counts.
 *
 * Read by the bracket cascade (`resolveBracketSeats`, usecases/stages.ts — a recorded abandon is not a dead feeder)
 * and by stage completion (`loadStageInputs`, competition.ts — a recorded abandon that decided nobody is not settled).
 *
 * As SQL: `on` names the `fixtures` row in the enclosing query (an alias, or the table itself). Gated on the status
 * first, so the ledger probe runs only for abandoned rows, not for every row of every pass.
 */
export function hasActiveAbandonSql(tx: Tx, on = "f") {
  const f = tx(on);
  return tx`(${f}.status = 'abandoned' and exists (
    select 1 from score_events a
    where a.fixture_id = ${f}.id and a.type = 'core.abandon'
      and not exists (select 1 from score_events v where v.fixture_id = a.fixture_id and v.voids_event_id = a.id)))`;
}

/**
 * A recorded abandon that decided NOBODY, and so is owed the organiser's `core.settle` (X-ST-1: `settleApplies` is
 * true for an abandon with no outcome and for a level one). Outcome null in eight sports; `no_result` where the
 * sport's abandon folds to one (cricket, carrom, generic, football under `abandonPolicy: "award"` at a level score).
 * An abandon that DID decide (football's award to the leader) names its winner and is settled like any result.
 */
export function abandonAwaitsSettle(f: { status: string; outcome: unknown; has_active_abandon: boolean }): boolean {
  return f.status === "abandoned" && f.has_active_abandon && (f.outcome == null || isLevelOutcome(f.outcome as never));
}

/**
 * The engine status a BRACKET or LADDER reader gives a fixture (D-G1). `engineFixtureStatus` maps every `abandoned`
 * row to `void`, which the engine counts as SETTLED: right for the generator's void, wrong for a recorded abandon
 * that decided nobody — that one read as settled completed a stage around an abandoned final and ranked its two
 * unbeaten finalists last. It is played, not finished, and seats nobody: `in_play`, as a held `needs_decision`
 * fixture is (fixture-engine-status.ts). Table stages keep `engineFixtureStatus`: a league's abandoned match is void.
 */
export function bracketEngineStatus(f: { status: string; outcome: unknown; has_active_abandon: boolean }): FixtureStatus {
  return abandonAwaitsSettle(f) ? "in_play" : engineFixtureStatus(f.status);
}
