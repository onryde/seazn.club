-- V437 — Capture record upload (spec docs/superpowers/specs/2026-10-12-capture-record-upload-design.md §9, P5/P6/P9,
-- approved by the owner 2026-10-12): the operator's "Send record to Seazn" lands here, its kept lines only.
--
-- RLS: V410's pattern, as V430's four tables take it (QR v2 §17.1, ruling R1) — ENABLE + FORCE row level security, NO
-- policy, NO trg_set_org trigger and NO grant to app_user. The phone route carries no org session (the tok is its auth)
-- and staff read through the non-tenant client in /admin. rls-static.test.ts reads this file as part of the stream fold
-- (its name says capture).

-- 1. One row per accepted upload (§9). `lines` is the KEPT NDJSON verbatim, joined by "\n" — '' when every line was
--    dropped (P10: a 201 with kept 0 is stored as counts with no lines). A dropped line is never stored, not even hashed.
create table capture_records (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  competition_id uuid not null,                                                 -- divisions.competition_id, a snapshot as V410's sessions keep it
  fixture_id     uuid not null references fixtures(id) on delete cascade,
  code_id        uuid not null references fixture_stream_codes(id) on delete cascade,
  slot           integer not null check (slot >= 0),                            -- the code's slot, 0 today
  ref            text not null unique check (ref ~ '^R-[0-9A-HJKMNP-TV-Z]{4,8}$'),   -- P9, the contract's ok.ref pattern
  received_lines integer not null check (received_lines between 1 and 1000),   -- §5: 0 lines is a 422, never stored
  kept_lines     integer not null check (kept_lines >= 0),
  dropped_lines  integer not null check (dropped_lines >= 0),
  body_bytes     integer not null check (body_bytes between 1 and 1048576),    -- the DECOMPRESSED body (§5)
  lines          text not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,                                          -- created_at + 30 days (P6), the sweep's key
  check (kept_lines + dropped_lines = received_lines),
  check ((kept_lines = 0) = (lines = '')),
  check (expires_at > created_at)
);
create index on capture_records (org_id, created_at);                          -- V410's per-table org index
create index on capture_records (fixture_id, created_at desc);                 -- /admin: a fixture's records, newest first
create index on capture_records (code_id);                                     -- the code FK cascades here
create index on capture_records (expires_at);                                  -- the daily sweep's delete

-- 2. The sessions the kept sid lines name (§9: what keys a record "by session"). A1 kept only the sending code's
--    sessions, so each link is one this code's pairings joined. Both FKs cascade: the record's sweep and a session's
--    delete each take their links with them.
create table capture_record_sessions (
  record_id  uuid not null references capture_records(id) on delete cascade,
  session_id uuid not null references fixture_stream_sessions(id) on delete cascade,
  primary key (record_id, session_id)
);
create index on capture_record_sessions (session_id);                          -- the session FK cascades here; /admin reads by session

-- 3. RLS: the V410 pattern. Enable + force, no policy.
alter table capture_records          enable row level security;
alter table capture_records          force  row level security;
alter table capture_record_sessions  enable row level security;
alter table capture_record_sessions  force  row level security;
