-- G2 (bench B03 product-gaps, 2026-09-02): an organiser had no way to record
-- an official's blackout — V284 granted app_user SELECT only on
-- official_availability, so every write had to go through /me (superuser
-- connection, person-wide fan-out). This grants org-scoped write access for
-- POST/DELETE /api/v1/officials/{id}/availability: the tenant RLS policy
-- already on this table (official_availability_tenant, V284) restricts every
-- row to org_id = current_org_id() on read AND write, so this grant cannot
-- let an org touch another org's row.
grant insert, update, delete on official_availability to app_user;
