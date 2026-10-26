-- V474 — email outbox phase 3, wave 3: eight account and invite emails join the outbox's vocabulary. Spec:
-- docs/superpowers/specs/2026-10-25-email-outbox-phase3-design.md (the kind table, wave 3).
-- Plan: docs/superpowers/plans/2026-10-26-email-outbox-phase3-wave3.md (T1).
--
-- WHAT THIS ADDS. Eight kinds, in the table's row order: email_verification, funnel_claim, email_change_confirmation,
-- email_change_notice, account_deletion, org_invite, claim_invite, official_invite.
-- Nothing else changes: the once-key, the replace rule and the cancel function are V472's and serve these kinds as they are (the
-- email change's cancel reason is a word in cancel.ts; `email_outbox_cancel` accepts any snake_case reason).

-- Closed set: outbox-schema.test.ts reads this back and requires it to equal constants.ts and the spec's list.
alter table email_outbox drop constraint email_outbox_kind_valid,
  add constraint email_outbox_kind_valid check (kind in ('magic_link', 'chess_invite', 'registration_confirmation',
    'payment_reminder', 'registration_promoted', 'refund_issued', 'solo_signup_assigned',
    'registration_dispute_alert', 'registration_dispute_lost', 'sponsor_invoice', 'sponsor_receipt', 'sponsor_refund',
    'sponsor_dispute_alert', 'sponsor_dispute_won', 'sponsor_dispute_lost', 'pass_revoked', 'trial_ending',
    'email_verification', 'funnel_claim', 'email_change_confirmation', 'email_change_notice', 'account_deletion',
    'org_invite', 'claim_invite', 'official_invite'));
