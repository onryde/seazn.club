-- V529 — pre-minted rooms and the line's stamped price (check-in capacity design 2026-11-05 §6.1, §6.3, §6.4). Renumber at merge if main has moved past.
-- V451 made the stamps NOT NULL ("a board with no pairing gets no meeting"); an unadopted room is exactly that board's room, both null.
alter table fixture_video_meetings alter column home_entrant_id drop not null;
alter table fixture_video_meetings alter column away_entrant_id drop not null;
-- An unadopted room has BOTH stamps null; one null alone is a bug.
alter table fixture_video_meetings add constraint fixture_video_meetings_stamp_pair_check
  check ((home_entrant_id is null) = (away_entrant_id is null));
-- The stay's price, stamped at the stay's FIRST claim (and again when a stay restarts), never re-priced inside a stay
-- (seat-line.ts lineReservation), and what its opponent's re-verify costs at that read price (lineRecheckCost). Both are written
-- by upsertStay together; both are null for a row from before this migration, and every reader coalesces them.
alter table fixture_seat_line add column reservation int null check (reservation between 1 and 64);
alter table fixture_seat_line add column recheck_cost int null check (recheck_cost between 1 and 8);
-- The instant a claim first saw the browser report a live camera with no presence on file (preflight.ts PRESENCE_FALLBACK_MS); cleared when presence arrives.
alter table fixture_video_participants add column presence_fallback_from timestamptz null;
-- The receipt of the FIRST `live` camera report of this seat's current live run (owner ruling 2026-11-17): written by
-- camera-report.ts when it writes `live` over a stored state that is not a FRESH `live` (null, `off`, or a `live` older than
-- CAMERA_REPORT_STALE_MS); never re-stamped by a same-state heartbeat on a fresh `live` (`refreshed`, which re-stamps
-- camera_reported_at every 30 s); cleared when it writes `off`. The fallback clock reads it. A row already `live` at deploy
-- keeps null until its next report, which stamps it (the writer coalesces); the reader treats live-with-null as a run starting now.
-- No "live implies stamped" constraint: the app version running while this migration applies writes `live` without it.
-- Set only while camera_reported is 'live'. `is not distinct from`, not `=`: with camera_reported null, `= 'live'` is NULL,
-- and a NULL check PASSES (three-valued logic), so `=` would admit a stamp beside no report at all (controller ruling
-- 2026-11-18, amending the plan's DDL).
alter table fixture_video_participants add column camera_live_first_at timestamptz null;
alter table fixture_video_participants add constraint fixture_video_participants_camera_live_first_check
  check (camera_live_first_at is null or camera_reported is not distinct from 'live');
-- When the seat last handed this participant a token (a mint's own, or refreshParticipantToken), written by preflight.ts.
-- The fallback clock never starts before it: no peer can join before its page holds a token, and a reload's page gets a new
-- one (review fix 2026-11-17, finding 6). Null: never handed, so nobody can have joined and the fallback never fires.
alter table fixture_video_participants add column token_issued_at timestamptz null;
