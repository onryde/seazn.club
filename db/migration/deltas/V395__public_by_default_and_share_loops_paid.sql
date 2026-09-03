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
