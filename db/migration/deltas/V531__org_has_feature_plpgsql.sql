-- V531 — the per-request resolvers move from LANGUAGE sql to LANGUAGE plpgsql,
-- for its plan cache. Nothing they answer changes. Plus two lints the same
-- measurement turned up: the realtime policies' per-row topic() and the
-- billing_events replay sweep's seq scan.
--
-- Measured 2026-11-18 (prod: pg_stat_statements + EXPLAIN ANALYZE; stg
-- read-only). A SECURITY DEFINER SQL function is never inlined, and its body is
-- planned again on every top-level statement that calls it:
--   * org_has_feature: one call on a one-org database cost 5.6 ms and 859
--     shared buffer hits, nearly all catalog reads and planning, not data. The
--     public read models make that call per request (public_entrants_v's
--     `cross join lateral (select org_has_feature(...) offset 0)`,
--     public_competitions_v, public_discovery_v, the realtime and org-settings
--     selects): 21.5 ms of a 26 ms public_entrants_v read.
--   * stage_qualification_meta: ~19 ms / 140 buffers per call, and
--     public_stages_v calls it once per stage row, so a 3-stage division paid
--     57 of 68 ms; the stages query is 130 ms mean on stg.
-- PL/pgSQL prepares each query once per session and reuses the plan; that is
-- the whole change.
--
-- What is deliberately identical, because CREATE OR REPLACE replaces every
-- attribute it is given and keeps only owner and ACL (so V475's revoke-from-
-- public / grant-to-app_user on stage_qualification_meta stands):
--   * signatures, parameter and OUT-column names and order, return types — the
--     views bind the functions by OID and their columns by name, so no view is
--     reissued;
--   * STABLE, SECURITY DEFINER, not STRICT (a null p_competition_id is the
--     org-level question, and must reach the body);
--   * `set search_path = ${flyway:defaultSchema}, pg_temp` — V306's header says
--     why each element is load-bearing; dropping the clause would let a temp
--     table shadow a real one inside a definer function;
--   * the bodies: the latest definers' queries verbatim, comments aside —
--     org_has_feature from V344 (chain V228, V306, V313, V314, V328, V332,
--     V334, V338, V343, V344), its 2-arg wrapper from V306,
--     stage_qualification_meta from V475 (chain V414, V475).
--   * name resolution: `#variable_conflict use_column`. In a SQL function a
--     column always beats a parameter of the same name, and OUT columns are not
--     in scope at all; in plpgsql both are variables, and the default
--     (`error`) would turn any future same-named column into a runtime error.
--     use_column is the SQL function's rule, so the bodies resolve every name
--     the way they did.
-- One planner hint changes on purpose: stage_qualification_meta declares
-- `rows 1` (it returns exactly one row for a stage, none for a missing one)
-- instead of the SRF default of 1000, so public_stages_v's lateral join is
-- costed as what it is.
--
-- The parity suites are the behavioural tie (entitlements-sql-parity,
-- pass-under-paid-plan, entitlements-v18-*, public-stages-qualification-db,
-- stage-qualification-db); apps/web/src/lib/__tests__/resolvers-plpgsql.test.ts pins
-- the catalog shape, the bodies against their sources, the policies and the
-- index.

