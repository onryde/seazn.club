// Player payment page, Task 3 (plan 2026-11-11-player-payment-page): Pay from `/r/pay/<token>`. `payFromPayPage` reuses the entry's
// own open session (`registrations.pay_session_id`) while more than PAY_SESSION_REUSE_MARGIN_MS of it is left and it covers
// exactly this entry, else expires it and mints a new one for this entry alone, returning to the page; and
// `reconcileRegistrationByPaySession` confirms on return. The money invariant under test: two Pay presses never leave two payable
// sessions for one entry, and a paid entry always confirms.
//
// Premise check (re-verified against the tree at 34f4e7ee7f before building on it, Task 3 brief "Session plumbing"):
// - `createRegistrationCheckout` expires the group's prior session only on SUBSUMPTION (prior open AND its `registration_ids` all
//   inside the new mint's ids), so a page mint for {A} leaves an open cart session for {A,B} alone (Review Focus 1).
// - the group stamp is conditional (`checkout_session_id is not distinct from` the value read); a loser expires its own session
//   and answers 409 REGISTRATION_CHECKOUT_CONFLICT.
// - every session carries an explicit comma-joined `metadata.registration_ids`; fulfilment confirms exactly the listed entries,
//   and an already-paid entry paid again under a DIFFERENT intent takes `confirmPaidRegistration`'s `kind: "duplicate"` refund.
//
// Stripe is a small in-memory fake (create / retrieve / expire over one session store, refunds.create), mocked the way
// `registration-checkout-supersede.test.ts` mocks it. Tokens come from the REAL producer (`issuePayLink` + `recordPayToken` with
// the entry's own org), never a hand-inserted hash.
//
// E2E / smoke: no route yet. Traced forward to T7's card golden path (Pay → Stripe → back → Paid) and the smoke
// "Pay on a paid entry 409" (moved to T5 by the ledger ruling: the first task where a producer issues a token).
//
// Real Postgres required; skipped without DATABASE_URL (matches every sibling usecase suite in this directory).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

interface FakeSession {
  id: string;
  object: "checkout.session";
  status: "open" | "complete" | "expired";
  payment_status: "unpaid" | "paid";
  payment_intent: string | null;
  /** The PaymentIntent's own status behind a `complete` session (delayed methods: `processing`, then `succeeded` or back to
   *  `requires_payment_method` on failure). Read through `paymentIntents.retrieve`, the way `payFromPayPage` reads it. */
  pi_status?: string;
  url: string | null;
  expires_at: number;
  metadata: Record<string, string>;
}

const stripeMock = vi.hoisted(() => {
  const store = new Map<string, FakeSession>();
  /** When > 0, each `create` waits until this many creates have arrived (a barrier for the concurrency case). */
  const barrier = { want: 0, waiting: [] as (() => void)[] };
  return {
    store,
    barrier,
    checkoutCreate: vi.fn(),
    checkoutRetrieve: vi.fn(),
    checkoutExpire: vi.fn(),
    refundCreate: vi.fn(),
    paymentIntentRetrieve: vi.fn(),
  };
});
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        create: stripeMock.checkoutCreate,
        retrieve: stripeMock.checkoutRetrieve,
        expire: stripeMock.checkoutExpire,
      },
    },
    refunds: { create: stripeMock.refundCreate },
    paymentIntents: { retrieve: stripeMock.paymentIntentRetrieve },
  }),
}));

// One seam for the stale-read race: the next `payPageDocByToken` call answers a document read EARLIER (a second press whose
// read happened before the first press stamped). Inert (`null`) for every other case.
const docOverride = vi.hoisted(() => ({ next: null as unknown }));
vi.mock("@/server/usecases/registrations/pay-page", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/registrations/pay-page")>();
  return {
    ...actual,
    payPageDocByToken: async (token: string, now: Date) => {
      const stale = docOverride.next as Awaited<ReturnType<typeof actual.payPageDocByToken>> | null;
      if (stale) {
        docOverride.next = null;
        return stale;
      }
      return actual.payPageDocByToken(token, now);
    },
  };
});

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { isPayConfirming } from "@/lib/registration-pay";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import {
  issuePayLink,
  recordPayToken,
  payPageDocByToken,
  PAY_PAGE_STATES,
  type PayPageState,
  mintGroupCheckout,
  handleRegistrationCheckoutCompleted,
  handleRegistrationCheckoutAsyncPaymentFailed,
  markRegistrationPaidOffline,
  putRegistrationSettings,
  payFromPayPage,
  reconcileRegistrationByPaySession,
  resumeRegistrationCheckout,
  PAY_SESSION_REUSE_MARGIN_MS,
} from "../registrations";
import { createRegistrationCheckout } from "../registrations/checkout";
import { divisionCtx } from "../registrations/lookups";
import {
  stripeRig,
  seedRegistration,
  seedSecondEntry,
  loadWithGroup,
  SETTINGS_BASE,
  type StripeRigResult,
} from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const ORIGIN = "https://pay.test";

