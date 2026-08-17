-- =============================================================================
-- V367 — per-entry refunds: registrations.refunded_cents
--
-- RS001 moved the whole payment envelope — including refunded_cents — from
-- registrations to registration_groups (V364). That is exactly right while a
-- cart can only ever hold one entry, which is all that exists today: nothing
-- creates a multi-entry cart until RS002/RS003 ship group submit. The block
-- comment above RegistrationWithGroupRow (apps/web/src/server/usecases/
-- registrations.ts) flagged three call sites that read or write the cart's
-- refunded_cents as if it were THIS ONE entry's own refund state — exact
-- today, wrong the moment a cart holds two entries: refunding one entry would
-- claw back its siblings' money, overwrite the cart's accumulated total
-- instead of adding to it, or report a sibling as "already fully refunded".
--
-- This is the decision RS001 deliberately deferred (same comment): per-entry
-- refunds get their OWN column rather than being derived from the cart's.
-- registration_groups.refunded_cents is UNCHANGED by this migration — it
-- stays the cart's accumulated refund total, written additively, never
-- overwritten and never sourced FROM this new column. No per-entry
-- refunded_at: a cart's last-refund timestamp is enough, and a second clock
-- per entry is deliberately out of scope here.
--
-- Same non-negative guard as registration_groups.refunded_cents
-- (registration_groups_refunded_nonneg, V363) for the same reason: a refund
-- can only ever add to what has already gone out.
-- =============================================================================

alter table registrations add column refunded_cents integer not null default 0;
alter table registrations add constraint registrations_refunded_nonneg check (refunded_cents >= 0);
