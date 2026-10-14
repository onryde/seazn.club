-- =============================================================================
-- V439 — Online chess: board in page + camera (design 2026-10-09).
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
-- `(stage_id, org_id)` is ONE composite FK through stages_id_org_key (V375),
-- the fixtures_court_id_org_id_fkey shape: a plain `org_id` FK only proves the
-- org exists, so an open row could carry another tenant's org beside this
-- stage. FK checks bypass RLS, so the binding has to be in the key itself.
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
  stage_id  uuid not null,
  org_id    uuid not null references organizations(id) on delete cascade,
  round_no  int  not null,
  opened_at timestamptz not null default now(),
  opened_by uuid not null references users(id) on delete restrict,
  unique (stage_id, round_no),
  constraint stage_round_opens_stage_org_fkey
    foreign key (stage_id, org_id) references stages (id, org_id) on delete cascade
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
  -- because guard.ts/room.ts still select them; T9 drops them in V441 once
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
  -- invited players cannot be un-opened by deleting its row. The FK only
  -- proves SOME open row exists; that it is THIS fixture's round is the
  -- fixture_external_play_round_open_binding trigger below.
  round_open_id       uuid null references stage_round_opens(id) on delete restrict,
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check ((status = 'needs_organiser') = (needs_reason is not null)),
  -- D12's invariant: a fixture cannot be marked invited before its round is
  -- opened. The invite stamps ARE the seat stamps above — T19's
  -- inviteUnemailedSeats stamps white_emailed_at / black_emailed_at per seat
  -- and emails only a seat whose stamp is null; there is no second, per-fixture
  -- invite column. Either seat stamp set ⇒ round_open_id set. Three guards,
  -- each mutable on its own: this CHECK (a seat stamp needs an open round),
  -- the round_open_id FK (that open row exists), and the binding trigger below
  -- (that open row is THIS fixture's stage, round and organisation). A CHECK
  -- cannot span tables, so no single constraint expresses the whole thing.
  constraint fixture_external_play_invite_needs_open_round_check
    check ((white_emailed_at is null and black_emailed_at is null)
           or round_open_id is not null)
);

