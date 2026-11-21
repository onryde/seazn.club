-- V540 — the Seazn destination row (Seazn-hosted video, Phase 1, Task 9).
--
-- Seazn itself becomes a destination: one `kind = 'seazn'` row per organisation on org_stream_targets, not a flag on
-- fixture_stream_settings. fixture_stream_sessions.target_id, court_stream_links.target_id, the fixture panel's picker,
-- fixtureStreamTarget's default and the session's destination_kind copy (stream-sessions/start.ts) all key on a target
-- row, so a row keeps every reader working where a flag would fork each of them. Whether a reader LISTS or ADMITS the
-- row is the server flag SEAZN_HOSTED_LIVE's job (relay/config.ts), not this migration's.
--
-- The row is made by a trigger on organizations (and once below for every organisation that already exists), never
-- lazily on read: fixtureStreamTarget is documented as writing nothing. The trigger function is SECURITY DEFINER with a
-- pinned search_path (the V306 / V451 shape): org_stream_targets has FORCED RLS and no policy (V410), so an invoker-rights
-- trigger would fail every organisation insert made by the app role (app_user under withTenant).

-- ─── 1. org_stream_targets: a seazn kind with no source of its own ───────────────────────────────────────────────────
alter table org_stream_targets drop constraint org_stream_targets_kind_check;
alter table org_stream_targets
  add constraint org_stream_targets_kind_check
    check (kind in ('youtube','facebook','twitch','kick','custom_rtmp','seazn'));

-- V479's exactly-one-source rule stays for every external destination; a seazn row seals no key and names no connection.
alter table org_stream_targets drop constraint org_stream_targets_one_source;
alter table org_stream_targets
  add constraint org_stream_targets_one_source
    check ((kind = 'seazn' and rtmp_enc is null and youtube_connection_id is null)
        or (kind <> 'seazn' and (rtmp_enc is null) <> (youtube_connection_id is null)));

-- One seazn row per organisation; the trigger's and the backfill's `on conflict` name this index.
create unique index org_stream_targets_one_seazn on org_stream_targets (org_id) where kind = 'seazn';

-- ─── 2. the row for every organisation: a trigger for new ones, one insert for the ones that exist ──────────────────
create function ensure_seazn_target() returns trigger
  language plpgsql security definer
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
begin
  insert into org_stream_targets (org_id, kind, label, watch_url)
  values (new.id, 'seazn', 'Seazn', null)
  on conflict (org_id) where kind = 'seazn' do nothing;
  return null;
end $$;
-- A trigger function cannot be called directly; the revoke keeps a definer function off the public execute list anyway.
revoke execute on function ensure_seazn_target() from public;

create trigger organizations_ensure_seazn_target
  after insert on organizations
  for each row execute function ensure_seazn_target();

-- The only backfill (RULES.md is greenfield): one row per existing organisation. CREATE TRIGGER above holds a lock on
-- organizations until this migration commits, so no organisation can land between the trigger and this insert unseen.
insert into org_stream_targets (org_id, kind, label, watch_url)
select id, 'seazn', 'Seazn', null from organizations
on conflict (org_id) where kind = 'seazn' do nothing;

-- ─── 3. fixture_stream_inputs: the signed settings an input was created with, and the recordings-locked mark ────────
-- access: `{"signed":true,"allowedOrigins":[…]}`, written once by provisioning and never updated (Task 12).
-- recordings_locked_at: every recording of a finished programme input is locked (Task 13), so it is never listed again.
alter table fixture_stream_inputs
  add column access jsonb null,
  add column recordings_locked_at timestamptz null;

-- ─── 4. the two one-per-recording marks (the V430 pattern: enable + force RLS, no policy, no grant) ─────────────────
-- The sweep hold's one alert per recording (Task 18). It needs no replay row, so it works in Phase 1.
create table seazn_held_alerts (
  cf_video_id text primary key,
  session_id  uuid not null references fixture_stream_sessions(id) on delete restrict,
  alerted_at  timestamptz not null default now()
);
create index seazn_held_alerts_session_idx on seazn_held_alerts (session_id);

-- Task 13 has set requireSignedURLs on this recording (C3), so it is set once.
create table seazn_locked_videos (
  cf_video_id  text primary key,
  input_row_id uuid not null references fixture_stream_inputs(id) on delete restrict,
  locked_at    timestamptz not null default now()
);
create index seazn_locked_videos_input_row_idx on seazn_locked_videos (input_row_id);

alter table seazn_held_alerts   enable row level security;
alter table seazn_held_alerts   force  row level security;
alter table seazn_locked_videos enable row level security;
alter table seazn_locked_videos force  row level security;

-- ─── 5. fixture_stream_sessions: a Seazn session is not exclusive per target ────────────────────────────────────────
-- V479's index keeps one active session per PASTED target. Every Seazn match of an org streams to that org's one seazn
-- row at once, so a seazn session leaves the index. destination_kind is written once at admission (start.ts) and never
-- updated, so the predicate is stable for a row's whole life. Drop and recreate share this migration's transaction, and
-- DROP INDEX holds the table's ACCESS EXCLUSIVE lock until commit, so no window admits two active pasted sessions.
drop index fixture_stream_sessions_one_active_target;
create unique index fixture_stream_sessions_one_active_target
  on fixture_stream_sessions (target_id)
  where state in ('requested','provisioning','warming','live','ending')
    and not api_backed
    and destination_kind is distinct from 'seazn';