create or replace function org_has_feature(
  p_org_id uuid,
  p_feature_key text,
  p_competition_id uuid
) returns boolean
  language plpgsql stable security definer
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
#variable_conflict use_column
begin
  return (
    with plan as (
      select case
        -- MODERATION, not billing (mirrors entitlements.ts): a suspended ORG
        -- resolves community whatever its group pays for, scoped to that one org
        -- so a moderator cannot degrade siblings that merely share a payer.
        when o.status = 'suspended' then 'community'
        when s.comped_until is not null and s.comped_until <= now()
             and (s.stripe_subscription_id is null
                  or coalesce(s.status, '') not in
                     ('trialing', 'active', 'past_due'))
             then 'community'
        when s.status = 'past_due'
             and coalesce(s.status_changed_at, s.updated_at) <= now() - interval '14 days'
             then 'community'
        -- Trial-end backstop: a trialing sub whose trial ended over a day ago is a
        -- MISSED transition webhook (Stripe moves trialing→active/past_due/canceled at
        -- trial_end). The resolver stops trusting the stale status, cron-free, the same
        -- way the past_due arm above does. 1-day grace absorbs Stripe's transition lag.
        -- trial_end IS null on a never-trialed sub → guard it so those stay on plan.
        when s.status = 'trialing'
             and s.trial_end is not null
             and s.trial_end <= now() - interval '1 day'
             then 'community'
        -- v17 #287/#288: a never-paid first invoice conveys NO plan (mirrors
        -- entitlements.ts's orgPlanKey). Must NOT inherit the past_due grace
        -- above, which is for a renewal that failed on a subscription that WAS
        -- active; 'incomplete' never was.
        when s.status = 'incomplete' then 'community'
        -- A CANCELLED subscription does not convey its plan (V313). The
        -- comped_at guard keeps an INDEFINITE staff comp alive; a lapsed comp is
        -- already community via the comped_until arm above.
        when s.status = 'canceled' and s.comped_at is null
             then 'community'
        else coalesce(s.plan_key, 'community')
      end as plan_key
      from organizations o
      left join subscriptions s on s.id = o.subscription_id
      where o.id = p_org_id
    )
    select coalesce(
      (select bool_value from org_entitlement_overrides
        where org_id = p_org_id and feature_key = p_feature_key
          and (expires_at is null or expires_at > now())),
      -- Event Pass: competition in scope, ANY plan (V344). A key absent from the
      -- pass matrix falls through to the plan row rather than denying, and so
      -- does a key the pass answers FALSE: `and pe.bool_value` makes this arm
      -- grant-only, so a pass can never take a Pro feature away. v17 SPEC-4 §7:
      -- the pass stops applying once its competition is archived or long-ended
      -- (mirrors isPassLocked in lib/entitlements.ts). The grace boundary is the
      -- UTC calendar date (V334), matching isPassLocked's Date.UTC(getUTC*) —
      -- NOT the session-TZ `current_date`.
      (select pe.bool_value
         from competition_passes cp
         join competitions c on c.id = cp.competition_id
         join plan_entitlements pe
           on pe.plan_key = cp.pass_key and pe.feature_key = p_feature_key
        where p_competition_id is not null
          and cp.competition_id = p_competition_id
          and cp.org_id = p_org_id
          and pe.bool_value
          and pass_applies(c.status, c.ends_on, (now() at time zone 'utc')::date)),
      (select pe.bool_value from plan_entitlements pe
        where pe.feature_key = p_feature_key
          and pe.plan_key = (select plan_key from plan)),
      false)
  );
end
$$;

-- The 2-arg form stays a thin delegating wrapper (V306), still called by
-- public_competitions_v, server/public-site/data.ts and sponsors/invoice-doc.ts.
-- As LANGUAGE sql it re-plans its own one-line body on every statement and then
-- makes a fresh, plan-less call into the 3-arg form; as plpgsql the call is a
-- cached simple expression and the 3-arg form's session plan is reused.
create or replace function org_has_feature(p_org_id uuid, p_feature_key text)
  returns boolean
  language plpgsql stable security definer
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
#variable_conflict use_column
begin
  return org_has_feature(p_org_id, p_feature_key, null::uuid);
end
$$;

