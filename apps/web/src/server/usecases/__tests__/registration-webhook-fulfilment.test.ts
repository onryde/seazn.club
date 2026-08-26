// RS003 W5b: the group-checkout webhook fulfilment path, consolidated.
//
// The SAME failure family has hit this dispatcher in two consecutive
// sessions, each time in a DIFFERENT place:
//   - RS002: confirmPaidRegistration had no `rejected` branch, so a late or
//     replayed Stripe webhook took money AND materialised an entrant for a
//     registration the organiser had explicitly refused (RULING A).
//   - RS003 W3b: the registration branch of the dispatch had no
//     `payment_status` gate while every OTHER kind in billing-events.ts's
//     dispatch already had one, so a delayed-notification payment method's
//     `checkout.session.completed` (fired while still `unpaid`) confirmed
//     and materialised before money actually moved.
// Both are "money and materialisation move on an event that does not mean
// what the code assumed". This file exercises fulfilment and idempotency
// together, through both `handleRegistrationCheckoutCompleted` directly and
// the `processStripeEvent`/`runEvent` dispatch, so the next change to this
// dispatcher cannot fix one hazard and reintroduce the other.
//
// Real Postgres required; skipped without DATABASE_URL (matches every other
// DB-backed usecase suite in this directory).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

// vi.mock is hoisted per-module and does not travel through an import, so
// this must be declared here even though _registration-fixtures.ts's
// stripeRig/currencyRig also exercise Stripe — see that file's header.
const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn();
  const checkoutRetrieve = vi.fn();
  const refundCreate = vi.fn();
  const chargeRetrieve = vi.fn();
  const reversalCreate = vi.fn();
  const reversalList = vi.fn();
  return {
    checkoutCreate,
    checkoutRetrieve,
    refundCreate,
    chargeRetrieve,
    reversalCreate,
    reversalList,
    stripe: {
      checkout: {
        sessions: { create: checkoutCreate, retrieve: checkoutRetrieve },
      },
      refunds: { create: refundCreate },
      charges: { retrieve: chargeRetrieve },
      transfers: {
        createReversal: reversalCreate,
        listReversals: reversalList,
      },
    },
  };
});

vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { balance, walletIdFor } from "@/lib/credits";
import { processStripeEvent, runEvent } from "../billing-events";
import { handleRegistrationCheckoutCompleted } from "../registrations";
import { seedRegistration, seedSecondEntry, loadWithGroup, fakeSession, stripeRig } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

/** The three event types the group-checkout path reacts to (billing-events.ts
 *  HANDLED_EVENT_TYPES). Typed as a closed union, not `string`, so a typo
 *  here is a compile error rather than a silently-unhandled event. */
type RegistrationEventType =
  | "checkout.session.completed"
  | "checkout.session.async_payment_succeeded"
  | "checkout.session.async_payment_failed";

function asEvent(type: RegistrationEventType, session: Stripe.Checkout.Session): Stripe.Event {
  return {
    id: "evt_" + randomUUID().slice(0, 8),
    type,
    data: { object: session },
  } as unknown as Stripe.Event;
}

/** competition_events rows written by audit(), scoped to one registration —
 *  the shared shape both `registration.payment_failed` and
 *  `registration.confirmed` use. */
