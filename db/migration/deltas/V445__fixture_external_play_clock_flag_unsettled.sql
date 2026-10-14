-- V445 — fixture_external_play learns `clock_flag_unsettled` (T17B fix 2, D11).
--
-- Renumber at merge if main has moved past (V443 is W2c's, controller ruling
-- 2026-10-14; V444 is this branch's D9).
--
-- Measured live on staging (game x0JKlePc, 5+0, 2026-10-14): White's clock
-- reached zero and Lichess still reported the game `started` with White at 0
-- for seven minutes, until White resigned. We never declare a flag from our
-- own arithmetic (reconcile.ts), so a flag Lichess has not settled a minute
-- after it fell is HELD for the organiser with the evidence (the side, when
-- its clock ran out, the last read) — never given up silently. A mid-game
-- hold: reconcile keeps reading it, and Lichess's own end replaces it.
--
-- Expand-only: the CHECK widens by one value under its own name, so every
-- existing row still passes and `fixture_external_play_needs_reason_check`
-- stays the name a refusal reports (types.ts NEEDS_REASONS is the same set,
-- read back from pg_constraint by external-play-needs-organiser.test.ts).
alter table fixture_external_play
  drop constraint fixture_external_play_needs_reason_check,
  add constraint fixture_external_play_needs_reason_check check (needs_reason in (
    'no_show_white', 'no_show_black', 'no_show_both',
    'not_started', 'aborted', 'mismatch', 'provider_error',
    'token_revoked', 'double_walkover_blocked',
    'create_outcome_unknown',
    'tiebreak_owed',
    'fair_play',
    'account_changed',
    'clock_flag_unsettled'
  ));
