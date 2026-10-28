// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, postSignedStripeWebhook, smokeDb, setPlan } from "../harness.ts";

/**
 * v17 gap W10 — purchased add-on capacity dies with the money that rented it.
 *
 * Two ways a group stops paying, both driven through the app's REAL webhook
 * route rather than by calling the handler: a `customer.subscription.deleted`
 * (#330) and a lost dispute (#331). Before this wave the plan collapsed to
 * community on both and the recurring add-on rows stayed `active`, so a
 * churned group kept `community base + N` organisations and seats for ever,
 * unpaid — and nothing else swept them, because the reconciling sweep only
 * runs on `customer.subscription.updated`, which neither path emits.
 *
 * Every leg asserts THREE rows, not one: the extra-org rider and the seat
 * rider must both freeze, and an ADMIN-granted comp (`stripe_item_id` null)
 * must survive untouched. The grant is the half that makes this a scoped
 * cancel rather than a truncate — a fix that cancelled everything on the
 * wallet would pass a one-row assertion.
 *
 * Needs the server's `STRIPE_WEBHOOK_SECRET` to sign a payload it will accept;
 * skips cleanly without one, the same convention `paymentMethodSuite` uses.
 * No Stripe key and no network call: the dispute legs carry an EXPANDED charge
 * object, which `disputeCustomerId` reads inline instead of retrieving.
 */
export async function addonChurnWebhookSuite(): Promise<void> {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    check(
      "addon churn: skipped (no STRIPE_WEBHOOK_SECRET — cannot sign a webhook this server will accept); the DB-backed vitest suites cover both paths",
      true,
    );
    return;
  }

  const db = smokeDb();
  try {
    /** A fresh paid group carrying all three add-on rows, with Stripe ids the
     *  handlers can match on. Returns the wallet (= subscription) id. */
    const seedGroup = async (label: string, plan: string) => {
      const s = newSession();
      const email = `delivered+addonchurn_${label}_${tag}@resend.dev`;
      const orgId = (await signIn(s, email)).org_id;
      await setPlan(orgId, plan, s);
      const [row] = await db<{ wallet_id: string }[]>`
        select coalesce(subscription_id::text, id::text) as wallet_id
          from organizations where id = ${orgId}`;
      const walletId = row.wallet_id;
      await db`
        update subscriptions
           set stripe_subscription_id = ${`sub_smoke_${label}_${tag}`},
               stripe_customer_id = ${`cus_smoke_${label}_${tag}`}
         where id = ${walletId}`;
      await db`
        insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty,
                                stripe_item_id, status)
        values (${walletId}, null, 'orgs.max_owned', 1, 1,
                ${`si_smoke_${label}_rider_${tag}`}, 'active'),
               (${walletId}, null, 'members.max', 1, 3,
                ${`si_smoke_${label}_seat_${tag}`}, 'active'),
               (${walletId}, null, 'members.max', 1, 1, null, 'granted')`;
      return { orgId, walletId };
    };

    /** The three rows' statuses, keyed so a check reads as a sentence. */
    const statuses = async (walletId: string) => {
      const rows = await db<{ feature_key: string; stripe_item_id: string | null; status: string }[]>`
        select feature_key, stripe_item_id, status from org_addons
         where wallet_id = ${walletId} order by stripe_item_id nulls last`;
      return {
        rider: rows.find((r) => r.feature_key === "orgs.max_owned")?.status,
        seat: rows.find((r) => r.feature_key === "members.max" && r.stripe_item_id)?.status,
        granted: rows.find((r) => !r.stripe_item_id)?.status,
      };
    };

    // === #330 — churn. The subscription is gone; so is the capacity it billed.
    // `pro`, not the deleted `pro_plus` (V393, entitlements v18). The plan key
    // is incidental here — what is under test is a webhook cancelling the
    // add-on rows on a PAID group — and Pro is the only self-serve paid tier
    // left that a Stripe subscription would legitimately sit on.
    const churn = await seedGroup("churn", "pro");
    const before = await statuses(churn.walletId);
    check(
      "addon churn: fixture built — a paid group carrying a purchased rider, a purchased seat block and an admin comp, all live",
      before.rider === "active" && before.seat === "active" && before.granted === "granted",
    );
    const churnStatus = await postSignedStripeWebhook("customer.subscription.deleted", {
      id: `sub_smoke_churn_${tag}`,
      object: "subscription",
      customer: `cus_smoke_churn_${tag}`,
      status: "canceled",
      items: { object: "list", data: [] },
    });
    check("addon churn: the app accepts the signed deletion webhook (200)", churnStatus === 200);
    const afterChurn = await statuses(churn.walletId);
    check(
      "addon churn: a deleted subscription cancels BOTH Stripe-billed families — the extra-org rider and the seat block (#330)",
      afterChurn.rider === "canceled" && afterChurn.seat === "canceled",
    );
    check(
      "addon churn: ...and leaves the ADMIN-granted comp alone — a grant is capacity the group was given, never something Stripe was billing",
      afterChurn.granted === "granted",
    );

    // === #331 — a lost dispute. Same outcome by a different route, and the
    // `created` event first because the loss is guarded on the dispute_id it
    // stamps: a loss that matches no stored dispute must strip nothing.
    const disputed = await seedGroup("disp", "pro");
    const disputeId = `dp_smoke_${tag}`;
    const charge = { id: `ch_smoke_${tag}`, object: "charge", customer: `cus_smoke_disp_${tag}` };
    const createdStatus = await postSignedStripeWebhook("charge.dispute.created", {
      id: disputeId,
      object: "dispute",
      charge,
      status: "warning_needs_response",
      payment_intent: null,
    });
    check("addon churn/dispute: the app accepts the signed dispute-opened webhook (200)", createdStatus === 200);

    // A loss under a DIFFERENT dispute id — the stale-loss case. It must move
    // nothing, which is the only thing that makes the guard on the real loss
    // below meaningful rather than decorative.
    await postSignedStripeWebhook("charge.dispute.closed", {
      id: `${disputeId}_other`,
      object: "dispute",
      charge,
      status: "lost",
      payment_intent: null,
    });
    const afterStale = await statuses(disputed.walletId);
    check(
      "addon churn/dispute: a loss whose dispute id matches nothing strips no capacity (#331 guard)",
      afterStale.rider === "active" && afterStale.seat === "active",
    );

    const lostStatus = await postSignedStripeWebhook("charge.dispute.closed", {
      id: disputeId,
      object: "dispute",
      charge,
      status: "lost",
      payment_intent: null,
    });
    check("addon churn/dispute: the app accepts the signed dispute-lost webhook (200)", lostStatus === 200);
    const afterLost = await statuses(disputed.walletId);
    check(
      "addon churn/dispute: losing a dispute cancels the purchased rider and seat block, not just the plan (#331)",
      afterLost.rider === "canceled" && afterLost.seat === "canceled",
    );
    check(
      "addon churn/dispute: ...and the admin comp survives here too",
      afterLost.granted === "granted",
    );
    const [plan] = await db<{ plan_key: string; status: string }[]>`
      select plan_key, status from subscriptions where id = ${disputed.walletId}`;
    check(
      "addon churn/dispute: the plan itself still drops to community/canceled — the add-on cancel is in ADDITION to it, not instead of it",
      plan?.plan_key === "community" && plan?.status === "canceled",
    );
  } finally {
    await db.end();
  }
}
