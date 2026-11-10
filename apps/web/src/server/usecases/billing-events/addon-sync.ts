import "server-only";
// Stripe event processing: seat / extra-org add-on rows from subscription items (see ./index.ts).
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { walletIdFor } from "@/lib/credits";
import { SEAT_ADDON, isSeatAddonItem } from "@/lib/seat-addons";
import { ORG_ADDON_FEATURE_KEY, ORG_ADDON_DELTA_EACH, isOrgAddonItem } from "@/lib/org-addons";

/**
 * Reflect a subscription's extra-seat items into org_addons (v17 SPEC-2 §3,
 * §11.3, Phase 3 Task 3a). The ROUTE (setExtraSeats) mutates Stripe; THIS is
 * the SINGLE writer of the seat rows, so Stripe and the DB can never diverge.
 *
 * `subscriptionId` is the resolved billing GROUP (the wallet id for every org
 * grouped under it — coalesce(subscription_id, org_id) resolves to exactly this
 * for a member org). For each seat item present on the subscription, UPSERT its
 * org_addons row keyed on `stripe_item_id` (the V324 partial-unique key IS the
 * idempotency — a redelivered event neither duplicates a row nor double-counts
 * the cap). Any active seat row for this group whose item Stripe no longer
 * reports (removed, or quantity 0) is FLIPPED to status='canceled'
 * (freeze-not-delete, V323/V324) — never deleted, never written with qty=0
 * (the V324 CHECK forbids it).
 */
export async function syncSeatAddonsForSubscription(
  stripeSub: Stripe.Subscription,
  subscriptionId: string,
): Promise<void> {
  const seatItems = (stripeSub.items?.data ?? []).filter(isSeatAddonItem);
  const seenItemIds: string[] = [];
  for (const item of seatItems) {
    const targetOrgId = item.metadata?.target_org_id;
    if (!targetOrgId) {
      log.error(
        { itemId: item.id, stripeSubscriptionId: stripeSub.id },
        "billing: seat item carries no target_org_id metadata — cannot resolve which org's cap to lift; skipping",
      );
      continue;
    }
    // A seat SKU lifts members.max BY DEFINITION (isSeatAddonItem matched it by
    // lookup_key). Pin the feature_key instead of trusting item metadata: a
    // divergent metadata.feature_key would write the row on an arbitrary cap
    // that the members.max-scoped reconcile below never cancels — a stuck lift.
    const featureKey = SEAT_ADDON.featureKey;
    const qty = item.quantity ?? 0;
    if (qty <= 0) {
      // A quantity-0 seat item is a removal in disguise: never write qty=0
      // (the V324 CHECK forbids it), flip any existing row to canceled instead.
      await sql`
        update org_addons set status = 'canceled'
         where stripe_item_id = ${item.id} and status <> 'canceled'`;
      continue;
    }
    // The wallet the resolver keys on (SPEC-2 §11.1): a grouped org resolves to
    // its group's subscription id, i.e. `subscriptionId` here.
    const walletId = await walletIdFor(targetOrgId);
    await sql`
      insert into org_addons
        (wallet_id, target_org_id, target_competition_id, feature_key, delta_each, qty,
         stripe_item_id, status)
      values (${walletId}, ${targetOrgId}, null, ${featureKey}, ${SEAT_ADDON.deltaEach},
              ${qty}, ${item.id}, 'active')
      on conflict (stripe_item_id) where stripe_item_id is not null
      do update set qty = excluded.qty, status = 'active',
        wallet_id = excluded.wallet_id, target_org_id = excluded.target_org_id,
        feature_key = excluded.feature_key, delta_each = excluded.delta_each`;
    seenItemIds.push(item.id);
  }

  // Reconcile removals: an active Stripe-origin seat row (non-null
  // stripe_item_id, the seat feature_key) for THIS group whose item Stripe no
  // longer reports is gone. Scoped to SEAT_ADDON.featureKey so a future
  // size-pack add-on (Task 3b) on a different feature on the same wallet is
  // never swept here. When no seat items remain, every active seat row goes.
  if (seenItemIds.length === 0) {
    await sql`
      update org_addons set status = 'canceled'
       where wallet_id = ${subscriptionId} and feature_key = ${SEAT_ADDON.featureKey}
         and stripe_item_id is not null and status = 'active'`;
  } else {
    await sql`
      update org_addons set status = 'canceled'
       where wallet_id = ${subscriptionId} and feature_key = ${SEAT_ADDON.featureKey}
         and stripe_item_id is not null and status = 'active'
         and stripe_item_id not in ${sql(seenItemIds)}`;
  }
}

