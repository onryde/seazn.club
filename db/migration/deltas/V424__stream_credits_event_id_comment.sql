-- V424 — Streaming R1: say what org_stream_credits.stripe_event_id actually holds.
--
-- Lane B carry M7 (lane D amendment D4). The column's NAME says "Stripe event
-- id"; it has never held one. The webhook writes the Checkout SESSION id
-- (`cs_…`) into it — billing-events.ts `recordPurchase({ stripeEventId:
-- session.id })` → stream-credits.ts `insert … stripe_event_id … on conflict
-- (stripe_event_id) do nothing` — because the session id is the one id every
-- delivery of a purchase carries (billing-events.ts, both comments): a
-- re-claimed or staff-replayed event, and the async_payment_succeeded event a
-- delayed payment method sends for the same session, are different event ids
-- for one purchase. stripe_checkout_session_id (V410, ruling 13 item 6) holds the same
-- value as the purchase row's Stripe link. stream-credits-webhook.test.ts pins
-- the fact through the real webhook (stripe_event_id = stripe_checkout_session_id
-- = the cs_ id); migration-shape.test.ts reads these comments back.
--
-- Comments only, no rename: a rename touches seven files (the webhook, the
-- credit writer, their tests) for no behaviour change, and V410 is merged. A
-- FORWARD delta, not an amend. COMMENT ON rewrites no rows and takes no lock
-- beyond the catalogue's.
comment on column org_stream_credits.stripe_event_id is
  'Stripe Checkout Session id (cs_…), the purchase idempotency key (unique; any further event for the same session writes nothing). NOT a Stripe event id, despite the name. Set on purchase rows only; holds the same value as stripe_checkout_session_id.';

comment on column org_stream_credits.stripe_checkout_session_id is
  'Stripe Checkout Session id (cs_…) — the purchase row''s Stripe link (ruling 13 item 6). Same value as stripe_event_id, which is the idempotency key; this column is the link, that one the key.';
