// Refund / lost-dispute claw-back of MATCH credits (streaming R1 lane B tail,
// OWNER RULING 2026-09-28 in the programme _STATE.md).
//
// The rule being proven: a FULL refund of a match-credit pack charge revokes
// `min(creditsPurchased, currentBalance)` — never the whole pack
// unconditionally. A spent credit means the stream already broadcast and
// Cloudflare already billed us for those minutes; we cannot un-deliver it, and
// V410's `balance_after >= 0` CHECK would throw on an uncapped revoke rather
// than record anything. A claw-back SHORT of the pack is the refund-abuse
// signature ("bought a pack, streamed, asked for the money back"), so it is
// written AND alerted; the webhook never judges. A PARTIAL refund claws back
// nothing and alerts only. A lost dispute claws back on the same terms through
// the SAME idempotency key, so a dispute after a refund cannot double-claw.
//
// The seam is driven end to end: the purchase is written by the REAL producer
// (`runEvent` → `handleCheckoutCompleted` → `recordPurchase`, the checkout
// webhook's own path), and the claw-back by the REAL consumer
// (`processStripeEvent` on a `charge.refunded` / `charge.dispute.*` event).
// Neither end is a fixture, so a purchase that stopped stamping
// `stripe_payment_intent_id` would red this suite rather than pass it.
//
// The gate is the PAYMENT INTENT, never `charge.metadata`: Stripe does not copy
// `payment_intent_data.metadata` onto the Charge, so these fixtures carry an
// empty `metadata` exactly as a real Checkout-created charge does.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { seedOrg } from "./_rig";
import { processStripeEvent, runEvent } from "../billing-events";
import { creditBalance } from "../stream-credits";
import { sendStaffDisputeAlertEmail, sendStreamCreditClawbackAlertEmail } from "@/lib/email";

// Both alerts are mocked at the function rather than at the transport, so the
// assertions are on the call the branch makes and not on whether an SMTP env
// happens to be configured in this process. Their COPY is proven separately
// (lib/__tests__/stream-credit-clawback-alert-email.test.ts).
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendStreamCreditClawbackAlertEmail: vi.fn(async () => true),
  sendStaffDisputeAlertEmail: vi.fn(async () => true),
}));
const clawbackAlert = vi.mocked(sendStreamCreditClawbackAlertEmail);
const disputeAlert = vi.mocked(sendStaffDisputeAlertEmail);

// The guarded PaymentIntent retrieve the `matched === false` branch uses to tell
// a paid-but-ungranted match-credit pack from a genuine non-stream charge. Only
// that branch calls it; every matched path answers off the ledger row.
const stripeMock = vi.hoisted(() => ({
  retrieveIntent: vi.fn(),
  retrieveCharge: vi.fn(async () => ({ customer: null })),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    paymentIntents: { retrieve: stripeMock.retrieveIntent },
    charges: { retrieve: stripeMock.retrieveCharge },
  }),
}));

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = (): string => randomUUID().slice(0, 8);

/** A `checkout.session.completed` for a match-credit pack — the shape
 *  `lib/relay-checkout.ts` creates. `payment_intent` is what the refund and the
 *  dispute both key on, so it is the value the whole suite threads. */
