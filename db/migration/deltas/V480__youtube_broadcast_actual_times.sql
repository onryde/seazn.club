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

-- ─── public_fixture_youtube_parts_v: a part's number follows when the broadcast STARTED ────────────────────────────────
-- V479 numbered the parts by completed_at. That is the wrong clock: a broadcast that started first and was ended LATE (its `complete`
-- call failed and backed off, while the restart's broadcast went through) would be numbered Part 2 behind the video that started
-- after it, and the numbers would be told differently by what the match page lists and what the organiser's panel lists. A
-- part is a stretch of the match, so it is numbered in the order the stretches STARTED: the broadcast row's created_at (the row is
-- made when Go live admits the start; a restart makes a later row), ties broken by id so the numbering is stable.
--
-- A broadcast that is PRIVATE on YouTube is not a part the public can see (owner ruling 2026-10-28, option A): its facade would be a
-- dead tap and its link "This video is private". The filter is the BROADCAST ROW's own `privacy` (stored when Go live made it), never
-- the channel's current default, so a channel switched to private later does not hide an unlisted match and one switched to unlisted
-- does not publish a private one. The numbering runs over the rows that remain (the filter is in the WHERE, ahead of the window), so
-- the public numbers what it shows: Part 1 unlisted + Part 2 private is ONE part, number 1, and the match page labels none. The
-- organiser's own read (server/youtube/parts.ts `fixtureReplayParts`) does not use this view: it lists every complete broadcast,
-- private ones marked, and its numbers may therefore differ from the public's when privacies mix.
--
-- V479 is merged, so its view is replaced here, never edited. This V480 is not merged, so it carries the replacement: `create or
-- replace view` keeps the columns, names, types and order exactly (fixture_id, video_id, part_no, completed_at), which is all
-- Postgres allows a replace to do, and the grant state is untouched (the view is still not granted to app_user; V479's §7 header).
-- Greenfield (RULES.md §Schema): a view has no data to move.
create or replace view public_fixture_youtube_parts_v as
  select b.fixture_id,
         b.yt_broadcast_id as video_id,
         (row_number() over (partition by b.fixture_id order by b.created_at, b.id))::int as part_no,
         b.completed_at
  from youtube_broadcasts b
  join fixtures f     on f.id = b.fixture_id
  join divisions d    on d.id = f.division_id
  join competitions c on c.id = d.competition_id
  where b.state = 'complete'
    and b.privacy <> 'private'
    and d.status <> 'setup'
    and c.visibility in ('public', 'unlisted');
