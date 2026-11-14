-- V520 -- the email outbox's `registration_promotion_skipped` kind (registration walk-fix F16).
--
-- WHAT THIS ADDS. `registration_promotion_skipped`: an automatic waitlist promotion on an online-play division passed over a waiting
-- registrant because the seat gate refused them (their Lichess account is not linked to play), and offered the place to the next in
-- line. To the entry's contact, with the step that makes the next place theirs (link Lichess). Literal address, not transactional (like
-- every registration_* mail). Queued in the transaction that records the skip (`registration.promotion_skipped`), once per registrant per
-- act that passed them over.
--
-- The CHECK restates every kind: V515's sixty-one in V515's order (V503's fifty-two, V511's five registration lifecycle kinds, V514's
-- registration_rejected and registration_promotion_lapsed, origin/main V515's quick_match_link and quick_match_reminder), then this
-- one: sixty-two. origin/main's V515__quick_match_lifecycle.sql is the previous definer of email_outbox_kind_valid (re-checked
-- 2026-11-14 against origin/main 254b9d83ad: V516, V517 and V518 define none). Numbered V520: origin/main owns V515-V518, and
-- this branch's V519__registration_cart_position.sql (renumbered from V517, then V518, at the two pre-PR rebases) defines none, so
-- this file is the LAST definer. constants.ts carries all sixty-two. Nothing else moves: the once-key, the replace rule and the
-- cancel function are V472's.

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
    'registration_promotion_skipped'));
