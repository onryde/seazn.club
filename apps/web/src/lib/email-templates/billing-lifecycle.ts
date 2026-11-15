// The billing lifecycle mails (2026-11-15): what happened to a billing group's subscription, told to its payer. Six outbox kinds share
// this file because they share their shape: a plan name, a date or two, an amount, and one link to the billing page.
//
//  - trialExpiredTemplate        a no-card trial ran out and the group is on Community now
//  - planActivatedTemplate       the first paid invoice of a subscription (a new paid plan, or the charge that ends a trial)
//  - renewalPaidTemplate         a later renewal was paid: the receipt
//  - renewalFailedTemplate       a renewal charge was declined: the dunning notice, with the grace the resolver still gives
//  - renewalUpcomingTemplate     an ANNUAL plan renews soon (Stripe's `invoice.upcoming`)
//  - subscriptionChangedTemplate the payer's own change, confirmed: a cancel scheduled, a resume, an interval switch
//
// Every interpolated value is escaped for the HTML half and left as it is for the text half: the sentences carry no markup of their own,
// so one key serves both. Dates are DAYS in the reader's language, read as UTC (the instant Stripe bills on, not the server's local day),
// and amounts are spelled by `money()` in that language. Rendering only: who gets which mail, and when, is the producer's
// (server/usecases/billing-events/lifecycle-mail.ts).
import { button, inlineLink, panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { plural, t, type Dict } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n-constants";

type Rendered = { subject: string; html: string; text: string };

interface Common {
  /** `planLabel(plan_key)` — a product name, the same in every language. */
  planName: string;
  /** Absolute URL of the billing settings page. */
  billingUrl: string;
  locale: Locale;
}

/** A DAY, in the reader's language. UTC: the date a charge falls on, not the server's local day. */
function day(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(iso));
}

const escapeAll = (vars: Record<string, string | number>): Record<string, string | number> =>
  Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "string" ? escapeHtml(v) : v]));

/** One sentence as both halves need it: escaped for the HTML, raw for the text. */
function sentence(dict: Dict, key: string, vars: Record<string, string | number>): { html: string; text: string } {
  return { html: t(dict, key, escapeAll(vars)), text: t(dict, key, vars) };
}

interface Layout {
  subject: string;
  preheader: string;
  planName: string;
  title: string;
  sentences: { html: string; text: string }[];
  cta: { label: string; url: string };
  /** A secondary link (the hosted invoice), shown under the button. */
  link?: { label: string; url: string };
  panel?: { title: string; body: string };
}