beforeEach(() => {
  stripeMock.store.clear();
  stripeMock.barrier.want = 0;
  stripeMock.barrier.waiting = [];
  docOverride.next = null;
  let n = 0;
  stripeMock.checkoutCreate.mockReset().mockImplementation(async (params: Stripe.Checkout.SessionCreateParams) => {
    const id = `cs_test_pp3_${++n}_${randomUUID().slice(0, 6)}`;
    const s: FakeSession = {
      id,
      object: "checkout.session",
      status: "open",
      payment_status: "unpaid",
      payment_intent: null,
      url: `https://checkout.stripe.test/${id}`,
      expires_at: Math.floor(Date.now() / 1000) + 24 * 3600,
      metadata: { ...(params.metadata as Record<string, string>) },
    };
    stripeMock.store.set(id, s);
    const b = stripeMock.barrier;
    if (b.want > 0) {
      await new Promise<void>((resolve) => {
        b.waiting.push(resolve);
        if (b.waiting.length >= b.want) for (const r of b.waiting) r();
      });
    }
    return { ...s };
  });
  stripeMock.checkoutRetrieve.mockReset().mockImplementation(async (id: string) => {
    const s = stripeMock.store.get(id);
    if (!s) throw Object.assign(new Error(`No such checkout.session: ${id}`), { code: "resource_missing" });
    return { ...s };
  });
  stripeMock.checkoutExpire.mockReset().mockImplementation(async (id: string) => {
    const s = stripeMock.store.get(id);
    if (!s || s.status !== "open") throw new Error(`session ${id} is not open`);
    s.status = "expired";
    return { ...s };
  });
  stripeMock.refundCreate.mockReset().mockImplementation(async () => ({ id: "re_test_" + randomUUID().slice(0, 8) }));
  stripeMock.paymentIntentRetrieve.mockReset().mockImplementation(async (id: string) => {
    const s = [...stripeMock.store.values()].find((x) => x.payment_intent === id);
    if (!s?.pi_status) throw Object.assign(new Error(`No such payment_intent: ${id}`), { code: "resource_missing" });
    return { id, object: "payment_intent", status: s.pi_status };
  });
});

afterEach(() => {
  __setRateLimitCounterForTests(null);
});

/** A link exactly as a producer mints it; returns the raw token (the url's last path segment). */
async function linkFor(reg: { id: string; org_id: string }): Promise<string> {
  const { url, tokenHash } = issuePayLink(ORIGIN);
  await recordPayToken(sql, { tokenHash, registrationId: reg.id, orgId: reg.org_id });
  const token = new URL(url).pathname.split("/").pop();
  if (!token) throw new Error(`no token in ${url}`);
  return token;
}

async function cardEntry(over: Parameters<typeof seedRegistration>[3] = {}, rig?: StripeRigResult) {
  const r = rig ?? (await stripeRig({ feeCents: 1500 }));
  const seeded = await seedRegistration(r.competition.id, r.division.id, r.settings, over);
  return { rig: r, reg: seeded.registration, accessToken: seeded.access_token };
}

async function payPointer(regId: string): Promise<string | null> {
  const [row] = await sql<{ pay_session_id: string | null }[]>`select pay_session_id from registrations where id = ${regId}`;
  return row!.pay_session_id;
}

/** Sessions Stripe still holds open (payable) whose `registration_ids` name `regId`. */
function payableFor(regId: string): string[] {
  return [...stripeMock.store.values()]
    .filter((s) => s.status === "open" && (s.metadata.registration_ids ?? "").split(",").includes(regId))
    .map((s) => s.id);
}

