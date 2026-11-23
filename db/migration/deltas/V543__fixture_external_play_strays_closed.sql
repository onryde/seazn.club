-- A board whose fixture stopped being playable (withdrawn, voided, decided elsewhere) while its bridge still carried T9's sent
-- marker (`create_sent_at`, nothing recorded) can leave a challenge open at Lichess that no one will ever claim: a create is
-- never claimed for an unplayable fixture, so no recovery runs to cancel it, and Black can still accept it. The sweep's
-- `close_strays` job lists White's outgoing challenges while one could still be that create (the recovery's own window after
-- the marker) and cancels the matches; past the window nothing listed can be ours, and it asks Lichess nothing.
--
-- strays_closed_at / strays_closed_reason: the one-shot stamp. Set when the job can do NOTHING MORE for the board - which is
-- not "nothing of ours is open": our own unaccepted challenge leaves Lichess's list ~36 s after it is sent and stays
-- acceptable, and once its id is lost no listing can find it (owed to recording the id the moment the create answers).
--   cancelled      every match listed inside the window was cancelled (or was already over)
--   not_listed     no match listed inside the window - or the board was reached only after the window, without a call
--   token_refused  White's token was refused (revoked, or missing the challenge scopes)
--   no_token       White has no stored token
--   unidentifiable nothing to match ours by (no pairing, White or Black unlinked, a clock no create could have sent)
--   gave_up        STRAYS_GIVE_UP_AFTER passes failed in a row (sweep/close-strays.ts)
-- strays_attempts: the failed passes so far (a 429, an answer that proves nothing, a throw); the job reads the fewest first,
-- so a failing board never holds the head of the line.
-- The marker itself is kept - a game MAY still exist, and M-10's lock and the account-change hold read it.
alter table fixture_external_play
  add column strays_closed_at timestamptz null,
  add column strays_closed_reason text null,
  add column strays_attempts integer not null default 0,
  add constraint fixture_external_play_strays_closed_reason_check check (
    strays_closed_reason is null
    or strays_closed_reason in ('cancelled', 'not_listed', 'token_refused', 'no_token', 'unidentifiable', 'gave_up')),
  add constraint fixture_external_play_strays_closed_pair_check check (
    (strays_closed_at is null) = (strays_closed_reason is null)),
  add constraint fixture_external_play_strays_attempts_check check (strays_attempts >= 0);
