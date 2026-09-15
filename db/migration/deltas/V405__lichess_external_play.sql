-- =============================================================================
-- V405 — Chess Lichess external play (design 2026-09-15)
--
-- user_external_accounts: per-user OAuth link to an external board (lichess
-- first; chess.com later). Not org-scoped — a Seazn user has one Lichess
-- identity across orgs. Accessed via the privileged pooled `sql` path (same
-- as users / Google OAuth), not under app_user tenant RLS: tokens must not be
-- readable through org-scoped queries.
--
-- fixture_external_play: per-fixture bridge state for online play. Org-scoped
-- with the usual tenant RLS. Status machine: pending → ready → live →
-- finished | needs_organiser.
--
-- Migration number: V404 is claimed on branch feat/retire-scorer
-- (V404__retire_scorer_role.sql); origin/main tip at cut was V403.
-- =============================================================================

create table user_external_accounts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  provider         text not null check (provider in ('lichess')),
  external_user_id text not null,
  username         text not null,
  access_token     text not null,
  refresh_token    text,
  token_expires_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, provider),
  unique (provider, external_user_id)
);

create index user_external_accounts_user_idx on user_external_accounts (user_id);

-- No RLS policies: under FORCE, app_user cannot read tokens. Auth/cron code
-- uses the privileged connection (plain `sql`), not withTenant.
alter table user_external_accounts enable row level security;
alter table user_external_accounts force row level security;

create table fixture_external_play (
  fixture_id             uuid primary key references fixtures(id) on delete cascade,
  org_id                 uuid not null references organizations(id) on delete cascade,
  provider               text not null check (provider in ('lichess')),
  status                 text not null check (status in (
                           'pending', 'ready', 'live', 'finished', 'needs_organiser'
                         )),
  external_challenge_id  text,
  external_game_id       text,
  play_url               text,
  white_play_url         text,
  black_play_url         text,
  last_error             text,
  emailed_at             timestamptz,
  started_at             timestamptz,
  finished_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index fixture_external_play_org_idx
  on fixture_external_play (org_id);
create index fixture_external_play_status_idx
  on fixture_external_play (status, emailed_at);
create unique index fixture_external_play_game_idx
  on fixture_external_play (external_game_id)
  where external_game_id is not null;

alter table fixture_external_play enable row level security;
alter table fixture_external_play force row level security;
create policy fixture_external_play_tenant on fixture_external_play
  for all to app_user
  using (org_id = current_org_id())
  with check (org_id = current_org_id());
grant select, insert, update, delete on fixture_external_play to app_user;
