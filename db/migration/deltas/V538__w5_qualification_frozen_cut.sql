-- V538 — W5 (format matrix: round robin) app PR B Task 6 (rules X-QS-1, X-QS-2; rulebook RB5-T1..T4, RB5-T14; owner ruling 283;
-- ST-G17; preflight K25): a finished league, group or Swiss table keeps its cut line, frozen as "Qualified" / "Out" from who
-- actually went through. VIEW-ONLY: no table, no column, no data moves.
--
-- `stage_qualification_meta` (V414, rebuilt by V475) gains two columns, appended in this order, and `public_stages_v` publishes
-- them after V475's twelve (the view is dropped and re-created with it, as V475 did; its grant is V239's):
--
-- * `qualify_best_nth` — the cut's destination ALSO takes best-Nth seats beside its per-group cut (a groups → knockout with "top
--   two of each group and the best third"). V475's forecast returned no cut at all for that shape (any `bestNth` rule failed its
--   every-rule check), so the commonest unequal-pool format had no cut line and, once complete, no frozen markers (K25). Now the
--   cut is the per-group quota (`qualify_count` = n, `qualify_per_group`) and this flag says it is not the whole story: the live
--   race cannot be placed per pool (a best third may still go through), so the app shows no live statuses on such a table and
--   reads its frozen markers from `qualified` alone (apps/web/src/server/public-site/qualification-view.ts). Only into the cut's
--   OWN destination, only beside a `topNPerGroup` cut, and only for an nth below the quota (`nth > n`, `count >= 1`): a best-Nth
--   take into any other destination still blocks the cut, exactly as before.
-- * `qualified` — who went through from this stage into the cut's destination: the newest CONFIRMED seed proposal's qualifiers
--   drawn from this stage (a `timing: "setup"` destination), else the destination's stored `config.qualified` (an `on_complete`
--   one, written by `seedNextStage`), else null. A draft is no one's verdict, so it is never read. A jsonb array of entrant ids;
--   the confirmed proposal's in seat order, `config.qualified` in its stored order. Public data already: the destination's
--   bracket names the same entrants once seated.
--
-- Every other column, guard and grant is V475's, verbatim, in V537's plpgsql form (`rows 1`, `#variable_conflict use_column`:
-- its plan-cache reason holds for the new body too). The signature changes (two OUT columns), so the function and the view are
-- dropped and re-created rather than replaced, as V475 did.

drop view public_stages_v;
drop function stage_qualification_meta(uuid);

create or replace function stage_qualification_meta(p_stage_id uuid)
returns table (
  qualify_count int,
  qualify_per_group boolean,
  next_stage_name text,
  swiss_rounds int,
  points_rule jsonb,
  has_rank_overrides boolean,
  qualify_best_nth boolean,
  qualified jsonb
)
  language plpgsql stable security definer
  rows 1
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
#variable_conflict use_column
begin
  return query
  with src as (
    select s.id, s.division_id, s.seq, s.kind, s.config,
           s.config -> 'points' as points,
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
           -- V538: a best-Nth take's place and seat count (`{ kind: "bestNth", nth, count }`)
           case when jsonb_typeof(r.value -> 'nth') = 'number' and (r.value ->> 'nth') ~ '^[0-9]{1,6}$'
                then (r.value ->> 'nth')::int end as nth_n,
           case when jsonb_typeof(r.value -> 'count') = 'number' and (r.value ->> 'count') ~ '^[0-9]{1,6}$'
                then (r.value ->> 'count')::int end as count_n,
           count(*) over (partition by d.id) as dest_rules,
           count(*) filter (where r.value ->> 'kind' = 'bestNth') over (partition by d.id) as dest_best_nth
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
           c.dest_name as next_stage_name,
           c.dest_best_nth > 0 as qualify_best_nth,
           c.dest_id
    from cut c
    where (select count(*) from cut) = 1
      -- the cut is its destination's only rule - or (V538, K25) a per-group cut whose other rules are all best-Nth takes
      and (c.dest_rules = 1 or (c.kind = 'topNPerGroup' and c.dest_rules = 1 + c.dest_best_nth))
      and not exists (
        select 1 from rules w
        where not coalesce(
          (w.kind = 'rankRange' and w.from_n >= 1 and w.to_n >= w.from_n)
          or (w.kind = 'topNPerGroup' and w.n_n >= 1)
          -- V538 (K25): a best-Nth take, only into the cut's own destination, beside its per-group cut, below its quota
          or (w.kind = 'bestNth' and w.dest_id = c.dest_id and c.kind = 'topNPerGroup'
              and w.nth_n > c.n_n and w.count_n >= 1),
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
  ),
  -- V538: who went through - the destination's newest confirmed proposal (its qualifiers drawn from THIS stage), else its stored
  -- `config.qualified`. Read only for a stage that has a cut (`forecast`), into the cut's own destination.
  confirmed as (
    select p.computed
    from forecast f
    join stage_seed_proposals p on p.stage_id = f.dest_id and p.status = 'confirmed'
    order by p.created_at desc, p.id desc
    limit 1
  ),
  went as (
    select coalesce(
      (select jsonb_agg(q.value -> 'entrantId'
                        order by case when jsonb_typeof(q.value -> 'rank') = 'number' then (q.value ->> 'rank')::numeric end,
                                 q.ord)
         from confirmed cp
         cross join lateral jsonb_array_elements(
           case when jsonb_typeof(cp.computed -> 'qualifiers') = 'array' then cp.computed -> 'qualifiers'
                else '[]'::jsonb end
         ) with ordinality as q(value, ord)
        where jsonb_typeof(q.value -> 'entrantId') = 'string'
          and q.value #>> '{source,stageId}' = p_stage_id::text),
      (select jsonb_agg(e.value order by e.ord)
         from forecast f
         join stages d on d.id = f.dest_id
         cross join lateral jsonb_array_elements(
           case when jsonb_typeof(d.config -> 'qualified') = 'array' then d.config -> 'qualified'
                else '[]'::jsonb end
         ) with ordinality as e(value, ord)
        where jsonb_typeof(e.value) = 'string')
    ) as qualified
  )
  select f.qualify_count,
         coalesce(f.qualify_per_group, false),
         f.next_stage_name,
         case when src.kind = 'swiss'
                   and jsonb_typeof(src.config -> 'rounds') = 'number'
                   and (src.config ->> 'rounds') ~ '^[0-9]{1,6}$'
              then (src.config ->> 'rounds')::int end,
         stage_points_rule_published(src.points),
         coalesce(jsonb_typeof(src.config -> 'rank_overrides') = 'array'
                  and src.config -> 'rank_overrides' <> '[]'::jsonb, false),
         coalesce(f.qualify_best_nth, false),
         case when f.qualify_count is not null then (select w.qualified from went w) end
  from src
  left join forecast f on not src.feeds_by_result;
end
$$;

revoke all on function stage_qualification_meta(uuid) from public;
grant execute on function stage_qualification_meta(uuid) to app_user;

-- V475's columns in V475's order, then V538's two. The visibility gate is copied verbatim from V233; the grant is V239's.
create view public_stages_v as
  select st.id, st.division_id, st.seq, st.kind, st.name, st.status,
         q.qualify_count, q.qualify_per_group, q.next_stage_name, q.swiss_rounds, q.points_rule,
         q.has_rank_overrides, q.qualify_best_nth, q.qualified
  from stages st
  join divisions d    on d.id = st.division_id
  join competitions c on c.id = d.competition_id
  cross join lateral stage_qualification_meta(st.id) q
  where c.visibility in ('public','unlisted');

grant select on public_stages_v to app_user;
