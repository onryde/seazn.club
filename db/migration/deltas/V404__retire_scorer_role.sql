-- =============================================================================
-- V404 — Retire org-member role 'scorer' and scorer_assignments (#707, option A).
--
-- Option A (owner ruling 2026-09-15): delete all scorer memberships and
-- assignments; no demotion to viewer. Recreate role CHECKs as owner|admin|viewer
-- only. Leaves org_invites.default_scope column (Task 2–3 may drop if unused).
-- =============================================================================

DELETE FROM scorer_assignments;
DELETE FROM org_members WHERE role = 'scorer';
DELETE FROM org_invites WHERE role = 'scorer';

-- V115: policy + user index; V275: created_by partial index
DROP POLICY IF EXISTS scorer_assignments_tenant ON scorer_assignments;
DROP INDEX IF EXISTS scorer_assignments_user_idx;
DROP INDEX IF EXISTS scorer_assignments_created_by_idx;
DROP TABLE IF EXISTS scorer_assignments;

ALTER TABLE org_members DROP CONSTRAINT IF EXISTS org_members_role_check;
ALTER TABLE org_members ADD CONSTRAINT org_members_role_check
  CHECK (role = ANY (ARRAY['owner'::text, 'admin'::text, 'viewer'::text]));

ALTER TABLE org_invites DROP CONSTRAINT IF EXISTS org_invites_role_check;
ALTER TABLE org_invites ADD CONSTRAINT org_invites_role_check
  CHECK (role = ANY (ARRAY['owner'::text, 'admin'::text, 'viewer'::text]));
