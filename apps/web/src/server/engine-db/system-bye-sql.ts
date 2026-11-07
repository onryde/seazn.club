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
