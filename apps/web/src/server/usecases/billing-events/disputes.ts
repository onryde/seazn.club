import "server-only";
// Stripe event processing: platform-charge disputes (see ./index.ts).
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { recordPassRefund } from "@/lib/credits";
// MATCH credits — a different currency from @/lib/credits above, on its own
// table and its own writer. Kept adjacent deliberately so the next reader sees
// that the two are distinct rather than duplicated. The PURCHASE grant lives in
// stream-credits-checkout.ts, shared with reconcile-on-return (Task 14 G1).
import { findStreamPurchase, recordStreamPackRefund } from "@/server/usecases/stream-credits";
import { isPassKey } from "@/lib/currency";
import { SEAT_ADDON } from "@/lib/seat-addons";
import { ORG_ADDON_FEATURE_KEY } from "@/lib/org-addons";
import {
  invalidateGroupEntitlements,
  invalidateOrgEntitlements,
} from "@/lib/entitlements";
import { getStripe } from "@/lib/stripe";
import { STREAM_CLAWBACK_REASON, alertStreamClawback, notifyStaffDispute } from "./staff-alerts";
import { groupForCustomer, primaryOrgForGroup } from "./group-resolution";

// ---------------------------------------------------------------------------
// Platform-charge disputes (Task 7, P1-4, decisions §6.2)
// ---------------------------------------------------------------------------

/** The Stripe customer behind a dispute's charge. A charge.dispute.* event
 *  carries `charge` as an id STRING, so reading the customer needs a charge
 *  retrieve — done OUTSIDE any tx and guarded on STRIPE_SECRET_KEY (mirroring
 *  platform-revenue); keyless envs skip it and the subscription branch no-ops.
 *  An already-expanded charge object (tests) is read inline, no Stripe call. */
async function disputeCustomerId(dispute: Stripe.Dispute): Promise<string | null> {
  const charge = dispute.charge;
  if (typeof charge === "object" && charge) {
    return typeof charge.customer === "string" ? charge.customer : (charge.customer?.id ?? null);
  }
  if (typeof charge === "string" && process.env.STRIPE_SECRET_KEY) {
    try {
      const full = await getStripe().charges.retrieve(charge);
      return typeof full.customer === "string" ? full.customer : (full.customer?.id ?? null);
    } catch {
      return null; // a retrieve failure must never block the webhook ACK
    }
  }
  return null;
}

/**
 * Disputes on PLATFORM charges (decisions 2026-07-18 §6.2): `created` = flag +
 * staff alert; `closed lost` on a subscription charge = auto-downgrade the org;
 * `closed lost` on a pass charge = revoke the pass; `closed won` clears the
 * flag. Unlike a destination-charge dispute there is NO transfer to reverse —
 * a platform charge's money left the platform account directly, so recovery is
 * entitlement truth-up, never recoverDisputedTransfer. Registration + sponsor
 * handlers already no-op'd (no matching rows) before this runs; it is dispatched
 * LAST in both dispute cases.
 *
 * Replay-safe: the flag / clear / downgrade / revoke writes all converge, and
 * the staff breadcrumb + email never throw. Stripe calls (charge retrieve) stay
 * OUTSIDE any sql tx.
 */
