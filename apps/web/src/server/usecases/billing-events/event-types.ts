import "server-only";
// Stripe event processing: which event types the dispatch acts on (see ./index.ts).

/** Every event type the dispatch below acts on — also the filter the staff
 *  console asks Stripe for. Anything else is silently ACKed. */
export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  // Delayed-notification payment methods (registrations, W3b): the completed
  // event can arrive while the session is still unpaid, so these two carry
  // the actual outcome. Stripe skill, "Webhooks and fulfillment".
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "invoice.payment_succeeded",
  "account.updated",
  "charge.dispute.created",
  "charge.dispute.closed",
  // A dispute took the money (a formal chargeback at once, or an inquiry the
  // network escalated). Sponsor placements only: an inquiry leaves the
  // placement live, and this is what parks it (owner, 2026-10-26).
  "charge.dispute.funds_withdrawn",
  "charge.refunded",
  // Sponsor package orders (v10): activation keys off the PaymentIntent
  // because the intent metadata carries kind/order_id. Non-sponsor intents
  // (entry fees, passes) are ignored inside the handlers.
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  // Cards added/removed/promoted in the STRIPE DASHBOARD (support, or the org
  // via an emailed invoice). Without these the has_payment_method mirror only
  // tracks in-app changes and the trial banner asks for a card that exists.
  "payment_method.attached",
  "payment_method.detached",
  "customer.updated",
  // Payout health (V411), all CONNECT-scoped — they describe the club's own
  // Stripe account and arrive on the connected-accounts destination, so the
  // account id is on `event.account` and never on the object.
  //
  // `payouts_enabled` answers whether Stripe is WILLING to pay out. None of
  // these three do, and that is the gap: an account reporting
  // `payouts_enabled: true` throughout is exactly the state a club sits in
  // while its payouts bounce off a closed bank account.
  "payout.paid", // the positive direction — money landed, so CLEAR the alert
  "payout.failed", // a real transfer bounced; account.updated says nothing
  "account.external_account.updated", // the destination bank changed under us
  "account.external_account.deleted", // ...or is gone entirely
  // Trial ending (V411): the ONLY warning a trialing org gets before the first
  // charge. Without it a no-card trial silently cancels (missing_payment_method:
  // "cancel") and a card-on-file trial charges unannounced — neither is an event
  // anything else in this table emits, because Stripe sends it three days AHEAD
  // of any subscription state change.
  "customer.subscription.trial_will_end",
] as const;

/**
 * Which of `HANDLED_EVENT_TYPES` are delivered on the CONNECTED-ACCOUNTS
 * destination rather than the platform's own.
 *
 * This is not documentation — it is the one fact about this file that cannot
 * be discovered by reading it. Stripe splits "Your account" and "Connected
 * accounts" into two destinations with two signing secrets, and subscribing an
 * event on the WRONG one does not error: Stripe simply never delivers it, and
 * the handler below sits there looking correct for ever. `account.updated`
 * already cost this repo that discovery once (see the webhook route's comment).
 *
 * Two consequences for anything added here:
 *   - Its object does NOT carry the connected account id. `event.account`
 *     does, and it is the only place it appears — a handler that reads
 *     `object.id` (as `account.updated` legitimately does, because THAT
 *     object IS the account) mirrors onto nothing for every other type.
 *   - The live endpoint has to be updated too. The code and the destination
 *     are one change, not two, and nothing in CI can see the second half.
 *
 * Live endpoints as of 2026-09-20 — connected accounts:
 * `we_1UHrDBAy22H0xqqxTTsYxYz9` (prod), `we_1UHkJNAy22H0xqqxtn4AK7L4` (stg);
 * your account: `we_1UHrCsAy22H0xqqxMn5vwx1S` (prod),
 * `we_1UHkJMAy22H0xqqxqjGcjPKL` (stg).
 */
export const CONNECT_SCOPED_EVENT_TYPES = [
  "account.updated",
  "payout.paid",
  "payout.failed",
  "account.external_account.updated",
  "account.external_account.deleted",
] as const;
