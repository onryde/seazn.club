import "server-only";
// Stripe event processing: which billing group / org a Stripe object belongs to (see ./index.ts).
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { orgIdsInGroup, subscriptionIdForOrg } from "@/lib/billing-group";
import { isTerminalStripeStatus } from "@/lib/subscription-status";

/** Best-effort person id for org-scoped revenue events: the org owner, falling
 *  back to a synthetic org id so the event still lands on the org group. */
export async function ownerDistinctId(orgId: string): Promise<string> {
  const [row] = await sql<{ created_by: string | null }[]>`
    select created_by from organizations where id = ${orgId}`;
  return row?.created_by ?? `org:${orgId}`;
}

/**
 * Which billing GROUP did this checkout session pay for?
 *
 * `metadata.subscription_id` is stamped by buildEmbeddedCheckoutParams and names
 * the group that actually paid, whatever has happened to the org since. It is
 * verified against the table rather than trusted — a deleted group must not be
 * written, and metadata is not a trusted channel. Falls back to the buying org's
 * current group for sessions created before the stamp shipped.
 */
export async function checkoutGroupId(
  session: Stripe.Checkout.Session,
  orgId: string,
): Promise<string | null> {
  const stamped = session.metadata?.subscription_id;
  if (stamped) {
    const [row] = await sql<{ id: string }[]>`
      select id from subscriptions where id = ${stamped}`;
    if (row) return row.id;
    // Call through the logger object — extracting log.error/log.warn and
    // invoking unbound loses `this`, and pino then throws
    // "Cannot read properties of undefined (reading 'Symbol(pino.msgPrefix)')",
    // which aborted the Stripe webhook with 500 on this path.
    log[session.livemode ? "error" : "warn"](
      { sessionId: session.id, stamped },
      "billing: checkout session stamped with unknown group",
    );
  }
  return subscriptionIdForOrg(orgId);
}

/** Billing GROUP behind a Stripe customer id, or null when we do not bill them.
 *  A Stripe customer belongs to the subscription, not to any one org, so this
 *  deliberately returns the subscription id rather than picking a member org. */
export async function groupForCustomer(customerId: string | null | undefined): Promise<string | null> {
  if (!customerId) return null;
  const [row] = await sql<{ id: string }[]>`
    select id from subscriptions where stripe_customer_id = ${customerId}`;
  return row?.id ?? null;
}

/**
 * An org to attribute a group-level event to (staff alert name, audit target,
 * analytics). Oldest LIVE member org, so the choice is stable across sweeps and
 * replays.
 *
 * `deleted_at is null` matters: orgIdsInGroup deliberately includes
 * soft-deleted orgs (they still bear on billing), but a deleted org has no
 * owner left for orgOwnerRecipient to find, so attributing a dispute alert or a
 * PAYMENT_FAILED to it would send the notification nowhere. Falls back to the
 * oldest org of any state rather than dropping the event entirely — a group
 * whose every org is deleted still has a real invoice failing.
 */
export async function primaryOrgForGroup(subscriptionId: string): Promise<string | null> {
  const [live] = await sql<{ id: string }[]>`
    select id from organizations
    where subscription_id = ${subscriptionId} and deleted_at is null
    order by created_at limit 1`;
  if (live) return live.id;
  const orgs = await orgIdsInGroup(subscriptionId);
  return orgs[0] ?? null;
}

/** How a Stripe subscription found its billing group. Ordered strongest first;
 *  `legacy_org_id` is the only one that can name a group this subscription does
 *  not belong to, and is logged so the pre-stamp population is observable. */
export type GroupResolution =
  | "metadata_subscription_id"
  | "stripe_subscription_id"
  | "stripe_customer_id"
  | "legacy_org_id";

/**
 * Which billing GROUP does this Stripe subscription write to?
 *
 * Was `metadata.org_id → that org's subscription`, which was correct only while
 * a subscription belonged to exactly one org. It is now a corruption bug: after
 * a detach, org A still carries the stamp from group 1 while billing through
 * group 2, so an event for group 1 would resolve to — and overwrite — group 2.
 * Silently: wrong plan, wrong status, wrong period end, no exception.
 *
 * The chain, strongest first:
 *   a) `metadata.subscription_id` — stamped at checkout (buildEmbeddedCheckoutParams),
 *      immutable, names the group that actually paid.
 *   b) `subscriptions.stripe_subscription_id = <this sub>` — we already store it.
 *   c) `subscriptions.stripe_customer_id = <event customer>` — the customer is
 *      the group's, not any org's.
 *   d) `metadata.org_id → organizations.subscription_id` — the LEGACY path.
 *
 * (b) and (c) are not belt-and-braces: subscriptions created before the stamp
 * shipped carry no `subscription_id` at all and Stripe metadata cannot be
 * back-filled onto past events, so without them every pre-existing customer
 * would fall to (d) forever.
 *
 * Returns null when nothing resolves — the caller no-ops rather than guesses.
 */