-- V475's function verbatim (V414's, but for the rule it publishes), as plpgsql.
-- Its readers: public_stages_v (division page, hub, embed — one call per stage
-- row) and the organiser console (usecases/stage-qualification.ts).
create or replace function stage_qualification_meta(p_stage_id uuid)
returns table (
  qualify_count int,
  qualify_per_group boolean,
  next_stage_name text,
  swiss_rounds int,
  points_rule jsonb,
  has_rank_overrides boolean
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
         stage_points_rule_published(src.points),
         coalesce(jsonb_typeof(src.config -> 'rank_overrides') = 'array'
                  and src.config -> 'rank_overrides' <> '[]'::jsonb, false)
  from src
  left join forecast f on not src.feeds_by_result;
end
$$;

-- ── billing_events: the replay sweep's index ─────────────────────────────────
--
-- sweepStuckEvents (usecases/billing-events/ledger.ts) asks for the oldest
-- `processed_at is null` rows past a 10-minute floor. billing_events has only
-- its primary key, so every cron tick seq-scans the whole ledger: 127k rows /
-- 136 MB on stg, 5.8 s mean, 20.6 s max — to find the handful of stuck rows.
-- PARTIAL on the sweep's own predicate, keyed on its sort column: the index
-- holds only unprocessed rows (a processed event leaves it the moment its
-- processed_at is written) and is read in received_at order, so `order by
-- received_at limit n` stops after n entries. Its predicate must stay the
-- query's literal `processed_at is null`, or the planner cannot prove the
-- implication and falls back to the scan; the test reads the query out of
-- ledger.ts and EXPLAINs it.
--
-- Plain CREATE INDEX, not CONCURRENTLY: Flyway holds its own transaction open
-- (V413's header, measured). The SHARE lock queues webhook INSERTs for the
-- build — one heap pass — and Stripe's delivery waits rather than fails.
-- `replay_attempts < 4` too: a row the sweep parks (4th failed replay) keeps
-- processed_at null forever, so without it every parked row would sit at the
-- index's oldest end and every tick would read past all of them (stg: all 690
-- unprocessed rows are parked). The sweep states `replay_attempts < 4`
-- literally, so the implication still holds.
create index if not exists billing_events_unprocessed_idx
  on billing_events (received_at)
  where processed_at is null and replay_attempts < 4;

-- ── Realtime Authorization policies: evaluate realtime.topic() once ─────────
--
-- V403's "fixture broadcast read by claim" and V452's "external play lobby
-- read by claim" call realtime.topic() bare, so Postgres evaluates it for every
-- row of realtime.messages (Supabase lint 0003, auth_rls_initplan). Wrapped in
-- a scalar sub-select it becomes an InitPlan, evaluated once per statement.
-- The topic is a per-connection setting, so the value cannot differ between
-- rows of one statement: same answer, one evaluation. The JWT side was already
-- wrapped. Name, command, role, permissiveness and the rest of USING are
-- unchanged.
--
-- Same skip rules as V403/V452: a non-Supabase database has no realtime
-- schema, and Flyway may not own realtime.messages. The drops and the creates
-- sit in ONE exception block, so a privilege failure on any of them rolls all
-- of them back and leaves V403/V452's policies in place — never a database with
-- a drop and without its create, which would refuse every private-channel
-- subscribe.
do $migrate$
begin
  if not exists (select 1 from pg_namespace where nspname = 'realtime') then
    raise notice 'V531: no realtime schema — skip (non-Supabase database)';
    return;
  end if;

  if not exists (
    select 1 from pg_tables
    where schemaname = 'realtime' and tablename = 'messages'
  ) then
    raise notice 'V531: realtime.messages missing — skip';
    return;
  end if;

  begin
    execute $sql$
      drop policy if exists "fixture broadcast read by claim" on realtime.messages
    $sql$;
    execute $sql$
      create policy "fixture broadcast read by claim"
      on realtime.messages
      for select
      to authenticated
      using (
        extension = 'broadcast'
        and (select realtime.topic()) = ('fixture:' || (select auth.jwt() ->> 'fixture_id'))
      )
    $sql$;

    execute $sql$
      drop policy if exists "external play lobby read by claim" on realtime.messages
    $sql$;
    execute $sql$
      create policy "external play lobby read by claim"
      on realtime.messages
      for select
      to authenticated
      using (
        extension = 'broadcast'
        and (select realtime.topic()) = ('external-play:' || (select auth.jwt() ->> 'lobby_fixture_id'))
      )
    $sql$;
  exception
    when insufficient_privilege then
      raise notice 'V531: insufficient privilege on realtime.messages — skip (not owner)';
  end;
end
$migrate$;
