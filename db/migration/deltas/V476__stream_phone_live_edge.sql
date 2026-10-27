-- V476 — Owed 108 fix (b), web half: tell the relay when the phone is live AGAIN.
--
-- The relay (the Fly compositor) is outbound-only: it POSTs a heartbeat about every 5 s and web can answer only in that
-- reply. When the phone's connection returns after an outage the relay is waiting out its own back-off; the heartbeat reply
-- carries `phoneLiveEdge`, a per-session counter the relay acts on once per INCREASE (docs/contracts/relay-job.v1.json
-- `$defs.heartbeatReply`). The counter must be monotonic for the life of the session and must survive a restart, so it is
-- stored — never held in memory (server/relay/domain/phone-live.ts is the pure rule, capture-phone.ts `postBeat` the only
-- writer, stream-sessions.ts `heartbeat` the only reader).
--
--   * phone_live_edge     — NULL until the session's phone has been live once (no phone, or a phone that has not published
--                           yet: the reply omits the field). 0 at the first-ever live beat — there was no outage to recover
--                           from, so the first live does not count. +1 for each later not-live → live edge.
--   * phone_live          — whether the last IN-ORDER beat of the session's phone reported a live state. The previous side
--                           of the edge. Kept apart from `phone_beat`, which a late beat still overwrites: the edge must not
--                           be moved by a beat the phone sent BEFORE one that was already applied.
--   * phone_live_beat_at  — the phone's own `at` of that beat (UTC). A beat whose `at` is EARLIER than this is a late delivery
--                           and is not applied; an equal `at` is (whole-second timestamps can be shared by two beats), and a
--                           duplicate of the last beat carries the state already held, so it is no edge.
--
-- Every existing row reads NULL in all three: no session has a recorded phone-live history, and the reply omits the field
-- for it, which is what it did before.
alter table fixture_stream_sessions
  add column phone_live_edge integer,
  add column phone_live boolean,
  add column phone_live_beat_at timestamptz;

-- The three move together. A counter implies the phone was seen (live, and when); the two last-beat facts are written as a
-- pair. A row that breaks this would read as an edge from nothing (or a counter with no side to compare), so the table
-- refuses it instead of the reader guessing.
alter table fixture_stream_sessions
  add constraint fixture_stream_sessions_phone_live_edge_ck check (
    (phone_live is null) = (phone_live_beat_at is null)
    and (phone_live_edge is null or (phone_live_edge >= 0 and phone_live is not null))
  );
