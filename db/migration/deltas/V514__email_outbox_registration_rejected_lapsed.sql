-- V514 -- the email outbox's last two registrant lifecycle kinds (polish wave P5, the P2 carry).
--
-- WHAT THIS ADDS. `registration_rejected` (the organiser rejected the entry on a manual-approval division; a refund line when the
-- entry's own card payment is being returned) and `registration_promotion_lapsed` (an entry promoted off the waitlist was not paid in
-- its pay window and went back to the waitlist). Literal addresses, not transactional (like every registration_* mail). Each is queued
-- in the transaction that records the fact it reports, once per fact.
--
-- The CHECK restates every kind: V503's fifty-two in V503's order, V511's five registration lifecycle kinds, then these two (V511 is
-- the previous definer of email_outbox_kind_valid, re-checked 2026-11-12; origin/main defines none after V503). Nothing else moves:
-- the once-key, the replace rule and the cancel function are V472's. outbox-schema.test.ts reads the constraint back and requires it
-- to equal constants.ts.

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
    'sponsor_deal_paid',
    'registration_paid', 'registration_approved', 'registration_expired', 'registration_withdrawn', 'registration_joined', 'registration_rejected', 'registration_promotion_lapsed'));
