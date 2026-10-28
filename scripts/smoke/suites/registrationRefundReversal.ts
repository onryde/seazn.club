// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  CONNECT_TEST_ACCOUNT, check, postPaidRegistrationWebhook, smokeStripe, payRealDestinationCharge,
  releaseConnectAccount, seedRealRegistrationCart, smokeDb, v1,
} from "../harness.ts";

/**
 * RS006 money-hardening leg 2/2: `stripeRefund` passes `reverse_transfer:
 * true, refund_application_fee: true` (registrations.ts) — refunding a paid
 * registration must pull the money back off the CONNECTED account (reverse
 * the transfer) and hand back the PLATFORM's own cut (refund the
 * application fee), not just refund the card. A stub can return any canned
 * refund object it likes; it can never prove Stripe actually paired those
 * two real side-effects together. This asserts against the real Transfer
 * and ApplicationFee objects, before and after, that both flipped — plus
 * the real Refund object's own `transfer_reversal` field, a third,
 * independent angle on the same pairing.
 *
 * Own fresh Pro org (seedRealRegistrationCart); claims/restores
 * CONNECT_TEST_ACCOUNT exactly like registrationPaidLoopSuite. Keyless-safe:
 * skips (never fails) without STRIPE_SECRET_KEY or
 * STRIPE_CONNECT_TEST_ACCOUNT, and refuses outright (smokeStripe) against a
 * non-test-mode key.
 */
export async function registrationRefundReversalSuite(): Promise<void> {
  if (!process.env.STRIPE_SECRET_KEY) {
    check("reg refund: skipped (no STRIPE_SECRET_KEY — cannot mint a real session)", true);
    return;
  }
  if (!CONNECT_TEST_ACCOUNT) {
    check(
      "reg refund: skipped (no STRIPE_CONNECT_TEST_ACCOUNT — destination charge needs a real connected account)",
      true,
    );
    return;
  }

  const stripe = await smokeStripe();
  const feeCents = 2000;
  const seeded = await seedRealRegistrationCart("regrefund", "Reg Refund Cup", feeCents);
  const openSessions: string[] = [seeded.sessionId];
  try {
    // Pays through an independent real PaymentIntent — see
    // payRealDestinationCharge's own doc comment for why the real Checkout
    // session minted above is never completed directly.
    const { paymentIntentId, transferId, applicationFeeId } = await payRealDestinationCharge(
      stripe,
      feeCents,
      seeded.currency,
    );

    const webhookStatus = await postPaidRegistrationWebhook({
      groupId: seeded.groupId,
      registrationIds: [seeded.regId],
      orgId: seeded.orgId,
      currency: seeded.currency,
      feePercent: seeded.feePercent,
      paymentIntent: paymentIntentId,
    });
    check("reg refund: the real payment's webhook confirms the entry (200)", webhookStatus === 200);

    const feeBefore = await stripe.applicationFees.retrieve(applicationFeeId);
    const transferBefore = await stripe.transfers.retrieve(transferId);
    check(
      "reg refund: before refunding, the real destination charge carries an unreversed transfer and an unrefunded application fee",
      transferBefore.reversed === false && feeBefore.refunded === false,
    );

    const refundRes = await v1(seeded.owner, `/api/v1/registrations/${seeded.regId}/refund`, "POST", {});
    check("reg refund: the organiser refund route accepts the paid entry (200)", refundRes.status === 200);

    const eventsDb = smokeDb();
    let stripeRefundId: string | undefined;
    try {
      const [event] = await eventsDb<{ payload: Record<string, unknown> }[]>`
        select payload from competition_events
        where payload ->> 'registration_id' = ${seeded.regId} and type = 'registration.refunded'
        order by created_at desc limit 1`;
      stripeRefundId = event?.payload.stripe_refund_id as string | undefined;
    } finally {
      await eventsDb.end();
    }
    if (!stripeRefundId) throw new Error("reg refund: no registration.refunded audit row was written");
    const refund = await stripe.refunds.retrieve(stripeRefundId);
    check(
      "reg refund: the real Refund object reverse_transfer'd — it carries a transfer_reversal",
      refund.status === "succeeded" && !!refund.transfer_reversal && refund.amount === feeCents,
    );

    const feeAfter = await stripe.applicationFees.retrieve(applicationFeeId);
    const transferAfter = await stripe.transfers.retrieve(transferId);
    check(
      "reg refund: Stripe actually reversed the FULL transfer off the connected account",
      transferAfter.reversed === true && transferAfter.amount_reversed === transferBefore.amount,
    );
    check(
      "reg refund: Stripe actually returned the platform's FULL application fee",
      feeAfter.refunded === true && feeAfter.amount_refunded === feeBefore.amount,
    );
  } finally {
    for (const id of openSessions) {
      await stripe.checkout.sessions.expire(id).catch(() => undefined);
    }
    await releaseConnectAccount(seeded.orgId, seeded.previousHolderId);
  }
}
