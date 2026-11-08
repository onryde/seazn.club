// W3 T3 (SW-M7, X-SW-5): a SYSTEM bye, as SQL. It lives in engine-db, below both of its readers, so that the engine-db
// reader (`playedSql`, format-standing.ts) never imports from usecases: `fixtureEvidenceSql`
// (usecases/fixture-results-sql.ts) imports it from here. W4 T3 (K2, X-SD-5) adds `byeLineSql`, every bye line as SQL,
// and moves the Swiss shell's `swissByeShellSql` here beside it (fixture-results-sql.ts re-exports it).
import type postgres from "postgres";
import { BYE_SLOT_LABEL } from "@/lib/bye-line";

type Tx = postgres.TransactionSql;

/**
 * W3 T3 (SW-M7): a SYSTEM bye, as SQL over the fixtures row `on` — the typed bye every server writer stores
 * (`byeAward`, lib/fixture-bye.ts: an `award` with `reason: "bye"`), on a row with at most one seat filled, and that
 * seat the winner's. At most one, not exactly one: a bye whose holder was deleted before the swiss guard existed
 * keeps its award with BOTH seats empty (swiss-delete-entrant.test.ts's orphan), and Unpair is how it is cleared.
 * Ruling 116's walkover over a dead seat has `reason` `withdrew`, so it is not one; nor is any award with both seats
 * filled. Each clause is pinned by its own shape in swiss-bye-snapshot.test.ts. Never null: a null here would turn its readers' `not (...)` null and drop a row from the evidence
 * set (three-valued logic), so a row with no outcome reads false.
 */
export function systemByeSql(tx: Tx | postgres.Sql, on = "f") {
  const f = tx(on);
  return tx`coalesce(
    ${f}.outcome ->> 'kind' = 'award'
    and ${f}.outcome ->> 'reason' = 'bye'
    and (${f}.home_entrant_id is null or ${f}.away_entrant_id is null)
    and (coalesce(${f}.home_entrant_id, ${f}.away_entrant_id) is null
         or ${f}.outcome ->> 'winner' = coalesce(${f}.home_entrant_id, ${f}.away_entrant_id)::text),
    false)`;
}

/**
 * W3 T3 (SW-M13, X-SW-29; RB3-23): a Swiss stage's bye row, seated or not, as SQL over the fixtures row `on` — the
 * SQL twin of `isSwissByeShellExtKey` (lib/swiss-shell.ts), the one bye-shell predicate. A bye is not played, so it
 * takes no court, no time and no sheet. Never null (a row with no ext_key reads false).
 */
export function swissByeShellSql(tx: Tx | postgres.Sql, on = "f") {
  return tx`coalesce(${tx(on)}.ext_key ~ '^sw-r[0-9]+-bye$', false)`;
}

/**
 * W4 T3 (K2; X-SD-5): a bye line, as SQL over the fixtures row `on` — the SQL twin of `isByeLine` (lib/bye-line.ts),
 * held to the same table of shapes (lib/__tests__/bye-line-shapes.ts). A Swiss bye shell, a system bye, or a pre-award
 * bye line: `scheduled`, no outcome, and an EMPTY side carrying the bye slot label. A bye is not played, so it takes no
 * court and no time: `movableFixtureSql` and the quick Start's rolling times (usecases/schedule.ts) and history's
 * placement replays (`slotTaker`, usecases/history.ts) read it. Never null: each arm is coalesced, so a reader's
 * `not (...)` keeps every other row (three-valued logic).
 */
export function byeLineSql(tx: Tx | postgres.Sql, on = "f") {
  const f = tx(on);
  return tx`(${swissByeShellSql(tx, on)} or ${systemByeSql(tx, on)} or coalesce(
    ${f}.status = 'scheduled' and ${f}.outcome is null
    and ((${f}.home_entrant_id is null and ${f}.home_slot_label ->> 'key' = ${BYE_SLOT_LABEL.key})
      or (${f}.away_entrant_id is null and ${f}.away_slot_label ->> 'key' = ${BYE_SLOT_LABEL.key})),
    false))`;
}

/** The phantom side of a pre-award bye line as its feed slot (1 = home, 2 = away), or null: `byePhantomSide`'s SQL twin
 *  (lib/bye-line.ts) — the EMPTY side carrying the bye slot label, home first. */
function phantomSlotSql(tx: Tx | postgres.Sql, on: string) {
  const f = tx(on);
  return tx`case
    when ${f}.home_entrant_id is null and ${f}.home_slot_label ->> 'key' = ${BYE_SLOT_LABEL.key} then 1
    when ${f}.away_entrant_id is null and ${f}.away_slot_label ->> 'key' = ${BYE_SLOT_LABEL.key} then 2
  end`;
}

/**
 * W4 B1b fix round 1 (Q1): who held a bye line's DEAD SEAT, as SQL over the fixtures row `on` — the winner its phantom side's
 * feeder handed on (`winner_to_fixture` / `winner_to_slot`), when that entrant has since withdrawn (owner ruling 116) — or
 * null. THE one answer to "walkover or bye": `awardSeededByes` (usecases/stages.ts) writes the award from it (non-null: a
 * `withdrew` walkover over her seat, a match; null: a `bye`, no match), and `awaitsWalkoverSql` below tells the run sheet and
 * the desk the same thing BEFORE the award, so the count and the award cannot disagree. A day-one setup bye has no feeder; a
 * feeder that handed on nobody (a double walkover, a void) has no winner; a disqualified winner is not `withdrawn` — each null.
 */
export function deadSeatLeaverSql(tx: Tx | postgres.Sql, on = "f") {
  return tx`(select src.outcome ->> 'winner' from fixtures src
       join entrants e on e.id::text = src.outcome ->> 'winner'
      where src.winner_to_fixture = ${tx(on)}.id
        and src.winner_to_slot = ${phantomSlotSql(tx, on)}
        and e.status = 'withdrawn'
      limit 1)`;
}

/**
 * W4 B1b fix round 1 (Q1): a bye line still waiting on its award (`scheduled`, no outcome, a phantom side) whose award will be a
 * WALKOVER (`deadSeatLeaverSql` non-null) — so it is a match owed, which the run sheet's round bar and the desk count in their
 * totals (never as played). Never null; the feeder probe runs only for a waiting bye line.
 */
export function awaitsWalkoverSql(tx: Tx | postgres.Sql, on = "f") {
  const f = tx(on);
  return tx`(case
    when ${f}.status = 'scheduled' and ${f}.outcome is null and ${phantomSlotSql(tx, on)} is not null
      then ${deadSeatLeaverSql(tx, on)} is not null
    else false
  end)`;
}
