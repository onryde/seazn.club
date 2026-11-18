-- V528 — the lots draw's live key is a fixed-size hash of the member list, not the list itself.
--
-- WHY. V475 made `stage_lots_draws_live_key` a unique index over (stage, pool, members_key), where `members_key` is the
-- member list as text (37 characters an entrant). A btree row is capped at 2704 bytes ("index row size N exceeds btree
-- version 4 maximum 2704"), and the row also carries the stage and the pool, so a tie class of 72 entrants or more could not
-- be stored: the INSERT threw, out of `recomputeStandings`, which `scoreEvent` calls after the score committed. The result
-- stood, the caller got a 500, the stage's table was not refolded and every hook after it was skipped. Found by the
-- 100-board / 200-player Swiss load run (2026-11-18): every unplayed entrant of a fresh round is one class, so each of the
-- first ~65 results of a 200-player round 1 hit it.
--
-- WHAT. The same unique key, the same partial predicate (one LIVE draw per stage, pool and member set; a superseded draw is
-- history and never blocks a new live one), over md5(members_key): 32 characters whatever the class size. `members_key`
-- stays as it is — the readers group and sort on it (`loadLotsDraws`, `swissInputHash`) and the check beside it
-- (`stage_lots_draws_order_is_members`) is on `members`, not on the key.
--
-- A collision of two different member sets' md5 would read as "already drawn" (`on conflict do nothing`), and
-- `rankWithStoredLots` refuses a draw that was not stored by name (`lots_draw_unstored`) rather than ranking by an order
-- nobody stored; 2^-128 per pair, so the refusal is for the record, not for use.
--
-- The swap loses no row: every stored row fitted the old index, and the new one can refuse the build only if two live
-- rows of one (stage, pool) had different member sets with one md5 (the same 2^-128 case). md5() is immutable, so it is
-- allowed in an index expression. The table holds one row per tie class ever drawn, so the rebuild holds no lock of note.
drop index stage_lots_draws_live_key;

create unique index stage_lots_draws_live_key
  on stage_lots_draws (stage_id, coalesce(pool_id, '00000000-0000-0000-0000-000000000000'::uuid), md5(members_key))
  where superseded_at is null;
