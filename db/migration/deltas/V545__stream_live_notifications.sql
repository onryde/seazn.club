-- V545 — Cloudflare live-input notifications, one replay row per Bunny copy, and the input-uid lookup (Seazn-hosted video,
-- Task 27b; renumbered from V543, which another branch claimed first).
--
-- 1. fixture_stream_samples.source admits 'notification'. Cloudflare Notifications (alert type `stream_live_notifications`) push
--    live_input.connected / .disconnected / .errored the moment they happen. The stream tick polls the input every 1 min (prod) /
--    5 min (stg), so a drop and a reconnect inside one gap left no trace. The webhook route records each notification as a
--    sample with this source and an `ingest_status` event of source `webhook` (usecases/stream-sessions/live-notification.ts). A RECORD only: the
--    poll stays the decider. Every reader that decides reads `source = 'poll'` (latestPollSample, phone-lost's
--    last_connected_at), and D3's `since` skips the notification's events. V410 declared this check inline, so its default name
--    is fixture_stream_samples_source_check (confirmed with pg_constraint on a fresh V542 schema, 2026-11-23).
alter table fixture_stream_samples
  drop constraint fixture_stream_samples_source_check,
  add constraint fixture_stream_samples_source_check
    check (source in ('heartbeat','poll','notification'));

-- 2. A Bunny copy is named by at most one fixture_video_replays row (Task 27 review m4). The webhook looks a copy up by its id
--    on every acted event (usecases/seazn-replay-webhook.ts), so this serves that read, and the "two rows name one copy" guard
--    becomes a constraint. Partial: a row with no copy (found, downloading, fetching, failed, deleted) holds null, and nulls
--    never collide. PLAIN, not CONCURRENTLY: Flyway runs each delta in a transaction (V420, V425), where CONCURRENTLY is
--    refused. Bunny's guids are unique in a library, so no real pair exists; a stg or prod database that held one would fail
--    this migration by name (check: select bunny_video_id from fixture_video_replays where bunny_video_id is not null group by
--    1 having count(*) > 1).
create unique index fixture_video_replays_bunny_video_id_key
  on fixture_video_replays (bunny_video_id)
  where bunny_video_id is not null;

-- 3. The input-uid lookup (Task 27b review m3). Every notification delivery, from both environments and for every input on the
--    shared Cloudflare account, finds its input row by uid (usecases/stream-sessions/live-notification.ts), as relay-sweep
--    does. Partial: a retired input's uid is nulled. NOT unique: one row per uid is a named code guard there
--    (`ambiguous_input`), never a constraint a prod row could fail. PLAIN, for the same reason as (2).
create index fixture_stream_inputs_ingest_input_id_idx
  on fixture_stream_inputs (ingest_input_id)
  where ingest_input_id is not null;
