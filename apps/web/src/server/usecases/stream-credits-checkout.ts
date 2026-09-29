import "server-only";
// Fulfilling a MATCH-credit Checkout Session (streaming R1, design §5.2) — the one home for both paths that learn a pack
// was paid for:
//
//   * the webhook — billing-events.ts `handleCheckoutCompleted`, reached from `checkout.session.completed` and from
//     `checkout.session.async_payment_succeeded` (a delayed method's only carrier of the outcome);
//   * reconcile-on-return — the division page, when the embedded checkout sends the buyer back to
//     `?checkout=success&session_id=…` (Task 14 fix round 1, G1). Without it, a return render that beats the webhook
//     shows the club that has just paid the "Buy match credits" card again. The billing, upgrade and registration pages
//     already reconcile on return (lib/billing.ts reconcileCheckout / reconcilePassCheckout,
//     registrations.ts reconcileRegistrationBySession); this is the same contract for this ledger.
//
// The two CONVERGE ON ONE LEDGER ROW because both write through `recordPurchase`, idempotent on
// org_stream_credits.stripe_event_id = the Checkout Session id — the one id every delivery of this purchase, and every
// retrieve of it, carries. The settled gate, the credits derivation (the checkout-time SNAPSHOT, the catalogue only as
// a logged fallback) and the terminal-refusal handling below were the webhook branch verbatim; moving them here is what
// keeps reconcile from growing a second copy of any of them.
import type Stripe from "stripe";
import { log } from "@/server/logger";
import { getStripe } from "@/lib/stripe";
import { HttpError } from "@/lib/errors";
import { linkStripeCustomer, pinBillingCurrency } from "@/lib/billing";
import { sendStreamCreditGrantFailedAlertEmail } from "@/lib/email";
import { streamPack } from "@/lib/stream-credit-packs";
import { recordPurchase } from "@/server/usecases/stream-credits";

/**
 * Grant a `kind: "stream_credits"` session's credits to `orgId` — the session's own IMMUTABLE `metadata.org_id`, which
 * both callers establish before calling (the webhook's enclosing gate reads it; the reconcile compares it). True once
 * the ledger holds this purchase — written now, or already written by the other path — and false when nothing is owed
 * (not settled) or nothing could be granted (logged, and a human paged). A transient database fault THROWS: the webhook
 * wants a redelivery, and the reconcile catches it.
 */
