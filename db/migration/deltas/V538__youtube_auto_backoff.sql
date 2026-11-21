-- V538 — YouTube Connect: the AUTOMATIC start backs off a channel after a refusal (Phase 0, YouTube channel safety, Task 1).
--
-- An automatic start retries every minute. When YouTube answers the token exchange or a new broadcast with a rate or availability
-- refusal (youtube_limit_reached, youtube_unavailable), or the pool's grow answers youtube_channel_busy after a YouTube insertStream,
-- each retry would make the same calls against the same channel and fail the same way. The pick-time busy (no free key, ten live)
-- makes no YouTube call and is deliberately not backed off. The connection now remembers how many such refusals came in a row and
-- until when an automatic start is refused without asking YouTube: 60 s after the first, doubling each time, capped at 1800 s
-- (lib/youtube.ts YOUTUBE_AUTO_BACKOFF_*; server/youtube/connections.ts `recordAutoBackoff`). A person's tap (the organiser's
-- Go live, the operator's Start) never reads it, and any successful prepare clears it.
--
-- Deliberately NOT `last_error_code` / `last_health_at`: those feed `liveStateOf` and the Streaming page's live state, which is a
-- fact about whether the channel CAN stream, not about how recently it was busy.
--
-- `auto_backoff_code` is the refusal that started the window, so a refused automatic start carries YouTube's own code instead
-- of a generic one. Greenfield: every existing row takes the defaults (no backoff), and no data moves.
alter table org_youtube_connections
  add column auto_backoff_count int not null default 0,
  add column auto_retry_after   timestamptz null,
  add column auto_backoff_code  text null,
  add constraint org_youtube_connections_auto_backoff_count_check check (auto_backoff_count >= 0),
  add constraint org_youtube_connections_auto_backoff_code_check check (
    auto_backoff_code is null or auto_backoff_code in ('youtube_limit_reached', 'youtube_channel_busy', 'youtube_unavailable')
  );
