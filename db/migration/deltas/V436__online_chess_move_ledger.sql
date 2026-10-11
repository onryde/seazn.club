-- V436 — the move ledger on fixture_external_play (chess design §3.4, Task 10).
--
-- Our server is the only mover: a player posts an intended move to us, we
-- submit it with THAT player's Lichess token, and only an accepted move is
-- recorded here and then broadcast. Mid-game truth is this ledger plus the
-- Board API stream (M16: the export stalls mid-game and is never read for
-- moves or clocks).
--
-- moves_uci / move_count — every move Lichess ACCEPTED, in order, as UCI
--   (T3's assertUci shape). move_count is the ledger's length, kept as its
--   own column because the append is conditional on it (the loser of a race
--   writes nothing); the ledger CHECK below keeps the two from drifting.
-- last_move_at — when the last accepted move was recorded. Clocks render
--   locally from it and are corrected on every reconcile; NOTHING declares a
--   flag from our arithmetic (spec §6, M1/M2).
-- white_ms / black_ms / clock_increment_s — our locally-derived clocks: null
--   until the first accepted move seeds them from the division clock (T9's
--   'ready' row carries none). Never negative.
-- draw_offer_by — the standing draw offer as lila would hold it (lila
--   Drawer.scala; source, not measured — T17 owes the live measurement). The
--   export cannot show one (M10).
-- white_draw_offer_ply / black_draw_offer_ply — the ply at which each side
--   last made an offer lila REGISTERED. lila refuses a re-offer within 20 plies
--   of the last one (Game.scala `playerHasOfferedDrawRecently`) and answers it
--   200 all the same, so without these the ledger would invent an offer lila
--   never holds. Never below ply 2, never beyond the ledger's own length.
--
-- revoked_seat — WHICH seat a `token_revoked` hold froze (T11 fix round 1,
--   controller ruling M7, 2026-10-11): 'white', 'black' or 'both'. A revoked
--   token freezes only its own seat; the other player keeps playing (T10) and
--   can still win on the clock — freezing the innocent side would hand the
--   flag to the player whose token broke. Null on every other reason. Null on
--   a token_revoked hold is a seat nobody recorded (T9's create/accept
--   refusal, before a game ran): both seats are frozen.
--
-- sweep_no_truth_reads — how many CONSECUTIVE reads by the external-play sweep
--   (T13) told it nothing about this game: no stream line, no terminal export.
--   Counted only past the game's expected end; reset to 0 by any read that
--   brings the truth. It backs the sweep's re-read off, and at a small N puts
--   a ready/live board in the organiser's queue as provider_error (T11 review
--   M4: a board read forever with no signal blocks the next round). Written
--   by the sweep alone; `last_polled_at` (V433) is when it last read.
--
-- Additive and nullable/defaulted, so every existing row (pending, ready,
-- needs_organiser) is valid as it stands: an empty ledger.
alter table fixture_external_play
  add column moves_uci            jsonb       not null default '[]'::jsonb,
  add column move_count           integer     not null default 0,
  add column last_move_at         timestamptz null,
  add column white_ms             integer     null,
  add column black_ms             integer     null,
  add column clock_increment_s    integer     null,
  add column draw_offer_by        text        null,
  add column white_draw_offer_ply integer     null,
  add column black_draw_offer_ply integer     null,
  add column revoked_seat         text        null,
  add column sweep_no_truth_reads integer     not null default 0;

-- One constraint per guarded fact, each named so a test can assert it by
-- SQLSTATE + name (never by clause text).
alter table fixture_external_play
  -- A JSON ARRAY whose length IS move_count. CASE, not AND: Postgres does not
  -- promise AND's evaluation order, and jsonb_array_length on a non-array
  -- raises 22023 instead of failing the check.
  add constraint fixture_external_play_move_ledger_check
    check (case when jsonb_typeof(moves_uci) = 'array'
                then move_count = jsonb_array_length(moves_uci)
                else false end),
  -- A standing offer is a colour, and stands only from ply 2: lila registers
  -- none earlier (Game.scala `playerCanOfferDraw`). Spelled with `is null`
  -- because `null and false` is false, which would refuse every early row.
  add constraint fixture_external_play_draw_offer_by_check
    check (draw_offer_by is null or (draw_offer_by in ('white', 'black') and move_count >= 2)),
  -- A clock is a non-negative duration; our arithmetic clamps at zero and
  -- leaves the flag to Lichess.
  add constraint fixture_external_play_clock_check
    check ((white_ms is null or white_ms >= 0)
           and (black_ms is null or black_ms >= 0)
           and (clock_increment_s is null or clock_increment_s >= 0)),
  -- An offer is made at a ply the game has already reached, and never before
  -- ply 2 — lila registers none earlier (Game.scala `playerCanOfferDraw`), so
  -- an earlier one from any writer (T11's adoption included) is invented.
  add constraint fixture_external_play_draw_offer_ply_check
    check ((white_draw_offer_ply is null or white_draw_offer_ply between 2 and move_count)
           and (black_draw_offer_ply is null or black_draw_offer_ply between 2 and move_count)),
  -- A recorded seat belongs to a token_revoked hold and to nothing else.
  -- `is not distinct from`, not `=`: a NULL needs_reason would make `=` NULL,
  -- and a NULL CHECK passes.
  add constraint fixture_external_play_revoked_seat_check
    check (revoked_seat is null
           or (revoked_seat in ('white', 'black', 'both')
               and needs_reason is not distinct from 'token_revoked')),
  -- A count of reads: never negative.
  add constraint fixture_external_play_sweep_no_truth_reads_check
    check (sweep_no_truth_reads >= 0);
