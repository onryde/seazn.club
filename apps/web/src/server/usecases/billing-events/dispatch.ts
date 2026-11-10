import "server-only";
// Stripe event processing: processStripeEvent, the dispatch table (see ./index.ts).
import type Stripe from "stripe";
import {
  handleRegistrationCheckoutAsyncPaymentFailed,
  handleRegistrationCheckoutCompleted,
  handleRegistrationDispute,
  syncRegistrationRefund,
} from "@/server/usecases/registrations";
import { syncConnectAccount } from "@/server/usecases/stripe-connect";
import {
  handleSponsorChargeRefunded,
  handleSponsorDispute,
  handleSponsorPaymentFailed,
  handleSponsorPaymentSucceeded,
} from "@/server/usecases/sponsors";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { ownerDistinctId } from "./group-resolution";
import { handleCheckoutCompleted } from "./checkout";
import {
  handlePaymentMethodChanged,
  handleSubscriptionChanged,
  handleSubscriptionDeleted,
  handleTrialWillEnd,
} from "./subscriptions";
import { handleInvoicePaymentFailed, handleInvoicePaymentSucceeded } from "./invoices";
import {
  revokePassForRefundedChargeAndNotify,
  handlePackChargeRefunded,
  handleStreamPackChargeRefunded,
} from "./refunds";
import { handlePlatformDispute } from "./disputes";
import { handleConnectPayout, handleExternalAccountChanged } from "./connect";

/** The dispatch table (formerly inline in the webhook route). Unhandled
 *  types are a silent no-op — the caller still stamps processed_at. */
