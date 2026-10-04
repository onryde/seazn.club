-- V430 — Capture QR v2, PR-1 (spec docs/superpowers/specs/2026-10-01-capture-qr-v2-design.md §8.1,
-- amended by §17.1 and §17.3): the stable stream code, its pairings, per-fixture stream settings,
-- the phone-beat history, fixtures.finished_at, and the session columns they hang off.
--
-- RLS (ruling R1, spec §17.1): the four new tables take V410's pattern — ENABLE + FORCE row level
-- security, NO policy, NO trg_set_org trigger and NO grant to app_user. Every read and write goes
-- through the app's non-tenant client, and the use-case writes org_id from the code row or the
-- session row. V117's tenant pattern (trg_set_org + a tenant policy + a grant) is NOT copied: the
-- phone routes carry no org session (the tok is their auth), and the stream tables would split
-- across two RLS models. rls-static.test.ts reads this file as part of the stream fold.
--
-- The drop and the rename (ruling R3, spec §17.3) land here, in the same commit as the live QR
-- writer (stream-sessions.ts currentSession) and its test readers. Interim meaning: until `?reveal=1`
-- is removed later in PR-1, credentials_served_* also count organiser reveals; from the descriptor
-- GET onward they also count descriptor serves.

-- 1. When a fixture finished, maintained in ONE place for every writer (appendEvent's fold, finalize,
--    the admin correction, the Swiss and knockout bye writers). "Finished" is the §3 set; leaving it
--    (a reverted result, C5) clears the stamp. The trigger fires only on INSERT and on an UPDATE that
--    names `status`, so an update of any other column never moves the stamp. An INSERT in the set
--    KEEPS a stamp it supplies (history Undo/restore re-inserts a snapshotted row with its own
--    finished_at, history.ts restoreFixtures) and is stamped now() only when it supplies none.
alter table fixtures add column finished_at timestamptz null;
create function fixtures_track_finished() returns trigger language plpgsql as $$
begin
  if new.status in ('decided','finalized','forfeited','abandoned','cancelled') then
    if tg_op = 'INSERT' then
      new.finished_at := coalesce(new.finished_at, now());
    elsif old.status not in ('decided','finalized','forfeited','abandoned','cancelled') then
      new.finished_at := now();
    end if;
  else
    new.finished_at := null;
  end if;
  return new;
end $$;
create trigger fixtures_track_finished before insert or update of status on fixtures
  for each row execute function fixtures_track_finished();
-- The backfill. It names no `status`, so the trigger above never fires on it.
update fixtures set finished_at = now() where status in ('decided','finalized','forfeited','abandoned','cancelled');

-- 2. The stable code (W1).
create table fixture_stream_codes (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  fixture_id     uuid not null references fixtures(id) on delete cascade,      -- T35
  code           text not null unique check (code ~ '^[0-9a-hjkmnp-tv-z]{12}$'),
  tok_hash       text not null check (tok_hash ~ '^[0-9a-f]{64}$'),
  tok_enc        bytea null,                                                    -- wiped when ended
  issued_by      uuid not null,
  created_at     timestamptz not null default now(),
  first_shown_at timestamptz null,
  shown_count    integer not null default 0,
  ended_at       timestamptz null,
  end_cause      text null check (end_cause in ('reissued','expired')),
  ended_by       uuid null,
  check ((ended_at is null) = (end_cause is null)),
  check (ended_at is null or tok_enc is null)
);
create unique index fixture_stream_codes_one_active on fixture_stream_codes (fixture_id) where ended_at is null;

-- 3. Per-fixture stream settings: the destination pre-pick (W6). PR-2 adds the auto columns.
create table fixture_stream_settings (
  fixture_id uuid primary key references fixtures(id) on delete cascade,
  org_id     uuid not null references organizations(id) on delete cascade,
  target_id  uuid null references org_stream_targets(id),                      -- archived rows are never deleted (D2)
  updated_by uuid null,
  updated_at timestamptz not null default now()
);

-- 4. Pairings (A9, A14).
create table fixture_stream_pairings (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organizations(id) on delete cascade,
  code_id               uuid not null references fixture_stream_codes(id) on delete cascade,
  slot                  integer not null check (slot >= 0),
  phone                 text not null check (length(phone) between 16 and 64),
  claim_kind            text not null check (claim_kind in ('new','resume')),
  device_model          text null check (length(device_model) <= 80),
  app_version           text null check (length(app_version) <= 40),
  mode                  text null check (mode in ('automatic','operator')),
  phone_state           text null,
  not_ready             text null check (not_ready in ('camera','sound','network','held')),
  start_failed          text null check (start_failed in ('not-found','cred-host','config','start-error')),
  claimed_at            timestamptz not null,
  last_beat_at          timestamptz not null,
  answered_poll_seconds integer not null check (answered_poll_seconds between 5 and 300),
  last_beat             jsonb null,
  ended_at              timestamptz null,
  end_cause             text null check (end_cause in ('replaced','operator_stopped','code_ended')),
  replaced_by           uuid null references fixture_stream_pairings(id),
  check ((ended_at is null) = (end_cause is null))
);
create unique index fixture_stream_pairings_one_current on fixture_stream_pairings (code_id, slot) where ended_at is null;

