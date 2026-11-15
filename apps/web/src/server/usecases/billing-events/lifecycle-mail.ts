import "server-only";
// Stripe event processing: the billing lifecycle mails to a group's payer (see ./index.ts).
//
// One owner for three questions every one of these mails asks: WHO the payer is (the trial warning's rule, moved here so all seven
// billing mails share it), WHICH mail an event earns (the guards below, each a named predicate a test reaches), and its ONCE-KEY. The
// handlers in ./subscriptions and ./invoices call in after their own writes; nothing here writes billing state.
//
// Every kind is addressed to the payer's account (`subscriptions.owner_user_id`, resolved at send), in the payer's language, with ref
// `subscription/<group id>` and no organisation (a group can span several), and is TRANSACTIONAL: it is about the payer's own money,
// like the trial warning. A webhook has no request to make a first attempt, so the worker sends.
//
// The once-keys (outbox `email_outbox_once_idx`, unique per kind): a Stripe redelivery, the stuck-event sweeper and a staff replay of
// one event all land on one row.
//  - trial_expired:        the Stripe subscription id (a subscription is deleted once)
//  - plan_activated:       the invoice id
//  - renewal_paid:         the invoice id
//  - renewal_failed:       the invoice id (ONE notice per declined invoice, however many retries Stripe makes)
//  - renewal_upcoming:     `<stripe subscription id>:<renewal instant>` (an `invoice.upcoming` payload has NO invoice id)
//  - subscription_changed: the Stripe event id (each change is its own event)
import type Stripe from "stripe";
import { sql, type Tx } from "@/lib/db";
import { log } from "@/server/logger";
import { getDictionary, type Dict } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n-constants";
import { appOrigin } from "@/lib/email";
import { planLabel } from "@/lib/plan-label";
import { planItem } from "@/lib/subscription-items";
import { hasLiveSubscription } from "@/lib/subscription-status";
import { enqueueEmailOnce, expiryWithin, onceKey, recipientLocale, type OutboxKind } from "@/server/email-outbox";
import {
  planActivatedTemplate,
  renewalFailedTemplate,
  renewalPaidTemplate,
  renewalUpcomingTemplate,
  subscriptionChangedTemplate,
  trialExpiredTemplate,
  type SubscriptionChange,
} from "@/lib/email-templates";

type Db = Tx | typeof sql;
type Rendered = { subject: string; html: string; text: string };

const DAY_MS = 86_400_000;
/** A calendar year is never shorter than 365 days, and a month never longer than 31: a line billing at least this long is annual. */
const ANNUAL_MIN_SECONDS = 365 * 86_400;

const iso = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------------------------------------------------------------
// The payer
// ---------------------------------------------------------------------------------------------------------------------------------

/** Who a billing group's mail goes to, and the mirror facts the mails read. */
export interface BillingPayer {
  groupId: string;
  ownerUserId: string;
  ownerEmail: string;
  planKey: string | null;
  hasPaymentMethod: boolean;
  /** Our mirror of the Stripe status (`subscriptions.status`). */
  status: string | null;
  /** Our mirror of Stripe's `trial_end`; Stripe keeps it on the subscription after the trial is over. */
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** The org the billing link points at (see the query), and that org's default language. */
  orgSlug: string | null;
  orgDefaultLocale: string | null;
}

/**
 * The group's payer, or null when it has none to reach (no owner, or a deleted account). The rule the trial warning always used (V411):
 * the account `subscriptions.owner_user_id` names, and the billing page of the org that payer created (else the group's oldest org).
 */
