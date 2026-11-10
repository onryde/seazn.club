import "server-only";
// Stripe event processing: customer.subscription.* and payment-method mirroring (see ./index.ts).
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { syncPaymentMethodFlagForSubscription, syncSubscriptionForGroup } from "@/lib/billing";
import { SEAT_ADDON } from "@/lib/seat-addons";
import { ORG_ADDON_FEATURE_KEY } from "@/lib/org-addons";
import { invalidateGroupEntitlements } from "@/lib/entitlements";
import { creditPassTowardSubscription } from "@/server/usecases/pass-credit";
import { trialEndingEmail } from "@/lib/email";
import { enqueueEmailOnce, expiryWithin, onceKey, recipientLocale } from "@/server/email-outbox";
import { planLabel } from "@/lib/plan-label";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import {
  attributionOrgForGroup,
  groupForCustomer,
  mayWriteGroup,
  ownerDistinctId,
  resolveGroupForStripeSub,
} from "./group-resolution";
import { syncSeatAddonsForSubscription, syncOrgAddonsForSubscription } from "./addon-sync";
import { convergeOrgAddonPrices } from "./addon-pricing";

/**
 * A card was attached, detached, or the customer's default changed — in the
 * Stripe dashboard, not in our UI. Re-mirror has_payment_method so the trial
 * banner agrees with Stripe either way.
 *
 * A DETACHED payment method carries a null customer (Stripe nulls the link as
 * part of the change), so the org has to come from previous_attributes.
 *
 * customer.updated is CHATTY — it fires for a name, an address, a tax id, a
 * balance change — and only invoice_settings can move the default card, so
 * that event is gated on previous_attributes.invoice_settings and everything
 * else is a cheap ACK instead of a Stripe round trip. attached/detached stay
 * unconditional: those events ARE the card change.
 */
export async function handlePaymentMethodChanged(event: Stripe.Event) {
  const object = event.data.object as { id?: string; customer?: string | { id: string } | null };
  const previous = (event.data as {
    previous_attributes?: { customer?: string | null; invoice_settings?: unknown };
  }).previous_attributes;
  if (event.type === "customer.updated" && !(previous && "invoice_settings" in previous)) return;
  const raw =
    event.type === "customer.updated"
      ? object.id
      : (typeof object.customer === "string" ? object.customer : object.customer?.id) ??
        previous?.customer;
  const subscriptionId = await groupForCustomer(raw);
  if (!subscriptionId) return;
  await syncPaymentMethodFlagForSubscription(subscriptionId);
}

export async function handleSubscriptionChanged(stripeSub: Stripe.Subscription) {
  const resolved = await resolveGroupForStripeSub(stripeSub);
  if (!resolved) return;
  if (!(await mayWriteGroup(resolved, stripeSub))) return;
  await syncSubscriptionForGroup(resolved.subscriptionId, stripeSub);
  log.info(
    {
      subscriptionId: resolved.subscriptionId,
      stripeSubscriptionId: stripeSub.id,
      status: stripeSub.status,
    },
    "billing: subscription row synced from webhook",
  );
  // Plan/status just moved on the shared row: every org in the group resolves
  // through it, so a single-org invalidation would leave siblings on the old
  // plan for the 300s TTL.
  await invalidateGroupEntitlements(resolved.subscriptionId);
  // Extra-seat add-ons ride the same subscription as extra items (SPEC-2 §11.3,
  // Phase 3 Task 3a); reflect their current state into org_addons. getLimit sums
  // org_addons UNCACHED (lib/entitlements.addonBonus), so no further entitlement
  // invalidation is needed for a seat change to bite on the next read.
  await syncSeatAddonsForSubscription(stripeSub, resolved.subscriptionId);
  // The extra-org rider is priced PER TIER ($9 Pro / $19 Pro Plus), so a plan
  // change makes every existing rider item wrong. This is the only convergence
  // point that catches all three ways a plan can move (in-app, Stripe
  // Dashboard, Customer Portal), and it must run BEFORE the row sync so that
  // sync sees the post-update items rather than the ones we just replaced.
  // Never throws — see its doc comment.
  await convergeOrgAddonPrices(stripeSub, resolved.subscriptionId);
  // Extra-ORGANISATION add-ons (v17 gap #293) ride the same subscription as
  // further items, but lift a GROUP-WIDE cap rather than one org's — see
  // syncOrgAddonsForSubscription's own doc comment for why this is a sibling
  // function and not a shared generalisation of the seat sync. Same
  // no-invalidation reasoning as the seat call above: getLimit sums org_addons
  // UNCACHED, so the new cap bites on the next read.
  await syncOrgAddonsForSubscription(stripeSub, resolved.subscriptionId);

  // Pass-to-Pro credit (v3/07 D12; grant timing moved 2026-07-26 — see
  // docs/superpowers/specs/2026-07-26-pass-credit-redemption-design.md §1). This
  // is one of the two arms that "learn a subscription started"; the other is
  // reconcileCheckout (lib/billing.ts), for environments where this webhook
  // never arrives. `org_id` is the buying org — stamped onto BOTH the session
  // and subscription_data.metadata by buildEmbeddedCheckoutParams, so it is
  // present on every subscription this webhook was ever going to fire for.
  //
  // Deliberately UNCONDITIONAL rather than gated to "this is a genuine
  // trialing/active transition": this handler fires on customer.subscription
  // .created AND .updated, i.e. on every seat change, dunning retry and plan
  // edit too, not just the moment the subscription first goes live. Gating on
  // a transition would need to reliably distinguish "just started" from "still
  // running" from a single event — and get the re-buy case right (a NEW
  // subscription replacing a canceled one on the same group, the
  // metadata_subscription_id branch of mayWriteGroup above) — for a saving
  // that is not worth the risk of silently skipping the one event that should
  // have minted the credit. `creditPassTowardSubscription` starts with
  // `groupAlreadyRedeemed`, a single indexed SELECT that runs before any
  // Stripe call and short-circuits on the (overwhelmingly common) case where
  // the group has already redeemed or never held a pass, so calling it on
  // every update is a cheap no-op, not a repeated Stripe round trip.
  //
  // One consequence worth naming: `mostRecentPass` inside the usecase reads
  // whatever the org's most recent pass is AT THE MOMENT this particular
  // webhook happens to succeed — not pinned to the event that started the
  // subscription. If the very first attempt is skipped (mayWriteGroup
  // refuses an out-of-order delivery, or `groupAlreadyRedeemed`'s DB read
  // fails closed on a transient error), a LATER webhook — a dunning retry, a
  // seat change — becomes the one that actually credits. That is a feature,
  // not a bug: it is what makes a skipped first attempt self-healing rather
  // than a permanently lost credit. It does mean the credit is not
  // deterministically tied to "the subscription just started" the way the
  // v3/07 window language ("bought in the last 30 days") reads — it is tied
  // to "a webhook that could write this group's redemption eventually ran",
  // bounded by `withinCreditWindow` inside the usecase either way.
  if (stripeSub.metadata?.org_id) {
    await creditPassTowardSubscription(stripeSub.metadata.org_id);
  }
}

