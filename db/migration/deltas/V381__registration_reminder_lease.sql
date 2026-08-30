-- V381 — RS007 follow-up: the sweep's reminder claim becomes a LEASE, not a
-- permanent mark.
--
-- 648c56503 made both T-24h reminder passes in sweepRegistrations
-- (registrations.ts) claim-before-send: stamp reminded_at /
-- promotion_reminded_at right before minting the checkout + sending, revert
-- it in a `catch` on a thrown send failure. That guarantee ("prefer
-- double-send over lost-send") only holds for a THROWN failure. If the
-- process dies WITHOUT unwinding between the claim committing and the send
-- completing — deploy, OOM, SIGKILL, container eviction — no `catch` ever
-- runs, so the mark stays non-null forever and `where reminded_at is null`
-- never matches that row again. The reminder is lost permanently and the
-- entrant can lapse to the waitlist over a payment deadline they were never
-- told about. That is worse than the double-send the claim exists to
-- prevent, and it is not a rare edge case here:
-- registrations-sweep.yml's own `curl --max-time 60 --retry 2` calls a pass
-- that walks up to 200 rows serially, each doing a Stripe checkout create
-- plus an email, so a run outliving 60s (and its process) is ordinary.
--
-- Two distinct facts need two distinct columns: "someone is currently
-- sending this" (a LEASE that EXPIRES) and "this was actually sent"
-- (PERMANENT — the existing reminded_at / promotion_reminded_at, unchanged).
-- One column cannot carry both, which is why the pre-V381 code was wrong.
-- The claim UPDATE now sets the lease column and only succeeds when the
-- lease is null or stale; a successful send is followed by a separate write
-- to the existing sent column; a thrown failure clears the LEASE (not the
-- sent mark) so the next sweep retries promptly instead of waiting out the
-- window. The "due" SELECT in both passes keeps filtering on the sent
-- column only — the lease is never part of what makes a row eligible, only
-- part of what makes a claim on it succeed. See sweepRegistrations' two
-- passes (registrations.ts) for the read/write side and the chosen lease
-- duration's justification.
--
-- No new index: like reminded_at/promotion_reminded_at themselves, the
-- lease column is only ever touched by a single-row UPDATE keyed on the
-- table's own primary key (`where id = ...`) — never scanned or ordered by.
--
-- Greenfield (RS001 demolition — prod holds zero registration rows): no
-- backfill owed, no NOT NULL to satisfy — an unset lease is correct for
-- every existing row.
alter table registration_groups
  add column if not exists reminder_claimed_at timestamptz;

alter table registrations
  add column if not exists promotion_reminder_claimed_at timestamptz;
