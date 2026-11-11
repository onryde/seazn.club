-- =============================================================================
-- V500 — remove the referral programme (owner ruling 2026-11-11: "We don't want to have referral and don't using that
-- in prod yet").
--
-- DATA CHANGE: drops `organizations.referral_code` (with its partial unique index `organizations_referral_code_key`) and
-- `organizations.referred_by_org_id` (with its self-referencing FK), both added by V333. Any shareable code and any
-- referrer attribution stamped on an org is discarded. Nothing reads or writes either column any more (the /refer route,
-- the `ref` cookie and the referrer / referral-welcome credit grants are deleted in the same change).
--
-- KEPT on purpose: the `earn_grant` value of `ai_credit_ledger_source_check` (V330/V331). It is not referral-specific —
-- the onboarding and first-paid-competition earn grants still write it — and the ledger is append-only, so rows the
-- retired referral grants wrote (`idempotency_key = 'earn:referral:…' / 'earn:referral_welcome:…'`) stay valid and
-- readable in the wallet history. No ledger row is touched.
-- =============================================================================

drop index if exists organizations_referral_code_key;
alter table organizations drop column if exists referral_code;
alter table organizations drop column if exists referred_by_org_id;
