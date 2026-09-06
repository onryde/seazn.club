-- Entitlements v18 W2 (owner rulings 2026-09-02/03; design of record
-- docs/superpowers/specs/2026-09-02-entitlements-v18-three-tier-design.md
-- §2/§4/§5): reshape the plan matrix for the three-tier relaunch — retire
-- Pro Plus into a new non-public `enterprise` plan, apply the §2 matrix to
-- community/pro/event_pass/event_pass_l, and drop four keys that are
-- defined and copy-referenced but never read by any hasFeature/getLimit
-- call site.
--
-- Order matters: `subscriptions`, `plan_entitlements` and
-- `competition_passes` all reference `plans(key)` with no cascade, so the
-- new plan is inserted and populated before `pro_plus` rows are repointed
-- and the plan itself is dropped.
--
-- Resolver semantics this migration is written against (measured, not
-- assumed): for an int key only `int_value` is read — a stray `bool_value`
-- on an int row is ignored noise and is left alone throughout. `int_value
-- = NULL` means unlimited; a key with NO ROW resolves to 0 (deny), so
-- deleting an int key denies it rather than freeing it — safe here only
-- because nothing reads the four keys step 4 removes. A bool key requires
-- `bool_value = true` exactly; NULL or no row denies.

-- Step 1: the enterprise plan itself. Never self-serve — no Stripe price
-- ids — granted only through the existing comped-plan path
-- (server/usecases/admin-plan.ts) and per-org overrides.
insert into plans (key, name, is_public)
values ('enterprise', 'Enterprise', false);

-- Step 2: seed enterprise by copying every pro_plus row (its matrix
-- already reads as the design doc's Ent column almost everywhere), then
-- correct the three cells that don't: a staff-negotiated AI credit pool,
-- the 1% fee, and orgs.max_owned, which was pro_plus's own 10-org cap and
-- must become unlimited (NULL) to match Ent's "∞".
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
select 'enterprise', feature_key, bool_value, int_value
  from plan_entitlements
 where plan_key = 'pro_plus';

update plan_entitlements
   set int_value = 500
 where plan_key = 'enterprise' and feature_key = 'ai.credits.monthly';

update plan_entitlements
   set int_value = 1
 where plan_key = 'enterprise' and feature_key = 'registration.fee_percent';

update plan_entitlements
   set int_value = null
 where plan_key = 'enterprise' and feature_key = 'orgs.max_owned';

-- Step 3: apply design doc §2 to community / pro / event_pass /
-- event_pass_l. Every statement below is an UPDATE — each key already has
-- a row on its plan, measured against the live matrix on this branch.

-- community: scale caps down (Free gets smaller, R6/R10), and eight
-- correctness/growth keys go free per the R9 "charge for leverage, never
-- correctness" principle plus the growth-loop ruling (player profiles,
-- embeds, auto posts).
update plan_entitlements set int_value = 3 where plan_key = 'community' and feature_key = 'members.max';
update plan_entitlements set int_value = 2 where plan_key = 'community' and feature_key = 'scorers.max';
update plan_entitlements set int_value = 3 where plan_key = 'community' and feature_key = 'competitions.max_active';
update plan_entitlements set int_value = 3 where plan_key = 'community' and feature_key = 'dashboard.public.max';
update plan_entitlements set int_value = 5 where plan_key = 'community' and feature_key = 'ai.credits.monthly';
update plan_entitlements
   set bool_value = true
 where plan_key = 'community'
   and feature_key in (
     'formats.double_elim', 'standings.custom_points', 'tiebreakers.custom',
     'scheduling.multi_division', 'cricket.dls', 'dashboard.player_profiles',
     'embeds.enabled', 'news.auto'
   );

