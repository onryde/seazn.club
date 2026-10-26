-- V473 — email outbox phase 3, wave 2: ten money emails join the outbox's vocabulary. Spec:
-- docs/superpowers/specs/2026-10-25-email-outbox-phase3-design.md (the kind table, wave 2).
-- Plan: docs/superpowers/plans/2026-10-26-email-outbox-phase3-wave2.md (T1).
--
-- WHAT THIS ADDS. Ten kinds, in the table's row order: registration_dispute_alert, registration_dispute_lost, sponsor_invoice,
-- sponsor_receipt, sponsor_refund, sponsor_dispute_alert, sponsor_dispute_won, sponsor_dispute_lost, pass_revoked, trial_ending.
-- Nothing else changes: the once-key, the replace rule and the cancel function are V472's and serve these kinds as they are.

-- Closed set: outbox-schema.test.ts reads this back and requires it to equal constants.ts.
alter table email_outbox drop constraint email_outbox_kind_valid,
  add constraint email_outbox_kind_valid check (kind in ('magic_link', 'chess_invite', 'registration_confirmation',
    'payment_reminder', 'registration_promoted', 'refund_issued', 'solo_signup_assigned',
    'registration_dispute_alert', 'registration_dispute_lost', 'sponsor_invoice', 'sponsor_receipt', 'sponsor_refund',
    'sponsor_dispute_alert', 'sponsor_dispute_won', 'sponsor_dispute_lost', 'pass_revoked', 'trial_ending'));
