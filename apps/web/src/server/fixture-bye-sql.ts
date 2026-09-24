import "server-only";
// The SQL twin of `isRestBye` (lib/fixture-bye.ts), for the readers that COUNT
// fixtures in SQL rather than reading rows into TypeScript: the desk's card
// stats, the career match count and the public player-matches read (#850).
//
// ONE authority, two spellings. The TypeScript predicate is the authority; this
// fragment re-states its row conditions for Postgres and takes the stage kinds
// AND the marker pattern from the SAME constants (`REST_BYE_STAGE_KINDS`,
// `REST_BYE_EXT_KEY_PATTERN` — bound as parameters, never typed here), so a
// change to either moves both. The row conditions are pinned to the predicate
// by `__tests__/fixture-bye-sql.test.ts`, which runs both over the same real
// rows, both directions — including the fed league's walkover, which has a
// rest bye's SHAPE and is not one (owner ruling 2026-09-24, fourth round).
//
// NULL-SAFE ON PURPOSE. Every caller writes `and not ${restByeSql(...)}`, and
// `outcome ->> 'kind'` is NULL for a fixture with no outcome — the ordinary
// unplayed match. A bare AND chain would then evaluate to NULL, `not NULL` is
// NULL, and WHERE drops the row: every unplayed match would silently vanish
// from the counts. `coalesce(…, false)` makes "not a rest bye" the answer.
import type postgres from "postgres";
import { REST_BYE_EXT_KEY_PATTERN, REST_BYE_STAGE_KINDS } from "@/lib/fixture-bye";

/** True exactly for a round-robin rest-bye row: the rest-bye MARKER on its
 *  `ext_key` (`REST_BYE_EXT_KEY_PATTERN`), an `award` outcome naming a winner,
 *  exactly one seat filled and that seat the winner, in a stage whose kind is
 *  in `REST_BYE_STAGE_KINDS`. `alias` names the `fixtures` row in the caller's
 *  query (default `f`). A NULL `ext_key` makes `~` NULL, which the coalesce
 *  turns into "not a rest bye". */
export function restByeSql(db: postgres.ISql, alias = "f"): postgres.PendingQuery<postgres.Row[]> {
  const f = db(alias);
  return db`coalesce((
    ${f}.ext_key ~ ${REST_BYE_EXT_KEY_PATTERN}
    and ${f}.outcome ->> 'kind' = 'award'
    and (${f}.home_entrant_id is null) <> (${f}.away_entrant_id is null)
    and ${f}.outcome ->> 'winner' = coalesce(${f}.home_entrant_id, ${f}.away_entrant_id)::text
    and exists (
      select 1 from stages rest_bye_stage
      where rest_bye_stage.id = ${f}.stage_id
        and rest_bye_stage.kind = any(${[...REST_BYE_STAGE_KINDS]}::text[])
    )
  ), false)`;
}
