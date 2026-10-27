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
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { seedOrg } from "./_rig";
import { processStripeEvent, runEvent } from "../billing-events";
import { creditBalance } from "../stream-credits";
import { staffDisputeAlertEmail, streamCreditClawbackAlertEmail } from "@/lib/email";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import { staffAlertDrops, staffRows } from "./_money-fixtures";

// The claw-back alert is queued on the email outbox (phase 3 wave 5, kind
// `staff_stream_credit_clawback`, once per incident: `<charge>:partial:<amount
// refunded>`, `<charge>:short`, `<charge>:ungranted`, `<dispute>:lost`) to this
// suite's own STAFF_ALERT_EMAIL, so the tests read its rows (`staffRows`). Its
// builder is a spy that calls through, so what the alert SAYS is read where it
// enters the mail; the copy itself is proven in
// lib/__tests__/stream-credit-clawback-alert-email.test.ts. Sentry's issue
// capture is observed (call-through) so a test can assert the writer dropped
// nothing. The platform dispute alert (`staff_dispute_alert`) is queued the same
// way; its builder is a call-through spy too, read here only for what it says
// (platform-dispute.test.ts owns its rows).
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    streamCreditClawbackAlertEmail: vi.fn(actual.streamCreditClawbackAlertEmail),
    staffDisputeAlertEmail: vi.fn(actual.staffDisputeAlertEmail),
  };
});
vi.mock("@/lib/sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry")>();
  return { ...actual, captureError: vi.fn(actual.captureError) };
});
const clawbackAlert = vi.mocked(streamCreditClawbackAlertEmail);
const disputeAlert = vi.mocked(staffDisputeAlertEmail);
const KIND = "staff_stream_credit_clawback";
const RUN = `scc-${randomUUID().slice(0, 8)}`;
const clawSubject = (ref: string): string => `Match credits claw-back needs review: ${ref}`;

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

/** The `created_at` Postgres stamped on a purchase row — the attribution
 *  boundary the claw-back reads. Needed to force the EXACT-TIE case, which is
 *  otherwise unreachable (two transactions never take the same `now()`). */
async function purchasedAt(intent: string): Promise<Date> {
  const [row] = await sql<{ created_at: Date }[]>`
    select created_at from org_stream_credits
     where reason = 'purchase' and stripe_payment_intent_id = ${intent}`;
  return new Date(row!.created_at);
}

