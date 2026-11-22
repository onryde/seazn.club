-- V542 — Seazn replays (Seazn-hosted video, Phase 2, Task 23).
--
-- Every finished recording of a Seazn session's programme input is moved from Cloudflare to Bunny Stream (Task 24) and played
-- from there (Task 25). This migration holds that move's state: one `fixture_video_replays` row per Cloudflare recording, the
-- org's Bunny collection, and the dedupe mark for Bunny's webhook (Task 27). Plus three carries from Phase 1 (controller ruling
-- 2026-11-22): `stream_provider_calls` admits `bunny` (Task 22 m8), an index for the stream tick's per-minute Seazn pass
-- (Task 13 m9), and the recording's start on `seazn_locked_videos` (Task 14).
--
-- Every new table takes the stream pattern (V410, V430): RLS ENABLED and FORCED, NO policy, NO trg_set_org, NO grant to
-- app_user. Only the privileged server client reads or writes them. The public view is not granted either: its one reader is
-- a server usecase on the privileged client, and it exists so the redaction below lives in one place.
--
-- `on delete restrict` on every org_id (plan decision): no product path hard-deletes an organisation (extra-orgs.ts), and a
-- cascade would drop the Bunny ids that the org-deletion cleanup (Task 31) needs to delete the videos.

-- ─── 1. org_video_collections: an org's one Bunny collection ─────────────────────────────────────────────────────────
create table org_video_collections (
  org_id        uuid primary key references organizations(id) on delete restrict,
  collection_id text not null,
  created_at    timestamptz not null default now()
);

-- ─── 2. fixture_video_replays: one row per Cloudflare recording moved to Bunny ───────────────────────────────────────
-- part_no is assigned ONCE, at discovery (the fixture's highest part_no + 1, in recorded_at order within a batch), and never
-- changed: a part keeps its number whatever becomes playable first. A fixture deleted later sets fixture_id null, and the
-- unique (fixture_id, part_no) treats nulls as distinct, so its parts never collide with each other. Parts count from 1: the
-- public page shows "Part n", and a `coalesce(max(part_no), 0)` slip in discovery would otherwise publish a Part 0.
-- cf_duration_seconds and cf_height are the Cloudflare listing's (IngestVideo.durationSeconds, .height), written at discovery:
-- the length and rendition check (Task 24, recommendation 2026-11-21 G-C) compares the Bunny copy against them. verified_at is
-- set when the copy passes it; `playable` means verified, and the Cloudflare delete waits for verified_at + 60 min (G-D).
-- bunny_cleaned_at: a deleted row whose Bunny copies have all been removed.
create table fixture_video_replays (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete restrict,
  session_id          uuid not null references fixture_stream_sessions(id) on delete restrict,
  fixture_id          uuid null references fixtures(id) on delete set null,
  cf_video_id         text not null unique,
  recorded_at         timestamptz not null,
  part_no             int not null check (part_no >= 1),
  state               text not null check (state in ('found','downloading','fetching','encoding','playable','failed','deleted')),
  state_at            timestamptz not null default now(),
  bunny_video_id      text null,
  length_seconds      int null,
  cf_duration_seconds int null,
  cf_height           int null,
  attempts            int not null default 0,
  next_attempt_at     timestamptz not null default now(),
  cf_deleted_at       timestamptz null,
  verified_at         timestamptz null,
  bunny_cleaned_at    timestamptz null,
  deleted_at          timestamptz null,
  deleted_by          uuid null,
  deleted_reason      text null check (deleted_reason in ('organiser','org_deleted')),
  created_at          timestamptz not null default now(),
  unique (fixture_id, part_no),
  -- A row past the fetch holds the Bunny video it made; only a row with none yet, or one that lost it, may lack one.
  constraint fixture_video_replays_bunny_video_id
    check (bunny_video_id is not null or state in ('found','downloading','fetching','failed','deleted')),
  -- `playable` means the Bunny copy passed the length and rendition check (recommendation 2026-11-21).
  constraint fixture_video_replays_playable_verified
    check (state <> 'playable' or verified_at is not null)
);

-- The mover's claim (Task 24): every row it may still act on — a row not yet playable, a playable row still on Cloudflare, a
-- deleted row awaiting cleanup. The predicate IS the claim's WHERE, word for word, so the planner proves the claim may use this
-- index, and a settled row leaves it: a playable row whose Cloudflare copy is deleted, a deleted row whose Bunny copies are
-- cleaned. The index holds the work still to do, not every replay ever made.
create index fixture_video_replays_due_idx on fixture_video_replays (state, next_attempt_at)
  where state not in ('playable','deleted')
     or (state = 'playable' and cf_deleted_at is null)
     or (state = 'deleted' and bunny_cleaned_at is null);
-- The fixture's parts in recording order (discovery's numbering, the replay read).
create index fixture_video_replays_fixture_recorded_idx on fixture_video_replays (fixture_id, recorded_at);
-- The two RESTRICT keys' walks: an org or a session delete checks this table by them (V541's seazn_* indexes, same reason).
create index fixture_video_replays_org_idx on fixture_video_replays (org_id);
create index fixture_video_replays_session_idx on fixture_video_replays (session_id);

