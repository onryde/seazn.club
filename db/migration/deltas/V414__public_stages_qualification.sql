-- V414 — standings qualification status (spec
-- docs/superpowers/specs/2026-09-22-standings-qualification-status-design.md
-- §4.1; plan Task 4). The public standings table shows whether a place in the
-- next stage is won, open or lost, which needs the CUT: how many places go
-- through, per pool or overall, and to which stage. The cut is declared on the
-- DESTINATION stage's `progression`; this derives it once, here, for BOTH
-- readers — `public_stages_v` below (division page, hub, embed) and the
-- organiser console (usecases/stage-qualification.ts), so the two can never
-- disagree (spec §4.2 "do not fork the calculation").
--
-- A status must never be wrong, so anything short of ONE clean cut is no cut
-- (qualify_count null). Forecastable only when, across every destination that
-- names this stage:
--   * EXACTLY ONE take rule is a cut — a `rankRange` from 1 or a
--     `topNPerGroup`. A `rankRange` from > 1 (a plate) is not a cut and does
--     not block one;
--   * that rule is the ONLY rule its destination takes from this stage. Two
--     rules into one stage (1..2 and 3..4, in one source or in two sources
--     that both name this stage) send the top four through, not two;
--   * every rule is a well-formed `rankRange` or `topNPerGroup`. `bestNth`,
--     `picks` and `roundLosers` move who qualifies in ways a points bound
--     cannot see, and anything malformed is doubt;
--   * the stage sends nobody on by RESULT: a non-empty `config.cross_feeds`
--     (Jul3/08 §9) wires a fixture's winner or loser into a destination slot
--     whatever the table says. StageConfig (api-v1/schemas.ts) accepts it on
--     any stage kind, and every generated fixture carries the ext_key that
--     wireCrossFeeds (usecases/stages.ts) matches on, so a table stage can
--     carry one;
--   * the cut's destination takes nobody else by RESULT: if ANY stage in the
--     division has a `cross_feeds` entry whose `to_stage_seq` is the
--     destination's seq, a fed seat can take a place the ranking would have
--     filled (controller ruling, R3 "when in doubt, null"). The match is jsonb
--     number equality, the same thing wireCrossFeeds' `bySeq.get` sees.
-- `"previous"` means the same-division stage with the largest seq below the
-- destination's (usecases/stage-seeding.ts resolveProgressionSource).
--
-- Every jsonb number is read through a guard (`jsonb_typeof = 'number'` plus a
-- digits-only match) inside CASE, and a `take` that is not an array reads as a
-- malformed rule: the view feeds three public pages, and one bad value must
-- cost that stage its cut, not 500 all three (spec-review F4). A `sources`
-- that is not an array (final review M1) is read as no sources: which stage
-- it names cannot be read, so it can add no rule, and the engine cannot parse
-- that progression either, so its destination seeds nobody from it.
--
-- SECURITY DEFINER with a pinned search_path, like org_has_feature (V344). A
-- function called from a view runs as the CALLER. The public pages read
-- through the pooled `sql` client, which connects as the owning role
-- (apps/web/src/lib/db.ts), so for them DEFINER changes nothing. It matters
-- for `app_user` callers — withTenant transactions, such as the organiser
-- console (Task 9): `stages` is FORCE row-level secured, so a caller-rights
-- function would see only the caller tenant's rows (none with no tenant set)
-- and report "no cut" instead of failing. It returns only derived facts; raw
-- `progression` and the rest of `config` stay private. Execute is revoked
-- from PUBLIC and granted to app_user, the role V239 grants the public views
-- to.
--
-- `swiss_rounds` and `points_rule` ride along so both readers get every input
-- from one row. Without `points_rule` a custom-points stage would be forecast
-- with the sport's points and could be wrong (plan P4). It is the stage's own
-- PointsRule (`config.points`), REBUILT from only the keys PointsRule reads —
-- base.{win,draw,loss}, bonuses[].{when,param,points} and
-- forfeit.{winnerPoints,loserPoints,awardScore}. createStages stores the raw
-- config (it parses only to validate), and PointsRule is a non-strict
-- z.object at every level, so an organiser's stray keys can sit beside it and
-- must not reach a public page. A key that is absent stays absent
-- (jsonb_strip_nulls): PointsRule rejects `param: null`. The values themselves
-- are not sensitive, since the table already prints the points they produce.
--
-- `has_rank_overrides` (controller ruling M1): the engine sets `rankLocked` on
-- EVERY tie it settles by lots (competition/tiebreakers.ts), so a status guard
-- keyed on `rankLocked` would hide the status on ordinary tables. The ranks an
-- ORGANISER pinned — overrideStandings, or a placement game's result — live on
-- `stages.config.rank_overrides`, and the engine applies them exactly when that
-- is a non-empty array (engine-db/competition.ts toTableStage).

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
           'base', case when jsonb_typeof(src.config #> '{points,base}') = 'object' then jsonb_build_object(
                     'win',  src.config #> '{points,base,win}',
                     'draw', src.config #> '{points,base,draw}',
                     'loss', src.config #> '{points,base,loss}') end,
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

-- Columns APPENDED after V233's six, in order (create or replace view may only
-- add columns at the end). The visibility gate is copied verbatim from V233.
create or replace view public_stages_v as
  select st.id, st.division_id, st.seq, st.kind, st.name, st.status,
         q.qualify_count, q.qualify_per_group, q.next_stage_name, q.swiss_rounds, q.points_rule,
         q.has_rank_overrides
  from stages st
  join divisions d    on d.id = st.division_id
  join competitions c on c.id = d.competition_id
  cross join lateral stage_qualification_meta(st.id) q
  where c.visibility in ('public','unlisted');
