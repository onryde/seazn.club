import { button, panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, isOwnEntry, money, ownKey } from "./shared";
import { formatDeadline } from "./registration";
import { t, type Dict } from "@/lib/i18n";
import {
  fillPaymentInstructions,
  paymentInstructionsText,
} from "@/lib/payment-instructions";

export interface PaymentReminderArgs {
  orgName: string;
  competitionName: string;
  /** The entry the fee is for (named in the body, in brackets: a rep may hold several). */
  displayName: string;
  /** The entry's division, named beside it: two entries for one person are otherwise the same name (polish wave sign-off V5). */
  divisionName: string;
  /** The person the mail is for: the greeting names them, never the entry (polish wave W4). */
  contactName: string;
  feeCents: number;
  currency: string;
  paymentInstructions: string | null;
  /** How the entry pays: `card` (the page's Pay button) or `offline` (the instructions, and the page for the details). */
  method: "card" | "offline";
  /** The player's payment page for this entry (`/r/pay/<token>`). Every reminder links it; never a Checkout url. */
  payPageUrl: string;
  payDeadline?: Date | string | null;
  /** The organiser's zone (`organizations.timezone` resolved): the deadline is written in it. UTC when absent. */
  timeZone?: string | null;
  /** The reference to quote for THIS entry (`entryReferenceOf`, lib/ref-code.ts): the cart's, with the entry's place in it for a 2+ cart.
   *  Printed on its own line, and fills {{reference}} in the instructions. Named `refCode` for the i18n placeholder it fills. */
  refCode?: string | null;
}

/** Payment nudge for an unpaid entry fee — organiser-triggered or sweep-triggered at T-24h. Both link the player's payment page:
 *  a card entry gets the Pay button, an offline entry its instructions plus a link to the page's details. `dict` = emails
 *  namespace for the recipient's locale. */
export function paymentReminderTemplate(
  opts: PaymentReminderArgs,
  dict: Dict,
  /** The language the mail is written in: the deadline's own spelling follows it. */
  locale = "en",
): { subject: string; html: string; text: string } {
  const amount = money(opts.feeCents, opts.currency, locale);
  const deadline = opts.payDeadline ? formatDeadline(opts.payDeadline, locale, opts.timeZone) : null;
  const instructions = opts.paymentInstructions
    ? paymentInstructionsText(fillPaymentInstructions(opts.paymentInstructions, opts.refCode))
    : null;
  const card = opts.method === "card";
  // Final fix round F: the registrant's reference, printed on its own line whenever there is one (B5 T18: this entry's own, `SZ-XXXX-XXXX-2`
  // in a 2+ cart). Organisers' instructions say "use your reference" without always writing the {{reference}} placeholder.
  const refHtml = opts.refCode ? paragraph(t(dict, "paymentReminder.reference", { refCode: escapeHtml(opts.refCode) })) : "";
  const refText = opts.refCode ? "\n" + t(dict, "paymentReminder.textReference", { refCode: opts.refCode }) : "";
  const how = card
    ? panel(
        t(dict, "paymentReminder.completePanelTitle"),
        deadline
          ? t(dict, "paymentReminder.completeHeldUntil", { deadline })
          : t(dict, "paymentReminder.completeHeld"),
      ) + button(t(dict, "paymentReminder.payNow", { amount }), opts.payPageUrl)
    : (instructions
        ? panel(t(dict, "paymentReminder.howToPayTitle"), instructions)
        : paragraph(t(dict, "paymentReminder.contactOrg", { orgName: escapeHtml(opts.orgName) }))) +
      button(t(dict, "paymentReminder.viewDetails"), opts.payPageUrl);

  const subject = t(dict, "paymentReminder.subject", { competitionName: opts.competitionName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "paymentReminder.preheader", {
        amount,
        competitionName: opts.competitionName,
      }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.competitionName}`,
      title: t(dict, "paymentReminder.title"),
      contentHtml:
        paragraph(
          t(dict, ownKey("paymentReminder.body", isOwnEntry(opts.displayName, opts.contactName)), {
            contactName: escapeHtml(opts.contactName),
            displayName: escapeHtml(opts.displayName),
            divisionName: escapeHtml(opts.divisionName),
            competitionName: escapeHtml(opts.competitionName),
            amount,
          }),
        ) +
        refHtml +
        how,
      footerNote: t(dict, "paymentReminder.footer"),
    }),
    text:
      t(dict, "paymentReminder.textLine", {
        competitionName: opts.competitionName,
        orgName: opts.orgName,
      }) +
      "\n" +
      t(dict, ownKey("paymentReminder.textEntry", isOwnEntry(opts.displayName, opts.contactName)), { displayName: opts.displayName, divisionName: opts.divisionName }) +
      "\n" +
      t(dict, "paymentReminder.textFee", { amount }) +
      refText +
      (card
        ? "\n" +
          (deadline
            ? t(dict, "paymentReminder.textHeldUntil", { deadline })
            : t(dict, "paymentReminder.textHeld")) +
          "\n" +
          opts.payPageUrl
        : (instructions
            ? "\n" + t(dict, "paymentReminder.textHowToPay") + "\n" + instructions
            : "\n" + t(dict, "paymentReminder.textContactOrg")) +
          "\n\n" +
          t(dict, "paymentReminder.textViewDetails") +
          "\n" +
          opts.payPageUrl) +
      "\n\n" +
      t(dict, "paymentReminder.textAlreadyPaid"),
  };
}
