-- V523 — Revshare affiliate attribution.
-- subscriptions.revshare_ref_code: the Revshare affiliate ref_code, stamped ONCE when the paying group is
--   minted for a user's FIRST org (lib/auth.ts createOrgForUser, from the `rs_ref` cookie) and never rewritten.
--   Attribution belongs to the payer, not to an org: attaching or detaching an org (billing-groups.ts) must
--   not change or drop who is owed commission on this group's renewals. Read at invoice.payment_succeeded
--   (billing-events/invoices.ts) to report the sale. Nullable; unrelated to organizations.referral_code /
--   referred_by_org_id (V333), the deprecated org-to-org referral loop (replaced by invite/earn).
alter table subscriptions add column if not exists revshare_ref_code text;
