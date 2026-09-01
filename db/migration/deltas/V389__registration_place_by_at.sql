-- RS012 ruling 2 — the pool's own deadline.
--
-- A solo sign-up ("free agent") is promised, at sign-up, that "the organiser
-- will assign you to a team once one has space" (register.details.freeAgent
-- copy, RS006). If that never happens, the owner's ruling is that the
-- registrant's money back is the only honest outcome: the organiser may
-- place them, or extend this date, right up to it — but once it passes with
-- nobody having placed them, `sweepRegistrations` withdraws and refunds them
-- (reusing the expiry sweep machinery RS002 already proved, not a second
-- money path).
--
-- No CHECK constraint and no default: this is a greenfield table (zero prod
-- registration rows, per AGENTS.md), so NULL is the correct value for every
-- row until an organiser explicitly sets one — there is nothing to backfill
-- and nothing to guard against. NULL means "no explicit date" and is
-- resolved to the division's own `closes_at` at READ time (coalesce), never
-- backfilled into this column itself, so a later change to `closes_at`
-- keeps moving the effective deadline for every division that never set an
-- explicit one.
alter table registration_settings
  add column place_by_at timestamptz;

comment on column registration_settings.place_by_at is
  'RS012: after this passes, an unplaced solo sign-up is auto-refunded and withdrawn. NULL = defaults to closes_at (the division''s own registration close) at read time.';
