-- =============================================================================
-- V409 — player_stat_folds: what the last player-stats fold of a division READ.
--
-- `player_stat_snapshots` is refolded from the division ledger after every
-- result (apps/web/src/server/usecases/player-stats-refresh.ts). A refresh
-- skips the fold when the snapshot already covers the ledger. That check used
-- to compare an event COUNT stamped on the snapshot rows, which two things
-- defeated:
--   - a count is not an identity: deleting a scored fixture and recording the
--     same number of events elsewhere read as "covered";
--   - a config re-snapshot changes what the fold derives with no new event;
-- and a division whose fold writes no rows had no stamp at all, so it refolded
-- on every refresh.
--
-- One row per division, written in the same transaction as the snapshot rows:
--   ledger      {fixture_id: [event_count, max_seq]} built from the fold's OWN
--               events read, so it is exactly the ledger the rows reflect. The
--               ledger is append-only per fixture, so (count, max seq) is that
--               fixture's identity, and a deleted fixture drops out of the map.
--   inputs_md5  md5 over the fold's other inputs (division and stage config,
--               each played fixture's frozen config, entrants and lineups, the
--               roster, merge tombstones), read BEFORE the fold's own reads —
--               a write landing in between is folded but not stamped, which
--               costs one extra refold later, never a skipped one.
--   row_count   rows the fold wrote, so "no rows before, none after" is known.
-- A disposable cache like the snapshot itself: deleting a row forces a refold.
-- =============================================================================
create table if not exists player_stat_folds (
  division_id uuid primary key references divisions(id) on delete cascade,
  org_id      uuid not null,
  ledger      jsonb not null,
  inputs_md5  text not null,
  row_count   integer not null,
  folded_at   timestamptz not null default now()
);

drop trigger if exists trg_set_org on player_stat_folds;
create trigger trg_set_org before insert on player_stat_folds
  for each row execute function set_org_from_parent('divisions', 'division_id');

alter table player_stat_folds enable row level security;
alter table player_stat_folds force  row level security;
drop policy if exists player_stat_folds_tenant on player_stat_folds;
create policy player_stat_folds_tenant on player_stat_folds for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on player_stat_folds to app_user;
