// The words and the small questions the deal screens share (sponsor deals PR 2, Tasks 15 and 16): what ending a deal does to the
// money and to the public pages, and the "this sponsor already has one of these" check behind the Add deal sheet's duplicate
// confirm. They lived in the Packages tab's transitional picker (components/sponsor-packages.tsx, which Task 18 deletes and which
// now re-exports them): the sponsor page and the Add deal sheet need the SAME answers, so there is one home. Pure: no hooks.
import type { MessageKey } from "@/lib/messages";
import { isLiveDeal, isOpenDeal, isUnpaid, type SponsorDeal } from "@/lib/sponsor-deals";

/** Does this sponsor already have an OPEN deal on this package - one that has not gone live yet (draft, awaiting payment or
 *  approval, scheduled)? A live deal is running and an ended one is over; neither is a second invoice for the same thing.
 *  "Open" is `isOpenDeal`, the same definition as the server's `has_open_deal` (T14 carry m4: one authority). Keys on the
 *  SPONSOR, not the typed email. */
export function hasOpenDealOn(deals: readonly SponsorDeal[], sponsorId: string, packageId: string): boolean {
  return deals.some((d) => d.sponsor_id === sponsorId && d.package_id === packageId && isOpenDeal(d));
}

/** Is this sponsor under a LIVE deal right now? A live deal keeps the sponsor on the public pages whatever is queued behind it;
 *  without one, a deal waiting for its payment hides the sponsor until it is live (server/sponsors/deal-apply.ts, step 4). */
export function hasLiveDeal(deals: readonly SponsorDeal[], sponsorId: string): boolean {
  return deals.some((d) => d.sponsor_id === sponsorId && isLiveDeal(d));
}

/** The duplicate-invoice confirm's words (review m8): "could pay twice" only while one of the sponsor's open deals on this
 *  package still has money to take (pending or failed); open deals with nothing left to pay make a second deal, not a second
 *  payment. */
export function dupConfirmBodyKey(deals: readonly SponsorDeal[], sponsorId: string, packageId: string): MessageKey {
  const unpaid = deals.some(
    (d) => d.sponsor_id === sponsorId && d.package_id === packageId && isOpenDeal(d) && isUnpaid(d.payment_status),
  );
  return unpaid ? "sponsors.order.dupConfirm.body" : "sponsors.order.dupConfirm.bodySettled";
}

/** End now's confirm words (review I2): what the public pages do once this deal ends. A live deal hands over to the queue (or
 *  the sponsor comes off); a deal that never went live leaves the sponsor as it is - shown under its live deal, else hidden
 *  (server/sponsors/deal-apply.ts, step 4). */
export function endConfirmBodyKey(deals: readonly SponsorDeal[], deal: SponsorDeal): MessageKey {
  if (isLiveDeal(deal)) return "sponsors.order.endConfirm.bodyLive";
  if (deal.sponsor_id !== null && hasLiveDeal(deals, deal.sponsor_id)) return "sponsors.order.endConfirm.bodyKept";
  return "sponsors.order.endConfirm.bodyHidden";
}

/** End now never moves money (batch G New-2; extended to a LIVE deal by the PR 2 ruling): a deal the sponsor has paid keeps its
 *  payment when it ends - live or not - and the confirm says so, and that Refund, still offered on it afterwards
 *  (lib/sponsor-deals.ts allowedActions), is the separate step. A disputed payment is the dispute's, not the club's to refund. */
export function endKeepsPayment(deal: SponsorDeal): boolean {
  return deal.payment_status === "paid" && !deal.disputed_at;
}