async function rejection(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

/** A delayed-method (SEPA/Bacs) completion: Stripe marks the session `complete` with `payment_status: "unpaid"` while the
 *  PaymentIntent is `processing`; a later failure leaves the session exactly so and moves the intent back to
 *  `requires_payment_method` (Stripe: "Checkout Session object", payment_status; "Payment Intents", status lifecycle). */
function completeDelayed(id: string, piStatus: Stripe.PaymentIntent.Status): Stripe.Checkout.Session {
  const s = stripeMock.store.get(id)!;
  s.status = "complete";
  s.payment_status = "unpaid";
  s.payment_intent = "pi_test_d" + id.slice(-6) + randomUUID().slice(0, 4);
  s.pi_status = piStatus;
  return { ...s } as unknown as Stripe.Checkout.Session;
}

function createdParams(i: number): Stripe.Checkout.SessionCreateParams {
  return stripeMock.checkoutCreate.mock.calls[i]![0] as Stripe.Checkout.SessionCreateParams;
}

/** Marks a fake session paid (Stripe's `complete` + `paid`), the shape the webhook / return read. */
function payInStripe(id: string): Stripe.Checkout.Session {
  const s = stripeMock.store.get(id)!;
  s.status = "complete";
  s.payment_status = "paid";
  s.payment_intent = "pi_test_" + id.slice(-6) + randomUUID().slice(0, 4);
  return { ...s } as unknown as Stripe.Checkout.Session;
}

// A `complete` + `unpaid` session is dead ONLY when its PaymentIntent cannot collect any more: back at
// `requires_payment_method` after a failed debit, or `canceled`. Every other status can still land money - `requires_action`
// is a voucher / bank-transfer method (customer_balance, OXXO, Boleto, Konbini) waiting for the customer to pay, and
// `succeeded` can precede the session's own `payment_status` flip - so minting a second session beside it risks a double charge.
// Typed as a Record over Stripe's own status union, so a status Stripe adds fails tsc until it is classified here.
const PI_STATUS_STILL_PAYS: Record<Stripe.PaymentIntent.Status, boolean> = {
  requires_payment_method: false,
  canceled: false,
  processing: true,
  requires_action: true,
  requires_confirmation: true,
  requires_capture: true,
  succeeded: true,
};
const STILL_PAYS = Object.entries(PI_STATUS_STILL_PAYS).filter(([, live]) => live).map(([st]) => st as Stripe.PaymentIntent.Status);
const DEAD = Object.entries(PI_STATUS_STILL_PAYS).filter(([, live]) => !live).map(([st]) => st as Stripe.PaymentIntent.Status);

describe.skipIf(!HAS_DB)("payFromPayPage (player payment page, Task 3)", () => {
  it("unknown token → 404, zero sessions.create (empty case first)", async () => {
    const err = await rejection(payFromPayPage("x".repeat(43), ORIGIN));
    expect(err.status).toBe(404);
    const empty = await rejection(payFromPayPage("", ORIGIN));
    expect(empty.status).toBe(404);
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
    expect(stripeMock.checkoutRetrieve).not.toHaveBeenCalled();
  });

  it("the margin is 10 minutes (the sponsor rule's value)", () => {
    expect(PAY_SESSION_REUSE_MARGIN_MS).toBe(10 * 60_000);
  });

  it("two Pay presses → one sessions.create, same URL", async () => {
    const { reg } = await cardEntry();
    const token = await linkFor(reg);

    const first = await payFromPayPage(token, ORIGIN);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
    const s1 = await payPointer(reg.id);
    expect(s1).not.toBeNull();
    expect(first).toBe(stripeMock.store.get(s1!)!.url);
    expect(createdParams(0).metadata?.registration_ids).toBe(reg.id);

    const now = new Date();
    stripeMock.store.get(s1!)!.expires_at = Math.floor(now.getTime() / 1000) + 23 * 3600; // 23 h left
    const second = await payFromPayPage(token, ORIGIN, now);

    expect(second).toBe(first);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.checkoutRetrieve).toHaveBeenCalledWith(s1);
    expect(stripeMock.checkoutExpire).not.toHaveBeenCalled();
    expect(payableFor(reg.id)).toEqual([s1]);
  });

  it.each([
    { left: 9, reused: false },
    { left: 11, reused: true },
  ])("stored session with $left minutes left → reused: $reused (boundary pair around the margin)", async ({ left, reused }) => {
    const { reg } = await cardEntry();
    const token = await linkFor(reg);
    await payFromPayPage(token, ORIGIN);
    const s1 = (await payPointer(reg.id))!;
    const now = new Date();
    stripeMock.store.get(s1)!.expires_at = Math.floor(now.getTime() / 1000) + left * 60;

    const url = await payFromPayPage(token, ORIGIN, now);

    if (reused) {
      expect(url).toBe(stripeMock.store.get(s1)!.url);
      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
      expect(stripeMock.checkoutExpire).not.toHaveBeenCalled();
      expect(await payPointer(reg.id)).toBe(s1);
    } else {
      expect(stripeMock.checkoutExpire).toHaveBeenCalledWith(s1);
      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
      const s2 = await payPointer(reg.id);
      expect(s2).not.toBe(s1);
      expect(url).toBe(stripeMock.store.get(s2!)!.url);
      expect(stripeMock.store.get(s1)!.status).toBe("expired");
    }
    expect(payableFor(reg.id)).toHaveLength(1);
  });

  it("a stored session covering [A,B] is not reused for A → a new create for [A] only", async () => {
    const { rig, reg: a, accessToken } = await cardEntry();
    const b = await seedSecondEntry(a.group_id, rig.division.id, 1500, "Entry B");
    await mintGroupCheckout(a.group_id, rig.division.id, ORIGIN, accessToken);
    const sAB = (await loadWithGroup(a.id)).checkout_session_id!;
    expect(stripeMock.store.get(sAB)!.metadata.registration_ids.split(",").sort()).toEqual([a.id, b.id].sort());
    // The input this guard exists for: an entry pointer naming a multi-entry session (hand-set; no producer stamps one).
    await sql`update registrations set pay_session_id = ${sAB} where id = ${a.id}`;
    const token = await linkFor(a);

    const url = await payFromPayPage(token, ORIGIN);

    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
    expect(createdParams(1).metadata?.registration_ids).toBe(a.id);
    const sA = await payPointer(a.id);
    expect(sA).not.toBe(sAB);
    expect(url).toBe(stripeMock.store.get(sA!)!.url);
    expect(url).not.toBe(stripeMock.store.get(sAB)!.url);
  });

  // The non-`pay` states, one row each, every one reached through a real entry and its real document.
  const nonPayRows: { state: Exclude<PayPageState, "pay">; seed: (r: StripeRigResult) => Promise<{ id: string; org_id: string }> }[] = [
    {
      state: "paid",
      seed: async (r) => (await seedRegistration(r.competition.id, r.division.id, r.settings, { status: "confirmed" })).registration,
    },
    {
      state: "refunded",
      seed: async (r) => {
        const reg = (await seedRegistration(r.competition.id, r.division.id, r.settings, { status: "confirmed" })).registration;
        await sql`update registrations set refunded_cents = 500 where id = ${reg.id}`;
        return reg;
      },
    },
    {
      state: "offline",
      seed: async (r) => {
        const reg = (await seedRegistration(r.competition.id, r.division.id, r.settings)).registration;
        await putRegistrationSettings(r.owner, r.division.id, { ...SETTINGS_BASE, payment_method: "offline", fee_cents: 1500 });
        return reg;
      },
    },
    {
      // Review Focus 2, the case where the deadline differs from expires_at: a promoted entry's own window passed while the
      // cart's is still open, and the hourly sweep has not expired the row.
      state: "deadline_passed",
      seed: async (r) => {
        const reg = (await seedRegistration(r.competition.id, r.division.id, r.settings)).registration;
        await sql`update registration_groups set expires_at = now() + interval '1 day' where id = ${reg.group_id}`;
        await sql`update registrations set promoted_at = now() - interval '3 hours',
                  promotion_expires_at = now() - interval '1 minute' where id = ${reg.id}`;
        return reg;
      },
    },
    {
      state: "waitlisted",
      seed: async (r) => (await seedRegistration(r.competition.id, r.division.id, r.settings, { status: "waitlisted" })).registration,
    },
  ];
  const refusedStates = new Set<PayPageState>();

  it.each(nonPayRows)("state $state → 409 REGISTRATION_NOT_PAYABLE, zero create", async ({ state, seed }) => {
    const r = await stripeRig({ feeCents: 1500 });
    const reg = await seed(r);
    const token = await linkFor(reg);
    expect((await payPageDocByToken(token, new Date()))?.state).toBe(state); // the row really is in the state it names

    const err = await rejection(payFromPayPage(token, ORIGIN));
    expect(err.status).toBe(409);
    expect(err.code).toBe("REGISTRATION_NOT_PAYABLE");
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
    expect(stripeMock.checkoutRetrieve).not.toHaveBeenCalled();
    refusedStates.add(state);
  });

  it("the refusal sweep covered every non-pay state (counted; zero is a failure)", () => {
    expect(nonPayRows.length).toBe(PAY_PAGE_STATES.length - 1);
    expect(refusedStates.size).toBe(PAY_PAGE_STATES.length - 1);
    expect([...refusedStates].sort()).toEqual(PAY_PAGE_STATES.filter((s) => s !== "pay").sort());
  });

  it("marked paid offline after the page loaded → 409, zero create (Review Focus 3)", async () => {
    const { rig, reg } = await cardEntry();
    const token = await linkFor(reg);
    expect((await payPageDocByToken(token, new Date()))?.state).toBe("pay"); // the page the player has open
    await markRegistrationPaidOffline(rig.owner, reg.id);

    const err = await rejection(payFromPayPage(token, ORIGIN));
    expect(err.status).toBe(409);
    expect(err.code).toBe("REGISTRATION_NOT_PAYABLE");
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("stored session complete (webhook not landed) → 409 REGISTRATION_PAID_ONLINE, zero create", async () => {
    const { reg } = await cardEntry();
    const token = await linkFor(reg);
    await payFromPayPage(token, ORIGIN);
    const s1 = (await payPointer(reg.id))!;
    payInStripe(s1); // paid in Stripe; the entry is still `pending` here

    const err = await rejection(payFromPayPage(token, ORIGIN));
    expect(err.status).toBe(409);
    expect(err.code).toBe("REGISTRATION_PAID_ONLINE");
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1); // the first press only
    expect(stripeMock.checkoutExpire).not.toHaveBeenCalled();
  });

  it("stored session complete + paid → 409 PAID_ONLINE, no intent read, zero create (final review, item 1)", async () => {
    const { reg } = await cardEntry();
    const token = await linkFor(reg);
    await payFromPayPage(token, ORIGIN);
    const s1 = (await payPointer(reg.id))!;
    payInStripe(s1);

    const err = await rejection(payFromPayPage(token, ORIGIN));
    expect(err.code).toBe("REGISTRATION_PAID_ONLINE");
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.paymentIntentRetrieve).not.toHaveBeenCalled();
    expect(await payPointer(reg.id)).toBe(s1);
  });

  it("stored session complete + delayed payment still processing → 409 PAID_ONLINE (recording), no mint (final review, item 1)", async () => {
    const { reg } = await cardEntry();
    const token = await linkFor(reg);
    await payFromPayPage(token, ORIGIN);
    const s1 = (await payPointer(reg.id))!;
    completeDelayed(s1, "processing");

    const err = await rejection(payFromPayPage(token, ORIGIN));
    expect(err.status).toBe(409);
    expect(err.code).toBe("REGISTRATION_PAID_ONLINE");
    expect(stripeMock.paymentIntentRetrieve).toHaveBeenCalledTimes(1);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1); // the first press only
    expect(stripeMock.checkoutExpire).not.toHaveBeenCalled();
    expect(await payPointer(reg.id)).toBe(s1);
  });

  it("stored session complete + delayed payment FAILED (webhook not landed) → a fresh session, pointer moved, never 'recording' (final review, item 1)", async () => {
    const { reg } = await cardEntry();
    const token = await linkFor(reg);
    await payFromPayPage(token, ORIGIN);
    const s1 = (await payPointer(reg.id))!;
    completeDelayed(s1, "requires_payment_method");

    const url = await payFromPayPage(token, ORIGIN);

    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
    const s2 = (await payPointer(reg.id))!;
    expect(s2).not.toBe(s1);
    expect(url).toBe(stripeMock.store.get(s2)!.url);
    expect(stripeMock.checkoutExpire).not.toHaveBeenCalled(); // a complete session cannot be expired
    expect(payableFor(reg.id)).toEqual([s2]);
  });


  it("the status table classifies both sides (anti-vacuity: a sweep over zero statuses proves nothing)", () => {
    expect(STILL_PAYS.length).toBeGreaterThanOrEqual(5);
    expect(DEAD).toEqual(expect.arrayContaining(["requires_payment_method", "canceled"]));
    expect(DEAD).toHaveLength(2);
  });

  it.each(STILL_PAYS)(
    "stored session complete + unpaid, PaymentIntent %s → 409 PAID_ONLINE, no mint, pointer kept (money can still arrive)",
    async (piStatus) => {
      const { reg } = await cardEntry();
      const token = await linkFor(reg);
      await payFromPayPage(token, ORIGIN);
      const s1 = (await payPointer(reg.id))!;
      completeDelayed(s1, piStatus);

      const err = await rejection(payFromPayPage(token, ORIGIN));
      expect(err.status).toBe(409);
      expect(err.code).toBe("REGISTRATION_PAID_ONLINE");
      expect(stripeMock.paymentIntentRetrieve).toHaveBeenCalledTimes(1);
      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1); // the first press only
      expect(stripeMock.checkoutExpire).not.toHaveBeenCalled();
      expect(await payPointer(reg.id)).toBe(s1);
    },
  );

  it.each(DEAD)(
    "stored session complete + unpaid, PaymentIntent %s → a fresh session, pointer moved (nothing can still pay)",
    async (piStatus) => {
      const { reg } = await cardEntry();
      const token = await linkFor(reg);
      await payFromPayPage(token, ORIGIN);
      const s1 = (await payPointer(reg.id))!;
      completeDelayed(s1, piStatus);

      const url = await payFromPayPage(token, ORIGIN);

      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
      const s2 = (await payPointer(reg.id))!;
      expect(s2).not.toBe(s1);
      expect(url).toBe(stripeMock.store.get(s2)!.url);
      expect(payableFor(reg.id)).toEqual([s2]);
    },
  );

  it("stored session complete + unpaid with NO PaymentIntent at all → a fresh session (nothing to collect), no intent read", async () => {
    const { reg } = await cardEntry();
    const token = await linkFor(reg);
    await payFromPayPage(token, ORIGIN);
    const s1 = (await payPointer(reg.id))!;
    const stored = stripeMock.store.get(s1)!;
    stored.status = "complete"; // payment_status stays "unpaid", payment_intent stays null

    await payFromPayPage(token, ORIGIN);

    expect(stripeMock.paymentIntentRetrieve).not.toHaveBeenCalled();
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
    expect(await payPointer(reg.id)).not.toBe(s1);
  });

  it("an intent read failure on a complete + unpaid session refuses 502, zero create (never mint beside a session that may still pay)", async () => {
    const { reg } = await cardEntry();
    const token = await linkFor(reg);
    await payFromPayPage(token, ORIGIN);
    const s1 = (await payPointer(reg.id))!;
    completeDelayed(s1, "processing");
    stripeMock.paymentIntentRetrieve.mockRejectedValueOnce(new Error("stripe down"));

    const err = await rejection(payFromPayPage(token, ORIGIN));
    expect(err.status).toBe(502);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
  });

  it("the async_payment_failed webhook clears the entry's pointer to that session (only that one): the old success return no longer reads as confirming, and Pay mints", async () => {
    const { reg } = await cardEntry();
    const token = await linkFor(reg);
    await payFromPayPage(token, ORIGIN);
    const s1 = (await payPointer(reg.id))!;
    const failed = completeDelayed(s1, "requires_payment_method");
    const ret = { checkout: "success", session_id: s1 };
    expect(isPayConfirming((await payPageDocByToken(token, new Date()))!, ret)).toBe(true); // processing window

    await handleRegistrationCheckoutAsyncPaymentFailed(failed);

    expect(await payPointer(reg.id)).toBeNull();
    const doc = (await payPageDocByToken(token, new Date()))!;
    expect(doc.state).toBe("pay");
    expect(isPayConfirming(doc, ret)).toBe(false);
    await payFromPayPage(token, ORIGIN);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
    expect(await payPointer(reg.id)).not.toBe(s1);
  });

  it("a stale async_payment_failed for an older session leaves the entry's CURRENT pointer alone", async () => {
    const { reg } = await cardEntry();
    const token = await linkFor(reg);
    await payFromPayPage(token, ORIGIN);
    const s1 = (await payPointer(reg.id))!;
    const failed = completeDelayed(s1, "requires_payment_method");
    await payFromPayPage(token, ORIGIN); // dead session → fresh one
    const s2 = (await payPointer(reg.id))!;
    expect(s2).not.toBe(s1);

    await handleRegistrationCheckoutAsyncPaymentFailed(failed);

    expect(await payPointer(reg.id)).toBe(s2);
  });

  it("charges_enabled false → 503, zero create (Review Focus 5)", async () => {
    const { rig, reg } = await cardEntry();
    const token = await linkFor(reg);
    await sql`update organizations set stripe_charges_enabled = false where id = ${rig.orgId}`;

    const err = await rejection(payFromPayPage(token, ORIGIN));
    expect(err.status).toBe(503);
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("charges_enabled false with a reusable stored session (23 h left) → 503, nothing handed out, zero create (Review Focus 5)", async () => {
    const { rig, reg } = await cardEntry();
    const token = await linkFor(reg);
    await payFromPayPage(token, ORIGIN);
    const s1 = (await payPointer(reg.id))!;
    const now = new Date();
    stripeMock.store.get(s1)!.expires_at = Math.floor(now.getTime() / 1000) + 23 * 3600; // reusable on every other count
    await sql`update organizations set stripe_charges_enabled = false where id = ${rig.orgId}`;
    stripeMock.checkoutRetrieve.mockClear();

    const err = await rejection(payFromPayPage(token, ORIGIN, now));
    expect(err.status).toBe(503);
    expect(stripeMock.checkoutRetrieve).not.toHaveBeenCalled(); // the stored session is never looked at, so never handed out
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1); // the first press only
    expect(stripeMock.checkoutExpire).not.toHaveBeenCalled();
    expect(await payPointer(reg.id)).toBe(s1);
  });

  it("return URLs point at the page", async () => {
    const { reg } = await cardEntry();
    const token = await linkFor(reg);
    await payFromPayPage(token, ORIGIN);

    const p = createdParams(0);
    expect(p.success_url).toBe(`${ORIGIN}/r/pay/${token}?src=pay&checkout=success&session_id={CHECKOUT_SESSION_ID}`);
    expect(p.cancel_url).toBe(`${ORIGIN}/r/pay/${token}?src=pay&checkout=cancelled`);
  });

  it("a returnBase without its query string is refused before any Stripe call", async () => {
    const { reg } = await cardEntry();
    const ctx = await divisionCtx(sql, reg.division_id);
    await expect(
      createRegistrationCheckout(reg.group_id, [reg.id], ctx, ORIGIN, null, { returnBase: `${ORIGIN}/r/pay/abc` }),
    ).rejects.toThrow(/returnBase must already carry its query string/);
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("regression: in-app mints keep their return URLs (no opts)", async () => {
    const { rig, reg, accessToken } = await cardEntry({ refCode: "PQ" + randomUUID().slice(0, 4).toUpperCase() });
    await mintGroupCheckout(reg.group_id, rig.division.id, ORIGIN, accessToken);
    const statusBase =
      `${ORIGIN}/live/${rig.orgSlug}/${rig.competition.slug}/register/status` +
      `?rid=${reg.group_id}&token=${encodeURIComponent(accessToken)}`;
    expect(createdParams(0).success_url).toBe(`${statusBase}&checkout=success&session_id={CHECKOUT_SESSION_ID}`);
    expect(createdParams(0).cancel_url).toBe(`${statusBase}&checkout=cancelled`);

    const ctx = await divisionCtx(sql, reg.division_id);
    await createRegistrationCheckout(reg.group_id, [reg.id], ctx, ORIGIN, null);
    const refBase = `${ORIGIN}/r/${reg.ref_code}?src=email`;
    expect(createdParams(1).success_url).toBe(`${refBase}&checkout=success&session_id={CHECKOUT_SESSION_ID}`);
    expect(createdParams(1).cancel_url).toBe(`${refBase}&checkout=cancelled`);
    expect(await payPointer(reg.id)).toBeNull(); // only the page claims the entry pointer
  });

  it("concurrent Pay presses leave one payable session", async () => {
    const { reg } = await cardEntry();
    const token = await linkFor(reg);
    stripeMock.barrier.want = 2; // both presses mint before either stamps

    const results = await Promise.allSettled([payFromPayPage(token, ORIGIN), payFromPayPage(token, ORIGIN)]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(HttpError);
    expect((lost[0]!.reason as HttpError).status).toBe(409);
    expect((lost[0]!.reason as HttpError).code).toBe("REGISTRATION_CHECKOUT_CONFLICT");

    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
    const stamped = (await payPointer(reg.id))!;
    const created = [...stripeMock.store.keys()];
    expect(created).toContain(stamped);
    const others = created.filter((id) => id !== stamped);
    expect(others).toHaveLength(1);
    for (const id of others) expect(stripeMock.store.get(id)!.status).toBe("expired");
    expect(stripeMock.store.get(stamped)!.status).toBe("open");
    expect((ok[0] as PromiseFulfilledResult<string>).value).toBe(stripeMock.store.get(stamped)!.url);
    expect(payableFor(reg.id)).toEqual([stamped]);
  });

  it("a press that read the page before another press stamped loses cleanly and never expires the winner's session", async () => {
    const { reg } = await cardEntry();
    const token = await linkFor(reg);
    const staleDoc = await payPageDocByToken(token, new Date()); // read before the first press stamps
    expect(staleDoc?.paySessionId).toBeNull();

    const firstUrl = await payFromPayPage(token, ORIGIN);
    const s1 = (await payPointer(reg.id))!;

    docOverride.next = staleDoc; // the second press acts on the earlier read
    const err = await rejection(payFromPayPage(token, ORIGIN));
    expect(err.status).toBe(409);
    expect(err.code).toBe("REGISTRATION_CHECKOUT_CONFLICT");

    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
    expect(stripeMock.store.get(s1)!.status).toBe("open"); // the URL the first press handed out still pays
    expect(firstUrl).toBe(stripeMock.store.get(s1)!.url);
    expect(await payPointer(reg.id)).toBe(s1);
    expect((await loadWithGroup(reg.id)).checkout_session_id).toBe(s1); // the cart pointer was not moved either
    expect(payableFor(reg.id)).toEqual([s1]);
  });

  describe("cart sibling with an open cart session (Review Focus 1)", () => {
    async function cartWithOpenSession() {
      const { rig, reg: a, accessToken } = await cardEntry({ displayName: "Entry A" });
      const b = await seedSecondEntry(a.group_id, rig.division.id, 1500, "Entry B");
      await mintGroupCheckout(a.group_id, rig.division.id, ORIGIN, accessToken);
      const sAB = (await loadWithGroup(a.id)).checkout_session_id!;
      return { rig, a, b, sAB };
    }

    it("A pays from the page, then the cart session completes → A takes the duplicate refund, B confirmed", async () => {
      const { a, b, sAB } = await cartWithOpenSession();
      const token = await linkFor(a);

      await payFromPayPage(token, ORIGIN);
      const sA = (await payPointer(a.id))!;
      expect(stripeMock.store.get(sAB)!.status).toBe("open"); // not subsumed: B still needs it

      await handleRegistrationCheckoutCompleted(payInStripe(sA));
      expect((await loadWithGroup(a.id)).status).toBe("confirmed");

      const cart = payInStripe(sAB);
      await handleRegistrationCheckoutCompleted(cart);

      expect((await loadWithGroup(b.id)).status).toBe("confirmed");
      expect((await loadWithGroup(a.id)).status).toBe("confirmed");
      // A's second charge goes back through the existing duplicate path: its own amount, on the cart session's intent.
      expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
      expect(stripeMock.refundCreate).toHaveBeenCalledWith(
        expect.objectContaining({ payment_intent: cart.payment_intent, amount: a.amount_cents }),
      );
      const refunds = await sql<{ mode: string }[]>`
        select payload->>'mode' as mode from competition_events
        where type = 'registration.refunded' and payload->>'registration_id' = ${a.id}`;
      expect(refunds.map((r) => r.mode)).toEqual(["duplicate"]);
    });

    it("the cart session completes first → A and B confirmed, then A's page shows paid and Pay 409s", async () => {
      const { a, b, sAB } = await cartWithOpenSession();
      const token = await linkFor(a);

      await handleRegistrationCheckoutCompleted(payInStripe(sAB));
      expect((await loadWithGroup(a.id)).status).toBe("confirmed");
      expect((await loadWithGroup(b.id)).status).toBe("confirmed");

      expect((await payPageDocByToken(token, new Date()))?.state).toBe("paid");
      const err = await rejection(payFromPayPage(token, ORIGIN));
      expect(err.status).toBe(409);
      expect(err.code).toBe("REGISTRATION_NOT_PAYABLE");
      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1); // the cart mint only
      expect(stripeMock.refundCreate).not.toHaveBeenCalled();
    });
  });
});

describe.skipIf(!HAS_DB)("reconcileRegistrationByPaySession (player payment page, Task 3)", () => {
  async function pressedEntry() {
    const { reg } = await cardEntry();
    const token = await linkFor(reg);
    await payFromPayPage(token, ORIGIN);
    const sid = (await payPointer(reg.id))!;
    stripeMock.checkoutRetrieve.mockClear();
    return { reg, sid };
  }

  it("a session id that is not the entry's pointer → false, zero retrieve (empty case first)", async () => {
    const { reg, sid } = await pressedEntry();
    payInStripe(sid);
    expect(await reconcileRegistrationByPaySession(reg.id, "cs_test_forged")).toBe(false);
    expect(await reconcileRegistrationByPaySession(reg.id, "")).toBe(false);
    expect(await reconcileRegistrationByPaySession(randomUUID(), sid)).toBe(false); // another entry's id, no pointer
    expect(await reconcileRegistrationByPaySession("not-a-uuid", sid)).toBe(false);
    expect(stripeMock.checkoutRetrieve).not.toHaveBeenCalled();
    expect((await loadWithGroup(reg.id)).status).toBe("pending");
  });

  it("the entry's own paid session → true, entry confirmed", async () => {
    const { reg, sid } = await pressedEntry();
    payInStripe(sid);
    expect(await reconcileRegistrationByPaySession(reg.id, sid)).toBe(true);
    expect(stripeMock.checkoutRetrieve).toHaveBeenCalledWith(sid);
    expect((await loadWithGroup(reg.id)).status).toBe("confirmed");
  });

  it("the entry's own session, unpaid → false, still pending", async () => {
    const { reg, sid } = await pressedEntry();
    expect(await reconcileRegistrationByPaySession(reg.id, sid)).toBe(false);
    expect(stripeMock.checkoutRetrieve).toHaveBeenCalledWith(sid);
    expect((await loadWithGroup(reg.id)).status).toBe("pending");
  });

  it("6th call within 60 s → false with zero retrieve", async () => {
    const { reg, sid } = await pressedEntry();
    const counts = new Map<string, number>();
    __setRateLimitCounterForTests(async (key, windowSeconds) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { count: n, ttlMs: windowSeconds * 1000 };
    });
    for (let i = 0; i < 5; i++) expect(await reconcileRegistrationByPaySession(reg.id, sid)).toBe(false); // unpaid
    expect(stripeMock.checkoutRetrieve).toHaveBeenCalledTimes(5);

    payInStripe(sid); // even a paid session is not looked at once the bucket is spent
    expect(await reconcileRegistrationByPaySession(reg.id, sid)).toBe(false);
    expect(stripeMock.checkoutRetrieve).toHaveBeenCalledTimes(5);
    expect(counts.get(`rl:reg-pay-reconcile:${reg.id}`)).toBe(6);
    expect((await loadWithGroup(reg.id)).status).toBe("pending");
  });
});

