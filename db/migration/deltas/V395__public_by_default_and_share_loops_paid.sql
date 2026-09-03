-- Entitlements v18 W2 / T14 + T15 (owner rulings 2026-09-03; design of record
-- docs/superpowers/specs/2026-09-02-entitlements-v18-three-tier-design.md §2,
-- amended in the same commits as this file — `entitlements-v18-matrix.test.ts`
-- parses that table and pins every cell below against it, so the doc and this
-- migration cannot drift apart in one direction only).
--
-- Resolver semantics this file is written against, unchanged since V391's
-- header: for an int key only `int_value` is read, `int_value = NULL` means
-- unlimited, and a key with NO ROW resolves to 0 — DENY, not unlimited. For a
-- bool, `bool_value = true` exactly; a pass row can only GRANT on top of the
-- org's plan row, never take away, and a key with no pass row FALLS THROUGH to
-- the plan row. That last clause is why step 2 has to insert pass rows it
-- would otherwise not need (see the trap it names).
--
-- Every statement is written to be re-runnable: this file was developed
-- against a database the steps had already been applied to by hand.

-- ---------------------------------------------------------------------------
-- Step 1 (T14): launch `import.events` — bool TRUE on every plan.
--
-- The key had ZERO rows and a deliberate rollout kill-switch at its two
-- enforcement sites (`// 402 during rollout`). It is a FEATURE LAUNCH, not a
-- forgotten matrix row, and it was put to the owner as one.
--
-- Ruling: ship it, true on all five plans. R9 says scoring detail is never a
-- price boundary, and W1 (V390) already stripped the fidelity-band gate off
-- this very importer — gating the same importer by plan would re-introduce the
-- boundary R9 removed. The house pattern for imports is a VOLUME CAP, not a
-- gate (`import.bulk` is 50 Free / 500 Pro); if event-import volume ever needs
-- bounding, add a cap key rather than converting this back into a gate.
--
-- Consequence, recorded because it decides what the code around it may say:
-- `orgPlanKey` (lib/entitlements.ts) coalesces an org with no subscription to
-- 'community', so after this statement NO PLAN can deny the key. The only
-- refusal left is an explicit `org_entitlement_overrides` deny, which is why
-- the two call sites keep their `requireFeature`/`hasFeature` calls and only
-- their stale "402 during rollout" comments change.
insert into plan_entitlements (plan_key, feature_key, bool_value)
values ('community',    'import.events', true),
       ('pro',          'import.events', true),
       ('enterprise',   'import.events', true),
       ('event_pass',   'import.events', true),
       ('event_pass_l', 'import.events', true)
on conflict (plan_key, feature_key) do update set bool_value = true;

-- ---------------------------------------------------------------------------
-- Step 2 (T15): the three share loops become PAID on Free.
--
-- This REVERSES four cells V392 set the previous day, and reverses §2's own
-- growth thesis ("Three share loops go free… each one puts the badge in front
-- of people who are not yet customers"). Owner ruling 2026-09-03, taken with
-- that counter-argument put and overruled: value capture over the loop. A
-- reader who finds V392 and V395 disagreeing is not looking at a mistake — do
-- not "restore" these to Free on the strength of the design doc, which is now
-- the older decision.
--
-- `branding` (the org's own logo) is deliberately NOT in this list and stays
-- TRUE on Free. An earlier draft flipped it; the owner WITHDREW that — a free
-- club uploads its own logo. What is sold is the removal of OUR badge, which
-- step 3 makes enterprise-only.
update plan_entitlements
   set bool_value = false
 where plan_key = 'community'
   and feature_key in ('dashboard.player_profiles', 'embeds.enabled', 'news.auto');

-- THE TRAP, stated because getting it wrong is silent. `embeds.enabled` had NO
-- pass rows: it did not need any while community granted it, because the pass
-- overlay only ADDS to what the plan row already says and a key with no pass
-- row falls straight through to the plan. Flip community to false without
-- these two inserts and an Event Pass holder SILENTLY LOSES embeds on the
-- competition they paid for. `dashboard.player_profiles` and `news.auto`
-- already carry their pass rows (V308 / V112), which is why only this key
-- needs them written.
insert into plan_entitlements (plan_key, feature_key, bool_value)
values ('event_pass',   'embeds.enabled', true),
       ('event_pass_l', 'embeds.enabled', true)
on conflict (plan_key, feature_key) do update set bool_value = true;

-- ---------------------------------------------------------------------------
-- Step 3 (T15): the badge is SHOWN on every plan except enterprise.
--
-- `dashboard.branding` is INVERTED: true means the badge is REMOVED. So this
-- one UPDATE takes badge removal off Pro and leaves it enterprise-only, which
-- is where R3 already puts white label ("White label, custom domain, write
-- API, priority support -> Contact Us"). Final cells: community false, pro
-- false, event_pass false, event_pass_l false, enterprise true.
--
-- THIS OVERTURNS DESIGN §2's OWN NOTE ON THIS CELL, "D7, never moves".
-- Recorded here rather than argued in a commit message, because a reader who
-- finds that note is one edit away from reverting this: the note is the older
-- decision, the owner moved the cell deliberately on 2026-09-03, and the
-- design table has been amended in the same commit.
--
-- An intermediate ruling the same day set the two pass rungs TRUE. It was
-- never built, so there is nothing to revert — but note that this statement
-- also moves PRO, which no earlier draft did.
--
-- Net effect: every self-serve plan carries our badge, Pro included. The
-- acquisition loop survives step 2's share-loop reversal after all; it just
-- runs through public dashboards now instead of profiles, embeds and posts.
update plan_entitlements
   set bool_value = false
 where plan_key = 'pro' and feature_key = 'dashboard.branding';

-- ---------------------------------------------------------------------------
-- Step 4 (T15): public dashboards — Free 3 -> 2, Pro unlimited -> 10.
--
-- Pro loses the "unlimited public dashboards" claim; §3's Pro card and
-- `capClaimFaults` move with it (copy sweep).
--
-- The tightening is only safe BECAUSE the same wave fixed what the cap counts.
-- `assertPublicQuota` was a flat `select count(*) from competitions where
-- visibility = 'public'` — no status filter, no pass exclusion — so it counted
-- HISTORY: a club three seasons in carried three public dashboards for ever
-- and was refused a fourth while nothing was running. That is why 3 felt tight
-- and why 2 would have felt broken. Free's third active competition is also
-- why the create path now DEGRADES to private instead of refusing (step 5):
-- Free is 3 active competitions but 2 public dashboards, and a plan whose
-- one-line sell is "run a club night" must never fail a create by default.
update plan_entitlements
   set int_value = 2
 where plan_key = 'community' and feature_key = 'dashboard.public.max';

update plan_entitlements
   set int_value = 10
 where plan_key = 'pro' and feature_key = 'dashboard.public.max';
