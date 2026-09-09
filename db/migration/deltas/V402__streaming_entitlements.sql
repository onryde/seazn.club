-- =============================================================================
-- V402 — Streaming W1: the `streaming.overlay` and `streaming.relay` keys
-- (design §5.1, re-pinned 2026-09-09; the 09-05 plan wrote V393/V401 at
-- various points, which are the entitlements-v18 catalogue and Task 3's
-- fixture-stream-url migration respectively — both already landed on this
-- branch, so V402 is the next free number: `ls db/migration/deltas | sort -V
-- | tail -1` → V401__fixture_stream_url.sql, re-confirmed immediately before
-- writing this file).
--
-- Both granted by NO plan at launch (dark rollout, design §10.4; the GA flip
-- to §5.1's split — true on pro / event_pass_l / enterprise — is a LATER
-- migration shipped with its pricing copy). A missing row already denies
-- (lib/entitlements.ts's resolver; V024__plan_entitlements.sql:1), so these
-- rows are not what makes the gate work — they are what makes the key VISIBLE
-- in /admin/entitlements under "other", so an operator can see the feature
-- exists before deciding a tier for it.
--
-- The key is deliberately NOT added to `ENTITLEMENT_DOMAINS`
-- (apps/web/src/lib/entitlement-domains.ts) — that catalogue is CODE, and
-- `buildPricingSections` renders only listed keys, so the omission is exactly
-- what keeps a false-everywhere row off the public pricing comparison. Adding
-- it there would render an empty column on every plan.
--
-- The test org is lifted with an `org_entitlement_overrides` row (V025), which
-- the resolver ranks first — SQL, not a migration, so the grant travels with
-- the environment rather than with the schema.
--
-- Derived from `plans` rather than a typed plan list, so a tier added later
-- still gets its explicit deny without an edit here. Same insert form as
-- V290__pro_plus_plan.sql:18,39.
--
-- Re-pinned on the ovl DB immediately before landing this file:
--   select key from plans order by key
--   -> community, enterprise, event_pass, event_pass_l, pro  (5 rows, the v18
--      set — pro_plus retired at V393:145, matches this file's own claim).
-- =============================================================================

insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
select p.key, k.feature_key, false, null
from plans p
cross join (values ('streaming.overlay'), ('streaming.relay')) as k(feature_key)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;
