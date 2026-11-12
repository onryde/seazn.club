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

import { HttpError } from "@/lib/errors";
import { sql } from "@/lib/db";
import {
  handleRegistrationCheckoutCompleted,
  putRegistrationSettings,
  refundRegistration,
  withdrawRegistrationOrganiser,
} from "../registrations";
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
    expect(stripeMock.refundCreate.mock.calls.at(-1)![0]).toMatchObject({ payment_intent: paid.payment_intent, amount: 1500 });
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
    expect(stripeMock.refundCreate.mock.calls.at(-1)![0]).toMatchObject({ payment_intent: paid.payment_intent, amount: 1500 });
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
    expect(stripeMock.refundCreate.mock.calls.at(-1)![0]).toMatchObject({ payment_intent: first.payment_intent, amount: 1500 });
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
    expect(stripeMock.refundCreate.mock.calls.at(-1)![0]).toMatchObject({ payment_intent: first.payment_intent, amount: 1500 });
    expect((await loadWithGroup(masters.id)).refunded_cents, "the sibling's payment is untouched").toBe(0);
  });
});

// Polish wave P5, P1-review carry (c): two organiser refunds of one entry at once both read the same cap before either booked its
// refund, so both passed and both moved money; and the Stripe call carried no idempotency key, so a retry of a refund whose
// booking failed could send the money twice. Rule under test (owner-approved rec): the entry row is locked `for update` around
// read-cap -> Stripe -> book, and the Stripe call carries a key derived from (entry, refunded amount read under the lock, amount).
describe.skipIf(!HAS_DB)("concurrent organiser refunds serialise on the entry (P5 carry c)", () => {
  async function paidEntry() {
    const { rig, open } = await twoEntryCart();
    const paid = paidSession([open.id], 1500, "conc");
    await handleRegistrationCheckoutCompleted(paid);
    return { rig, open, paid };
  }

  it("two concurrent full refunds → ONE Stripe refund, the other refused 422; the books hold one refund", async () => {
    const { rig, open, paid } = await paidEntry();
    // Stripe takes a while: without the lock the second call reads the cap while the first is still inside Stripe.
    stripeMock.refundCreate.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { id: `re_conc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` };
    });

    const results = await Promise.allSettled([
      refundRegistration(rig.owner, open.id, undefined),
      refundRegistration(rig.owner, open.id, undefined),
    ]);

    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.refundCreate.mock.calls[0]![0]).toMatchObject({ payment_intent: paid.payment_intent, amount: 1500 });
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(HttpError);
    expect((rejected[0]!.reason as HttpError).status).toBe(422);
    const row = await loadWithGroup(open.id);
    expect(row.refunded_cents).toBe(1500);
    expect(row.group_refunded_cents).toBe(1500);
  });

  it("the Stripe call carries an idempotency key of (entry, refunded read, amount): two legitimate equal partial refunds carry DIFFERENT keys", async () => {
    const { rig, open } = await paidEntry();

    await refundRegistration(rig.owner, open.id, 500);
    await refundRegistration(rig.owner, open.id, 500);

    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(2);
    const keys = stripeMock.refundCreate.mock.calls.map((c) => (c[1] as { idempotencyKey?: string } | undefined)?.idempotencyKey);
    expect(keys[0]).toBe(`registration-refund:${open.id}:0:500`);
    expect(keys[1]).toBe(`registration-refund:${open.id}:500:500`);
    expect((await loadWithGroup(open.id)).refunded_cents).toBe(1000);
  });
});

