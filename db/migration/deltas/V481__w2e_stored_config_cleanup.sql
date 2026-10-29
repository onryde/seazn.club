-- V481 — W2e (format matrix: sport fidelity): the stored-config cleanup, run before the deploy (D18).
-- Spec docs/superpowers/specs/2026-10-28-format-matrix-w2e-design.md §9; plan Task 13b (A1h). One unmerged migration,
-- AMENDED while PR A is open, never corrected forward. Numbered main's max + 1 when written (main had reached V480,
-- youtube_broadcast_actual_times); RENUMBER AT MERGE if main has moved. Its test reads this file by glob
-- (apps/web/src/server/__tests__/w2e-migration.test.ts).
--
-- ── Where sport config is stored (a0-findings A0.7, re-pinned against information_schema) ──
-- divisions.config          the FULL parsed config.
-- stages.config->'rules'    a PARTIAL overlay laid over the division's with a SHALLOW merge (a top-level key replaces the
--                           division's whole); null means inherit. The other `stages.config` keys are not sport config.
-- fixtures.rules_override   the LEAVES one match changed, merged leaf by leaf over its stage's format (an object whose
--                           keys its base object lacks replaces it whole); a null top-level key means inherit.
-- fixtures.config_snapshot  the FULL config frozen at the match's first event; the fold reads it as it is.
-- match_states.state->'cfg' the FULL config inside the folded-state cache.
-- sport_variants.config is code-owned (`npm run sync:sports` rewrites it on every deploy) and is not touched here.
-- Every statement is scoped by the row's sport, read off its division. The delta runs as the migrating role, which
-- bypasses RLS, as V432 and V438 do: run as app_user, it sees the current organisation's rows alone.
--
-- ── What this delta does, in order, in one block ──
-- 1. FAIL LOUD (PO decision 2026-10-28, Task 13; batch review I-1). Before anything is written it counts the stored
--    configs the W2e write doors refuse, in all five places above, so that no division, stage or match is left with a
--    format whose next save is refused whatever it changed, and no played match holds one silently:
--    * a volleyball or table tennis `setTo` or `finalSetTo` below 5 (ruling 31; VB-CF-1, TT-CF-1), counted where the
--      value is stored;
--    * a tennis best of 1 whose final set is a match tie-break (RB2A-13; TN-CF-1), as each layer resolves (division;
--      division + stage rules; division + stage rules + the match's own; the snapshot and the state cache as they are),
--      counted on the layer that names `bestOf` or `finalSet` itself.
--    Any count above zero raises, naming the count and every row by place, and nothing is written: the deploy stops
--    (prod.yml migrates before it deploys). Staging counted 0 in all five places (read 2026-10-29).
-- 2. Removes `shootout.suddenDeath` from hockey and ice hockey configs (W2e D4; HK-SO-2, IH-SO-2): the key was declared
--    and never read, and the period kernel no longer declares it.
-- 3. Removes `progressScore` from generic configs (W2e D6): the key was stored and never read.
-- 4. Pins every Fast4-shaped tennis set (`gamesTo` 4, tie-break at 3–3) to the tie-break margin it plays today (W2e
--    RB2A-12, TN-SS-2; owner ruling: the margin is the config's own `tiebreak.winBy`, 2 when absent, never a literal 2,
--    so an organiser's sudden-death Fast4 stays sudden death). Before W2e no stored set carried `tiebreakWinBy`, and a set
--    without it plays to the RESOLVED `tiebreak.winBy`; after W2e the fast4 preset carries a margin of 1, and the key, once
--    stored, wins over `tiebreak.winBy`. Each layer is pinned to the margin its own resolved format plays:
--    a. a match's own format (`rules_override`) whose resolved set is Fast4-shaped and carries no margin, unless the set
--       it inherits will be pinned below to the same margin: it stores the WHOLE resolved set with the margin, because
--       adding the key alone to a partial set (the stored leaves) would turn the leaf merge into a whole replacement
--       that drops the stage's `winBy` and `tiebreakTo`. This also covers a match that changed only `tiebreak.winBy`
--       under an inherited Fast4 set, whose set would otherwise take the stage's margin once that is pinned;
--    b. a stage's rules, the same way: its own Fast4 set gains its margin, and a stage that changed only `tiebreak.winBy`
--       under the division's Fast4 set stores that set whole with its own margin (the stage merge is shallow, so a
--       partial `set` would replace the division's whole);
--    c. the division config, d. the frozen snapshot and e. the state cache, each a full config: its own margin.
--    a and b run BEFORE c, because they ask whether the set above them is still unpinned.
-- Each step reports the rows it changed in a NOTICE (`W2e stored-config cleanup: <column> <change>=<n>`).
--
-- Idempotent: every update is guarded by the shape it changes, so a second run changes no row.
do $$
declare
  refused_count integer;
  division_list text;
  stage_list text;
  override_list text;
  snapshot_list text;
  state_list text;
  changed integer;
begin
  -- ═══ 1. Fail loud ═══
  with
  -- The floor is the engine's `minSetTo` for volleyball and table tennis (packages/engine/src/sports/setbased/
  -- volleyball.ts and tabletennis.ts, `minSetTo: 5`; the write doors refuse a `setTo` or `finalSetTo` below it). The test
  -- reads the engine's own floor and pins this literal to it.
  floor_layer (kind, id, cfg) as (
    select 'divisions.config', d.id, d.config
      from divisions d
     where d.sport_key in ('volleyball', 'tabletennis')
    union all
    select 'stages.config.rules', s.id, s.config -> 'rules'
      from stages s join divisions d on d.id = s.division_id
     where d.sport_key in ('volleyball', 'tabletennis')
    union all
    select 'fixtures.rules_override', f.id, f.rules_override
      from fixtures f join divisions d on d.id = f.division_id
     where d.sport_key in ('volleyball', 'tabletennis')
    union all
    select 'fixtures.config_snapshot', f.id, f.config_snapshot
      from fixtures f join divisions d on d.id = f.division_id
     where d.sport_key in ('volleyball', 'tabletennis')
    union all
    select 'match_states.state.cfg', m.fixture_id, m.state -> 'cfg'
      from match_states m join fixtures f on f.id = m.fixture_id join divisions d on d.id = f.division_id
     where d.sport_key in ('volleyball', 'tabletennis')
  ),
  below_floor (kind, id) as (
    select kind, id
      from floor_layer
     where jsonb_typeof(cfg) = 'object'
       and ((jsonb_typeof(cfg -> 'setTo') = 'number' and (cfg ->> 'setTo')::numeric < 5)
         or (jsonb_typeof(cfg -> 'finalSetTo') = 'number' and (cfg ->> 'finalSetTo')::numeric < 5))
  ),
  tennis_layer (kind, id, own, best_of, final_set) as (
    select 'divisions.config', d.id, d.config, d.config -> 'bestOf', d.config -> 'finalSet'
      from divisions d
     where d.sport_key = 'tennis'
    union all
    select 'stages.config.rules', s.id, s.config -> 'rules',
           coalesce(nullif(s.config #> '{rules,bestOf}', 'null'), d.config -> 'bestOf'),
           coalesce(nullif(s.config #> '{rules,finalSet}', 'null'), d.config -> 'finalSet')
      from stages s join divisions d on d.id = s.division_id
     where d.sport_key = 'tennis'
    union all
    select 'fixtures.rules_override', f.id, f.rules_override,
           coalesce(nullif(f.rules_override -> 'bestOf', 'null'), nullif(s.config #> '{rules,bestOf}', 'null'), d.config -> 'bestOf'),
           coalesce(nullif(f.rules_override -> 'finalSet', 'null'), nullif(s.config #> '{rules,finalSet}', 'null'), d.config -> 'finalSet')
      from fixtures f join stages s on s.id = f.stage_id join divisions d on d.id = f.division_id
     where d.sport_key = 'tennis'
    union all
    select 'fixtures.config_snapshot', f.id, f.config_snapshot, f.config_snapshot -> 'bestOf', f.config_snapshot -> 'finalSet'
      from fixtures f join divisions d on d.id = f.division_id
     where d.sport_key = 'tennis'
    union all
    select 'match_states.state.cfg', m.fixture_id, m.state -> 'cfg', m.state #> '{cfg,bestOf}', m.state #> '{cfg,finalSet}'
      from match_states m join fixtures f on f.id = m.fixture_id join divisions d on d.id = f.division_id
     where d.sport_key = 'tennis'
  ),
  bo1_match_tiebreak (kind, id) as (
    select kind, id
      from tennis_layer
     where jsonb_typeof(own) = 'object'
       and (nullif(own -> 'bestOf', 'null') is not null or nullif(own -> 'finalSet', 'null') is not null)
       and best_of = '1'::jsonb
       and jsonb_typeof(final_set) = 'object' and (final_set ? 'matchTiebreakTo')
  ),
  refused (kind, id) as (
    select kind, id from below_floor
    union
    select kind, id from bo1_match_tiebreak
  )
  select count(*)::integer,
         coalesce(string_agg(id::text, ',' order by id::text) filter (where kind = 'divisions.config'), ''),
         coalesce(string_agg(id::text, ',' order by id::text) filter (where kind = 'stages.config.rules'), ''),
         coalesce(string_agg(id::text, ',' order by id::text) filter (where kind = 'fixtures.rules_override'), ''),
         coalesce(string_agg(id::text, ',' order by id::text) filter (where kind = 'fixtures.config_snapshot'), ''),
         coalesce(string_agg(id::text, ',' order by id::text) filter (where kind = 'match_states.state.cfg'), '')
    into refused_count, division_list, stage_list, override_list, snapshot_list, state_list
    from refused;
  if refused_count > 0 then
    raise exception 'W2e stored configs the write doors refuse: count=% divisions.config=% stages.config.rules=% '
                    'fixtures.rules_override=% fixtures.config_snapshot=% match_states.state.cfg=%',
      refused_count, division_list, stage_list, override_list, snapshot_list, state_list
      using hint = 'Raise each volleyball and table tennis setTo and finalSetTo to 5 or more, and give each best-of-1 tennis '
                || 'format a deciding set (finalSet same or {tiebreakTo}) or best of 3 in place of its match tie-break, on the '
                || 'division, stage rules or match format named. A snapshot or state cache named is a played match''s: '
                || 'agree its correction with the owner and refold it. Then run the migration again (W2e ruling 31, RB2A-13).';
  end if;
  raise notice 'W2e stored configs the write doors refuse: count=0';

  -- ═══ 2. shootout.suddenDeath (hockey, ice hockey) ═══
  update divisions d
     set config = d.config #- '{shootout,suddenDeath}'
   where d.sport_key in ('hockey', 'icehockey')
     and (d.config -> 'shootout') ? 'suddenDeath';
  get diagnostics changed = row_count;
  raise notice 'W2e stored-config cleanup: divisions.config shootout.suddenDeath=%', changed;

  update stages s
     set config = s.config #- '{rules,shootout,suddenDeath}'
    from divisions d
   where d.id = s.division_id and d.sport_key in ('hockey', 'icehockey')
     and (s.config #> '{rules,shootout}') ? 'suddenDeath';
  get diagnostics changed = row_count;
  raise notice 'W2e stored-config cleanup: stages.config.rules shootout.suddenDeath=%', changed;

  update fixtures f
     set rules_override = f.rules_override #- '{shootout,suddenDeath}'
    from divisions d
   where d.id = f.division_id and d.sport_key in ('hockey', 'icehockey')
     and (f.rules_override -> 'shootout') ? 'suddenDeath';
  get diagnostics changed = row_count;
  raise notice 'W2e stored-config cleanup: fixtures.rules_override shootout.suddenDeath=%', changed;

  update fixtures f
     set config_snapshot = f.config_snapshot #- '{shootout,suddenDeath}'
    from divisions d
   where d.id = f.division_id and d.sport_key in ('hockey', 'icehockey')
     and (f.config_snapshot -> 'shootout') ? 'suddenDeath';
  get diagnostics changed = row_count;
  raise notice 'W2e stored-config cleanup: fixtures.config_snapshot shootout.suddenDeath=%', changed;

  update match_states m
     set state = m.state #- '{cfg,shootout,suddenDeath}'
    from fixtures f join divisions d on d.id = f.division_id
   where f.id = m.fixture_id and d.sport_key in ('hockey', 'icehockey')
     and (m.state #> '{cfg,shootout}') ? 'suddenDeath';
  get diagnostics changed = row_count;
  raise notice 'W2e stored-config cleanup: match_states.state.cfg shootout.suddenDeath=%', changed;

  -- ═══ 3. progressScore (generic) ═══
  update divisions d
     set config = d.config - 'progressScore'
   where d.sport_key = 'generic'
     and d.config ? 'progressScore';
  get diagnostics changed = row_count;
  raise notice 'W2e stored-config cleanup: divisions.config progressScore=%', changed;

  update stages s
     set config = s.config #- '{rules,progressScore}'
    from divisions d
   where d.id = s.division_id and d.sport_key = 'generic'
     and (s.config -> 'rules') ? 'progressScore';
  get diagnostics changed = row_count;
  raise notice 'W2e stored-config cleanup: stages.config.rules progressScore=%', changed;

  update fixtures f
     set rules_override = f.rules_override - 'progressScore'
    from divisions d
   where d.id = f.division_id and d.sport_key = 'generic'
     and f.rules_override ? 'progressScore';
  get diagnostics changed = row_count;
  raise notice 'W2e stored-config cleanup: fixtures.rules_override progressScore=%', changed;

  update fixtures f
     set config_snapshot = f.config_snapshot - 'progressScore'
    from divisions d
   where d.id = f.division_id and d.sport_key = 'generic'
     and f.config_snapshot ? 'progressScore';
  get diagnostics changed = row_count;
  raise notice 'W2e stored-config cleanup: fixtures.config_snapshot progressScore=%', changed;

  update match_states m
     set state = m.state #- '{cfg,progressScore}'
    from fixtures f join divisions d on d.id = f.division_id
   where f.id = m.fixture_id and d.sport_key = 'generic'
     and (m.state -> 'cfg') ? 'progressScore';
  get diagnostics changed = row_count;
  raise notice 'W2e stored-config cleanup: match_states.state.cfg progressScore=%', changed;

  -- ═══ 4. Fast4-shaped tennis sets keep the margin they play (a, b BEFORE c: they read the unpinned set above) ═══
  -- 4a. A match's own format. `base` is the set its stage resolves (the stage's own, else the division's), `resolved`
  --     the leaf merge of the match's leaves over it (a set is flat, so `||` is that merge), `margin` the match's
  --     resolved `tiebreak.winBy` and `base_margin` the stage's.
  update fixtures f
     set rules_override = jsonb_set(f.rules_override, '{set}', x.resolved || jsonb_build_object('tiebreakWinBy', x.margin))
    from (
      select f2.id,
             b.base,
             b.base || coalesce(nullif(f2.rules_override -> 'set', 'null'), '{}'::jsonb) as resolved,
             coalesce(nullif(f2.rules_override #> '{tiebreak,winBy}', 'null'), nullif(s.config #> '{rules,tiebreak,winBy}', 'null'),
                      nullif(d.config #> '{tiebreak,winBy}', 'null'), '2'::jsonb) as margin,
             coalesce(nullif(s.config #> '{rules,tiebreak,winBy}', 'null'), nullif(d.config #> '{tiebreak,winBy}', 'null'),
                      '2'::jsonb) as base_margin
        from fixtures f2
        join stages s on s.id = f2.stage_id
        join divisions d on d.id = f2.division_id
        cross join lateral (select coalesce(nullif(s.config #> '{rules,set}', 'null'), d.config -> 'set') as base) b
       where d.sport_key = 'tennis'
         and jsonb_typeof(f2.rules_override) = 'object'
         and jsonb_typeof(b.base) = 'object'
         and (jsonb_typeof(f2.rules_override -> 'set') = 'object' or nullif(f2.rules_override #> '{tiebreak,winBy}', 'null') is not null)
    ) x
   where x.id = f.id
     and x.resolved -> 'gamesTo' = '4'::jsonb and x.resolved -> 'tiebreakAt' = '3'::jsonb
     and not (x.resolved ? 'tiebreakWinBy')
     and not (x.base -> 'gamesTo' = '4'::jsonb and x.base -> 'tiebreakAt' = '3'::jsonb and x.margin = x.base_margin);
  get diagnostics changed = row_count;
  raise notice 'W2e stored-config cleanup: fixtures.rules_override set.tiebreakWinBy=%', changed;

  -- 4b. A stage's rules: its own set when it has one, else the division's.
  update stages s
     set config = jsonb_set(s.config, '{rules,set}', x.resolved || jsonb_build_object('tiebreakWinBy', x.margin))
    from (
      select s2.id,
             coalesce(nullif(s2.config #> '{rules,set}', 'null'), d.config -> 'set') as resolved,
             nullif(s2.config #> '{rules,set}', 'null') is not null as own_set,
             coalesce(nullif(s2.config #> '{rules,tiebreak,winBy}', 'null'), nullif(d.config #> '{tiebreak,winBy}', 'null'),
                      '2'::jsonb) as margin,
             coalesce(nullif(d.config #> '{tiebreak,winBy}', 'null'), '2'::jsonb) as division_margin
        from stages s2
        join divisions d on d.id = s2.division_id
       where d.sport_key = 'tennis'
         and jsonb_typeof(s2.config -> 'rules') = 'object'
    ) x
   where x.id = s.id
     and jsonb_typeof(x.resolved) = 'object'
     and x.resolved -> 'gamesTo' = '4'::jsonb and x.resolved -> 'tiebreakAt' = '3'::jsonb
     and not (x.resolved ? 'tiebreakWinBy')
     and (x.own_set or x.margin <> x.division_margin);
  get diagnostics changed = row_count;
  raise notice 'W2e stored-config cleanup: stages.config.rules set.tiebreakWinBy=%', changed;

  -- 4c. The division config.
  update divisions d
     set config = jsonb_set(d.config, '{set,tiebreakWinBy}', coalesce(nullif(d.config #> '{tiebreak,winBy}', 'null'), '2'::jsonb))
   where d.sport_key = 'tennis'
     and jsonb_typeof(d.config -> 'set') = 'object'
     and d.config #> '{set,gamesTo}' = '4'::jsonb and d.config #> '{set,tiebreakAt}' = '3'::jsonb
     and not ((d.config -> 'set') ? 'tiebreakWinBy');
  get diagnostics changed = row_count;
  raise notice 'W2e stored-config cleanup: divisions.config set.tiebreakWinBy=%', changed;

  -- 4d. The frozen snapshot.
  update fixtures f
     set config_snapshot = jsonb_set(f.config_snapshot, '{set,tiebreakWinBy}',
                                     coalesce(nullif(f.config_snapshot #> '{tiebreak,winBy}', 'null'), '2'::jsonb))
    from divisions d
   where d.id = f.division_id and d.sport_key = 'tennis'
     and jsonb_typeof(f.config_snapshot -> 'set') = 'object'
     and f.config_snapshot #> '{set,gamesTo}' = '4'::jsonb and f.config_snapshot #> '{set,tiebreakAt}' = '3'::jsonb
     and not ((f.config_snapshot -> 'set') ? 'tiebreakWinBy');
  get diagnostics changed = row_count;
  raise notice 'W2e stored-config cleanup: fixtures.config_snapshot set.tiebreakWinBy=%', changed;

  -- 4e. The state cache.
  update match_states m
     set state = jsonb_set(m.state, '{cfg,set,tiebreakWinBy}', coalesce(nullif(m.state #> '{cfg,tiebreak,winBy}', 'null'), '2'::jsonb))
    from fixtures f join divisions d on d.id = f.division_id
   where f.id = m.fixture_id and d.sport_key = 'tennis'
     and jsonb_typeof(m.state #> '{cfg,set}') = 'object'
     and m.state #> '{cfg,set,gamesTo}' = '4'::jsonb and m.state #> '{cfg,set,tiebreakAt}' = '3'::jsonb
     and not ((m.state #> '{cfg,set}') ? 'tiebreakWinBy');
  get diagnostics changed = row_count;
  raise notice 'W2e stored-config cleanup: match_states.state.cfg set.tiebreakWinBy=%', changed;
end $$;
