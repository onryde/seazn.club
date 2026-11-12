-- V510 — Quick match lifecycle (docs/superpowers/specs/2026-11-03-quick-match-design.md §7.6, §7.7, C2; plan 3 Task 1 and its
-- pre-flight amendment T1 [B20], the plan-1 final review's carry m3).
-- Flyway runs with outOfOrder=false, so the version number must rise in MERGE order: it is a WORKING number, assigned at merge
-- (main's max + 1: authored as V507 after V506__quick_matches.sql, renumbered to V510 past main's V508__sponsor_archive.sql and
-- V509__match_day_codes.sql). A renumber moves this file's name, the `V510` on line 1 (migration-header-truth.test.ts) and the
-- comments that cite V510 by number (`git grep -n V510 -- apps`).
--
-- Three changes, none of which changes a row's data:
--
-- 1. The email outbox's vocabulary gains the quick match's two mails: the link at creation (`quick_match_link`) and the one reminder
--    before expiry (`quick_match_reminder`). The CHECK restates V503's fifty-two kinds in V503's order (V478's fifty-one, then
--    sponsor_deal_paid), then these two.
--    outbox-schema.test.ts reads it back and requires it to equal constants.ts and the typed list.
--
-- 2. `quick_matches.locale` is one of the app's shipped locales (lib/i18n-constants.ts LOCALES), in V282's and V478's shape. The
--    create path writes it from a schema that already refuses anything else (`z.enum(LOCALES)`), and the link mail is rendered in
--    it; the CHECK makes the database say so too. NOT NULL already holds (V506), so no `is null` arm.
--
-- 3. The by-email save (usecases/quick-match-save.ts `saveInTx`) runs on every verified sign-in, site-wide, as app_user under
--    the table's forced RLS: `email_lower = lower($1) and saved_by_user_id is null and (expires_at ...)`. The lookup key is a
--    STORED generated column, not an expression index on lower(email): under RLS the planner may not evaluate a function that
--    is not leakproof (lower() is not) on a row before the policy has passed it, so `lower(email) = $1` can never be an index
--    condition there. An expression index was tried and EXPLAIN as app_user showed it walked as a whole (every unsaved address,
--    then filtered); on the column, the same statement is an Index Cond on the one address. Saved rows and rows with no address
--    never enter the partial index. Not in V506: databases that already applied V506 would fail Flyway's checksum.

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
    'quick_match_link', 'quick_match_reminder'));

alter table quick_matches
  add constraint quick_matches_locale_valid check (locale in ('en', 'fr', 'es', 'nl'));

alter table quick_matches add column email_lower text generated always as (lower(email)) stored;

create index quick_matches_unsaved_email_idx on quick_matches (email_lower)
  where saved_by_user_id is null and email_lower is not null;
