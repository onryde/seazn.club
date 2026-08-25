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
--
-- Fix round 1 (review): every FK gets its own index (`imported_by` was
-- missing one — the "every FK indexed" constraint and V367's own precedent),
-- and `event_imports_division_idx` is dropped as a strict-prefix duplicate
-- of `event_imports_key_idx` (which already leads with `division_id`) —
-- V367__venues_and_courts.sql:90-96 drops the same class of redundancy for
-- `courts_active_idx`.
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
create index event_imports_org_idx         on event_imports (org_id);
create index event_imports_fixture_idx     on event_imports (fixture_id);
create index event_imports_imported_by_idx on event_imports (imported_by);

alter table event_imports enable row level security;
alter table event_imports force  row level security;
create policy event_imports_tenant on event_imports for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert on event_imports to app_user;

-- =============================================================================
-- import_locks — cross-process concurrency lock for one (division, import_id)
-- (P11 / D6 Task 5, fix round 2 — owner ruling 2026-08-25, design doc §5.1).
--
-- Folded into V376 rather than a new version: same feature, and V376 is
-- still unmerged — greenfield stance is one migration, not a patch on top.
--
-- Originally a Postgres advisory lock (pg_try_advisory_lock), held by the
-- SESSION that took it. Under a transaction-mode pooler the physical
-- backend can be reassigned between the lock and the unlock statements, so
-- the cross-process guarantee silently stops holding — and keeping a
-- session alive for the whole call required reserving a pool connection for
-- its full duration, which starves the pool under concurrent imports on
-- different keys. A row fixes both: it survives pooler reassignment because
-- it is data, not session state, and reserves nothing.
--
-- Acquire is a single statement — insert, or take over a row whose
-- expires_at has passed, or come back empty (design doc §5.1's exact SQL,
-- reproduced verbatim in event-import.ts):
--
--   insert into import_locks (division_id, import_id, org_id, holder, expires_at)
--   values ($1, $2, $3, $4, now() + interval '30 minutes')
--   on conflict (division_id, import_id) do update
--     set holder = excluded.holder, acquired_at = now(), expires_at = excluded.expires_at
--     where import_locks.expires_at < now()
--   returning holder
--
-- Zero rows back means a live holder — 409 import.concurrent. One
-- statement, so two concurrent callers cannot both win. Refresh
-- (`update ... where holder = $4`) keeps a long call's lock alive between
-- streams, never inside a stream's own write transaction — a refresh inside
-- a transaction is invisible to any other caller until that transaction
-- commits. Release (`delete ... where holder = $4`) is holder-scoped so a
-- late release from an already-timed-out caller can never free a
-- successor's lock.
--
-- TTL, not a heartbeat: a crashed process leaves a row behind, and 30
-- minutes is what lets the next caller proceed instead of wedging the
-- division forever. A premature takeover is still safe — the
-- event_imports unique index (above) refuses a double import regardless,
-- and the unstarted-fixture guard refuses a fixture that already has
-- events. This lock is an ergonomics feature (a race becomes a clean 409,
-- instead of two writers colliding on the unique index); correctness rests
-- on that index, which no pooling mode can weaken.
--
-- No separate index for the division_id FK: it is the PK's leading column,
-- so the PK's own btree already serves a division_id-only lookup — the same
-- strict-prefix reasoning event_imports_division_idx was dropped for above.
-- org_id is NOT a PK prefix, so it gets its own index, same as every other
-- FK in this file.
-- =============================================================================
create table import_locks (
  division_id  uuid not null references divisions(id)      on delete cascade,
  import_id    text not null,
  org_id       uuid not null references organizations(id)  on delete cascade,
  holder       uuid not null,
  acquired_at  timestamptz not null default now(),
  expires_at   timestamptz not null,
  primary key (division_id, import_id)
);

create index import_locks_org_idx on import_locks (org_id);

alter table import_locks enable row level security;
alter table import_locks force  row level security;
create policy import_locks_tenant on import_locks for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on import_locks to app_user;
