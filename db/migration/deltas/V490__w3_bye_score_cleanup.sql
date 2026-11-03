-- V490 — W3 (format matrix: Swiss) app-B Task 2 (ruling 251; rule X-SW-6): the stored `byeScore` of a board game, removed
-- before the deploy. Spec docs/superpowers/specs/2026-10-31-format-matrix-w3-swiss-design.md; plan
-- docs/superpowers/plans/2026-10-31-w3-swiss-app-b.md Task 2. Numbered main's max + 1 when written (main had reached V489,
-- competition_frozen_at, after Match Day #1111 took V488 and V489); RENUMBER AT MERGE if main has moved. Its test reads this
-- file by glob, never by number (apps/web/src/server/__tests__/w3-migration.test.ts).
--
-- DATA CHANGE (LOUD). Engine 2.0.0 removes `byeScore` from the board game's config (a pairing-allocated bye is always the
-- win, X-SW-5; the key was declared and read nowhere) and moves boardgame's FOLD_EPOCH 4 → 5. Its config parse strips the
-- key. The app then reads a stored `byeScore` as a CHANGE: `changedConfigKeys` (usecases/divisions.ts) diffs the parsed patch
-- against the RAW stored row, and a started division refuses a changed key (DIVISION_FORMAT_LOCKED, rule-locks.ts). The
-- Settings page re-sends the stored config on every save, so a division that still stores the key refuses every later save
-- with a 409 naming `byeScore` (`restoreKey` writes it back, so the refusal repeats). The `divisions.config` strip below is
-- therefore load-bearing, not cosmetic. The other four places are stripped so that nothing stored holds a key the engine no
-- longer declares (a frozen snapshot and a state cache are read as they are).
--
-- ── Where sport config is stored (V481's words; a0-findings A0.7, re-pinned against information_schema) ──
-- divisions.config          the FULL parsed config.
-- stages.config->'rules'    a PARTIAL overlay laid over the division's with a SHALLOW merge; null means inherit. The other
--                           `stages.config` keys are not sport config.
-- fixtures.rules_override   the LEAVES one match changed, merged leaf by leaf over its stage's format; a null top-level key
--                           means inherit.
-- fixtures.config_snapshot  the FULL config frozen at the match's first event; the fold reads it as it is.
-- match_states.state->'cfg' the FULL config inside the folded-state cache.
-- sport_variants.config is code-owned (`npm run sync:sports` rewrites it on every deploy) and is not touched here.
-- Every statement is scoped by the row's sport, read off its division: `sport_key = 'boardgame'`. Boardgame is the only sport
-- that ever stored the key (engine 1.1.0 declares `byeScore` in sports/boardgame/boardgame.js alone), so a stray `byeScore`
-- on any other sport's row is not this delta's to remove. The delta runs as the migrating role, which bypasses RLS, as V432,
-- V438 and V481 do: run as app_user, it sees the current organisation's rows alone.
--
-- ── Pre-flight count (W3 app-B Task 0, read-only, staging, 2026-11-02, after the owner-approved 11-02 staging cleanup) ──
-- boardgame rows carrying `byeScore`, in the order of the five places above: 13 / 0 / 0 / 23 / 28 (divisions.config 13,
-- stages.config->'rules' 0, fixtures.rules_override 0, fixtures.config_snapshot 23, match_states.state->'cfg' 28). Production
-- was not queried (the owner runs it); the block COUNTS FIRST and reports what it found in a NOTICE, then writes, and reports
-- the rows each statement changed (`W3 bye score cleanup: <place> byeScore=<n>`). The counts and the changes agree on a quiet
-- database; a difference means a writer ran between the count and the update, which a second run settles.
--
-- ── Runbook ──
-- 1. Run this delta BEFORE the 2.0.0 deploy (prod.yml migrates before it deploys). It is one block, so it commits whole or not
--    at all.
-- 2. THE 1.x WINDOW. Between this strip and the 2.0.0 app serving, the 1.x app re-adds the default `byeScore: 2` to any
--    boardgame config it writes (a division created or saved, a first event's snapshot, a folded state). The delta is
--    idempotent: run it once more after 2.0.0 is serving. The PR body carries this line.
-- 3. The 426 gate. After the deploy a native capture client still on engine 1.x sends `engine_epoch: 4` for a boardgame fixture
--    and gets 426 ENGINE_OUTDATED; the web pad sends no `engine_epoch` and is unaffected. The emergency lever is
--    ENGINE_EPOCH_FLOOR_OVERRIDE=boardgame=4, and it is safe here: outcomes, summaries and deltas are byte-identical across the
--    bump (only the `byeScore` text left the states), so an epoch-4 phone folds the same results.
--
-- Idempotent: every update is guarded by the key it removes, so a second run changes no row.
do $$
declare
  n_division integer;
  n_stage integer;
  n_override integer;
  n_snapshot integer;
  n_state integer;
  changed integer;
begin
  -- ═══ 1. Count first ═══
  select count(*) into n_division
    from divisions d
   where d.sport_key = 'boardgame' and d.config ? 'byeScore';
  select count(*) into n_stage
    from stages s join divisions d on d.id = s.division_id
   where d.sport_key = 'boardgame' and (s.config -> 'rules') ? 'byeScore';
  select count(*) into n_override
    from fixtures f join divisions d on d.id = f.division_id
   where d.sport_key = 'boardgame' and f.rules_override ? 'byeScore';
  select count(*) into n_snapshot
    from fixtures f join divisions d on d.id = f.division_id
   where d.sport_key = 'boardgame' and f.config_snapshot ? 'byeScore';
  select count(*) into n_state
    from match_states m join fixtures f on f.id = m.fixture_id join divisions d on d.id = f.division_id
   where d.sport_key = 'boardgame' and (m.state -> 'cfg') ? 'byeScore';
  raise notice 'W3 bye score cleanup: counted before writing divisions.config=% stages.config.rules=% fixtures.rules_override=% fixtures.config_snapshot=% match_states.state.cfg=%',
    n_division, n_stage, n_override, n_snapshot, n_state;

  -- ═══ 2. Remove byeScore from the five places ═══
  update divisions d
     set config = d.config - 'byeScore'
   where d.sport_key = 'boardgame'
     and d.config ? 'byeScore';
  get diagnostics changed = row_count;
  raise notice 'W3 bye score cleanup: divisions.config byeScore=%', changed;

  update stages s
     set config = s.config #- '{rules,byeScore}'
    from divisions d
   where d.id = s.division_id and d.sport_key = 'boardgame'
     and (s.config -> 'rules') ? 'byeScore';
  get diagnostics changed = row_count;
  raise notice 'W3 bye score cleanup: stages.config.rules byeScore=%', changed;

  update fixtures f
     set rules_override = f.rules_override - 'byeScore'
    from divisions d
   where d.id = f.division_id and d.sport_key = 'boardgame'
     and f.rules_override ? 'byeScore';
  get diagnostics changed = row_count;
  raise notice 'W3 bye score cleanup: fixtures.rules_override byeScore=%', changed;

  update fixtures f
     set config_snapshot = f.config_snapshot - 'byeScore'
    from divisions d
   where d.id = f.division_id and d.sport_key = 'boardgame'
     and f.config_snapshot ? 'byeScore';
  get diagnostics changed = row_count;
  raise notice 'W3 bye score cleanup: fixtures.config_snapshot byeScore=%', changed;

  update match_states m
     set state = m.state #- '{cfg,byeScore}'
    from fixtures f join divisions d on d.id = f.division_id
   where f.id = m.fixture_id and d.sport_key = 'boardgame'
     and (m.state -> 'cfg') ? 'byeScore';
  get diagnostics changed = row_count;
  raise notice 'W3 bye score cleanup: match_states.state.cfg byeScore=%', changed;
end $$;
