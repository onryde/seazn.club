-- V434 — drop fixture_external_play.url_white / url_black.
--
-- Dead under the 2026-10-09 design (§3.3): White's token challenges Black's
-- username and Black's token accepts, so there is no per-colour lichess.org
-- link to hand a player (D3 deleted that mode). V432 kept both columns
-- nullable only because guard.ts and room.ts still read them; T9 removes the
-- last reader in the same change as this migration (controller ruling: T9
-- owns V434, T10 takes V435).
--
-- Nothing else depends on them: no index, constraint, policy, view or trigger
-- in V432/V433 names either column.
alter table fixture_external_play
  drop column url_white,
  drop column url_black;
