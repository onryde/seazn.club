-- V522 (feat/youtube-live-status): the YouTube live status line of a YouTube Connect session (owner direction 2026-11-14,
-- docs/superpowers/specs/2026-11-14-stream-output-health-warning-design.md). V519 and V520 are open PR #1220's (registration).
--
-- While a session that streams into a YouTube Connect broadcast is live, the stream tick (and the organiser's poll) read YouTube -
-- the broadcast's life and its stream's status/health - and reduce them to ONE word the stream panel shows:
--   live_receiving  the broadcast is live and the stream is active and healthy
--   not_live        the broadcast is not live
--   live_no_video   the broadcast is live but YouTube is receiving no video
-- No word is stored for a session YouTube has not been read for (null): a pasted key has none (no API), a session reads none until
-- the first read, 60 s after it went live (usecases/stream-sessions/youtube-status.ts), and a session whose grant was revoked has its
-- word cleared rather than left to say what was true before.
--
--   youtube_status          the latest word YouTube's answer gave. Written in the SAME transaction as the `youtube_status` event
--                           (fixture_stream_events, source 'output') that records the change - a word that did not change records
--                           nothing, and a read that failed or said nothing leaves it as it was.
--   youtube_status_read_at  the CLAIM on a read, like ingest_polled_at (V428): a poll claims the YouTube read by stamping this with a
--                           conditional UPDATE, and only when the previous claim is old enough, so any number of open panels and the
--                           cron tick share ONE read per window (YouTube's Data API quota is per Cloud project, shared by every org).
--   youtube_status_steady   how many reads in a row have answered `live_receiving` (capped at the use case's back-off threshold). It
--                           picks the window: once the word has held, the read slows to one per few minutes; any other word zeroes it
--                           and the fast window is back. Written in the same transaction as the word.
alter table fixture_stream_sessions
  add column youtube_status text null check (youtube_status in ('live_receiving', 'not_live', 'live_no_video')),
  add column youtube_status_read_at timestamptz null,
  add column youtube_status_steady smallint not null default 0 check (youtube_status_steady >= 0);
