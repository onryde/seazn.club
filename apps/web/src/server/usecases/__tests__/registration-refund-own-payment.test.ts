// Registration polish wave, W8 (walkthrough S08 + the s08b probe, 2026-11-12): the organiser's Refund on an entry that never paid
// issued a REAL refund. A cart of two (Masters £10, Open £15) where only Open paid, through a per-entry reminder: Refund on the
// still-pending Masters row sent £10 back off the PaymentIntent that paid OPEN, because `refundRegistration` read the CART's
// `payment_intent_id` (set by the sibling's payment) and bounded the refund by the entry's fee, not by money it had paid.
//
// The rule under test: a refund moves only money THIS entry paid, on the payment that paid it (`registrations.payment_intent_id`,
// V387, read as `entry_payment_intent_id`), never the cart's. An entry with no payment of its own refuses 422 before any Stripe
// call. The same rule binds the reject-a-paid-entry refund (`rejectRegistration`), which read the cart's intent too.
//
// Every payment below lands through the REAL webhook core (`handleRegistrationCheckoutCompleted`) with a session naming exactly
// the entries it paid, so the expected intent is the one the paying session carried - never a value read back from the code
// under test. Only the network seams are replaced (Stripe, the outbox transport).
//
// Sport: not applicable - refunds do not vary by sport (the money path never reads the sport).
// Real Postgres required; skipped without DATABASE_URL (matches every sibling usecase suite in this directory).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const stripeMock = vi.hoisted(() => {
  const refundCreate = vi.fn();
  return { refundCreate, stripe: { refunds: { create: refundCreate } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));
// The refund ROUTE is driven too (the organiser's panel calls it): a signed-in owner, as approval-routes.test.ts signs one in.
const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { handleRegistrationCheckoutCompleted, putRegistrationSettings, refundRegistration } from "../registrations";
import { rejectRegistration } from "../registration-approval";
import { SETTINGS_BASE, fakeSession, loadWithGroup, seedRegistration, seedSecondEntry, stripeRig } from "./_registration-fixtures";
import { POST as refundRoute } from "@/app/api/v1/registrations/[id]/refund/route";

const HAS_DB = !!process.env.DATABASE_URL;