// Final review m6: the withdrawal and reject refunds read the cap in their status-changing transaction and called Stripe AFTER the
// commit, outside any lock and with no idempotency key, while the manual Refund locks the entry. An organiser pressing Refund during a
// withdrawal's or a rejection's Stripe call read the same untouched cap and refunded the same money again (on a shared-intent cart,
// a sibling's). Rule under test: every refund of an entry's own payment is capped, moved and booked under the entry's lock, with ONE
// key format `registration-refund:<id>:<refunded read>:<amount>`. The race is made deterministic: the FIRST Stripe call (the
// automatic refund) starts the organiser's Refund and then takes 300 ms, so the manual press always lands inside it.
describe.skipIf(!HAS_DB)("an automatic refund and the organiser's Refund share the entry lock and the key (m6)", () => {
  function manualPressDuringFirstStripeCall(owner: Parameters<typeof refundRegistration>[0], regId: string) {
    let press: Promise<unknown> | null = null;
    let n = 0;
    stripeMock.refundCreate.mockImplementation(async () => {
      n += 1;
      if (n === 1) {
        press = refundRegistration(owner, regId, undefined).then(
          (v) => ({ ok: true as const, v }),
          (e: unknown) => ({ ok: false as const, e }),
        );
        await new Promise((r) => setTimeout(r, 300));
      }
      return { id: `re_m6_${n}_${Date.now()}` };
    });
    return { pressed: () => press as Promise<{ ok: true; v: unknown } | { ok: false; e: unknown }> | null };
  }

  const shapes = [
    {
      name: "reject a paid entry",
      approval: "manual" as const,
      act: (rig: Awaited<ReturnType<typeof twoEntryCart>>["rig"], id: string) => rejectRegistration(rig.owner, id),
    },
    {
      name: "withdraw a paid entry before the refund lock",
      approval: "auto" as const,
      act: (rig: Awaited<ReturnType<typeof twoEntryCart>>["rig"], id: string) => withdrawRegistrationOrganiser(rig.owner, id),
    },
  ];

  it("a manual Refund pressed during the automatic refund's Stripe call waits, then refuses: ONE refund, booked once, the shared key", async () => {
    let checked = 0;
    for (const shape of shapes) {
      stripeMock.refundCreate.mockReset();
      const { rig, open, masters } = await twoEntryCart(shape.approval);
      // A refund lock in the future, so the withdrawal refunds automatically (resolveRefundPolicy).
      await sql`update registration_settings set refund_lock_at = now() + interval '30 days' where division_id = ${rig.division.id}`;
      // One session paid BOTH entries: a shared intent, so a double refund of Open would spend Masters' money.
      const paid = paidSession([open.id, masters.id], 2500, `m6${checked}`);
      await handleRegistrationCheckoutCompleted(paid);
      const premise = await loadWithGroup(open.id);
      expect(premise.entry_payment_intent_id, `${shape.name}: premise, Open paid on the shared intent`).toBe(paid.payment_intent);
      expect(premise.status, `${shape.name}: premise`).toBe(shape.approval === "manual" ? "paid" : "confirmed");

      const race = manualPressDuringFirstStripeCall(rig.owner, open.id);
      await shape.act(rig, open.id);
      const press = race.pressed();
      expect(press, `${shape.name}: premise, the organiser pressed Refund during the automatic refund`).not.toBeNull();
      const outcome = await press!;

      expect(stripeMock.refundCreate, `${shape.name}: one refund at Stripe`).toHaveBeenCalledTimes(1);
      const [params, opts] = stripeMock.refundCreate.mock.calls[0]! as [{ payment_intent: string; amount: number }, { idempotencyKey?: string }];
      expect(params).toMatchObject({ payment_intent: paid.payment_intent, amount: 1500 });
      expect(opts?.idempotencyKey, `${shape.name}: the shared key format`).toBe(`registration-refund:${open.id}:0:1500`);
      expect(outcome.ok, `${shape.name}: the manual press is refused`).toBe(false);
      expect((outcome as { e: unknown }).e).toBeInstanceOf(HttpError);
      expect(((outcome as { e: HttpError }).e).status).toBe(422);
      const after = await loadWithGroup(open.id);
      expect(after.refunded_cents, `${shape.name}: booked once`).toBe(1500);
      expect(after.group_refunded_cents, `${shape.name}: the cart booked once`).toBe(1500);
      expect((await loadWithGroup(masters.id)).refunded_cents, `${shape.name}: the sibling's share is untouched`).toBe(0);
      checked += 1;
    }
    expect(checked, "anti-vacuity: both automatic refund paths").toBe(shapes.length);
  });
});

