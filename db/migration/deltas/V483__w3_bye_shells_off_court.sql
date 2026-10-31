-- V483 — W3 (format matrix: Swiss) app-A Task 3 (SW-M13; rule X-SW-29, RB3-23): a Swiss bye shell never holds a slot.
-- Spec docs/superpowers/specs/2026-10-31-format-matrix-w3-swiss-design.md §12. Numbered main's max + 1 when written (main
-- had reached V482, youtube_broadcast_made_for_kids); RENUMBER AT MERGE if main has moved. Its test reads this file by
-- glob (apps/web/src/server/__tests__/w3-migration.test.ts).
--
-- DATA CHANGE (LOUD). A Swiss stage mints each round's bye row as a shell (`sw-r{N}-bye`) before Pair. Until this
-- branch every placement writer took it for one more movable fixture: the auto pass and the AI builders placed it, a
-- board drag dropped it on a court, a quick Start's rolling times stamped it — and a placed bye shell printed a scorer
-- sheet and showed on the board as a match nobody plays. The app now refuses all of that (`isMovable`,
-- `movableFixtureSql`, `moveFixture`'s SWISS_BYE_NOT_PLACEABLE, the bye seat in stages.ts). This delta takes the slot
-- off every bye shell placed before the deploy: time, court, venue and pin — the branch's ONE "holds a slot" predicate
-- (`holdsSlot`, apps/web/src/lib/rebuild-slots.ts), so no half-placed row is left for a reader of a single column.
--
-- Pre-flight count (W3 T0, 2026-10-31): stg 1 row (one division), prod 0. Nothing else about the row moves: seats,
-- status, outcome and snapshot are the Pair's business. Idempotent: a second run matches nothing. Runs as the
-- migrating role, which bypasses RLS (as V432 and V438 do).
update fixtures
   set scheduled_at = null, court_id = null, venue_id = null, schedule_locked = false
 where ext_key ~ '^sw-r[0-9]+-bye$'
   and (scheduled_at is not null or court_id is not null or venue_id is not null or schedule_locked);
