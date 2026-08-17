-- =============================================================================
-- V367 — Venues & courts as entities (D5/P8)
--
-- Courts were config-level strings (`fixtures.venue`/`court_label`, free
-- text) with no reuse across competitions, no availability, no filtering.
-- This migration adds the entity tables; NO consumer switches yet —
-- `court_label` and `fixtures.venue` keep working untouched this session.
-- `fixtures.court_id` is added nullable with zero readers; P9 migrates
-- stored schedule configs and switches readers/writers over.
--
-- Ruling (session 2026-08-17, see docs/superpowers/plans/2026-08-17-p8-
-- session-status.md): the design's DDL gives `courts`, `court_hours` and
-- `court_exceptions` no `org_id`, but `scripts/check-rls.ts` enumerates only
-- tables that HAVE an org_id column — those three would ship as tenant
-- tables the RLS guard skips SILENTLY (the same shape as the V366 "guard
-- checked zero tables" finding). `org_id` is denormalized onto all three,
-- and consistency with the parent is enforced in DDL, not by convention:
-- `venues` carries `unique (id, org_id)`, and each child carries a composite
-- FK `(parent_id, org_id) references parent (id, org_id) on delete cascade`,
-- which makes an org_id that disagrees with its parent unrepresentable.
--
-- Hours-overlap (multiple ranges/weekday must not overlap) is validated
-- application-side (usecases/venues.ts) and unit-tested there — not a DB
-- EXCLUDE constraint, to keep this migration's scope to what P8 owes.
--
-- Amendment (owner ruling, same session — see the session-status doc's
-- "Rulings made this session" #4): court removal is delete-OR-archive, not
-- one permanent 409. A club that permanently loses a hall could otherwise
-- never remove the court — history references it forever, so pickers would
-- accumulate dead courts. `archived_at` lands on both `venues` and `courts`
-- (precedent `V261__division_archive.sql`); the courts name-uniqueness
-- becomes a PARTIAL unique index so a name frees up once archived; and
-- `fixtures.court_id` is `on delete restrict` (precedent
-- `V299__sponsor_order_delete_restrict.sql`) so the in-use 409 is a DDL
-- guarantee, not only a check `usecases/venues.ts` could forget. The
-- archive gate itself keys on fixture STATUS (scheduled/in_play = still
-- needed vs decided/finalized/abandoned/forfeited/cancelled = history),
-- never on date — see usecases/venues.ts.
--
-- `weekday` is 0-6 with 0 = Sunday, matching `@seazn/engine/scheduling/tz`'s
-- own `getUTCDay()`-based convention (WEEKDAYS[0] = "SUN") — pinned here
-- because the original design DDL left it unstated and P8's advisory
-- stranded-fixture count (below) computes weekday via that same module.
-- =============================================================================

create table venues (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  name        text not null,
  address     text,
  sort        int  not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (id, org_id)
);
create index venues_org_idx on venues(org_id);
create index venues_active_idx on venues(org_id) where archived_at is null;

alter table venues enable row level security;
alter table venues force  row level security;
create policy venues_tenant on venues for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on venues to app_user;

-- Courts: org_id denormalized (see header) and pinned to its venue's org_id
-- by the composite FK below — an org_id that disagrees with the parent venue
-- cannot be inserted.
create table courts (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null,
  org_id      uuid not null,
  name        text not null,
  sort        int  not null default 0,
  tags        text[] not null default '{}',
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (id, org_id),
  foreign key (venue_id, org_id) references venues (id, org_id) on delete cascade
);
create index courts_venue_idx on courts(venue_id);
create index courts_org_idx   on courts(org_id);
create index courts_active_idx on courts(venue_id) where archived_at is null;
-- Name uniqueness only among ACTIVE courts — archiving frees the name for
-- reuse (owner ruling; V261:9 is the precedent for this partial-index form).
create unique index courts_venue_name_active_idx on courts(venue_id, name)
  where archived_at is null;
-- Tag containment filter (P9: candidate courts for a stage = tags ⊇
-- required_court_tags).
create index courts_tags_gin_idx on courts using gin(tags);

alter table courts enable row level security;
alter table courts force  row level security;
create policy courts_tenant on courts for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on courts to app_user;

-- Weekly hours: multiple ranges per weekday allowed (e.g. morning + evening
-- session). The pk on (court_id, weekday, open_min) stops an exact-duplicate
-- start time at the DB layer; overlap between two DIFFERENT start times is
-- an application-level invariant (usecases/venues.ts), because Postgres has
-- no portable CHECK over sibling rows.
create table court_hours (
  court_id  uuid not null,
  org_id    uuid not null,
  weekday   int  not null check (weekday between 0 and 6),
  open_min  int  not null,
  close_min int  not null,
  primary key (court_id, weekday, open_min),
  foreign key (court_id, org_id) references courts (id, org_id) on delete cascade,
  check (open_min >= 0 and open_min < close_min and close_min <= 1440)
);
create index court_hours_org_idx on court_hours(org_id);

alter table court_hours enable row level security;
alter table court_hours force  row level security;
create policy court_hours_tenant on court_hours for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on court_hours to app_user;

-- Exceptions: ONE row per (court, date) — the whole date is either closed
-- (open_min/close_min both null) or carries exactly one override window
-- (both set, open < close). It always wins over that weekday's court_hours
-- rows (usecases/venues.ts resolves the precedence; unit-tested there).
create table court_exceptions (
  court_id  uuid not null,
  org_id    uuid not null,
  date      date not null,
  closed    boolean not null default false,
  open_min  int,
  close_min int,
  primary key (court_id, date),
  foreign key (court_id, org_id) references courts (id, org_id) on delete cascade,
  check (
    (closed and open_min is null and close_min is null)
    or
    (not closed and open_min is not null and close_min is not null
     and open_min >= 0 and open_min < close_min and close_min <= 1440)
  )
);
create index court_exceptions_org_idx on court_exceptions(org_id);

alter table court_exceptions enable row level security;
alter table court_exceptions force  row level security;
create policy court_exceptions_tenant on court_exceptions for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on court_exceptions to app_user;

-- Fixtures: the future write model (P9 cuts stored configs + fixtures.venue/
-- court_label text over to this). Nullable, zero readers this session.
-- `on delete restrict` (not the repo's more common cascade/set-null): a
-- court referenced by fixture history must not silently vanish out from
-- under it — the same "referenced history must not vanish" reasoning as
-- V299__sponsor_order_delete_restrict.sql. The application-level 409 in
-- deleteCourt is the friendly message; this is the guarantee that holds
-- even if a future call site forgets that check.
--
-- `deferrable initially deferred`: lets an explicit multi-statement
-- transaction fix up ordering before COMMIT (e.g. delete the fixture, then
-- the court, then commit) instead of failing on the first statement. A
-- normal `deleteCourt` call (one court, no cascade, one transaction from
-- `withTenant`) still fails exactly as before if a fixture references it —
-- deferred only changes WHEN the check runs within a transaction that is
-- already going to fail either way.
--
-- NOT a fix for a court sitting at the join of TWO cascade paths hanging
-- off `organizations` (org -> venues -> courts, and org -> competitions ->
-- divisions -> stages -> fixtures): a single `delete from organizations`
-- fans out through both in one statement, and this was verified empirically
-- to still violate the restrict even deferred — cross-path cascade order
-- within one statement is not something deferral controls. A caller that
-- bulk-deletes an organization (scripts, test cleanup) must delete
-- dependent history (here: competitions, which cascades fixtures) before
-- the organization itself; see venues.test.ts's `afterAll` for the pattern.
alter table fixtures add column court_id uuid
  references courts(id) on delete restrict deferrable initially deferred;
create index fixtures_court_idx on fixtures(court_id);

-- Tag-scoped court requirement per division/stage (P9 consumes: candidate
-- courts = tags ⊇ required_court_tags; empty = any court). Stored, not yet
-- read by any usecase this session.
alter table divisions add column required_court_tags text[] not null default '{}';
alter table stages    add column required_court_tags text[] not null default '{}';
