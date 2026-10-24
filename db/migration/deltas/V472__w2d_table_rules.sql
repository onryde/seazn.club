-- V472 — W2d (format matrix: tables and tie-breaks), the outcome-keyed stage points rule on the public and console reads.
-- Spec docs/superpowers/specs/2026-10-20-format-matrix-w2d-design.md §5.3; plan
-- docs/superpowers/plans/2026-10-20-format-matrix-w2d.md. W2d Task 2 creates this file; Task 7 (PF-3) AMENDS it (one
-- unmerged migration, not a V473).
--
-- W2d Task 2 replaced the stage PointsRule's W2c `{base, bonuses, forfeit}` shape with the outcome-keyed one: `win` /
-- `loss` by how a match was decided (`regulation`, `ot`, `so`; `loss.unplayed`), `draw`, `soBonus`, `shootoutAs`, `tie`,
-- `noResult`, `bySetScore`, `unit`, `bonuses`, `forfeit` (engine competition/points.ts). `stage_qualification_meta`
-- (V414) rebuilt `points_rule` from the OLD keys only, so a rule saved in the new shape reached both of its readers —
-- `public_stages_v` (division page, hub, embed) and the organiser console (usecases/stage-qualification.ts, which calls
-- the function directly) — as `{bonuses, forfeit}`: no qualification status, no "Points:" clause, no walkover-score
-- clause. The fold was unaffected (it reads `config.points` itself).
--
-- This rebuilds the FUNCTION (the view takes `points_rule` from it by a lateral join, so it follows without a change),
-- with `points_rule` built from BOTH shapes: the legacy `base` (until Task 7 converts the stored rows) and every key the
-- outcome-keyed PointsRule reads. The rest of the function is V414's, verbatim. The same rule as V414 holds at every
-- level: only the keys PointsRule reads, never an organiser's stray keys (PointsRule is a non-strict z.object, and
-- createStages stores the raw config); a key that is absent stays absent (jsonb_strip_nulls); a `bySetScore` key is kept
-- only when it is a set score ("W-L") or "*", the grammar PointsRule accepts. The values themselves are not sensitive:
-- the table already prints the points they produce.

