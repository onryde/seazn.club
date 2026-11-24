-- V552 — Seazn delivered minutes (Seazn-hosted video, Phase 3, Task 29; behind SEAZN_HOSTED_COST). Planned as V543 (main's chess
-- strays_closed delta took it), then V546 (main's stage_lots_draws_stage_key took it; renumbered at the 2026-11-24 rebase). V544
-- and V547 are billing's, V548 plan-limits', V549 and V550 online chess's (all unmerged); V551 is this branch's replay reason,
-- which this table does not depend on, so their order does not matter. The tests find this file by name, never by number.
--
-- One row per Seazn session: the minutes viewers watched of it, live (Cloudflare stream analytics) and as a replay (Bunny
-- statistics), each with the last day it was measured through. The daily measurement pass (Task 31,
-- usecases/seazn-cost.ts) upserts it and reads `*_measured_through` so a second run on one day never counts a day twice.
--
-- The minutes are numeric(12,1): analytics report fractional minutes, and tenths are the stored grain. Neither is ever
-- negative (controller ruling 2026-11-23): a negative analytics answer is refused here, by a constraint named for its column,
-- so the refusal says which reading was wrong.
--
-- session_id is ON DELETE RESTRICT: a measured session cannot vanish under its cost record. Sessions cascade from their org
-- (V410), so an org with a measured session cannot be hard-deleted either; no product path hard-deletes an org
-- (extra-orgs.ts), as V542 records for the replay rows. org_id carries no foreign key, and nothing in the schema makes it equal
-- the session's org (sessions have no unique (id, org_id) to point at): keeping them equal is the writer's job — the pass
-- copies it from the session or replay row it has just read (usecases/seazn-cost.ts).
--
-- RLS: the V430 pattern (R1). Enable + force, NO policy, NO trg_set_org trigger, NO grant to app_user; every read and write
-- goes through the app's non-tenant client. The file name says `seazn`, so the stream fold (_stream-migration.ts) reads it
-- and rls-static.test.ts / migration-shape.test.ts scan this table with the others.
create table fixture_video_delivery (
  session_id              uuid primary key references fixture_stream_sessions(id) on delete restrict,
  org_id                  uuid not null,
  live_minutes            numeric(12,1) not null default 0,
  replay_minutes          numeric(12,1) not null default 0,
  live_measured_through   date null,
  replay_measured_through date null,
  updated_at              timestamptz not null default now(),
  constraint fixture_video_delivery_live_minutes_nonnegative   check (live_minutes >= 0),
  constraint fixture_video_delivery_replay_minutes_nonnegative check (replay_minutes >= 0)
);

alter table fixture_video_delivery enable row level security;
alter table fixture_video_delivery force  row level security;
