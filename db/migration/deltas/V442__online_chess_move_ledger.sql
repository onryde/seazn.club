-- V442 — the move ledger on fixture_external_play (chess design §3.4, Task 10).
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
--   flag to the player whose token broke. An `account_changed` hold (final
--   re-review P11, 2026-10-14: a player re-linked another Lichess account
--   mid-game) records its seat the same way. Null on every other reason.
--   Null on a seat hold is a seat nobody recorded (T9's create/accept
--   refusal, before a game ran): both seats are frozen.
--
-- sweep_no_truth_reads — how many CONSECUTIVE reads by the external-play sweep
--   (T13) told it nothing about this game: no stream line, no terminal export.
--   Counted only past the game's expected end; reset to 0 by any read that
--   brings the truth. It backs the sweep's re-read off, and at a small N puts
--   a ready/live board in the organiser's queue as provider_error (T11 review
--   M4: a board read forever with no signal blocks the next round). On a row
--   ALREADY held, every read counts whatever it brings (controller ruling C3:
--   a held board is never re-read every tick). Written by the sweep alone;
--   `last_polled_at` (V439) is when it last read.
--
-- game_over_at — when a reconcile read FIRST found this game over (a terminal
--   Lichess status), whatever was then written: a result that finished the
--   bridge, or a hold that keeps it (a tie-break owed, an abort, a mid-game
--   hold whose game later ended). `finished_at` is stamped only when the
--   bridge closes, so a held game would otherwise have no end on file, and the
--   sweep's camera evidence (T13 fix round 1, ruling I1) would run on to the
--   ROOM's end — accusing both players of the minutes after the game. Never
--   moved once set. A game end needs a game: never without a challenge.
--
-- pending_move_ply / pending_move_uci / pending_move_at — the move T10 is
--   SUBMITTING (T13 fix round 1, ruling I4): its ply (the ledger's length when
--   sent), its canonical UCI, and when. Recorded BEFORE Lichess hears it and
--   cleared by T10's append, so a reconcile landing between Lichess's 200 and
--   the append adopts that very move without an out-of-band flag. It excuses
--   only that ply with that move: a submission that failed or timed out
--   cannot whitewash a DIFFERENT move, or one at another ply. All three or
--   none; a game on file only; and only ever for the NEXT ply (the ledger's
--   length): T10 records it only at that ply, and every ledger write spends
--   a submission whose ply it passes.
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
  add column sweep_no_truth_reads integer     not null default 0,
  add column game_over_at         timestamptz null,
  add column pending_move_ply     integer     null,
  add column pending_move_uci     text        null,
  add column pending_move_at      timestamptz null;

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
  -- A recorded seat belongs to a seat hold (token_revoked, account_changed —
  -- types.ts SEAT_HOLD_REASONS) and to nothing else.
  -- `is not distinct from`, not `=`: a NULL needs_reason would make `=` NULL,
  -- and a NULL CHECK passes.
  add constraint fixture_external_play_revoked_seat_check
    check (revoked_seat is null
           or (revoked_seat in ('white', 'black', 'both')
               and (needs_reason is not distinct from 'token_revoked'
                    or needs_reason is not distinct from 'account_changed'))),
  -- A count of reads: never negative.
  add constraint fixture_external_play_sweep_no_truth_reads_check
    check (sweep_no_truth_reads >= 0),
  -- A game end is a game's: no challenge, nothing to have ended.
  add constraint fixture_external_play_game_over_check
    check (game_over_at is null or challenge_id is not null),
  -- A submission is whole or absent, for the ledger's NEXT ply, in T3's UCI
  -- shape (assertUci), on a game on file. Spelled out per column: `null and
  -- false` is false, so a half-null row must fail on its own arm.
  add constraint fixture_external_play_pending_move_check
    check ((pending_move_ply is null and pending_move_uci is null and pending_move_at is null)
           or (pending_move_ply is not null and pending_move_uci is not null and pending_move_at is not null
               and pending_move_ply = move_count
               and pending_move_uci ~ '^[a-h][1-8][a-h][1-8][qrbn]?$'
               and challenge_id is not null));

