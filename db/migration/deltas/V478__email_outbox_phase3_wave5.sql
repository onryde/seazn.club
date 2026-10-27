-- V478 — email outbox phase 3, wave 5: the funnel reminder and the sixteen staff alerts join the outbox's vocabulary, and a funnel
-- draft remembers the visitor's language. Spec: docs/superpowers/specs/2026-10-25-email-outbox-phase3-design.md (the kind table, wave 5).
-- Plan: docs/superpowers/plans/2026-10-26-email-outbox-phase3-wave5.md (T1; Owner questions Q3).
--
-- WHAT THIS ADDS. Seventeen kinds, in the table's row order: funnel_reminder, staff_registration_refund_failed,
-- staff_credit_pack_grant_failed, staff_size_pack_grant_failed, staff_stream_credit_grant_failed, staff_pass_credit_reversal_incomplete,
-- staff_pass_rung_mismatch, staff_pass_unknown_competition, staff_stream_credit_clawback, staff_extra_org_reprice_failed,
-- staff_dispute_alert, staff_connect_bank_changed, staff_stuck_events, staff_stream_pack_price_drift, staff_ai_run_cost,
-- staff_earn_grant_volume, staff_extra_org_allowance. The CHECK restates every kind: wave 4's thirty-four in wave 4's order (V477), then these.
-- With them the vocabulary is the spec's fifty-one. The once-key, the replace rule and the cancel function are V472's.
--
-- And one column (the plan's Q3, which the owner applied; wave 3 stored no locale on the draft): `funnel_drafts.locale`, the language the visitor started the draft in, so the claim
-- and the +24h reminder are written in it. Nullable: a draft started before this column has none, and its reminder falls back to `en`,
-- which is what it was sent in before. The set is the app's LOCALES (lib/i18n-constants.ts), in V282's shape.
--
-- ORDER. V475 is W2d's, V476 the relay's (stream phone live edge) and V477 wave 4's; all must reach main before this migration does:
-- db/flyway.toml sets no outOfOrder, so a database already at V478 refuses a lower version that arrives after it.

-- Closed set: outbox-schema.test.ts reads this back and requires it to equal constants.ts and the spec's list.
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
    'staff_earn_grant_volume', 'staff_extra_org_allowance'));

-- Q3: the draft's language, set at /api/funnel/start (wave 5 T3 writes and reads it).
alter table funnel_drafts add column locale text,
  add constraint funnel_drafts_locale_valid check (locale is null or locale in ('en', 'fr', 'es', 'nl'));
