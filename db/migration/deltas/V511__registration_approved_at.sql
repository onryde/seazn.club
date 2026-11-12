-- =============================================================================
-- V511 — the organiser's approval is recorded apart from the payment (registration polish wave P5, walkthrough W12).
--
-- On a manual-approval division Approve and Mark paid were one decision: Approve refused an unpaid entry ("mark it paid first")
-- and Mark paid confirmed it outright, so an organiser could not approve an entry and leave its fee due, nor record a payment
-- without approving. `approved_at` is the moment the organiser approved an entry that still owed its fee; the entry stays
-- `pending` (payment due) until the money lands, and the payment (card webhook or Mark paid) then confirms it. An entry marked
-- paid before it is approved stays `paid` (awaiting approval) until Approve confirms it. Both, in either order -> confirmed.
--
-- No backfill: no entry was ever approved without being confirmed in the same step.
-- =============================================================================

alter table registrations add column approved_at timestamptz;