export async function handlePlatformDispute(
  dispute: Stripe.Dispute,
  phase: "created" | "closed",
): Promise<boolean> {
  const intent =
    typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;

  // Pass charge? Matched by payment intent — works keyless. `pass_key` comes
  // along so the staff alert names the RUNG that was actually bought (v17 #294):
  // a disputed $59 Event Pass L labelled "Event Pass" sends whoever triages it
  // hunting for a $29 charge that never existed.
  if (intent) {
    const [pass] = await sql<{ org_id: string; pass_key: string }[]>`
      select org_id, pass_key from competition_passes where stripe_payment_intent = ${intent}`;
    if (pass) {
      if (phase === "closed" && dispute.status === "lost") {
        // Money-safety: claw back the pass's one-time credit grant (keyed on the
        // same payment intent) BEFORE the delete, so a lost dispute pulls the 25
        // credits like a refund does. Idempotent on `pass_refund:${intent}` — a
        // dispute after a refund (or a redelivered event) won't double-claw, and
        // it reads the immutable `pass_grant` ledger row, not the pass row.
        await recordPassRefund(intent);
        // Its MATCH credits stay, as on a refund (lib/billing.ts
        // `revokePassForRefundedCharge`; Task 14b fix round 2 ruling).
        await sql`delete from competition_passes where stripe_payment_intent = ${intent}`;
        await invalidateOrgEntitlements(pass.org_id);
      }
      // isPassKey, not a cast: the column is `not null default 'event_pass'` and
      // a row written before #294 (or by a future rung this build predates) must
      // still produce a valid label rather than a missing i18n key.
      await notifyStaffDispute(
        isPassKey(pass.pass_key) ? pass.pass_key : "event_pass",
        pass.org_id,
        dispute,
        phase,
      );
      return true;
    }

    // Match-credit pack charge? Also matched by payment intent (streaming R1,
    // OWNER RULING 2026-09-28). This MUST sit ahead of the subscription branch
    // below: that one matches on the Stripe CUSTOMER and returns false for a
    // pack charge, so a disputed pack would fall out of the dispatcher entirely
    // — a `created` would throw and retry forever, a lost `closed` would leave
    // the credits with a customer who took the money back.
    const stream = await findStreamPurchase(sql, intent);
    if (stream) {
      if (phase === "closed" && dispute.status === "lost") {
        // The SAME writer, the SAME key (`stream_pack_refund:${intent}`) as the
        // refund arm — a dispute AFTER a refund cannot double-claw, and the key
        // is what makes that true where the refund WROTE a row: the balance cap
        // cannot, because an org that has since bought another pack has a
        // non-zero balance again. Where the refund clawed nothing there is no
        // key, and the writer's attribution bound is what holds instead.
        const res = await recordStreamPackRefund({ paymentIntentId: intent, via: "dispute", reference: dispute.id });
        // The ruling says a lost dispute claws back ON THE SAME TERMS as a
        // refund, and the staff alert is part of those terms. Without these two
        // lines a lost dispute is the only money write on this path with no
        // figure anywhere a human reads: the ledger row is the whole trail,
        // `notifyStaffDispute`'s audit detail carries no credit counts, and the
        // outcome copy says "capped at the balance left" without saying by how
        // much. Same condition as the refund arm, so the two cannot drift.
        log.info(
          { disputeId: dispute.id, intent, orgId: res.orgId, purchased: res.purchased, clawedBack: res.clawedBack, applied: res.applied },
          "billing: match-credit pack clawed back on a lost dispute",
        );
        if (res.matched && res.clawedBack < res.purchased) {
          await alertStreamClawback({
            shape: "lost",
            refType: "dispute",
            refId: dispute.id,
            orgId: res.orgId ?? stream.orgId,
            purchased: res.purchased,
            clawedBack: res.clawedBack,
            reason: STREAM_CLAWBACK_REASON.short,
          });
        }
      }
      await notifyStaffDispute("stream_credits", stream.orgId, dispute, phase);
      return true;
    }
  }

  // Subscription charge? Matched by the Stripe customer on the charge.
  const customer = await disputeCustomerId(dispute);
  if (!customer) return false;
  const subscriptionId = await groupForCustomer(customer);
  if (!subscriptionId) return false; // not a platform subscription charge
  // The dispute is against the GROUP's invoice; staff notification still needs
  // one org to name, so the group's primary org stands in for it.
  const orgId = await primaryOrgForGroup(subscriptionId);
  if (!orgId) return false;

  if (phase === "created") {
    // coalesce keeps the FIRST flag time so a duplicate created (or a manual
    // /admin/billing-events re-process) never re-stamps disputed_at — mirrors
    // sponsors.ts's created path.
    await sql`update subscriptions set disputed_at = coalesce(disputed_at, now()),
              dispute_id = ${dispute.id}, updated_at = now() where id = ${subscriptionId}`;
  } else if (dispute.status === "won") {
    // Guard on dispute_id: a win resolving long after the customer re-bought
    // clears ONLY the flag it set, never a newer dispute's — and clears
    // dispute_id too so no sticky flag is left behind.
    await sql`update subscriptions set disputed_at = null, dispute_id = null, updated_at = now()
              where id = ${subscriptionId} and dispute_id = ${dispute.id}`;
  } else if (dispute.status === "lost") {
    // Same guard: a stale loss (60+ days on) must not clobber a subscription the
    // customer has since renewed/re-bought under a different (or no) dispute.
    await sql`update subscriptions set plan_key = 'community', status = 'canceled',
              updated_at = now() where id = ${subscriptionId} and dispute_id = ${dispute.id}`;
    // The plan is one axis; recurring add-ons sit on TOP of it (#331). Losing a
    // dispute is churn by another route — nothing else cancels these rows on
    // this path, because syncOrgAddonsForSubscription runs only on
    // `customer.subscription.updated`, which a dispute never emits — so the
    // group kept `community base + N` on orgs.max_owned AND members.max, for
    // ever and unpaid. Scoped exactly like the churn cancel: these two
    // Stripe-billed families only, `stripe_item_id is not null` so an
    // ADMIN-granted comp (SPEC-3, status='granted', null item id) survives, and
    // FROZEN rather than deleted so the qty stays for history and a re-buy.
    // Guarded on dispute_id like the update above — via `exists`, since the
    // update may have to fire on a group whose plan row was already community —
    // so a stale loss that clobbered no plan strips no capacity either.
    await sql`
      update org_addons set status = 'canceled'
       where wallet_id = ${subscriptionId}
         and feature_key in ${sql([ORG_ADDON_FEATURE_KEY, SEAT_ADDON.featureKey])}
         and stripe_item_id is not null and status = 'active'
         and exists (select 1 from subscriptions s
                      where s.id = ${subscriptionId} and s.dispute_id = ${dispute.id})`;
    // A lost dispute cancels the plan for every org in the group.
    await invalidateGroupEntitlements(subscriptionId);
  }
  await notifyStaffDispute("subscription", orgId, dispute, phase);
  return true;
}
