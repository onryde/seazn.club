-- =============================================================================
-- V432 — Online chess: board in page + camera (design 2026-10-09).
-- Amends the unmerged V405 in place (renamed: V405 sat below main's V431 and
-- flyway.toml sets no outOfOrder, so it could never be applied again).
--
-- user_external_accounts: a Seazn user's Lichess identity AND their token at
-- rest. This REVERSES V405's identity-only decision (design §3.1): the board
-- API submits moves with each player's own token, so the token is sealed
-- under LICHESS_TOKEN_KEK (server/relay/crypto.ts sealWith — the same
-- envelope V417 gave the device link) and kept. `scopes` records what the
-- grant actually carries, `consented_at` when the player agreed to it.
-- A row with all three null is a LEGACY identity-only link: legal, and owed
-- a re-consent screen before its first online fixture.
-- Not org-scoped; FORCE RLS with no app_user policy, read via privileged `sql`.
--
-- fixture_external_play: per-fixture bridge for online play. Check-in is NOT
-- here — it is fixture_availability.checked_in_at.
-- =============================================================================

create table user_external_accounts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  provider         text not null check (provider in ('lichess')),
  external_user_id text not null,
  username         text not null,
  -- Sealed under LICHESS_TOKEN_KEK. Named ONLY by
  -- server/usecases/external-accounts.ts (enc-boundary.test.ts holds every
  -- other file to that). Nothing ever searches by this value.
  access_token_enc bytea null,
  scopes           text[] not null default '{}',
  consented_at     timestamptz null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, provider),
  unique (provider, external_user_id),
  -- Named, not positional: two table CHECKs would otherwise be
  -- `…_check` and `…_check1`, and a test that asserts a constraint NAME is
  -- the only thing stopping the other CHECK from satisfying it.
  constraint user_external_accounts_consent_token_check
    check ((access_token_enc is null) = (consented_at is null)),
  constraint user_external_accounts_consent_scopes_check
    check (consented_at is null or cardinality(scopes) > 0)
);

create index user_external_accounts_user_idx on user_external_accounts (user_id);

alter table user_external_accounts enable row level security;
alter table user_external_accounts force row level security;

-- =============================================================================
-- Organiser-driven rounds (design D12, 2026-10-09). The organiser presses
-- "Open round": that stamps the round, sends every pairing's invite and STARTS
-- the window. The timetable becomes the time players are SHOWN
-- (fixture_external_play.scheduled_at_basis), never the trigger — a Swiss
-- round almost never starts when the timetable said, and opening windows on a
-- stale schedule marks a field no-show for a round that had not started.
--
-- The grain is (stage_id, round_no), because v2 has no rounds table: a round
-- is a column on fixtures (V214__fixtures.sql:10, indexed at :47).
-- `unique (stage_id, round_no)` makes "Open round" idempotent in the SCHEMA,
-- so a double press or a retry cannot produce two windows for one round.
-- `opened_by … on delete restrict`: this row is the authority for a window
-- that can forfeit somebody, so it keeps its actor.
--
-- Declared ABOVE fixture_external_play because that table's round_open_id FK
-- names it.
--
-- CONSEQUENCE FOR CODE, not enforced here: T−10 and T+20 are now relative to
-- `opened_at`, not to the fixture's scheduled time, and a fixture whose round
-- has no row here is not yet playable. window.ts is T9/T13's to change.
-- =============================================================================
create table stage_round_opens (
  id        uuid primary key default gen_random_uuid(),
  stage_id  uuid not null references stages(id) on delete cascade,
  org_id    uuid not null references organizations(id) on delete cascade,
  round_no  int  not null,
  opened_at timestamptz not null default now(),
  opened_by uuid not null references users(id) on delete restrict,
  unique (stage_id, round_no)
);
create index stage_round_opens_org_idx on stage_round_opens (org_id, opened_at desc);

alter table stage_round_opens enable row level security;
alter table stage_round_opens force  row level security;

