-- V532: one LIVE arbiter participant per organizer per player meeting (capacity design §6.5).
-- Today every open minted a row, so a database may hold several live rows per (fixture, side, user): stamp all but the newest
-- removed FIRST, then build the index. A row stamped here gets no vendor removal (SQL cannot call the vendor), so it is safe only
-- where no vendor call is owed: on an ENDED meeting the teardown already kicked everyone and INACTIVE keeps every token out (the
-- sweep's own rule, job 6: "a watch whose room has ended needs no vendor call"). A duplicate on a LIVE meeting is stamped too
-- (the index cannot be built over it) and COUNTED: its participant then lives at the vendor until that meeting's teardown kick-all,
-- out of reach of the sweep's revocations. Accepted and bounded: apply when no online round is in check-in or play, so the count is 0.
do $$
declare live_orphans int;
begin
  select count(*) into live_orphans
    from fixture_video_participants p
    join fixture_video_meetings m on (m.fixture_id, m.side) = (p.fixture_id, p.side)
   where p.preset = 'arbiter' and p.removed_at is null and m.ended_at is null
     and exists (select 1 from fixture_video_participants q
                  where q.preset = 'arbiter' and q.removed_at is null
                    and (q.fixture_id, q.side, q.user_id) = (p.fixture_id, p.side, p.user_id)
                    and (q.created_at, q.id) > (p.created_at, p.id));
  if live_orphans > 0 then
    raise warning 'V532: % live arbiter duplicates stamped removed without a vendor removal; they end at their meeting''s teardown', live_orphans;
  end if;
end $$;
update fixture_video_participants p set removed_at = now()
 where p.preset = 'arbiter' and p.removed_at is null
   and exists (select 1 from fixture_video_participants q
                where q.preset = 'arbiter' and q.removed_at is null
                  and (q.fixture_id, q.side, q.user_id) = (p.fixture_id, p.side, p.user_id)
                  and (q.created_at, q.id) > (p.created_at, p.id));
create unique index fixture_video_participants_arbiter_live_idx
  on fixture_video_participants (fixture_id, side, user_id)
  where preset = 'arbiter' and removed_at is null;
