-- V524 -- the email outbox's seven billing lifecycle kinds (2026-11-15).
--
-- WHAT THIS ADDS. A billing group's payer is told what happened to the subscription, each mail queued by the Stripe webhook that
-- learns it (server/usecases/billing-events/lifecycle-mail.ts):
--   trial_expired         a no-card trial ran out (customer.subscription.deleted) and the group is on Community now
--   plan_activated        a subscription's first payment (invoice.payment_succeeded: a new paid plan, or the charge that ends a trial)
--   renewal_failed        a renewal charge was declined (invoice.payment_failed), one notice per invoice, with the 14-day grace
--   renewal_upcoming      an ANNUAL plan renews soon (invoice.upcoming)
--   renewal_paid          a later renewal was paid: the receipt (invoice.payment_succeeded; BILLING_RENEWAL_RECEIPT_EMAILS can stop it)
--   subscription_changed  the payer's own change confirmed (customer.subscription.updated): cancel scheduled, resumed, interval switched
--   renewal_action_required  the payer's bank wants a renewal confirmed (invoice.payment_action_required, 3-D Secure), one per invoice,
--                            its button the invoice's Stripe-hosted page (Stripe's own confirm-your-payment email is off)
-- All seven are addressed to the payer's account (subscriptions.owner_user_id, resolved at send) and transactional, like trial_ending.
--
-- The CHECK restates every kind: V520's sixty-two in V520's order, then these seven: sixty-nine. V520__email_outbox_registration_
-- promotion_skipped.sql is the previous definer of email_outbox_kind_valid (re-checked 2026-11-16 against origin/main: V521 to V523
-- define none). constants.ts carries all sixty-nine. Nothing else moves: the once-key, the replace rule and the cancel function are
-- V472's.

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
    'registration_paid', 'registration_approved', 'registration_expired', 'registration_withdrawn', 'registration_joined', 'registration_rejected', 'registration_promotion_lapsed',
    'quick_match_link', 'quick_match_reminder',
    'registration_promotion_skipped',
    'trial_expired', 'plan_activated', 'renewal_failed', 'renewal_upcoming', 'renewal_paid', 'subscription_changed',
    'renewal_action_required'));