-- camera_evidence_at — when the external-play sweep (T13, controller ruling
--   C1; design §5.2 "fetched once, at least 2 minutes after the player leaves
--   or the match ends") SETTLED this meeting's camera evidence: every player's
--   peer reports, over every session of the meeting, read final and turned
--   into a camera_lost flag (fixture_play_flags) where the camera was off in
--   the match — or nothing to read (no game, a policy other than Required, an
--   organiser's video override). Null while the reports are not final; the
--   sweep retries. Stamped in the SAME transaction as the flags it writes, on
--   the condition that it is still null, so a re-run or a racing pass writes
--   no second flag. Evidence comes after the meeting ends, never before.
alter table fixture_video_meetings
  add column camera_evidence_at timestamptz null,
  add constraint fixture_video_meetings_camera_evidence_check
    check (camera_evidence_at is null or ended_at is not null);

-- fixture_video_guard_faults — when OUR safeguard, not the player, took a
--   player's camera out of the meeting (T14 re-review 3, I-1, controller
--   ruling 2026-10-12). The player's browser refuses every remote stream
--   (D7, spec §5.3); when it cannot — a remote peer is subscribed and the
--   SDK will not unsubscribe it — it leaves the meeting and re-joins a fresh
--   one. That gap is Seazn's fault: the client stamps its start before
--   leaving and its end once re-joined (POST …/room/camera-fault), and the
--   sweep's camera evidence (job 5) counts the stamped interval as ON, so it
--   never becomes a camera_lost flag against the player; while one is open,
--   the opponent's room shows no presence pill rather than "camera off".
--   One row per fault, per player per fixture; at most one OPEN per player
--   (the partial unique index), and an end never precedes its start. The
--   times are the SERVER's, never the client's. Sealed like the other video
--   tables: FORCE RLS, no app_user policy, reached only through `sql`.
create table fixture_video_guard_faults (
  id         uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references fixture_video_meetings(fixture_id) on delete cascade,
  person_id  uuid not null references persons(id) on delete cascade,
  started_at timestamptz not null,
  ended_at   timestamptz null,
  constraint fixture_video_guard_faults_interval_check
    check (ended_at is null or ended_at >= started_at)
);
create unique index fixture_video_guard_faults_open_idx
  on fixture_video_guard_faults (fixture_id, person_id) where ended_at is null;
alter table fixture_video_guard_faults enable row level security;
alter table fixture_video_guard_faults force  row level security;

-- fixture_video_participants.user_id, removed_at — WHO watched, and WHEN
--   (T15, design §5.3; fix round 1, I2 + M5): an arbiter participant is the
--   organiser whose signed-in session joined the fixture's meeting
--   receive-only, so the record says which user saw the players' cameras. A
--   player row never carries one (its person is the record). One row per
--   WATCH: the panel mints a fresh participant each time it opens a board,
--   never reusing one (a RealtimeKit token lasts 100 days and a refresh does
--   not revoke the old one), and the server REMOVES it — the panel closed,
--   the organiser's role gone, the participant past its TTL, the room torn
--   down — stamping `removed_at`. created_at → removed_at is that watch.
--   ON DELETE SET NULL keeps the record that someone watched after the
--   account is deleted (the CHECK allows a null user on an arbiter row), and
--   the sweep then removes a participant whose user is gone.
alter table fixture_video_participants
  add column user_id uuid null references users(id) on delete set null,
  add column removed_at timestamptz null,
  add constraint fixture_video_participants_user_check
    check (user_id is null or preset = 'arbiter'),
  add constraint fixture_video_participants_removed_check
    check (removed_at is null or preset = 'arbiter');
-- The sweep's look-up: arbiter participants not yet removed.
create index fixture_video_participants_arbiter_open_idx
  on fixture_video_participants (fixture_id)
  where preset = 'arbiter' and removed_at is null;