create table fixture_external_play (
  fixture_id          uuid primary key references fixtures(id) on delete cascade,
  org_id              uuid not null references organizations(id) on delete cascade,
  provider            text not null default 'lichess' check (provider in ('lichess')),
  status              text not null default 'pending' check (status in (
                        'pending', 'ready', 'live', 'finished', 'needs_organiser'
                      )),
  scheduled_at_basis  timestamptz not null,
  challenge_id        text,
  -- Dead under the 2026-10-09 design (§3.3 removes the urlWhite/urlBlack
  -- hand-off: White's token challenges Black's username). Kept nullable
  -- because guard.ts/room.ts still select them; T9 drops them in V434 once
  -- the last reader is gone.
  url_white           text,
  url_black           text,
  white_side          text check (white_side in ('home', 'away')),
  white_lichess_id    text,
  black_lichess_id    text,
  expires_at          timestamptz,
  mint_claimed_at     timestamptz,
  white_emailed_at    timestamptz,
  black_emailed_at    timestamptz,
  last_polled_at      timestamptz,
  needs_reason        text check (needs_reason in (
                        'no_show_white', 'no_show_black', 'no_show_both',
                        'not_started', 'aborted', 'mismatch', 'provider_error',
                        -- §3.6: a revoked/rejected token is not a no-show; a
                        -- double walkover on a final/last rung/third place is
                        -- refused and the fixture stays open for the organiser.
                        'token_revoked', 'double_walkover_blocked'
                      )),
  last_error          text,
  -- §5.5 / D11: the organiser proceeded without video under policy
  -- `required` (RealtimeKit unavailable). Read by preflight (T8); the human
  -- record of WHO and WHY is the online_chess_audit row beside it.
  video_override_at   timestamptz null,
  -- D12: the round this fixture's window hangs off. Null until the organiser
  -- presses Open round; `on delete restrict` because a round that has already
  -- invited players cannot be un-opened by deleting its row.
  round_open_id       uuid null references stage_round_opens(id) on delete restrict,
  -- D12: the per-fixture record that the pairing's invite went out. One row
  -- per fixture (fixture_id is the primary key), so "invited" is recorded
  -- once; T13 writes it with `where invited_at is null`, which is what makes a
  -- re-open or a retry a no-op instead of a second email to both players.
  invited_at          timestamptz null,
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check ((status = 'needs_organiser') = (needs_reason is not null)),
  -- D12's invariant: a fixture cannot be marked invited before its round is
  -- opened. Half of it — the other half is the round_open_id FK, which can
  -- only name a row the organiser's press created. Two guards, deliberately
  -- separate so each is mutable on its own; a CHECK cannot span tables, so no
  -- single constraint can express the whole thing.
  constraint fixture_external_play_invite_needs_open_round_check
    check (invited_at is null or round_open_id is not null)
);

create index fixture_external_play_org_idx on fixture_external_play (org_id);
create index fixture_external_play_poll_idx
  on fixture_external_play (last_polled_at nulls first)
  where status in ('ready', 'live');
create unique index fixture_external_play_challenge_idx
  on fixture_external_play (challenge_id)
  where challenge_id is not null;

alter table fixture_external_play enable row level security;
alter table fixture_external_play force row level security;
create policy fixture_external_play_tenant on fixture_external_play
  for all to app_user
  using (org_id = current_org_id())
  with check (org_id = current_org_id());
grant select, insert, update, delete on fixture_external_play to app_user;

-- =============================================================================
-- Camera policy (design §5.1, D5). COLUMNS, not config keys: divisions.config
-- and stages.config are sport-module-validated snapshots and would strip a
-- foreign key — the same reason V209 put scorer_can_finalize in a column.
-- The competition is the floor (NOT NULL, 'off' for all existing data, so no
-- legacy competition can accidentally start spending on video); a stage's
-- null means "inherit". effectivePolicy (T6) reads exactly these two levels.
-- =============================================================================
alter table competitions
  add column camera_policy text not null default 'off'
    check (camera_policy in ('off', 'optional', 'required'));
alter table stages
  add column camera_policy text null
    check (camera_policy in ('off', 'optional', 'required'));

-- =============================================================================
-- Video (design §5.2, D6) — one RealtimeKit meeting per fixture, created when
-- the FIRST player arrives in the window (preflight needs something to join),
-- torn down at the result or at T+20. N participants per fixture on purpose:
-- one camera is enough for ship 1, a second angle is then config, not a
-- migration — so (fixture_id, person_id) is deliberately NOT unique.
-- Sealed like V410's tables: ENABLE + FORCE RLS, no app_user policy; these
-- rows are reached only through the app's privileged client, and the organiser
-- sees a projection, never a row.
-- =============================================================================
create table fixture_video_meetings (
  fixture_id uuid primary key references fixtures(id) on delete cascade,
  org_id     uuid not null references organizations(id) on delete cascade,
  provider   text not null default 'realtimekit' check (provider in ('realtimekit')),
  meeting_id text not null unique,
  created_at timestamptz not null default now(),
  ended_at   timestamptz null
);
create index fixture_video_meetings_org_idx on fixture_video_meetings (org_id);

