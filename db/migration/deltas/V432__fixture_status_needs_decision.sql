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
update fixtures f set status = 'needs_decision'
  from stages s
 where s.id = f.stage_id
   and s.kind in ('knockout','double_elim','stepladder','page_playoff','ladder')
   and f.status in ('decided','finalized')
   and f.outcome->>'kind' in ('draw','tie','no_result');
