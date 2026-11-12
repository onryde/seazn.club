import { button, panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { t, type Dict } from "@/lib/i18n";

export interface SponsorInvoiceArgs {
  orgName: string;
  packageName: string;
  sponsorName: string;
  amountCents: number;
  currency: string;
  /** The invoice number as the invoice prints it (`formatInvoiceNumber`, e.g. `SP-0042`). */
  number: string;
  /** The invoice page (`/r/sponsor/invoice/<token>`), absolute. The email's only link: paying happens there (D14). */
  invoiceUrl: string;
  /** How the sponsor pays: by card on the invoice page (an online deal), or by bank transfer (an offline deal) with the club's
   *  bank details as its invoice settings hold them (null when the club has set none). */
  pay: { by: "card" } | { by: "transfer"; bankDetails: string | null };
}

/** The sponsor's invoice (plan 2026-11-07-sponsor-deals, Task 23; spec §7): its number and amount, how to pay, and a link to the
 *  numbered invoice page - never a payment session, which the page mints when the sponsor asks (D14). An online invoice says it
 *  is paid by card there; an offline one carries the bank details and the reference to use. `dict` = the emails namespace in the
 *  org's language (a sponsor has no account, so no language of its own). */
export function sponsorInvoiceTemplate(
  opts: SponsorInvoiceArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const amount = money(opts.amountCents, opts.currency);
  const subject = t(dict, "sponsorInvoice.subject", { number: opts.number, orgName: opts.orgName });
  const bankDetails = opts.pay.by === "transfer" ? opts.pay.bankDetails : null;
  const howToPay =
    opts.pay.by === "card"
      ? t(dict, "sponsorInvoice.payByCard")
      : t(dict, "sponsorInvoice.payByTransfer", { number: opts.number });
  // Offline with no bank details set: nothing to transfer to, so the sponsor is told whom to ask instead of an empty panel.
  const askClub =
    opts.pay.by === "transfer" && bankDetails === null ? t(dict, "sponsorInvoice.noBankDetails", { orgName: opts.orgName }) : null;
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "sponsorInvoice.preheader", { number: opts.number, amount, orgName: opts.orgName }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.packageName}`,
      title: t(dict, "sponsorInvoice.title"),
      contentHtml:
        paragraph(
          t(dict, "sponsorInvoice.body", {
            sponsorName: escapeHtml(opts.sponsorName),
            orgName: escapeHtml(opts.orgName),
            packageName: escapeHtml(opts.packageName),
            number: escapeHtml(opts.number),
            amount,
          }),
        ) +
        paragraph(escapeHtml(howToPay)) +
        (bankDetails !== null ? panel(t(dict, "sponsorInvoice.bankTitle"), bankDetails) : "") +
        (askClub !== null ? paragraph(escapeHtml(askClub)) : "") +
        button(t(dict, "sponsorInvoice.viewInvoice", { number: opts.number }), opts.invoiceUrl),
      footerNote: t(dict, "sponsorInvoice.footer", { orgName: opts.orgName }),
    }),
    text: [
      t(dict, "sponsorInvoice.textLine", {
        number: opts.number,
        orgName: opts.orgName,
        packageName: opts.packageName,
        amount,
      }),
      howToPay,
      ...(bankDetails !== null ? [bankDetails] : []),
      ...(askClub !== null ? [askClub] : []),
      opts.invoiceUrl,
    ].join("\n"),
  };
}
