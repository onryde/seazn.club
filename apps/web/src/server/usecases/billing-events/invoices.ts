import "server-only";
// Stripe event processing: invoice.payment_failed / payment_succeeded and the renewal true-up (see ./index.ts).
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { invalidateGroupEntitlements } from "@/lib/entitlements";
import { syncGroupQuantity } from "@/server/usecases/billing-groups";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { reportSale } from "@/lib/revshare";
import { ownerDistinctId, primaryOrgForGroup } from "./group-resolution";
import { queuePaidInvoiceMail, queueRenewalFailedMail, queueRenewalUpcomingMail } from "./lifecycle-mail";

/** In Stripe v22 the subscription ref moved to invoice.parent.subscription_details.subscription */
export function invoiceSubId(invoice: Stripe.Invoice): string | null {
  const sub = invoice.parent?.subscription_details?.subscription;
  if (!sub) return null;
  return typeof sub === "string" ? sub : sub.id;
}

export async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const subId = invoiceSubId(invoice);
  if (!subId) return;
  const [row] = await sql<{ id: string; grace_ends_at: Date }[]>`
    update subscriptions
    set status = 'past_due', updated_at = now(),
        -- Grace anchor: only the FIRST failure starts the 14-day clock;
        -- every dunning retry lands here again and must not re-arm it.
        status_changed_at = case when status is distinct from 'past_due'
                                 then now() else status_changed_at end
    where stripe_subscription_id = ${subId}
    -- When that grace ends, by the resolver's own rule (lib/entitlements.ts and
    -- org_has_feature: past_due collapses to community once
    -- coalesce(status_changed_at, updated_at) <= now() - interval '14 days'),
    -- for the dunning mail to name.
    returning id, coalesce(status_changed_at, updated_at) + interval '14 days' as grace_ends_at`;
  if (row) {
    // past_due starts the 14-day grace the resolver reads, so it is a plan
    // change in all but name — drop the whole group's cached entitlements.
    await invalidateGroupEntitlements(row.id);
    // One event per failed invoice, attributed to the group's primary org
    // (there is one payer and one invoice, however many orgs share it).
    const orgId = await primaryOrgForGroup(row.id);
    if (orgId) {
      await captureServer({
        event: EVENTS.PAYMENT_FAILED,
        distinctId: await ownerDistinctId(orgId),
        orgId,
      });
    }
    // The dunning notice (billing lifecycle mails, 2026-11-15): one per declined renewal invoice.
    await queueRenewalFailedMail(invoice, row.id, row.grace_ends_at);
  }
}

export async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
  const subId = invoiceSubId(invoice);
  if (!subId) return;
  // Not a trialing mirror (its own events move it), and not a CANCELLED one: a retry that succeeds after a cancel NOW inside the retry
  // window must not revive a deleted subscription — a revived 'active' would also block the payer's next checkout (review round 2 m-b).
  const [row] = await sql<{ id: string }[]>`
    update subscriptions set status = 'active', updated_at = now()
    where stripe_subscription_id = ${subId} and status not in ('trialing', 'canceled')
    returning id`;
  // Leaving dunning restores the plan for every org in the group.
  if (row) await invalidateGroupEntitlements(row.id);
  await trueUpQuantityPaid(invoice, subId);
  await reportRevshareSale(invoice, subId);
  // The activation mail for a subscription's first payment, or the renewal receipt (billing lifecycle mails, 2026-11-15).
  await queuePaidInvoiceMail(invoice, subId);
}

/**
 * Revshare: report each paid subscription charge against the ref_code frozen on
 * the paying GROUP (subscriptions.revshare_ref_code, stamped once at the user's
 * first org). Frozen on the payer rather than looked up from member orgs, so an
 * org attach/detach never changes or drops who is owed the renewals.
 *
 * Scope is the first charge and renewals only (billing_reason subscription_create
 * / subscription_cycle) — a proration or add-on invoice (subscription_update,
 * manual) is deliberately not reported. The amount EXCLUDES tax: automatic tax is
 * on, so amount_paid carries VAT/GST and would overpay commission. The invoice id
 * is the transaction id — unique per charge, and a replayed webhook is ignored by
 * Revshare. Best-effort, and a no-op while the master switch is off — reportSale owns both
 * (one authority; a second copy of the switch here would shadow its tests).
 */
