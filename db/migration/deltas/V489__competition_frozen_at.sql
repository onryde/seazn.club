-- competition_frozen_at — the billing freeze is CHOSEN ONCE and kept (Match Day PB2 review C1; owner ruling 2026-11-02,
-- option A: "lock in the frozen set when the org goes over its limit"). Flyway runs with outOfOrder=false, so the version
-- number must rise in MERGE order: it is assigned at merge (main's max + 1 if needed), and nothing else in the repo names it —
-- tests and code find this file by `V*__competition_frozen_at.sql`.
--
-- ── Why ──
-- An organisation over its plan's `competitions.max_active` keeps its newest-active competitions running and freezes the rest
-- (`entitlement-freeze.ts`). The set used to be recomputed on every read, ranked by each competition's last score event. Once a
-- frozen competition may score (Match Day PB2, owner 2026-11-02, "apply rec"), one point on it made it the most recently
-- active: it thawed, and an idle competition nobody touched froze in its place. Every later point could rotate it again.
--
-- ── What changes ──
-- `competitions.frozen_at`: when this competition was frozen; null when it is not. The app now CHOOSES the set once, at the
-- first read that finds the organisation running more competitions than its limit (the least recently active of the running
-- ones freeze, as before), and stores it. From then on the set moves only when ROOM appears or the overflow GROWS:
--  * room — a running competition archived, completed or deleted, an Event Pass bought, a plan upgrade or a staff override:
--    the frozen competitions thaw, most recently active first, until the running ones fill the limit again;
--  * overflow — a competition joins the active set over the limit (a pass ending, a downgrade): the least recently active of
--    the RUNNING ones freezes, the already-frozen stay frozen.
-- Scoring, a withdrawal cascade or an imported result never moves it: activity is read only when the set must grow or shrink.
-- A competition that leaves the active set (archived, completed, passed) loses its mark: it is no longer frozen, it is gone
-- from the count.
--
-- ── The LOUD data move: the competitions frozen TODAY ──
-- Without a backfill the app would choose each over-quota organisation's set at its first read after the deploy. That is the
-- same choice the old read made, but a point scored in between could still move it (the C1 defect, once). So this migration
-- stores today's set now, BEFORE the deploy, with the old read's own rule, and counts what it stored (`raise notice`).
-- Nothing scores a frozen competition before this runs: the release that lets it ships with this migration.
--
-- The limit is the app's resolver (`getLimit(org, 'competitions.max_active')`, lib/entitlements.ts) restated for this one
-- read, arm for arm, and its parity is a test (`competition-freeze-backfill.test.ts` runs THIS statement against seeded
-- organisations in each billing state and compares it with the app's own selector):
--   base  = a live override's int_value when one exists (a null int there is UNLIMITED), else the resolved plan's
--           `plan_entitlements` int_value (a plan without the row is 0); null base = unlimited, nothing freezes;
--   plan  = `orgPlanKey`'s CASE (suspended org, lapsed comp, 14-day dunning, missed trial end, incomplete, cancelled);
--   bonus = the wallet's counting add-ons for the key (`active`, `granted`), group-wide or targeted at this org.
-- The candidates are `liveUnpassedCompetition`'s (draft, published or live, no Event Pass applying), ranked as
-- `loadCandidates` + `selectFrozen` rank them: last activity (latest score event, else creation) newest first, id ascending.
-- Runs as the migrating role, which bypasses RLS (V432, V438, V481).
--
-- ── NOT SAFE TO RE-RUN BY HAND ──
-- Flyway runs this once. Re-running the whole file aborts at `add column` (no `if not exists`) and changes nothing, but the
-- `do` block run ALONE is not: it re-stamps `frozen_at` on competitions already marked and can mark competitions the app has
-- since chosen to keep running (more than the overflow). Never paste the block into a console. If marks are ever wrong, the
-- app's next read for that organisation trims them back to the overflow (`reconcileFrozen` thaws the excess).

alter table competitions add column frozen_at timestamptz null;

-- Serves the reads of the marks: an UNLIMITED organisation's one-statement check ("is anything of it still marked?", no
-- transaction) and the reconcile's. The limited common case does NOT read this index alone — `frozenCompetitionIds` counts
-- every competition of the organisation in the same statement, so there the index is not the whole read.
create index competitions_frozen_idx on competitions (org_id) where frozen_at is not null;

do $$
declare
  frozen_count int;
  org_count int;
begin
  with plan as (
    select o.id as org_id,
           coalesce(o.subscription_id, o.id)::text as wallet_id,
           case
             when o.status = 'suspended' then 'community'
             when s.comped_until is not null and s.comped_until <= now()
                  and (s.stripe_subscription_id is null
                       or coalesce(s.status, '') not in ('trialing', 'active', 'past_due', 'incomplete'))
                  then 'community'
             when s.status = 'past_due'
                  and coalesce(s.status_changed_at, s.updated_at) <= now() - interval '14 days'
                  then 'community'
             when s.status = 'trialing'
                  and s.trial_end is not null
                  and s.trial_end <= now() - interval '1 day'
                  then 'community'
             when s.status = 'incomplete' then 'community'
             when s.status = 'canceled' and s.comped_at is null then 'community'
             else coalesce(s.plan_key, 'community')
           end as plan_key
      from organizations o
      left join subscriptions s on s.id = o.subscription_id
  ),
  lim as (
    select p.org_id,
           case
             when ov.org_id is not null then ov.int_value
             else coalesce(pe.int_value, case when pe.plan_key is null then 0 end)
           end as base,
           (select coalesce(sum(a.delta_each * a.qty), 0)::int
              from org_addons a
             where a.wallet_id = p.wallet_id
               and a.feature_key = 'competitions.max_active'
               and a.status in ('active', 'granted')
               and (a.target_org_id is null or a.target_org_id = p.org_id::text)
               and a.target_competition_id is null) as bonus
      from plan p
      left join org_entitlement_overrides ov
        on ov.org_id = p.org_id and ov.feature_key = 'competitions.max_active'
       and (ov.expires_at is null or ov.expires_at > now())
      left join plan_entitlements pe
        on pe.plan_key = p.plan_key and pe.feature_key = 'competitions.max_active'
  ),
  ranked as (
    select c.id, c.org_id,
           row_number() over (
             partition by c.org_id
             -- Milliseconds, as the app compares them (`selectFrozen` reads a JS Date); a uuid orders as its hex text does.
             order by date_trunc('milliseconds', greatest(c.created_at, coalesce(max(e.recorded_at), c.created_at))) desc, c.id asc
           ) as rn
      from competitions c
      left join divisions d on d.competition_id = c.id
      left join fixtures f on f.division_id = d.id
      left join score_events e on e.fixture_id = f.id
     where c.status in ('draft', 'published', 'live')
       and not exists (
         select 1 from competition_passes cp
          where cp.competition_id = c.id
            and pass_applies(c.status, c.ends_on, (now() at time zone 'utc')::date))
     group by c.id, c.org_id, c.created_at
  ),
  chosen as (
    select r.id, r.org_id
      from ranked r
      join lim l on l.org_id = r.org_id
     where l.base is not null
       and r.rn > l.base + l.bonus
  ),
  stamped as (
    update competitions c
       set frozen_at = now()
      from chosen ch
     where c.id = ch.id
    returning c.id, c.org_id
  )
  select count(*)::int, count(distinct org_id)::int into frozen_count, org_count from stamped;
  raise notice 'competition_frozen_at: competitions frozen today, stored: competitions=% organisations=%', frozen_count, org_count;
end $$;
