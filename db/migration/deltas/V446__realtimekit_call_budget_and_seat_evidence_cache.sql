-- V446 — RealtimeKit inside its vendor budget (T17B fix 2, D21; review I2).
--
-- Renumber at merge if main has moved past (V443 is W2c's, controller ruling 2026-10-14; V444 and V445 are this
-- branch's).
--
-- WHY. RealtimeKit's REST API allows 1,200 calls per five minutes for the WHOLE account, and past it EVERY call is
-- refused for five minutes: seats, the sweep, the arbiter, for every club. The seat gate asked the vendor about a
-- starting camera every second (four calls a claim), so 50 boards checking in at once could ask for ~6,000 calls in
-- five minutes. Two changes, both here:
--
-- 1. `realtimekit_call_budget` — ONE row per vendor budget (the vendor host + account the calls go to), a token bucket
--    every RealtimeKit REST call spends from (video/budget.ts). It is a Postgres row and not a process counter because Fly runs more than one web machine and
--    the limit is the account's, not a machine's; and not Redis because the repo's limiter there is inert wherever Redis
--    is not configured (local dev, e2e, the D22 load test would measure nothing). A call takes a token in ONE statement
--    (refill by elapsed time, then spend one only if there is one), so concurrent machines can never spend the same
--    token. Only the bucket's STATE is stored: its size and rate are constants in code, and the statement clamps the
--    stored value to them on every use, so retuning needs no migration. A row is made, full, by the first call that
--    finds none, so there is nothing to seed — and a test's fixture vendor (another host:port) gets its own bucket
--    rather than spending the shared one.
--
-- 2. `fixture_video_participants` learns the seat gate's per-participant evidence cache (preflight.ts). A read of a
--    starting camera is four vendor calls, and the seat used to make it on every claim. Now a read is claimed in ONE
--    UPDATE: it is allowed only when none is outstanding or the back-off for the reads so far has passed (1, 2, 4, 8 s —
--    cameraEvidenceDelayMs, shared with the room's own re-ask timer), and a claim inside it is answered from what the
--    last read found (`seat_read_state`, `seat_read_since`) with no vendor call. Only the two not-yet verdicts are cached
--    (`starting`: no evidence yet; `unreadable`: the report could not be read); anything definite — on, off, blocked,
--    absent — clears the cache, so a seat is never answered from a stale pass.
--
-- Sealed like V439's tables: RLS enabled AND forced, no policy, no grant for app_user — only the privileged client
-- reaches it (online-chess-video-schema.test.ts reads the catalogue). The participants table is already sealed; the new
-- columns inherit that.
create table realtimekit_call_budget (
  key         text primary key,
  tokens      double precision not null check (tokens >= 0),
  refilled_at timestamptz not null
);
alter table realtimekit_call_budget enable row level security;
alter table realtimekit_call_budget force  row level security;

alter table fixture_video_participants
  add column seat_read_at    timestamptz null,
  add column seat_reads      integer not null default 0 check (seat_reads >= 0),
  add column seat_read_state text null,
  add column seat_read_since timestamptz null,
  -- No read outstanding means no cache: the clear writes all four together.
  add constraint fixture_video_participants_seat_read_check check (
    seat_reads > 0 or (seat_read_at is null and seat_read_state is null and seat_read_since is null)
  ),
  -- Only the two not-yet verdicts are ever cached, and a cached verdict always knows when its peer joined (the deadline
  -- is judged from it on every claim). `is not null` is explicit: a CHECK that evaluates to NULL PASSES, so a since with
  -- no state would otherwise slip through the second branch.
  add constraint fixture_video_participants_seat_read_state_check check (
    (seat_read_state is null and seat_read_since is null)
    or (seat_read_state is not null and seat_read_state in ('starting', 'unreadable') and seat_read_since is not null)
  );
