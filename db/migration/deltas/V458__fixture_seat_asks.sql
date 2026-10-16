-- V458 — a per-seat limit on the match room's seat and camera doors (T17B fix 2, D21-fix-4; review I2).
--
-- Renumber at merge if main has moved past (V443 is W2c's; V455-V457 are this branch's).
--
-- WHY. Every seat claim and every camera-token ask can cost the platform's RealtimeKit budget (V457: ONE bucket for the
-- whole account), and both routes answer to any signed-in player of a board. A player with a hand-rolled client could ask at
-- twenty requests a second, keep the bucket empty, and turn every club's check-in into `camera_starting` while the sweep's
-- retries found no token to spend. The limit is PER SEAT - one (fixture, person) pair, per door - so one player's loop can
-- never spend another's asks.
--
-- WHY POSTGRES. The repo's limiter (lib/rate-limit.ts) is Redis-only and INERT wherever Redis is not configured (local
-- dev, the e2e suite, any environment without REDIS_URL), and it fails OPEN on a Redis blip - so a limit built on it would
-- not hold where this one is tested, nor when it is needed. One UPSERT counts an ask and decides, so concurrent machines
-- cannot pass more than the limit between them (the row lock serialises them). Only the window's STATE is stored: its
-- length and the limits are constants in code (server/external-play/seat-ask-limit.ts), applied on every use, so retuning
-- needs no migration.
--
-- THE LIFECYCLE IS THE FIXTURE'S. The row goes with its fixture and with its person, so nothing accumulates past the
-- boards that earned it, and no cleanup job exists to forget.
--
-- Sealed like V457's `realtimekit_call_budget`: RLS enabled AND forced, no policy, no grant for app_user - only the
-- privileged client reaches it (online-chess-video-schema.test.ts reads the catalogue). No org_id: it is not a tenant table
-- (the person and fixture it names are, and are checked by the room's identity before this table is touched).
create table fixture_seat_asks (
  fixture_id        uuid not null references fixtures(id) on delete cascade,
  person_id         uuid not null references persons(id)  on delete cascade,
  -- The two doors. A closed set on purpose: a third is a code change AND a migration, so a new door cannot ship unlimited
  -- by forgetting to ask for a limit.
  route             text not null check (route in ('seat', 'camera')),
  -- When the current window opened (a fixed window, anchored on the first ask after the last one closed), and how many asks
  -- it has taken. A refused ask is counted too and never moves the window, so hammering cannot keep a seat shut past it.
  window_started_at timestamptz not null,
  asks              integer not null check (asks >= 1),
  primary key (fixture_id, person_id, route)
);
alter table fixture_seat_asks enable row level security;
alter table fixture_seat_asks force  row level security;
