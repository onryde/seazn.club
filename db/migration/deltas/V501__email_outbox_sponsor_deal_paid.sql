-- V501 — the email outbox's sponsor_deal_paid kind (plan docs/superpowers/plans/2026-11-07-sponsor-deals.md, Task 23, D13).
--
-- WHAT THIS ADDS. One kind, `sponsor_deal_paid`: the notice to the org's owner (an ACCOUNT, `orgOwnerRecipient`, in the owner's
-- language) that a sponsor has paid a deal online. It is what tells an "After I approve" club to act. It is queued by the payment
-- webhook (server/usecases/sponsors.ts `handleSponsorPaymentSucceeded`) in the transaction that records the payment, once per payment
-- intent. Not transactional (a sponsor and money mail, like the six sponsor kinds before it).
--
-- The CHECK restates every kind: V478's fifty-one in V478's order (the last definer of email_outbox_kind_valid, re-checked
-- 2026-11-11), then this one. Nothing else moves: the once-key, the replace rule and the cancel function are V472's.
--
-- The tests find this file by its SUFFIX (`__email_outbox_sponsor_deal_paid.sql`), never its number: a renumber at merge (F26) is a
-- pure `git mv`. outbox-schema.test.ts reads the constraint back and requires it to equal constants.ts.

alter table email_outbox drop constraint email_outbox_kind_valid,
  add constraint email_outbox_kind_valid check (kind in ('magic_link', 'chess_invite', 'registration_confirmation',
    'payment_reminder', 'registration_promoted', 'refund_issued', 'solo_signup_assigned',
    'registration_dispute_alert', 'registration_dispute_lost', 'sponsor_invoice', 'sponsor_receipt', 'sponsor_refund',
    'sponsor_dispute_alert', 'sponsor_dispute_won', 'sponsor_dispute_lost', 'pass_revoked', 'trial_ending',
    'email_verification', 'funnel_claim', 'email_change_confirmation', 'email_change_notice', 'account_deletion',
    'org_invite', 'claim_invite', 'official_invite',
    'official_assigned', 'official_assignment_changed', 'suspension_confirmed', 'suspension_served', 'match_report_submitted',
    'group_transfer_offer', 'group_transfer_complete', 'group_org_removed', 'group_org_left',
    'funnel_reminder', 'staff_registration_refund_failed', 'staff_credit_pack_grant_failed', 'staff_size_pack_grant_failed',
    'staff_stream_credit_grant_failed', 'staff_pass_credit_reversal_incomplete', 'staff_pass_rung_mismatch',
    'staff_pass_unknown_competition', 'staff_stream_credit_clawback', 'staff_extra_org_reprice_failed', 'staff_dispute_alert',
    'staff_connect_bank_changed', 'staff_stuck_events', 'staff_stream_pack_price_drift', 'staff_ai_run_cost',
    'staff_earn_grant_volume', 'staff_extra_org_allowance',
    'sponsor_deal_paid'));