function completed(orgId: string, sessionId: string, credits: string): Stripe.Event {
  return {
    id: `evt_${sessionId}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        payment_status: "paid",
        currency: "gbp",
        amount_total: 2500,
        customer: null,
        payment_intent: `pi_${sessionId}`,
        metadata: { kind: "stream_credits", org_id: orgId, fixture_id: "00000000-0000-4000-8000-000000000000", pack: "5", credits },
      },
    },
  } as unknown as Stripe.Event;
}

/** A `charge.refunded`. `refunded: true` is Stripe's FULL-refund flag;
 *  `refunded: false` with `amount_refunded > 0` is a partial. Carries NO
 *  `metadata.kind` on purpose — a real Checkout charge's metadata is `{}`. */
function refundEvent(over: {
  paymentIntent: string;
  chargeId?: string;
  refunded?: boolean;
  amountRefunded?: number;
}): Stripe.Event {
  return {
    id: `evt_${uniq()}`,
    type: "charge.refunded",
    data: {
      object: {
        id: over.chargeId ?? `ch_${uniq()}`,
        refunded: over.refunded ?? true,
        amount_refunded: over.amountRefunded ?? 2500,
        payment_intent: over.paymentIntent,
        metadata: {},
      },
    },
  } as unknown as Stripe.Event;
}

/** A `charge.dispute.*`. `charge` stays an opaque id string, as a real webhook
 *  sends it; the match is by payment intent. */
function disputeEvent(over: {
  paymentIntent: string;
  phase: "created" | "closed";
  status?: string;
  disputeId?: string;
}): Stripe.Event {
  return {
    id: `evt_${uniq()}`,
    type: over.phase === "created" ? "charge.dispute.created" : "charge.dispute.closed",
    data: {
      object: {
        id: over.disputeId ?? `dp_${uniq()}`,
        status: over.status ?? "needs_response",
        amount: 2500,
        currency: "gbp",
        payment_intent: over.paymentIntent,
        charge: `ch_${uniq()}`,
      },
    },
  } as unknown as Stripe.Event;
}

/** Buy a pack through the REAL checkout webhook path. Returns the payment
 *  intent the claw-back will have to match on. */
async function buyPack(orgId: string, credits: number): Promise<{ intent: string; sessionId: string }> {
  const sessionId = `cs_test_claw_${uniq()}`;
  expect(await runEvent(completed(orgId, sessionId, String(credits)))).toBe(true);
  return { intent: `pi_${sessionId}`, sessionId };
}

/** Spend `n` credits. A raw `consume` row per credit: this is the PRECONDITION,
 *  not a seam under test — `consumeForSession` needs a real
 *  `fixture_stream_sessions` row for its `session_id` FK and nothing here
 *  depends on HOW a credit was spent, only that it is gone. */
async function spend(orgId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const bal = await creditBalance(sql, orgId);
    await sql`
      insert into org_stream_credits (org_id, delta, reason, balance_after)
      values (${orgId}, -1, 'consume', ${bal - 1})`;
  }
}

interface LedgerRow {
  delta: number;
  reason: string;
  balance_after: number;
  idempotency_key: string | null;
  note: string | null;
  stripe_payment_intent_id: string | null;
}

async function revokeRows(orgId: string): Promise<LedgerRow[]> {
  return sql<LedgerRow[]>`
    select delta, reason, balance_after, idempotency_key, note, stripe_payment_intent_id
      from org_stream_credits where org_id = ${orgId} and reason = 'revoke'
     order by created_at`;
}

describe.skipIf(!HAS_DB)("charge.refunded → match-credit claw-back", () => {
  beforeEach(() => {
    clawbackAlert.mockClear();
    disputeAlert.mockClear();
    stripeMock.retrieveIntent.mockReset();
    // A real retrieve always answers with a PaymentIntent object; the AI pack
    // handler runs FIRST on every charge.refunded and reads `pi.metadata`, so a
    // bare reset (returning undefined) would crash the donor, not this arm.
    stripeMock.retrieveIntent.mockResolvedValue({ metadata: {} });
    vi.stubEnv("STAFF_ALERT_EMAIL", "billing-ops@example.test");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("an UNSPENT pack: a full refund revokes the whole pack in ONE row, keyed on the intent, and alerts nobody", async () => {
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);
    expect(await creditBalance(sql, auth.orgId)).toBe(5);

    const chargeId = `ch_${uniq()}`;
    await processStripeEvent(refundEvent({ paymentIntent: intent, chargeId }));

    expect(await creditBalance(sql, auth.orgId)).toBe(0);
    const rows = await revokeRows(auth.orgId);
    expect(rows).toHaveLength(1);
    // `revoke`, never `refund`: in org_stream_credits `refund` ADDS credits back
    // (the staff remedy for a stream that failed). A card claw-back moves the
    // other way and V410's reason CHECK offers exactly one value for it.
    expect(rows[0]!.reason).toBe("revoke");
    expect(rows[0]!.delta).toBe(-5);
    expect(rows[0]!.balance_after).toBe(0);
    // The key the dispute path shares — asserted by VALUE, because sharing it is
    // the only thing that stops a dispute-after-refund double-claw.
    expect(rows[0]!.idempotency_key).toBe(`stream_pack_refund:${intent}`);
    // The note names the charge (owner ruling), so a ledger row can be walked
    // back to the Stripe object that caused it.
    expect(rows[0]!.note).toContain(chargeId);
    expect(rows[0]!.stripe_payment_intent_id).toBe(intent);
    // Nothing was spent, so this is a clean reversal: no human is owed a look.
    expect(clawbackAlert).not.toHaveBeenCalled();
  });

  it("a PARTIALLY spent pack: the claw-back is capped at the balance, and staff are alerted", async () => {
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);
    await spend(auth.orgId, 3);
    expect(await creditBalance(sql, auth.orgId)).toBe(2);

    await processStripeEvent(refundEvent({ paymentIntent: intent }));

    // 2 revoked, not 5. An uncapped revoke would write balance_after -3 and
    // V410's CHECK would throw inside the webhook.
    expect(await creditBalance(sql, auth.orgId)).toBe(0);
    const rows = await revokeRows(auth.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delta).toBe(-2);
    expect(rows[0]!.balance_after).toBe(0);
    // Bought → streamed → refunded is the abuse signature. Recorded AND alerted;
    // a human decides whether to chase.
    expect(clawbackAlert).toHaveBeenCalledTimes(1);
    const arg = clawbackAlert.mock.calls[0]![0];
    expect(arg.orgId).toBe(auth.orgId);
    expect(arg.purchased).toBe(5);
    expect(arg.clawedBack).toBe(2);
  });

  it("a FULLY spent pack: nothing is left to revoke, so NO row is written and staff are alerted", async () => {
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);
    await spend(auth.orgId, 5);
    expect(await creditBalance(sql, auth.orgId)).toBe(0);

    await processStripeEvent(refundEvent({ paymentIntent: intent }));

    expect(await creditBalance(sql, auth.orgId)).toBe(0);
    // V410 constrains `delta <> 0`, so a zero claw-back has no row to write —
    // the absence is the schema's answer, not a silent skip.
    expect(await revokeRows(auth.orgId)).toHaveLength(0);
    expect(clawbackAlert).toHaveBeenCalledTimes(1);
    expect(clawbackAlert.mock.calls[0]![0].clawedBack).toBe(0);
    expect(clawbackAlert.mock.calls[0]![0].purchased).toBe(5);
  });

  it("a refund of a DIFFERENT charge leaves another org's pack alone, and no PaymentIntent metadata makes it ours", async () => {
    const { auth } = await seedOrg();
    await buyPack(auth.orgId, 5);
    expect(await creditBalance(sql, auth.orgId)).toBe(5);

    // A genuine non-stream charge: the retrieve answers with another product's
    // metadata, so the ungranted-pack alert must NOT fire either.
    stripeMock.retrieveIntent.mockResolvedValue({ metadata: { kind: "credit_pack" } });
    await processStripeEvent(refundEvent({ paymentIntent: `pi_unrelated_${uniq()}` }));

    // The gate is `stripe_payment_intent_id = <this intent>`. Widened to "any
    // purchase row", this refund would claw back a stranger's pack.
    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    expect(await revokeRows(auth.orgId)).toHaveLength(0);
    expect(clawbackAlert).not.toHaveBeenCalled();
  });

  it("a refunded match-credit charge with NO purchase row alerts a human and writes nothing", async () => {
    const orgId = randomUUID();
    const intent = `pi_ungranted_${uniq()}`;
    stripeMock.retrieveIntent.mockResolvedValue({
      metadata: { kind: "stream_credits", org_id: orgId, pack: "5" },
    });

    await processStripeEvent(refundEvent({ paymentIntent: intent }));

    expect(stripeMock.retrieveIntent).toHaveBeenCalledWith(intent);
    expect(clawbackAlert).toHaveBeenCalledTimes(1);
    expect(clawbackAlert.mock.calls[0]![0].orgId).toBe(orgId);
    // Nothing to claw back and nothing invented.
    expect(clawbackAlert.mock.calls[0]![0].clawedBack).toBeUndefined();
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from org_stream_credits where stripe_payment_intent_id = ${intent}`;
    expect(n).toBe("0");
  });

  it("a PARTIAL refund claws back NOTHING and alerts only", async () => {
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);

    // Stripe's full-refund flag stays false while money HAS moved back.
    await processStripeEvent(
      refundEvent({ paymentIntent: intent, refunded: false, amountRefunded: 500 }),
    );

    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    expect(await revokeRows(auth.orgId)).toHaveLength(0);
    expect(clawbackAlert).toHaveBeenCalledTimes(1);
    expect(clawbackAlert.mock.calls[0]![0].reason).toMatch(/partial/i);
    // The PaymentIntent is never consulted on the partial path — it matched off
    // the ledger row, so a Stripe round trip would be a cost with no answer.
    expect(stripeMock.retrieveIntent).not.toHaveBeenCalled();
  });

  it("an UNREFUNDED charge (both flags clear) is a silent no-op even for a pack we sold", async () => {
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);

    await processStripeEvent(
      refundEvent({ paymentIntent: intent, refunded: false, amountRefunded: 0 }),
    );

    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    expect(await revokeRows(auth.orgId)).toHaveLength(0);
    expect(clawbackAlert).not.toHaveBeenCalled();
  });

  it("a REDELIVERED refund writes no second revoke row", async () => {
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);
    const chargeId = `ch_${uniq()}`;

    // processStripeEvent, not runEvent: the billing_events claim would refuse a
    // true redelivery before the handler is reached, so driving it there would
    // prove the OUTER floor twice and this one never.
    await processStripeEvent(refundEvent({ paymentIntent: intent, chargeId }));
    await processStripeEvent(refundEvent({ paymentIntent: intent, chargeId }));

    expect(await revokeRows(auth.orgId)).toHaveLength(1);
    expect(await creditBalance(sql, auth.orgId)).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("charge.dispute.* → match-credit claw-back", () => {
  beforeEach(() => {
    clawbackAlert.mockClear();
    disputeAlert.mockClear();
    stripeMock.retrieveIntent.mockReset();
    // A real retrieve always answers with a PaymentIntent object; the AI pack
    // handler runs FIRST on every charge.refunded and reads `pi.metadata`, so a
    // bare reset (returning undefined) would crash the donor, not this arm.
    stripeMock.retrieveIntent.mockResolvedValue({ metadata: {} });
    vi.stubEnv("STAFF_ALERT_EMAIL", "billing-ops@example.test");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a LOST closed dispute claws back on the refund's terms and notifies staff as a match-credit dispute", async () => {
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);
    await spend(auth.orgId, 1);

    await processStripeEvent(disputeEvent({ paymentIntent: intent, phase: "closed", status: "lost" }));

    expect(await creditBalance(sql, auth.orgId)).toBe(0);
    const rows = await revokeRows(auth.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delta).toBe(-4); // capped at the balance, exactly as a refund is
    expect(rows[0]!.idempotency_key).toBe(`stream_pack_refund:${intent}`);
    expect(disputeAlert).toHaveBeenCalledTimes(1);
    expect(disputeAlert.mock.calls[0]![0].kind).toBe("stream_credits");
  });

  it("a CREATED dispute on a pack charge is MATCHED — no throw — and claws back nothing yet", async () => {
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);

    // An unmatched `created` dispute THROWS (the sweeper retries it), so
    // completing without one is the proof that the branch returned true.
    await processStripeEvent(disputeEvent({ paymentIntent: intent, phase: "created" }));

    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    expect(await revokeRows(auth.orgId)).toHaveLength(0);
    expect(disputeAlert).toHaveBeenCalledTimes(1);
    expect(disputeAlert.mock.calls[0]![0].phase).toBe("created");
    expect(disputeAlert.mock.calls[0]![0].kind).toBe("stream_credits");
  });

  it("a WON closed dispute claws back nothing and still notifies", async () => {
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);

    await processStripeEvent(disputeEvent({ paymentIntent: intent, phase: "closed", status: "won" }));

    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    expect(await revokeRows(auth.orgId)).toHaveLength(0);
    expect(disputeAlert).toHaveBeenCalledTimes(1);
  });

  it("a lost dispute AFTER a refund of the same charge writes no second row — even once the org has bought a NEW pack", async () => {
    const { auth } = await seedOrg();
    const { intent: first } = await buyPack(auth.orgId, 5);
    await processStripeEvent(refundEvent({ paymentIntent: first }));
    expect(await creditBalance(sql, auth.orgId)).toBe(0);
    expect(await revokeRows(auth.orgId)).toHaveLength(1);

    // The org buys again. Without the shared idempotency key the dispute below
    // would recompute min(5, 5) and revoke the NEW pack's credits — the balance
    // cap alone cannot refuse it, because the balance is no longer zero.
    await buyPack(auth.orgId, 5);
    expect(await creditBalance(sql, auth.orgId)).toBe(5);

    await processStripeEvent(disputeEvent({ paymentIntent: first, phase: "closed", status: "lost" }));

    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    expect(await revokeRows(auth.orgId)).toHaveLength(1);
    // The dispute is still reported: nothing was clawed, but a human is told.
    expect(disputeAlert).toHaveBeenCalledTimes(1);
  });

  it("a dispute on a charge that is not a match-credit pack does not claim the event", async () => {
    const { auth } = await seedOrg();
    await buyPack(auth.orgId, 5);

    // `created` + unmatched is the one shape that must FAIL the event so the
    // stuck-event sweeper retries it. If the stream branch claimed every
    // dispute, this would resolve instead of throwing.
    await expect(
      processStripeEvent(disputeEvent({ paymentIntent: `pi_unrelated_${uniq()}`, phase: "created" })),
    ).rejects.toThrow(/matched no registration\/sponsor\/platform charge/);
    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    expect(await revokeRows(auth.orgId)).toHaveLength(0);
  });
});
