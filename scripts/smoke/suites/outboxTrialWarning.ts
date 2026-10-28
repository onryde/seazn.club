// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, checkQueuedOutboxRow, postSignedStripeWebhook, smokeDb } from "../harness.ts";

/**
 * Email outbox, phase 3 wave 2 (Task 11): Stripe's three-day trial warning, over the real signed-webhook route.
 *
 * `customer.subscription.trial_will_end` reaches `handleTrialWillEnd`, which queues ONE `trial_ending` row (ref
 * `subscription/<group id>`, no organisation) for the worker to send, once per Stripe EVENT id. A redelivery of that same
 * event — Stripe's retry, the stuck-event sweeper, a staff replay — must queue nothing more.
 *
 * The fixture is a fresh org's own billing group, made a no-card trial on a stored Stripe subscription: the handler
 * resolves the group by `stripe_subscription_id` and reads `has_payment_method` from it. The event id carries the run's
 * `evt_smoke_<tag>_` prefix, so teardown's ledger sweep removes it. The row has no org, so no org teardown reaches it:
 * `finally` deletes it.
 *
 * Needs the server's `STRIPE_WEBHOOK_SECRET` to sign a payload it will accept; skips cleanly without one, as
 * `addonChurnWebhookSuite` does.
 */
export async function outboxTrialWarningSuite(): Promise<void> {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    check(
      "outbox trial warning: skipped (no STRIPE_WEBHOOK_SECRET — cannot sign a webhook this server will accept); the DB-backed vitest suites cover the producer",
      true,
    );
    return;
  }

  const db = smokeDb();
  let groupId: string | undefined;
  try {
    const s = newSession();
    const orgId = (await signIn(s, `delivered+trialwarn_${tag}@resend.dev`)).org_id;
    const stripeSubId = `sub_smoke_trial_${tag}`;
    const [group] = await db<{ id: string }[]>`
      update subscriptions
         set stripe_subscription_id = ${stripeSubId}, status = 'trialing', has_payment_method = false
       where id = (select subscription_id from organizations where id = ${orgId})
      returning id`;
    groupId = group?.id;
    check(
      "outbox trial warning: fixture built — the fresh org's billing group is a no-card trial on a stored Stripe subscription",
      !!groupId,
    );
    if (!groupId) return;

    const eventId = `evt_smoke_${tag}_trial`;
    const subscription = {
      id: stripeSubId,
      object: "subscription",
      status: "trialing",
      trial_end: Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60,
      items: { object: "list", data: [] },
    };
    const first = await postSignedStripeWebhook("customer.subscription.trial_will_end", subscription, eventId);
    check("outbox trial warning: the app accepts the signed trial_will_end webhook (200)", first === 200);
    await checkQueuedOutboxRow("trial_ending", "subscription", groupId);

    const replay = await postSignedStripeWebhook("customer.subscription.trial_will_end", subscription, eventId);
    check("outbox trial warning: the app accepts a redelivery of the SAME event id (200)", replay === 200);
    const [after] = await db<{ n: number }[]>`
      select count(*)::int as n from email_outbox
       where kind = 'trial_ending' and ref_type = 'subscription' and ref_id = ${groupId}`;
    check("outbox trial warning: the redelivery queues no second row (still one)", after?.n === 1);
  } finally {
    if (groupId) await db`delete from email_outbox where kind = 'trial_ending' and ref_id = ${groupId}`;
    await db.end();
  }
}
