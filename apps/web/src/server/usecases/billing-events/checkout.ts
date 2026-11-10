import "server-only";
// Stripe event processing: checkout.session.completed (see ./index.ts).
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import {
  linkStripeCustomerForGroup,
  linkStripeCustomer,
  alertPassUnknownCompetition,
  passKeyForSession,
  passSessionRungMatchesPrice,
  pinBillingCurrency,
  recordPassPurchase,
  refundDuplicatePassPayment,
} from "@/lib/billing";
import { CREDIT_PACKS } from "@/lib/credit-packs";
import { recordPackPurchase, walletIdFor } from "@/lib/credits";
// MATCH credits — a different currency from @/lib/credits above, on its own
// table and its own writer. Kept adjacent deliberately so the next reader sees
// that the two are distinct rather than duplicated. The PURCHASE grant lives in
// stream-credits-checkout.ts, shared with reconcile-on-return (Task 14 G1).
import { fulfilStreamCreditsCheckout } from "@/server/usecases/stream-credits-checkout";
import { getSizePack } from "@/lib/size-packs";
import { handleRegistrationCheckoutCompleted } from "@/server/usecases/registrations";
import { alertCreditPackGrantFailed, alertSizePackGrantFailed } from "./staff-alerts";
import { checkoutGroupId } from "./group-resolution";

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