// Final review m1: Stripe keeps the first answer to an idempotency key for 24 hours, errors included. A refund Stripe refused (e.g. a
// drained connected account) was retried after the cause was fixed with the SAME key and got the refusal replayed. Rule under test: a
// failure Stripe ANSWERED is recorded (`registration.refund_failed`, `stripe_answered`) and the next attempt carries a new key; a call
// that got no answer (a connection error: the refund may have gone through) keeps the key, so the retry is a replay.
describe.skipIf(!HAS_DB)("a retry after a refused refund carries a new key; after an unanswered call the same key (m1)", () => {
  async function paidEntry(tag: string) {
    const { rig, open } = await twoEntryCart();
    await handleRegistrationCheckoutCompleted(paidSession([open.id], 1500, tag));
    return { rig, open };
  }
  const keyOf = (i: number) => (stripeMock.refundCreate.mock.calls[i]![1] as { idempotencyKey?: string } | undefined)?.idempotencyKey;

  it("Stripe answered an error: the press fails and books nothing; the retry carries a NEW key and refunds; a third refund replays nothing old", async () => {
    const { rig, open } = await paidEntry("m1a");
    stripeMock.refundCreate.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Insufficient funds in the connected account"), { statusCode: 400, type: "StripeInvalidRequestError" });
    });
    await expect(refundRegistration(rig.owner, open.id, undefined)).rejects.toThrow("Insufficient funds");
    expect((await loadWithGroup(open.id)).refunded_cents, "nothing booked").toBe(0);

    const after = await refundRegistration(rig.owner, open.id, undefined);
    expect(after.refunded_cents).toBe(1500);
    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(2);
    expect(keyOf(0)).toBe(`registration-refund:${open.id}:0:1500`);
    expect(keyOf(1), "a new key, not the refusal replayed").toBe(`registration-refund:${open.id}:0:1500:f1`);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from competition_events
       where type = 'registration.refund_failed' and payload->>'registration_id' = ${open.id} and payload->>'stripe_answered' = 'true'`;
    expect(n, "the answered failure is on the record").toBe(1);
  });

  it("the positive pair: a call that got NO answer (a connection error) keeps the key, so the retry is a replay at Stripe", async () => {
    const { rig, open } = await paidEntry("m1b");
    stripeMock.refundCreate.mockImplementationOnce(async () => {
      throw Object.assign(new Error("connection reset"), { type: "StripeConnectionError" });
    });
    await expect(refundRegistration(rig.owner, open.id, undefined)).rejects.toThrow("connection reset");
    await refundRegistration(rig.owner, open.id, undefined);
    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(2);
    expect(keyOf(1), "same key: if the first went through, Stripe replays it").toBe(keyOf(0));
    expect(keyOf(0)).toBe(`registration-refund:${open.id}:0:1500`);
  });

  it("an automatic refund Stripe refused records the answered failure too, so the organiser's later Refund is a new key", async () => {
    const { rig, open } = await twoEntryCart("manual");
    await handleRegistrationCheckoutCompleted(paidSession([open.id], 1500, "m1c"));
    stripeMock.refundCreate.mockImplementationOnce(async () => {
      throw Object.assign(new Error("account restricted"), { statusCode: 400 });
    });
    await rejectRegistration(rig.owner, open.id);
    expect((await loadWithGroup(open.id)).refunded_cents, "the reject stands, nothing booked").toBe(0);
    await refundRegistration(rig.owner, open.id, undefined);
    expect(keyOf(0)).toBe(`registration-refund:${open.id}:0:1500`);
    expect(keyOf(1)).toBe(`registration-refund:${open.id}:0:1500:f1`);
  });
});