export async function handleSubscriptionDeleted(stripeSub: Stripe.Subscription) {
  const resolved = await resolveGroupForStripeSub(stripeSub);
  if (!resolved) return;
  const subscriptionId = resolved.subscriptionId;
  // Stale-event guard (P1-5): only the CURRENTLY stored subscription may
  // downgrade the group — a late-delivered deleted for a replaced sub must not
  // touch a resubscribed customer. A delete is terminal, so this holds on the
  // stamped path too (mayWriteGroup's re-buy exemption needs a LIVE status).
  if (!(await mayWriteGroup(resolved, stripeSub))) return;
  await sql`
    update subscriptions
    set plan_key = 'community', status = 'canceled', updated_at = now(),
        -- Paid slots die with the subscription: a re-buy starts from the real
        -- org count, never from what the dead subscription had been billed for.
        quantity_paid = 1,
        status_changed_at = case when status is distinct from 'canceled'
                                 then now() else status_changed_at end
    where id = ${subscriptionId}`;
  // The plan is only ONE of the two axes the resolver adds up (v17 gap #293,
  // acceptance item 4). Recurring add-ons sit on TOP of the plan base, and
  // nothing here was cancelling them: syncOrgAddonsForSubscription runs only on
  // `customer.subscription.updated`, and a DELETED subscription still reports
  // its items, so its reconcile sweep never sees an empty list and never fires.
  // A churned group therefore kept `community base 1 + N` orgs.max_owned for
  // ever and unpaid — buy the rider, create org #11, cancel the subscription,
  // keep the capacity. That is V314:244-245's "silent reseller", and it is a
  // strictly bigger hole than the self-serve reduction setExtraOrgs guards,
  // which churn bypasses entirely.
  //
  // BOTH Stripe-billed add-on families, not just the extra-org rider: the seat
  // (`members.max`) rows had the identical hole, for the identical reason, and
  // closing it is issue #330.
  //
  // Scoped exactly like that sweep in every other respect: these feature keys
  // only, so a size-pack or any future family on the same wallet survives, and
  // `stripe_item_id is not null`, so an ADMIN-granted comp of either cap
  // (SPEC-3, status='granted', null item id) survives — a grant is capacity the
  // group was GIVEN, never something Stripe was billing. FROZEN, never deleted
  // (V323/V324) — the qty stays for history and for a re-buy.
  await sql`
    update org_addons set status = 'canceled'
     where wallet_id = ${subscriptionId}
       and feature_key in ${sql([ORG_ADDON_FEATURE_KEY, SEAT_ADDON.featureKey])}
       and stripe_item_id is not null and status = 'active'`;
  // A cancel drops EVERY org in the group to Community at once.
  await invalidateGroupEntitlements(subscriptionId);
  log.info(
    { subscriptionId, stripeSubscriptionId: stripeSub.id },
    "billing: subscription canceled — group dropped to community",
  );
  // Attribution only. Prefer the org the checkout named, but ONLY if it still
  // bills through this group — otherwise a cancel would be reported against an
  // org that has since moved elsewhere.
  const orgId = await attributionOrgForGroup(subscriptionId, stripeSub.metadata?.org_id);
  if (!orgId) return;
  await captureServer({
    event: EVENTS.SUBSCRIPTION_CANCELED,
    distinctId: await ownerDistinctId(orgId),
    orgId,
  });
}

