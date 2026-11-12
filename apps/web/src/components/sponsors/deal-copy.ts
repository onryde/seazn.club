// The words and the small questions the deal screens share (sponsor deals PR 2, Tasks 15-17): what ending or refunding a deal does to
// the money and to the public pages, whether a pay link the console showed can still be paid, and the "this sponsor already has one
// of these" check behind the Add deal sheet's duplicate confirm. They lived in the Packages tab's transitional picker (deleted in
// Task 18, when Packages became a price list): the sponsor page, the deal page and the Add deal sheet need the SAME answers, so
// there is one home. Pure: no hooks.
import { fmtNumber } from "@/lib/format";
import type { MessageKey } from "@/lib/messages";
import { endedStillDue, isLiveDeal, isOpenDeal, isUnpaid, type SponsorDeal } from "@/lib/sponsor-deals";

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
  return unpaid ? "sponsors.deal.confirm.dup.body" : "sponsors.deal.confirm.dup.bodySettled";
}

/** End now's confirm words (review I2): what the public pages do once this deal ends. A live deal hands over to the queue (or
 *  the sponsor comes off); a deal that never went live leaves the sponsor as it is - shown under its live deal, else hidden
 *  (server/sponsors/deal-apply.ts, step 4). */
export function endConfirmBodyKey(deals: readonly SponsorDeal[], deal: SponsorDeal): MessageKey {
  if (isLiveDeal(deal)) return "sponsors.deal.confirm.end.bodyLive";
  if (deal.sponsor_id !== null && hasLiveDeal(deals, deal.sponsor_id)) return "sponsors.deal.confirm.end.bodyKept";
  return "sponsors.deal.confirm.end.bodyHidden";
}

/** End now never moves money (batch G New-2; extended to a LIVE deal by the PR 2 ruling): a deal the sponsor has paid keeps its
 *  payment when it ends - live or not - and the confirm says so, and that Refund, still offered on it afterwards
 *  (lib/sponsor-deals.ts allowedActions), is the separate step. A disputed payment is the dispute's, not the club's to refund. */
export function endKeepsPayment(deal: SponsorDeal): boolean {
  return deal.payment_status === "paid" && !deal.disputed_at;
}

/** £1,500 / £120.50: whole amounts drop the pence, the way the mockup writes them. The ONE price format of the deal screens - the list
 *  row, the Mark as paid confirm, and the Add deal sheet's package cards and summary all name the same amount the same way. */
export function priceLabel(locale: string, cents: number, currency: string): string {
  const whole = cents % 100 === 0;
  try {
    return fmtNumber(locale, cents / 100, { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: whole ? 0 : 2 });
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** The refund confirm's money words (review m1, batch G New-3): back to the card through Stripe only when a card payment at Stripe
 *  paid the deal - `has_payment_intent`, the SAME fact refundDeal decides on (server/usecases/sponsor-deals.ts). Without it (marked
 *  as paid by hand, or paid offline) the refund is recorded and the club pays the sponsor back. `marked_paid_by` is not that fact: it
 *  is nulled when the marking user is deleted. */
export function refundConfirmBodyKey(deal: SponsorDeal): MessageKey {
  return deal.has_payment_intent ? "sponsors.deal.confirm.refund.body" : "sponsors.deal.confirm.refund.bodyRecorded";
}

/** The refund confirm's placement words (review m1 remainder, batch G): a refund ends the deal, so the public pages do what ending it
 *  does (endConfirmBodyKey) - except for a deal that has already ended, where nothing on them changes. */
export function refundPlacementKey(deals: readonly SponsorDeal[], deal: SponsorDeal): MessageKey {
  if (deal.deal_status === "ended") return "sponsors.deal.confirm.refund.placementEnded";
  if (deal.deal_status === "live") return "sponsors.deal.confirm.refund.placementLive";
  if (deal.sponsor_id !== null && hasLiveDeal(deals, deal.sponsor_id)) return "sponsors.deal.confirm.refund.placementKept";
  return "sponsors.deal.confirm.refund.placementHidden";
}

/** Can the pay link the console last showed still be paid (batch G New-1)? While its deal has not ended and still owes money, or has
 *  ended with its invoice still due (`endedStillDue`: an offline deal that went live and ran out unpaid, which is offered Resend
 *  invoice - final review m2; the link opens the invoice and its bank details). End now kills the link, and a paid, refunded or
 *  written-off deal has nothing left to pay. The deal is the list's copy when the list has it - every action re-reads it - else the
 *  one the send answered (the re-read has not landed yet). */
export function payLinkStillOpen(deals: readonly SponsorDeal[], sent: SponsorDeal): boolean {
  const current = deals.find((d) => d.id === sent.id) ?? sent;
  return (current.deal_status !== "ended" && isUnpaid(current.payment_status)) || endedStillDue(current);
}

/** The words on a deal action's button (final review m1): the surface's own word for the action, except that Resend invoice on a
 *  deal whose invoice has never gone out reads "Send invoice". Read off `invoice_sent_at`, not the action's name: an OFFLINE deal's
 *  first send is offered as `resend_invoice` (it has no draft to send from), and so is an online deal that went live before its
 *  first send was made. Only the words change - the action, its route and its answer are the same (`invoiceNoticeKey` words what
 *  it did). */
export function dealActionKey<A extends string>(
  words: Readonly<Record<A, MessageKey>>,
  action: A,
  deal: Pick<SponsorDeal, "invoice_sent_at">,
): MessageKey {
  return action === "resend_invoice" && deal.invoice_sent_at === null ? "sponsors.deal.action.sendInvoice" : words[action];
}

/** What a send says it did (T23 review m3), read off the deal as it was BEFORE the send: a deal whose invoice never went out says
 *  "Invoice sent"; only one already sent says "sent again" and that the new email replaces the earlier link. Not the action's
 *  name: an OFFLINE deal's first send is offered as Resend invoice (it has no draft to send from), and it replaces nothing. */
export function invoiceNoticeKey(before: Pick<SponsorDeal, "invoice_sent_at">): MessageKey {
  return before.invoice_sent_at === null ? "sponsors.deal.notice.invoiceSent" : "sponsors.deal.notice.invoiceResent";
}

/** Does Mark as paid retire a pay link? An online deal whose invoice went out has a Checkout session the server expires when the club
 *  records the payment (markDealPaid -> retireBefore "refuse"), so the sponsor cannot pay it a second time. */
export function markPaidRetiresPayLink(deal: SponsorDeal): boolean {
  return deal.payment_method === "online" && deal.invoice_sent_at !== null;
}