beforeEach(() => {
  let n = 0;
  stripeMock.refundCreate.mockReset().mockImplementation(async () => ({ id: `re_w8_${++n}_${Date.now()}` }));
  deliverMock.mockReset().mockResolvedValue({ ok: true, providerId: "w8" });
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function rejection(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

/** A session that paid exactly `regIds`, carrying its own intent (the producer's input, so the test's expected intent). */
function paidSession(regIds: string[], amount: number, tag: string): Stripe.Checkout.Session {
  const s = fakeSession(regIds, amount);
  (s as unknown as { id: string }).id = `cs_test_w8_${tag}_${regIds[0]!.slice(0, 8)}`;
  (s as unknown as { payment_intent: string }).payment_intent = `pi_test_w8_${tag}_${regIds[0]!.slice(0, 8)}`;
  return s;
}

/** The walkthrough's cart: Open £15 and Masters £10 in one cart, both pending card entries. */
async function twoEntryCart(approval: "auto" | "manual" = "auto") {
  const rig = await stripeRig({ feeCents: 1500 });
  if (approval === "manual") {
    await putRegistrationSettings(rig.owner, rig.division.id, { ...SETTINGS_BASE, payment_method: "stripe", fee_cents: 1500, approval });
  }
  const open = await seedRegistration(rig.competition.id, rig.division.id, rig.settings, { displayName: "Open Singles", amountCents: 1500 });
  const masters = await seedSecondEntry(open.registration.group_id, rig.division.id, 1000, "Masters Singles");
  return { rig, open: open.registration, masters };
}

describe.skipIf(!HAS_DB)("an organiser refund moves only the entry's own payment (W8)", () => {
  it("an entry nothing has paid (no intent anywhere) → 422, zero refunds.create (empty case first)", async () => {
    const { rig, masters } = await twoEntryCart();
    const err = await rejection(refundRegistration(rig.owner, masters.id, undefined));
    expect(err.status).toBe(422);
    expect(stripeMock.refundCreate).not.toHaveBeenCalled();
  });

  it("the sibling paid on its own session: Refund on the UNPAID entry → 422 and no Stripe call; Refund on the paid one → its own share on its own intent", async () => {
    const { rig, open, masters } = await twoEntryCart();
    const paid = paidSession([open.id], 1500, "open");
    await handleRegistrationCheckoutCompleted(paid);
    const before = await loadWithGroup(masters.id);
    expect(before.status, "premise: the unpaid entry is still pending").toBe("pending");
    expect(before.payment_intent_id, "premise: the CART carries the sibling's intent (the s08b shape)").toBe(paid.payment_intent);
    expect(before.entry_payment_intent_id, "premise: the unpaid entry has no payment of its own").toBeNull();

    const err = await rejection(refundRegistration(rig.owner, masters.id, undefined));
    expect(err.status).toBe(422);
    expect(stripeMock.refundCreate).not.toHaveBeenCalled();
    const mastersAfter = await loadWithGroup(masters.id);
    expect(mastersAfter.refunded_cents).toBe(0);
    expect(mastersAfter.group_refunded_cents, "the cart books no refund either").toBe(0);

    // A partial amount on the unpaid entry is refused the same way: there is no payment to take a share of.
    const partial = await rejection(refundRegistration(rig.owner, masters.id, 500));
    expect(partial.status).toBe(422);
    expect(stripeMock.refundCreate).not.toHaveBeenCalled();

    // The positive pair: the entry that paid refunds its own share, on the intent that paid it.
    const openAfter = await refundRegistration(rig.owner, open.id, undefined);
    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.refundCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: paid.payment_intent, amount: 1500 }));
    expect(openAfter.refunded_cents).toBe(1500);
    const mastersFinal = await loadWithGroup(masters.id);
    expect(mastersFinal.status, "the unpaid sibling is untouched").toBe("pending");
    expect(mastersFinal.refunded_cents).toBe(0);
  });

  it("the refund ROUTE answers the unpaid sibling 422 with no Stripe call, and the paid entry 200 with its own share", async () => {
    const { rig, open, masters } = await twoEntryCart();
    const paid = paidSession([open.id], 1500, "route");
    await handleRegistrationCheckoutCompleted(paid);
    authState.userId = rig.ownerId;
    const post = (id: string) =>
      refundRoute(
        new Request(`https://test.local/api/v1/registrations/${id}/refund`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
        { params: Promise.resolve({ id }) },
      );

    const refused = await post(masters.id);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { ok: boolean }).ok).toBe(false);
    expect(stripeMock.refundCreate).not.toHaveBeenCalled();

    const accepted = await post(open.id);
    expect(accepted.status).toBe(200);
    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.refundCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: paid.payment_intent, amount: 1500 }));
  });

  it("a second Refund on the paid entry after the first → 422 'already fully refunded', no second Stripe call (sequence)", async () => {
    const { rig, open } = await twoEntryCart();
    await handleRegistrationCheckoutCompleted(paidSession([open.id], 1500, "seq"));
    await refundRegistration(rig.owner, open.id, undefined);
    const err = await rejection(refundRegistration(rig.owner, open.id, undefined));
    expect(err.status).toBe(422);
    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
  });

  it("each entry paid on its own session: refunding the EARLIER one uses its own intent, never the cart's newest", async () => {
    const { rig, open, masters } = await twoEntryCart();
    const first = paidSession([open.id], 1500, "first");
    const second = paidSession([masters.id], 1000, "second");
    await handleRegistrationCheckoutCompleted(first);
    await handleRegistrationCheckoutCompleted(second);
    expect((await loadWithGroup(open.id)).payment_intent_id, "premise: the cart's intent is the newest payment").toBe(second.payment_intent);

    await refundRegistration(rig.owner, open.id, undefined);

    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.refundCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: first.payment_intent, amount: 1500 }));
  });

  it("rejecting a paid entry refunds it on its own intent, never the cart's newest (the same rule on the reject path)", async () => {
    const { rig, open, masters } = await twoEntryCart("manual");
    const first = paidSession([open.id], 1500, "rjfirst");
    const second = paidSession([masters.id], 1000, "rjsecond");
    await handleRegistrationCheckoutCompleted(first);
    await handleRegistrationCheckoutCompleted(second);
    expect((await loadWithGroup(open.id)).status, "premise: manual approval leaves the paid entry awaiting a decision").toBe("paid");
    expect((await loadWithGroup(open.id)).payment_intent_id, "premise: the cart's intent is the newest payment").toBe(second.payment_intent);

    await rejectRegistration(rig.owner, open.id);

    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.refundCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: first.payment_intent, amount: 1500 }));
    expect((await loadWithGroup(masters.id)).refunded_cents, "the sibling's payment is untouched").toBe(0);
  });
});
