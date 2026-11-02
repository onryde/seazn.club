// W3 T3 (SW-M7, X-SW-5): a SYSTEM bye, as SQL. It lives in engine-db, below both of its readers, so that the engine-db
// reader (`playedSql`, format-standing.ts) never imports from usecases: `fixtureEvidenceSql`
// (usecases/fixture-results-sql.ts) imports it from here.
import type postgres from "postgres";

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
