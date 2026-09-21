-- =============================================================================
-- V411 — Connect payout health: "the money cannot reach this club".
--
-- The existing Connect mirror on `organizations` (V-series, PROMPT-20a/P1-8)
-- answers whether Stripe will ACCEPT charges and whether payouts are ENABLED:
-- `stripe_charges_enabled`, `stripe_payouts_enabled`, `stripe_disabled_reason`,
-- `stripe_requirements_due`. All four are mirrored from `account.updated`, and
-- all four can read perfectly healthy while an actual payout bounces — an
-- enabled account whose bank closed the destination account still reports
-- `payouts_enabled = true` right up until Stripe marks the payout `failed`.
--
-- Three events carry that news and nothing read them before this migration:
--   payout.failed                      — a real transfer bounced
--   account.external_account.deleted   — the destination bank account is gone
--   account.external_account.updated   — it changed under us
-- All three are CONNECT-scoped: they describe the club's own Stripe account,
-- never the platform's, and are delivered on the connected-accounts endpoint.
--
-- One alert column, not one per cause. A bounced payout and a removed bank
-- account are the same sentence to an owner ("your payout could not be paid"),
-- differing only in what to DO about it, so they share a banner and the value
-- selects the copy. `payout.paid` is the positive direction: money demonstrably
-- landed, so it CLEARS the alert and stamps `stripe_last_payout_at`. Without
-- that clear the banner would be permanent after the first bounce, which is the
-- idempotency-guard failure class in reverse — a guard that never lets go.
--
-- `stripe_payout_alert_detail` is operator-facing (Stripe's `failure_code`, or
-- the external account's id/last4). It is deliberately NOT on the wire: the
-- banner renders from `stripe_payout_alert` alone, so no Stripe-authored
-- English can reach a screen.
-- =============================================================================

alter table organizations
  add column if not exists stripe_payout_alert        text,
  add column if not exists stripe_payout_alert_at     timestamptz,
  add column if not exists stripe_payout_alert_detail text,
  add column if not exists stripe_last_payout_at      timestamptz;

-- Closed set, like every other status column here: an unknown value would
-- reach `msg()` as a missing dictionary key and render as the raw token.
alter table organizations
  drop constraint if exists organizations_stripe_payout_alert_chk;
alter table organizations
  add constraint organizations_stripe_payout_alert_chk
  check (stripe_payout_alert is null
         or stripe_payout_alert in ('payout_failed', 'bank_removed', 'bank_changed'));

-- The only read is "which connected orgs are currently alerting", which a
-- staff sweep or a support query asks across the whole table. Partial so the
-- index holds only the rows that are actually in trouble.
create index if not exists organizations_stripe_payout_alert_idx
  on organizations (stripe_payout_alert)
  where stripe_payout_alert is not null;
