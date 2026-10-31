-- V484 — Match Day: a match CALLED onto a court, and the slot it held before the call.
-- (Spec docs/superpowers/specs/2026-10-31-match-day-design.md §7; owner ruling B, 2026-10-31: "planned times never change on a
-- call".)
--
-- A call writes ONE fixture's court, venue and time directly: the called match goes onto the free court now. Every other match keeps
-- its planned time, and Match Day estimates the knock-on when it reads. So the board's single-fixture move, which refuses an overlap
-- with a planned match on the target court, is not the write path. This table is the rest of the call:
--
--  * It is the call's MARKER. A court is "Called" while its row exists AND its fixture is still unstarted. The fixture's status, not
--    the row, says whether that is still true. A called match the scorer has started, or one voided or forfeited, keeps its row and
--    reads as playing or free. A row is only ever deleted by Undo call, or by a cascade.
--  * It holds the PREVIOUS slot, for Undo call: the court, venue and time the fixture had when it was first called, nulls included
--    (a "no court yet" match goes back to having no court). Calling an already-called match to another court keeps the first
--    previous slot, so one Undo always returns it to where it was before Match Day touched it.
--
-- One row per fixture (the fixture id is the key). `org_id` is denormalised, as on every tenant table, for RLS. The court is a
-- composite FK to `courts (id, org_id)`, the V367 pattern, so a call can never name another org's court. The previous court and venue
-- carry no FK on purpose: they are a record of what was, and a court deleted since must not take the record with it.
create table fixture_calls (
  fixture_id        uuid primary key references fixtures (id) on delete cascade,
  org_id            uuid not null references organizations (id) on delete cascade,
  court_id          uuid not null,
  called_at         timestamptz not null default now(),
  called_by         uuid null references users (id) on delete set null,
  prev_court_id     uuid null,
  prev_venue_id     uuid null,
  prev_scheduled_at timestamptz null,
  foreign key (court_id, org_id) references courts (id, org_id) on delete cascade
);
create index fixture_calls_org_court_idx on fixture_calls (org_id, court_id);

alter table fixture_calls enable row level security;
alter table fixture_calls force  row level security;
create policy fixture_calls_tenant on fixture_calls for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on fixture_calls to app_user;
