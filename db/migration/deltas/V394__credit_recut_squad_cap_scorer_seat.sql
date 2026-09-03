-- Entitlements v18 W2 / T12 (owner rulings 2026-09-03; design of record
-- docs/superpowers/specs/2026-09-02-entitlements-v18-three-tier-design.md §2,
-- amended in the same commit as this file — `entitlements-v18-matrix.test.ts`
-- parses that table and pins every cell below against it, so the doc and this
-- migration cannot drift apart in one direction only).
--
-- Four changes, all UPDATEs and one key deletion. Resolver semantics are the
-- ones V392's header records and this file is written against them: for an int
-- key only `int_value` is read, `int_value = NULL` means unlimited, and a key
-- with NO ROW resolves to 0 — DENY, not unlimited. That last one is why step 4
-- ships with its two call-site edits and is not a data-only change.

-- Step 1: the AI credit re-cut. Pro's monthly grant 35 -> 25.
-- Community stays 5 (owner: "AI Credit is fine, that's the selling point")
-- and enterprise stays 500, which is a staff-negotiated pool set per deal.
--
-- Recorded and accepted by the owner when the number was chosen: 25 is now
-- BELOW the cheapest credit pack (40 credits for $10), so an org whose only
-- unmet need is AI is better off buying a pack than upgrading. That is
-- coherent with the design's "credits are compute, not packaging".
update plan_entitlements
   set int_value = 25
 where plan_key = 'pro' and feature_key = 'ai.credits.monthly';

-- Step 2: the one-time trial grant, PRO ONLY — 20 -> 15.
--
-- `plan_key = 'enterprise'` is deliberately NOT touched and keeps 20, so
-- enterprise's trial ends up LARGER than Pro's. The owner confirmed the
-- asymmetry on 2026-09-03 with it stated: enterprise is a staff-granted
-- contact-us plan whose numbers are set per deal, not a rung a customer
-- self-serves onto. Do not "correct" it to 15 in a later wave.
update plan_entitlements
   set int_value = 15
 where plan_key = 'pro' and feature_key = 'ai.credits.trial';

-- Step 3: Free's squad cap 20 -> 23.
--
-- §2 justifies Free's cap as "one matchday squad". Measured against the
-- engine's OWN declarations it was not one: packages/engine/src/sports/
-- football/football.ts declares `lineup: { size: 11, benchMax: 12 }` and
-- icehockey/icehockey.ts `{ size: 6, benchMax: 17 }` — both 23. At 20, a
-- football or ice-hockey club could not register its first full squad on Free
-- at all. Cricket (15) and volleyball (14) already fit.
--
-- The numbers come from the sport modules, never from §2's old prose, which
-- cited "rugby 23" — rugby is not in the engine catalogue at all.
-- Pro stays 40, which keeps the real distinction (matchday squad vs season
-- roster) and leaves the "squads of 40" Pro claim true.
update plan_entitlements
   set int_value = 23
 where plan_key = 'community' and feature_key = 'teams.squad_max';

-- Step 4: delete `scorers.max` from every plan (owner ruling 2026-09-03).
--
-- The cap meters a capability the product gives away. W1 ruled scoring free on
-- every plan, and `requireFixtureActor` (server/api-v1/auth.ts) already grants
-- an ACCEPTED fixture official both read and score on a fixture with NO org
-- role at all — so a Free org delegates scoring today without spending a
-- scorer seat. Nor is there any UI that creates a `scorer_assignments` row, so
-- the matrix was selling "10 scorer seats" for a half-built feature that the
-- pricing comparison (#244) does not even list.
--
-- THE SCORER ROLE STAYS. Deprecating it is issue #707 and its own wave — it
-- touches `requireFixtureActor`, which is an authorisation path.
--
-- Deleting an int key DENIES it (no row -> 0), so this half of the change is
-- only safe because the two enforcement branches that read the key stop asking
-- for it in the same commit and fall back to the `members.max` pool:
--   * app/api/orgs/[id]/members/[userId]/role/route.ts
--   * lib/invites.ts (grantInvite)
-- Overrides go with the plan rows, the pairing V390 and V392 both use.
delete from org_entitlement_overrides
 where feature_key = 'scorers.max';
delete from plan_entitlements
 where feature_key = 'scorers.max';