export async function billingPayer(db: Db, groupId: string): Promise<BillingPayer | null> {
  const [row] = await db<
    {
      plan_key: string | null;
      has_payment_method: boolean | null;
      status: string | null;
      trial_end: Date | null;
      cancel_at_period_end: boolean | null;
      owner_user_id: string;
      owner_email: string | null;
      org_slug: string | null;
      org_default_locale: string | null;
    }[]
  >`
    select s.plan_key, s.has_payment_method, s.status, s.trial_end, s.cancel_at_period_end,
           s.owner_user_id, u.email as owner_email,
           -- The billing page is per-ORG, but a group can span several. Prefer
           -- the one the payer actually owns — that is the org whose settings
           -- they can reach — and fall back to the group's oldest org so a
           -- payer who owns none still lands somewhere they can act.
           coalesce(
             (select o.slug from organizations o
               where o.subscription_id = s.id and o.created_by = s.owner_user_id
               order by o.created_at limit 1),
             (select o.slug from organizations o
               where o.subscription_id = s.id
               order by o.created_at limit 1)
           ) as org_slug,
           -- That same org's default language, by the same choice (an org's
           -- default_locale is never null, so each coalesce settles on the
           -- same arm).
           coalesce(
             (select o.default_locale from organizations o
               where o.subscription_id = s.id and o.created_by = s.owner_user_id
               order by o.created_at limit 1),
             (select o.default_locale from organizations o
               where o.subscription_id = s.id
               order by o.created_at limit 1)
           ) as org_default_locale
    from subscriptions s
    left join users u on u.id = s.owner_user_id and u.deleted_at is null
    where s.id = ${groupId}`;
  if (!row?.owner_email) return null;
  return {
    groupId,
    ownerUserId: row.owner_user_id,
    ownerEmail: row.owner_email,
    planKey: row.plan_key,
    hasPaymentMethod: row.has_payment_method === true,
    status: row.status,
    trialEnd: row.trial_end,
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    orgSlug: row.org_slug,
    orgDefaultLocale: row.org_default_locale,
  };
}

/** Absolute URL of the billing page the payer acts on (the platform root when the group has no org left). */
export function billingUrl(orgSlug: string | null): string {
  const base = appOrigin();
  return orgSlug ? `${base}/o/${orgSlug}/settings/billing` : base;
}

/** The group a Stripe subscription id is CURRENTLY mirrored on. A replaced subscription's late invoice finds none, and mails nobody. */
async function groupForStripeSubscription(stripeSubId: string): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`select id from subscriptions where stripe_subscription_id = ${stripeSubId}`;
  return row?.id ?? null;
}

async function queue(
  db: Db,
  p: BillingPayer,
  kind: OutboxKind,
  onceId: string,
  render: (dict: Dict, locale: Locale, url: string) => Rendered,
): Promise<string | null> {
  const locale = await recipientLocale(db, { pick: null, userId: p.ownerUserId, orgDefault: p.orgDefaultLocale });
  const dict = await getDictionary(locale, "emails");
  return enqueueEmailOnce(db, {
    kind,
    refType: "subscription",
    refId: p.groupId,
    orgId: null,
    to: p.ownerEmail,
    recipientUserId: p.ownerUserId,
    ...render(dict, locale, billingUrl(p.orgSlug)),
    transactional: true,
    expiresAt: expiryWithin(null),
    dedupeKey: onceKey(kind, "subscription", onceId),
  });
}

function noPayer(kind: OutboxKind, ids: Record<string, string>): void {
  log.warn({ kind, ...ids }, "billing: lifecycle mail — group has no reachable payer");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// trial_expired (customer.subscription.deleted)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Did this deletion end a TRIAL that ran out, as opposed to a cancel the payer asked for or a paid plan ending?
 *
 * Measured in a Stripe sandbox (2026-11-15, test clocks; report-1.md): `cancellation_details.reason` reads `cancellation_requested` on
 * ALL of them — the untouched no-card trial too — so it cannot tell them apart. What does:
 *  - our mirror said `trialing` up to this delete (a converted, paying group says active or past_due);
 *  - no end date had been SET (`cancel_at` null): scheduling a cancel — the payer's "cancel at period end", or a Dashboard date — sets
 *    it, and that payer was already told by the cancel confirmation;
 *  - it ended EXACTLY at the trial's end (the sandbox's run-out: `ended_at == trial_end == canceled_at`). An immediate cancel during the
 *    trial ends before it; a trial that converted and was cancelled later ends after it — the case where our mirror can still say
 *    `trialing` because the conversion's update is late or stuck (`handleInvoicePaymentSucceeded` never moves a trialing mirror), and a
 *    paying customer must not be told their trial ended with no card.
 * A no-card trial is the only one that ends this way: a card-on-file trial converts at `trial_end` instead of ending.
 */