export async function processStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      break;
    case "checkout.session.async_payment_succeeded": {
      // Delayed-notification success: same fulfilment path as a same-request
      // paid completion. handleRegistrationCheckoutCompleted's own
      // payment_status gate makes this safe unconditionally even though this
      // event's session is always "paid" by the time Stripe sends it.
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.metadata?.kind === "registration_group") {
        await handleRegistrationCheckoutCompleted(session);
      } else if (session.metadata?.kind === "stream_credits") {
        // Match credits (streaming R1). A delayed method completes the session
        // UNPAID, so the `completed` event's payment_status gate refuses the
        // grant and THIS event is the only one carrying the outcome — without
        // this arm the buyer is charged and never credited. Routed through
        // handleCheckoutCompleted rather than a copy of the branch, so the
        // snapshot/fallback/idempotency rules have exactly one home. The
        // ledger is keyed on the Checkout Session id, which both events carry,
        // so a paid `completed` followed by this one cannot double-grant.
        //
        // Unreachable on the Stripe account as configured TODAY — its one
        // payment method configuration enables no delayed-notification method
        // — and deliberately wired anyway: enabling one is a Dashboard toggle
        // nobody would pair with a webhook change.
        await handleCheckoutCompleted(session);
      }
      break;
    }
    case "checkout.session.async_payment_failed": {
      // The delayed-notification counterpart failed — never confirm; record
      // it and leave every named entry payable.
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.metadata?.kind === "registration_group") {
        await handleRegistrationCheckoutAsyncPaymentFailed(session);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const stripeSub = event.data.object as Stripe.Subscription;
      await handleSubscriptionChanged(stripeSub);
      // Fire the activation-of-revenue event once, on creation only.
      if (event.type === "customer.subscription.created" && stripeSub.metadata?.org_id) {
        await captureServer({
          event: EVENTS.SUBSCRIPTION_STARTED,
          distinctId: await ownerDistinctId(stripeSub.metadata.org_id),
          orgId: stripeSub.metadata.org_id,
          properties: { plan_key: stripeSub.metadata?.plan_key, status: stripeSub.status },
        });
      }
      break;
    }
    case "payment_method.attached":
    case "payment_method.detached":
    case "customer.updated":
      await handlePaymentMethodChanged(event);
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
      break;
    case "invoice.payment_failed":
      await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
      break;
    case "invoice.payment_succeeded":
      await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice);
      break;
    case "account.updated":
      // Connect Express onboarding progress (PROMPT-20a): mirror the four
      // Connect-health flags (charges_enabled, payouts_enabled, disabled_reason,
      // requirements_due) that gate entry-fee checkout and drive the payout banner.
      await syncConnectAccount(event.data.object as Stripe.Account);
      break;
    case "charge.dispute.created":
    case "charge.dispute.closed": {
      // Entry-fee, sponsor-order AND platform (subscription / Event Pass)
      // chargebacks (spec issue #5, P0-2, Task 7 P1-4): flag + alert. Each
      // handler no-ops on the others' charges, same pattern as charge.refunded;
      // the platform handler runs LAST (the destination-charge handlers write
      // nothing on a platform charge).
      const dispute = event.data.object as Stripe.Dispute;
      const phase = event.type === "charge.dispute.created" ? "created" : "closed";
      const matched =
        (await handleRegistrationDispute(dispute, phase)) ||
        (await handleSponsorDispute(dispute, phase)) ||
        (await handlePlatformDispute(dispute, phase));
      // Dispute-before-activation race (stg 2026-07-19): Stripe can deliver
      // the dispute BEFORE checkout.session.completed writes the money row's
      // payment_intent_id. An unmatched CREATED must FAIL the event so the
      // ledger keeps it unprocessed — the stuck-event sweeper (or an admin
      // replay) re-runs it once the row knows its intent. CLOSED stays a
      // silent no-op: it trails created by days (no race window), and a
      // replayed closed-lost legitimately matches nothing once the pass row
      // was deleted by the first run.
      if (!matched && phase === "created") {
        throw new Error(
          `dispute ${dispute.id} matched no registration/sponsor/platform charge yet — retry via sweeper`,
        );
      }
      break;
    }
    case "charge.dispute.funds_withdrawn":
      // The money is taken: a sponsor's placement is parked now if its
      // dispute is an inquiry that escalated (owner, 2026-10-26). Sponsor
      // orders ONLY. The entry-fee and platform handlers record a dispute at
      // `created` and settle it at `closed`; a withdrawal is neither (as a
      // `created` it would re-stamp the cart's flag and audit again). An
      // unmatched withdrawal is a silent no-op, never a retry: the charge is
      // simply not a sponsor's, and a formal dispute whose withdrawal beats
      // its `created` is parked by that `created`.
      await handleSponsorDispute(event.data.object as Stripe.Dispute, "funds_withdrawn");
      break;
    case "charge.refunded":
      // Refunds made in the Stripe dashboard still show on the console.
      // Registration, sponsor and Event Pass charges share the event type; each
      // handler no-ops on the others' charges.
      await syncRegistrationRefund(event.data.object as Stripe.Charge);
      await handleSponsorChargeRefunded(event.data.object as Stripe.Charge);
      await revokePassForRefundedChargeAndNotify(event.data.object as Stripe.Charge);
      await handlePackChargeRefunded(event.data.object as Stripe.Charge);
      // Match credits (streaming R1, OWNER RULING 2026-09-28) — a SEPARATE
      // ledger and a separate currency from the AI credit pack above, so a
      // separate handler; each no-ops on the other's charges.
      await handleStreamPackChargeRefunded(event.data.object as Stripe.Charge);
      break;
    case "payment_intent.succeeded":
      // Sponsor deal paid — moves the deal, which applies to its own sponsor (never inserts one), replay-safe.
      await handleSponsorPaymentSucceeded(event.data.object as Stripe.PaymentIntent);
      break;
    case "payment_intent.payment_failed":
      await handleSponsorPaymentFailed(event.data.object as Stripe.PaymentIntent);
      break;
    case "payout.paid":
    case "payout.failed":
      // Connect payout health (V411): `paid` clears the alert, `failed` raises
      // it. Both directions on purpose — an alert nothing can take down is a
      // banner that outlives the problem it reports.
      await handleConnectPayout(event);
      break;
    case "account.external_account.updated":
    case "account.external_account.deleted":
      // The club's destination bank changed or vanished. `account.updated`
      // does NOT cover this: payouts_enabled stays true across both.
      await handleExternalAccountChanged(event);
      break;
    case "customer.subscription.trial_will_end":
      // Stripe's 3-day warning — the only notice before a no-card trial
      // cancels or a card-on-file trial charges.
      await handleTrialWillEnd(event.data.object as Stripe.Subscription, event.id);
      break;
    // Unhandled events are silently ACKed
  }
}