/**
 * `customer.subscription.trial_will_end` — Stripe's three-day warning, and the
 * only notice a trialing group gets before the trial resolves itself.
 *
 * The email is the WHOLE point: a DB write here would be an inert seam, since
 * `trial_end` is already mirrored by `customer.subscription.updated` and no
 * screen is waiting on anything this event carries. So the one thing this must
 * do is reach a person.
 *
 * Which sentence they get turns on `has_payment_method`, read from OUR mirror
 * rather than from the event: a no-card trial CANCELS at trial end
 * (`missing_payment_method: "cancel"`, lib/billing-manage.ts) and needs a card
 * to survive, while a card-on-file trial simply charges — telling the second
 * group to "add a card" would be wrong copy on a money screen. The mirror is
 * the right source because a trialing subscription's own webhook payload does
 * not carry its default payment method (see `syncSubscriptionForGroup`'s
 * `hasPm` note), so the event cannot answer this question about itself.
 *
 * The warning is queued on the email outbox (kind `trial_ending`, ref
 * `subscription/<group id>`, no organisation: a group can span several),
 * addressed to the payer's account (`subscriptions.owner_user_id`, resolved at
 * send) in the payer's language (D4: the account's, then the default of the org
 * the billing link points at), TRANSACTIONAL as it always was, and the worker
 * makes the first attempt. The once-key is the Stripe EVENT id: a redelivery,
 * the stuck-event sweeper or a staff replay of one event queues one row, while a
 * changed trial (a new `trial_will_end`, so a new event id) queues a new row
 * that replaces a still-queued earlier one (the outbox's replace trigger).
 *
 * An unresolvable group, a group with no reachable payer (none, or a deleted
 * account) and an event with no `trial_end` ACK with a log line: there is no
 * one to warn, or nothing to warn about. A refused enqueue throws (D1), so the
 * event stays unprocessed in the ledger and is run again; the once-key holds
 * every run of it to one row.
 */
export async function handleTrialWillEnd(stripeSub: Stripe.Subscription, eventId: string): Promise<void> {
  const resolved = await resolveGroupForStripeSub(stripeSub);
  if (!resolved) {
    log.warn(
      { stripeSubscriptionId: stripeSub.id },
      "billing: trial_will_end for an unresolvable group",
    );
    return;
  }
  const [row] = await sql<
    {
      plan_key: string | null;
      has_payment_method: boolean | null;
      owner_user_id: string;
      owner_email: string | null;
      org_slug: string | null;
      org_default_locale: string | null;
    }[]
  >`
    select s.plan_key, s.has_payment_method, s.owner_user_id, u.email as owner_email,
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
    where s.id = ${resolved.subscriptionId}`;
  if (!row?.owner_email) {
    log.warn(
      { subscriptionId: resolved.subscriptionId },
      "billing: trial_will_end — group has no reachable owner",
    );
    return;
  }
  // Stripe's own trial_end on THIS event, not our mirror: the event is the
  // fresher of the two (it is sent ahead of the `updated` that moves the
  // mirror), and it is the date the reader is being warned about.
  const trialEnd = stripeSub.trial_end
    ? new Date(stripeSub.trial_end * 1000).toISOString()
    : null;
  if (!trialEnd) {
    log.warn(
      { subscriptionId: resolved.subscriptionId, stripeSubscriptionId: stripeSub.id },
      "billing: trial_will_end carried no trial_end",
    );
    return;
  }
  const locale = await recipientLocale(sql, { pick: null, userId: row.owner_user_id, orgDefault: row.org_default_locale });
  const kind = "trial_ending";
  await enqueueEmailOnce(sql, {
    kind,
    refType: "subscription",
    refId: resolved.subscriptionId,
    orgId: null,
    to: row.owner_email,
    recipientUserId: row.owner_user_id,
    ...(await trialEndingEmail(
      {
        planName: planLabel(row.plan_key),
        trialEnd,
        hasPaymentMethod: row.has_payment_method === true,
        orgSlug: row.org_slug,
      },
      locale,
    )),
    transactional: true,
    expiresAt: expiryWithin(null),
    dedupeKey: onceKey(kind, "subscription", eventId),
  });
}
