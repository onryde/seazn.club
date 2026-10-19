-- V461 — the capacity work: staggered check-in batches and the check-in line (spec §3.2.1, §5.6.8, §5.7.2; owner decisions
-- C1-C7, 2026-10-15/16).
--
-- Renumber at merge if main has moved past (V462 is r2's, #981, and V463 is W2c's, per the migration ledger of 2026-10-18;
-- V451-V460 are this branch's).
--
-- It does three things.
--
-- 1. `stage_round_opens.staggered` — whether the round's check-in is spread over timed batches (spec §3.2.1). Decided ONCE,
--    at the open, from the camera policy of that moment (required | optional ⇒ true; off ⇒ false: an `off` round spends no
--    vendor calls, so it is one batch) and stored here so a later policy downgrade cannot move a board's open time or
--    deadline underneath a player who was told a time. A row that exists when this lands defaults to false and behaves as
--    it did.
--
-- 2. `fixture_seat_line` — the check-in line's ledger: one row per (fixture, person), a STAY (spec §5.7.2). When the
--    platform's RealtimeKit call budget (V457: one bucket for the whole account) cannot cover every Required seat claim at
--    once, the claims are served first come, first served; the row carries the player's place (arrival), their last
--    gate event (for liveness), the instant admission funded them, and how their stay ended. Every statement that reads
--    its liveness columns lives in server/usecases/external-play/seat-line.ts as one of four named SQL fragments, and a
--    source guard forbids any other (seat-line-one-reader.test.ts).
--
--    Sealed like V451, V457 and V458: RLS enabled AND forced, no policy, no grant for app_user — only the privileged
--    client reaches it (online-chess-video-schema.test.ts reads the catalogue). No org_id: it is not a tenant table (the
--    fixture and person it names are, and are checked by the room's identity before this table is touched). Postgres, and
--    not Redis, because the repo's limiter there is inert wherever Redis is not configured (local dev, e2e, the load test).
--    The row goes with its fixture and with its person, so nothing accumulates and no cleanup job exists to forget.
--
-- 3. V458's `fixture_seat_asks.route` check gains 'line' — AMENDED IN PLACE in V458, not here (spec Q6): no environment has
--    applied V458 (stg was repaired to V438 + V450 and has never held it), and an unmerged migration is amended, not
--    corrected forward. This file therefore carries no third statement; the note is here so a reader looking for the
--    change to that check finds where it went.
alter table stage_round_opens
  add column staggered boolean not null default false;

create table fixture_seat_line (
  fixture_id     uuid not null references fixtures(id) on delete cascade,
  person_id      uuid not null references persons(id)  on delete cascade,
  -- The bucket this player spends from: budgetKey(baseUrl, accountId). The line is per bucket (spec §5.7.6).
  budget_key     text not null,
  -- The stay's ARRIVAL, the line's order key: stamped once per stay, by its first gated claim, whether or not the stay is
  -- ever held. It is the instant that claim's window was judged (the application's clock), never later than the gate's own
  -- reading of the database clock - so a claim judged inside the window never opens a stay dated after the deadline
  -- (seat-line.ts arrivalOf).
  first_claim_at timestamptz not null,
  -- The last gate event and what it was. Liveness is judged from these (seat-line.ts stayLapsedSql): a stay that was HELD
  -- and went silent for LINE_ABANDON_AFTER_MS, or one that PASSED and went silent for LINE_RELEASE_GRACE_MS, is over.
  last_seen_at   timestamptz not null,
  last_gate      text not null check (last_gate in ('held', 'passed')),
  -- The first time the budget held this stay. A stay is IN LINE from here until it is served, ended or lapsed.
  queued_at      timestamptz null,
  -- The last time the gate let a claim spend.
  released_at    timestamptz null,
  -- The instant admission funded this stay (windowed admission, spec §5.7.3): it then holds a reservation of
  -- LINE_RESERVATION tokens, plus LINE_RECHECK_COST while `completing`.
  admitted_at    timestamptz null,
  -- This stay's seat COULD complete its board: the board's other side has an open stay or a counted check-in.
  completing     boolean not null default false,
  -- How service ended: in a seat, or by an answer no wait can fix (camera_blocked, video_unavailable). At most one.
  served_at      timestamptz null,
  ended_at       timestamptz null,
  primary key (fixture_id, person_id),
  constraint fixture_seat_line_queued_after_arrival   check (queued_at   is null or queued_at   >= first_claim_at),
  constraint fixture_seat_line_admitted_after_arrival check (admitted_at is null or admitted_at >= first_claim_at),
  constraint fixture_seat_line_served_after_arrival   check (served_at   is null or served_at   >= first_claim_at),
  constraint fixture_seat_line_ended_after_arrival    check (ended_at    is null or ended_at    >= first_claim_at),
  constraint fixture_seat_line_one_ending             check (served_at is null or ended_at is null)
);

-- The line's ORDER: the stays the budget is holding, oldest arrival first (ties by fixture, then person).
create index fixture_seat_line_order_idx
  on fixture_seat_line (budget_key, first_claim_at, fixture_id, person_id)
  where queued_at is not null and served_at is null and ended_at is null;
-- The RESERVATION sum: the stays admission has funded and that have not ended.
create index fixture_seat_line_reserved_idx
  on fixture_seat_line (budget_key)
  where admitted_at is not null and served_at is null and ended_at is null;

alter table fixture_seat_line enable row level security;
alter table fixture_seat_line force  row level security;
