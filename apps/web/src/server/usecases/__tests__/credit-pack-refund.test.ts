// Credit-pack refund → wallet claw-back (v17 SPEC-2 §5, Phase 3 Task 4).
//
// A `charge.refunded` for a credit-pack charge claws back only the credits the
// customer has NOT yet spent from the `pack` bucket — never more than the
// purchase granted, never below zero, never touching the `grant` bucket, and
// idempotent on a webhook replay.
//
// The pack charge is identified by matching the charge's `payment_intent`
// against the seeded `pack_purchase` ledger row — NOT off `charge.metadata`.
// Stripe does NOT copy `payment_intent_data.metadata` onto the Charge object
// (Charge and PaymentIntent metadata are distinct fields), so these fixtures
// carry NO `metadata.kind` — the real Checkout-created shape. A `matched`
// ledger row is what proves a charge is a pack; the only time the PaymentIntent
// metadata is consulted is the ungranted-pack alert branch, where a guarded
// `paymentIntents.retrieve` (mocked here) distinguishes a paid-but-never-granted
// pack from a genuine non-pack (registration/sponsor/pass) refund.
//
// The staff alert for a paid pack that holds nothing (phase 3 wave 5, kind
// `staff_credit_pack_grant_failed`) is queued on the email outbox to
// STAFF_ALERT_EMAIL, once per Stripe object (P-W5-10): a refunded pack with no
// ledger row under its CHARGE (ref type `charge`), and, in the second block
// below, a paid session that could not be granted under its SESSION (ref type
// `checkout_session`). The tests read the row (`staffRows`) with this run's own
// staff address, and assert the writer dropped nothing (no
// STAFF_ALERT_QUEUE_FAILED line, no Sentry issue). The builder is a spy that
// calls through, so what the alert says is read where it enters the mail. The
// subjects are the sender's inline English, typed from its source.
//
// Real Postgres required; skipped without DATABASE_URL. Run against the fresh
// v17 schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { balance, grantBalance, packBalance, recordPackPurchase, reserve, walletIdFor } from "@/lib/credits";
import { processStripeEvent, runEvent } from "../billing-events";
import { creditPackGrantFailedAlertEmail } from "@/lib/email";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import { staffAlertDrops, staffRows } from "./_money-fixtures";

vi.mock("@/lib/email", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/email")>();
  return { ...actual, creditPackGrantFailedAlertEmail: vi.fn(actual.creditPackGrantFailedAlertEmail) };
});
vi.mock("@/lib/sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry")>();
  return { ...actual, captureError: vi.fn(actual.captureError) };
});

// The guarded PaymentIntent retrieve the matched===false branch uses to tell an
// ungranted pack from a non-pack charge. THIS handler's matched path never
// calls it — but since streaming R1 the `charge.refunded` arm also runs
// `handleStreamPackChargeRefunded`, whose own ungranted branch retrieves for any
// charge that is not a match-credit pack, i.e. for every fixture in this file.
// So "was it called" no longer isolates this handler; the two matched tests make
// the retrieve REJECT instead, which proves independence rather than absence.
const stripeMock = vi.hoisted(() => ({ retrieveIntent: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ paymentIntents: { retrieve: stripeMock.retrieveIntent } }),
}));

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const RUN = `cpr-${uniq()}`;
const KIND = "staff_credit_pack_grant_failed";
/** This test's own staff address (CI sets none; a shared database must not count another run's rows). */
const staffAddress = (): string => `staff-${RUN}-${uniq()}@x.test`;

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where kind = ${KIND} and lower(recipient) like ${`staff-${RUN}-%`}`;
  await sql`delete from billing_events where id like ${`evt_${RUN}_%`}`;
});

async function seedOrg(): Promise<string> {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${`Pack Refund Org ${uniq()}`}, ${`pack-refund-org-${uniq()}`})
    returning id`;
  return org!.id;
}

