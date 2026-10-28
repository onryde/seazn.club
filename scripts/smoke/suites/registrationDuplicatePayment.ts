// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  CONNECT_TEST_ACCOUNT, newSession, check, postPaidRegistrationWebhook, smokeStripe, payRealDestinationCharge,
  releaseConnectAccount, seedRealRegistrationCart, smokeDb, v1, v1data,
} from "../harness.ts";

/**
 * RS006 money-hardening leg 1/2: `confirmPaidRegistration`'s duplicate-
 * payment branch (registrations.ts — the `reg.status === "confirmed" ||
 * reg.status === "paid"` check, just above its own "two open checkout tabs"
 * comment) — the registrant-reopened-the-pay-link scenario that comment
 * names, where two distinct real payments land for the same still-pending
 * cart. The entry must confirm off the FIRST payment only; the second,
 * different payment_intent must be auto-refunded (its own amount_cents,
 * never a sibling's or the cart's total) with an audit row carrying
 * mode:"duplicate" — the exact real-refund-object pairing a stubbed Stripe
 * can never produce to assert against.
 *
 * This does NOT keep two Checkout Sessions open at once, and neither
 * session is ever completed — see the inline comment on the resume-mint
 * below for why (this same branch added expireSupersededCheckoutSession),
 * and payRealDestinationCharge's own doc comment for why a session can't be
 * paid headlessly at all. The duplicate PAYMENT this leg proves is
 * synthesized independently: two distinct real PaymentIntents against the
 * fixture Connect account, each fed through its own
 * synthetic-but-correctly-signed webhook.
 *
 * Own fresh Pro org (seedRealRegistrationCart); claims/restores
 * CONNECT_TEST_ACCOUNT exactly like registrationPaidLoopSuite. Keyless-safe:
 * skips (never fails) without STRIPE_SECRET_KEY or
 * STRIPE_CONNECT_TEST_ACCOUNT, the same convention as every other Connect
 * check in this file, and refuses outright (smokeStripe) against a
 * non-test-mode key.
 */
