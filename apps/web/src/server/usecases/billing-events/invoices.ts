import "server-only";
// Stripe event processing: invoice.payment_failed / payment_succeeded and the renewal true-up (see ./index.ts).
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { invalidateGroupEntitlements } from "@/lib/entitlements";
import { syncGroupQuantity } from "@/server/usecases/billing-groups";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { ownerDistinctId, primaryOrgForGroup } from "./group-resolution";

/** In Stripe v22 the subscription ref moved to invoice.parent.subscription_details.subscription */
export function invoiceSubId(invoice: Stripe.Invoice): string | null {
  const sub = invoice.parent?.subscription_details?.subscription;
  if (!sub) return null;
  return typeof sub === "string" ? sub : sub.id;
}

export async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const subId = invoiceSubId(invoice);
  if (!subId) return;
  const [row] = await sql<{ id: string }[]>`
    update subscriptions
    set status = 'past_due', updated_at = now(),
        -- Grace anchor: only the FIRST failure starts the 14-day clock;
        -- every dunning retry lands here again and must not re-arm it.
        status_changed_at = case when status is distinct from 'past_due'
                                 then now() else status_changed_at end
    where stripe_subscription_id = ${subId}
    returning id`;
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
  }
}

export async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
  const subId = invoiceSubId(invoice);
  if (!subId) return;
  const [row] = await sql<{ id: string }[]>`
    update subscriptions set status = 'active', updated_at = now()
    where stripe_subscription_id = ${subId} and status != 'trialing'
    returning id`;
  // Leaving dunning restores the plan for every org in the group.
  if (row) await invalidateGroupEntitlements(row.id);
  await trueUpQuantityPaid(invoice, subId);
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