function layout(dict: Dict, l: Layout): Rendered {
  const contentHtml =
    l.sentences.map((s) => paragraph(s.html)).join("") +
    button(l.cta.label, l.cta.url) +
    (l.link ? paragraph(inlineLink(l.link.label, l.link.url)) : "") +
    (l.panel ? panel(l.panel.title, l.panel.body) : "");
  const text = [
    ...l.sentences.map((s) => s.text),
    ...(l.panel ? [l.panel.body] : []),
    `${l.cta.label}: ${l.cta.url}`,
    ...(l.link ? [`${l.link.label}: ${l.link.url}`] : []),
  ].join("\n");
  return {
    subject: l.subject,
    html: renderEmail({
      subject: l.subject,
      preheader: l.preheader,
      eyebrow: l.planName,
      title: l.title,
      contentHtml,
      footerNote: t(dict, "billingLifecycle.footer"),
    }),
    text,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------

export interface TrialExpiredArgs extends Common {
  /** ISO: Stripe's `trial_end` — the moment the trial ran out. */
  trialEnd: string;
}

/** A trial with no card on file ran out (`missing_payment_method: "cancel"`): the group is on Community now. */
export function trialExpiredTemplate(a: TrialExpiredArgs, dict: Dict): Rendered {
  const vars = { planName: a.planName, date: day(a.trialEnd, a.locale) };
  return layout(dict, {
    subject: t(dict, "trialExpired.subject", vars),
    preheader: t(dict, "trialExpired.preheader", vars),
    planName: a.planName,
    title: t(dict, "trialExpired.title", vars),
    sentences: [sentence(dict, "trialExpired.body", vars)],
    cta: { label: t(dict, "trialExpired.cta", vars), url: a.billingUrl },
    panel: { title: t(dict, "trialExpired.panelTitle"), body: t(dict, "trialExpired.panelBody") },
  });
}

export interface PaidInvoiceArgs extends Common {
  /** What the invoice took (`amount_paid`), in minor units. */
  amountCents: number;
  currency: string;
  /** ISO: the end of the period this payment covers — the next renewal. Null when the invoice names no period. */
  renewsAt: string | null;
  /** Stripe's hosted invoice page, when the invoice has one. */
  invoiceUrl: string | null;
}

function paidInvoice(prefix: "planActivated" | "renewalPaid", a: PaidInvoiceArgs, dict: Dict): Rendered {
  const vars = { planName: a.planName, amount: money(a.amountCents, a.currency, a.locale) };
  return layout(dict, {
    subject: t(dict, `${prefix}.subject`, vars),
    preheader: t(dict, `${prefix}.preheader`, vars),
    planName: a.planName,
    title: t(dict, `${prefix}.title`, vars),
    sentences: [
      sentence(dict, `${prefix}.body`, vars),
      ...(a.renewsAt ? [sentence(dict, `${prefix}.renews`, { date: day(a.renewsAt, a.locale) })] : []),
    ],
    cta: { label: t(dict, "billingLifecycle.manageBilling"), url: a.billingUrl },
    link: a.invoiceUrl ? { label: t(dict, "billingLifecycle.invoiceLink"), url: a.invoiceUrl } : undefined,
  });
}

/** The first paid invoice of a subscription: a new paid plan, or the first charge after a trial. */
export function planActivatedTemplate(a: PaidInvoiceArgs, dict: Dict): Rendered {
  return paidInvoice("planActivated", a, dict);
}

/** A later renewal was paid: the receipt. */
export function renewalPaidTemplate(a: PaidInvoiceArgs, dict: Dict): Rendered {
  return paidInvoice("renewalPaid", a, dict);
}

export interface RenewalFailedArgs extends Common {
  /** What the declined invoice asked for (`amount_due`), in minor units. */
  amountDueCents: number;
  currency: string;
  /** ISO: when the past-due grace ends (the resolver's 14 days from the first failure). */
  graceEndsAt: string;
  /** Whole days left of that grace, rounded up; 0 or less once it is over. */
  graceDaysLeft: number;
  /** ISO: Stripe's `next_payment_attempt`, or null when no retry is scheduled. */
  nextAttemptAt: string | null;
}

/** A renewal charge was declined. Says what failed, when Stripe tries again, and how long the plan holds. */
export function renewalFailedTemplate(a: RenewalFailedArgs, dict: Dict): Rendered {
  const vars = { planName: a.planName, amount: money(a.amountDueCents, a.currency, a.locale) };
  const grace =
    a.graceDaysLeft > 0
      ? (() => {
          const g = { planName: a.planName, date: day(a.graceEndsAt, a.locale) };
          return {
            html: plural(dict, "renewalFailed.grace", a.graceDaysLeft, a.locale, escapeAll(g)),
            text: plural(dict, "renewalFailed.grace", a.graceDaysLeft, a.locale, g),
          };
        })()
      : sentence(dict, "renewalFailed.lapsed", { planName: a.planName });
  return layout(dict, {
    subject: t(dict, "renewalFailed.subject", vars),
    preheader: t(dict, "renewalFailed.preheader", vars),
    planName: a.planName,
    title: t(dict, "renewalFailed.title", vars),
    sentences: [
      sentence(dict, "renewalFailed.body", vars),
      ...(a.nextAttemptAt ? [sentence(dict, "renewalFailed.retry", { date: day(a.nextAttemptAt, a.locale) })] : []),
      grace,
    ],
    cta: { label: t(dict, "renewalFailed.cta"), url: a.billingUrl },
  });
}

export interface RenewalUpcomingArgs extends Common {
  /** What the upcoming invoice will ask for (`amount_due`), in minor units. */
  amountDueCents: number;
  currency: string;
  /** ISO: the renewal moment, from the payload (never "in N days": Stripe's lead time is a dashboard setting). */
  renewsAt: string;
}

/** An ANNUAL plan renews soon. */
export function renewalUpcomingTemplate(a: RenewalUpcomingArgs, dict: Dict): Rendered {
  const vars = { planName: a.planName, amount: money(a.amountDueCents, a.currency, a.locale), date: day(a.renewsAt, a.locale) };
  return layout(dict, {
    subject: t(dict, "renewalUpcoming.subject", vars),
    preheader: t(dict, "renewalUpcoming.preheader", vars),
    planName: a.planName,
    title: t(dict, "renewalUpcoming.title", vars),
    sentences: [sentence(dict, "renewalUpcoming.body", vars), sentence(dict, "renewalUpcoming.change", vars)],
    cta: { label: t(dict, "billingLifecycle.manageBilling"), url: a.billingUrl },
  });
}

/** The three confirmations of one kind (`subscription_changed`), and the interval an interval switch moved TO. */
export type SubscriptionChange =
  | { variant: "cancel_scheduled"; endsAt: string }
  | { variant: "resumed" }
  | { variant: "plan_changed"; interval: "month" | "year"; nextBillingAt: string };

export type SubscriptionChangedArgs = Common & { change: SubscriptionChange };

/** The payer's own change, confirmed. */
export function subscriptionChangedTemplate(a: SubscriptionChangedArgs, dict: Dict): Rendered {
  const c = a.change;
  const prefix =
    c.variant === "cancel_scheduled"
      ? "subscriptionChanged.cancelScheduled"
      : c.variant === "resumed"
        ? "subscriptionChanged.resumed"
        : c.interval === "year"
          ? "subscriptionChanged.annual"
          : "subscriptionChanged.monthly";
  const date =
    c.variant === "cancel_scheduled" ? day(c.endsAt, a.locale) : c.variant === "plan_changed" ? day(c.nextBillingAt, a.locale) : "";
  const vars = { planName: a.planName, date };
  return layout(dict, {
    subject: t(dict, `${prefix}.subject`, vars),
    preheader: t(dict, `${prefix}.preheader`, vars),
    planName: a.planName,
    title: t(dict, `${prefix}.title`, vars),
    sentences: [sentence(dict, `${prefix}.body`, vars)],
    cta: { label: t(dict, `${prefix}.cta`), url: a.billingUrl },
  });
}
