-- V546 — Seazn delivered minutes (Seazn-hosted video, Phase 3, Task 29; behind SEAZN_HOSTED_COST). Planned as V543, which
-- main's chess strays_closed delta took first; V544 and V547 are held by unmerged billing branches, and V545 is this branch's.
--
-- One row per Seazn session: the minutes viewers watched of it, live (Cloudflare stream analytics) and as a replay (Bunny
-- statistics), each with the last day it was measured through. The daily measurement pass (Task 31,
-- usecases/seazn-cost.ts) upserts it and reads `*_measured_through` so a second run on one day never counts a day twice.
--
-- The minutes are numeric(12,1): analytics report fractional minutes, and tenths are the stored grain.
--
-- session_id is ON DELETE RESTRICT: a measured session cannot vanish under its cost record. Sessions cascade from their org
-- (V410), so an org with a measured session cannot be hard-deleted either; no product path hard-deletes an org
-- (extra-orgs.ts), as V542 records for the replay rows. org_id carries no foreign key: it is copied from the session row by
-- the pass, and the session's own org FK already ties the two.
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
  updated_at              timestamptz not null default now()
);

alter table fixture_video_delivery enable row level security;
alter table fixture_video_delivery force  row level security;