export async function registrationDuplicatePaymentSuite(): Promise<void> {
  if (!process.env.STRIPE_SECRET_KEY) {
    check("reg duplicate: skipped (no STRIPE_SECRET_KEY — cannot mint a real session)", true);
    return;
  }
  if (!CONNECT_TEST_ACCOUNT) {
    check(
      "reg duplicate: skipped (no STRIPE_CONNECT_TEST_ACCOUNT — destination charge needs a real connected account)",
      true,
    );
    return;
  }

  const stripe = await smokeStripe();
  const feeCents = 1500;
  const seeded = await seedRealRegistrationCart("regdup", "Reg Dup Cup", feeCents);
  const openSessions: string[] = [seeded.sessionId];
  try {
    // Resume-mints a second real session for the same still-pending cart.
    // createRegistrationCheckout mints this new session FIRST, then calls
    // expireSupersededCheckoutSession(seeded.sessionId, registrationIds) —
    // added this same branch — which finds seeded.sessionId still `open`
    // with intersecting registration_ids and expires it. So this does NOT
    // leave two open sessions behind (see this function's own doc comment);
    // what it proves is that the resume path mints a genuinely distinct
    // session (asserted via sessionIdB below) rather than replaying the
    // stale one. Neither session is ever paid through directly either way —
    // a Checkout Session's own `payment_intent` stays null until a real
    // browser visits its hosted page, so nothing headless can complete one
    // (payRealDestinationCharge's doc comment). The duplicate PAYMENT below
    // is synthesized independently, through two distinct real PaymentIntents.
    const resumed = await v1(
      newSession(),
      `/api/v1/public/registrations/${seeded.regId}/checkout`,
      "POST",
      { token: seeded.accessToken },
    );
    const resumedOut = v1data<{ checkout_url: string }>(resumed);
    check(
      "reg duplicate: a second real session mints for the same still-pending cart",
      resumed.status === 200 && !!resumedOut?.checkout_url?.startsWith("https://checkout.stripe.com/"),
    );

    const sessionDb = smokeDb();
    let sessionIdB: string;
    try {
      const [group] = await sessionDb<{ checkout_session_id: string | null }[]>`
        select checkout_session_id from registration_groups where id = ${seeded.groupId}`;
      sessionIdB = group?.checkout_session_id ?? "";
    } finally {
      await sessionDb.end();
    }
    check(
      "reg duplicate: the second session is a distinct Stripe object from the first",
      !!sessionIdB && sessionIdB !== seeded.sessionId,
    );
    if (sessionIdB) openSessions.push(sessionIdB);

    // Pay BOTH for real against the fixture Connect account — two genuine,
    // succeeded destination-charge PaymentIntents, in either order. See
    // payRealDestinationCharge's own doc comment for why this pays through
    // an independent PaymentIntent rather than either Checkout session
    // above. Each is fulfilled the same way registrationPaidLoopSuite's own
    // single session is: a synthetic, correctly-signed
    // checkout.session.completed, just carrying a REAL payment_intent id
    // instead of a fake string.
    const { paymentIntentId: paymentIntentA } = await payRealDestinationCharge(
      stripe,
      feeCents,
      seeded.currency,
    );
    const { paymentIntentId: paymentIntentB } = await payRealDestinationCharge(
      stripe,
      feeCents,
      seeded.currency,
    );

    const webhookA = await postPaidRegistrationWebhook({
      groupId: seeded.groupId,
      registrationIds: [seeded.regId],
      orgId: seeded.orgId,
      currency: seeded.currency,
      feePercent: seeded.feePercent,
      paymentIntent: paymentIntentA,
    });
    check("reg duplicate: the FIRST real payment's webhook is accepted (200)", webhookA === 200);

    const readAfter = async () => {
      const d = smokeDb();
      try {
        const [reg] = await d<{ status: string; entrant_id: string | null }[]>`
          select status, entrant_id from registrations where id = ${seeded.regId}`;
        const [group] = await d<{ payment_intent_id: string | null }[]>`
          select payment_intent_id from registration_groups where id = ${seeded.groupId}`;
        return {
          status: reg?.status ?? "",
          entrantId: reg?.entrant_id ?? null,
          paymentIntentId: group?.payment_intent_id ?? null,
        };
      } finally {
        await d.end();
      }
    };
    const afterA = await readAfter();
    check(
      "reg duplicate: the entry confirms off the FIRST payment (paid/confirmed, entrant materialised, cart pinned to intent A)",
      (afterA.status === "paid" || afterA.status === "confirmed") &&
        !!afterA.entrantId &&
        afterA.paymentIntentId === paymentIntentA,
    );

    const webhookB = await postPaidRegistrationWebhook({
      groupId: seeded.groupId,
      registrationIds: [seeded.regId],
      orgId: seeded.orgId,
      currency: seeded.currency,
      feePercent: seeded.feePercent,
      paymentIntent: paymentIntentB,
    });
    check(
      "reg duplicate: the SECOND real payment's webhook (a different intent) is accepted, not rejected (200)",
      webhookB === 200,
    );

    const afterB = await readAfter();
    check(
      "reg duplicate: the entry confirms EXACTLY ONCE — status/entrant/pinned intent unchanged by the duplicate payment",
      afterB.status === afterA.status &&
        afterB.entrantId === afterA.entrantId &&
        afterB.paymentIntentId === paymentIntentA,
    );

    const eventsDb = smokeDb();
    let events: { type: string; payload: Record<string, unknown> }[];
    try {
      events = await eventsDb<{ type: string; payload: Record<string, unknown> }[]>`
        select type, payload from competition_events
        where payload ->> 'registration_id' = ${seeded.regId}
        order by created_at`;
    } finally {
      await eventsDb.end();
    }
    const confirmedCount = events.filter((e) => e.type === "registration.confirmed").length;
    const refundEvent = events.find((e) => e.type === "registration.refunded");
    check(
      'reg duplicate: exactly one confirmation audit row, and one refund audit row carrying mode:"duplicate"',
      confirmedCount === 1 && refundEvent?.payload.mode === "duplicate",
    );

    const stripeRefundId = refundEvent?.payload.stripe_refund_id as string | undefined;
    const dupRefunds = await stripe.refunds.list({ payment_intent: paymentIntentB, limit: 5 });
    check(
      "reg duplicate: a REAL Stripe refund exists for the duplicate (second) intent, for the entry's own amount",
      dupRefunds.data.length === 1 &&
        dupRefunds.data[0]?.status === "succeeded" &&
        dupRefunds.data[0]?.amount === feeCents &&
        dupRefunds.data[0]?.id === stripeRefundId,
    );

    const keptRefunds = await stripe.refunds.list({ payment_intent: paymentIntentA, limit: 5 });
    check(
      "reg duplicate: the ORIGINAL (kept) payment is untouched — no refund exists for intent A",
      keptRefunds.data.length === 0,
    );
  } finally {
    for (const id of openSessions) {
      // Best-effort: an already-completed/expired session is not a failure —
      // matches registration-currency.live.test.ts's own cleanup.
      await stripe.checkout.sessions.expire(id).catch(() => undefined);
    }
    await releaseConnectAccount(seeded.orgId, seeded.previousHolderId);
  }
}
