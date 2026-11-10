// Sponsor deals (batch F review m2): EVERY machine code the sponsor, package and deal routes refuse with, in ONE list. The
// server builds each coded refusal through `sponsorRefusal`, whose `code` is typed against this list, so a new code cannot be
// thrown that way without joining it; the console's refusal map (components/sponsors/save-error.ts) is a Record over the
// list, so tsc refuses a code with no words; and save-error.test.ts walks the list through the real v1 handler at runtime.
// A refusal with no code (a 404, a 400) reads by its status (`statusCode` in server/api-v1/http.ts) and is not listed here.
// Client-safe on purpose (the console's map imports its type): no I/O, no server import.
import { HttpError } from "@/lib/errors";

export const SPONSOR_REFUSAL_CODES = [
  // A sponsor: what its deals lock (server/sponsors/deal-apply.ts, D9), a dispute holding it, and its delete
  // (server/usecases/sponsors.ts).
  "sponsor_locked_by_deal",
  "sponsor_has_open_deal",
  "sponsor_dispute_parked",
  "sponsor_has_deal_history",
  "sponsor_has_open_checkout",
  // Add deal (server/usecases/sponsor-deals.ts `createDeal`), in its declared order.
  "package_retired",
  "scope_outside_package",
  "competition_finished",
  "connect_required",
  "sponsor_email_required",
  "ends_on_in_past",
  // A deal action the deal does not offer (F12, `notOffered`), a deal that moved under the action, money already paid online.
  "deal_already_paid",
  "deal_ended",
  "deal_not_payable",
  "deal_not_awaiting_approval",
  "deal_not_refundable",
  "deal_disputed",
  "deal_not_invoiceable",
  "deal_changed",
  "deal_paid_online",
  // A DealRuleError mapped at the usecase boundary (lib/sponsor-deals.ts `DealRuleCode`).
  "on_payment_needs_payment",
  "illegal_transition",
  // Stripe could not do what the action needs (502).
  "stripe_unavailable",
] as const;

export type SponsorRefusalCode = (typeof SPONSOR_REFUSAL_CODES)[number];

/** A coded refusal of a sponsor, package or deal route. The code must be one the list above names. */
export function sponsorRefusal(status: number, message: string, code: SponsorRefusalCode): HttpError {
  return new HttpError(status, message, code);
}
