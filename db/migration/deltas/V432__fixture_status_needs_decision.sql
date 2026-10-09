-- W2a (spec §5.4.6; rulings 79, 72). A play-produced level result in a bracket stage is HELD as
-- `needs_decision`: not decided, nobody seated, closed by the organiser's core.settle.
-- V432, not the plan's V431: origin/main took V431 (V431__auto_stream.sql, #928) while W2a was in flight.
-- The V214 inline check is named fixtures_status_check by Postgres (confirmed against the w2a DB:
-- select conname from pg_constraint where conrelid = 'fixtures'::regclass and contype = 'c'
--   and pg_get_constraintdef(oid) like '%status%').
alter table fixtures drop constraint fixtures_status_check;
alter table fixtures add constraint fixtures_status_check check (status in
  ('scheduled','in_play','decided','finalized','abandoned','forfeited','cancelled','needs_decision'));

-- Controller ruling D-M1 (2026-10-09, owner-delegated): needs_decision JOINS V430's finished set. No play
-- remains on a held fixture (a chess game awaiting its tie-break is NOT held: it stays in_play with no outcome),
-- so it stamps finished_at and arms the stream's automatic stop like decided does; the capture code's expiry and
-- the phone's finished state read the same stamp. The organiser's settle (needs_decision -> decided) stays inside
-- the set and keeps the held stamp; a void back to in_play leaves it and clears the stamp (C5). Redefined here
-- with create or replace, BEFORE the backfill below, so the rows it moves keep their decided stamp. V430's
-- header (the INSERT arm keeps a supplied stamp; the trigger fires only on an update that names status) applies.
-- Spec docs/superpowers/specs/2026-10-01-capture-qr-v2-design.md §3 "finished" carries the amended set.
create or replace function fixtures_track_finished() returns trigger language plpgsql as $$
begin
  if new.status in ('decided','finalized','forfeited','abandoned','cancelled','needs_decision') then
    if tg_op = 'INSERT' then
      new.finished_at := coalesce(new.finished_at, now());
    elsif old.status not in ('decided','finalized','forfeited','abandoned','cancelled','needs_decision') then
      new.finished_at := now();
    end if;
  else
    new.finished_at := null;
  end if;
  return new;
end $$;

-- Finding 7, ruling 82 (owner, 2026-10-08): legacy bracket rows stored decided/finalized
-- with a level outcome move to needs_decision, so the organiser sees the block instead of an exception page.
-- The update names `status`, so fixtures_track_finished fires; decided/finalized and needs_decision are all in
-- its finished set (ruling D-M1, above), so the moved rows KEEP their finished_at.
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
