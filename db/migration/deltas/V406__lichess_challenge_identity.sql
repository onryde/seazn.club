-- V406 — persist the Lichess identities a challenge was built with, and
-- when it was created, so a later profile relink is not a false mismatch
-- and a 20s-expired Lichess challenge can be recreated without a second email.
--
-- V404 is claimed on feat/retire-scorer. V405 is this programme's tables.

alter table fixture_external_play
  add column white_lichess_id text,
  add column black_lichess_id text,
  add column challenge_created_at timestamptz;
