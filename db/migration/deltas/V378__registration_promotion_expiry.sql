-- V378 — a promoted-from-waitlist entry gets its OWN payment deadline
-- (RS007). RS001 moved expires_at to registration_groups (cart-level);
-- promoteWaitlistedRow extends that SHARED deadline on every promotion, so
-- promoting one entry in a multi-entry cart silently extends (and later
-- expires) every sibling's deadline too — wrong the moment a cart holds more
-- than one entry, since pay-on-promotion mints a checkout for a single
-- entry. promotion_expires_at is that entry's own clock, added alongside
-- the cart's (unchanged) expires_at rather than replacing it: the cart's
-- deadline still governs never-paid submits, this one governs promotions.
--
-- waitlisted_at marks when a row (re)joined the waitlist. Null for a row
-- that has never lapsed — promoteOldestWaitlisted falls back to created_at
-- for those, so a fresh waitlist join is unaffected. A row that lapses past
-- its promotion_expires_at gets waitlisted_at = now(), which sorts it BEHIND
-- everyone who has been waiting since before that moment (the waitlist
-- tail), rather than letting it re-claim its original place in line.
--
-- Greenfield (RS001 demolition — prod holds zero registration rows): no
-- backfill owed, no NOT NULL to satisfy.
alter table registrations
  add column if not exists promotion_expires_at timestamptz,
  add column if not exists waitlisted_at         timestamptz;

-- Mirrors registrations_expiry_idx (V273__registration_payments.sql:50-51):
-- only a promoted pending row ever carries promotion_expires_at, so the
-- sweep's lapse query (status='pending' and promotion_expires_at < now())
-- hits a small, targeted index instead of scanning every pending row.
create index if not exists registrations_promotion_expiry_idx
  on registrations(promotion_expires_at)
  where status = 'pending' and promotion_expires_at is not null;
