-- V476 — email outbox phase 3, wave 4: nine officials, discipline, report and billing-group emails join the outbox's vocabulary. Spec:
-- docs/superpowers/specs/2026-10-25-email-outbox-phase3-design.md (the kind table, wave 4).
-- Plan: docs/superpowers/plans/2026-10-26-email-outbox-phase3-wave4.md (T1).
--
-- WHAT THIS ADDS. Nine kinds, in the table's row order: official_assigned, official_assignment_changed, suspension_confirmed,
-- suspension_served, match_report_submitted, group_transfer_offer, group_transfer_complete, group_org_removed, group_org_left.
-- Nothing else: the once-key, the replace rule and the cancel function are V472's, and V474's scrub index serves account_deletion
-- alone, which this wave does not touch.
--
-- ORDER. V475 is W2d's and must reach main before this migration does: db/flyway.toml sets no outOfOrder, so a database already at
-- V476 refuses a V475 that arrives after it.

-- Closed set: outbox-schema.test.ts reads this back and requires it to equal constants.ts and the spec's list.
alter table email_outbox drop constraint email_outbox_kind_valid,
  add constraint email_outbox_kind_valid check (kind in ('magic_link', 'chess_invite', 'registration_confirmation',
    'payment_reminder', 'registration_promoted', 'refund_issued', 'solo_signup_assigned',
    'registration_dispute_alert', 'registration_dispute_lost', 'sponsor_invoice', 'sponsor_receipt', 'sponsor_refund',
    'sponsor_dispute_alert', 'sponsor_dispute_won', 'sponsor_dispute_lost', 'pass_revoked', 'trial_ending',
    'email_verification', 'funnel_claim', 'email_change_confirmation', 'email_change_notice', 'account_deletion',
    'org_invite', 'claim_invite', 'official_invite',
    'official_assigned', 'official_assignment_changed', 'suspension_confirmed', 'suspension_served', 'match_report_submitted',
    'group_transfer_offer', 'group_transfer_complete', 'group_org_removed', 'group_org_left'));
