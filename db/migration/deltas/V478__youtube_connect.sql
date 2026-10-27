-- V478 — YouTube Connect: a channel connection, a pool of stream keys, one broadcast per match.
-- (design of record docs/superpowers/specs/2026-10-27-youtube-connect-design.md §5; plan task T1.)
--
-- VERSION. The plan names this file V4NN; Flyway cannot read a non-numeric version, so the delta carries the number
-- the controller would assign today (origin/main's tail is V477__email_outbox_phase3_wave4.sql). Take max + 1 again
-- at merge (`git mv`, amend while unmerged). A fresh database built from this branch applies 476 then 478 happily
-- (Flyway runs without outOfOrder, and gaps already exist below V410).
--
-- ─── What this adds ────────────────────────────────────────────────────────────────────────────────────────────────
--   org_youtube_connections   one row per connected channel (spec §5.1)
--   youtube_connect_pending   the OAuth round-trip's intent, keyed by sha256(state), 10-minute expiry (plan P10)
--   youtube_stream_keys       the per-connection pool of YouTube liveStreams, at most 10 live (spec §5.3)
--   youtube_broadcasts        one row per YouTube broadcast Seazn creates (spec §5.4)
--   org_stream_targets        a destination is now EITHER a pasted key (rtmp_enc) OR a connection (spec §5.2)
--   fixture_stream_sessions   api_backed + youtube_broadcast_id; the one-active-session-per-target index narrows to pasted rows
--   public_fixture_youtube_parts_v   the public match page's "Part 1 / Part 2" list, with public_fixtures_v's redaction
--
-- Greenfield (RULES.md §Schema): no backfill, no data-copy. Production holds no row that any statement below could
-- refuse — every new table is empty, and the two existing tables only gain a nullable column or a looser NOT NULL.
--
-- ─── Sealed, not granted ───────────────────────────────────────────────────────────────────────────────────────────
-- Every new table takes the stream pattern (V410, V430): RLS ENABLED and FORCED, NO policy, NO trg_set_org, NO grant to
-- app_user. These rows are reached only through the privileged server client, every read org-scoped in SQL; a future
-- `grant … to app_user` lands on a table that is already sealed. The parts view is not granted either (plan R7): its
-- one reader is the server usecase `replayParts` on the privileged client, and the view exists so the redaction below
-- lives in one place. relay/__tests__/rls-static.test.ts scans this file's text for both statements per table.
--
-- ─── Secrets ───────────────────────────────────────────────────────────────────────────────────────────────────────
-- Two `*_enc` columns land here and neither is ever written by anything but its owner (enc-boundary.test.ts):
--   refresh_token_enc  (connections, pending)  sealed under YOUTUBE_TOKEN_KEK; owner server/youtube/token-store.ts (T2)
--   pool_rtmp_enc      (stream keys)           sealed under RELAY_KEK in rtmp_enc's {url, streamKey} shape; owner
--                                              server/relay/secret-columns.ts (T2)
-- Neither column has a writer in THIS task. Errors are stored as CODES (last_error_code), never a Google response body.
--
-- ─── Foreign keys and what a delete does ───────────────────────────────────────────────────────────────────────────
-- A deleted org takes its connections, pending grants, keys and broadcasts with it (on delete cascade on org_id; the
-- unqualified references among them are NO ACTION, which Postgres checks at the END of the cascade statement, when
-- every referencing row is already gone — so none of them can refuse an org delete). A deleted fixture takes its
-- broadcasts. A deleted session leaves its broadcast (last_session_id set null); a deleted broadcast leaves its session
-- (youtube_broadcast_id set null) — money and history outlive both, exactly as V410 ruled for fixture_id.
-- consent_by / created_by are `on delete restrict` (the V451 opened_by precedent): they are an audit of WHO consented
-- and acted, so a hard user delete is refused rather than orphaning the record. The app only soft-deletes users.

-- ─── 1. org_youtube_connections ────────────────────────────────────────────────────────────────────────────────────
create table org_youtube_connections (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  channel_id        text not null,
  channel_title     text not null,
  -- The Google subject of the account that granted access (the sign-in routes' google_sub is a different thing).
  google_sub        text null,
  -- The sealed refresh token (YOUTUBE_TOKEN_KEK). Present exactly while the connection is not revoked: the first
  -- CHECK below. A revoke clears it in the SAME statement that sets status and revoked_at (token-store.ts, T2).
  refresh_token_enc bytea null,
  granted_scope     text not null,
  default_privacy   text not null default 'unlisted',
  made_for_kids     boolean not null default false,
  -- The consent record (D7): who ticked the box, when, and which consent text version they saw.
  consent_by        uuid not null references users(id) on delete restrict,
  consent_at        timestamptz not null,
  consent_version   int not null,
  status            text not null,
  status_since      timestamptz not null default now(),
  last_health_at    timestamptz null,
  -- A code, never a token or a Google response body: [a-z_:]{1,64} (the shape CHECK below refuses anything else).
  last_error_code   text null,
  created_by        uuid not null references users(id) on delete restrict,
  created_at        timestamptz not null default now(),
  revoked_at        timestamptz null,

  constraint org_youtube_connections_default_privacy_check check (default_privacy in ('unlisted', 'public', 'private')),
  constraint org_youtube_connections_status_check check (status in ('connected', 'reconnect_needed', 'revoked')),
  -- global-constraints: errors are stored as CODES. A response body (JSON, spaces, braces, a message echoing a token)
  -- cannot match, so the column cannot become a place a Google body or a credential lands. NULL passes (no error).
  constraint org_youtube_connections_last_error_code_shape check (last_error_code ~ '^[a-z_:]{1,64}$'),
  -- Both directions of "revoked ⇔ no token" and "revoked ⇔ revoked_at", IMMEDIATE (CHECK cannot be deferred): every
  -- writer of these three columns is one token-store statement, so a half-revoke is refused instead of stored (ruling R1).
  -- A live row that lost its token (a 30-day purge of a dead grant) must therefore become `revoked` in the same statement.
  constraint org_youtube_connections_revoked_no_token check ((status = 'revoked') = (refresh_token_enc is null)),
  constraint org_youtube_connections_revoked_at check ((status = 'revoked') = (revoked_at is not null))
);

-- A channel is live in at most ONE org (owner rule: it keeps the 10-stream cap counted in one place). `reconnect_needed`
-- still HOLDS the channel — a dead grant is revoked, not abandoned — and revoked rows are history, so any number of
-- them sit beside the live one. The index name is what a 23505 reports and what the connect callback matches on.
create unique index org_youtube_connections_one_live_channel
  on org_youtube_connections (channel_id)
  where status <> 'revoked';
-- The org's connections (the directory's list, every org-scoped read, and the org-delete cascade).
create index org_youtube_connections_org_idx on org_youtube_connections (org_id);
-- consent_by / created_by carry no index: nothing reads by them and users are never hard-deleted.

alter table org_youtube_connections enable row level security;
alter table org_youtube_connections force  row level security;

-- ─── 2. youtube_connect_pending ────────────────────────────────────────────────────────────────────────────────────
-- The OAuth intent lives in this row, never in a cookie or a URL (plan P10): the cookies carry only `state` and the PKCE
-- verifier. The consent is recorded here BEFORE Google is asked, so consent_version / consent_at are NOT NULL. After a
-- multi-channel grant the row also holds the sealed token and the picker's channel list until a channel is chosen.
create table youtube_connect_pending (
  id                uuid primary key default gen_random_uuid(),
  -- sha256 of the `state` value; the callback finds its row by it. Unique: a replayed state finds one row or none.
  state_hash        text not null unique,
  org_id            uuid not null references organizations(id) on delete cascade,
  user_id           uuid not null references users(id) on delete cascade,
  -- The RECONNECT target: set when an existing connection is being re-authorised, null for a first connect.
  connection_id     uuid null references org_youtube_connections(id) on delete cascade,
  default_privacy   text not null,
  made_for_kids     boolean not null,
  consent_version   int not null,
  consent_at        timestamptz not null,
  refresh_token_enc bytea null,
  granted_scope     text null,
  google_sub        text null,
  channels          jsonb null,
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now(),

  constraint youtube_connect_pending_default_privacy_check check (default_privacy in ('unlisted', 'public', 'private'))
);
-- The daily sweep that purges expired grants (a sealed token must not outlive its 10 minutes). The table is tiny and
-- short-lived, so org_id / user_id / connection_id carry no index of their own.
create index youtube_connect_pending_expires_idx on youtube_connect_pending (expires_at);

alter table youtube_connect_pending enable row level security;
alter table youtube_connect_pending force  row level security;

-- ─── 3. youtube_stream_keys ────────────────────────────────────────────────────────────────────────────────────────
-- The pool: one row per YouTube liveStream a connection owns. A key is BUSY while any broadcast bound to it is open
-- (section 4's per-key index). A retired key keeps its row — history, and the unique below — but frees its slot.
create table youtube_stream_keys (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  connection_id  uuid not null references org_youtube_connections(id) on delete cascade,
  -- 1..10: YouTube's concurrent-stream cap per channel (spec §3.1). The CHECK is the cap's second floor under the
  -- pool code's own count; with the live-slot unique below it bounds a connection at TEN live keys.
  slot           smallint not null
    constraint youtube_stream_keys_slot_range check (slot between 1 and 10),
  live_stream_id text not null,
  -- The ingestion URL and stream key sealed together under RELAY_KEK, in rtmp_enc's {url, streamKey} shape.
  pool_rtmp_enc  bytea not null,
  created_at     timestamptz not null default now(),
  retired_at     timestamptz null,

  -- One YouTube liveStream is pooled once per connection — retired rows included, so this is NOT partial.
  constraint youtube_stream_keys_connection_live_stream_uniq unique (connection_id, live_stream_id)
);
-- One LIVE key per slot per connection; a retired slot is reusable.
create unique index youtube_stream_keys_one_live_slot
  on youtube_stream_keys (connection_id, slot)
  where retired_at is null;

alter table youtube_stream_keys enable row level security;
alter table youtube_stream_keys force  row level security;

-- ─── 4. youtube_broadcasts ─────────────────────────────────────────────────────────────────────────────────────────
-- One row per YouTube broadcast Seazn creates; its video id is the replay link. Exclusivity for an API-backed
-- destination moves from the TARGET (section 6) to the KEY and the FIXTURE — the two unique indexes below.
create table youtube_broadcasts (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  connection_id   uuid not null references org_youtube_connections(id),
  fixture_id      uuid not null references fixtures(id) on delete cascade,
  -- Null until a key is bound (and never set for a broadcast that failed before binding).
  key_id          uuid null references youtube_stream_keys(id),
  -- The YouTube broadcast id, which is also the video id. Null until the broadcast is created on YouTube.
  yt_broadcast_id text null,
  title           text not null,
  -- The visibility the broadcast was created with (the connection's default_privacy, or the organiser's choice).
  privacy         text not null,
  state           text not null,
  -- Set exactly while state = 'reserved': the grace window a bound broadcast waits for the stream to arrive.
  reserved_until  timestamptz null,
  last_session_id uuid null references fixture_stream_sessions(id) on delete set null,
  claimed_at      timestamptz null,
  completed_at    timestamptz null,
  -- The 30-day rule (DP III.E.4): when Seazn last refreshed this row's YouTube data.
  refreshed_at    timestamptz not null default now(),
  -- A code, never a Google response body: [a-z_:]{1,64} (the shape CHECK below refuses anything else).
  last_error_code text null,
  attempts        int not null default 0,
  next_attempt_at timestamptz null,
  created_at      timestamptz not null default now(),

  constraint youtube_broadcasts_privacy_check check (privacy in ('unlisted', 'public', 'private')),
  constraint youtube_broadcasts_state_check check (state in ('created', 'bound', 'reserved', 'live', 'ending', 'complete', 'failed')),
  constraint youtube_broadcasts_reserved_until check ((state = 'reserved') = (reserved_until is not null)),
  -- A COMPLETE broadcast is a replay part: it must know when it finished (the part's order) and which video it is (the
  -- part's link). Without this a complete row with a null id would reach the match page as a null video_id.
  constraint youtube_broadcasts_complete_has_facts check (state <> 'complete' or (completed_at is not null and yt_broadcast_id is not null)),
  constraint youtube_broadcasts_last_error_code_shape check (last_error_code ~ '^[a-z_:]{1,64}$')
);

-- At most one OPEN broadcast per fixture. `ending` is deliberately NOT open here: a Stop followed by a restart may
-- start the next broadcast while the previous one is still being ended (the match page then lists Part 1 and Part 2).
create unique index youtube_broadcasts_one_open_per_fixture
  on youtube_broadcasts (fixture_id)
  where state in ('created', 'bound', 'reserved', 'live');
-- At most one open broadcast per KEY, `ending` INCLUDED: the stream is still on the key until the end step finishes.
-- NULLS DISTINCT carries weight here — a broadcast holds no key until one is bound, and keyless rows never collide.
create unique index youtube_broadcasts_one_open_per_key
  on youtube_broadcasts (key_id)
  where state in ('created', 'bound', 'reserved', 'live', 'ending');
-- "Open broadcasts whose end may be due" — the end step's scan (the V470 email_outbox_due_idx pattern).
create index youtube_broadcasts_open_due_idx
  on youtube_broadcasts (next_attempt_at nulls first, created_at)
  where state in ('created', 'bound', 'reserved', 'live', 'ending');
-- The match page's parts: a fixture's complete broadcasts in completion order.
create index youtube_broadcasts_parts_idx
  on youtube_broadcasts (fixture_id, completed_at)
  where state = 'complete';
-- The FKs the partial indexes above cannot serve: a fixture delete walks its broadcasts (any state), a disconnect
-- reads a connection's broadcasts, and a key row's delete walks the broadcasts that named it. last_session_id carries
-- none — a session is deleted only with its org.
create index youtube_broadcasts_fixture_idx on youtube_broadcasts (fixture_id);
create index youtube_broadcasts_connection_idx on youtube_broadcasts (connection_id);
-- Any-state reads of a key's broadcasts and the FK walk when a key row goes (the per-key unique above is partial on the
-- open states only, so it cannot serve either); keyless rows never name a key.
create index youtube_broadcasts_key_idx on youtube_broadcasts (key_id) where key_id is not null;

alter table youtube_broadcasts enable row level security;
alter table youtube_broadcasts force  row level security;

-- ─── 5. org_stream_targets: a destination is a pasted key OR a connection ──────────────────────────────────────────
-- A connection appears as a kind 'youtube' destination row, which keeps fixture_stream_settings.target_id, the archive
-- (V427), the fixture panel's picker and every existing reader working (spec §5.2). rtmp_enc becomes nullable: an
-- API-backed row seals no key of its own — its keys live in the pool. Every existing row holds an rtmp_enc, so the
-- exactly-one-source check below holds for all of them the moment it is added.
alter table org_stream_targets alter column rtmp_enc drop not null;
alter table org_stream_targets
  add column youtube_connection_id uuid null references org_youtube_connections(id);
alter table org_stream_targets
  add constraint org_stream_targets_one_source
    check ((rtmp_enc is null) <> (youtube_connection_id is null));
alter table org_stream_targets
  add constraint org_stream_targets_connection_is_youtube
    check (youtube_connection_id is null or kind = 'youtube');
-- A connection's destination row (the connect flow's upsert, the disconnect's archive).
create index org_stream_targets_youtube_connection_idx
  on org_stream_targets (youtube_connection_id)
  where youtube_connection_id is not null;

-- ─── 6. fixture_stream_sessions: the one-active-per-target rule narrows to pasted rows ─────────────────────────────
-- V421: one active session per TARGET row. That is right for a pasted key (YouTube takes one broadcast per key) and
-- wrong for a connection, where one channel streams several matches at once — four courts live at once is the case the
-- key pool exists for. Exclusivity for an API session moves to the KEY (section 4's per-key index).
--
-- The exemption is a flag the session CARRIES, not the presence of its broadcast. The first draft keyed the predicate on
-- `youtube_broadcast_id is null`, and the FK below is `on delete set null`: deleting an API session's broadcast (the
-- fixture's cascade, an org purge) put a still-ACTIVE session back inside the index, and two such sessions on one
-- destination then failed the FK action itself with a 23505. `api_backed` is written once, at admission, and never changes,
-- so a broadcast row going away cannot move a session across the predicate. The predicate keeps V421's five ACTIVE
-- states (domain/session.ts ACTIVE_STATES, still the one authority) and adds `and not api_backed`.
--
-- Default false: every existing row is a pasted-key session and stays exclusive per target.
--
-- Drop and recreate share this migration's transaction (Flyway), and DROP INDEX takes the table's ACCESS EXCLUSIVE lock
-- until commit, so there is no window in which two active sessions can land on one pasted target.
--
-- The new index can only fail if a database already holds two active sessions on one pasted target — V421's own
-- index forbids exactly that, so none can. This migration MUST NOT delete or repair rows to get itself applied.
alter table fixture_stream_sessions
  add column api_backed boolean not null default false;
alter table fixture_stream_sessions
  add column youtube_broadcast_id uuid null references youtube_broadcasts(id) on delete set null;
-- A session that names a broadcast is api_backed. The converse is not required: it stays api_backed after its broadcast
-- row goes (the set null above), and a session may be admitted before its broadcast row exists.
alter table fixture_stream_sessions
  add constraint fixture_stream_sessions_broadcast_implies_api_backed
    check (youtube_broadcast_id is null or api_backed);

drop index fixture_stream_sessions_one_active_target;
create unique index fixture_stream_sessions_one_active_target
  on fixture_stream_sessions (target_id)
  where state in ('requested','provisioning','warming','live','ending')
    and not api_backed;

-- The session of a broadcast, and the set-null walk when a broadcast is deleted (V431 m-2: a FK owes an index to walk).
create index fixture_stream_sessions_youtube_broadcast_idx
  on fixture_stream_sessions (youtube_broadcast_id)
  where youtube_broadcast_id is not null;

-- ─── 7. public_fixture_youtube_parts_v ─────────────────────────────────────────────────────────────────────────────
-- A fixture's complete YouTube broadcasts as numbered parts, for the public match page. The redaction is
-- public_fixtures_v's (V401), read from that view's own text: its row set is competitions whose visibility is public or
-- unlisted, and its per-row "setup" redaction nulls a setup division's schedule and stream link — an unreleased
-- division must not leak a replay ahead of its release. A view cannot null a whole row, so here a setup division
-- simply has no row: nothing to list is the same redaction.
--
-- part_no numbers AFTER the WHERE, so only published rows are counted; ties on completed_at break by id so the
-- numbering is stable. NOT granted to app_user (see the header): only `replayParts` reads it, on the privileged client.
create view public_fixture_youtube_parts_v as
  select b.fixture_id,
         b.yt_broadcast_id as video_id,
         (row_number() over (partition by b.fixture_id order by b.completed_at, b.id))::int as part_no,
         b.completed_at
  from youtube_broadcasts b
  join fixtures f     on f.id = b.fixture_id
  join divisions d    on d.id = f.division_id
  join competitions c on c.id = d.competition_id
  where b.state = 'complete'
    and d.status <> 'setup'
    and c.visibility in ('public', 'unlisted');
