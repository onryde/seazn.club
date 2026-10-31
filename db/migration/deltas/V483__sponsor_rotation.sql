-- V483 — Sponsors on stream (R4, spec docs/superpowers/specs/2026-10-27-sponsors-on-stream-design.md §4): the
-- rotation's settings and assignments, the proof-of-display log and its frames, tracked clicks, the sponsor report's
-- links, and the on-screen short codes (owner ruling R7). Greenfield: no backfill. Every existing sponsor starts OFF
-- the stream (on_stream = false); the first tick (S12) turns the org's settings row on itself (ruling R12).
--
-- File name: deliberately not "...stream...". The relay's fold (server/relay/__tests__/_stream-migration.ts) takes
-- every delta whose NAME says stream|capture|youtube and requires it to carry no policy and no grant (the sealed
-- stream pattern). These are tenant tables, so they would red it.
--
-- Tenancy: V283's pattern on every table: org_id, RLS enabled AND forced, one org-scoped policy for app_user.
-- Grants follow the writer:
--   * console writes under withTenant: sponsor_stream_settings (S12 settings PUT) and sponsor_report_links (S13
--     create + revoke; revoke is an update, so links carry no delete grant).
--   * privileged writers only (the overlay read path, the relay heartbeat and frame upload, the /s/ redirect):
--     sponsor_assignments, sponsor_airings, sponsor_airing_frames, sponsor_clicks, sponsor_short_codes. app_user
--     READS them (the hub, the report) and writes none. Deleting a sponsor under withTenant still reaches them:
--     foreign-key actions run as the table owner.
--
-- Deletes never take proof of display with them (ruling R16): an airing outlives its sponsor, fixture and session
-- (all set null; the report reads sponsor_name). Every foreign key a delete walks has an index.

alter table sponsors add column on_stream boolean not null default false;

-- One row per scope: the org row (competition_id null) and any competition rows; a competition row overrides the org
-- row (S12). NULLS NOT DISTINCT makes the org row unique too, and is the arbiter for S12's upsert.
create table sponsor_stream_settings (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  competition_id uuid null references competitions(id) on delete cascade,
  enabled        boolean not null default false,
  frequency      text not null default 'normal',
  updated_by     uuid null references users(id) on delete set null,
  updated_at     timestamptz not null default now(),
  constraint sponsor_stream_settings_frequency_check check (frequency in ('light', 'normal', 'busy')),
  constraint sponsor_stream_settings_scope_key unique nulls not distinct (org_id, competition_id)
);
create index sponsor_stream_settings_competition_idx on sponsor_stream_settings (competition_id)
  where competition_id is not null;

alter table sponsor_stream_settings enable row level security;
alter table sponsor_stream_settings force  row level security;
create policy sponsor_stream_settings_tenant on sponsor_stream_settings for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on sponsor_stream_settings to app_user;

-- Which card a break got (plan P3), written on the overlay read path the first time a served plan hands a break its
-- card. One row per break. A rotation row holds the org's cycle position (max + 1, gaps allowed: F9); an operator row
-- never does.
create table sponsor_assignments (
  fixture_id         uuid not null references fixtures(id) on delete cascade,
  moment_id          text not null,
  org_id             uuid not null references organizations(id) on delete cascade,
  seq                int  not null,
  sponsor_id         uuid null references sponsors(id) on delete set null,
  position           int  null,
  source             text not null,
  break_kind         text not null,
  style              text not null,
  hold_ms            int  not null,
  operator_choice_at timestamptz null,
  assigned_at        timestamptz not null default now(),
  constraint sponsor_assignments_pkey primary key (fixture_id, moment_id),
  constraint sponsor_assignments_source_check check (source in ('rotation', 'operator')),
  constraint sponsor_assignments_style_check check (style in ('lower_third', 'banner')),
  constraint sponsor_assignments_position_iff_rotation check ((source = 'rotation') = (position is not null))
);
create unique index sponsor_assignments_org_position_key on sponsor_assignments (org_id, position)
  where position is not null;
create index sponsor_assignments_sponsor_idx on sponsor_assignments (sponsor_id);

alter table sponsor_assignments enable row level security;
alter table sponsor_assignments force  row level security;
create policy sponsor_assignments_tenant on sponsor_assignments for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select on sponsor_assignments to app_user;

