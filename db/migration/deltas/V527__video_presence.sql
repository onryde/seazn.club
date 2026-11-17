-- V527 — webhook presence (check-in capacity design 2026-11-05 §6.2). Renumber at merge if main has moved past.
--
-- WHY. The seat path reads a meeting's participants from the vendor (three calls per seat). RealtimeKit's webhooks tell us
-- the same thing for free: who joined which meeting, and when they left. These three tables keep what the webhooks say.
--
-- WHAT.
--   realtimekit_webhook_deliveries  one row per delivery (the `rtk-uuid` header): a redelivery is recognised, never applied
--                                   twice.
--   fixture_video_presence          one row per (meeting, peer): open while the peer is in the room, closed by its own
--                                   participantLeft (left_by = 'left') or by its session's meeting.ended (left_by = 'ended').
--                                   `seq` is the last tie-break of the presence order (joined_at, received_at, seq), so two
--                                   joins in one millisecond still order. `fixture_id` and `side` are the board and side the
--                                   meeting belonged to when the row was written, kept because a re-pair or a teardown can
--                                   delete the meeting row; null only if the lookup found none.
--   realtimekit_ended_sessions      a session's end, kept so a joined/left that arrives AFTER meeting.ended (a 5xx retried
--                                   late) is stored closed.
--
-- NO FOREIGN KEYS, on purpose: a webhook can name a meeting whose row a re-pair has deleted, and the row must still be kept
-- (§6.2, "never dropped"; the meeting is still in `video_rooms_to_end`). No `org_id` either, so the RLS guard
-- (scripts/check-rls.ts selects org_id tables) never reads these and scripts/rls-exempt.ts is untouched.
--
-- Sealed exactly like V460's `video_rooms_to_end`: RLS enabled AND forced, no policy, no grant for app_user — only the
-- privileged client reaches them (online-chess-video-schema.test.ts reads the catalogue).
create table realtimekit_webhook_deliveries (
  rtk_uuid    text primary key,
  event       text not null,
  received_at timestamptz not null default now()
);
create index realtimekit_webhook_deliveries_received_idx on realtimekit_webhook_deliveries (received_at); -- retention (Task 10b)
alter table realtimekit_webhook_deliveries enable row level security;
alter table realtimekit_webhook_deliveries force  row level security;

create table fixture_video_presence (
  meeting_id            text not null,
  peer_id               text not null,
  -- the board and side the meeting belonged to when the row was written (heldMeeting, Task 5), kept because a re-pair or a
  -- teardown can delete the meeting row; the shadow report and its tests scope by it. null only if the lookup found none.
  fixture_id            uuid null,
  side                  text null check (side in ('home', 'away')),
  participant_id        text null,
  custom_participant_id text not null,
  session_id            text null,
  joined_at             timestamptz null,
  left_at               timestamptz null,
  -- what closed the row: the peer's own participantLeft, or its session's meeting.ended (a row closed only by the end is a
  -- lost-leave witness the shadow report counts); null while open
  left_by               text null check (left_by in ('left', 'ended')),
  source                text not null check (source in ('webhook', 'read')),
  received_at           timestamptz not null default now(),
  -- the last tie-break of the presence order (joined_at, received_at, seq): two joins in one millisecond still order
  seq                   bigserial not null,
  primary key (meeting_id, peer_id)
);
create index fixture_video_presence_live_idx on fixture_video_presence (meeting_id, participant_id) where left_at is null;
create index fixture_video_presence_custom_idx on fixture_video_presence (meeting_id, custom_participant_id);
create index fixture_video_presence_session_idx on fixture_video_presence (meeting_id, session_id) where left_at is null; -- meeting.ended
create index fixture_video_presence_received_idx on fixture_video_presence (received_at); -- retention (Task 10b)
create index fixture_video_presence_fixture_idx on fixture_video_presence (fixture_id, side); -- the shadow report's scope
alter table fixture_video_presence enable row level security;
alter table fixture_video_presence force  row level security;

-- A session's end, kept so a joined/left that arrives AFTER meeting.ended (a 5xx retried late) is stored closed.
create table realtimekit_ended_sessions (
  meeting_id  text not null,
  session_id  text not null,
  ended_at    timestamptz not null,
  received_at timestamptz not null default now(),
  primary key (meeting_id, session_id)
);
create index realtimekit_ended_sessions_received_idx on realtimekit_ended_sessions (received_at); -- retention (Task 10b)
alter table realtimekit_ended_sessions enable row level security;
alter table realtimekit_ended_sessions force  row level security;
