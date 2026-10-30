-- V483 — W2 release: stored tie-break lists that the W2d standings read refuses, run before the deploy (owner rule D18:
-- a data change ships loud, as a pre-deploy migration, with no compat workaround in code). Numbered main's max + 1 when
-- written (main had reached V482, youtube_broadcast_made_for_kids); RENUMBER AT MERGE if main has moved. Its test reads
-- this file by glob (apps/web/src/server/__tests__/w2-tiebreak-preset-migration.test.ts).
--
-- ── Why ──
-- Before W2d the ranker skipped a tie-break entry it had no comparator for, so a football preset NAME stored where its
-- KEYS belong (`["fifa2026"]`, written before the F5 edge guard `TiebreakerKeyS`) ranked every table in seed order. W2d's
-- ranker refuses such an entry (`rankStandings` → `parseCascade`, CONFIG_INVALID "has no comparator"; a pending stage
-- already refuses it while resolving its rules, `defaultCrossGroup` → `isHeadToHeadKey`), so after the W2 deploy those
-- standings throw. Staging (read 2026-10-30, at V482): 3 football divisions of the archived competition "FIFA World Cup
-- 2027" hold `divisions.tiebreakers = ["fifa2026"]`, and V475's pin (`w2d_pin_started_stages`, which copies the division's
-- list verbatim) carried it into `stages.table_rules_pinned.tiebreakers` of their 6 started stages. Nothing else on
-- staging. Prod has never been read, so the same shape may be there; on prod V475 runs before this delta and pins it too.
--
-- ── Where a tie-break list is stored, and what reads it (re-pinned against information_schema and the loader) ──
-- divisions.tiebreakers                   jsonb; SQL or JSON null = inherit. Read for a PENDING stage with no order of
--                                         its own (apps/web/src/server/engine-db/table-rules.ts `divisionOrderOf`).
-- stages.config.tiebreakers               the stage's own order; null = inherit. Read for a pending stage (`ownRulesOf`).
-- stages.config.crossGroupTiebreakers     the stage's own cross-group order; null = derived. Read as above.
-- stages.table_rules_pinned.tiebreakers   the pin (V475, `pinStageTableRules`); read for EVERY stage that has one
-- stages.table_rules_pinned.crossGroup    (`parsePin`), which is every started stage: its own and its division's order
--                                         are then not read at all. The CHECK keeps a pin an object or SQL null.
-- divisions.config.tiebreakers            no reader (no sport schema declares the key; nothing in apps/web or the engine
--                                         reads it). Mended defensively below, and censused, but never refused.
--
-- ── What the read path refuses (the census raises on exactly this, read from the code, not assumed) ──
-- * a value that is not a list: the loader's `z.array(z.string())` (an absent pin key is one too: the pin needs both);
-- * an entry that is not a string: the same schema;
-- * a string that is not a tie-break key: `parseCascade` (and `isHeadToHeadKey`); the key list below is `TiebreakerKeyS`
--   (apps/web/src/server/api-v1/schemas.ts), which `TiebreakerKeySchemaMatchesEngine` holds to the engine's union;
-- * a block modifier (`h2h_reapply`, `h2h_exclusion`) that does not directly follow a head-to-head block key, at most one
--   per block: `parseCascade` throws "must directly follow a head-to-head block". Splicing a preset after a list that
--   already holds the block's keys can PRODUCE this (the de-duplication removes the preset's block), so it is counted.
-- * the EMPTY list `[]`, in four places of the five: the engine's ranker accepts `[]` (no step; seed order), but the web
--   loader reads every order with `z.array(z.string()).min(1)` (`Order`, and the pin's `tiebreakers`) and refuses it,
--   CONFIG_INVALID `order_invalid` / `pin_invalid`. Before W2d an empty division list read as seed order, and V475 copies
--   one into a pin, so `[]` is refused in divisions.tiebreakers, both stage orders and the pin's tiebreakers. The pin's
--   `crossGroup` has no minimum (`StoredPin.crossGroup`) and the cross-group ranking takes `[]` as seed order, so an
--   empty `crossGroup` is NOT refused.
-- Not refused by the read path, so not counted: a repeated key, and a step the write side would refuse on this sport or
-- stage (`validateCascade`: first/last, fair play off, ...). A fair-play step on a division that does not track fair
-- play ranks (every row reads zero) but its next order save is refused: the organiser's to correct, not this delta's.
--
-- ── What this delta does, in order, in one block ──
-- 1. Expands football's preset names. In every football list (division, division config, stage's own order, pin), each
--    entry equal to a preset name (`fifa2026`, `uefa`, `classic`) is replaced, in place, by that preset's keys
--    (`FOOTBALL_TIEBREAKERS`, packages/engine/src/sports/football/football.ts; the test pins the literal to it), then the
--    list is de-duplicated keeping each key's first occurrence. A list with no preset name is not touched. The two
--    cross-group places are not expanded: they were written only by W2d code, through `TiebreakerKeyS` (the stage's own)
--    or as a literal (V475's pin), so a preset name there is not a shape to mend: the census names it. A NOTICE per place
--    names how many rows changed and which (`W2 tie-break preset names: <place> expanded=<n> ids=<ids>`).
-- 2. FAILS LOUD. A census of every list in the five read places, every sport, counts what the read path refuses (above).
--    Any refusal raises, naming every list by place, id (a division's or a stage's), sport, the entry and why, so the
--    block writes nothing (step 1 included) and the deploy stops (prod.yml migrates before it deploys). A NOTICE names how
--    many lists it checked per place. divisions.config.tiebreakers is censused too and its refusals are named in a
--    NOTICE, never raised: nothing reads it.
--
-- Idempotent: step 1 changes only a list that still holds a preset name, and its result holds none, so a second run
-- changes no row; the census writes nothing.
do $$
declare
  -- FOOTBALL_TIEBREAKERS, each preset's keys in its own order.
  presets constant jsonb := '{
    "fifa2026": ["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "fair_play", "lots"],
    "uefa":     ["points", "h2h_points", "h2h_diff", "h2h_for", "h2h_reapply", "diff", "for", "fair_play", "lots"],
    "classic":  ["points", "diff", "for", "h2h_points", "h2h_diff", "h2h_for", "fair_play", "lots"]
  }';
  -- TiebreakerKeyS.options, in its own order.
  tiebreak_keys constant text[] := array[
    'points', 'wins', 'h2h_points', 'h2h_diff', 'h2h_for', 'diff', 'for', 'nrr',
    'set_ratio', 'game_ratio', 'board_ratio', 'point_ratio', 'buchholz',
    'buchholz_cut1', 'sberger', 'direct', 'fair_play', 'seed', 'lots',
    'set_diff', 'point_diff', 'h2h_two', 'h2h_wins', 'h2h_set_ratio', 'h2h_point_ratio', 'h2h_reapply', 'h2h_exclusion',
    'matches_played', 'field_goals'];
  -- The ranker's head-to-head block keys and the modifiers that close a block (`parseCascade`).
  block_keys constant text[] := array['h2h_points', 'h2h_diff', 'h2h_for', 'h2h_wins', 'h2h_set_ratio', 'h2h_point_ratio'];
  modifier_keys constant text[] := array['h2h_reapply', 'h2h_exclusion'];
  expanded jsonb;
  changed integer;
  changed_ids text;
  checked_counts jsonb;
  refused_count integer;
  refused_list text;
  unread_list text;
begin
  -- ═══ 1. Expand football's preset names ═══
  -- `expanded` maps '<place> <id>' to the list that replaces it: each entry's preset keys at its position (`pos`, then
  -- the key's place in the preset, `sub`), a non-preset entry as itself, then every key's first occurrence only.
  with
  lists (place, id, list) as (
    select 'divisions.tiebreakers', d.id, d.tiebreakers
      from divisions d
     where d.sport_key = 'football'
    union all
    select 'divisions.config.tiebreakers', d.id, d.config -> 'tiebreakers'
      from divisions d
     where d.sport_key = 'football'
    union all
    select 'stages.config.tiebreakers', s.id, s.config -> 'tiebreakers'
      from stages s join divisions d on d.id = s.division_id
     where d.sport_key = 'football'
    union all
    select 'stages.table_rules_pinned.tiebreakers', s.id, s.table_rules_pinned -> 'tiebreakers'
      from stages s join divisions d on d.id = s.division_id
     where d.sport_key = 'football'
  ),
  holding (place, id, list) as (
    select place, id, list
      from lists
     where jsonb_typeof(list) = 'array'
       and exists (select 1
                     from jsonb_array_elements(case when jsonb_typeof(list) = 'array' then list else '[]'::jsonb end) as e (entry)
                    where jsonb_typeof(e.entry) = 'string' and presets ? (e.entry #>> '{}'))
  ),
  spliced (place, id, entry, pos, sub) as (
    select h.place, h.id, coalesce(p.key, t.entry), t.pos, coalesce(p.sub, 0)
      from holding h
     cross join lateral jsonb_array_elements(case when jsonb_typeof(h.list) = 'array' then h.list else '[]'::jsonb end)
           with ordinality as t (entry, pos)
      left join lateral jsonb_array_elements(presets -> (t.entry #>> '{}')) with ordinality as p (key, sub)
        on jsonb_typeof(t.entry) = 'string'
  ),
  firsts (place, id, entry, pos, sub) as (
    select place, id, entry, pos, sub
      from (select place, id, entry, pos, sub,
                   row_number() over (partition by place, id, entry order by pos, sub) as nth
              from spliced) x
     where nth = 1
  )
  select coalesce(jsonb_object_agg(place || ' ' || id, list), '{}'::jsonb)
    into expanded
    from (select place, id, jsonb_agg(entry order by pos, sub) as list from firsts group by place, id) y;

  update divisions d
     set tiebreakers = expanded -> ('divisions.tiebreakers ' || d.id)
   where expanded ? ('divisions.tiebreakers ' || d.id);
  get diagnostics changed = row_count;
  select coalesce(string_agg(split_part(k, ' ', 2), ',' order by k), '') into changed_ids
    from jsonb_object_keys(expanded) as k where k like 'divisions.tiebreakers %';
  raise notice 'W2 tie-break preset names: divisions.tiebreakers expanded=% ids=%', changed, changed_ids;

  update divisions d
     set config = jsonb_set(d.config, '{tiebreakers}', expanded -> ('divisions.config.tiebreakers ' || d.id))
   where expanded ? ('divisions.config.tiebreakers ' || d.id);
  get diagnostics changed = row_count;
  select coalesce(string_agg(split_part(k, ' ', 2), ',' order by k), '') into changed_ids
    from jsonb_object_keys(expanded) as k where k like 'divisions.config.tiebreakers %';
  raise notice 'W2 tie-break preset names: divisions.config.tiebreakers expanded=% ids=%', changed, changed_ids;

  update stages s
     set config = jsonb_set(s.config, '{tiebreakers}', expanded -> ('stages.config.tiebreakers ' || s.id))
   where expanded ? ('stages.config.tiebreakers ' || s.id);
  get diagnostics changed = row_count;
  select coalesce(string_agg(split_part(k, ' ', 2), ',' order by k), '') into changed_ids
    from jsonb_object_keys(expanded) as k where k like 'stages.config.tiebreakers %';
  raise notice 'W2 tie-break preset names: stages.config.tiebreakers expanded=% ids=%', changed, changed_ids;

  update stages s
     set table_rules_pinned = jsonb_set(s.table_rules_pinned, '{tiebreakers}', expanded -> ('stages.table_rules_pinned.tiebreakers ' || s.id))
   where expanded ? ('stages.table_rules_pinned.tiebreakers ' || s.id);
  get diagnostics changed = row_count;
  select coalesce(string_agg(split_part(k, ' ', 2), ',' order by k), '') into changed_ids
    from jsonb_object_keys(expanded) as k where k like 'stages.table_rules_pinned.tiebreakers %';
  raise notice 'W2 tie-break preset names: stages.table_rules_pinned.tiebreakers expanded=% ids=%', changed, changed_ids;

  -- ═══ 2. Fail loud: every list the read path reads, every sport, as it stands after step 1 ═══
  with
  -- `read`: the standings read reads this place. `may_be_empty`: the place's reader takes `[]`.
  lists (place, id, sport, list, read, may_be_empty) as (
    select 'divisions.tiebreakers', d.id, d.sport_key, d.tiebreakers, true, false
      from divisions d
     where nullif(d.tiebreakers, 'null'::jsonb) is not null
    union all
    select 'divisions.config.tiebreakers', d.id, d.sport_key, d.config -> 'tiebreakers', false, false
      from divisions d
     where nullif(d.config -> 'tiebreakers', 'null'::jsonb) is not null
    union all
    select 'stages.config.tiebreakers', s.id, d.sport_key, s.config -> 'tiebreakers', true, false
      from stages s join divisions d on d.id = s.division_id
     where nullif(s.config -> 'tiebreakers', 'null'::jsonb) is not null
    union all
    select 'stages.config.crossGroupTiebreakers', s.id, d.sport_key, s.config -> 'crossGroupTiebreakers', true, false
      from stages s join divisions d on d.id = s.division_id
     where nullif(s.config -> 'crossGroupTiebreakers', 'null'::jsonb) is not null
    union all
    -- a pin is read whole: an absent or null list in it is refused, not inherited
    select 'stages.table_rules_pinned.tiebreakers', s.id, d.sport_key, s.table_rules_pinned -> 'tiebreakers', true, false
      from stages s join divisions d on d.id = s.division_id
     where s.table_rules_pinned is not null
    union all
    select 'stages.table_rules_pinned.crossGroup', s.id, d.sport_key, s.table_rules_pinned -> 'crossGroup', true, true
      from stages s join divisions d on d.id = s.division_id
     where s.table_rules_pinned is not null
  ),
  refusals (place, id, sport, read, pos, entry, why) as (
    select place, id, sport, read, 0::bigint, coalesce(left(list::text, 80), 'absent'), 'not a list'
      from lists
     where jsonb_typeof(list) is distinct from 'array'
    union all
    select place, id, sport, read, 0::bigint, '[]', 'empty'
      from lists
     where jsonb_typeof(list) = 'array' and jsonb_array_length(list) = 0 and not may_be_empty
    union all
    select l.place, l.id, l.sport, l.read, t.pos, left(t.entry::text, 80),
           case when jsonb_typeof(t.entry) <> 'string' then 'not a string'
                when not ((t.entry #>> '{}') = any (tiebreak_keys)) then 'not a tie-break key'
                else 'a modifier not directly after a head-to-head block' end
      from lists l
     cross join lateral jsonb_array_elements(case when jsonb_typeof(l.list) = 'array' then l.list else '[]'::jsonb end)
           with ordinality as t (entry, pos)
     where jsonb_typeof(t.entry) <> 'string'
        or not ((t.entry #>> '{}') = any (tiebreak_keys))
        or ((t.entry #>> '{}') = any (modifier_keys)
            -- `->` takes a negative index from the END, so the first entry is asked by position, never by index -1
            and (t.pos = 1 or not coalesce((l.list -> (t.pos::integer - 2)) #>> '{}' = any (block_keys), false)))
  )
  select (select jsonb_object_agg(place, n) from (select place, count(*) as n from lists group by place) c),
         (select count(*)::integer from refusals where read),
         (select string_agg(format('place=%s id=%s sport=%s entry=%s why=%s', place, id, sport, entry, why), '; '
                            order by place, id::text, pos)
            from refusals where read),
         (select string_agg(format('id=%s sport=%s entry=%s why=%s', id, sport, entry, why), '; ' order by id::text, pos)
            from refusals where not read)
    into checked_counts, refused_count, refused_list, unread_list;
  checked_counts := coalesce(checked_counts, '{}'::jsonb);
  if refused_count > 0 then
    raise exception 'W2 stored tie-break lists the standings read refuses: count=% %', refused_count, refused_list
      using hint = 'Give each list named only tie-break keys (TiebreakerKeyS), at least one, each block modifier directly '
                || 'after a head-to-head key; or set a division''s or a stage''s own order to null to inherit. A pin '
                || '(stages.table_rules_pinned) is what a started stage ranks by: agree its correction with the owner. '
                || 'Then run the migration again (W2 release, D18).';
  end if;
  if unread_list is not null then
    raise notice 'W2 tie-break census: divisions.config.tiebreakers is read by nothing; lists there the read would refuse: %',
      unread_list;
  end if;
  raise notice 'W2 tie-break census: checked=% divisions.tiebreakers=% divisions.config.tiebreakers=% '
               'stages.config.tiebreakers=% stages.config.crossGroupTiebreakers=% '
               'stages.table_rules_pinned.tiebreakers=% stages.table_rules_pinned.crossGroup=% refused=0',
    (select coalesce(sum(value::integer), 0) from jsonb_each_text(checked_counts)),
    coalesce(checked_counts ->> 'divisions.tiebreakers', '0'),
    coalesce(checked_counts ->> 'divisions.config.tiebreakers', '0'),
    coalesce(checked_counts ->> 'stages.config.tiebreakers', '0'),
    coalesce(checked_counts ->> 'stages.config.crossGroupTiebreakers', '0'),
    coalesce(checked_counts ->> 'stages.table_rules_pinned.tiebreakers', '0'),
    coalesce(checked_counts ->> 'stages.table_rules_pinned.crossGroup', '0');
end $$;