-- Proof of display, fed by the compositor's heartbeat (S8). sponsor_name is a snapshot so the report still reads
-- after the sponsor is deleted. No viewers / video_id / youtube_refreshed_at here (F6): viewer counts live in Y1's
-- table, joined through Connect's broadcast row. `skipped` is set by web from the operator log, not by the compositor.
create table sponsor_airings (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  sponsor_id      uuid null references sponsors(id) on delete set null,
  sponsor_name    text not null,
  fixture_id      uuid null references fixtures(id) on delete set null,
  session_id      uuid null references fixture_stream_sessions(id) on delete set null,
  moment_id       text not null,
  source          text not null,
  break_kind      text null,
  style           text not null,
  started_at      timestamptz not null,
  ended_at        timestamptz null,
  cut_short       boolean not null default false,
  skipped         boolean not null default false,
  ended_estimated boolean not null default false,
  constraint sponsor_airings_source_check check (source in ('rotation', 'scene', 'operator')),
  -- The heartbeat's style enum (S8), the same pair the assignment carries.
  constraint sponsor_airings_style_check check (style in ('lower_third', 'banner')),
  constraint sponsor_airings_session_moment_key unique (session_id, moment_id)
);
create index sponsor_airings_org_sponsor_started_idx on sponsor_airings (org_id, sponsor_id, started_at);
create index sponsor_airings_sponsor_idx on sponsor_airings (sponsor_id);
create index sponsor_airings_fixture_idx on sponsor_airings (fixture_id);

alter table sponsor_airings enable row level security;
alter table sponsor_airings force  row level security;
create policy sponsor_airings_tenant on sponsor_airings for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select on sponsor_airings to app_user;

-- A still of the card on air (plan P4). Keyed like the airing but NOT a foreign key to it: the frame is posted 1.5 s
-- after `start` and the airing row only lands on the next 5 s beat, so the frame often arrives first. The report
-- left-joins it. A frame dies with its session (its airing then has no session to join on anyway).
create table sponsor_airing_frames (
  session_id uuid not null references fixture_stream_sessions(id) on delete cascade,
  moment_id  text not null,
  org_id     uuid not null references organizations(id) on delete cascade,
  path       text not null,
  created_at timestamptz not null default now(),
  constraint sponsor_airing_frames_pkey primary key (session_id, moment_id)
);

alter table sponsor_airing_frames enable row level security;
alter table sponsor_airing_frames force  row level security;
create policy sponsor_airing_frames_tenant on sponsor_airing_frames for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select on sponsor_airing_frames to app_user;

-- One row per tracked /s/ click (S10), beside the existing click_count bump.
create table sponsor_clicks (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  sponsor_id uuid not null references sponsors(id) on delete cascade,
  fixture_id uuid null references fixtures(id) on delete set null,
  source     text not null,
  at         timestamptz not null default now(),
  constraint sponsor_clicks_source_check check (source in ('match', 'stream', 'site', 'unknown'))
);
create index sponsor_clicks_sponsor_at_idx on sponsor_clicks (sponsor_id, at);
create index sponsor_clicks_fixture_idx on sponsor_clicks (fixture_id);

alter table sponsor_clicks enable row level security;
alter table sponsor_clicks force  row level security;
create policy sponsor_clicks_tenant on sponsor_clicks for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select on sponsor_clicks to app_user;

-- A shareable report link (S13). The token (32 random bytes) is shown once as a URL; only its hash is stored. Revoke
-- sets revoked_at. A link scoped to a competition that is later deleted keeps working org-wide (R16, set null).
create table sponsor_report_links (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  sponsor_id     uuid not null references sponsors(id) on delete cascade,
  competition_id uuid null references competitions(id) on delete set null,
  from_date      date not null,
  to_date        date not null,
  token_hash     bytea not null,
  created_by     uuid null references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz null,
  constraint sponsor_report_links_token_hash_key unique (token_hash),
  constraint sponsor_report_links_period_check check (from_date <= to_date)
);
create index sponsor_report_links_sponsor_idx on sponsor_report_links (sponsor_id);
create index sponsor_report_links_competition_idx on sponsor_report_links (competition_id)
  where competition_id is not null;

alter table sponsor_report_links enable row level security;
alter table sponsor_report_links force  row level security;
create policy sponsor_report_links_tenant on sponsor_report_links for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update on sponsor_report_links to app_user;

-- R7: the code the stream lower third prints as seazn.club/s/<code> (S7), resolved by the /s/ route (S10). The
-- alphabet is lib/sponsor-short-code.ts's SPONSOR_SHORT_CODE_PATTERN, stated here as a literal because SQL cannot
-- import it; migration.test.ts compares the two. A fixture's deletion keeps its codes (set null): the unique pair
-- keeps nulls DISTINCT, so a sponsor whose codes lose two fixtures is not refused on the second delete.
create table sponsor_short_codes (
  code       text primary key,
  org_id     uuid not null references organizations(id) on delete cascade,
  sponsor_id uuid not null references sponsors(id) on delete cascade,
  fixture_id uuid null references fixtures(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint sponsor_short_codes_code_check check (code ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4,8}$'),
  constraint sponsor_short_codes_sponsor_fixture_key unique (sponsor_id, fixture_id)
);
create index sponsor_short_codes_fixture_idx on sponsor_short_codes (fixture_id);

alter table sponsor_short_codes enable row level security;
alter table sponsor_short_codes force  row level security;
create policy sponsor_short_codes_tenant on sponsor_short_codes for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select on sponsor_short_codes to app_user;
