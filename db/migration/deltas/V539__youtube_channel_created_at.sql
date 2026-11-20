-- V539 — YouTube Connect: when the connected channel was created (Phase 0, YouTube channel safety, Task 3).
--
-- YouTube treats a young channel that runs several short live streams as a risk. A Go live warning (a later task) reads how old
-- the channel is; this column holds YouTube's own answer, channels.list `snippet.publishedAt`, read once when the connection is
-- created (server/youtube/connections.ts `recordChannelCreatedAt`). The read is best effort: a failed read leaves null and never
-- fails the connect, and null means "not known", which the warning treats as not young (server/youtube/channel-safety.ts).
--
-- Nullable for every existing row (no backfill: nothing reads it yet). Not an identifier and not a secret: a public channel fact.
alter table org_youtube_connections
  add column channel_created_at timestamptz null;