export async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  // Entry-fee checkouts (PROMPT-20a) share the endpoint; kind disambiguates.
  // Re-keyed to the GROUP (RS003 W3a mint / W3b webhook): a session now
  // carries registration_ids, plural — kind: "registration" (singular) has
  // no producer left. Deliberately NOT re-gated on payment_status here too —
  // handleRegistrationCheckoutCompleted is the one place that checks it,
  // shared with the async_payment_succeeded branch below and both
  // reconcile-on-return paths, so there is exactly one gate that can drift.
  if (session.metadata?.kind === "registration_group") {
    await handleRegistrationCheckoutCompleted(session);
    return;
  }

  // Size-pack one-time purchase (v17 SPEC-2 §3, Phase 3 Task 3b) — lifts ONE
  // competition's entrant cap by writing an org_addons row. This is the SINGLE
  // writer of that row; idempotent on the payment_intent id (the V324 partial
  // unique index on stripe_item_id). Handled before the generic org_id gate
  // below because it keys on its own target_org_id metadata, not org_id.
  if (session.metadata?.kind === "size_pack") {
    // SETTLED, not merely "paid". `buildSizePackCheckoutParams` sets
    // `allow_promotion_codes: true` (lib/size-packs.ts), so a code covering
    // the whole price is reachable, and Stripe completes that session as
    // `no_payment_required` — never `paid`. Gating on `paid` alone let the
    // buyer redeem a valid code and granted nothing: no org_addons row, no
    // log, no alert. Written as two comparisons, not a shared `isSettled`
    // helper: the same gate is duplicated in the credit_pack limb below and
    // in registrations/, and a concurrent branch is editing one of these
    // limbs — folding them onto one predicate would turn that merge into
    // "one side refactored, the other edited". The duplication is a choice.
    if (
      session.payment_status === "paid" ||
      session.payment_status === "no_payment_required"
    ) {
      await grantSizePackAddon(session);
    }
    return;
  }

  const orgId = session.metadata?.org_id;
  if (!orgId) return;

  // AI credit pack one-time purchase (v17 SPEC-2 §5.1/§6, Phase 3 Task 1) —
  // grants the pack into the org's wallet. Unlike the Event Pass branch below
  // there is no reconcile-on-return path (credit packs are not competition-
  // scoped, so there is nowhere in-app to reconcile from); this webhook is the
  // only writer, made safe to replay by recordPackPurchase's idempotency key.
  if (session.metadata?.kind === "credit_pack") {
    // SETTLED, not merely "paid" — same reason as the size_pack limb above:
    // `buildCreditPackCheckoutParams` sets `allow_promotion_codes: true`
    // (lib/credit-packs.ts), and a 100% code completes the session as
    // `no_payment_required`, which is settled rather than unpaid. Deliberately
    // duplicated inline rather than lifted into a shared predicate, for the
    // merge reason spelled out on the size_pack limb.
    if (
      session.payment_status === "paid" ||
      session.payment_status === "no_payment_required"
    ) {
      const packKey = session.metadata.pack_key;
      // The grant amount is SNAPSHOTTED into metadata.credits at checkout
      // creation (review fix, P3 T1) — the webhook can fire long after this
      // session was created, so re-deriving the amount from the live
      // CREDIT_PACKS catalog by pack_key here would grant the WRONG amount if
      // a deploy changed the pack's credits in the meantime, or silently
      // grant ZERO if the pack_key was removed. The catalog lookup is kept
      // only as a logged last-resort fallback for pre-fix sessions that never
      // got a snapshot; it is never a silent no-op.
      const snapshotRaw = session.metadata.credits;
      const snapshot = snapshotRaw ? Number(snapshotRaw) : NaN;
      const credits =
        Number.isFinite(snapshot) && snapshot > 0
          ? snapshot
          : (() => {
              const fallback = packKey ? CREDIT_PACKS[packKey]?.credits : undefined;
              if (fallback) {
                log.error(
                  { sessionId: session.id, snapshotRaw, packKey },
                  "billing: credit_pack session had no usable credits snapshot — fell back to catalog lookup by pack_key",
                );
              }
              return fallback;
            })();
      if (credits) {
        // The payment_intent id is the durable "which charge paid for this"
        // reference; falling back to the session id only covers a session type
        // that somehow completed with no intent (never expected for mode:
        // "payment", but a session id is still a valid, unique idempotency
        // anchor either way).
        const stripeRef =
          (typeof session.payment_intent === "string" ? session.payment_intent : null) ??
          session.id;
        const walletId = await walletIdFor(orgId);
        await recordPackPurchase(walletId, credits, stripeRef);
        if (session.customer) await linkStripeCustomer(orgId, session.customer as string);
        await pinBillingCurrency(orgId, session.currency);
      } else {
        // Paid, but neither the metadata snapshot nor the catalog fallback
        // could resolve a credit amount — a silent zero-grant here would be
        // an invisible paid-but-ungranted purchase (the bug this fix closes).
        // Surface it the same way other billing anomalies in this file are
        // surfaced: a `log.error` plus a best-effort staff alert email, and
        // still ACK the webhook (nothing here is retryable into a better
        // outcome — a human must grant this manually).
        log.error(
          { sessionId: session.id, orgId, packKey },
          "billing: credit_pack session paid but ungranted — no credits snapshot and no resolvable pack_key",
        );
        await alertCreditPackGrantFailed("checkout_session", {
          sessionId: session.id,
          orgId,
          packKey,
          reason: "no credits snapshot and no resolvable pack_key",
        });
      }
    }
    return;
  }

  // Match credits (streaming R1, design §5.2): a separate ledger on the AI
  // wallet's shape — DIFFERENT currency, different table, so never the branch
  // above. `stream_credits` and `credit_pack` are disjoint discriminators on
  // purpose: routing one into the other's writer tops up the wrong balance and
  // sells the buyer something they did not ask for. The grant is the SNAPSHOT
  // stamped at checkout creation (lib/relay-checkout.ts), falling back to the
  // catalogue by pack size only with a logged error, never a silent zero.
  //
  // `orgId` is the enclosing gate's `session.metadata.org_id` (:202) — the same
  // IMMUTABLE session metadata `runEvent` keys its own claim on. Orgs move
  // between billing groups (billing_group_transfers), so resolving the org any
  // other way here would let a transfer redirect a paid purchase.
  //
  // Replay-safe TWICE, on two independent floors. runEvent's claim on
  // billing_events.id stops a redelivery before this branch is reached at all;
  // org_stream_credits.stripe_event_id — keyed on the Checkout Session id, the
  // one id every redelivery of this purchase carries — stops a second row if
  // one ever does reach it (runEvent deliberately RE-CLAIMS an event whose
  // lease is older than ten minutes, and replayEvent is staff-reachable, so
  // this code IS met more than once). The `billing-events` cron retries rows
  // left UNPROCESSED: it selects `processed_at is null` only, so it never
  // re-enters here for a purchase the webhook already handled, and can witness
  // NEITHER floor (FT0-5). Mutate them one at a time — two guards covering for
  // each other are each untested: the outer claim's killer is the webhook
  // test's `runEvent(ev)` → false, the inner one's is Task 7's replay test.
  if (session.metadata?.kind === "stream_credits") {
    // G1 (Task 14 fix round 1): the branch lives in stream-credits-checkout.ts so reconcile-on-return runs the SAME
    // settled gate, credits derivation and idempotent writer — the two converge on one ledger row.
    await fulfilStreamCreditsCheckout(orgId, session, { alertStaff: true });
    return;
  }

  // Event Pass one-time purchase (v3/07 §3, rung ladder v17 #294) —
  // reconcile-on-return usually lands first; recordPassPurchase is idempotent
  // either way. passKeyForSession owns the gate for BOTH paths: a session with
  // no pass_key is not a pass session and falls through to the subscription
  // handling below; an unrecognised rung falls back to M rather than being
  // dropped. See its doc comment in lib/billing.ts.
  const passKey = passKeyForSession(session);
  if (passKey) {
    const competitionId = session.metadata?.competition_id;
    // SETTLED, not merely "paid" — third instance of the same widening, after
    // the size_pack and credit_pack limbs above. `buildPassCheckoutParams` sets
    // `allow_promotion_codes: true` (lib/billing.ts), so a code covering the
    // whole price is reachable and Stripe settles that session as
    // `no_payment_required`. Nothing downstream catches it: the rung guard
    // below compares PRICE IDS, and a discount does not move the price id, so
    // it returns true and the buyer is left with no pass, no log and no alert.
    // Two comparisons, inline, deliberately duplicated rather than folded into
    // a shared predicate with the limbs above or with the twin of this gate in
    // `reconcilePassCheckout` — see the size_pack limb for why.
    if (
      competitionId &&
      (session.payment_status === "paid" ||
        session.payment_status === "no_payment_required")
    ) {
      // Same mint guard as reconcile-on-return (v17 gap #326) — the check lives
      // in ONE place (lib/billing.ts) precisely so the two paths cannot drift on
      // what a session means, exactly like passKeyForSession above it. ACK the
      // webhook either way: nothing here is retryable into a better outcome, a
      // human must decide (the guard has already alerted them).
      if (!(await passSessionRungMatchesPrice(session, passKey, orgId))) return;
      const res = await recordPassPurchase({
        orgId,
        competitionId,
        passKey,
        paymentIntent:
          typeof session.payment_intent === "string" ? session.payment_intent : null,
      });
      // The competition this payment names is not a row in this database, so
      // there is nothing to record and no retry can change that. ACK the
      // webhook — the same reasoning as the mint guard above — but NEVER
      // silently: for a competition deleted after the buyer paid, this is a
      // real customer charged for nothing, and the only way anyone learns of
      // it is this alert. The money trace below is deliberately skipped: it
      // would describe a purchase we did not record, against an org that may
      // not exist here either.
      if (res.unknownCompetition) {
        log.error(
          {
            sessionId: session.id,
            orgId,
            competitionId,
            passKey,
            paymentIntent: session.payment_intent,
          },
          "billing: event pass paid but the competition does not exist in this database — acked, not retried",
        );
        await alertPassUnknownCompetition({
          sessionId: session.id,
          orgId,
          competitionId,
          passKey,
          paymentIntent:
            typeof session.payment_intent === "string" ? session.payment_intent : null,
          source: "webhook",
        });
        return;
      }
      // Second owner / second tab paid for an already-passed comp — send it
      // straight back. The refund is outside any tx and swallows its own
      // failure, so the webhook still ACKs (P0-3b).
      if (res.duplicateIntent) {
        await refundDuplicatePassPayment(res.duplicateIntent);
      } else {
        // The money trace. This branch RETURNS before the shared
        // linkStripeCustomer below, so a pass-only org's stripe_customer_id
        // stayed NULL — and the billing page lists invoices.list({ customer }),
        // so it showed nothing at all for a $29 purchase. Skipped for the
        // refunded duplicate above: that payer is not this org's customer, and
        // their currency is not the one we kept. Both writes are idempotent, so
        // the reconcile/webhook replay is free.
        if (session.customer) await linkStripeCustomer(orgId, session.customer as string);
        // First purchase of ANY kind fixes the org's billing currency, so a
        // pass buyer is never re-quoted in another currency for Pro later.
        await pinBillingCurrency(orgId, session.currency);
        // NB: the SPEC-5 §2 "first paid competition" earn grant is NOT hooked
        // here. Buying an Event Pass is not the same as an org taking a paid
        // registration, and stacking +10 onto the pass's +25 credits was wrong.
        // The earn now fires on the first genuinely-confirmed paid registration
        // (confirmPaidRegistration in registrations/checkout-completion.ts); the pass keeps only +25.
      }
    }
    return;
  }

  // Link the Stripe customer to the GROUP that bought it. A re-buy after a
  // cancel mints a NEW customer, and has_payment_method mirrors cards on the OLD
  // one — so this goes through linkStripeCustomerForGroup, which re-derives the
  // flag on a change.
  //
  // Group-addressed, not org-addressed: `stripe_customer_id` lives on the
  // subscription row, and once orgs move between groups the org named in the
  // metadata may no longer bill through the group that paid — writing through it
  // would stamp this payer's customer onto somebody else's row (the same defect
  // already fixed for the subscription webhooks). The checkout stamp is the
  // durable answer; the org's current group is the fallback for sessions created
  // before the stamp existed.
  if (session.customer) {
    const groupId = await checkoutGroupId(session, orgId);
    if (groupId) await linkStripeCustomerForGroup(groupId, session.customer as string);
  }

  // Subscription details arrive via subscription.created; nothing more to do here.
}

