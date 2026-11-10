// The Sponsors hub's refusal copy (final review D3): ONE map from the v1 envelope's machine code to a dictionary key, for the
// On stream tab's tick and dial, Share report's create and revoke and - since sponsor deals T12 - the Sponsors tab's manager and
// the Packages tab's invoice, resend, end and refund. The server's sentence is English and names internals ("competition not
// found"), so it is never shown; a code this map does not know reads the house fallback. Pure: no hooks, no "use client", like
// break-labels.ts beside it.
import { ApiV1Error } from "@/lib/client-v1";
import type { MessageKey } from "@/lib/messages";
import type { SponsorRefusalCode } from "@/lib/sponsor-refusals";

/** The envelope's own status codes the hub's routes refuse with (`statusCode` in server/api-v1/http.ts). */
type EnvelopeCode = "VALIDATION" | "UNAUTHENTICATED" | "PAYMENT_REQUIRED" | "FORBIDDEN" | "NOT_FOUND" | "RATE_LIMITED";

/** The codes the hub's routes refuse with, each to its own words. The first block is the envelope's own status codes; the
 *  rest is EVERY sponsor, package and deal refusal (batch F review m2): a Record over `SPONSOR_REFUSAL_CODES`
 *  (lib/sponsor-refusals.ts, the list the server builds its coded refusals from), so a code with no words does not compile. */
export const SAVE_ERROR_MSG: Readonly<Record<EnvelopeCode | SponsorRefusalCode, MessageKey>> = {
  VALIDATION: "sponsors.error.invalid",
  UNAUTHENTICATED: "sponsors.error.signedOut",
  PAYMENT_REQUIRED: "sponsors.error.planRequired",
  FORBIDDEN: "sponsors.error.forbidden",
  NOT_FOUND: "sponsors.error.notFound",
  RATE_LIMITED: "sponsors.error.rateLimited",
  // A live deal owns the sponsor's tier, scope, stream and status; a deal waiting to go live holds its status (D9); an open
  // dispute holds a parked placement down.
  sponsor_locked_by_deal: "sponsors.error.lockedByDeal",
  sponsor_has_open_deal: "sponsors.error.hasOpenDeal",
  sponsor_dispute_parked: "sponsors.error.disputeParked",
  // Delete: money history (paid, refunded, or a pre-deals order) blocks it; so does a payment link nobody could close (F3).
  sponsor_has_deal_history: "sponsors.error.hasDealHistory",
  sponsor_has_open_checkout: "sponsors.error.hasOpenCheckout",
  // Add deal.
  package_retired: "sponsors.error.packageRetired",
  scope_outside_package: "sponsors.error.scopeOutsidePackage",
  competition_finished: "sponsors.error.competitionFinished",
  connect_required: "sponsors.error.connectRequired",
  sponsor_email_required: "sponsors.error.emailRequired",
  ends_on_in_past: "sponsors.error.endsOnInPast",
  on_payment_needs_payment: "sponsors.error.needsPayment",
  // A deal action the deal does not offer, or a deal that moved under it.
  deal_already_paid: "sponsors.error.dealAlreadyPaid",
  deal_ended: "sponsors.error.dealEnded",
  deal_not_payable: "sponsors.error.dealNotPayable",
  deal_not_awaiting_approval: "sponsors.error.notAwaitingApproval",
  deal_not_refundable: "sponsors.error.notRefundable",
  deal_disputed: "sponsors.error.dealDisputed",
  deal_not_invoiceable: "sponsors.error.notInvoiceable",
  deal_changed: "sponsors.error.dealChanged",
  illegal_transition: "sponsors.error.dealChanged",
  // Mark as paid's refusal (F37): the sponsor's own payment is in flight. Resend says it its own way (below).
  deal_paid_online: "sponsors.error.dealPaidOnline",
  // Refund, End now, Mark as paid: Stripe failed before anything was written. A create and a Resend say it their own way.
  stripe_unavailable: "sponsors.error.stripeUnavailable",
};

/** A write whose refusal means something else than the shared words say, for one or two codes. */
export type SponsorWrite = "create_deal" | "create_deal_ending" | "resend_invoice";

/** Which create a refusal came from: the Add deal sheet asks to end the sponsor's live deal (`end_current`) in the same call or not,
 *  and a 502 means something different in each (below). */
export function createDealWrite(endCurrent: boolean): SponsorWrite {
  return endCurrent ? "create_deal_ending" : "create_deal";
}

/** Per-write words, consulted before the shared map (batch F review I1, m7). */
export const SAVE_ERROR_BY_WRITE: Readonly<Record<SponsorWrite, Partial<Record<SponsorRefusalCode, MessageKey>>>> = {
  // A create that does NOT end the current deal: its only Stripe call is the invoice, sent AFTER the deal is saved (createDeal,
  // F11), so a 502 there leaves a saved draft, which Send invoice sends.
  create_deal: { stripe_unavailable: "sponsors.error.invoiceSavedNoLink" },
  // A create that ends the current deal (`end_current`, Task 16) has a SECOND Stripe call, before anything is written: closing the
  // live deal's pay link. A 502 is therefore either "nothing was saved" or "the deal is saved, its invoice is not sent", and the
  // answer does not say which - so the words send the organiser to look at the sponsor's deals rather than promise either.
  create_deal_ending: { stripe_unavailable: "sponsors.error.invoiceNotSentCheck" },
  // Resend may close the old link before Stripe fails to make the new one, so "nothing was changed" is not certain; and a
  // stored session already paid is the sponsor's payment on its way, not a hand-marked one.
  resend_invoice: {
    stripe_unavailable: "sponsors.error.resendStripeUnavailable",
    deal_paid_online: "sponsors.error.resendPaidOnline",
  },
};

/** Anything else: another code, a network failure, a body that was not the envelope. */
export const SAVE_ERROR_FALLBACK_MSG: MessageKey = "settings.saveFailed";

/** The key a failed hub write shows: the write's own words for its code, else the shared words, else the fallback. An
 *  inherited name (`toString`) is not a code. */
export function sponsorSaveErrorKey(err: unknown, write?: SponsorWrite): MessageKey {
  if (!(err instanceof ApiV1Error)) return SAVE_ERROR_FALLBACK_MSG;
  const own = write === undefined ? undefined : SAVE_ERROR_BY_WRITE[write];
  if (own && Object.hasOwn(own, err.code)) return own[err.code as SponsorRefusalCode]!;
  return Object.hasOwn(SAVE_ERROR_MSG, err.code) ? SAVE_ERROR_MSG[err.code as keyof typeof SAVE_ERROR_MSG] : SAVE_ERROR_FALLBACK_MSG;
}
