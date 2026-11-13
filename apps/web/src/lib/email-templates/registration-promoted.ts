import { button, linkFallback, panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, isOwnEntry, money, ownKey } from "./shared";
import { formatDeadline } from "./registration";
import { t, type Dict } from "@/lib/i18n";
import {
  fillPaymentInstructions,
  paymentInstructionsText,
} from "@/lib/payment-instructions";

export interface RegistrationPromotedArgs {
  orgName: string;
  competitionName: string;
  /** The entry that was promoted (named in the intro, in brackets). */
  displayName: string;
  /** The person the mail is for: the greeting names them, never the entry (polish wave W4). */
  contactName: string;
  feeCents: number;
  currency: string;
  /** How the entry pays: `card` (the page's Pay button) or `offline` (the instructions, and the page for the details). */
  method: "card" | "offline";
  /** The player's payment page for this entry (`/r/pay/<token>`); null for a free promotion (nothing to pay, no page). */
  payPageUrl?: string | null;
  /** Card divisions: the new 48h deadline. */
  payDeadline?: Date | string | null;
  /** The organiser's zone (`organizations.timezone` resolved): the deadline is written in it. UTC when absent. */
  timeZone?: string | null;
  /** Offline divisions: resolved cash/bank instructions. */
  paymentInstructions?: string | null;
  /** The reference to quote for THIS entry (`entryReferenceOf`, lib/ref-code.ts; B5 T18): this mail is always about one entry. Printed in the
   *  reference line, and fills {{reference}} in the instructions. Not the status link's: `refStatusUrl` resolves by the CART's reference. */
  refCode?: string | null;
  refStatusUrl?: string | null;
}

/** A waitlist spot opened (spec §2): the registrant is pending again — card
 *  entries pay inside the fresh window from their payment page, offline entries follow instructions (and get the page's
 *  details link).
 *  `dict` = emails namespace for the recipient's locale. */
export function registrationPromotedTemplate(
  opts: RegistrationPromotedArgs,
  dict: Dict,
  /** The language the mail is written in: the deadline's own spelling follows it. */
  locale = "en",
): { subject: string; html: string; text: string } {
  const paid = opts.feeCents > 0;
  const amount = money(opts.feeCents, opts.currency, locale);
  const deadline = opts.payDeadline ? formatDeadline(opts.payDeadline, locale, opts.timeZone) : null;
  const card = paid && opts.method === "card" && !!opts.payPageUrl;
  const detailsUrl = paid && !card ? (opts.payPageUrl ?? null) : null;
  const instructions = opts.paymentInstructions
    ? paymentInstructionsText(fillPaymentInstructions(opts.paymentInstructions, opts.refCode))
    : null;

  const nextStepHtml = card
    ? panel(
        t(dict, "registrationPromoted.feePanelTitle", { amount }),
        deadline
          ? t(dict, "registrationPromoted.feeHeldUntil", { deadline })
          : t(dict, "registrationPromoted.feeHeld"),
      ) + button(t(dict, "registrationPromoted.payNow", { amount }), opts.payPageUrl as string)
    : paid
      ? panel(
          t(dict, "registrationPromoted.feePanelTitle", { amount }),
          instructions ?? t(dict, "registrationPromoted.contactOrganiser"),
        ) + (detailsUrl ? button(t(dict, "registrationPromoted.viewDetails"), detailsUrl) : "")
      : paragraph(t(dict, "registrationPromoted.noPayment"));

  const nextStepText = card
    ? t(dict, "registrationPromoted.textFee", { amount }) +
      "\n" +
      (deadline
        ? t(dict, "registrationPromoted.textHeldUntil", { deadline })
        : t(dict, "registrationPromoted.textHeld")) +
      "\n" +
      opts.payPageUrl
    : paid
      ? t(dict, "registrationPromoted.textFee", { amount }) +
        "\n" +
        (instructions ?? t(dict, "registrationPromoted.contactOrganiser")) +
        (detailsUrl ? "\n\n" + t(dict, "registrationPromoted.textViewDetails") + "\n" + detailsUrl : "")
      : t(dict, "registrationPromoted.noPayment");

  const subject = t(dict, "registrationPromoted.subject", {
    competitionName: opts.competitionName,
  });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader:
        card && deadline
          ? t(dict, "registrationPromoted.preheaderPay", {
              competitionName: opts.competitionName,
              deadline,
            })
          : t(dict, "registrationPromoted.preheader", {
              competitionName: opts.competitionName,
            }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.competitionName}`,
      title: t(dict, "registrationPromoted.title"),
      contentHtml:
        paragraph(
          t(dict, ownKey("registrationPromoted.intro", isOwnEntry(opts.displayName, opts.contactName)), {
            contactName: escapeHtml(opts.contactName),
            displayName: escapeHtml(opts.displayName),
            competitionName: escapeHtml(opts.competitionName),
          }),
        ) +
        nextStepHtml +
        (opts.refStatusUrl
          ? paragraph(
              t(dict, "registrationPromoted.reference", {
                refCode: escapeHtml(opts.refCode ?? ""),
                url: opts.refStatusUrl,
              }),
            ) + linkFallback(opts.refStatusUrl)
          : ""),
      footerNote: t(dict, "registrationPromoted.footer", {
        competitionName: opts.competitionName,
        orgName: opts.orgName,
      }),
    }),
    text:
      t(dict, "registrationPromoted.textIntro", {
        competitionName: opts.competitionName,
        orgName: opts.orgName,
      }) +
      "\n\n" +
      nextStepText +
      (opts.refStatusUrl
        ? "\n\n" +
          t(dict, "registrationPromoted.textReference", { refCode: opts.refCode ?? "" }) +
          "\n" +
          t(dict, "registrationPromoted.textStatus", { url: opts.refStatusUrl })
        : ""),
  };
}
