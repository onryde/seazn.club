import "server-only";
// Stripe event processing (extracted from the webhook route so the staff
// console can replay events): one dispatch table, shared by the signed
// webhook POST and the admin "process now" path. billing_events is the
// idempotency ledger — received_at set on arrival, processed_at only after
// the handler ran, so a NULL processed_at is a stuck event and a missing row
// is an event we never received (the deleted-endpoint incident class).
//
// Split by concern (src/server/MODULARIZATION.md). This barrel re-exports
// exactly the public surface the single file had; siblings never import it.
//   event-types       the event types handled, and which arrive Connect-scoped
//   dispatch          processStripeEvent — the dispatch table
//   ledger            billing_events: claim/run, replay, stuck-event sweep, reads
//   checkout          checkout.session.completed (packs, passes, subscriptions)
//   subscriptions     customer.subscription.* and payment-method mirroring
//   invoices          invoice.payment_failed / payment_succeeded, renewal true-up
//   refunds           charge.refunded: pass revoke, AI pack + match-credit claw-back
//   disputes          platform-charge disputes
//   connect           Connect payout health and external-account changes
//   addon-sync        seat / extra-org add-on rows from subscription items
//   addon-pricing     extra-org rider re-pricing and its reconciliation sweep
//   group-resolution  which billing group / org a Stripe object belongs to
//   staff-alerts      the staff alerts queued on the email outbox
export { HANDLED_EVENT_TYPES, CONNECT_SCOPED_EVENT_TYPES } from "./event-types";
export { processStripeEvent } from "./dispatch";
export {
  eventStatus,
  runEvent,
  replayEvent,
  ledgerByIds,
  sweepStuckEvents,
  stuckLedgerEvents,
} from "./ledger";
export type { LedgerRow, EventStatus } from "./ledger";
export type { GroupResolution } from "./group-resolution";
export { syncSeatAddonsForSubscription, syncOrgAddonsForSubscription } from "./addon-sync";
export {
  convergeOrgAddonPrices,
  ORG_PRICE_SWEEP_ALERT_CAP,
  sweepStaleOrgAddonPrices,
} from "./addon-pricing";
export type { OrgAddonPriceMismatch } from "./addon-pricing";
export { queuePassRevokedEmail } from "./refunds";
export {
  alertCreditPackGrantFailed,
  alertSizePackGrantFailed,
  maybeAlertOrgRepriceFailed,
  alertStreamClawback,
  notifyStaffDispute,
  alertConnectBankRemoved,
  alertStuckEventParked,
} from "./staff-alerts";
export type { StreamClawbackAlert } from "./staff-alerts";
