// W4 Task 2 (K4, X-LE-9): THE "this match has started" predicate, as SQL, for every format — one authority per fact.
//
// Who reads it (keep this list true when a caller moves):
//   `fixtureStartedSql`
//     - swiss-rounds-admin.ts: re-exported as `swissBoardStartedSql` (W3 T9/T12), so the Swiss late-entry case decision,
//       the rounds lock, Finish and the desk's controls read this one predicate
//     - `stageHasStarted` below (swiss-rounds-admin.ts' rounds lock and controls; later W4 tasks)
//   `fixtureCalledSql` (its call arm, on its own)
//     - stages.ts `rebuildStageFixtures`: Rebuild's result guard refuses a stage with a live call (X-LE-9). Only the call
//       arm, beside the guard's own `fixtureHasResultSql`: the predicate's other two arms would refuse rows two owner
//       rulings say Rebuild redraws — the generator's F14 walkover (review 3 of #857, N2: a walkover counts only through
//       its evidence) and an online-game bridge row with no game (open-round.test.ts M-10, refused by name instead as
//       ONLINE_GAME_EXISTS, `lockBoardsRefusingOnlineGames`)
//     - engine-db/fed-seats.ts: the take-back's `Node.called` (a called next match is a started one, `hasStarted`)
import type postgres from "postgres";
import { systemByeSql } from "@/server/engine-db/system-bye-sql";
import { fixtureHasResultSql, swissByeShellSql } from "./fixture-results-sql";
import { LIVE_CALL_ALIASES, liveCallSql } from "./match-day-call";
import { DECIDED } from "./stages";

type Tx = postgres.TransactionSql;

/** `liveCallSql` owns the aliases `fc` and `g` inside its subquery; the outer row under either name would be shadowed by
 *  them and the arm would read "any live call in the organisation". A guard, not a comment (TEST-STRATEGY rule 4). */
function refuseOwnedAlias(fn: string, on: string): void {
  if (on === LIVE_CALL_ALIASES.call || on === LIVE_CALL_ALIASES.fixture) {
    throw new Error(`${fn}: "${on}" is an alias liveCallSql owns`);
  }
}

/**
 * A Match Day call that still holds on the fixtures row `on` (owner ruling 257): a `fixture_calls` row read through
 * `liveCallSql` (match-day-call.ts), Match Day's one liveness test — the match unstarted and still on the court and at the
 * time the call put it. A call that Undo call deleted, or that a board edit has moved, holds nothing. Never null.
 */
export function fixtureCalledSql(tx: Tx, on = "f") {
  refuseOwnedAlias("fixtureCalledSql", on);
  const f = tx(on);
  const fc = tx(LIVE_CALL_ALIASES.call);
  const g = tx(LIVE_CALL_ALIASES.fixture);
  return tx`exists (
    select 1 from fixture_calls ${fc} join fixtures ${g} on ${g}.id = ${fc}.fixture_id
    where ${fc}.fixture_id = ${f}.id and ${liveCallSql(tx)}
  )`;
}

/**
 * THE "this match has started" predicate, as SQL over the fixtures row `on` (W3 T9, spec §4 "started"; W4 T2 made it every
 * format's, X-LE-9):
 *  - a result or any recorded evidence: `fixtureHasResultSql` (in play, decided, an outcome-bearing abandonment, a score
 *    event, a frozen cfg, a report, a mark, a suspension);
 *  - an online game stands behind it: any `fixture_external_play` row (T9 Review Focus 1), scored or not;
 *  - a Match Day call that still holds (`fixtureCalledSql`, ruling 257). The call writes a court and a time and no status or
 *    event, yet the match is on a court with its players standing at it: a re-pair, a re-seat or a rebuild under it would
 *    put two other players at a court somebody was called to. A match that has since begun is a start through the arms
 *    above;
 *  - decided, other than a bye: a two-sided walkover an import or a pre-W2b generator wrote holds no event, yet it is
 *    settled.
 * NOT a start: a bye — a SYSTEM bye of any format (`systemByeSql`: a knockout's structural bye, a cascade walkover over a
 * dead seat) or a Swiss bye shell (`swissByeShellSql`, which also covers a bye stored before W2b with no reason); nobody
 * played it. Nor a device link (T9 re-ruling I1: a link carries no opened marker, and printing a day's sheets mints one per
 * board; a link that was used has written a score event).
 */
export function fixtureStartedSql(tx: Tx, on = "f") {
  // Its alias guard is the call arm's own (`fixtureCalledSql`, built below for every `on`): a second check here would be
  // a guard nothing could kill (mutation sweep, W4 T2).
  const f = tx(on);
  return tx`(
    ${fixtureHasResultSql(tx, on)}
    or exists (select 1 from fixture_external_play x where x.fixture_id = ${f}.id)
    or ${fixtureCalledSql(tx, on)}
    or (${f}.status in ${tx([...DECIDED])} and not (${systemByeSql(tx, on)} or ${swissByeShellSql(tx, on)}))
  )`;
}

/** Whether any fixture of the stage has started (`fixtureStartedSql`). A caller deciding a write on it holds the boards'
 *  append locks first (the Swiss callers' `lockSwissBoardAppends`). */
export async function stageHasStarted(tx: Tx, stageId: string): Promise<boolean> {
  const [hit] = await tx`select 1 from fixtures f where f.stage_id = ${stageId} and ${fixtureStartedSql(tx, "f")} limit 1`;
  return hit !== undefined;
}
