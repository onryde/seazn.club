import { button, panel, paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";
import { t, type Dict } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n-constants";

export interface TrialEndingArgs {
  /** Display name of the plan the trial is for — always `planLabel(plan_key)`,
   *  never a hand-typed name, so a renamed or retired plan moves with it. */
  planName: string;
  /** ISO timestamp of Stripe's `trial_end` for THIS subscription. */
  trialEnd: string;
  /**
   * Whether the group has a card on file, read from our `has_payment_method`
   * mirror.
   *
   * This picks WHICH EMAIL this is, not a decoration. Without a card the trial
   * CANCELS at `trialEnd` (`missing_payment_method: "cancel"`) and the reader
   * must act; with one it simply charges and the reader need do nothing. Telling
   * the second group to "add a card" would be wrong copy about their own money,
   * so the two bodies are separate keys rather than one with an optional clause.
   */
  hasPaymentMethod: boolean;
  /** Absolute URL of the billing settings page — where both variants send the
   *  reader, to add a card or to cancel before the first charge. */
  billingUrl: string;
  /** Formats `trialEnd` in the reader's own language. */
  locale: Locale;
}

/**
 * Stripe's three-day `customer.subscription.trial_will_end` warning (V411) —
 * the only notice a trialing group gets before the trial resolves itself.
 *
 * `dict` = emails namespace; en default.
 */
export function trialEndingTemplate(
  opts: TrialEndingArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  // Date only: the reader is being told which DAY to act by, and a time would
  // be a false precision — Stripe bills on its own schedule within that day.
  const date = new Intl.DateTimeFormat(opts.locale, {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(opts.trialEnd));
  const variant = opts.hasPaymentMethod ? "charge" : "card";
  const subject = t(dict, `trialEnding.subject.${variant}`, { planName: opts.planName, date });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, `trialEnding.preheader.${variant}`, { date }),
      eyebrow: opts.planName,
      title: t(dict, `trialEnding.title.${variant}`),
      contentHtml:
        paragraph(
          t(dict, `trialEnding.body.${variant}`, {
            planName: escapeHtml(opts.planName),
            date,
          }),
        ) +
        button(t(dict, `trialEnding.cta.${variant}`), opts.billingUrl) +
        panel(
          t(dict, `trialEnding.panelTitle.${variant}`),
          t(dict, `trialEnding.panelBody.${variant}`, { date }),
        ),
      footerNote: t(dict, "trialEnding.footer"),
    }),
    text:
      t(dict, `trialEnding.text.${variant}`, { planName: opts.planName, date }) +
      "\n" +
      opts.billingUrl,
  };
}
