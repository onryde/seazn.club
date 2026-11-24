-- V557 — a Seazn recording is offered only once Cloudflare can play it (Seazn-hosted video, Phase 4, Task 39). V554 and V555 are
-- the realtime branch's and V556 is planned there; V551 to V553 are this branch's. The tests find this file by name, never by number.
--
-- `seazn_locked_videos` (V541) records that the Seazn pass made a recording need a token; the pass locks every FINISHED recording at
-- once, because signing must not wait. Locking is not playing: Cloudflare reads a finished recording `queued` or `inprogress` for a
-- while, and `error` for one it could not process. `ready_at` is when the pass last saw it `ready` (and `readyToStream` not false):
-- the interim replay offers a Cloudflare part only when it is set, and an `error` recording never sets it, so it is never offered
-- yet still holds its part number (it stays a row of the fixture's numbering).
--
-- Nullable, no default: a default would claim a recording playable that nobody has seen playable. The pass writes it on every
-- firing it lists the recording (set once, kept while it stays ready, cleared if Cloudflare later reads it otherwise); only the
-- backfill below writes it elsewhere. No new table and no grant: V541's enable + force RLS with no policy covers the column.
--
-- Guarded so a re-run adds nothing and never resurrects a value the pass cleared: the column is added, and backfilled, only when it
-- is not there. The backfill is a lock that already has a replay row (`fixture_video_replays`), which discovery stores only for a
-- recording Cloudflare reported `ready`; it is stamped with the lock's own time. A lock with no row is left null for the pass to
-- decide on its next firing, and an input the pass has already finished with is never listed again (see usecases/seazn-recordings.ts).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = current_schema() and table_name = 'seazn_locked_videos' and column_name = 'ready_at'
  ) then
    alter table seazn_locked_videos add column ready_at timestamptz null;
    update seazn_locked_videos v set ready_at = v.locked_at
     where exists (select 1 from fixture_video_replays r where r.cf_video_id = v.cf_video_id);
  end if;
end $$;
