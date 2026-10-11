-- V435 — the creation bookkeeping T9 owns on fixture_external_play.
--
-- 1. Drop url_white / url_black. Dead under the 2026-10-09 design (§3.3):
--    White's token challenges Black's username and Black's token accepts, so
--    there is no per-colour lichess.org link to hand a player (D3 deleted that
--    mode). V433 kept both columns nullable only because guard.ts and room.ts
--    still read them; T9 removes the last reader in the same change as this
--    migration (controller ruling: T9 owns V435, T10 takes V436). Nothing
--    else depends on them: no index, constraint, policy, view or trigger in
--    V433/V434 names either column.
--
-- 2. create_sent_at — the durable "a create was sent" marker (T9 fix round 1,
--    I2). Written as its own committed statement BEFORE the challenge HTTP
--    call, and cleared only where the outcome is KNOWN (the game recorded, or
--    a 429 that lila refused before acting). A claim that goes stale while it
--    carries the marker belongs to a minter that may have died after Lichess
--    answered 2xx and before our commit: it is never retaken blind — the next
--    claimant looks the game up first (create-game.ts). Amended into V435
--    rather than a new version because the branch is unmerged and V436 is
--    T10's.
--
-- 3. needs_reason gains 'create_outcome_unknown': the hold a lookup that
--    could not prove the outcome lands on. Same constraint name, so
--    NEEDS_REASONS (types.ts) and its pg_constraint read-back still match.
--
-- 4. needs_reason gains 'tiebreak_owed' (T12, spec §3.6): a drawn game in a
--    bracket stage is HELD for the organiser and never written as decided —
--    this branch's engine has no tie-break phase, so the hold is the bridge
--    row. Amended into V435 (the CHECK's latest declaration) rather than a new
--    version because the branch is unmerged; V436 is T10's move ledger.
--
-- 5. needs_reason gains 'fair_play' (T12 fix round 1, I2; addendum 1): Lichess
--    ended the game for a fair-play violation (status `cheat`). The organiser
--    sees a fair-play verdict Lichess already made, never a provider fault —
--    amended here for the same reason as item 4.
alter table fixture_external_play
  drop column url_white,
  drop column url_black,
  add column create_sent_at timestamptz null;

alter table fixture_external_play
  drop constraint fixture_external_play_needs_reason_check,
  add constraint fixture_external_play_needs_reason_check check (needs_reason in (
    'no_show_white', 'no_show_black', 'no_show_both',
    'not_started', 'aborted', 'mismatch', 'provider_error',
    'token_revoked', 'double_walkover_blocked',
    'create_outcome_unknown',
    'tiebreak_owed',
    'fair_play'
  ));
