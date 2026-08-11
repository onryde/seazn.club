-- V356 — extend persons.lane to 'coach' and 'staff' (#428, S4 — closes S3's
-- carried caveat).
--
-- S3/#426 owner ruling 3 shipped `LineupSlot.role: 'player' | 'coach' |
-- 'staff'` engine-side only: a team official is IN the squad (so a card can
-- be shown to him) but never in a playing projection. `persons.lane`
-- (V348) predates that ruling and only distinguishes 'player' from
-- 'official' — where 'official' means a MATCH official (referee/umpire),
-- per V348's own comment — so a team coach or other staff member has no
-- lane to register under at all.
--
-- Mirrors LineupSlot.role's own union exactly rather than inventing a third
-- name for the same idea. Additive, greenfield, no backfill: existing rows
-- stay 'player'/'official', and this migration does not attempt to guess
-- which already-registered persons are actually coaches or staff.
--
-- Schema-only: this completes S3's caveat for PERSON REGISTRATION (this
-- table), a different axis from the per-FIXTURE lineup slot role
-- (LineupSlot.role) `aggregatePlayerStats` filters on — that gap was closed
-- separately, same review round, by V357 (`lineups.role`) plus the app-layer
-- wiring in `player-stats.ts`/`org-posts.ts`. A coach registering in the
-- person model (this migration) and a coach being named on a specific
-- fixture's team sheet (V357) are independent facts about independent
-- tables; neither implies the other.
--
-- persons_org_user_lane_uq stays untouched (its CURRENT definition is V349,
-- not V348 — V349 dropped and recreated it with an added
-- `and merged_into is null` clause; the citation below is to where the
-- functional claim was last true, which is still correct): it is a PARTIAL
-- index scoped `where user_id is not null and lane = 'player' and
-- merged_into is null`, so 'coach' and 'staff' rows are excluded from it
-- automatically, the same way 'official' already is — verified live this
-- session (two 'coach' rows, same org_id + user_id, insert with no unique
-- violation).
--
-- Defensive/idempotent drop-if-exists + re-add, same shape as
-- V330/V331/V336 (ai_credit_ledger_source_check); Flyway runs
-- -defaultSchema=seazn_club.
alter table persons
  drop constraint if exists persons_lane_check;

alter table persons
  add constraint persons_lane_check
    check (lane in ('player', 'official', 'coach', 'staff'));
