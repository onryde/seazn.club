-- V525 — Court stream (spec: seazn.club.capture docs/specs/2026-11-14-court-stream-design.md; plan
-- docs/superpowers/plans/2026-11-14-court-stream-web.md, Task 2): a court link for one day, its code, the
-- per-fixture switch that lets a court's phone stream that fixture, and the columns that hang off the link.
--
-- RLS: court_stream_links takes V430's pattern (itself V410's, ruling R1 of capture QR v2) — ENABLE + FORCE row
-- level security, NO policy, NO trg_set_org trigger and NO grant to app_user. Every read and write goes through the
-- app's non-tenant client; the phone routes carry no org session (the tok is their auth). rls-static.test.ts reads
-- this file as part of the stream fold (its name says `stream`).
--
-- Why a court's code is a ROW of fixture_stream_codes and not a table of its own: pairings, sessions, phone beats and
-- capture records all hang off fixture_stream_codes(id) by foreign key. A court code in the same table keeps every one
-- of those keys, its tok handling (tok_hash, tok_enc, the wipe on end) and its one-active rule unchanged; a code row
-- now names exactly ONE owner, a fixture or a court link (fixture_stream_codes_one_owner).

-- 1. The court link: one court, one day, one destination. `day` is the local date in `tz`; opens_at/expires_at are the
--    instants that day covers. Withdrawing it frees the (court, day) slot for a new link.
create table court_stream_links (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  competition_id uuid not null references competitions(id) on delete cascade,
  court_id       uuid not null,
  day            date not null,
  tz             text not null,
  opens_at       timestamptz not null,
  expires_at     timestamptz not null,
  target_id      uuid not null references org_stream_targets(id),             -- archived targets are never deleted (D2)
  created_by     uuid not null,
  created_at     timestamptz not null default now(),
  withdrawn_at   timestamptz null,
  withdrawn_by   uuid null,
  check (opens_at < expires_at),
  check ((withdrawn_at is null) = (withdrawn_by is null)),
  foreign key (court_id, org_id) references courts (id, org_id) on delete cascade
);
create unique index court_stream_links_one_live on court_stream_links (court_id, day) where withdrawn_at is null;
create index on court_stream_links (org_id, created_at);                         -- V410's per-table org index
create index on court_stream_links (competition_id, day);                        -- the competition's links for a day

-- 2. A court's code is a row of fixture_stream_codes with no fixture. fixture_stream_codes_one_active (fixture_id)
--    WHERE ended_at IS NULL never sees a court code (a null key is distinct), so a court link has its own.
alter table fixture_stream_codes
  alter column fixture_id drop not null,
  add column court_link_id uuid null references court_stream_links(id) on delete cascade,
  add constraint fixture_stream_codes_one_owner check ((fixture_id is null) <> (court_link_id is null));
create unique index fixture_stream_codes_one_active_court on fixture_stream_codes (court_link_id) where ended_at is null;
-- end_cause: V430 declares its value check INLINE and unnamed (`end_cause text null check (end_cause in
-- ('reissued','expired'))`), so Postgres names it by default fixture_stream_codes_end_cause_check — confirmed with
-- \d fixture_stream_codes on a fresh V522 database, 2026-11-15. It is dropped and re-added under that SAME name in one
-- alter, admitting 'withdrawn' (a court link withdrawn by the organiser ends its code).
alter table fixture_stream_codes
  drop constraint fixture_stream_codes_end_cause_check,
  add constraint fixture_stream_codes_end_cause_check
    check (end_cause in ('reissued','expired','withdrawn'));

-- 3. The per-fixture switch: whether the court's phone may stream this fixture. Off unless the organiser turns it on.
alter table fixture_stream_settings
  add column court_stream boolean not null default false;
create index on fixture_stream_settings (fixture_id) where court_stream;

-- 4. The court link a session was started under (null for a fixture's own code). A link's delete leaves the session.
alter table fixture_stream_sessions
  add column court_link_id uuid null references court_stream_links(id) on delete set null;
create index on fixture_stream_sessions (court_link_id);                         -- the set-null FK walks this

-- 5. A court code's record may arrive with no fixture to name. code_id stays NOT NULL, so a record still has an owner.
alter table capture_records
  alter column fixture_id drop not null;

-- 6. RLS: the V430 pattern. Enable + force, no policy.
alter table court_stream_links enable row level security;
alter table court_stream_links force  row level security;