/**
 * Grant a paid size-pack purchase (v17 Phase 3 Task 3b): write ONE org_addons
 * row lifting the target competition's entrant cap. The SINGLE writer of that
 * row.
 *
 * Snapshot-first (T1 lesson): the grant reads feature_key + delta_each from the
 * session metadata SNAPSHOT stamped at checkout creation, so a later catalog
 * edit can never change an already-bought pack. The live size_pack_catalog is
 * only a LOGGED last-resort fallback (staff-alerted on drift) — never a silent
 * wrong/zero grant.
 *
 * Idempotent: a one-time pack has no subscription item, so stripe_item_id holds
 * the PAYMENT_INTENT id (the Stripe object that created the row); the V324
 * partial unique index makes a redelivered webhook a no-op via
 * `on conflict (stripe_item_id) where stripe_item_id is not null do nothing` —
 * the WHERE predicate matches the partial index. A replay must not double-lift.
 */
async function grantSizePackAddon(session: Stripe.Checkout.Session): Promise<void> {
  const md = session.metadata ?? {};
  const targetOrgId = md.target_org_id;
  const targetCompetitionId = md.target_competition_id;
  const sizePackKey = md.size_pack_key;
  if (!targetOrgId || !targetCompetitionId) {
    log.error(
      { sessionId: session.id },
      "billing: size_pack session missing target_org_id/target_competition_id — cannot resolve which cap to lift; skipping",
    );
    return;
  }

  // Snapshot-first: trust what was stamped at checkout creation.
  const snapDelta = md.delta_each ? Number(md.delta_each) : NaN;
  let featureKey = md.feature_key || "";
  let deltaEach = Number.isFinite(snapDelta) && snapDelta > 0 ? snapDelta : NaN;
  if (!featureKey || !Number.isFinite(deltaEach)) {
    const cat = sizePackKey ? await getSizePack(sizePackKey) : null;
    if (cat) {
      featureKey = featureKey || cat.feature_key;
      deltaEach = Number.isFinite(deltaEach) ? deltaEach : cat.delta_each;
      log.error(
        { sessionId: session.id, featureKey: md.feature_key, deltaEach: md.delta_each, sizePackKey },
        "billing: size_pack session had no usable snapshot — fell back to catalog lookup by size_pack_key",
      );
    }
  }
  if (!featureKey || !Number.isFinite(deltaEach) || deltaEach <= 0) {
    // Paid but ungranted — surface it, never a silent no-op (mirrors credit packs).
    log.error(
      { sessionId: session.id, targetOrgId, sizePackKey },
      "billing: size_pack session paid but ungranted — no usable snapshot and no resolvable size_pack_key",
    );
    await alertSizePackGrantFailed({
      sessionId: session.id,
      targetOrgId,
      competitionId: targetCompetitionId,
      sizePackKey,
      reason: "no snapshot and no resolvable size_pack_key",
    });
    return;
  }

  const stripeItemId =
    typeof session.payment_intent === "string" ? session.payment_intent : session.id;
  const walletId = await walletIdFor(targetOrgId);
  await sql`
    insert into org_addons
      (wallet_id, target_org_id, target_competition_id, feature_key, delta_each, qty,
       stripe_item_id, status)
    values (${walletId}, ${targetOrgId}, ${targetCompetitionId}, ${featureKey},
            ${deltaEach}, 1, ${stripeItemId}, 'active')
    on conflict (stripe_item_id) where stripe_item_id is not null do nothing`;
}