-- 5. Sessions.
alter table fixture_stream_sessions
  add column start_cause text not null default 'organiser' check (start_cause in ('organiser','operator','automatic')),
  add column code_id     uuid null references fixture_stream_codes(id) on delete set null,
  add column pairing_id  uuid null references fixture_stream_pairings(id) on delete set null,
  add column phone_beat  jsonb null,
  add column phone_beat_at timestamptz null,
  add column warming_at  timestamptz null,
  -- Whether the latest CLAIMED ingest status read threw (B7 re-review, the outage gap): a poll that coalesces onto that
  -- claim answers as the read did, so the panel's warming countdown is held there too (N1). Written only on a change.
  add column ingest_read_failed boolean not null default false,
  drop column qr_issued_first_at;
alter table fixture_stream_sessions rename column credentials_revealed_first_at to credentials_served_first_at;
alter table fixture_stream_sessions rename column credentials_reveal_count to credentials_served_count;
-- The counter's inline `>= 0` check keeps the name Postgres gave it in V410; renamed with the column so a grep for
-- the new name finds its constraint too.
alter table fixture_stream_sessions rename constraint fixture_stream_sessions_credentials_reveal_count_check
  to fixture_stream_sessions_credentials_served_count_check;
-- end_reason: V410 declares its value check INLINE and unnamed (V410 `end_reason text null check
-- (end_reason in ('stopped','max_duration'))`), so Postgres names it by default
-- fixture_stream_sessions_end_reason_check — confirmed with \d fixture_stream_sessions on a fresh
-- V429 database, 2026-10-01. It is dropped and re-added under that SAME name in one alter, admitting
-- all five: stopped | operator_stopped | auto_stopped | phone_lost | max_duration.
-- fixture_stream_sessions_end_reason_state (end_reason only in ending/completed) is unchanged.
alter table fixture_stream_sessions
  drop constraint fixture_stream_sessions_end_reason_check,
  add constraint fixture_stream_sessions_end_reason_check
    check (end_reason in ('stopped','operator_stopped','auto_stopped','phone_lost','max_duration'));

-- 6. fixture_stream_events.source admits 'phone'. V410 declares this check inline too, so its default
--    name is fixture_stream_events_source_check (confirmed with \d fixture_stream_events, 2026-10-01).
--    V410's list is copied exactly, with 'phone' added.
alter table fixture_stream_events
  drop constraint fixture_stream_events_source_check,
  add constraint fixture_stream_events_source_check
    check (source in ('domain','runner','ingest','output','sweep','webhook','admin','client','phone'));

-- 7. History (W10).
create table fixture_stream_phone_beats (
  id              bigint generated always as identity primary key,
  org_id          uuid not null references organizations(id) on delete cascade,
  pairing_id      uuid not null references fixture_stream_pairings(id) on delete cascade,
  session_id      uuid null references fixture_stream_sessions(id) on delete cascade,
  recorded_at     timestamptz not null,
  kind            text not null check (kind in ('minute','change')),
  phone_state     text null,
  flags           text[] not null default '{}',
  battery_pct     smallint null check (battery_pct between 0 and 100),
  charging        boolean null,
  thermal         smallint null,
  bitrate_kbps    integer null,
  delivery        text null check (delivery in ('ok','stalled','unknown')),
  delivered_lag_s numeric(6,1) null,
  raw             jsonb not null
);
create index on fixture_stream_phone_beats (pairing_id, recorded_at desc);
create index on fixture_stream_phone_beats (recorded_at);

-- 8. RLS: the V410 pattern (R1). Enable + force, no policy.
alter table fixture_stream_codes        enable row level security;
alter table fixture_stream_codes        force  row level security;
alter table fixture_stream_settings     enable row level security;
alter table fixture_stream_settings     force  row level security;
alter table fixture_stream_pairings     enable row level security;
alter table fixture_stream_pairings     force  row level security;
alter table fixture_stream_phone_beats  enable row level security;
alter table fixture_stream_phone_beats  force  row level security;
