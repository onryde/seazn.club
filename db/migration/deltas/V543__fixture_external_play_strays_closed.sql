-- A board whose fixture stopped being playable (withdrawn, voided, decided elsewhere) while its bridge still carried T9's sent
-- marker (`create_sent_at`, nothing recorded) can leave challenges open at Lichess that no one will ever claim: a create is
-- never claimed for an unplayable fixture, so no recovery runs to cancel them, and Black can still accept one. The sweep's
-- `close_strays` job lists White's outgoing challenges once the bridge is closed and cancels the ones matching the fixture's
-- create. This is its one-shot stamp: set when that cleanup is DONE (every match cancelled, or White's token refused), so a
-- later pass never asks Lichess again; null while it is owed (or retrying after a 429). The marker itself is kept - a game
-- MAY still exist, and M-10's lock and the account-change hold read it.
alter table fixture_external_play
  add column strays_closed_at timestamptz null;