/** Minimal `charge.refunded` event for a pack charge — only the fields the pack
 *  refund branch reads. Deliberately carries NO `metadata.kind`: Stripe never
 *  copies `payment_intent_data.metadata` onto a Charge, so the real object's
 *  `charge.metadata` is `{}`. Identification is by `payment_intent` → ledger
 *  row, exactly as production sees it. */
function packRefundEvent(over: { paymentIntent: string; chargeId?: string; refunded?: boolean }): Stripe.Event {
  return {
    id: `evt_${uniq()}`,
    type: "charge.refunded",
    data: {
      object: {
        id: over.chargeId ?? `ch_${uniq()}`,
        refunded: over.refunded ?? true,
        amount_refunded: 0,
        payment_intent: over.paymentIntent,
        metadata: {}, // real Checkout charge: PI metadata is NOT copied here.
      },
    },
  } as unknown as Stripe.Event;
}

describe.skipIf(!HAS_DB)("webhook → credit pack refund claws back unspent pack credits", () => {
  const alertMock = vi.mocked(creditPackGrantFailedAlertEmail);

  beforeEach(() => {
    alertMock.mockClear();
    vi.mocked(captureError).mockClear();
    stripeMock.retrieveIntent.mockReset();
    // A real `paymentIntents.retrieve` always answers with a PaymentIntent
    // object. A bare reset returns `undefined`, which no caller can be asked to
    // survive — and since streaming R1 added `handleStreamPackChargeRefunded` to
    // this same `charge.refunded` arm, a charge that is not a match-credit pack
    // DOES reach a second guarded retrieve. Default it to somebody else's
    // product; the two tests that care override it.
    stripeMock.retrieveIntent.mockResolvedValue({ metadata: { kind: "registration" } });
    // A key must be present for the guarded retrieve branch to be reachable.
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete process.env.STRIPE_SECRET_KEY;
  });

  it("fully-unspent pack: refund claws back exactly the grant, packBalance → 0", async () => {
    // STREAMING R1: this line used to read
    // `expect(stripeMock.retrieveIntent).not.toHaveBeenCalled()` at the bottom,
    // to prove the matched pack path needs no Stripe round trip. It no longer
    // states that about THIS handler — `handleStreamPackChargeRefunded` shares
    // the `charge.refunded` arm and does its own guarded retrieve for a charge
    // that is not a match-credit pack, which this one is not. A REJECTING
    // retrieve proves strictly more than an uncalled one: the pack claw-back
    // below lands with Stripe unavailable, so it cannot be reading it.
    stripeMock.retrieveIntent.mockRejectedValue(new Error("the matched pack path must not need Stripe"));
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    const intent = `pi_${uniq()}`;
    await recordPackPurchase(walletId, 40, intent);
    expect(await packBalance(walletId)).toBe(40);

    await processStripeEvent(packRefundEvent({ paymentIntent: intent }));

    expect(await packBalance(walletId)).toBe(0);
    expect(await balance(walletId)).toBe(0);
    const rows = await sql<{ delta: number; source: string; bucket: string; ref: string | null }[]>`
      select delta, source, bucket, ref from ai_credit_ledger
       where wallet_id = ${walletId} and source = 'refund'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ delta: -40, source: "refund", bucket: "pack", ref: intent });
    // (the rejecting retrieve stubbed at the top of this test is the proof)
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("partially-spent pack: claws back only what remains, never negative, grant bucket untouched", async () => {
    // Same as above (streaming R1): the pack path's independence from Stripe is
    // asserted by making the retrieve REJECT, not by counting calls — the arm
    // now carries a second handler with its own guarded retrieve.
    stripeMock.retrieveIntent.mockRejectedValue(new Error("the matched pack path must not need Stripe"));
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    const intent = `pi_${uniq()}`;
    await recordPackPurchase(walletId, 40, intent);
    // grant bucket is 0, so this reserve draws the 12 from the pack bucket via
    // the REAL spend path (reserve), not a hand-written ledger row.
    await reserve(walletId, orgId, 12);
    expect(await packBalance(walletId)).toBe(28);

    await processStripeEvent(packRefundEvent({ paymentIntent: intent }));

    expect(await packBalance(walletId)).toBe(0); // 28 clawed, min(40, 28), never below 0
    expect(await grantBalance(walletId)).toBe(0);
    const refundRows = await sql<{ delta: number; bucket: string }[]>`
      select delta, bucket from ai_credit_ledger
       where wallet_id = ${walletId} and source = 'refund'`;
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]).toMatchObject({ delta: -28, bucket: "pack" });
    // No refund ever touches the grant bucket.
    const grantRefunds = refundRows.filter((r) => r.bucket === "grant");
    expect(grantRefunds).toHaveLength(0);
  });

  it("non-pack charge (no pack_purchase row, PI metadata not credit_pack) is a silent no-op — no ledger row, no alert", async () => {
    vi.stubEnv("STAFF_ALERT_EMAIL", staffAddress());
    // A registration/sponsor/pass refund: the PI retrieve resolves, but its
    // metadata.kind is NOT credit_pack, so it must stay silent. (The positive
    // pair is the last test in this block: the same refund of a pack pages.)
    stripeMock.retrieveIntent.mockResolvedValue({ metadata: { kind: "registration" } });
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    await recordPackPurchase(walletId, 40, `pi_${uniq()}`);
    expect(await packBalance(walletId)).toBe(40);

    // Different payment_intent — no pack_purchase row matches it.
    const chargeId = `ch_${RUN}_${uniq()}`;
    await processStripeEvent(packRefundEvent({ paymentIntent: `pi_${uniq()}`, chargeId }));

    expect(await packBalance(walletId)).toBe(40);
    const refundRows = await sql<{ id: string }[]>`
      select id from ai_credit_ledger where wallet_id = ${walletId} and source = 'refund'`;
    expect(refundRows).toHaveLength(0);
    expect(alertMock).not.toHaveBeenCalled();
    expect(await staffRows(KIND, "charge", chargeId), "no staff row").toHaveLength(0);
  });

  it("replayed charge.refunded is idempotent — exactly one refund row, clawed once", async () => {
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    const intent = `pi_${uniq()}`;
    await recordPackPurchase(walletId, 40, intent);
    const event = packRefundEvent({ paymentIntent: intent });

    await processStripeEvent(event);
    expect(await packBalance(walletId)).toBe(0);
    await processStripeEvent(event); // verbatim redelivery
    expect(await packBalance(walletId)).toBe(0);

    const rows = await sql<{ id: string }[]>`
      select id from ai_credit_ledger where wallet_id = ${walletId} and source = 'refund'`;
    expect(rows).toHaveLength(1);
  });

  it("a refunded pack with no ledger row pages under the charge, and writes no negative balance", async () => {
    const staff = staffAddress();
    vi.stubEnv("STAFF_ALERT_EMAIL", staff);
    const errors = vi.spyOn(log, "error");
    const orgId = await seedOrg();
    const walletId = await walletIdFor(orgId);
    const intent = `pi_${uniq()}`; // never recorded a purchase for this intent
    const chargeId = `ch_${RUN}_${uniq()}`;
    // The guarded retrieve reveals it WAS a pack (Part A stamps the PI) — an
    // ungranted-then-refunded pack, which must alert rather than no-op.
    stripeMock.retrieveIntent.mockResolvedValue({
      metadata: { kind: "credit_pack", org_id: orgId, pack_key: "credits_10" },
    });

    await processStripeEvent(packRefundEvent({ paymentIntent: intent, chargeId }));

    expect(await balance(walletId)).toBe(0);
    const rows = await sql<{ id: string }[]>`
      select id from ai_credit_ledger where wallet_id = ${walletId} and source = 'refund'`;
    expect(rows).toHaveLength(0);
    expect(stripeMock.retrieveIntent).toHaveBeenCalledWith(intent);
    // P-W5-10: the refund's own Stripe object is the charge, so the ref type is `charge` and the key the charge id.
    expect(await staffRows(KIND, "charge", chargeId)).toEqual([
      { ref_id: chargeId, dedupe_key: chargeId, status: "queued", recipient: staff, subject: `Credit pack purchase could not be granted: ${chargeId}` },
    ]);
    expect(alertMock, "what the alert says").toHaveBeenCalledWith({
      sessionId: chargeId,
      orgId,
      packKey: "credits_10",
      reason: "refunded pack charge has no pack_purchase ledger row to claw back",
    });
    expect(staffAlertDrops(errors, vi.mocked(captureError)), "the alert was queued, not dropped").toEqual({ logged: 0, issues: 0 });
  });
});

/** A `checkout.session.completed` for an AI credit pack that is PAID but carries no credits snapshot and names a pack the catalog does
 *  not have: nothing can be granted. Only the fields the credit_pack limb reads. A fresh event id per call. */
function ungrantablePackSessionEvent(orgId: string, sessionId: string): Stripe.Event {
  return {
    id: `evt_${RUN}_${uniq()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        payment_status: "paid",
        payment_intent: `pi_${RUN}_${uniq()}`,
        customer: null,
        currency: "gbp",
        metadata: { kind: "credit_pack", org_id: orgId, pack_key: "nope" },
      },
    },
  } as unknown as Stripe.Event;
}

describe.skipIf(!HAS_DB)("webhook → a paid credit-pack session that cannot be granted pages staff", () => {
  beforeEach(() => {
    vi.mocked(creditPackGrantFailedAlertEmail).mockClear();
    vi.mocked(captureError).mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("a paid credit-pack session with no snapshot and no pack queues one alert", async () => {
    const staff = staffAddress();
    vi.stubEnv("STAFF_ALERT_EMAIL", staff);
    const errors = vi.spyOn(log, "error");
    const orgId = await seedOrg();
    const sessionId = `cs_${RUN}_${uniq()}`;

    await processStripeEvent(ungrantablePackSessionEvent(orgId, sessionId));

    expect(await balance(await walletIdFor(orgId)), "premise: nothing was granted").toBe(0);
    // P-W5-10: ref type `checkout_session`, keyed by the session id.
    expect(await staffRows(KIND, "checkout_session", sessionId)).toEqual([
      { ref_id: sessionId, dedupe_key: sessionId, status: "queued", recipient: staff, subject: `Credit pack purchase could not be granted: ${sessionId}` },
    ]);
    expect(creditPackGrantFailedAlertEmail, "what the alert says").toHaveBeenCalledWith({
      sessionId,
      orgId,
      packKey: "nope",
      reason: "no credits snapshot and no resolvable pack_key",
    });
    expect(staffAlertDrops(errors, vi.mocked(captureError)), "the alert was queued, not dropped").toEqual({ logged: 0, issues: 0 });
  });

  it("the same event processed twice pages once", async () => {
    const staff = staffAddress();
    vi.stubEnv("STAFF_ALERT_EMAIL", staff);
    const errors = vi.spyOn(log, "error");
    const orgId = await seedOrg();
    const sessionId = `cs_${RUN}_${uniq()}`;
    const event = ungrantablePackSessionEvent(orgId, sessionId);

    expect(await runEvent(event), "premise: the first delivery ran the handler").toBe(true);
    // A crashed attempt (wave-2 T10's pattern): the ledger row is left unprocessed and its lease has run out, so the next delivery
    // takes it over and runs the handler again.
    await sql`update billing_events set processed_at = null, processing_started_at = now() - interval '11 minutes' where id = ${event.id}`;
    expect(await runEvent(event), "premise: the redelivery ran the handler again").toBe(true);

    expect(creditPackGrantFailedAlertEmail, "premise: both runs reached the alert (the writer renders before the once-key insert)").toHaveBeenCalledTimes(2);
    expect(await staffRows(KIND, "checkout_session", sessionId)).toMatchObject([{ ref_id: sessionId, status: "queued", recipient: staff }]);
    expect(staffAlertDrops(errors, vi.mocked(captureError)), "the replay was deduplicated, not dropped").toEqual({ logged: 0, issues: 0 });
  });
});
