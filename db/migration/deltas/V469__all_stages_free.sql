-- V469 — "All stages are free" (owner ruling 2026-10-20, option 2).
--
-- Two plan-matrix keys go free on EVERY plan:
--
--   * stages.per_division.max — the stage COUNT. Was community 2 (V112),
--     event_pass / event_pass_l 4 and pro 6 (V393), enterprise unlimited.
--     NULL is unlimited on an int key.
--   * standings.carry_over    — carrying a stage's standings into the next.
--     Was false on community (V246) with no pass rows, so both pass rungs fell
--     through to community's false.
--
-- The rest of the ruling is CODE, not data, because it sat behind
-- `formats.advanced`, which stays paid for the americano and ladder stage
-- kinds: `auto_progress = true` (usecases/divisions.ts) and a stage's custom
-- byes / cross_feeds / placements (usecases/format-gates.ts) no longer ask
-- for it.
--
-- WRITTEN AGAINST THE LIVE CATALOGUE, NOT A PLAN LIST. The plan set a
-- database holds is not what the migrations read (`business` and `pro_plus`
-- exist in some histories and not in others), and the resolver treats an
-- ABSENT row as a refusal — an int key with no row resolves to 0 and a bool
-- key with no row denies (lib/entitlements.ts `getLimit` / `hasFeature`). So
-- every row is UPSERTED for every plan in `plans`, rather than UPDATEd on the
-- rows some earlier delta happened to insert: a plan with no row would stay
-- capped at 0 under an UPDATE.
--
-- The gate CALLS stay in place (`createStages`' stage cap and carry-over
-- check, `createFromTemplate`'s stage cap): from here on the only refusal
-- either key can raise is an explicit `org_entitlement_overrides` row — the
-- same shape `formats.double_elim`, `cricket.dls`, `standings.custom_points`
-- and `stats.player` (V399) already use. Keeping the rows, rather than
-- deleting the keys, is what lets staff still cap one organisation. Existing
-- override rows are staff decisions and are left alone.
--
-- Re-runnable, like every statement in this tree.

insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
select p.key, 'stages.per_division.max', null, null
  from plans p
on conflict (plan_key, feature_key) do update set int_value = null;

insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
select p.key, 'standings.carry_over', true, null
  from plans p
on conflict (plan_key, feature_key) do update set bool_value = true;
