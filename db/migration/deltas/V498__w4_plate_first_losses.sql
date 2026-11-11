-- V498 — W4 knockout app PR B, Task 7 (PL-1, X-PL-6): the plate takes EVERY first-match loss. Spec docs/superpowers/specs/2026-11-04-
-- format-matrix-w4-knockout-design.md; plan docs/superpowers/plans/2026-11-05-w4-knockout-app-b.md Task 7. Numbered after V496 (app
-- B's Task 6); V495 is main's sponsor_deals and V497 is reserved for swiss auto-advance: RENUMBER BY SUFFIX AT MERGE if main has
-- moved, never reorder. Its test reads this file by glob, never by number (apps/web/src/server/__tests__/w4b-migration.test.ts).
--
-- DATA CHANGE (LOUD). The ko_plate template used to write the plate's progression as one `roundLosers` take, round 1, `count` the
-- Top N knob (default 4): the plate took the four round-one losers and DROPPED every first loss above that (PL-1: above 12
-- entrants the field is larger than 4; a bye holder who loses in round two lost her FIRST match too). Engine 4.0.0/5.0.0
-- resolves `{ kind: "firstLosses" }` — every eligible first loss, no count, no round — and the template now writes it.
--
-- What it changes: every stage whose progression is EXACTLY one source, `stage: "previous"`, whose take is EXACTLY
-- [{ "kind": "roundLosers", "round": 1, "count": q }] (those three keys and no other), and whose fixtures are ALL placeholders:
-- no seated entrant, no result, nothing started — `fixtureStartedSql`'s SQL arms (usecases/fixture-started-sql.ts, with
-- `fixtureHasResultSql` and `fixtureEvidenceSql`) INLINED, read as stricter, never looser: no home or away entrant, status
-- 'scheduled', no outcome, no frozen cfg (config_snapshot), no score event, match state, report, official's mark, suspension,
-- online-game row or Match Day call.
--   1. The take is rewritten to [{ "kind": "firstLosses" }]; `placement`, `timing`, `carry` and the rest of the progression stay.
--   2. The stage's placeholder fixtures are DELETED (the old take's q-slot TBD bracket). The new take has no slots to lay down
--      before round two (engine: a `firstLosses` take expands to no slot until the source's field is known), so generating the
--      stage afterwards lays the bracket down from the played field. A placeholder that had been given a court or a time loses it
--      with the row; the block counts those and says so.
-- A plate that is SEATED or PLAYED keeps `roundLosers`, which the engine still resolves. So does a plate of any other shape (a named
-- source, several sources, other keys, a round other than 1).
--
-- ── Pre-flight census (W4 app-B Task 0 count 2) ──
-- stg 2026-11-07: 17 stages carry progression; 0 roundLosers takes (all-TBD 0, seated/played 0). Prod: not separately counted; app B T0
-- found no plate rows in the prod counts. The migration is a no-op on both today, and it is idempotent. The block COUNTS FIRST and
-- reports what it found in NOTICEs, then writes, and reports the rows it changed.
--
-- ── Runbook ──
-- 1. Run BEFORE the app that writes `firstLosses` serves (prod.yml migrates before it deploys). One block: it commits whole or not at all.
-- 2. READ THE NOTICES (`W4 plate first losses: ...`). stages and fixtures are FORCE ROW LEVEL SECURITY with a policy `to app_user`
--    only, so a role without BYPASSRLS counts 0, writes 0 and still exits clean. Flyway's migrating role bypasses it; a hand
--    re-run must use that role.
-- 3. Cached public documents turn over with the deploy.
--
-- Idempotent: a second run finds no `roundLosers` take of that shape on an all-placeholder stage and changes none.
do $$
declare
  n_progression integer;
  n_round_losers integer;
  n_targets integer;
  n_fixtures integer;
  n_scheduled integer;
  n_rewritten integer;
  n_deleted integer;
begin
  create temp table if not exists w4_v498_targets (stage_id uuid primary key) on commit drop;
  truncate w4_v498_targets;

  -- ═══ 1. Count first ═══
  select count(*) into n_progression from stages s where s.progression is not null;
  select count(*) into n_round_losers
    from stages s
   where s.progression is not null
     and jsonb_path_exists(s.progression, '$.sources[*].take[*] ? (@.kind == "roundLosers")');

  insert into w4_v498_targets (stage_id)
  select s.id
    from stages s
   where s.progression is not null
     -- a plate: a knockout that draws at setup (an on_complete plate takes no first-loss field, review m5)
     and s.kind = 'knockout'
     and s.progression ->> 'timing' = 'setup'
     -- exactly one source, the previous stage, taking exactly one rule: roundLosers, round 1, a count, nothing else
     and case when jsonb_typeof(s.progression -> 'sources') = 'array' then jsonb_array_length(s.progression -> 'sources') end = 1
     and s.progression #>> '{sources,0,stage}' = 'previous'
     and case when jsonb_typeof(s.progression #> '{sources,0,take}') = 'array' then jsonb_array_length(s.progression #> '{sources,0,take}') end = 1
     and s.progression #>> '{sources,0,take,0,kind}' = 'roundLosers'
     and (s.progression #> '{sources,0,take,0,round}') = '1'::jsonb
     and jsonb_typeof(s.progression #> '{sources,0,take,0,count}') = 'number'
     and (select count(*) from jsonb_object_keys(s.progression #> '{sources,0,take,0}')) = 3
     -- ... and every fixture of the stage a placeholder (vacuously true for a stage not generated yet)
     and not exists (
       select 1 from fixtures f
        where f.stage_id = s.id
          and (f.home_entrant_id is not null or f.away_entrant_id is not null
               or f.status <> 'scheduled'
               or f.outcome is not null
               or f.config_snapshot is not null
               or exists (select 1 from score_events se where se.fixture_id = f.id)
               or exists (select 1 from match_states ms where ms.fixture_id = f.id)
               or exists (select 1 from match_reports mr where mr.fixture_id = f.id)
               or exists (select 1 from official_marks om where om.fixture_id = f.id)
               or exists (select 1 from suspensions su where su.fixture_id = f.id)
               or exists (select 1 from fixture_external_play x where x.fixture_id = f.id)
               or exists (select 1 from fixture_calls fc where fc.fixture_id = f.id)));
  select count(*) into n_targets from w4_v498_targets;
  select count(*), count(*) filter (where f.scheduled_at is not null or f.court_label is not null or f.venue is not null)
    into n_fixtures, n_scheduled
    from fixtures f join w4_v498_targets t on t.stage_id = f.stage_id;

  raise notice 'W4 plate first losses: % stage(s) carry a progression', n_progression;
  raise notice 'W4 plate first losses: % stage(s) carry a roundLosers take', n_round_losers;
  raise notice 'W4 plate first losses: % all-placeholder plate(s) to rewrite to firstLosses (PL-1), % placeholder fixture(s) to delete, % of them with a court or a time', n_targets, n_fixtures, n_scheduled;

  -- ═══ 2. Write ═══
  update stages s
     set progression = jsonb_set(s.progression, '{sources,0,take}', '[{"kind": "firstLosses"}]'::jsonb)
    from w4_v498_targets t
   where s.id = t.stage_id;
  get diagnostics n_rewritten = row_count;
  delete from fixtures f using w4_v498_targets t where f.stage_id = t.stage_id;
  get diagnostics n_deleted = row_count;
  raise notice 'W4 plate first losses: % plate(s) rewritten, % placeholder fixture(s) deleted', n_rewritten, n_deleted;
  raise notice 'W4 plate first losses: % roundLosers stage(s) left as they are (seated or played, or another shape)', n_round_losers - n_targets;
end
$$;