async function auditCount(type: string, registrationId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from competition_events
    where type = ${type} and payload->>'registration_id' = ${registrationId}`;
  return Number(row!.n);
}

beforeEach(() => {
  stripeMock.checkoutCreate.mockReset().mockImplementation(async () => ({
    id: "cs_test_" + randomUUID().slice(0, 8),
    url: "https://checkout.stripe.test/session",
  }));
  stripeMock.refundCreate.mockReset().mockResolvedValue({ id: "re_test_1" });
  stripeMock.checkoutRetrieve.mockReset();
  stripeMock.chargeRetrieve.mockReset();
  stripeMock.reversalCreate.mockReset().mockResolvedValue({ id: "trr_test_1" });
  stripeMock.reversalList.mockReset().mockResolvedValue({ data: [] });
});

// `log` is a module-level singleton shared by every `it()` in this file —
// without this, a `vi.spyOn(log, "error")` installed by one test (cases
// 13-14 below) is REUSED, not re-wrapped, by the next test that spies on
// the same method (vitest returns the existing mock rather than nesting a
// second one), so its `.mock.calls` history leaks a PRIOR test's call into
// a later test's `toHaveBeenCalledWith`/`not.toHaveBeenCalled` assertions —
// found the hard way: case 14 failed with case 13's own mismatch payload.
afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("registration webhook fulfilment (RS002/RS003 regression)", () => {
  // -------------------------------------------------------------------------
  // Fulfilment (cases 1-6)
  // -------------------------------------------------------------------------

  it("[1] confirms exactly the entries named in registration_ids; a pending sibling absent from the list is untouched", async () => {
    const { competition, division, settings } = await stripeRig();
    const a = await seedRegistration(competition.id, division.id, settings, {
      displayName: "Entry A",
      amountCents: 500,
    });
    const b = await seedSecondEntry(a.registration.group_id, division.id, 500, "Entry B");
    const d = await seedSecondEntry(a.registration.group_id, division.id, 500, "Entry D — not in this session");

    await handleRegistrationCheckoutCompleted(fakeSession([a.registration.id, b.id], 1000));

    const aAfter = await loadWithGroup(a.registration.id);
    const bAfter = await loadWithGroup(b.id);
    const dAfter = await loadWithGroup(d.id);
    expect(aAfter.status).toBe("confirmed");
    expect(bAfter.status).toBe("confirmed");
    expect(dAfter.status).toBe("pending"); // untouched — not named in registration_ids
    expect(dAfter.entrant_id).toBeNull();
  });

  it("[2] payment_status unpaid on checkout.session.completed confirms and materialises nothing", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    const session = {
      ...fakeSession(res.registration.id, 500),
      payment_status: "unpaid",
    } as unknown as Stripe.Checkout.Session;

    await handleRegistrationCheckoutCompleted(session);

    const row = await loadWithGroup(res.registration.id);
    expect(row.status).toBe("pending");
    expect(row.entrant_id).toBeNull();
  });

  it("[3] checkout.session.async_payment_succeeded, dispatched through runEvent, confirms the same as a paid completion", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    const session = fakeSession(res.registration.id, 500); // payment_status: "paid"

    const handled = await runEvent(asEvent("checkout.session.async_payment_succeeded", session));

    expect(handled).toBe(true);
    const row = await loadWithGroup(res.registration.id);
    expect(row.status).toBe("confirmed");
    expect(row.entrant_id).not.toBeNull();
  });

  it("[4] checkout.session.async_payment_failed never confirms, leaves every named entry payable, and writes one payment_failed audit row per entry", async () => {
    const { competition, division, settings } = await stripeRig();
    const a = await seedRegistration(competition.id, division.id, settings, { displayName: "Entry A" });
    const b = await seedSecondEntry(a.registration.group_id, division.id, 500, "Entry B");
    const session = {
      ...fakeSession([a.registration.id, b.id], 1000),
      payment_status: "unpaid",
    } as unknown as Stripe.Checkout.Session;

    await processStripeEvent(asEvent("checkout.session.async_payment_failed", session));

    const aAfter = await loadWithGroup(a.registration.id);
    const bAfter = await loadWithGroup(b.id);
    expect(aAfter.status).toBe("pending");
    expect(aAfter.entrant_id).toBeNull();
    expect(bAfter.status).toBe("pending");
    expect(await auditCount("registration.payment_failed", a.registration.id)).toBe(1);
    expect(await auditCount("registration.payment_failed", b.id)).toBe(1);
  });

  it("[5] RULING A through the group path: a rejected entry named in registration_ids is refunded its own amount, never confirmed; its sibling still confirms", async () => {
    const { competition, division, settings } = await stripeRig();
    const a = await seedRegistration(competition.id, division.id, settings, {
      displayName: "Entry A",
      amountCents: 1000,
    });
    const b = await seedSecondEntry(a.registration.group_id, division.id, 700, "Entry B");
    await sql`update registrations set status = 'rejected' where id = ${a.registration.id}`;
    stripeMock.refundCreate.mockClear();

    await handleRegistrationCheckoutCompleted(fakeSession([a.registration.id, b.id], 1700));

    const aAfter = await loadWithGroup(a.registration.id);
    const bAfter = await loadWithGroup(b.id);
    expect(aAfter.status).toBe("rejected"); // never confirmed
    expect(aAfter.entrant_id).toBeNull();
    expect(stripeMock.refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1000 }), // A's own amount, not the 1700 cart total
    );
    expect(bAfter.status).toBe("confirmed"); // sibling unaffected
  });

  it("[6] a manual-approval division leaves a listed entry paid-awaiting-approval and does NOT fire the first_paid growth grant", async () => {
    const { orgId, competition, division, settings } = await stripeRig();
    await sql`update registration_settings set approval = 'manual' where division_id = ${division.id}`;
    const walletId = await walletIdFor(orgId);
    const before = await balance(walletId);
    const res = await seedRegistration(competition.id, division.id, settings, { amountCents: 1000 });

    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 1000));

    const row = await loadWithGroup(res.registration.id);
    expect(row.status).toBe("paid"); // NOT confirmed — awaiting a human review
    expect(row.entrant_id).toBeNull();
    // The growth-loop earn grant is keyed on a genuine CONFIRMATION
    // (registrations.ts, the `if (outcome.kind === "confirmed")` block) —
    // a paid_awaiting_approval outcome must never reach it.
    expect(await balance(walletId)).toBe(before);
  });

  // -------------------------------------------------------------------------
  // Edge cases (cases 7-9)
  // -------------------------------------------------------------------------

  it("[7] a foreign session with no registration_ids is a clean no-op — never throws, on either fulfilment path", async () => {
    const foreignPaid = {
      id: "cs_test_foreign",
      payment_intent: "pi_test_foreign",
      payment_status: "paid",
      amount_total: 500,
      metadata: { kind: "registration_group", registration_group_id: "rg_foreign" }, // no registration_ids
    } as unknown as Stripe.Checkout.Session;
    await expect(handleRegistrationCheckoutCompleted(foreignPaid)).resolves.toBeUndefined();

    const foreignFailed = { ...foreignPaid, payment_status: "unpaid" } as unknown as Stripe.Checkout.Session;
    await expect(
      processStripeEvent(asEvent("checkout.session.async_payment_failed", foreignFailed)),
    ).resolves.toBeUndefined();
  });

  it("[8] fee_percent absent from session metadata falls back to the group's own fee_percent when locking the competition rate", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings, { amountCents: 500 });
    await sql`update registration_groups set fee_percent = 7 where id = ${res.registration.group_id}`;

    // fakeSession's third (feePercent) argument is omitted, so
    // metadata.fee_percent is absent — exactly a session minted before V312.
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500));

    const [comp] = await sql<{ fee_percent: number | null }[]>`
      select fee_percent from competitions where id = ${competition.id}`;
    expect(comp!.fee_percent).toBe(7);
  });

  it("[9] a mid-loop failure aborts the whole event: the earlier entry stays confirmed, the later entry stays untouched, and billing_events.processed_at stays null so Stripe retries", async () => {
    const { competition, division, settings } = await stripeRig();
    const a = await seedRegistration(competition.id, division.id, settings, {
      displayName: "Entry A",
      amountCents: 500,
    });
    const c = await seedSecondEntry(a.registration.group_id, division.id, 500, "Entry C");
    // The middle id is deliberately not a real registration: a malformed
    // uuid makes confirmPaidRegistration's own `for update` select throw a
    // genuine Postgres error (22P02 invalid input syntax), which is the only
    // way an uncaught exception can reach this sequential, no-per-id-catch
    // loop by design (doc comment above handleRegistrationCheckoutCompleted).
    // A real root cause (a bad write elsewhere, a data race) would throw the
    // exact same way — the loop's abort behaviour does not depend on WHY.
    const session = fakeSession([a.registration.id, "not-a-real-uuid", c.id], 1500);
    const event = asEvent("checkout.session.completed", session);

    await expect(runEvent(event)).rejects.toThrow();

    const aAfter = await loadWithGroup(a.registration.id);
    const cAfter = await loadWithGroup(c.id);
    expect(aAfter.status).toBe("confirmed"); // its own transaction already committed
    expect(cAfter.status).toBe("pending"); // never reached
    expect(cAfter.entrant_id).toBeNull();

    const [ledger] = await sql<{ processed_at: string | null }[]>`
      select processed_at from billing_events where id = ${event.id}`;
    expect(ledger!.processed_at).toBeNull(); // Stripe will retry the whole event
  });

  // -------------------------------------------------------------------------
  // Idempotency / replay (cases 10-12)
  // -------------------------------------------------------------------------

  it("[10] runEvent claims an event exactly once: an identical redelivery runs the handler zero additional times", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings, { amountCents: 500 });
    const event = asEvent("checkout.session.completed", fakeSession(res.registration.id, 500));

    const first = await runEvent(event);
    expect(first).toBe(true);
    const entrantId = (await loadWithGroup(res.registration.id)).entrant_id;
    expect(entrantId).not.toBeNull();
    expect(await auditCount("registration.confirmed", res.registration.id)).toBe(1);

    const second = await runEvent(event); // identical event.id, redelivered
    expect(second).toBe(false);
    const after = await loadWithGroup(res.registration.id);
    expect(after.entrant_id).toBe(entrantId); // no second materialisation
    expect(await auditCount("registration.confirmed", res.registration.id)).toBe(1); // handler did not run again
  });

  it("[11] a lease-expiry replay (processing_started_at stale, processed_at still null) DOES re-run, producing a second payment_failed audit row — this handler has no internal idempotency guard", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    const session = {
      ...fakeSession(res.registration.id, 500),
      payment_status: "unpaid",
    } as unknown as Stripe.Checkout.Session;
    const event = asEvent("checkout.session.async_payment_failed", session);

    const first = await runEvent(event);
    expect(first).toBe(true);
    expect(await auditCount("registration.payment_failed", res.registration.id)).toBe(1);

    // Simulate a stuck lease: the earlier attempt's claim is still on the
    // row, but its lease is long expired (>10 min) and it never reached
    // processed_at — exactly the state sweepStuckEvents/staff replay find.
    await sql`
      update billing_events
      set processed_at = null, processing_started_at = now() - interval '11 minutes'
      where id = ${event.id}`;

    const second = await runEvent(event);
    expect(second).toBe(true); // re-claimed — a stale lease does not block it
    // Pinned as-is (not a fix): handleRegistrationCheckoutAsyncPaymentFailed
    // has no guard of its own against re-auditing an already-recorded
    // failure, so a second genuine run writes a second row.
    expect(await auditCount("registration.payment_failed", res.registration.id)).toBe(2);
  });

  it("[12] a redelivered async_payment_succeeded (same session, direct handler replay) confirms once, not twice", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings, { amountCents: 500 });
    const session = fakeSession(res.registration.id, 500);

    await handleRegistrationCheckoutCompleted(session);
    const entrantId = (await loadWithGroup(res.registration.id)).entrant_id;
    expect(entrantId).not.toBeNull();
    expect(await auditCount("registration.confirmed", res.registration.id)).toBe(1);

    // Same session object, called directly a second time — bypasses the
    // billing_events ledger entirely, so only confirmPaidRegistration's OWN
    // already-paid/confirmed short-circuit can prevent a second fulfilment.
    await handleRegistrationCheckoutCompleted(session);

    const after = await loadWithGroup(res.registration.id);
    expect(after.entrant_id).toBe(entrantId); // no second entrant
    expect(await auditCount("registration.confirmed", res.registration.id)).toBe(1); // no second confirm audit
  });

  // -------------------------------------------------------------------------
  // Destination-account drift (CHANGE 1, cases 13-14, payment-integrity)
  // -------------------------------------------------------------------------

  it("[13] a destination account that changed since mint still confirms the entry, but records the drift for the organiser", async () => {
    const { orgId, competition, division, settings } = await stripeRig();
    const [orgBefore] = await sql<{ stripe_account_id: string }[]>`
      select stripe_account_id from organizations where id = ${orgId}`;
    const mintedDestination = orgBefore!.stripe_account_id;
    const res = await seedRegistration(competition.id, division.id, settings, { amountCents: 500 });

    // The org reconnects a DIFFERENT Stripe account after mint, before this
    // still-open session gets paid — exactly the hazard CHANGE 1 detects.
    const reconnectedAccount = "acct_" + randomUUID().slice(0, 8);
    await sql`update organizations set stripe_account_id = ${reconnectedAccount} where id = ${orgId}`;

    const session = fakeSession(res.registration.id, 500);
    (session.metadata as Record<string, string>).destination_account = mintedDestination;
    const errSpy = vi.spyOn(log, "error").mockImplementation(() => undefined as never);

    await handleRegistrationCheckoutCompleted(session);

    const row = await loadWithGroup(res.registration.id);
    expect(row.status).toBe("confirmed"); // still confirms — the registrant paid in good faith
    expect(row.entrant_id).not.toBeNull();
    expect(errSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mintedDestination,
        currentDestination: reconnectedAccount,
        sessionId: session.id,
      }),
      expect.stringContaining("destination account"),
    );
    const [drift] = await sql<{ n: string }[]>`
      select count(*)::text as n from competition_events
      where type = 'registration.destination_account_mismatch'
        and payload->>'checkout_session_id' = ${session.id}`;
    expect(Number(drift!.n)).toBe(1);
  });

  it("[14] a destination account that still matches the org's current account writes no drift audit row", async () => {
    const { orgId, competition, division, settings } = await stripeRig();
    const [org] = await sql<{ stripe_account_id: string }[]>`
      select stripe_account_id from organizations where id = ${orgId}`;
    const res = await seedRegistration(competition.id, division.id, settings, { amountCents: 500 });
    const session = fakeSession(res.registration.id, 500);
    (session.metadata as Record<string, string>).destination_account = org!.stripe_account_id;
    const errSpy = vi.spyOn(log, "error").mockImplementation(() => undefined as never);

    await handleRegistrationCheckoutCompleted(session);

    const row = await loadWithGroup(res.registration.id);
    expect(row.status).toBe("confirmed");
    expect(errSpy).not.toHaveBeenCalled();
    const [drift] = await sql<{ n: string }[]>`
      select count(*)::text as n from competition_events
      where type = 'registration.destination_account_mismatch'
        and payload->>'checkout_session_id' = ${session.id}`;
    expect(Number(drift!.n)).toBe(0);
  });
});
