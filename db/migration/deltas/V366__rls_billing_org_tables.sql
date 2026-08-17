-- =============================================================================
-- V366 — RLS on the three org_id tables that never had it
--
-- Found while running RS001b's gate: `scripts/check-rls.ts` filtered on schema
-- `public`, but every table in this database lives in `seazn_club`. It was
-- therefore selecting ZERO rows and printing "RLS guard OK" — in CI as much as
-- locally — for as long as it has existed. With the schema corrected it checks
-- 54 tenant tables and names three that enable no row-level security at all:
--
--   * org_credit_allocation   (V329) — per-org monthly AI credit cap
--   * pass_credit_redemptions (V335) — Event Pass credit redemption ledger
--   * pass_mint_refusals      (V342) — refused pass mints, price-desync audit
--
-- All three carry a NOT NULL `org_id` and are reached today only through the
-- superuser client (`lib/credits.ts`, `lib/billing.ts`,
-- `usecases/operator-allocation.ts`, `usecases/pass-credit.ts`), which is why
-- nothing has leaked: none of them GRANTs anything to `app_user`, so a tenant
-- connection cannot read them at all.
--
-- That is exactly why this is worth fixing rather than exempting. The isolation
-- rests on the absence of a GRANT — one future `GRANT SELECT … TO app_user`,
-- added by someone wiring an org-facing credits or billing surface, silently
-- exposes every org's rows to every other org, with no policy to stop it and no
-- gate to notice. Enabling and FORCEing RLS with a tenant policy now means that
-- GRANT lands on a table that is already isolated.
--
-- Deliberately NO `GRANT … TO app_user` here: these tables are superuser-only
-- today and this migration is meant to tighten, never to widen. The policy sits
-- ready for the grant that may one day come.
--
-- FORCE is safe for the same reason it is safe on the ~50 tables that already
-- carry it: the app's non-tenant client bypasses RLS (it already reads FORCEd
-- tables such as `registrations` outside `withTenant`), and only `app_user`
-- connections — which have no grant here — are subject to the policy.
--
-- Owner ruling 2026-08-17: fix the guard AND close the three tables in this PR
-- rather than exempting them or deferring to a follow-up.
-- =============================================================================

alter table org_credit_allocation enable row level security;
alter table org_credit_allocation force  row level security;
drop policy if exists org_credit_allocation_tenant on org_credit_allocation;
create policy org_credit_allocation_tenant on org_credit_allocation for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());

alter table pass_credit_redemptions enable row level security;
alter table pass_credit_redemptions force  row level security;
drop policy if exists pass_credit_redemptions_tenant on pass_credit_redemptions;
create policy pass_credit_redemptions_tenant on pass_credit_redemptions for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());

alter table pass_mint_refusals enable row level security;
alter table pass_mint_refusals force  row level security;
drop policy if exists pass_mint_refusals_tenant on pass_mint_refusals;
create policy pass_mint_refusals_tenant on pass_mint_refusals for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