-- D12, the cross-table half: round_open_id must name the open row for THIS
-- fixture's (stage_id, round_no), in THIS fixture's organisation. Without it a
-- fixture whose own round was never opened satisfies the CHECK and the FK by
-- naming another round's row — or another tenant's, since FK checks bypass RLS
-- (reviewer probe, 2026-10-09). One constraint name, three messages, so each
-- refusal is attributable and each branch is killable on its own; org is
-- checked FIRST because a foreign org's row is also a foreign stage's, and the
-- stage message would otherwise hide it.
-- security definer + pinned search_path (the V306 shape): stage_round_opens is
-- sealed (FORCE RLS, no app_user policy, no grant), so an invoker function run
-- under withTenant could not read the row it is asked to vouch for. It only
-- READS, and only the two rows named by the row being written.
-- Fires on INSERT and on UPDATE OF round_open_id / fixture_id only: a fixture
-- re-paired into another round is a fixtures UPDATE this trigger does not see
-- (re-open semantics are T19's).
create function fixture_external_play_round_open_binding() returns trigger
  language plpgsql security definer
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
declare
  f_stage uuid; f_round int; f_org uuid;
  o_stage uuid; o_round int; o_org uuid;
begin
  if new.round_open_id is null then
    return null;
  end if;
  select stage_id, round_no, org_id into f_stage, f_round, f_org
    from fixtures where id = new.fixture_id;
  select stage_id, round_no, org_id into o_stage, o_round, o_org
    from stage_round_opens where id = new.round_open_id;
  if o_org is distinct from f_org then
    raise exception 'round_open_id names a round opened in another organisation'
      using errcode = '23514', constraint = 'fixture_external_play_round_open_binding';
  end if;
  if o_stage is distinct from f_stage then
    raise exception 'round_open_id names a round of another stage'
      using errcode = '23514', constraint = 'fixture_external_play_round_open_binding';
  end if;
  if o_round is distinct from f_round then
    raise exception 'round_open_id names another round of this stage'
      using errcode = '23514', constraint = 'fixture_external_play_round_open_binding';
  end if;
  return null;
end $$;
create constraint trigger fixture_external_play_round_open_binding
  after insert or update of round_open_id, fixture_id on fixture_external_play
  for each row execute function fixture_external_play_round_open_binding();

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
-- Camera policy (design §5.1, D5: "set per division/stage, defaulting from the
-- competition"). COLUMNS, not config keys: divisions.config and stages.config
-- are sport-module-validated snapshots and would strip a foreign key — the
-- same reason V209 put scorer_can_finalize in a column.
-- The competition is the floor (NOT NULL, 'off' for all existing data, so no
-- legacy competition can accidentally start spending on video); a division's
-- or a stage's null means "inherit". effectivePolicy (T6) resolves exactly
-- these three levels, nearest first: stage → division → competition. The
-- division level was added by T6 (controller ruling Q1=D, 2026-10-09): it is
-- what the organiser edits on the division settings page, and a stage created
-- later inherits it without anything having to copy a value forward.
-- =============================================================================
alter table competitions
  add column camera_policy text not null default 'off'
    check (camera_policy in ('off', 'optional', 'required'));
alter table divisions
  add column camera_policy text null
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
  -- The PAIRING the meeting was made for (final re-review 2, R2-2, 2026-10-14): the fixture's two entrants when it
  -- was created. A re-pair keeps the fixture row, and the lobby seats a newcomer inside the old window, so the
  -- fixture alone cannot tell this board's players from the last pairing's. ensureMeeting replaces a meeting made
  -- for another pair (no game behind it), and never seats a new pairing in one. A stamp to compare, never joined:
  -- no foreign key, so an entrant deleted later only leaves it differing. Never null: a board with no pairing gets
  -- no meeting.
  home_entrant_id uuid not null,
  away_entrant_id uuid not null,
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
-- `camera_connection_problems` (T14 fix round 5) is NEUTRAL: OUR safeguard
-- took the player's camera out of the meeting and re-joined it often or long
-- enough in one match that the organiser is told — never an accusation, and
-- never a camera_lost for the stamped time (job 5, sweep.ts).
-- =============================================================================
create table fixture_play_flags (
  id          uuid primary key default gen_random_uuid(),
  fixture_id  uuid not null references fixtures(id) on delete cascade,
  org_id      uuid not null references organizations(id) on delete cascade,
  kind        text not null check (kind in ('camera_lost', 'out_of_band_play', 'camera_connection_problems')),
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
-- Audit (design D11). An org overriding a RealtimeKit outage under `required`
-- must leave a trace: WHO, on WHICH fixture; `on delete restrict` because an
-- audit row whose actor vanished is not an audit row.
-- A camera-POLICY change (D9) is NOT recorded here. It is a competition
-- settings change, so it is one row in competition_events
-- (`chess.camera_policy_changed`, written by patchDivision in the same
-- transaction as the change) — one authority per fact (T6 ruling Q2,
-- 2026-10-09). `policy_downgrade` was removed from both CHECKs below for that
-- reason, and the columns only it used (stage_id, from_policy, to_policy) were
-- dropped with it (T6 review M-3). fixture_id stays nullable and is demanded
-- per kind by the shape check, so a later kind that is not about one fixture
-- needs a new CASE arm, not a column change.
-- =============================================================================
create table online_chess_audit (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  fixture_id    uuid null references fixtures(id) on delete cascade,
  kind          text not null check (kind in ('video_override')),
  actor_user_id uuid not null references users(id) on delete restrict,
  note          text not null,
  created_at    timestamptz not null default now(),
  -- `else false`, not a bare CASE: a CASE with no ELSE yields NULL for an
  -- unknown kind and a NULL CHECK PASSES, which would leave this guard
  -- covered for by the kind CHECK instead of standing on its own.
  constraint online_chess_audit_shape_check check (
    case kind
      when 'video_override' then fixture_id is not null
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
