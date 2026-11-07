-- V492 — W4 (format matrix: knockout) app-A Task 3 (gap K2; engine row X-SD-5 "never a fixture on a court"): a bracket
-- bye line never holds a slot. Spec docs/superpowers/specs/2026-11-04-format-matrix-w4-knockout-design.md. Its test reads
-- this file by glob (apps/web/src/server/__tests__/w4-migration.test.ts).
--
-- DATA CHANGE (LOUD). A `timing: "setup"` progression draws its bracket before anyone qualifies, so its bye line sits
-- `scheduled` with no outcome and the bye slot label on its phantom side until the seed confirm awards it
-- (`awardSeededByes`). Until this branch every placement writer took it for a movable match: the auto pass and the AI
-- builders gave it a court and a time, a board drag placed it, and the award then flipped it to `forfeited` WITH the
-- slot — a court held all day by a match nobody plays. A plain bracket's system bye (baked `forfeited` at generation)
-- took a quick Start's rolling time the same way. The app now refuses all of that (`isByeLine` / `byeLineSql`:
-- `isMovable`, `movableFixtureSql`, history's `slotTaker`, `moveFixture`'s BYE_LINE_NOT_PLACEABLE, Start's rolling
-- times) and the award clears the slot. This delta takes the slot off every bye line placed before the deploy: time,
-- court, venue and pin — the ONE "holds a slot" predicate (`holdsSlot`, apps/web/src/lib/rebuild-slots.ts), as V485
-- did for the Swiss bye shell, so no half-placed row is left for a reader of a single column.
--
-- The shape is `byeLineSql`'s (apps/web/src/server/engine-db/system-bye-sql.ts), spelled out because a delta cannot
-- call it: a Swiss bye shell (V485 cleared those already; kept so the shape is the predicate's whole), a SYSTEM bye (an
-- award with reason `bye` over at most one seat, that seat the winner), or a pre-award bye line (`scheduled`, no
-- outcome, an EMPTY side carrying the bye slot label). A `withdrew` walkover (owner ruling 116) is not a bye line and
-- keeps its slot.
--
-- Pre-flight count (W4 app-A Task 0, count 1 — bracket bye lines holding a time or a court, 2026-11-05): stg 0 rows,
-- prod 0 rows. This delta also clears a venue or a pin held alone (the `holdsSlot` shape, a superset of count 1).
-- Nothing else about a row moves: seats, status and outcome are the bracket's business. Idempotent: a second run
-- matches nothing. Runs as the migrating role, which bypasses RLS (as V432, V438 and V485 do).
update fixtures
   set scheduled_at = null, court_id = null, venue_id = null, schedule_locked = false
 where (scheduled_at is not null or court_id is not null or venue_id is not null or schedule_locked)
   and (
        coalesce(ext_key ~ '^sw-r[0-9]+-bye$', false)
     or coalesce(outcome ->> 'kind' = 'award'
                 and outcome ->> 'reason' = 'bye'
                 and (home_entrant_id is null or away_entrant_id is null)
                 and (coalesce(home_entrant_id, away_entrant_id) is null
                      or outcome ->> 'winner' = coalesce(home_entrant_id, away_entrant_id)::text),
                 false)
     or coalesce(status = 'scheduled'
                 and outcome is null
                 and ((home_entrant_id is null and home_slot_label ->> 'key' = 'bracket.slot.bye')
                   or (away_entrant_id is null and away_slot_label ->> 'key' = 'bracket.slot.bye')),
                 false)
   );