-- pro: scale caps up (R4/R10, "your whole season"), officials.auto joins
-- (R5).
update plan_entitlements set int_value = 10 where plan_key = 'pro' and feature_key = 'members.max';
update plan_entitlements set int_value = 10 where plan_key = 'pro' and feature_key = 'scorers.max';
update plan_entitlements set int_value = 20 where plan_key = 'pro' and feature_key = 'divisions.per_competition.max';
update plan_entitlements set int_value = 6 where plan_key = 'pro' and feature_key = 'stages.per_division.max';
update plan_entitlements set int_value = 100 where plan_key = 'pro' and feature_key = 'teams.max';
update plan_entitlements set int_value = 40 where plan_key = 'pro' and feature_key = 'teams.squad_max';
update plan_entitlements set int_value = 25 where plan_key = 'pro' and feature_key = 'clubs.max';
update plan_entitlements set int_value = 500 where plan_key = 'pro' and feature_key = 'import.bulk';
update plan_entitlements set int_value = 10 where plan_key = 'pro' and feature_key = 'schedule.checkpoints.max';
update plan_entitlements set int_value = 35 where plan_key = 'pro' and feature_key = 'ai.credits.monthly';
update plan_entitlements set bool_value = true where plan_key = 'pro' and feature_key = 'officials.auto';

-- event_pass / event_pass_l: discipline tracking and auto-posts join both
-- rungs (R11-adjacent owner asks); the L rung also gets its own entrant
-- ceiling.
update plan_entitlements
   set bool_value = true
 where plan_key in ('event_pass', 'event_pass_l')
   and feature_key in ('discipline.enforced', 'news.auto');

update plan_entitlements set int_value = 512 where plan_key = 'event_pass_l' and feature_key = 'entrants.per_division.max';

-- Step 3b: rows that do not exist yet on either pass rung. Most §2 "Pass"
-- column values are already satisfied once step 3 turns the underlying
-- Free row true or non-zero (the pass overlay only needs to add what Free
-- does not already grant); these six keys are the genuinely new grants
-- the pass has to carry itself.
insert into plan_entitlements (plan_key, feature_key, int_value) values
  ('event_pass', 'stages.per_division.max', 4),
  ('event_pass_l', 'stages.per_division.max', 4),
  ('event_pass', 'schedule.checkpoints.max', 5),
  ('event_pass_l', 'schedule.checkpoints.max', 5);

insert into plan_entitlements (plan_key, feature_key, bool_value) values
  ('event_pass', 'officials.auto', true),
  ('event_pass_l', 'officials.auto', true),
  ('event_pass', 'scoring.device_links', true),
  ('event_pass_l', 'scoring.device_links', true),
  ('event_pass', 'scoring.audit_export', true),
  ('event_pass_l', 'scoring.audit_export', true),
  ('event_pass', 'stats.player', true),
  ('event_pass_l', 'stats.player', true);

-- Step 3c: teams.squad_max on both passes was 20 — identical to Free, so
-- the row lifted nothing. Drop the no-op rather than leave dead weight.
delete from plan_entitlements
 where plan_key in ('event_pass', 'event_pass_l') and feature_key = 'teams.squad_max';

-- NOTE: §2 prints "competitions.max_active +1" for both pass rungs, but
-- there is no additive mechanism on int_value and, deliberately, no pass
-- row is created for this key. The effect is already implemented as an
-- exclusion in server/usecases/competitions.ts (assertActiveQuota
-- subtracts passed competitions out of the active count) — inserting a
-- row here would double the effect, not add it.

-- Step 4: four keys that are defined, copy-referenced or displayed on the
-- pricing matrix, but never read by any hasFeature/getLimit call site
-- (design doc "Background facts" and §2, each row marked "delete key").
-- Drop them everywhere, including the enterprise rows step 2 just
-- created, plus any org-level override — as V390 did for its three
-- fidelity keys.
delete from org_entitlement_overrides
 where feature_key in ('officials.per_fixture.max', 'domains.custom', 'support.priority', 'stats.club_championship');
delete from plan_entitlements
 where feature_key in ('officials.per_fixture.max', 'domains.custom', 'support.priority', 'stats.club_championship');

-- Step 5-6: retire pro_plus. Greenfield, reconfirmed by the owner
-- 2026-09-03 (R7): no prod data, no grandfathering, unconditional delete
-- (unlike V290's guarded `business` retirement, there is nothing here to
-- protect).
update subscriptions set plan_key = 'pro' where plan_key = 'pro_plus';
delete from plan_entitlements where plan_key = 'pro_plus';
delete from plans where key = 'pro_plus';
