// The Sponsors hub's refusal copy (final review D3): ONE map from the v1 envelope's machine code to a dictionary key, for the
// On stream tab's tick and dial, Share report's create and revoke and - since sponsor deals T12 - the Sponsors tab's manager and
// the Packages tab's invoice and refund. The server's sentence is English and names internals ("competition not found"), so it
// is never shown; a code this map does not know reads the house fallback. Pure: no hooks, no "use client", like break-labels.ts
// beside it.
import { ApiV1Error } from "@/lib/client-v1";
import type { MessageKey } from "@/lib/messages";

/** The codes the hub's routes refuse with, each to its own words. The first block is the envelope's own status codes
 *  (`statusCode` in server/api-v1/http.ts); the second is the sponsor-deal refusals (sponsor deals T12), whose `HttpError`s
 *  carry their own machine code (server/usecases/sponsors.ts, sponsor-deals.ts, server/sponsors/deal-apply.ts) and reach the
 *  client verbatim as `error.code`. */
export const SAVE_ERROR_MSG: Readonly<Record<string, MessageKey>> = {
  VALIDATION: "sponsors.error.invalid",
  UNAUTHENTICATED: "sponsors.error.signedOut",
  PAYMENT_REQUIRED: "sponsors.error.planRequired",
  FORBIDDEN: "sponsors.error.forbidden",
  NOT_FOUND: "sponsors.error.notFound",
  RATE_LIMITED: "sponsors.error.rateLimited",
  // A live deal owns the sponsor's tier, scope, stream and status; a deal waiting to go live holds its status (D9).
  sponsor_locked_by_deal: "sponsors.error.lockedByDeal",
  sponsor_has_open_deal: "sponsors.error.hasOpenDeal",
  // Delete: money history (paid, refunded, or a pre-deals order) blocks it; so does a payment link nobody could close (F3).
  sponsor_has_deal_history: "sponsors.error.hasDealHistory",
  sponsor_has_open_checkout: "sponsors.error.hasOpenCheckout",
  // Add deal / refund.
  connect_required: "sponsors.error.connectRequired",
  on_payment_needs_payment: "sponsors.error.needsPayment",
  deal_changed: "sponsors.error.dealChanged",
  deal_paid_online: "sponsors.error.dealPaidOnline",
  deal_not_refundable: "sponsors.error.notRefundable",
  deal_disputed: "sponsors.error.dealDisputed",
  stripe_unavailable: "sponsors.error.stripeUnavailable",
};

/** Anything else: another code, a network failure, a body that was not the envelope. */
export const SAVE_ERROR_FALLBACK_MSG: MessageKey = "settings.saveFailed";

/** The key a failed hub write shows. An inherited name (`toString`) is not a code. */
export function sponsorSaveErrorKey(err: unknown): MessageKey {
  return err instanceof ApiV1Error && Object.hasOwn(SAVE_ERROR_MSG, err.code) ? SAVE_ERROR_MSG[err.code]! : SAVE_ERROR_FALLBACK_MSG;
}
