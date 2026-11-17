-- V526 — W5 (format matrix: round robin) app-A Task 5 (rules X-CU-7, X-CU-8; rulebook RB5-L10; owner rulings 271, 276; spec
-- docs/superpowers/specs/2026-11-05-format-matrix-w5-round-robin-design.md §4.1, §10): an entrant that ARRIVED AUTOMATICALLY in a
-- division whose root league or group stage is running — a confirmed or paid registration, a waitlist promotion, an import, a
-- Reinstate with no lines — is never placed by the app. It waits, flagged on the desk, until one organiser tap runs the late-entry
-- cases. Its test reads this file by glob, never by number (apps/web/src/server/usecases/__tests__/w5-migration.test.ts).
--
-- `table_waiting_stage_id` names the root table stage the entrant waits to join: a SECOND column beside W4's
-- `knockout_waiting_stage_id` (V494), not a rename (designer's call, design §10) — W4's readers keep their meaning. Written by the
-- automatic admission (W5 Task 6), cleared by the tap that places them, by a Rebuild, and by a withdrawal or delete of the entrant
-- (Task 6). `on delete set null`: deleting the stage leaves nothing to wait for. The partial index serves that set-null and the
-- desk's count: almost no entrant waits (the V494 shape).
--
-- DATA CHANGE (LOUD): the backfill flags the entrants this gap already stranded. Pre-flight count 2 (W5 app-A Task 0, 2026-11-16:
-- active entrants of a started league/group entry stage seated in none of its fixtures): stg 4 rows, of which 1 sits in a COMPLETE
-- football group and is NOT flagged (controller ruling 2026-11-16: a finished table takes no one, RB5-L8), so stg 3 rows are
-- flagged; prod 0 rows (prod's only league is complete). stg data is test-only: no compat shim. Runs pre-deploy; listed in the PR
-- body.
--
-- The root table is the division's ENTRY stage (lowest seq), a league or group drawing from the live roster (no progression, no
-- stored `qualified`) — `isRootTableStage` (apps/web/src/lib/open-entry-stages.ts) spelt in SQL — that is RUNNING (not complete),
-- already drawn (it has fixtures), in a started division. Only entrants still in the field and seated in none of its fixtures.
--
-- Idempotent: `if not exists` on the schema; the backfill touches only rows still null, so a second run flags nothing new.
alter table entrants add column if not exists table_waiting_stage_id uuid
  references stages(id) on delete set null;
create index if not exists entrants_table_waiting_stage_idx on entrants (table_waiting_stage_id)
  where table_waiting_stage_id is not null;

update entrants e
   set table_waiting_stage_id = s.id
  from stages s
  join divisions d on d.id = s.division_id
 where s.division_id = e.division_id
   and d.status in ('active', 'completed')
   and s.kind in ('league', 'group')
   and s.progression is null
   and not (s.config ? 'qualified')
   and s.status <> 'complete'
   and s.seq = (select min(s2.seq) from stages s2 where s2.division_id = s.division_id)
   and exists (select 1 from fixtures f where f.stage_id = s.id)
   and not exists (
     select 1 from fixtures f
      where f.stage_id = s.id and e.id in (f.home_entrant_id, f.away_entrant_id))
   and e.status in ('registered', 'confirmed')
   and e.table_waiting_stage_id is null;
