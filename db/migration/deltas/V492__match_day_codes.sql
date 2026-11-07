-- V492 — Match Day codes (capture S4 design 2026-11-07 §3, §9; MD-1 Task 1): an organiser-minted, one-day QR that lets
-- the Seazn Club app list a competition's matches and open their scoring links, plus the log of what each code did.
--
-- The token: `md_` + 32 random bytes, base64url. Stored twice, like device_links: its sha256 (`tok_hash`, the lookup key
-- a scan resolves by) and its sealed envelope under DEVICE_LINK_KEK (`token_enc`, which the desk re-opens so a printed QR
-- can be shown again). The envelope is NOT named `tok_enc`: that name is the stream code's (V430, RELAY_KEK), and
-- relay/__tests__/enc-boundary.test.ts lets only server/relay/** name it. match-day-codes.ts owns `token_enc`.
--
-- One day: `day` is the date the organiser picked, `tz` the zone it was bounded in (resolveVenueTz(null, org tz)),
-- `opens_at` 00:00 and `expires_at` 24:00 of that date in that zone.
--
-- Scope: `competition` (everything, matches with no court included), `venue` (that venue's courts) or `courts`
-- (exactly `court_ids`). The check below keeps the shape honest: a venue id only on a venue code, courts only on a
-- courts code, and a courts code never empty.
--
-- RLS: V410/V430's pattern — ENABLE + FORCE, NO policy, NO trg_set_org and NO grant to app_user. The phone's routes
-- carry no org session (the token is their auth), so every read and write is on the non-tenant `sql` client and the
-- use-case writes org_id from the competition (mint) or the code row (resolve). scripts/rls-exempt.ts lists the table.
create table match_day_codes (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  competition_id uuid not null references competitions(id) on delete cascade,
  scope_kind     text not null check (scope_kind in ('competition','venue','courts')),
  venue_id       uuid null references venues(id) on delete cascade,
  court_ids      uuid[] null,
  can_approve    boolean not null,
  day            date not null,
  tz             text not null,
  opens_at       timestamptz not null,
  expires_at     timestamptz not null,
  tok_hash       text not null unique check (tok_hash ~ '^[0-9a-f]{64}$'),
  token_enc      bytea not null,
  issued_by      uuid not null references users(id),
  revoked_at     timestamptz null,
  created_at     timestamptz not null default now(),
  check (opens_at < expires_at),
  check ((venue_id is not null) = (scope_kind = 'venue')),
  check ((court_ids is not null and cardinality(court_ids) > 0) = (scope_kind = 'courts'))
);
-- The desk's list: a competition's codes, newest first.
create index on match_day_codes (competition_id, created_at desc);
-- V410's per-table org index, so an org delete's cascade has an index to walk.
create index on match_day_codes (org_id, created_at);

-- Every match a code opened and every approval it made (§3 "Every link opened and every approval is logged").
-- An audit trail of what a printed one-day credential did, so it outlives what it names (MD-1 review I1): fixture_id
-- and stage_id are plain ids with no foreign key, as V430 keeps issued_by. A format change, a stage regenerate or a
-- fixture delete leaves the row in place, naming an id that is gone. The log goes only with its code (code_id
-- cascades), and a code goes only with its competition or its org.
create table match_day_code_uses (
  id         bigint generated always as identity primary key,
  code_id    uuid not null references match_day_codes(id) on delete cascade,
  kind       text not null check (kind in ('open','approve')),
  fixture_id uuid null,
  stage_id   uuid null,
  approval   text null check (approval in ('swiss','draw')),
  at         timestamptz not null default now(),
  check ((kind = 'open') = (fixture_id is not null)),
  check ((kind = 'approve') = (stage_id is not null and approval is not null))
);
create index on match_day_code_uses (code_id, at);

alter table match_day_codes      enable row level security;
alter table match_day_codes      force  row level security;
alter table match_day_code_uses  enable row level security;
alter table match_day_code_uses  force  row level security;
