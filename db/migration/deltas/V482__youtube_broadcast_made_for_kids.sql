-- V482 — YouTube Connect: whether a broadcast was MADE FOR KIDS, stamped on the broadcast row.
-- (Owner ruling 2026-10-29, controller rulings R1/R2: the public match page shows a made-for-kids replay as a link to YouTube and
-- never as an embedded player - Google's YouTube API Services Developer Policies III.E.4.j: a page that embeds a video made for kids
-- must not track, and the root layout runs consent-gated PostHog.)
--
-- Why a column on the BROADCAST and not a read of the connection. The connection's `made_for_kids` is editable later (the Streaming
-- page's PATCH), so it says what the NEXT broadcast will be sent, not what an existing one was made with. The value that decides
-- how a replay may be shown is the one YouTube was told when the broadcast was created (liveBroadcasts.insert
-- `status.selfDeclaredMadeForKids`), so the row carries it: server/youtube/prepare.ts stamps it at insert from the SAME value it
-- sends (one source - the connection is read once, then passed through, never re-read), and a later PATCH moves no existing row.
-- The end step ORs in YouTube's own determination (`status.madeForKids` of the liveBroadcasts.list it already makes) when it
-- finalizes a broadcast, so a flag goes from false to true and never back.
--
-- ─── The data move (LOUD, and before the deploy) ────────────────────────────────────────────────────────────────────────
-- Rows that exist when this runs were made before the flag was kept. Each is given its connection's CURRENT flag - the nearest fact
-- there is - by the one UPDATE below, which is the whole backfill: the column is then NOT NULL, so every row has an explicit value
-- and the application carries no "unknown" path for old rows. There is no compatibility shim. The DO block reports the move in the
-- migration log (how many rows, how many made for kids) so it is never silent. `youtube_broadcasts.connection_id` is NOT NULL and
-- a foreign key, so the join below reaches every row; if it somehow did not, `set not null` fails the migration loudly instead of
-- storing a guess.
--
-- NOT NULL with NO default, on purpose. A default of `false` would make a writer that forgets the flag silently "not for kids" -
-- the unsafe direction for this rule. Without one such a writer is refused by the database.
alter table youtube_broadcasts add column made_for_kids boolean null;

update youtube_broadcasts b
   set made_for_kids = c.made_for_kids
  from org_youtube_connections c
 where c.id = b.connection_id;

do $$
declare
  total int;
  kids  int;
begin
  select count(*), count(*) filter (where made_for_kids) into total, kids from youtube_broadcasts;
  raise notice 'V482: youtube_broadcasts.made_for_kids backfilled from each row''s connection - % rows, % made for kids, % not',
    total, kids, total - kids;
end
$$;

alter table youtube_broadcasts alter column made_for_kids set not null;

comment on column youtube_broadcasts.made_for_kids is
  'Made for kids: the value Go live sent YouTube when it made the broadcast (selfDeclaredMadeForKids), OR-ed with YouTube''s own status.madeForKids when the end step finalizes it. Per broadcast - a later change of the connection''s flag moves no existing row. A replay with this true is a link out on the public match page, never an embedded player (DP III.E.4.j).';

-- ─── public_fixture_youtube_parts_v: each part carries its flag ────────────────────────────────────────────────────────
-- The public match page reads its parts through this view (server/youtube/parts.ts `replayParts`), so the flag reaches the page the
-- same way the part itself does. `create or replace view` may only append columns, so `made_for_kids` goes LAST and every existing
-- column keeps its name, type and order (fixture_id, video_id, part_no, completed_at); the WHERE, the numbering and the privacy
-- allow-list are V480's, unchanged, and the grant state is untouched (the view is still not granted to app_user: V479's §7 header).
-- A view has no data to move. The flag is the broadcast ROW's own, never the connection's current one.
create or replace view public_fixture_youtube_parts_v as
  select b.fixture_id,
         b.yt_broadcast_id as video_id,
         (row_number() over (partition by b.fixture_id order by b.created_at, b.id))::int as part_no,
         b.completed_at,
         b.made_for_kids
  from youtube_broadcasts b
  join fixtures f     on f.id = b.fixture_id
  join divisions d    on d.id = f.division_id
  join competitions c on c.id = d.competition_id
  where b.state = 'complete'
    and b.privacy in ('unlisted', 'public')
    and d.status <> 'setup'
    and c.visibility in ('public', 'unlisted');
