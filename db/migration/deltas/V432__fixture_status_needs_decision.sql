-- W2a (spec §5.4.6; rulings 79, 72). A play-produced level result in a bracket stage is HELD as
-- `needs_decision`: not decided, nobody seated, closed by the organiser's core.settle.
-- V432, not the plan's V431: origin/main took V431 (V431__auto_stream.sql, #928) while W2a was in flight.
-- The V214 inline check is named fixtures_status_check by Postgres (confirmed against the w2a DB:
-- select conname from pg_constraint where conrelid = 'fixtures'::regclass and contype = 'c'
--   and pg_get_constraintdef(oid) like '%status%').
alter table fixtures drop constraint fixtures_status_check;
alter table fixtures add constraint fixtures_status_check check (status in
  ('scheduled','in_play','decided','finalized','abandoned','forfeited','cancelled','needs_decision'));

-- V430's fixtures_track_finished needs no change: needs_decision is NOT in its finished set, so the trigger
-- writes finished_at = null for it — the match is played but not finished (status-set ledger: "played").

-- Finding 7, ruling 82 (owner, 2026-10-08): legacy bracket rows stored decided/finalized
-- with a level outcome move to needs_decision, so the organiser sees the block instead of an exception page.
-- The update names `status`, so fixtures_track_finished fires and clears finished_at for them.
-- Review M-4: the block reports what it moved. needs_decision does not exist before this migration, so every
-- needs_decision row after the update is one it moved; complete_stages_holding_one counts the stages already
-- marked complete that hold such a row. stages.status is a stored flag (competition.ts completeStageIfReady writes
-- it once and returns early on it), so those stages STAY complete — reported, not reopened (reopening would orphan
-- whatever the next stage already seated from them).
do $$
declare
  moved integer;
  complete_stages integer;
begin
  update fixtures f set status = 'needs_decision'
    from stages s
   where s.id = f.stage_id
     and s.kind in ('knockout','double_elim','stepladder','page_playoff','ladder')
     and f.status in ('decided','finalized')
     and f.outcome->>'kind' in ('draw','tie','no_result');
  get diagnostics moved = row_count;
  select count(distinct s.id) into complete_stages
    from fixtures f
    join stages s on s.id = f.stage_id
   where f.status = 'needs_decision'
     and s.status = 'complete';
  raise notice 'V432 needs_decision backfill: moved=% complete_stages_holding_one=%', moved, complete_stages;
end $$;

-- Controller ruling D-F3 (fix round 1): a HELD fixture is a recorded result for division_has_results — the one
-- predicate behind the divisions.per_competition.max quota slot, restoreDivision and deleteDivision's guard (V354).
-- A held fixture is a bracket match PLAYED to a level result, waiting for the organiser's settle; read as "no
-- results", archiving a division whose only play is held would refund its slot (the evasion V354 closes) and drop
-- delete's guard. V355's rule holds inside the new arm: a no_result outcome is not a verdict (a held chess double
-- forfeit — nobody played), so it charges nothing, exactly like a rained-off abandon. Redefined here with
-- create or replace, as V355 redefined V354's; V355's header (STABLE, SECURITY INVOKER, narrower than delete's
-- check) still applies unchanged.
create or replace function division_has_results(p_division_id uuid)
  returns boolean
  language sql stable as $$
    select exists (
      select 1 from fixtures f
       where f.division_id = p_division_id
         and (f.status in ('decided', 'finalized', 'forfeited')
              or (f.status in ('abandoned', 'needs_decision')
                  and f.outcome is not null
                  and f.outcome->>'kind' <> 'no_result')))
  $$;

-- V355's reason, again: a partial index whose WHERE no longer covers the queried rows is silently ignored (a
-- sequential scan, not a wrong answer), so the index's status list widens with the function's status arms.
drop index if exists fixtures_division_results_idx;
create index if not exists fixtures_division_results_idx
  on fixtures (division_id)
  where status in ('decided', 'finalized', 'forfeited', 'abandoned', 'needs_decision');
