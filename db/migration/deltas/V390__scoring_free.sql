-- Entitlements v18 W1 (R9, owner ruling 2026-08-30): scoring detail is never
-- a price boundary. The three fidelity keys leave the matrix on every plan;
-- their server gate (requiredFeatureForEvent) is deleted in the same wave, so
-- a lingering row would be an inert seam. Overrides for these keys go too.
delete from org_entitlement_overrides
 where feature_key in ('scoring.ball_by_ball', 'scoring.rally_by_rally', 'scoring.match_timeline');
delete from plan_entitlements
 where feature_key in ('scoring.ball_by_ball', 'scoring.rally_by_rally', 'scoring.match_timeline');
