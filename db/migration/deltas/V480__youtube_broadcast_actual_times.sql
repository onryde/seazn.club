-- V480 — YouTube Connect: when a broadcast ACTUALLY started and ended, as YouTube reports it.
-- (design of record docs/superpowers/specs/2026-10-27-youtube-connect-design.md §0 D15; plan T14; for R4 sponsors-on-stream's
-- replay deep-link, whose rows FK to youtube_broadcasts(id) on delete cascade, so a purge of a broadcast covers them.)
--
-- Why a new delta and not an edit of V479: V479 is merged (B1, #1050), and Flyway checksums a merged delta. D15 asked for an
-- in-place amend while V479 was unmerged; that premise went false first, so the columns arrive additively here.
--
-- actual_start_at / actual_end_at are liveBroadcasts `snippet.actualStartTime` / `snippet.actualEndTime`
-- (developers.google.com/youtube/v3/live/docs/liveBroadcasts: "only available once the broadcast's state is live" / "...is
-- complete"; ISO 8601). The end step (server/youtube/end-step.ts) writes both in the SAME statement that finalizes a broadcast
-- `complete`, and nothing else writes them. Both stay NULL while the broadcast is open and for a `failed` row (it never ran, or
-- was deleted), and either may be NULL on a `complete` row when YouTube did not say (they are informational, never a reason to
-- keep a broadcast from ending). The check below holds the first two of those as the database's floor.
--
-- Greenfield (RULES.md §Schema): two nullable columns and one check every existing row satisfies (both are NULL on all of them).
alter table youtube_broadcasts
  add column actual_start_at timestamptz null,
  add column actual_end_at   timestamptz null;

alter table youtube_broadcasts
  add constraint youtube_broadcasts_actual_times_only_complete
    check (state = 'complete' or (actual_start_at is null and actual_end_at is null));