create table fixture_video_participants (
  id                     uuid primary key default gen_random_uuid(),
  -- To the MEETING, not the fixture: a participant with no meeting is a
  -- preflight that ran against nothing.
  fixture_id             uuid not null
                           references fixture_video_meetings(fixture_id) on delete cascade,
  person_id              uuid null references persons(id) on delete set null,
  preset                 text not null check (preset in ('player', 'arbiter')),
  participant_id         text not null,
  -- §5.2: a player is seated only when the MEETING reports a live video
  -- publisher for them. The POC's client-sent cameraOk boolean is on the
  -- do-not-copy list (§10); this is the server-verified stamp.
  last_publisher_seen_at timestamptz null,
  created_at             timestamptz not null default now(),
  unique (fixture_id, participant_id)
);
create index fixture_video_participants_person_idx
  on fixture_video_participants (fixture_id, person_id);

-- =============================================================================
-- Flags (design §5.5 / D10, §3.6). A camera that goes dark and out-of-band
-- play are LOGGED, never automatic sanctions — the organiser decides. The
-- board never freezes, so a flag is a record with two timestamps and an actor,
-- not a state the engine reads.
-- =============================================================================
create table fixture_play_flags (
  id          uuid primary key default gen_random_uuid(),
  fixture_id  uuid not null references fixtures(id) on delete cascade,
  org_id      uuid not null references organizations(id) on delete cascade,
  kind        text not null check (kind in ('camera_lost', 'out_of_band_play')),
  person_id   uuid null references persons(id) on delete set null,
  opened_at   timestamptz not null default now(),
  closed_at   timestamptz null,
  resolved_by uuid null references users(id) on delete set null,
  note        text null,
  -- Resolution is all-or-nothing in BOTH directions: a closed flag nobody
  -- resolved, and a resolver on a flag still open, are each a bug.
  constraint fixture_play_flags_resolution_check
    check ((closed_at is null) = (resolved_by is null))
);
create index fixture_play_flags_open_idx
  on fixture_play_flags (fixture_id) where closed_at is null;

-- =============================================================================
-- Audit (design D9, D11). Two things an org can do that must leave a trace:
-- downgrade the camera policy after a window has opened, and override a
-- RealtimeKit outage under `required`. Both carry WHO; `on delete restrict`
-- because an audit row whose actor vanished is not an audit row.
-- =============================================================================
create table online_chess_audit (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  fixture_id    uuid null references fixtures(id) on delete cascade,
  stage_id      uuid null references stages(id) on delete cascade,
  kind          text not null check (kind in ('policy_downgrade', 'video_override')),
  actor_user_id uuid not null references users(id) on delete restrict,
  from_policy   text null check (from_policy in ('off', 'optional', 'required')),
  to_policy     text null check (to_policy   in ('off', 'optional', 'required')),
  note          text not null,
  created_at    timestamptz not null default now(),
  -- `else false`, not a bare CASE: a CASE with no ELSE yields NULL for an
  -- unknown kind and a NULL CHECK PASSES, which would leave this guard
  -- covered for by the kind CHECK instead of standing on its own.
  constraint online_chess_audit_shape_check check (
    case kind
      when 'policy_downgrade' then
        stage_id is not null and fixture_id is null
        and from_policy is not null and to_policy is not null
      when 'video_override' then
        fixture_id is not null and stage_id is null
        and from_policy is null and to_policy is null
      else false
    end
  )
);
create index online_chess_audit_org_idx on online_chess_audit (org_id, created_at desc);

alter table fixture_video_meetings     enable row level security;
alter table fixture_video_meetings     force  row level security;
alter table fixture_video_participants enable row level security;
alter table fixture_video_participants force  row level security;
alter table fixture_play_flags         enable row level security;
alter table fixture_play_flags         force  row level security;
alter table online_chess_audit         enable row level security;
alter table online_chess_audit         force  row level security;