export async function fulfilStreamCreditsCheckout(orgId: string, session: Stripe.Checkout.Session): Promise<boolean> {
  // TWO settled states, written as two comparisons so each is killable on
  // its own. `paid` is the ordinary charge. `no_payment_required` is what
  // Stripe reports when a 100%-off promotion code leaves nothing to
  // collect — `allow_promotion_codes: true` is set on this checkout
  // (lib/relay-checkout.ts), so it is reachable today, and it is a SETTLED
  // session with no PaymentIntent, not an unpaid one. Anything else
  // (`unpaid`) is a delayed-notification session whose outcome arrives
  // later as `checkout.session.async_payment_succeeded`.
  const settled =
    session.payment_status === "paid" || session.payment_status === "no_payment_required";
  if (settled) {
    const snapshot = Number(session.metadata?.credits);
    const credits =
      Number.isInteger(snapshot) && snapshot > 0
        ? snapshot
        : (() => {
            const fallback = streamPack(Number(session.metadata?.pack))?.credits;
            if (fallback) {
              log.error(
                { sessionId: session.id, packRaw: session.metadata?.pack },
                "billing: stream_credits session had no usable credits snapshot — fell back to the catalogue",
              );
            }
            return fallback;
          })();
    if (credits) {
      // Ruling 13 item 6: the purchase link rides on the ledger row — ids and amounts, never card data.
      const link = {
        checkoutSessionId: session.id,
        paymentIntentId:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : (session.payment_intent?.id ?? null),
        pack: streamPack(Number(session.metadata?.pack))?.lookupKey ?? null,
        amountMinor: session.amount_total ?? null,
        currency: session.currency ?? null,
      };
      // `stripe_event_org_mismatch` is TERMINAL, and the only refusal here
      // that is. org_stream_credits.stripe_event_id is unique TABLE-wide, so
      // a Checkout Session id already recorded against a DIFFERENT org is
      // refused with nothing written — and no number of Stripe redeliveries
      // can turn that into a grant. Letting it reach the webhook's generic
      // error path would answer 500 and have Stripe retry the same event for
      // days while a human is the only thing that can fix it. ACK it and
      // shout in the log instead. Every OTHER error still propagates: a
      // transient database fault genuinely is worth a redelivery.
      const recorded = await recordPurchase({
        orgId,
        delta: credits,
        stripeEventId: session.id,
        link,
      }).catch((err: unknown) => {
        if (err instanceof HttpError && err.code === "stripe_event_org_mismatch") {
          log.error(
            { orgId, sessionId: session.id, credits },
            "billing: stream_credits session id already recorded for another organisation — acknowledged, nothing granted",
          );
          // ACKed means Stripe stops asking, so the log line is the ONLY
          // remaining trail — page a human, exactly as the donor branches do
          // (billing-events.ts's credit_pack, pass and size_pack limbs). The buyer was
          // charged and holds nothing; only a manual grant fixes it.
          const alertTo = process.env.STAFF_ALERT_EMAIL;
          if (alertTo) {
            void sendStreamCreditGrantFailedAlertEmail({
              to: alertTo,
              sessionId: session.id,
              orgId,
              packRaw: session.metadata?.pack,
              reason: "checkout session id already recorded for another organisation",
            }).catch(() => {});
          }
          return null;
        }
        throw err;
      });
      // Nothing was written, so there is no customer to link and no currency
      // to pin off a purchase that did not happen.
      if (!recorded) return false;
      const { applied, balance } = recorded;
      log.info({ orgId, sessionId: session.id, credits, applied, balance }, "billing: stream credits purchase");
      if (session.customer) await linkStripeCustomer(orgId, session.customer as string);
      await pinBillingCurrency(orgId, session.currency);
      return true;
    } else {
      log.error(
        { sessionId: session.id, orgId },
        "billing: stream_credits session paid but ungranted — no credits snapshot and no resolvable pack",
      );
      // Same reasoning as the mismatch limb above: acknowledged, unretryable,
      // and invisible to everyone unless somebody is told.
      const alertTo = process.env.STAFF_ALERT_EMAIL;
      if (alertTo) {
        void sendStreamCreditGrantFailedAlertEmail({
          to: alertTo,
          sessionId: session.id,
          orgId,
          packRaw: session.metadata?.pack,
          reason: "no credits snapshot and no resolvable pack",
        }).catch(() => {});
      }
    }
  }
  return false;
}

/**
 * Reconcile-on-return (G1): read the Checkout Session straight from Stripe and, only when it is a COMPLETE match-credit
 * checkout that names THIS org, fulfil it through the webhook's own path. Best-effort, idempotent, and it NEVER throws —
 * it runs inside the return render, and a throw there would 500 the page the buyer is coming back to; a failure only
 * means the webhook grants instead, a moment later.
 *
 * Three refusals of its own, each ahead of the settled gate inside `fulfilStreamCreditsCheckout`, and each a separate
 * comparison so each is killable on its own:
 *   * not `kind: "stream_credits"` — a plan, pass or AI-pack session is not this ledger's (disjoint discriminators, the
 *     same rule the webhook's dispatch keeps);
 *   * `metadata.org_id` is not the caller's org — `session_id` arrives in a URL, so it is caller-supplied; without this
 *     a club could be granted credits for a session another club paid for;
 *   * `status` is not `complete` — `status` and `payment_status` are separate fields, and the webhook never needs this
 *     check because Stripe only sends it completed sessions. A retrieve can return one still open.
 */
export async function reconcileStreamCreditsCheckout(orgId: string, sessionId: string): Promise<boolean> {
  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    if (session.metadata?.kind !== "stream_credits") return false;
    if (session.metadata.org_id !== orgId) return false;
    if (session.status !== "complete") return false;
    return await fulfilStreamCreditsCheckout(orgId, session);
  } catch (err) {
    log.error({ err, orgId, sessionId }, "billing: stream_credits reconcile-on-return failed — the webhook will grant");
    return false;
  }
}
