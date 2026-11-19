-- V531 — index the ledger rows a registrant's dispute state is read from. Renumber at merge if main has moved past.
--
-- WHY. The organiser's registrations list (`listRegistrations`) now reads each entry's chargeback state PER ENTRY PAYMENT
-- (`disputeOutcomeSql`, registrations/disputes.ts, registration defects fix round 3): for every row it probes
-- `competition_events` for that entry's `payment_intent_id` among the `registration.disputed` / `registration.dispute_lost` rows, and (only
-- when a dispute exists) the `registration.dispute_won` row of that dispute. The only index on the table is
-- (competition_id, created_at), so each probe walked EVERY ledger row of the competition and filtered it: measured on a copy of the
-- shape (500 entries, ~7,400 events on one competition) the list's dispute column cost ~254 ms, ~68,900 buffers, growing with
-- entries x events. The same lookup is the refund guard (`entryPaymentLost`), asked under a lock on every refund.
--
-- WHAT. Two PARTIAL indexes, holding only the few dispute rows, never the reminders / submissions / payments that make up the
-- ledger's bulk:
--   * (competition_id, payload->>'payment_intent_id') for the `disputed` and `dispute_lost` rows (the by-intent probes);
--   * (competition_id, payload->>'dispute_id') for the `dispute_won` rows (the by-dispute probe).
-- Both predicates are the literal types the queries name, so the planner proves them from `type = '...'`.
--
-- Plain CREATE INDEX (not CONCURRENTLY: Flyway runs each delta in a transaction). It takes a SHARE lock on competition_events for
-- the build, which blocks ledger writes for that moment; the indexes are partial (a handful of rows) so the build is a scan and
-- an instant sort. Same trade V425 made.
create index competition_events_reg_dispute_intent_idx
  on competition_events (competition_id, (payload->>'payment_intent_id'))
  where type in ('registration.disputed', 'registration.dispute_lost');

create index competition_events_reg_dispute_won_idx
  on competition_events (competition_id, (payload->>'dispute_id'))
  where type = 'registration.dispute_won';
