-- =============================================================================
-- V512 — a refund's cap is THIS entry's current payment (registration polish wave P5, P1-review carry b).
--
-- `registrations.refunded_cents` (V368) is the entry's whole refund HISTORY. A late payment (the entry had lapsed, expired or
-- been withdrawn when Stripe completed its session) is refunded automatically and booked there too - and a re-promotion resets
-- the fee but never that column. So a re-promoted entry that then paid in time read as already refunded: the organiser's Refund
-- answered "Already fully refunded", and a withdrawal before the lock refunded nothing, while the new payment sat untouched.
--
-- `late_refunded_cents` is the part of that history that sent back a LATE payment - never the entry's current payment, which a
-- late outcome never stamps on the entry. The refund cap of the current payment is `amount_cents - (refunded_cents -
-- late_refunded_cents)`; the history column is unchanged.
--
-- DATA MOVE (loud): existing late refunds are read back from their audit rows (`registration.refunded`, mode `late_payment`,
-- the rows `lateRefundAlreadyMade` and the payment page already key on) and booked into the new column.
-- =============================================================================

alter table registrations add column late_refunded_cents integer not null default 0;
alter table registrations add constraint registrations_late_refunded_cents_nonneg check (late_refunded_cents >= 0);

update registrations r
   set late_refunded_cents = s.cents
  from (select payload->>'registration_id' as rid, sum((payload->>'amount_cents')::int) as cents
          from competition_events
         where type = 'registration.refunded' and payload->>'mode' = 'late_payment'
         group by 1) s
 where r.id::text = s.rid;
