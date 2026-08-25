-- =============================================================================
-- V376 — event_imports receipt table (P11 / D6 Task 1)
--
-- One receipt per imported (division, import_id, fixture). The UNIQUE index
-- below IS the idempotency guarantee — a replay collides here, and the
-- usecase converts the violation into `skipped_duplicate`. Deliberately NOT a
-- report store: re-running the call idempotently is how the report is seen
-- again (design doc §5, §4 "Response").
--
-- Cascade rather than V367's `on delete restrict`: a receipt whose fixture is
-- gone is meaningless, and restrict would block an organiser from deleting a
-- fixture they imported (R7, design doc §5).
--
-- No composite `(id, org_id)` FK to divisions/fixtures (V367's pattern for
-- venues/courts): verified at execution that neither `divisions` nor
-- `fixtures` carries that composite unique key (only `id` is their PK), so
-- this falls back to a plain single-column FK plus the RLS policy below, per
-- design doc §5's own fallback instruction.
--
-- No `plan_entitlements` row for `import.events` (deliberately out of this
-- migration's scope — design doc §2.4/§3 R6): a plan row would grant the
-- feature to every org on that plan, which is the opposite of the
-- staff-only rollout gate. The key exists only as a per-org
-- `org_entitlement_overrides` row until the owner picks a plan.
-- =============================================================================
create table event_imports (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  division_id     uuid not null references divisions(id) on delete cascade,
  import_id       text not null,
  fixture_id      uuid not null references fixtures(id) on delete cascade,
  events_appended int  not null,
  imported_by     uuid references users(id) on delete set null,
  imported_at     timestamptz not null default now()
);

create unique index event_imports_key_idx
  on event_imports (division_id, import_id, fixture_id);
create index event_imports_org_idx      on event_imports (org_id);
create index event_imports_division_idx on event_imports (division_id);
create index event_imports_fixture_idx  on event_imports (fixture_id);

alter table event_imports enable row level security;
alter table event_imports force  row level security;
create policy event_imports_tenant on event_imports for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert on event_imports to app_user;
