-- V485 — W3 (format matrix: Swiss) app-A Task 9 (ruling 250; rules X-SW-12, X-SW-13): WHICH Swiss stage an entrant's
-- `swiss_first_round` (V484) belongs to. Numbered V485 here, after this branch's V484; RENUMBER AT MERGE to the next free
-- version above everything merged. Its test reads this file by glob, never by number
-- (apps/web/src/server/__tests__/w3-migration.test.ts).
--
-- Why. `swiss_first_round` is a column of the ENTRANT, but the round it names is a round of ONE Swiss stage: the stage
-- that admitted the entrant late (Task 9's `admitSwissLateEntrant`, the column's only writer). Nothing stops a division
-- holding two root Swiss stages (no progression; `assertStageBatchGates` refuses neither), so without this the second
-- stage would read the first stage's stamp and leave a player out of its early rounds. The stamp now counts only where
-- `swiss_first_round_stage_id` names the stage being paired (`swissFirstRoundIn`, apps/web/src/lib/swiss-late-entry.ts);
-- anywhere else the entrant plays from round 1.
--
-- `on delete set null`: deleting the stage orphans the stamp, which then counts nowhere — exactly "from round 1" for any
-- stage made later. No check ties the two columns together for that reason (a set-null would violate it).
--
-- A schema change only. A new nullable column moves no stored value: no writer of `swiss_first_round` has shipped
-- (V484 is this branch's), so no stored stamp is left without its stage.
--
-- The index (T9 review m8): deleting a stage runs the set-null as `update entrants ... where swiss_first_round_stage_id =
-- $1`, and without an index on the referencing column that is a scan of every entrant (the V275 advisor's rule for an
-- unindexed foreign key). Partial: almost every entrant holds no stamp, and `= $1` implies `is not null`, so the planner
-- may use it for that update.
--
-- Idempotent: `if not exists` makes a second run of either statement a no-op.
alter table entrants add column if not exists swiss_first_round_stage_id uuid
  references stages(id) on delete set null;
create index if not exists entrants_swiss_first_round_stage_idx on entrants (swiss_first_round_stage_id)
  where swiss_first_round_stage_id is not null;