const REVSHARE_BILLING_REASONS = new Set(["subscription_create", "subscription_cycle"]);

async function reportRevshareSale(invoice: Stripe.Invoice, subId: string): Promise<void> {
  if (!invoice.billing_reason || !REVSHARE_BILLING_REASONS.has(invoice.billing_reason)) return;
  const customerId =
    typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
  if (!customerId || !invoice.id) return;
  const [row] = await sql<{ revshare_ref_code: string | null }[]>`
    select revshare_ref_code from subscriptions where stripe_subscription_id = ${subId}`;
  if (!row?.revshare_ref_code) return;
  const paid = invoice.amount_paid ?? 0;
  // Never report more than was paid; fall back to the paid amount when Stripe
  // gives no pre-tax total.
  const exTax = invoice.total_excluding_tax;
  await reportSale({
    refCode: row.revshare_ref_code,
    transactionId: invoice.id,
    amountCents: typeof exTax === "number" ? Math.min(paid, exTax) : paid,
    currency: invoice.currency,
    customerId,
  });
}

/**
 * `invoice.upcoming` (billing lifecycle mails, 2026-11-15): Stripe's notice ahead of a renewal, sent by the dashboard's "upcoming renewal
 * events" lead time. The payload is a PREVIEW invoice — no `id` — so nothing here may key on one. Mail only (the annual renewal notice);
 * nothing is mirrored.
 */
export async function handleInvoiceUpcoming(invoice: Stripe.Invoice): Promise<void> {
  const subId = invoiceSubId(invoice);
  if (!subId) return;
  await queueRenewalUpcomingMail(invoice, subId);
}

/**
 * Seats this invoice was actually cut for.
 *
 * The subscription item can have moved on by the time we handle the event —
 * `sweepStuckEvents` replays ten minutes late by design, and a detach in between
 * lowers it — so the invoice line is the only truthful record of what the period
 * was billed at. Undefined when the line carries no quantity, which the caller
 * treats as "fall back to what the item held before we touched it".
 */
function invoicedSeats(invoice: Stripe.Invoice): number | undefined {
  const q = invoice.lines?.data?.[0]?.quantity;
  return typeof q === "number" ? q : undefined;
}

/**
 * Renewal: the one moment `quantity_paid` may come back DOWN.
 *
 * "A removed org frees a paid slot you can reuse at no charge until the period
 * ends" only keeps its promise if the paid-for count is eventually released, and
 * only a renewal may release it: Stripe has just cut an invoice from the
 * subscription item, so last period's slots are spent and what the item holds is
 * by definition what has now been paid for.
 *
 * Gated on `billing_reason`, not merely on "an invoice was paid". A mid-period
 * PRORATION invoice is also `invoice.payment_succeeded`, and lowering
 * quantity_paid on one would confiscate a slot the customer has this second
 * paid for: attach (3 seats charged), detach (2 orgs, 1 slot still owed to
 * them), any other prorated change → the freed slot silently disappears.
 * `subscription_create` is included because that first invoice IS the count the
 * checkout bought, and nothing else records it.
 */
async function trueUpQuantityPaid(invoice: Stripe.Invoice, subId: string): Promise<void> {
  const reason = invoice.billing_reason;
  if (reason !== "subscription_cycle" && reason !== "subscription_create") return;
  const [row] = await sql<{ id: string }[]>`
    select id from subscriptions where stripe_subscription_id = ${subId}`;
  if (!row) return;
  // The whole true-up, including the quantity_paid write, is syncGroupQuantity's
  // job under its lock. This must NOT set quantity_paid = count(*) itself: doing
  // that and then failing the Stripe call left the item wrong while the ledger
  // said it agreed, which is exactly the predicate reconcileGroupQuantities
  // selects on — so the drift became permanently invisible and every later
  // renewal re-billed the wrong seat count and re-armed the equality.
  //
  // `renewal: true` is what allows quantity_paid to come DOWN here: the cycle
  // invoice has just been cut from the item, so last period's paid-for slots are
  // spent. Best-effort — a webhook must still ACK — and a failure now leaves the
  // two disagreeing, which is what keeps the sweep able to see it.
  try {
    await syncGroupQuantity(row.id, { renewal: true, invoicedQuantity: invoicedSeats(invoice) });
  } catch (err) {
    log.error({ subscriptionId: row.id, err }, "billing: renewal quantity sync failed for group");
  }
}
