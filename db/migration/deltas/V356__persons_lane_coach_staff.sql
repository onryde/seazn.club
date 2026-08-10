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
-- Schema-only: this completes S3's caveat but is not load-bearing for S4's
-- acceptance criteria. App-layer plumbing (a coach registration flow, a
-- `lineups` table column to carry role into the engine's LineupPair) is
-- follow-on, not implemented here — see the PR body.
--
-- persons_org_user_lane_uq (V348) stays untouched: it is a PARTIAL index
-- scoped `where user_id is not null and lane = 'player'`, so 'coach' and
-- 'staff' rows are excluded from it automatically, the same way 'official'
-- already is — verified live this session (two 'coach' rows, same org_id +
-- user_id, insert with no unique violation).
--
-- Defensive/idempotent drop-if-exists + re-add, same shape as
-- V330/V331/V336 (ai_credit_ledger_source_check); Flyway runs
-- -defaultSchema=seazn_club.
alter table persons
  drop constraint if exists persons_lane_check;

alter table persons
  add constraint persons_lane_check
    check (lane in ('player', 'official', 'coach', 'staff'));