-- ─── 3. bunny_webhook_events: the dedupe mark for Bunny's EventId (B6, Task 27) ───────────────────────────────────────
create table bunny_webhook_events (
  event_id    text primary key,
  received_at timestamptz not null default now()
);

alter table org_video_collections enable row level security;
alter table org_video_collections force  row level security;
alter table fixture_video_replays enable row level security;
alter table fixture_video_replays force  row level security;
alter table bunny_webhook_events  enable row level security;
alter table bunny_webhook_events  force  row level security;

-- ─── 4. fixture_stream_inputs: discovery's "listed for good" mark ────────────────────────────────────────────────────
-- Set once discovery has listed this programme input's finished recordings for good, so it is never listed again.
alter table fixture_stream_inputs add column replays_discovered_at timestamptz null;

-- ─── 5. public_fixture_seazn_replays_v ────────────────────────────────────────────────────────────────────────────────
-- A fixture's playable Seazn replays, for the public match page. part_no is the STORED one, never renumbered: a part still
-- processing leaves a gap. The redaction is public_fixture_youtube_parts_v's (V479/V482): a competition that is public or
-- unlisted, and a division past setup — a view cannot null a whole row, so a setup division simply has no row. A row the
-- organiser removed (`deleted_at` set) is never listed, whatever its state reads (Task 24). NOT granted to app_user (see the header).
create view public_fixture_seazn_replays_v as
  select r.fixture_id,
         r.part_no,
         r.bunny_video_id
  from fixture_video_replays r
  join fixtures f     on f.id = r.fixture_id
  join divisions d    on d.id = f.division_id
  join competitions c on c.id = d.competition_id
  where r.state = 'playable'
    and r.deleted_at is null
    and d.status <> 'setup'
    and c.visibility in ('public', 'unlisted');

-- ─── 6. carry (Task 22 m8): stream_provider_calls admits the Bunny adapter's records ──────────────────────────────────
-- V410's inline CHECK, by its generated name; the new list is a superset, so every existing row still passes it. Dropped and
-- re-added NOT VALID in one alter, then validated in its own statement (V530's shape), for clarity only: the split does NOT
-- shorten the lock. Flyway runs this file in one transaction, so the add's ACCESS EXCLUSIVE on stream_provider_calls is held
-- through the VALIDATE's scan until commit (measured on PG, 2026-11-22). The lock lasts only that scan of a small table
-- (controller ruling 2026-11-22; no prod row count was taken), and the constraint ends validated.
alter table stream_provider_calls
  drop constraint stream_provider_calls_provider_check,
  add constraint stream_provider_calls_provider_check check (provider in ('cloudflare','fly','stripe','bunny')) not valid;
alter table stream_provider_calls validate constraint stream_provider_calls_provider_check;

-- ─── 7. carry (Task 13 m9): the stream tick's Seazn pass, every minute ───────────────────────────────────────────────
-- usecases/seazn-recordings.ts lists the programme inputs whose recordings are not yet all locked. An input leaves this index
-- once it is marked (recordings_locked_at set) or once the retention sweep retires it (usecases/relay-sweep.ts nulls
-- ingest_input_id), so it holds the programme inputs not yet marked and not yet retired. Only the Seazn pass marks an input:
-- a composed non-Seazn session's programme input (YouTube, a pasted key) stays in it until the retention sweep retires it.
-- The session side is then read by its primary key.
create index fixture_stream_inputs_seazn_unlocked_idx on fixture_stream_inputs (session_id)
  where role = 'programme' and recordings_locked_at is null and ingest_input_id is not null;

-- ─── 8. carry (Task 14): when a locked recording began ───────────────────────────────────────────────────────────────
-- Written by the lock pass from the Cloudflare listing's creation (the recording's start); null when the listing's value is
-- not a date. The interim replay orders one session's parts by it, then by locked_at, then by uid.
alter table seazn_locked_videos add column recorded_at timestamptz null;

-- ─── 9. Task 24 review m4: the replay discovery, every minute with SEAZN_HOSTED_REPLAY on ─────────────────────────────
-- usecases/seazn-replays.ts (`replayDiscoveryQuery`) lists the programme inputs whose recordings are not yet all discovered. The
-- index of section 7 cannot serve it (its predicate names recordings_locked_at), so without this one the table was read in full
-- every minute. Same shape: an input leaves it once discovery marks it (replays_discovered_at set) or once the retention sweep
-- retires it (ingest_input_id nulled); a non-Seazn programme input stays in it until it is retired. The session side is then read
-- by its primary key.
create index fixture_stream_inputs_seazn_undiscovered_idx on fixture_stream_inputs (session_id)
  where role = 'programme' and replays_discovered_at is null and ingest_input_id is not null;