// Gap wave G1 (2026-11-12): the cart status page's Pay (`resumeRegistrationCheckout`, `/register/status`) and the cart's own
// pointer, `registration_groups.checkout_session_id`. Premise check against the tree: that Pay never reused or refused on the
// stored session - it minted unconditionally and only `expireSupersededCheckoutSession` looked at the prior one (open → maybe
// expire; anything else left alone) - so a FAILED delayed payment never stuck it. The gap was the other way round: a `complete`
// session whose money is still on its way (SEPA/Bacs `processing`, a voucher at `requires_action`, ...) was minted past too, a
// second payable session for the same entry. The rule is the payment page's (`completedSessionStillPays`), applied to the cart
// pointer when its session names this entry; the async_payment_failed webhook drops the cart pointer to the failed session (only
// that one) as it does the entry's.
describe.skipIf(!HAS_DB)("the cart status page's Pay follows the payment page's liveness rule (gap wave G1)", () => {
  async function cartPointer(regId: string): Promise<string | null> {
    return (await loadWithGroup(regId)).checkout_session_id;
  }
  /** A card entry whose cart already holds one session minted from the status page. */
  async function resumedEntry() {
    const { rig, reg, accessToken } = await cardEntry();
    await resumeRegistrationCheckout(reg.id, accessToken, ORIGIN);
    const s1 = (await cartPointer(reg.id))!;
    expect(s1).toBeTruthy();
    return { rig, reg, accessToken, s1 };
  }

  it("no stored session → mints with no session read (empty case first)", async () => {
    const { reg, accessToken } = await cardEntry();
    await resumeRegistrationCheckout(reg.id, accessToken, ORIGIN);
    expect(stripeMock.checkoutRetrieve).not.toHaveBeenCalled();
    expect(stripeMock.paymentIntentRetrieve).not.toHaveBeenCalled();
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
  });

  it.each(STILL_PAYS)(
    "cart session complete + unpaid, PaymentIntent %s → 409 PAID_ONLINE, no mint, cart pointer kept",
    async (piStatus) => {
      const { reg, accessToken, s1 } = await resumedEntry();
      completeDelayed(s1, piStatus);

      const err = await rejection(resumeRegistrationCheckout(reg.id, accessToken, ORIGIN));
      expect(err.status).toBe(409);
      expect(err.code).toBe("REGISTRATION_PAID_ONLINE");
      expect(stripeMock.paymentIntentRetrieve).toHaveBeenCalledTimes(1);
      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1); // the first press only
      expect(await cartPointer(reg.id)).toBe(s1);
    },
  );

  it.each(DEAD)("cart session complete + unpaid, PaymentIntent %s → a fresh session, cart pointer moved", async (piStatus) => {
    const { reg, accessToken, s1 } = await resumedEntry();
    completeDelayed(s1, piStatus);

    const { checkout_url } = await resumeRegistrationCheckout(reg.id, accessToken, ORIGIN);

    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
    const s2 = (await cartPointer(reg.id))!;
    expect(s2).not.toBe(s1);
    expect(checkout_url).toBe(stripeMock.store.get(s2)!.url);
    expect(payableFor(reg.id)).toEqual([s2]);
  });

  it("cart session complete + paid (webhook not landed) → 409 PAID_ONLINE, no intent read, no mint", async () => {
    const { reg, accessToken, s1 } = await resumedEntry();
    payInStripe(s1);

    const err = await rejection(resumeRegistrationCheckout(reg.id, accessToken, ORIGIN));
    expect(err.code).toBe("REGISTRATION_PAID_ONLINE");
    expect(stripeMock.paymentIntentRetrieve).not.toHaveBeenCalled();
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
  });

  it("a sibling's processing session on the cart pointer does not block this entry (the rule is per entry)", async () => {
    const { rig, reg: a, accessToken } = await cardEntry({ displayName: "Entry A" });
    const b = await seedSecondEntry(a.group_id, rig.division.id, 1500, "Entry B");
    await resumeRegistrationCheckout(b.id, accessToken, ORIGIN);
    const sB = (await cartPointer(a.id))!;
    completeDelayed(sB, "processing");

    await resumeRegistrationCheckout(a.id, accessToken, ORIGIN);

    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
    expect(createdParams(1).metadata?.registration_ids).toBe(a.id);
    expect(payableFor(a.id)).toHaveLength(1);
  });

  it("a read failure on the stored cart session refuses 502, zero create (never mint beside a session that may still pay)", async () => {
    const { reg, accessToken } = await resumedEntry();
    stripeMock.checkoutRetrieve.mockRejectedValueOnce(new Error("stripe down"));

    const err = await rejection(resumeRegistrationCheckout(reg.id, accessToken, ORIGIN));
    expect(err.status).toBe(502);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
  });

  it("the async_payment_failed webhook clears the cart pointer to that session; the next Pay mints without reading it", async () => {
    const { reg, accessToken, s1 } = await resumedEntry();
    const failed = completeDelayed(s1, "requires_payment_method");

    await handleRegistrationCheckoutAsyncPaymentFailed(failed);

    expect(await cartPointer(reg.id)).toBeNull();
    stripeMock.checkoutRetrieve.mockClear();
    await resumeRegistrationCheckout(reg.id, accessToken, ORIGIN);
    expect(stripeMock.checkoutRetrieve).not.toHaveBeenCalled(); // nothing on record to read
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
    expect(await cartPointer(reg.id)).not.toBe(s1);
  });

  it("a stale async_payment_failed for an older session leaves the cart's CURRENT pointer alone", async () => {
    const { reg, accessToken, s1 } = await resumedEntry();
    const failed = completeDelayed(s1, "requires_payment_method");
    await resumeRegistrationCheckout(reg.id, accessToken, ORIGIN); // dead session → fresh one
    const s2 = (await cartPointer(reg.id))!;
    expect(s2).not.toBe(s1);

    await handleRegistrationCheckoutAsyncPaymentFailed(failed);

    expect(await cartPointer(reg.id)).toBe(s2);
  });
});
