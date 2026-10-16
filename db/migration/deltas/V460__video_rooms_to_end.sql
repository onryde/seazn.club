-- V460 — rooms nothing tracks any more (D16 fix-2, review residual 2).
--
-- Renumber at merge if main has moved past (V443 is W2c's; V455-V459 are this branch's).
--
-- WHY. A `fixture_video_meetings` row is the ONLY thing that tracks an ACTIVE vendor room, and it cascades away with its
-- fixture. Four writes delete fixtures (a stage deleted; Rebuild fixtures; a Swiss round reshaped to a smaller field; the
-- undo of a generation or a pool clear), and every wider delete (a division, a competition, an organisation) does too.
-- Each leaves up to two rooms per board ACTIVE at the vendor with live player tokens in them, and nothing would ever end
-- them: the row that named the room is gone, so neither the sweep nor a claim can find it. The delete cannot end the room
-- itself - a vendor call cannot sit inside the transaction that holds the division lock - and the caller cannot collect the
-- rows first without reading a sealed table from inside an app_user transaction at every site.
--
-- WHAT. Deleting an un-ended meeting row parks its room here, in the SAME transaction, whichever statement deleted it
-- (an explicit delete, or any cascade above it, including from paths not yet written). The sweep ends each parked room at
-- the vendor (kick-all, then INACTIVE) and deletes the row only after the end succeeded, so a refused end (an outage, the
-- platform's call budget) is asked again by the next pass. An ENDED row parks nothing: its room is already closed.
--
-- NO FOREIGN KEYS, on purpose. The fixture is gone (that is the point), and the organisation may be going: an organisation
-- delete cascades to the very meeting rows that fire the trigger, and a foreign key on `org_id` would make that delete
-- fail. `fixture_id` and `side` are for the log line only; `org_id` scopes the sweep's test seam.
--
-- Sealed like V457's `realtimekit_call_budget`: RLS enabled AND forced, no policy, no grant for app_user - only the
-- privileged client reaches it (online-chess-video-schema.test.ts reads the catalogue). It carries an org_id, so it is
-- exempt by name in scripts/rls-exempt.ts, as `fixture_video_meetings` is.
--
-- The trigger function is security definer with a pinned search_path (the V306 / V451 shape): the delete that fires it
-- may run as app_user (a stage delete under withTenant), which holds no privilege on this sealed table. It only INSERTs
-- the row being deleted, and never fails the delete (`on conflict do nothing`).
create table video_rooms_to_end (
  meeting_id text primary key,
  fixture_id uuid not null,
  side       text not null check (side in ('home', 'away')),
  org_id     uuid not null,
  created_at timestamptz not null default now()
);
create index video_rooms_to_end_org_idx on video_rooms_to_end (org_id);
alter table video_rooms_to_end enable row level security;
alter table video_rooms_to_end force  row level security;

create function park_video_room_to_end() returns trigger
  language plpgsql security definer
  set search_path = ${flyway:defaultSchema}, pg_temp as $$
begin
  insert into video_rooms_to_end (meeting_id, fixture_id, side, org_id)
  values (old.meeting_id, old.fixture_id, old.side, old.org_id)
  on conflict (meeting_id) do nothing;
  return null;
end $$;

create trigger fixture_video_meetings_park_room
  after delete on fixture_video_meetings
  for each row when (old.ended_at is null)
  execute function park_video_room_to_end();
