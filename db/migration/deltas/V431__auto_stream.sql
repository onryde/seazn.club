-- V431 — Capture QR v2, PR-2 (spec §8.2, plan 2026-10-07 R-1 and FP16).
alter table fixture_stream_settings
  add column auto_stream             boolean not null default false,
  add column auto_started_at         timestamptz null,
  add column auto_start_session_id   uuid null references fixture_stream_sessions(id) on delete set null,
  add column auto_start_blocked_at   timestamptz null,
  add column auto_start_attempted_at timestamptz null,
  add column auto_start_refusal      text null
    check (auto_start_refusal in ('no_destination','no_credit','not_entitled','destination_in_use','unavailable')),
  -- R-1: V430 read "a row exists" as "the organiser chose" (a null target_id = cleared). The switch and the A12 stamp create rows
  -- that chose nothing, so the choice gets its own flag. Every existing row was written by a destination write.
  add column target_chosen           boolean not null default false;
update fixture_stream_settings set target_chosen = true;
create index on fixture_stream_settings (auto_start_session_id);   -- V430 m-2: the FK has an index to walk on a session delete
-- T4 review: maybeAutoStart's facts read asks "did any session of this fixture ever receive ingest" on EVERY beat of a paired
-- phone. fixture_stream_sessions had no index on fixture_id that reaches a TERMINAL row (one_active is partial on the open
-- states), so that exists() seq-scanned the whole table: 4357 buffers / 12 ms at 39k rows, 12 buffers / 0.09 ms with this.
-- It is also the walk for the fixture_id FK's `on delete set null` (V430 T35).
create index on fixture_stream_sessions (fixture_id);
-- FP16: when the phone has been not-ready continuously, for the panel's debounce.
alter table fixture_stream_pairings add column not_ready_since timestamptz null;
