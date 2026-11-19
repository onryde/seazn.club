-- needs_reason gains 'lichess_unlinked' and 'lichess_reconnect': the hold an organiser's Open round writes on a board
-- whose player has no Lichess link that plays (none, or a grant short of a play scope). The board is never invited and
-- never auto-forfeited by the no-show sweep; the organiser awards it or waits for the link, and a re-open after the
-- link clears the hold. Same constraint name, so NEEDS_REASONS (types.ts) and its pg_constraint read-back still match.
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
    'clock_flag_unsettled',
    'lichess_unlinked', 'lichess_reconnect'
  ));
