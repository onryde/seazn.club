-- V493 — W4 (format matrix: knockout) app-A Task 11 (gaps K7, K13; rule X-LE-10; owner ruling 271): an entrant that ARRIVED
-- AUTOMATICALLY in a division whose root knockout has started — a confirmed or paid registration, a waitlist promotion,
-- an import, a Reinstate — is never placed in the bracket by the app. It waits, and the desk says so ("1 late player
-- waiting — add to bracket"); one organiser tap (`POST /stages/{id}/late-entrants/{entrantId}/place`) then runs the same
-- cases an organiser's "Add late player" runs. Spec docs/superpowers/specs/2026-11-04-format-matrix-w4-knockout-design.md
-- §4.1. Its test reads this file by glob, never by number (apps/web/src/server/__tests__/w4-migration.test.ts).
--
-- `knockout_waiting_stage_id` names the root knockout the entrant waits to join. Written by the automatic admission
-- (`admitKnockoutLateEntrant`, apps/web/src/server/usecases/knockout-late-entry.ts), cleared by the tap that places them
-- and by a Rebuild (which seats every active entrant). Null everywhere else.
--
-- `on delete set null`: deleting the stage leaves nothing to wait for. The partial index serves that set-null and the
-- desk's count (`where knockout_waiting_stage_id is not null`): almost no entrant waits (the V487 shape).
--
-- A schema change only — no backfill. Pre-flight count 2 (W4 app-A Task 0: active entrants of a started division seated
-- in none of its root knockout's fixtures, the root being the division's first stage): stg 0 rows. Prod's census was
-- still the owner's to run when this was written; a non-zero count there is a follow-up backfill, never this delta.
--
-- Idempotent: `if not exists` makes a second run of either statement a no-op.
alter table entrants add column if not exists knockout_waiting_stage_id uuid
  references stages(id) on delete set null;
create index if not exists entrants_knockout_waiting_stage_idx on entrants (knockout_waiting_stage_id)
  where knockout_waiting_stage_id is not null;