create or replace function stage_qualification_meta(p_stage_id uuid)
returns table (
  qualify_count int,
  qualify_per_group boolean,
  next_stage_name text,
  swiss_rounds int,
  points_rule jsonb,
  has_rank_overrides boolean
)
  language sql stable security definer
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
  with src as (
    select s.id, s.division_id, s.seq, s.kind, s.config,
           coalesce(jsonb_typeof(s.config -> 'cross_feeds') = 'array'
                    and s.config -> 'cross_feeds' <> '[]'::jsonb, false) as feeds_by_result
    from stages s where s.id = p_stage_id
  ),
  rules as (
    select d.id as dest_id,
           d.seq as dest_seq,
           d.name as dest_name,
           r.value ->> 'kind' as kind,
           case when jsonb_typeof(r.value -> 'from') = 'number' and (r.value ->> 'from') ~ '^[0-9]{1,6}$'
                then (r.value ->> 'from')::int end as from_n,
           case when jsonb_typeof(r.value -> 'to') = 'number' and (r.value ->> 'to') ~ '^[0-9]{1,6}$'
                then (r.value ->> 'to')::int end as to_n,
           case when jsonb_typeof(r.value -> 'n') = 'number' and (r.value ->> 'n') ~ '^[0-9]{1,6}$'
                then (r.value ->> 'n')::int end as n_n,
           count(*) over (partition by d.id) as dest_rules
    from src
    join stages d on d.division_id = src.division_id and d.progression is not null
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(d.progression -> 'sources') = 'array' then d.progression -> 'sources'
           else '[]'::jsonb end
    ) as so(value)
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(so.value -> 'take') = 'array' then so.value -> 'take'
           else '[null]'::jsonb end
    ) as r(value)
    where (so.value ->> 'stage' = 'previous'
           and src.seq = (select max(p.seq) from stages p
                          where p.division_id = d.division_id and p.seq < d.seq))
       or (so.value -> 'stage' ->> 'stageId') = src.id::text
  ),
  cut as (
    select * from rules
    where (kind = 'rankRange' and from_n = 1) or kind = 'topNPerGroup'
  ),
  forecast as (
    select case when c.kind = 'rankRange' then c.to_n else c.n_n end as qualify_count,
           c.kind = 'topNPerGroup' as qualify_per_group,
           c.dest_name as next_stage_name
    from cut c
    where (select count(*) from cut) = 1
      and c.dest_rules = 1
      and not exists (
        select 1 from rules w
        where not coalesce(
          (w.kind = 'rankRange' and w.from_n >= 1 and w.to_n >= w.from_n)
          or (w.kind = 'topNPerGroup' and w.n_n >= 1),
          false))
      and not exists (
        select 1
        from stages o
        cross join lateral jsonb_array_elements(
          case when jsonb_typeof(o.config -> 'cross_feeds') = 'array' then o.config -> 'cross_feeds'
               else '[]'::jsonb end
        ) as xf(value)
        where o.division_id = (select s.division_id from src s)
          and xf.value -> 'to_stage_seq' = to_jsonb(c.dest_seq))
  )
  select f.qualify_count,
         coalesce(f.qualify_per_group, false),
         f.next_stage_name,
         case when src.kind = 'swiss'
                   and jsonb_typeof(src.config -> 'rounds') = 'number'
                   and (src.config ->> 'rounds') ~ '^[0-9]{1,6}$'
              then (src.config ->> 'rounds')::int end,
         case when jsonb_typeof(src.config -> 'points') = 'object' then jsonb_strip_nulls(jsonb_build_object(
           -- the W2c shape, until W2d Task 7 converts the stored rows
           'base', case when jsonb_typeof(src.config #> '{points,base}') = 'object' then jsonb_build_object(
                     'win',  src.config #> '{points,base,win}',
                     'draw', src.config #> '{points,base,draw}',
                     'loss', src.config #> '{points,base,loss}') end,
           -- the W2d outcome-keyed shape (engine competition/points.ts PointsRule, spec §5.3)
           'win', case when jsonb_typeof(src.config #> '{points,win}') = 'object' then jsonb_build_object(
                     'regulation', src.config #> '{points,win,regulation}',
                     'ot',         src.config #> '{points,win,ot}',
                     'so',         src.config #> '{points,win,so}') end,
           'loss', case when jsonb_typeof(src.config #> '{points,loss}') = 'object' then jsonb_build_object(
                     'regulation', src.config #> '{points,loss,regulation}',
                     'ot',         src.config #> '{points,loss,ot}',
                     'so',         src.config #> '{points,loss,so}',
                     'unplayed',   src.config #> '{points,loss,unplayed}') end,
           'draw',       src.config #> '{points,draw}',
           'soBonus',    src.config #> '{points,soBonus}',
           'shootoutAs', src.config #> '{points,shootoutAs}',
           'tie',        src.config #> '{points,tie}',
           'noResult',   src.config #> '{points,noResult}',
           'bySetScore', case when jsonb_typeof(src.config #> '{points,bySetScore}') = 'object' then (
                     select jsonb_object_agg(k.key, k.value)
                     from jsonb_each(src.config #> '{points,bySetScore}') as k(key, value)
                     where k.key ~ '^([0-9]+-[0-9]+|[*])$') end,
           'unit',       src.config #> '{points,unit}',
           'bonuses', case when jsonb_typeof(src.config #> '{points,bonuses}') = 'array' then (
                     select coalesce(jsonb_agg(jsonb_build_object(
                              'when',   b.value -> 'when',
                              'param',  b.value -> 'param',
                              'points', b.value -> 'points') order by b.ord), '[]'::jsonb)
                     from jsonb_array_elements(src.config #> '{points,bonuses}') with ordinality as b(value, ord)) end,
           'forfeit', case when jsonb_typeof(src.config #> '{points,forfeit}') = 'object' then jsonb_build_object(
                     'winnerPoints', src.config #> '{points,forfeit,winnerPoints}',
                     'loserPoints',  src.config #> '{points,forfeit,loserPoints}',
                     'awardScore',   src.config #> '{points,forfeit,awardScore}') end)) end,
         coalesce(jsonb_typeof(src.config -> 'rank_overrides') = 'array'
                  and src.config -> 'rank_overrides' <> '[]'::jsonb, false)
  from src
  left join forecast f on not src.feeds_by_result
$$;

revoke all on function stage_qualification_meta(uuid) from public;
grant execute on function stage_qualification_meta(uuid) to app_user;
