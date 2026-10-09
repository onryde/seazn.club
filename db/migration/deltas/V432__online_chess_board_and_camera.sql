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

create table fixture_external_play (
  fixture_id          uuid primary key references fixtures(id) on delete cascade,
  org_id              uuid not null references organizations(id) on delete cascade,
  provider            text not null default 'lichess' check (provider in ('lichess')),
  status              text not null default 'pending' check (status in (
                        'pending', 'ready', 'live', 'finished', 'needs_organiser'
                      )),
  scheduled_at_basis  timestamptz not null,
  challenge_id        text,
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
                        'not_started', 'aborted', 'mismatch', 'provider_error'
                      )),
  last_error          text,
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check ((status = 'needs_organiser') = (needs_reason is not null))
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