export async function resolveGroupForStripeSub(
  stripeSub: Stripe.Subscription,
): Promise<{ subscriptionId: string; via: GroupResolution } | null> {
  // (a) The durable stamp. Verified against the table rather than trusted:
  // metadata is customer-visible-ish and a deleted group must not be written.
  const stamped = stripeSub.metadata?.subscription_id;
  if (stamped) {
    const [row] = await sql<{ id: string }[]>`
      select id from subscriptions where id = ${stamped}`;
    if (row) return { subscriptionId: row.id, via: "metadata_subscription_id" };
    // Test-mode ids routinely name a row from another environment's throwaway
    // DB (CI's own e2e suite stamps against its ephemeral Postgres, and stg
    // shares the same Stripe test-mode account) — not the corruption this
    // check exists for. Live traffic still errors loudly.
    // Call through the logger object — extracting log.error/log.warn and
    // invoking unbound loses `this`, and pino then throws
    // "Cannot read properties of undefined (reading 'Symbol(pino.msgPrefix)')",
    // which aborted the Stripe webhook with 500 on this path.
    log[stripeSub.livemode ? "error" : "warn"](
      { stripeSubscriptionId: stripeSub.id, stamped },
      "billing: subscription stamped with unknown group",
    );
  }

  // (b) We already store this subscription id — exact, and cannot mismatch.
  const [bySub] = await sql<{ id: string }[]>`
    select id from subscriptions where stripe_subscription_id = ${stripeSub.id}`;
  if (bySub) return { subscriptionId: bySub.id, via: "stripe_subscription_id" };

  // (c) The Stripe customer belongs to the group.
  const customerId =
    typeof stripeSub.customer === "string" ? stripeSub.customer : stripeSub.customer?.id;
  const byCustomer = await groupForCustomer(customerId);
  if (byCustomer) return { subscriptionId: byCustomer, via: "stripe_customer_id" };

  // (d) Legacy. Logged so the un-stamped population can eventually be retired.
  const orgId = stripeSub.metadata?.org_id;
  if (!orgId) return null;
  const legacy = await subscriptionIdForOrg(orgId);
  if (!legacy) return null;
  log.warn(
    { stripeSubscriptionId: stripeSub.id, subscriptionId: legacy, orgId },
    "billing: subscription resolved to group via LEGACY metadata.org_id — no subscription_id stamp, no stored sub id, no customer match",
  );
  return { subscriptionId: legacy, via: "legacy_org_id" };
}

/**
 * Refuse to write when the resolved group is demonstrably not this
 * subscription's. A missed update is recoverable (replay, reconcile-on-return,
 * the stuck-event sweep); overwriting another customer's subscription row is not.
 *
 * A mismatch is only ever LEGITIMATE on the stamped path, where it means a
 * re-buy: the group cancelled sub_old (whose id stays on the row for ever) and
 * bought sub_new, which is stamped with that same group. So a mismatch there is
 * allowed for a still-LIVE subscription and refused for a dead one — a late
 * `updated` for the replaced sub must not drag the group back to its state
 * (the same class of bug as the P1-5 delete guard).
 *
 * On the inferred paths (customer, legacy org_id) a mismatch is never
 * legitimate: the group is already billing a DIFFERENT subscription and this
 * event has no proof it owns that row.
 */
export async function mayWriteGroup(
  resolved: { subscriptionId: string; via: GroupResolution },
  stripeSub: Stripe.Subscription,
): Promise<boolean> {
  const [current] = await sql<{ stripe_subscription_id: string | null }[]>`
    select stripe_subscription_id from subscriptions where id = ${resolved.subscriptionId}`;
  const stored = current?.stripe_subscription_id ?? null;
  if (!stored || stored === stripeSub.id) return true;
  if (resolved.via === "metadata_subscription_id" && isLiveStripeStatus(stripeSub.status)) {
    return true; // re-buy: this subscription replaces the stored one
  }
  log.error(
    {
      subscriptionId: resolved.subscriptionId,
      stored,
      stripeSubscriptionId: stripeSub.id,
      status: stripeSub.status,
      via: resolved.via,
    },
    "billing: REFUSING to write group — wrong-row write averted",
  );
  return false;
}

/** Terminal STRIPE statuses. Everything else still owns the subscription: our
 *  STATUS_MAP collapses unpaid/paused into past_due and keeps incomplete
 *  distinct (#206 — it conveys no plan), and every one of those is in
 *  LIVE_SUBSCRIPTION_STATUSES, so "not terminal" still means "live".
 *
 *  The two-string list moved to lib/subscription-status.ts when
 *  `sweepOrphanGroups` needed the same question (#375). This file cannot be the
 *  home of it: billing-groups.ts would have to import from here, and this module
 *  already imports THAT one. */
export function isLiveStripeStatus(status: Stripe.Subscription.Status): boolean {
  return !isTerminalStripeStatus(status);
}

/** An org to hang a group-level analytics/audit event on: the org named in the
 *  metadata when it is still a member of the group, else the group's primary. */
export async function attributionOrgForGroup(
  subscriptionId: string,
  metadataOrgId: string | null | undefined,
): Promise<string | null> {
  if (metadataOrgId) {
    const [row] = await sql<{ id: string }[]>`
      select id from organizations
      where id = ${metadataOrgId} and subscription_id = ${subscriptionId}`;
    if (row) return row.id;
  }
  return primaryOrgForGroup(subscriptionId);
}
