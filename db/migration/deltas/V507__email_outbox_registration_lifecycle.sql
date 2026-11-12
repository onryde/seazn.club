-- V507 -- the email outbox's registrant lifecycle kinds (polish wave P2, walkthrough W1-W4, W10, W11, W13).
--
-- WHAT THIS ADDS. Mails to the person an entry is about, after its confirmation: `registration_paid` (the payment landed, by card or
-- marked offline), `registration_approved` (the organiser approved it; the contact and any teammate with an address),
-- `registration_expired` (the sweep released an unpaid place), `registration_withdrawn` (the ORGANISER withdrew it; a
-- self-withdrawal mails nothing) and `registration_joined` (a teammate claimed a slot). Literal addresses, not transactional (like
-- every registration_* mail). Each is queued in the transaction that records the fact it reports, once per fact.
--
-- The CHECK restates every kind: V503's fifty-two in V503's order (the last definer of email_outbox_kind_valid, re-checked
-- 2026-11-12), then these. Nothing else moves: the once-key, the replace rule and the cancel function are V472's.
--
-- Numbered V507 because this branch's V505 collides with main's (V505 sponsor_archive, V506 quick_matches): the renumber at merge is a
-- pure `git mv`, which the tests allow because they find this file by its SUFFIX (`__email_outbox_registration_lifecycle.sql`), never
-- its number. outbox-schema.test.ts reads the constraint back and requires it to equal constants.ts.

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
    'registration_paid', 'registration_approved', 'registration_expired'));
