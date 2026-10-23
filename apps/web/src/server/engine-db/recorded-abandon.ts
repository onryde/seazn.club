import "server-only";
import type postgres from "postgres";
import { settleOffered, type MatchOutcome } from "@seazn/engine/core";
import type { FixtureStatus } from "@seazn/engine/competition";
import { engineFixtureStatus } from "@/lib/fixture-engine-status";
import { ABANDON_RESULT_KINDS, ABANDON_WIN_METHODS } from "@/lib/forfeit-tag";

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
 *
 * `{ expunge: true }` (W2b D5, owner ruling 105 / loop-F M-10): only an active abandon that carries `expunge: true` —
 * a withdrawal's expunge (`withdrawal.ts` `expungeAbandon`), which took the match out of the table altogether, so
 * nothing is owed on it. The same probe, one more clause: never a second copy of the ledger rule.
 *
 * `{ noResult: true }` (rebase ruling D3): only an active abandon that IS the organiser's online No result
 * (`core.abandon{noResult: true}`, external-play/no-result.ts; writer-gated in append-event.ts) - already the
 * organiser's settle, so a table stage owes it nothing more (`rowAwaitsSettle`).
 */
/** `postgres.Sql` (a transaction is one too): the public loaders read it on the pool, outside a transaction. */
export function hasActiveAbandonSql(tx: postgres.Sql | Tx, on = "f", opts: { expunge?: true; noResult?: true } = {}) {
  const f = tx(on);
  const expunged = opts.expunge === true ? tx`and a.payload ->> 'expunge' = 'true'` : tx``;
  const noResult = opts.noResult === true ? tx`and a.payload ->> 'noResult' = 'true'` : tx``;
  return tx`(${f}.status = 'abandoned' and exists (
    select 1 from score_events a
    where ${activeAbandonOf(tx, on)} ${expunged} ${noResult}))`;
}

/** The one ledger rule both probes share: `a` is a `core.abandon` of the row `f` that no `core.void` targets. */
function activeAbandonOf(tx: postgres.Sql | Tx, on: string) {
  return tx`a.fixture_id = ${tx(on)}.id and a.type = 'core.abandon'
      and not exists (select 1 from score_events v where v.fixture_id = a.fixture_id and v.voids_event_id = a.id)`;
}

/**
 * W2b Task 13 (spec §5.4/§5.5, X-AB-2) — the REASON of the row's active `core.abandon`, or null: what the public tag
 * reads (`forfeitLedgerOfReason` → `forfeitTag`, lib/forfeit-tag.ts). An abandon's tag reads the ledger, never the
 * status — after ST-G1 an abandon with a result is `decided` like any other, and a rain-reduced chase played out to its
 * DLS target is `decided` with the same outcome and no abandon at all. So, unlike `hasActiveAbandonSql`, this is NOT
 * gated on the status. It IS gated on the outcome (review M-3) by the reader's own rule (`abandonKindOf`): a win only
 * with an abandon's method (`ABANDON_WIN_METHODS`: DLS, the award policy's leader), or a level kind (draw, tie,
 * no_result). So an ordinary played result — the commonest row on every division read and public cache miss — is never
 * probed. The latest active abandon wins (the kernel refuses a second once one decided).
 *
 * T16 review m3 (X-AB-1): NO outcome is probed too, at status `abandoned` only — where an abandon that decided nobody
 * lives (the replay policy; R16-3's level abandon where the cfg refuses a draw), and the reader now tags it. A null
 * outcome at any other status (a scheduled row, the commonest of all) is never probed, and the generator's void at
 * `abandoned` has no ledger, so it reads null. A withdrawal's EXPUNGE (`expunge: true`) reads null, as the reader's
 * `forfeitLedgerOf` does: it took the match out of the table, so nothing is owed on it.
 */
const ABANDON_LEVEL_KINDS = ABANDON_RESULT_KINDS.filter((kind) => kind !== "win");
export function activeAbandonReasonSql(tx: postgres.Sql | Tx, on = "f") {
  const f = tx(on);
  return tx`(case when (${f}.outcome ->> 'kind' = 'win' and ${f}.outcome ->> 'method' in ${tx([...ABANDON_WIN_METHODS])})
                    or ${f}.outcome ->> 'kind' in ${tx(ABANDON_LEVEL_KINDS)}
                    or (${f}.outcome is null and ${f}.status = 'abandoned') then (
    select case when a.payload ->> 'expunge' = 'true' then null else a.payload ->> 'reason' end from score_events a
    where ${activeAbandonOf(tx, on)}
    order by a.seq desc limit 1) end)`;
}

/**
 * W2c P-7 / X-AB-5 - the STAGE-AWARE reading of "this stored row is owed the organiser's settle": a recorded abandon
 * (stored `abandoned`, told apart from the generator's void only by the ledger) that the engine's `settleOffered`
 * says is settleable in this stage kind - a bracket's held abandon, or a TABLE stage's abandon that decided nobody
 * (a Swiss board holds the next round). A withdrawal's EXPUNGE (`expunged`) took the match out of the table and is
 * owed nothing; nor is the organiser's online No result (`no_result`, rebase ruling D3: that abandon IS the settle).
 * ONE predicate shared with the server's settle guard and the console's block (`settleOffered`). `no_result` is
 * REQUIRED so no reader can forget to ask: an omitted fact would silently hold every No result board again.
 */
export function rowAwaitsSettle(
  stageKind: string | null | undefined,
  f: { status: string; outcome: unknown; has_active_abandon: boolean; expunged?: boolean; no_result: boolean },
): boolean {
  return (
    f.status === "abandoned" &&
    f.has_active_abandon &&
    settleOffered({}, stageKind, {
      outcome: f.outcome as MatchOutcome | null,
      abandoned: true,
      expunged: f.expunged === true,
      noResult: f.no_result,
      state: null,
    })
  );
}

/**
 * The engine status a stage-COMPLETION reader gives a fixture (D-G1; X-AB-5). `engineFixtureStatus` maps every
 * `abandoned` row to `void`, which the engine counts as SETTLED: right for the generator's void and for a withdrawal's
 * expunge, wrong for a recorded abandon that decided nobody - that one read as settled completed a stage around an
 * abandoned final (ranking its two unbeaten finalists last) and, in a table stage, closed a league around a match the
 * desk shows held. It is played, not finished, and owed the organiser's settle: `in_play`, as a held `needs_decision`
 * fixture is (fixture-engine-status.ts). ONE predicate - `rowAwaitsSettle`, the same the settle guard, the console and
 * the desk read - for every stage kind, bracket or table; the expunge is closed (owner ruling 105), a plain abandon holds.
 */
export function completionEngineStatus(
  stageKind: string | null | undefined,
  f: { status: string; outcome: unknown; has_active_abandon: boolean; expunged?: boolean; no_result: boolean },
): FixtureStatus {
  return rowAwaitsSettle(stageKind, f) ? "in_play" : engineFixtureStatus(f.status);
}
