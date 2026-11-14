-- V518 — funnel drafts: a short human reference, one live draft per address, and the competition a claim built
-- (/start "Sent stepper" wave, Task 1, owner-approved 2026-11-14).
-- Flyway runs with outOfOrder=false, so the version number must rise in MERGE order: V518 is a WORKING number (main tops at
-- V517__quick_match_league_knockout.sql), reassigned at merge if main has moved past it. A renumber moves this file's name, the
-- `V518` on line 1 (migration-header-truth.test.ts) and the comments and tests that cite V518 by number (`git grep -n V518 -- apps`).
--
-- The defect: POST /api/funnel/start wrote a NEW draft and a new claim email on every submit, so an organiser who went back and
-- sent the wizard again held two live links, and claiming both built two competitions in one organisation.
--
-- 1. `reference` — `SZ-` and six symbols from 23456789ABCDEFGHJKLMNPQRSTUVWXYZ (digits and capitals less 0/O and 1/I, so it can be
--    read aloud or retyped from an email; owner, 2026-11-14). The start route returns it and the claim email prints it. A draft
--    that replaces another by its reference AND replace key (Change email) carries that reference; any other start draws a fresh
--    one (T1 review m1). A replaced draft always names its live successor's reference (the start rewrites them in step, at the
--    replaced drafts' own addresses), which is what the replaced-link card shows. Rows from before this migration get a fresh one each. The CHECK holds the shape; uniqueness is
--    only among LIVE drafts (below).
--
-- 2. `replaced_at` — set when a newer start replaced this draft: the same address resubmitted (case-insensitive), or the client
--    proved it holds the draft by sending its reference with its replace key (the Change-email flow, where the address differs).
--    A replaced draft never claims (the claim answers FUNNEL_CLAIM_REPLACED) and is never reminded. A draft is replaced OR used,
--    never both (`funnel_drafts_replaced_or_used`).
--
-- 3. `replace_key_hash` — sha256 (hex) of the opaque key the start route returns beside the reference. The reference alone is
--    guessable (32^6), so replacing a draft whose address differs needs the key only the client that started it holds. Null on
--    rows from before this migration: those can be replaced by their own address only.
--
-- 4. `competition_id` — the competition the claim built from this draft (null until claimed; set null when that competition is
--    deleted). The draft's payload stays the record of what the organiser chose — the field size the getting-started read
--    reports as the target ("0 of 8"), and the name and language its organisation was given.
--
-- `funnel_drafts_live_reference_idx` is the invariant "a reference names at most one live draft": a replace must retire the old
-- row before the new one carrying its reference is written. `funnel_drafts_email_idx` serves the start's per-address lookup of live
-- drafts and its rewrite of the replaced ones' references, so it is not partial.

alter table funnel_drafts
  add column reference text,
  add column replaced_at timestamptz,
  add column replace_key_hash text,
  add column competition_id uuid references competitions(id) on delete set null;

-- Correlated on the row (`d.id`), so every row draws its own six symbols.
update funnel_drafts d set reference = (
  select 'SZ-' || string_agg(substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 1 + floor(random() * 32)::int, 1), '')
    from generate_series(1, 6) where d.id is not null);

alter table funnel_drafts
  alter column reference set not null,
  add constraint funnel_drafts_reference_shape check (reference ~ '^SZ-[2-9A-HJ-NP-Z]{6}$'),
  add constraint funnel_drafts_replaced_or_used check (replaced_at is null or used_at is null);

create unique index funnel_drafts_live_reference_idx on funnel_drafts(reference) where used_at is null and replaced_at is null;
create index funnel_drafts_email_idx on funnel_drafts(lower(email));
create index funnel_drafts_competition_idx on funnel_drafts(competition_id) where competition_id is not null;