export function trialRanOut(sub: Stripe.Subscription, mirrorStatusBefore: string | null): boolean {
  if (mirrorStatusBefore !== "trialing") return false;
  if (sub.cancel_at != null) return false;
  if (sub.trial_end == null || sub.ended_at == null) return false;
  return sub.ended_at === sub.trial_end;
}

/**
 * Queue the "your trial has ended" mail, in the caller's transaction (the one that read the mirror BEFORE the delete). `planKeyBefore`
 * is the plan the trial was for, read before the downgrade: by the time this runs the row says `community`, and the mail would
 * otherwise announce the end of a "Community trial".
 */
export async function queueTrialExpiredMail(tx: Tx, groupId: string, sub: Stripe.Subscription, planKeyBefore: string | null): Promise<void> {
  const trialEnd = sub.trial_end;
  if (trialEnd == null) throw new Error("queueTrialExpiredMail: called for a subscription with no trial_end (trialRanOut refuses it)");
  const p = await billingPayer(tx, groupId);
  if (!p) return noPayer("trial_expired", { groupId, stripeSubscriptionId: sub.id });
  await queue(tx, p, "trial_expired", sub.id, (dict, locale, url) =>
    trialExpiredTemplate({ planName: planLabel(planKeyBefore), billingUrl: url, locale, trialEnd: iso(trialEnd) }, dict),
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------
// plan_activated / renewal_paid (invoice.payment_succeeded)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Whether the renewal receipt is sent. OFF unless `BILLING_RENEWAL_RECEIPT_EMAILS` is an explicit yes (`1`, `true`, `on`, `yes`): the
 * help page (help/billing/plans.md) says Stripe already emails every invoice when it is charged, so ours would be a second receipt
 * until the owner confirms Stripe's "successful payments" emails are off (review m-6, 2026-11-15). The activation mail is not gated:
 * it is the welcome, not the receipt.
 */
export function renewalReceiptsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.BILLING_RENEWAL_RECEIPT_EMAILS?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/**
 * A paid invoice for one of OUR billing groups that is not linked to its subscription yet. Stripe does not order its events: the
 * first invoice of a new paid subscription can arrive before `customer.subscription.created`, the only webhook that writes the
 * group's `stripe_subscription_id`. Throwing leaves the event unprocessed in the ledger (`runEvent` stamps `processed_at` only after
 * the handler returns) and answers Stripe 500, so Stripe's retry or the stuck-event sweeper runs it again after the link lands; the
 * invoice-id once-key keeps that to one mail. The handler's own writes before this point are replay-safe and found no group.
 */
export class BillingGroupNotLinkedError extends Error {
  constructor(
    readonly invoiceId: string,
    readonly groupId: string,
    readonly stripeSubscriptionId: string,
  ) {
    super(
      `billing: invoice ${invoiceId} was paid for group ${groupId}, which is not linked to ${stripeSubscriptionId} yet — retried once customer.subscription.created lands`,
    );
    this.name = "BillingGroupNotLinkedError";
  }
}

/**
 * The group a paid invoice is WAITING for, or null. Checkout stamps the group id on the subscription's metadata (`subscription_id`,
 * lib/billing.ts) and Stripe copies it onto the invoice's `parent.subscription_details.metadata`. Waiting means that group is ours and
 * bills no live subscription yet (none linked, or only a dead one: a re-buy). Null when the stamp is missing, names a group this
 * database does not have (the test-mode Stripe account is shared by stg, CI and local), or the group already bills a LIVE subscription
 * (this invoice is a replaced one's, late): those are skipped, never retried.
 */
async function groupAwaitingLink(invoice: Stripe.Invoice): Promise<string | null> {
  const stamped = invoice.parent?.subscription_details?.metadata?.subscription_id;
  // Metadata is free text: anything but a uuid names no group of ours (and would make the uuid comparison throw).
  if (!stamped || !UUID.test(stamped)) return null;
  const [row] = await sql<{ id: string; stripe_subscription_id: string | null; status: string | null }[]>`
    select id, stripe_subscription_id, status from subscriptions where id = ${stamped}`;
  if (!row) return null;
  return hasLiveSubscription(row) ? null : row.id;
}

/** The line with the longest service period: the plan's, when a rider on a shorter interval rides the same invoice. */
function longestLine(invoice: Stripe.Invoice): Stripe.InvoiceLineItem | null {
  let best: Stripe.InvoiceLineItem | null = null;
  for (const line of invoice.lines?.data ?? []) {
    if (!line.period) continue;
    if (!best || line.period.end - line.period.start > best.period.end - best.period.start) best = line;
  }
  return best;
}

/**
 * Is this paid invoice a subscription's FIRST payment? `billing_reason` alone cannot say: a new paid subscription's first invoice is
 * `subscription_create`, but the charge that ends a card-on-file trial is `subscription_cycle`, exactly like every later renewal
 * (measured in the sandbox, 2026-11-15). What marks that one is its period: it STARTS at the trial's end (`trial_end`, which our mirror
 * keeps after the trial is over).
 */
export function isFirstPayment(invoice: Stripe.Invoice, trialEnd: Date | null): boolean {
  if (invoice.billing_reason === "subscription_create") return true;
  if (invoice.billing_reason !== "subscription_cycle" || !trialEnd) return false;
  const trialEndSeconds = Math.floor(trialEnd.getTime() / 1000);
  return (invoice.lines?.data ?? []).some((line) => line.period?.start === trialEndSeconds);
}

/**
 * `invoice.payment_succeeded`: the activation mail for a subscription's first payment, the receipt for a later renewal, nothing else.
 *  - nothing was taken (`amount_paid` 0: a trial's opening invoice, an interval switch inside a trial) — no payment, no mail;
 *  - a proration (`subscription_update`) or any non-subscription reason is neither a start nor a renewal;
 *  - the receipt honours `renewalReceiptsEnabled`.
 */
export async function queuePaidInvoiceMail(invoice: Stripe.Invoice, stripeSubId: string): Promise<void> {
  if (!(invoice.amount_paid > 0)) return;
  if (invoice.billing_reason !== "subscription_create" && invoice.billing_reason !== "subscription_cycle") return;
  const groupId = await groupForStripeSubscription(stripeSubId);
  if (!groupId) {
    // Only a NEW subscription's invoice can outrun its link: a renewal's subscription was linked a whole period ago.
    const waiting = await groupAwaitingLink(invoice);
    if (waiting) throw new BillingGroupNotLinkedError(invoice.id, waiting, stripeSubId);
    return;
  }
  const p = await billingPayer(sql, groupId);
  if (!p) {
    const [mirror] = await sql<{ trial_end: Date | null }[]>`select trial_end from subscriptions where id = ${groupId}`;
    const skipped = isFirstPayment(invoice, mirror?.trial_end ?? null) ? "plan_activated" : "renewal_paid";
    return noPayer(skipped, { groupId, invoiceId: invoice.id });
  }
  const first = isFirstPayment(invoice, p.trialEnd);
  if (!first && !renewalReceiptsEnabled()) return;
  const line = longestLine(invoice);
  const args = {
    planName: planLabel(p.planKey),
    amountCents: invoice.amount_paid,
    currency: invoice.currency,
    renewsAt: line ? iso(line.period.end) : null,
    invoiceUrl: invoice.hosted_invoice_url ?? null,
  };
  const kind = first ? "plan_activated" : "renewal_paid";
  const template = first ? planActivatedTemplate : renewalPaidTemplate;
  await queue(sql, p, kind, invoice.id, (dict, locale, url) => template({ ...args, billingUrl: url, locale }, dict));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// renewal_failed (invoice.payment_failed)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * `invoice.payment_failed`: the dunning notice, ONE per invoice. Only a RENEWAL charge (`subscription_cycle`, which includes the charge
 * that ends a card-on-file trial): a declined first checkout (`subscription_create`) is shown on the checkout page as it happens and
 * has no grace to speak of, and a declined interval switch is confirmed in-page. `graceEndsAt` is the resolver's: 14 days from the
 * FIRST failure (`status_changed_at`), handed in by the handler that just wrote it.
 */
export async function queueRenewalFailedMail(invoice: Stripe.Invoice, groupId: string, graceEndsAt: Date): Promise<void> {
  if (invoice.billing_reason !== "subscription_cycle") return;
  if (!(invoice.amount_due > 0)) return;
  const p = await billingPayer(sql, groupId);
  if (!p) return noPayer("renewal_failed", { groupId, invoiceId: invoice.id });
  const graceDaysLeft = Math.ceil((graceEndsAt.getTime() - Date.now()) / DAY_MS);
  await queue(sql, p, "renewal_failed", invoice.id, (dict, locale, url) =>
    renewalFailedTemplate(
      {
        planName: planLabel(p.planKey),
        billingUrl: url,
        locale,
        amountDueCents: invoice.amount_due,
        currency: invoice.currency,
        graceEndsAt: graceEndsAt.toISOString(),
        graceDaysLeft,
        nextAttemptAt: invoice.next_payment_attempt ? iso(invoice.next_payment_attempt) : null,
      },
      dict,
    ),
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------
// renewal_upcoming (invoice.upcoming)
// ---------------------------------------------------------------------------------------------------------------------------------

/** The annual line an upcoming invoice renews, or null when it renews nothing annual (a monthly plan, or only a monthly rider). */
export function annualRenewalLine(invoice: Stripe.Invoice): Stripe.InvoiceLineItem | null {
  const line = longestLine(invoice);
  return line && line.period.end - line.period.start >= ANNUAL_MIN_SECONDS ? line : null;
}

/**
 * `invoice.upcoming` (sent ahead of a renewal by the dashboard's "upcoming renewal events" lead time, 3 days by default): the ANNUAL
 * renewal notice. The payload is a PREVIEW with no invoice id, so the once-key is the subscription and the renewal instant.
 *  - an annual line, or nothing (a monthly renewal is not announced);
 *  - not while our mirror says `trialing`: Stripe sends this before a card-on-file trial's first charge too, and that one is the trial
 *    warning's to announce;
 *  - not when the plan is set to end, and not when nothing will be charged;
 *  - not once the renewal it announces has HAPPENED: a late redelivery or a staff replay of an old preview (the one Stripe sent before a
 *    trial converted, replayed after it did) would otherwise announce a renewal that is already in the past.
 */
export async function queueRenewalUpcomingMail(invoice: Stripe.Invoice, stripeSubId: string): Promise<void> {
  const line = annualRenewalLine(invoice);
  if (!line) return;
  if (!(invoice.amount_due > 0)) return;
  if (line.period.start * 1000 <= Date.now()) return;
  const groupId = await groupForStripeSubscription(stripeSubId);
  if (!groupId) return;
  const p = await billingPayer(sql, groupId);
  if (!p) return noPayer("renewal_upcoming", { groupId, stripeSubscriptionId: stripeSubId });
  if (p.status === "trialing") return;
  if (p.cancelAtPeriodEnd) return;
  const renewsAt = line.period.start;
  await queue(sql, p, "renewal_upcoming", `${stripeSubId}:${renewsAt}`, (dict, locale, url) =>
    renewalUpcomingTemplate(
      {
        planName: planLabel(p.planKey),
        billingUrl: url,
        locale,
        amountDueCents: invoice.amount_due,
        currency: invoice.currency,
        renewsAt: iso(renewsAt),
        cardOnFile: p.hasPaymentMethod,
      },
      dict,
    ),
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------
// subscription_changed (customer.subscription.updated)
// ---------------------------------------------------------------------------------------------------------------------------------

type PlanInterval = "month" | "year";
const asInterval = (v: string | undefined): PlanInterval | null => (v === "month" || v === "year" ? v : null);

/**
 * Which confirmation a `customer.subscription.updated` earns, from its `previous_attributes` (only the keys that CHANGED are there):
 *  - an end date appeared (`cancel_at` null -> set: the payer's "cancel at period end", or a Dashboard date) -> cancel_scheduled;
 *  - an end date went away -> resumed;
 *  - the plan item's billing interval moved (month <-> year) -> plan_changed.
 * Anything else — a renewal, a trial converting, a seat or rider change, a status move — earns none. So does an update with no
 * previous attributes, or a subscription that is no longer live.
 */
export function subscriptionChange(sub: Stripe.Subscription, previous: Partial<Stripe.Subscription> | undefined): SubscriptionChange | null {
  if (!previous) return null;
  if (sub.status === "canceled" || sub.status === "incomplete_expired") return null;
  if ("cancel_at" in previous) {
    const wasEnding = previous.cancel_at != null;
    const isEnding = sub.cancel_at != null;
    if (!wasEnding && isEnding && sub.cancel_at != null) return { variant: "cancel_scheduled", endsAt: iso(sub.cancel_at) };
    if (wasEnding && !isEnding) return { variant: "resumed" };
  }
  if (previous.items) {
    const before = asInterval(planItem({ items: previous.items } as Stripe.Subscription)?.price?.recurring?.interval);
    const nowItem = planItem(sub);
    const after = asInterval(nowItem?.price?.recurring?.interval);
    if (before && after && before !== after && nowItem) {
      return { variant: "plan_changed", interval: after, nextBillingAt: iso(nowItem.current_period_end) };
    }
  }
  return null;
}

/**
 * What a change means to a payer who is TRIALING WITHOUT A CARD: nothing will bill, so a resume does not mean "your plan will
 * continue" and an interval switch has no "next billing date" — the trial still ends on its date unless a card is added. Both become
 * `trial_continues`, dated by the payload's `trial_end`. A cancel stays a cancel. The card fact is the mirror's (`has_payment_method`,
 * which the sync that ran just before keeps whenever the payload cannot answer), the status the payload's.
 */
export function changeForPayer(change: SubscriptionChange, sub: Stripe.Subscription, hasPaymentMethod: boolean): SubscriptionChange {
  if (change.variant === "cancel_scheduled") return change;
  if (sub.status !== "trialing" || hasPaymentMethod || sub.trial_end == null) return change;
  return { variant: "trial_continues", trialEndsAt: iso(sub.trial_end) };
}

/** Queue the confirmation. One kind for all of them, so a later change REPLACES a still-queued earlier one (the outbox's replace rule):
 *  a cancel undone a minute later mails only "your plan will continue". */
export async function queueSubscriptionChangedMail(
  groupId: string,
  sub: Stripe.Subscription,
  change: SubscriptionChange,
  eventId: string,
): Promise<void> {
  const p = await billingPayer(sql, groupId);
  if (!p) return noPayer("subscription_changed", { groupId, stripeSubscriptionId: sub.id });
  const told = changeForPayer(change, sub, p.hasPaymentMethod);
  await queue(sql, p, "subscription_changed", eventId, (dict, locale, url) =>
    subscriptionChangedTemplate({ planName: planLabel(p.planKey), billingUrl: url, locale, change: told }, dict),
  );
}
