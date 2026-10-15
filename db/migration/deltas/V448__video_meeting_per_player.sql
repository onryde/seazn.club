-- V448 — one RealtimeKit meeting per PLAYER (T17B fix 2, D16; design §5.6, owner ruling "1 per-player").
--
-- Renumber at merge if main has moved past (V443 is W2c's; V444-V447 are this branch's).
--
-- WHY. D7 ("a player sees their own tile only") was enforced by the player's browser alone, and a browser can be tampered
-- with: in a meeting shared by both players, one who calls `subscribe` from the console very likely receives the
-- opponent's camera, and chess events are full of under-18s. With a meeting per player there is no opponent stream to
-- subscribe to, so the guarantee holds on the vendor's side whatever the client does. A player's meeting holds that player
-- and, when one is watching, an arbiter. Nobody else.
--
-- WHAT CHANGES.
--   - A meeting is (fixture_id, side). `side` is the player's ENTRANT side, 'home' or 'away' - fixed for a pairing, unlike
--     the colour, which a `boardgame.pairing` card can swap after a player has arrived. Nothing reads a meeting by colour.
--   - `fixture_video_participants` and `fixture_video_guard_faults` name the side and reference (fixture_id, side), so a
--     participant or a fault can only live on a meeting that exists for its side.
--   - The open-fault rule is per meeting: at most one open fault per person per (fixture, side).
--   - `camera_reported` / `camera_reported_at` on a PLAYER's participant row: the opponent's pill (§5.6.3) is that player's
--     own client's last word on its camera, relayed by our server. The two move together (a state has a stamp and a stamp a
--     state) and an arbiter's row never has one. Nothing reads these but the room snapshot (a source-guard test pins it):
--     not the seat gate, not camera_lost, not the evidence read, not the teardown.
--   - camera_evidence_at stays per row, and so does V442's check (evidence requires ended_at): each meeting settles on its
--     own, while the other may still be live.
--
-- GREENFIELD (RULES.md). The shared-meeting rows are DROPPED, not split, and nothing is backfilled; their participants and
-- guard faults go with them (ON DELETE CASCADE). Prod has no rows: the branch is unmerged.
--
-- THE DEPLOY STEP THAT MUST RUN FIRST (§5.6.7). Every shared meeting with `ended_at is null` is ACTIVE at the vendor and its
-- tokens stay valid until they expire. Dropping the row would orphan it and nothing would ever end it. So before this delta
-- is applied, run `scripts/chess-end-shared-meetings.ts` against the environment (it ends every unended row at the vendor:
-- kick-all, then INACTIVE) until it reports zero failed.
--
-- THE GUARD LIVES HERE, not before the delta. A separate "confirm zero, then apply" leaves a gap: a seat claim landing
-- between the two inserts a row and adds a participant, and the drop then orphans a LIVE meeting with a player's token in
-- it. So this delta's first two statements are the table lock and the guard. Flyway runs it in one transaction: a claim that
-- committed before the lock is seen, the guard raises and NOTHING is dropped (run the script again); a claim that arrives
-- after waits on the lock and then meets the new schema.
--
-- THE GAP BETWEEN MIGRATE AND DEPLOY. Flyway applies this first and the deploy follows; for those minutes the OLD code runs
-- against the NEW schema (its meeting insert has no `side`, and the `on conflict (fixture_id)` it names no longer exists), so
-- a check-in fails with a database error until the deploy lands. Migrate and deploy back to back with no round open.
--
-- Sealed like V439's tables: RLS is already enabled AND forced on all three, with no policy; the new columns inherit it.

lock table fixture_video_meetings in access exclusive mode;

do $guard$
declare
  unended integer;
begin
  select count(*) into unended from fixture_video_meetings where ended_at is null;
  if unended > 0 then
    raise exception
      'V448: % shared video meeting(s) with ended_at null are still ACTIVE at the vendor; dropping them would orphan live rooms. Run scripts/chess-end-shared-meetings.ts against this environment first (chess-end-shared-meetings), then migrate again.',
      unended
      using hint = 'The script ends each unended row at the vendor (kick-all, then INACTIVE) and is safe to run twice.';
  end if;
end
$guard$;

-- Greenfield: the shared rows go (participants and guard faults cascade). The table is empty from here, so the NOT NULL
-- columns below need no backfill.
delete from fixture_video_meetings;

alter table fixture_video_participants drop constraint fixture_video_participants_fixture_id_fkey;
alter table fixture_video_guard_faults drop constraint fixture_video_guard_faults_fixture_id_fkey;

alter table fixture_video_meetings
  add column side text not null check (side in ('home', 'away'));
alter table fixture_video_meetings drop constraint fixture_video_meetings_pkey;
alter table fixture_video_meetings add constraint fixture_video_meetings_pkey primary key (fixture_id, side);

alter table fixture_video_participants
  add column side text not null,
  add column camera_reported text null,
  add column camera_reported_at timestamptz null,
  add constraint fixture_video_participants_fixture_id_side_fkey
    foreign key (fixture_id, side) references fixture_video_meetings (fixture_id, side) on delete cascade,
  add constraint fixture_video_participants_camera_reported_check
    check (camera_reported is null or camera_reported in ('live', 'off')),
  add constraint fixture_video_participants_camera_report_pair_check
    check ((camera_reported is null) = (camera_reported_at is null)),
  add constraint fixture_video_participants_camera_reported_player_check
    check (camera_reported is null or preset = 'player');

alter table fixture_video_guard_faults
  add column side text not null,
  add constraint fixture_video_guard_faults_fixture_id_side_fkey
    foreign key (fixture_id, side) references fixture_video_meetings (fixture_id, side) on delete cascade;

-- The look-ups follow the key: a person's participant on a meeting, the arbiters still watching a meeting, and the one open
-- fault a person may have on a meeting.
drop index fixture_video_participants_person_idx;
create index fixture_video_participants_person_idx on fixture_video_participants (fixture_id, side, person_id);
drop index fixture_video_participants_arbiter_open_idx;
create index fixture_video_participants_arbiter_open_idx
  on fixture_video_participants (fixture_id, side) where preset = 'arbiter' and removed_at is null;
drop index fixture_video_guard_faults_open_idx;
create unique index fixture_video_guard_faults_open_idx
  on fixture_video_guard_faults (fixture_id, side, person_id) where ended_at is null;
