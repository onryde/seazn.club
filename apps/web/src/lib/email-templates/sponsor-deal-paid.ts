import { button, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { t, type Dict, type TKey } from "@/lib/i18n";

/** What the card payment did to the deal, as the owner's next step (spec D13; plan 2026-11-07-sponsor-deals, Task 23):
 *  - `live`: the deal is live now (paid on an "on payment" rule, nothing else live);
 *  - `approve`: the deal waits for the club's approval (`on_approval`);
 *  - `scheduled`: the deal goes live when the sponsor's current live deal ends;
 *  - `duplicate`: a second payment on a deal already paid, recorded on its own row so the club can refund it;
 *  - `check`: money taken on a deal that could not move (it had ended, or its rule could not take a payment): recorded,
 *    refundable, the deal as it was. */
export const DEAL_PAID_NEXT = ["live", "approve", "scheduled", "duplicate", "check"] as const;
export type DealPaidNext = (typeof DEAL_PAID_NEXT)[number];

/** Typed key map: the i18n house rule bans dynamic keys. */
const NEXT_KEY: Record<DealPaidNext, TKey> = {
  live: "sponsorDealPaid.next.live",
  approve: "sponsorDealPaid.next.approve",
  scheduled: "sponsorDealPaid.next.scheduled",
  duplicate: "sponsorDealPaid.next.duplicate",
  check: "sponsorDealPaid.next.check",
};

export interface SponsorDealPaidArgs {
  orgName: string;
  packageName: string;
  sponsorName: string;
  /** What Stripe received, in minor units. */
  amountCents: number;
  currency: string;
  next: DealPaidNext;
  /** The deal on its sponsor's page in the console (`dealHref`), absolute. */
  dealUrl: string;
}

/** The owner's "a sponsor has paid" notice (kind `sponsor_deal_paid`): who paid, how much, and what happens next, with a link
 *  to the deal. `dict` = the emails namespace in the owner's language. */
export function sponsorDealPaidTemplate(
  opts: SponsorDealPaidArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const amount = money(opts.amountCents, opts.currency);
  const subject = t(dict, "sponsorDealPaid.subject", { sponsorName: opts.sponsorName, orgName: opts.orgName });
  const next = t(dict, NEXT_KEY[opts.next]);
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "sponsorDealPaid.preheader", { amount, sponsorName: opts.sponsorName }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.packageName}`,
      title: t(dict, "sponsorDealPaid.title"),
      contentHtml:
        paragraph(
          t(dict, "sponsorDealPaid.body", {
            sponsorName: escapeHtml(opts.sponsorName),
            amount,
            packageName: escapeHtml(opts.packageName),
            orgName: escapeHtml(opts.orgName),
          }),
        ) +
        paragraph(`<strong>${escapeHtml(next)}</strong>`) +
        button(t(dict, "sponsorDealPaid.viewDeal"), opts.dealUrl),
      footerNote: t(dict, "sponsorDealPaid.footer"),
    }),
    text:
      t(dict, "sponsorDealPaid.textLine", {
        sponsorName: opts.sponsorName,
        amount,
        packageName: opts.packageName,
        orgName: opts.orgName,
      }) +
      "\n" +
      next +
      "\n" +
      opts.dealUrl,
  };
}