/**
 * Reflect a subscription's extra-ORGANISATION items into org_addons (v17 gap
 * #293; design/v17-pricing-entitlements SPEC-2 §3, §11.3). The ROUTE
 * (setExtraOrgs) mutates Stripe; THIS is the SINGLE writer of the resulting
 * rows, so Stripe and the DB can never diverge — the same contract as
 * syncSeatAddonsForSubscription, deliberately kept as a SIBLING of it rather
 * than folded into one shared function:
 *
 *  - A seat is PER-ORG. It resolves a `target_org_id` out of item metadata and
 *    refuses the item without one, because a seat lifts exactly one club's
 *    members.max.
 *  - An extra org is GROUP-WIDE. `orgs.max_owned` is a property of the whole
 *    billing group (every member org resolves the same cap), so `target_org_id`
 *    is ALWAYS null and there is no metadata to resolve — which is also what
 *    keeps the two families apart at the filter: `isSeatAddonItem` requires
 *    `metadata.target_org_id`, which an org-addon item never carries.
 *
 * Sharing one function would mean either dropping the seat's target_org_id
 * guard-rail or growing a mode flag through the seat path for no gain; the
 * codebase already prefers siblings here (grantSizePackAddon sits beside the
 * seat sync for the same reason).
 *
 * `feature_key`/`delta_each` are PINNED from the catalog
 * (ORG_ADDON_FEATURE_KEY/ORG_ADDON_DELTA_EACH), never trusted from item
 * metadata: a divergent metadata key would write the row on an arbitrary cap
 * that the orgs.max_owned-scoped reconcile below never cancels — a stuck lift.
 *
 * UPSERT keyed on `stripe_item_id` — V324's partial unique index IS the
 * idempotency (feature-key agnostic, so it serves seats and org add-ons alike),
 * and a redelivered event therefore neither duplicates a row nor double-counts
 * the cap. Any active org-addon row for this GROUP whose item Stripe no longer
 * reports is FLIPPED to status='canceled' (freeze-not-delete, V323/V324) —
 * never deleted, never written with qty=0 (the V324 CHECK forbids it).
 */
export async function syncOrgAddonsForSubscription(
  stripeSub: Stripe.Subscription,
  subscriptionId: string,
): Promise<void> {
  const orgItems = (stripeSub.items?.data ?? []).filter(isOrgAddonItem);
  const seenItemIds: string[] = [];
  for (const item of orgItems) {
    const qty = item.quantity ?? 0;
    if (qty <= 0) {
      // A quantity-0 item is a removal in disguise: never write qty=0 (the
      // V324 CHECK forbids it), flip any existing row to canceled instead.
      await sql`
        update org_addons set status = 'canceled'
         where stripe_item_id = ${item.id} and status <> 'canceled'`;
      continue;
    }
    // `subscriptionId` IS the wallet id here: it is the resolved billing group,
    // and every member org's wallet (coalesce(subscription_id, org_id)) already
    // resolves to exactly it. No walletIdFor() lookup, unlike the per-org seat
    // write — there is no single target org to resolve one through.
    await sql`
      insert into org_addons
        (wallet_id, target_org_id, target_competition_id, feature_key, delta_each, qty,
         stripe_item_id, status)
      values (${subscriptionId}, null, null, ${ORG_ADDON_FEATURE_KEY}, ${ORG_ADDON_DELTA_EACH},
              ${qty}, ${item.id}, 'active')
      on conflict (stripe_item_id) where stripe_item_id is not null
      do update set qty = excluded.qty, status = 'active',
        wallet_id = excluded.wallet_id, target_org_id = excluded.target_org_id,
        feature_key = excluded.feature_key, delta_each = excluded.delta_each`;
    seenItemIds.push(item.id);
  }

  // Reconcile removals: an active Stripe-origin org-addon row (non-null
  // stripe_item_id) for THIS group whose item Stripe no longer reports is gone.
  // Scoped to ORG_ADDON_FEATURE_KEY so a seat or size-pack row on the same
  // wallet is never swept here, and to `stripe_item_id is not null` so an
  // ADMIN-granted comp of the same cap (SPEC-3, status='granted', null item id)
  // survives a purchased add-on's cancellation.
  if (seenItemIds.length === 0) {
    await sql`
      update org_addons set status = 'canceled'
       where wallet_id = ${subscriptionId} and feature_key = ${ORG_ADDON_FEATURE_KEY}
         and stripe_item_id is not null and status = 'active'`;
  } else {
    await sql`
      update org_addons set status = 'canceled'
       where wallet_id = ${subscriptionId} and feature_key = ${ORG_ADDON_FEATURE_KEY}
         and stripe_item_id is not null and status = 'active'
         and stripe_item_id not in ${sql(seenItemIds)}`;
  }
}
