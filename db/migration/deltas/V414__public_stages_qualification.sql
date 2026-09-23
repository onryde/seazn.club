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
--     cannot see, and anything malformed is doubt.
-- `"previous"` means the same-division stage with the largest seq below the
-- destination's (usecases/stage-seeding.ts resolveProgressionSource).
--
-- Every jsonb number is read through a guard (`jsonb_typeof = 'number'` plus a
-- digits-only match) inside CASE, and a `take` that is not an array reads as a
-- malformed rule: the view feeds three public pages, and one bad value must
-- cost that stage its cut, not 500 all three (spec-review F4).
--
-- SECURITY DEFINER with a pinned search_path, like org_has_feature (V344): a
-- function called from a view runs as the CALLER, `stages` is FORCE row-level
-- secured, and the public read path has no tenant set — as the caller, the
-- function would see no destination and report "no cut" everywhere. It
-- returns only derived facts; raw `progression` and the rest of `config` stay
-- private. Execute is revoked from PUBLIC and granted to app_user, the role
-- V239 grants the public views to.
--
-- `swiss_rounds` and `points_rule` ride along so both readers get every input
-- from one row. `points_rule` is the stage's own PointsRule (`config.points`,
-- not sensitive: the table already prints the points it produces). Without it
-- a custom-points stage would be forecast with the sport's points and could be
-- wrong (plan P4).
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
    select s.id, s.division_id, s.seq, s.kind, s.config from stages s where s.id = p_stage_id
  ),
  rules as (
    select d.id as dest_id,
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
    cross join lateral jsonb_array_elements(d.progression -> 'sources') as so(value)
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
  )
  select f.qualify_count,
         coalesce(f.qualify_per_group, false),
         f.next_stage_name,
         case when src.kind = 'swiss'
                   and jsonb_typeof(src.config -> 'rounds') = 'number'
                   and (src.config ->> 'rounds') ~ '^[0-9]{1,6}$'
              then (src.config ->> 'rounds')::int end,
         src.config -> 'points',
         coalesce(jsonb_typeof(src.config -> 'rank_overrides') = 'array'
                  and jsonb_array_length(
                        case when jsonb_typeof(src.config -> 'rank_overrides') = 'array'
                             then src.config -> 'rank_overrides' else '[]'::jsonb end) > 0,
                  false)
  from src
  left join forecast f on true
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