/** One `consume` row stamped at an EXPLICIT instant, for the boundary cases. */
async function spendAt(orgId: string, at: Date): Promise<void> {
  const bal = await creditBalance(sql, orgId);
  await sql`
    insert into org_stream_credits (org_id, delta, reason, balance_after, created_at)
    values (${orgId}, -1, 'consume', ${bal - 1}, ${at})`;
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

/** This test's own staff address and its `log.error` spy, both set in `beforeEach`. */
let staff = "";
let errors: ReturnType<typeof vi.spyOn>;
/** What the writer's never-throws catch left (I2): an alert that was queued or deduplicated left nothing. */
const drops = () => staffAlertDrops(errors, vi.mocked(captureError));
/** One queued claw-back row to this test's staff address, keyed `<ref>:<suffix>`. */
const clawRow = (ref: string, suffix: string) => ({
  ref_id: `${ref}:${suffix}`,
  dedupe_key: `${ref}:${suffix}`,
  status: "queued",
  recipient: staff,
  subject: clawSubject(ref),
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where kind in ${sql([KIND, "staff_dispute_alert"])} and lower(recipient) like ${`staff-${RUN}-%`}`;
});

describe.skipIf(!HAS_DB)("charge.refunded → match-credit claw-back", () => {
  beforeEach(() => {
    clawbackAlert.mockClear();
    disputeAlert.mockClear();
    vi.mocked(captureError).mockClear();
    stripeMock.retrieveIntent.mockReset();
    // A real retrieve always answers with a PaymentIntent object; the AI pack
    // handler runs FIRST on every charge.refunded and reads `pi.metadata`, so a
    // bare reset (returning undefined) would crash the donor, not this arm.
    stripeMock.retrieveIntent.mockResolvedValue({ metadata: {} });
    // This test's own staff address: CI sets none, and the database is shared.
    staff = `staff-${RUN}-${uniq()}@x.test`;
    vi.stubEnv("STAFF_ALERT_EMAIL", staff);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy");
    errors = vi.spyOn(log, "error");
  });
  afterEach(() => {
    errors.mockRestore();
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
    expect(await staffRows(KIND, "charge", chargeId), "no page, to any recipient").toHaveLength(0);
  });

  it("a PARTIALLY spent pack: the claw-back is capped at the balance, and staff are alerted", async () => {
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);
    await spend(auth.orgId, 3);
    expect(await creditBalance(sql, auth.orgId)).toBe(2);
    const chargeId = `ch_${RUN}_${uniq()}`;

    await processStripeEvent(refundEvent({ paymentIntent: intent, chargeId }));

    // 2 revoked, not 5. An uncapped revoke would write balance_after -3 and
    // V410's CHECK would throw inside the webhook.
    expect(await creditBalance(sql, auth.orgId)).toBe(0);
    const rows = await revokeRows(auth.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delta).toBe(-2);
    expect(rows[0]!.balance_after).toBe(0);
    // Bought → streamed → refunded is the abuse signature. Recorded AND alerted
    // (one page, keyed `<charge>:short`); a human decides whether to chase.
    expect(await staffRows(KIND, "charge", chargeId)).toEqual([clawRow(chargeId, "short")]);
    expect(clawbackAlert).toHaveBeenCalledTimes(1);
    const arg = clawbackAlert.mock.calls[0]![0];
    expect(arg.chargeId).toBe(chargeId);
    expect(arg.orgId).toBe(auth.orgId);
    expect(arg.purchased).toBe(5);
    expect(arg.clawedBack).toBe(2);
    expect(drops(), "the alert was queued, not dropped").toEqual({ logged: 0, issues: 0 });
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

  // ---- ATTRIBUTION: the claw-back is bounded by what THAT purchase still has
  // outstanding, not by the org's whole balance (review C-1 / G-1, orchestrator
  // ruling 2026-09-28). `min(purchased, balance)` alone lets a refund of pack A
  // eat pack B, on the FIRST delivery, with no alert — `clawedBack === purchased`
  // reads as a clean reversal.

  it("a refund of pack A never touches pack B: a fully-spent pack has nothing outstanding", async () => {
    const { auth } = await seedOrg();
    const { intent: a } = await buyPack(auth.orgId, 5);
    await spend(auth.orgId, 5); // pack A is gone — those streams went out
    await buyPack(auth.orgId, 5); // pack B, paid for separately, untouched
    expect(await creditBalance(sql, auth.orgId)).toBe(5);

    await processStripeEvent(refundEvent({ paymentIntent: a }));

    // Bounded by A's outstanding (0), NOT by the balance (5).
    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    expect(await revokeRows(auth.orgId)).toHaveLength(0);
    // …and the short claw-back IS reported, which `min(purchased, balance)`
    // would have suppressed by clawing the full 5 out of the wrong pack.
    expect(clawbackAlert).toHaveBeenCalledTimes(1);
    expect(clawbackAlert.mock.calls[0]![0]).toMatchObject({ purchased: 5, clawedBack: 0 });
  });

  it("a refund of pack A claws only A's unspent remainder while B is held", async () => {
    const { auth } = await seedOrg();
    const { intent: a } = await buyPack(auth.orgId, 5);
    await spend(auth.orgId, 3); // 3 of A's 5 streamed
    await buyPack(auth.orgId, 5); // B arrives after
    expect(await creditBalance(sql, auth.orgId)).toBe(7);

    await processStripeEvent(refundEvent({ paymentIntent: a }));

    // 2 — A's remainder — never 5, and never the 7 the balance would allow.
    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    const rows = await revokeRows(auth.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delta).toBe(-2);
    expect(rows[0]!.balance_after).toBe(5);
    expect(clawbackAlert.mock.calls[0]![0]).toMatchObject({ purchased: 5, clawedBack: 2 });
  });

  it("credits spent BEFORE a purchase are not charged against it", async () => {
    // The negative pair of the two above: attribution must not run backwards.
    // Without the `created_at >= <this purchase>` bound, the earlier pack's
    // five consumes would be counted against A and claw back nothing.
    const { auth } = await seedOrg();
    await buyPack(auth.orgId, 5); // an EARLIER pack…
    await spend(auth.orgId, 5); // …entirely spent before A is bought
    const { intent: a } = await buyPack(auth.orgId, 5);
    expect(await creditBalance(sql, auth.orgId)).toBe(5);

    await processStripeEvent(refundEvent({ paymentIntent: a }));

    expect(await creditBalance(sql, auth.orgId)).toBe(0);
    const rows = await revokeRows(auth.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delta).toBe(-5);
    expect(clawbackAlert).not.toHaveBeenCalled(); // clean, full reversal
  });

  it("a consume stamped in the SAME instant as the purchase counts AGAINST it", async () => {
    // `org_stream_credits.id` is `gen_random_uuid()` (V410:251) — random, not
    // time-sortable — and there is no sequence column, so a `created_at` tie
    // CANNOT be broken. The bound is `>=`, so a tie counts the consume as
    // spent from this purchase: more counted spent ⇒ LESS clawed back, which
    // is the conservative way to be wrong on a money path. Pinned here because
    // flipping `>=` to `>` is otherwise invisible.
    const { auth } = await seedOrg();
    const { intent: a } = await buyPack(auth.orgId, 5);
    await spendAt(auth.orgId, await purchasedAt(a)); // the exact same instant
    await buyPack(auth.orgId, 5); // a second pack, so the balance cannot bind
    expect(await creditBalance(sql, auth.orgId)).toBe(9);

    await processStripeEvent(refundEvent({ paymentIntent: a }));

    // 4, not 5: the tied consume is counted against A. With `>` it would be 5.
    const rows = await revokeRows(auth.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delta).toBe(-4);
    expect(await creditBalance(sql, auth.orgId)).toBe(5);
  });

  it("the balance is still a floor: credits expired after purchase cannot be over-clawed", async () => {
    // `outstanding` alone is not enough — a non-consume reduction (an expiry,
    // or a staff revoke) lowers the balance without touching attribution. An
    // uncapped revoke here would write balance_after -3 and V410's CHECK would
    // throw inside the webhook.
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);
    await sql`
      insert into org_stream_credits (org_id, delta, reason, balance_after)
      values (${auth.orgId}, -3, 'expire', 2)`;
    expect(await creditBalance(sql, auth.orgId)).toBe(2);

    await processStripeEvent(refundEvent({ paymentIntent: intent }));

    expect(await creditBalance(sql, auth.orgId)).toBe(0);
    const rows = await revokeRows(auth.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delta).toBe(-2);
    expect(rows[0]!.balance_after).toBe(0);
    expect(clawbackAlert.mock.calls[0]![0]).toMatchObject({ purchased: 5, clawedBack: 2 });
  });

  it("a ledger that sums below zero is REFUSED, not silently clamped", async () => {
    // "Cannot happen" is a guard, not a comment (TEST-STRATEGY.md rule 4).
    // V410's `balance_after >= 0` CHECK constrains each row's SNAPSHOT, not
    // sum(delta), so a corrupt row can still drive the true balance negative —
    // and a silent clamp would quietly claw back nothing instead of paging
    // anybody. The webhook must fail loudly so Stripe retries and a human looks.
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);
    await sql`
      insert into org_stream_credits (org_id, delta, reason, balance_after)
      values (${auth.orgId}, -10, 'consume', 0)`;
    expect(await creditBalance(sql, auth.orgId)).toBe(-5);

    await expect(processStripeEvent(refundEvent({ paymentIntent: intent }))).rejects.toThrow(
      /match-credit balance/i,
    );
    expect(await revokeRows(auth.orgId)).toHaveLength(0);
  });

  it("a replayed SHORT claw-back reports the EARLIER amount, writes no second row, reaches the alert again and pages once", async () => {
    // The replay branch returns `-prior.delta`, not 0, so the caller's
    // `clawedBack < purchased` verdict is the same on every delivery. Every
    // other replay case here uses an UNSPENT pack, where that number equals
    // `purchased` and any value >= purchased would pass — this is the only
    // case that can witness it.
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);
    await spend(auth.orgId, 3);
    const chargeId = `ch_${RUN}_${uniq()}`;
    const ev = refundEvent({ paymentIntent: intent, chargeId });

    await processStripeEvent(ev);
    expect(clawbackAlert).toHaveBeenCalledTimes(1);
    expect(clawbackAlert.mock.calls[0]![0]).toMatchObject({ purchased: 5, clawedBack: 2 });

    await processStripeEvent(ev); // the same charge again

    expect(await revokeRows(auth.orgId)).toHaveLength(1);
    expect(await creditBalance(sql, auth.orgId)).toBe(0);
    // The replay reports 2 — the amount the FIRST call clawed — so the replay
    // reaches the abuse alert again rather than falling silent before it…
    expect(clawbackAlert, "premise: both deliveries reached the alert").toHaveBeenCalledTimes(2);
    expect(clawbackAlert.mock.calls[1]![0]).toMatchObject({ purchased: 5, clawedBack: 2 });
    // …and the charge's once-key (`<charge>:short`) makes it one page.
    expect(await staffRows(KIND, "charge", chargeId)).toEqual([clawRow(chargeId, "short")]);
    expect(drops(), "deduplicated, not dropped").toEqual({ logged: 0, issues: 0 });
  });

  it("a refund of a DIFFERENT charge leaves another org's pack alone, and no PaymentIntent metadata makes it ours", async () => {
    const { auth } = await seedOrg();
    await buyPack(auth.orgId, 5);
    expect(await creditBalance(sql, auth.orgId)).toBe(5);

    // A genuine non-stream charge: the retrieve answers with another product's
    // metadata, so the ungranted-pack alert must NOT fire either.
    stripeMock.retrieveIntent.mockResolvedValue({ metadata: { kind: "credit_pack" } });
    const chargeId = `ch_${RUN}_${uniq()}`;
    await processStripeEvent(refundEvent({ paymentIntent: `pi_unrelated_${uniq()}`, chargeId }));

    // The gate is `stripe_payment_intent_id = <this intent>`. Widened to "any
    // purchase row", this refund would claw back a stranger's pack.
    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    expect(await revokeRows(auth.orgId)).toHaveLength(0);
    expect(clawbackAlert).not.toHaveBeenCalled();
    expect(await staffRows(KIND, "charge", chargeId), "no page, to any recipient").toHaveLength(0);
  });

  it("a refunded match-credit charge with NO purchase row alerts a human and writes nothing", async () => {
    const orgId = randomUUID();
    const intent = `pi_ungranted_${uniq()}`;
    stripeMock.retrieveIntent.mockResolvedValue({
      metadata: { kind: "stream_credits", org_id: orgId, pack: "5" },
    });
    const chargeId = `ch_${RUN}_${uniq()}`;

    await processStripeEvent(refundEvent({ paymentIntent: intent, chargeId }));

    expect(stripeMock.retrieveIntent).toHaveBeenCalledWith(intent);
    // One page, keyed `<charge>:ungranted`.
    expect(await staffRows(KIND, "charge", chargeId)).toEqual([clawRow(chargeId, "ungranted")]);
    expect(drops(), "the alert was queued, not dropped").toEqual({ logged: 0, issues: 0 });
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
    const chargeId = `ch_${RUN}_${uniq()}`;

    await processStripeEvent(
      refundEvent({ paymentIntent: intent, chargeId, refunded: false, amountRefunded: 0 }),
    );

    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    expect(await revokeRows(auth.orgId)).toHaveLength(0);
    expect(clawbackAlert).not.toHaveBeenCalled();
    expect(await staffRows(KIND, "charge", chargeId), "no page, to any recipient").toHaveLength(0);
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

  // ---- The staff page: once per incident (P-W5-9). The row's ref IS its
  // once-key (P-W5-1), so a replay pages nothing more, while two DIFFERENT
  // incidents about one charge are two pages and neither replaces the other.

  it("a partial refund pages once under the charge", async () => {
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);
    const chargeId = `ch_${RUN}_${uniq()}`;

    await processStripeEvent(refundEvent({ paymentIntent: intent, chargeId, refunded: false, amountRefunded: 500 }));

    // Keyed `<charge>:partial:<amount_refunded>`: the amount is what moved.
    expect(await staffRows(KIND, "charge", chargeId)).toEqual([clawRow(chargeId, "partial:500")]);
    expect(clawbackAlert, "what the alert says").toHaveBeenCalledWith({
      chargeId,
      orgId: auth.orgId,
      purchased: 5,
      clawedBack: 0,
      reason: expect.stringMatching(/partial/i),
    });
    expect(drops(), "the alert was queued, not dropped").toEqual({ logged: 0, issues: 0 });
  });

  it("a redelivered partial refund pages nothing more", async () => {
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);
    const chargeId = `ch_${RUN}_${uniq()}`;
    const ev = refundEvent({ paymentIntent: intent, chargeId, refunded: false, amountRefunded: 500 });

    // processStripeEvent, not runEvent: the billing_events claim would stop a
    // true redelivery before the handler, and this is the once-key's test.
    await processStripeEvent(ev);
    await processStripeEvent(ev);

    expect(clawbackAlert, "premise: both deliveries reached the alert").toHaveBeenCalledTimes(2);
    expect(await staffRows(KIND, "charge", chargeId)).toEqual([clawRow(chargeId, "partial:500")]);
    expect(drops(), "deduplicated, not dropped").toEqual({ logged: 0, issues: 0 });
  });

  it("a partial and then a full short refund of one charge are two alerts, and neither replaces the other", async () => {
    // Review Focus 1. The two pages share a kind, a charge and a recipient; with
    // a shared ref the replace trigger would let the second supersede the
    // first while it waits for the worker.
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);
    await spend(auth.orgId, 3);
    const chargeId = `ch_${RUN}_${uniq()}`;

    await processStripeEvent(refundEvent({ paymentIntent: intent, chargeId, refunded: false, amountRefunded: 500 }));
    await processStripeEvent(refundEvent({ paymentIntent: intent, chargeId, refunded: true, amountRefunded: 2500 }));

    expect(await revokeRows(auth.orgId), "premise: the full refund clawed back the 2 left, short of 5").toMatchObject([{ delta: -2 }]);
    expect(clawbackAlert, "premise: both refunds reached the alert").toHaveBeenCalledTimes(2);
    // Both queued: neither is `replaced`.
    expect(await staffRows(KIND, "charge", chargeId)).toEqual([clawRow(chargeId, "partial:500"), clawRow(chargeId, "short")]);
    expect(drops(), "both queued, nothing dropped").toEqual({ logged: 0, issues: 0 });
  });
});

describe.skipIf(!HAS_DB)("charge.dispute.* → match-credit claw-back", () => {
  beforeEach(() => {
    clawbackAlert.mockClear();
    disputeAlert.mockClear();
    vi.mocked(captureError).mockClear();
    stripeMock.retrieveIntent.mockReset();
    // A real retrieve always answers with a PaymentIntent object; the AI pack
    // handler runs FIRST on every charge.refunded and reads `pi.metadata`, so a
    // bare reset (returning undefined) would crash the donor, not this arm.
    stripeMock.retrieveIntent.mockResolvedValue({ metadata: {} });
    // This test's own staff address: CI sets none, and the database is shared.
    staff = `staff-${RUN}-${uniq()}@x.test`;
    vi.stubEnv("STAFF_ALERT_EMAIL", staff);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy");
    errors = vi.spyOn(log, "error");
  });
  afterEach(() => {
    errors.mockRestore();
    vi.unstubAllEnvs();
  });

  it("a LOST closed dispute claws back on the refund's terms, names the DISPUTE in the note, and alerts on the short claw-back", async () => {
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);
    await spend(auth.orgId, 1);
    const disputeId = `dp_stream_${uniq()}`;

    await processStripeEvent(
      disputeEvent({ paymentIntent: intent, phase: "closed", status: "lost", disputeId }),
    );

    expect(await creditBalance(sql, auth.orgId)).toBe(0);
    const rows = await revokeRows(auth.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delta).toBe(-4); // bounded by what the purchase still held
    expect(rows[0]!.idempotency_key).toBe(`stream_pack_refund:${intent}`);
    // The note is the human audit trail for a money row: it must say WHICH
    // Stripe object caused it and that it was a dispute, not a refund.
    expect(rows[0]!.note).toMatch(/lost dispute/i);
    expect(rows[0]!.note).toContain(disputeId);
    expect(disputeAlert).toHaveBeenCalledTimes(1);
    expect(disputeAlert.mock.calls[0]![0].kind).toBe("stream_credits");
    // "A lost dispute claws back ON THE SAME TERMS" — the alert is part of
    // those terms. 4 of 5 means a stream went out and was then charged back.
    expect(clawbackAlert).toHaveBeenCalledTimes(1);
    expect(clawbackAlert.mock.calls[0]![0]).toMatchObject({ purchased: 5, clawedBack: 4 });
  });

  it("a LOST dispute that reverses the pack cleanly does NOT raise a claw-back alert", async () => {
    // The positive pair for the assertion above: the dispute arm's alert is
    // conditional on the SHORT claw-back, not fired on every lost dispute.
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);
    const disputeId = `dp_${RUN}_${uniq()}`;

    await processStripeEvent(disputeEvent({ paymentIntent: intent, phase: "closed", status: "lost", disputeId }));

    expect(await revokeRows(auth.orgId)).toHaveLength(1);
    expect(await creditBalance(sql, auth.orgId)).toBe(0);
    expect(disputeAlert).toHaveBeenCalledTimes(1);
    expect(clawbackAlert).not.toHaveBeenCalled();
    expect(await staffRows(KIND, "dispute", disputeId), "no claw-back page, to any recipient").toHaveLength(0);
  });

  it("a lost dispute's short claw-back pages under the dispute", async () => {
    const { auth } = await seedOrg();
    const { intent } = await buyPack(auth.orgId, 5);
    await spend(auth.orgId, 1);
    const disputeId = `dp_${RUN}_${uniq()}`;

    await processStripeEvent(disputeEvent({ paymentIntent: intent, phase: "closed", status: "lost", disputeId }));

    // Ref type `dispute`, keyed `<dispute>:lost`: the dispute is what a staffer
    // opens, and a refund of the same charge is a different incident.
    expect(await staffRows(KIND, "dispute", disputeId)).toEqual([clawRow(disputeId, "lost")]);
    expect(clawbackAlert, "what the alert says").toHaveBeenCalledWith({
      chargeId: disputeId,
      orgId: auth.orgId,
      purchased: 5,
      clawedBack: 4,
      reason: expect.stringMatching(/fewer credits than the pack granted/),
    });
    expect(drops(), "the alert was queued, not dropped").toEqual({ logged: 0, issues: 0 });
  });

  it("a lost dispute after a refund that clawed NOTHING still cannot revoke a later pack", async () => {
    // Review C-1. The refund of a fully-spent pack writes no row (V410's
    // `delta <> 0`), so it mints no idempotency key — the key guard is absent
    // on exactly this branch, and the dispute arrives as a DIFFERENT Stripe
    // event id, so the billing_events claim does not stop it either. What
    // stops it is attribution: the purchase has nothing outstanding and never
    // will, because consumption only ever grows.
    const { auth } = await seedOrg();
    const { intent: a } = await buyPack(auth.orgId, 5);
    await spend(auth.orgId, 5);
    await processStripeEvent(refundEvent({ paymentIntent: a }));
    expect(await revokeRows(auth.orgId)).toHaveLength(0); // nothing clawed, no key minted
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from org_stream_credits
       where org_id = ${auth.orgId} and idempotency_key is not null`;
    expect(n).toBe("0");

    await buyPack(auth.orgId, 5); // weeks later, within the dispute window
    expect(await creditBalance(sql, auth.orgId)).toBe(5);

    await processStripeEvent(disputeEvent({ paymentIntent: a, phase: "closed", status: "lost" }));

    expect(await creditBalance(sql, auth.orgId)).toBe(5); // the NEW pack is untouched
    expect(await revokeRows(auth.orgId)).toHaveLength(0);
    expect(disputeAlert).toHaveBeenCalledTimes(1); // still reported to a human
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
