-- V357 — extend `lineups` with `role` (review round 1, finding 1).
--
-- S4/#428 shipped the person-role discriminator at the engine boundary
-- (aggregatePlayerStats's optional `lineups` argument, V356 for
-- persons.lane) but left it UNREACHABLE from a real fixture: the `lineups`
-- table had no column to carry `LineupSlot.role` at all — only `roles`
-- (plural, jsonb, a pre-existing and unrelated concept: the position-catalog
-- roles like captain/goalkeeper, read/written by `apps/web/src/server/
-- engine-db/lineups.ts` and `apps/web/src/server/usecases/fixtures.ts`).
-- So a coach's card scored through the real API still earned a leaderboard
-- row. This migration is the schema half of closing that gap; the app-layer
-- half (threading `role` through `putLineup`/`loadLineupPair` and wiring it
-- into `player-stats.ts`/`org-posts.ts`) ships in the same round.
--
-- Mirrors `LineupSlot.role`'s own union exactly: `'player' | 'coach' |
-- 'staff'`, default `'player'`. Additive, greenfield, no backfill —
-- every existing lineup row is a player today, and `not null default
-- 'player'` makes that explicit without a data migration.
alter table lineups
  add column role text not null default 'player'
  check (role in ('player', 'coach', 'staff'));
