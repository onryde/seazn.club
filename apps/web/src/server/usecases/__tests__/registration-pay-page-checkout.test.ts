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
  /** Where Stripe sends the player back - the mint's own `success_url`, so a reuse rule can tell whose page a session returns to. */
  success_url: string | null;
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

// Fix round 2 seam: `materialise` throws for ONE named entry (its confirm transaction rolls back, the entry stays pending), so a
// multi-entry completion can fail partway through. Inert (`null`) for every other case.
const materialiseFault = vi.hoisted(() => ({ regId: null as string | null }));
vi.mock("@/server/usecases/registrations/materialise", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/registrations/materialise")>();
  return {
    ...actual,
    materialise: async (...args: Parameters<typeof actual.materialise>) => {
      if (materialiseFault.regId && args[1].id === materialiseFault.regId) throw new Error("injected: the sibling's confirm failed");
      return actual.materialise(...args);
    },
  };
});

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

import { sql, statementCount } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { isPayConfirming } from "@/lib/registration-pay";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { log } from "@/server/logger";
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
  promoteWaitlistedRow,
  payFromPayPage,
  groupById,
  refundRegistration,
  withdrawRegistrationOrganiser,
  reconcileRegistrationByPaySession,
  resumeRegistrationCheckout,
  PAY_SESSION_REUSE_MARGIN_MS,
  type KnownCart,
} from "../registrations";
import { createRegistrationCheckout } from "../registrations/checkout";
import { approveRegistration, rejectRegistration } from "../registration-approval";
import { returnsToPayPage } from "../registrations/pay-page-checkout";
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
      success_url: params.success_url ?? null,
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

// Gap wave G2 (2026-11-12, ledger :42): lock order. Checkout completion (`confirmPaidRegistration`) locks the entry and its cart
// in ONE statement - `select … from registrations r join registration_groups g … for update` - entry row first. The page mint's
// stamp transaction used to update the cart first and the entry second: a webhook landing for the same entry mid-mint could
// deadlock against it. The mint now locks the entry row before touching the cart. Witnessed with real row locks on separate
// connections (a holder transaction + `pg_blocking_pids`, then a `for update nowait` probe on the other row), not by reading SQL.
describe.skipIf(!HAS_DB)("lock order: the entry row before the cart row (gap wave G2)", () => {
  async function blockedBy(pid: number): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`;
    return row!.n;
  }
  async function untilBlocked(pid: number): Promise<void> {
    const deadline = Date.now() + 5000;
    while ((await blockedBy(pid)) === 0) {
      if (Date.now() > deadline) throw new Error(`nothing ever waited on backend ${pid}: the call under test took no lock it holds`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  /** `for update nowait` on one row, outside any transaction: "free", or the SQLSTATE that refused it (55P03 = held). */
  async function probe(table: "registrations" | "registration_groups", id: string): Promise<string> {
    const q =
      table === "registrations"
        ? sql`select 1 from registrations where id = ${id} for update nowait`
        : sql`select 1 from registration_groups where id = ${id} for update nowait`;
    return q.then(
      () => "free",
      (e: unknown) => (e as { code?: string }).code ?? String(e),
    );
  }
  /** Holds a row lock on its own connection until `release()`. */
  function holdRow(table: "registrations" | "registration_groups", id: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let ready!: (pid: number) => void;
    const pid = new Promise<number>((r) => (ready = r));
    const done = sql.begin(async (tx) => {
      if (table === "registrations") await tx`select 1 from registrations where id = ${id} for update`;
      else await tx`select 1 from registration_groups where id = ${id} for update`;
      const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      ready(row!.pid);
      await gate;
    });
    return { pid, release, done };
  }

  it("premise: checkout completion holds the ENTRY row while it waits for the cart row", async () => {
    const { reg } = await cardEntry();
    const token = await linkFor(reg);
    await payFromPayPage(token, ORIGIN);
    const paid = payInStripe((await payPointer(reg.id))!);

    const cart = holdRow("registration_groups", reg.group_id);
    let completion: Promise<void> | undefined;
    try {
      const pid = await cart.pid;
      completion = handleRegistrationCheckoutCompleted(paid);
      completion.catch(() => undefined);
      await untilBlocked(pid);
      expect(await probe("registrations", reg.id)).toBe("55P03"); // taken before the cart it is waiting on
    } finally {
      cart.release();
      await cart.done;
    }
    await completion;
    expect((await loadWithGroup(reg.id)).status).toBe("confirmed");
  });

  it("the page mint waits on the entry row with the cart row still FREE (no cart lock held while it waits)", async () => {
    const { reg } = await cardEntry();
    const token = await linkFor(reg);

    const entry = holdRow("registrations", reg.id);
    let pay: Promise<string> | undefined;
    try {
      const pid = await entry.pid;
      pay = payFromPayPage(token, ORIGIN);
      pay.catch(() => undefined);
      await untilBlocked(pid);
      expect(await probe("registration_groups", reg.group_id)).toBe("free");
    } finally {
      entry.release();
      await entry.done;
    }
    const url = await pay;
    const s1 = (await payPointer(reg.id))!;
    expect(url).toBe(stripeMock.store.get(s1)!.url);
    expect((await loadWithGroup(reg.id)).checkout_session_id).toBe(s1);
  });
});

// Gap wave G3 (2026-11-12, ledger :44): a stored session that is `open` but not reusable (too little of it left, or not this entry
// alone) is expired before the mint. If it stops being open between the read and the expire - it timed out, or the player paid
// in another tab - Stripe refuses the expire (400 "Only Checkout Sessions with a status in [\"open\"] can be expired"). That used
// to answer a transient 502. Now the session is read again and the decision is made on what Stripe says it IS (never on the error
// text): expired → mint; complete → the payment page's liveness rule; still open → a real expire failure, 502.
describe.skipIf(!HAS_DB)("an expire refused because the session just stopped being open (gap wave G3)", () => {
  const STRIPE_NOT_OPEN = 'Only Checkout Sessions with a status in ["open"] can be expired.';
  /** A pressed entry whose stored session is open with only 5 minutes left (inside the reuse margin, so Pay expires it). */
  async function shortSession() {
    const { reg } = await cardEntry();
    const token = await linkFor(reg);
    await payFromPayPage(token, ORIGIN);
    const s1 = (await payPointer(reg.id))!;
    const now = new Date();
    stripeMock.store.get(s1)!.expires_at = Math.floor(now.getTime() / 1000) + 5 * 60;
    stripeMock.checkoutRetrieve.mockClear();
    return { reg, token, s1, now };
  }
  /** The next expire finds the session already moved on by `change`, and Stripe refuses it. */
  function expireRefusedAfter(change: (s: FakeSession) => void) {
    stripeMock.checkoutExpire.mockImplementationOnce(async (id: string) => {
      change(stripeMock.store.get(id)!);
      throw Object.assign(new Error(STRIPE_NOT_OPEN), { type: "StripeInvalidRequestError", statusCode: 400 });
    });
  }

  it("expired on its own between the read and the expire → read again, a fresh session (no 502)", async () => {
    const { reg, token, s1, now } = await shortSession();
    expireRefusedAfter((s) => (s.status = "expired"));

    const url = await payFromPayPage(token, ORIGIN, now);

    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
    // Before the mint: the read, then the re-read after the refused expire. (The mint's own supersede step reads the cart's prior
    // session once more afterwards - not this rule's business.)
    const mintedAt = stripeMock.checkoutCreate.mock.invocationCallOrder[1]!;
    expect(stripeMock.checkoutRetrieve.mock.invocationCallOrder.filter((o) => o < mintedAt)).toHaveLength(2);
    const s2 = (await payPointer(reg.id))!;
    expect(s2).not.toBe(s1);
    expect(url).toBe(stripeMock.store.get(s2)!.url);
    expect(payableFor(reg.id)).toEqual([s2]);
  });

  it("paid in another tab between the read and the expire → 409 PAID_ONLINE (recording), no mint", async () => {
    const { reg, token, s1, now } = await shortSession();
    expireRefusedAfter((s) => {
      s.status = "complete";
      s.payment_status = "paid";
      s.payment_intent = "pi_test_g3_" + randomUUID().slice(0, 6);
    });

    const err = await rejection(payFromPayPage(token, ORIGIN, now));
    expect(err.status).toBe(409);
    expect(err.code).toBe("REGISTRATION_PAID_ONLINE");
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1); // the first press only
    expect(await payPointer(reg.id)).toBe(s1);
  });

  it("an expire that fails while the session is STILL open → 502, zero create (a real failure stays fail-closed)", async () => {
    const { reg, token, s1, now } = await shortSession();
    expireRefusedAfter(() => undefined); // Stripe down: nothing changed, the session is still open

    const err = await rejection(payFromPayPage(token, ORIGIN, now));
    expect(err.status).toBe(502);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.store.get(s1)!.status).toBe("open");
    expect(await payPointer(reg.id)).toBe(s1);
  });

  it("a re-read that itself fails → 502, zero create", async () => {
    const { token, now } = await shortSession();
    expireRefusedAfter((s) => (s.status = "expired"));
    stripeMock.checkoutRetrieve
      .mockImplementationOnce(async (id: string) => ({ ...stripeMock.store.get(id)! })) // the first read succeeds
      .mockRejectedValueOnce(new Error("stripe down")); // the re-read does not

    const err = await rejection(payFromPayPage(token, ORIGIN, now));
    expect(err.status).toBe(502);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
  });

  // Fix round 1 (F6): when the re-read settles it, the refused expire's own error used to vanish without a trace. It is logged at
  // info (the outcome is normal - the line says why an expire failed); a still-open session keeps its error-level line.
  it("the refused expire's error is logged at info with the entry when the re-read settles it (expired, complete; counted)", async () => {
    const changes: [string, (s: FakeSession) => void][] = [
      ["expired", (s) => (s.status = "expired")],
      [
        "complete",
        (s) => {
          s.status = "complete";
          s.payment_status = "paid";
          s.payment_intent = "pi_test_f6_" + randomUUID().slice(0, 6);
        },
      ],
    ];
    let checked = 0;
    for (const [label, change] of changes) {
      const { reg, token, now } = await shortSession();
      const refused = Object.assign(new Error(STRIPE_NOT_OPEN), { type: "StripeInvalidRequestError", statusCode: 400 });
      stripeMock.checkoutExpire.mockImplementationOnce(async (id: string) => {
        change(stripeMock.store.get(id)!);
        throw refused;
      });
      const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
      try {
        await payFromPayPage(token, ORIGIN, now).catch(() => undefined); // complete answers 409 - its own case above
        const lines = info.mock.calls.filter(([o]) => (o as { err?: unknown } | undefined)?.err === refused);
        expect(lines, `${label}: the swallowed expire error is logged once`).toHaveLength(1);
        expect(lines[0]![0], label).toMatchObject({ registrationId: reg.id });
      } finally {
        info.mockRestore();
      }
      checked++;
    }
    expect(checked, "anti-vacuity: both settled outcomes checked").toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fix round 1 (gap-wave review), F1: a promotion that lapses, a late payment that is refunded, then a re-promotion. The late
// session stays `complete` + `paid` at Stripe forever; if either pointer still names it, both Pay buttons read it as "a payment
// already on its way" and refuse for good.
// ---------------------------------------------------------------------------------------------------------------------------------

/** A waitlisted entry promoted for real (`promoteWaitlistedRow`): pending, with its own promotion window and fee. */
async function promotedEntry() {
  const r = await stripeRig({ feeCents: 1500 });
  const seeded = await seedRegistration(r.competition.id, r.division.id, r.settings, { status: "waitlisted" });
  const row = await sql.begin((tx) => promoteWaitlistedRow(tx, seeded.registration.id, seeded.registration.group_id, r.settings));
  expect(row?.status, "premise: promoted to pending").toBe("pending");
  return { rig: r, reg: row!, accessToken: seeded.access_token };
}

/** The sweep's lapse write for one entry (sweep.ts, the promotion-lapse pass), applied to this row alone: `sweepRegistrations`
 *  is global, and the lapse pass touches neither pointer, so the pointers here are exactly what a real lapse leaves. */
async function lapse(regId: string): Promise<void> {
  await sql`update registrations
            set status = 'waitlisted', waitlisted_at = now(), promoted_at = null, promotion_expires_at = null, updated_at = now()
            where id = ${regId}`;
}

async function pointersOf(regId: string): Promise<{ pay: string | null; cart: string | null }> {
  const row = await loadWithGroup(regId);
  return { pay: await payPointer(regId), cart: row.checkout_session_id };
}

describe.skipIf(!HAS_DB)("a late payment refunded after a lapse leaves both Pay buttons usable on re-promotion (fix round 1, F1)", () => {
  /** Promoted, pays from the page AFTER its promotion lapsed: refunded, and back on the waitlist. Returns the late session. */
  async function lateAfterLapse() {
    const w = await promotedEntry();
    const token = await linkFor(w.reg);
    await payFromPayPage(token, ORIGIN);
    const late = (await payPointer(w.reg.id))!;
    expect((await pointersOf(w.reg.id)).cart, "premise: the page's mint stamped the cart too").toBe(late);
    await lapse(w.reg.id);
    await handleRegistrationCheckoutCompleted(payInStripe(late));
    const after = await loadWithGroup(w.reg.id);
    expect(after.status, "premise: the late payment did not seat the entry").toBe("waitlisted");
    expect(stripeMock.refundCreate, "premise: the late payment was refunded").toHaveBeenCalledTimes(1);
    return { ...w, token, late };
  }

  async function repromote(w: Awaited<ReturnType<typeof lateAfterLapse>>) {
    const row = await sql.begin((tx) => promoteWaitlistedRow(tx, w.reg.id, w.reg.group_id, w.rig.settings));
    expect(row?.status, "premise: re-promoted").toBe("pending");
  }

  it("the late completion clears both pointers that named its session", async () => {
    const w = await lateAfterLapse();
    expect(await pointersOf(w.reg.id)).toEqual({ pay: null, cart: null });
  });

  it("re-promoted: the cart status page's Pay mints a fresh session (no 409)", async () => {
    const w = await lateAfterLapse();
    await repromote(w);
    const creates = stripeMock.checkoutCreate.mock.calls.length;
    const { checkout_url } = await resumeRegistrationCheckout(w.reg.id, w.accessToken, ORIGIN);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(creates + 1);
    const fresh = (await pointersOf(w.reg.id)).cart!;
    expect(fresh).not.toBe(w.late);
    expect(checkout_url).toBe(stripeMock.store.get(fresh)!.url);
  });

  it("re-promoted: the payment page's Pay mints a fresh session (no 409)", async () => {
    const w = await lateAfterLapse();
    await repromote(w);
    const creates = stripeMock.checkoutCreate.mock.calls.length;
    const url = await payFromPayPage(w.token, ORIGIN);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(creates + 1);
    const fresh = (await payPointer(w.reg.id))!;
    expect(fresh).not.toBe(w.late);
    expect(url).toBe(stripeMock.store.get(fresh)!.url);
  });

  it("a late completion whose session the pointers no longer name leaves both pointers alone", async () => {
    const w = await promotedEntry();
    const token = await linkFor(w.reg);
    await payFromPayPage(token, ORIGIN);
    const late = (await payPointer(w.reg.id))!;
    // A later mint moved both pointers on (the session ids are what the guard compares; the newer session is not read).
    await sql`update registrations set pay_session_id = 'cs_test_newer_f1' where id = ${w.reg.id}`;
    await sql`update registration_groups set checkout_session_id = 'cs_test_newer_f1' where id = ${w.reg.group_id}`;
    await lapse(w.reg.id);
    await handleRegistrationCheckoutCompleted(payInStripe(late));
    expect(stripeMock.refundCreate, "premise: the late branch ran").toHaveBeenCalledTimes(1);
    expect(await pointersOf(w.reg.id)).toEqual({ pay: "cs_test_newer_f1", cart: "cs_test_newer_f1" });
  });

  // Fix round 2 (re-review of F1): a cart session can name a late entry AND a still-pending sibling. The cart pointer is what the
  // status page's reconcile-on-return and its Pay guard read for the sibling, so it may only be cleared once every entry the
  // session names has been handled - never while the sibling's confirm can still fail and leave it pending.
  /** A promoted entry A and a pending sibling B in one cart, one cart session naming [A, B] (A first), then A's promotion lapses. */
  async function lateAndPendingSibling() {
    const w = await promotedEntry();
    const b = await seedSecondEntry(w.reg.group_id, w.rig.division.id, 1500, "Entry B");
    await mintGroupCheckout(w.reg.group_id, w.rig.division.id, ORIGIN, w.accessToken);
    const cs = (await pointersOf(w.reg.id)).cart!;
    const named = stripeMock.store.get(cs)!.metadata.registration_ids.split(",");
    expect([...named].sort(), "premise: one session names both entries").toEqual([w.reg.id, b.id].sort());
    stripeMock.store.get(cs)!.metadata.registration_ids = `${w.reg.id},${b.id}`; // the late entry is handled first
    await lapse(w.reg.id);
    return { ...w, b, cs };
  }

  it("the sibling's confirm fails after the late entry: the cart pointer still names the session, so its Pay refuses; Stripe's retry confirms it and clears the pointer", async () => {
    const w = await lateAndPendingSibling();
    const paid = payInStripe(w.cs);
    materialiseFault.regId = w.b.id;
    try {
      await expect(handleRegistrationCheckoutCompleted(paid)).rejects.toThrow("injected");
    } finally {
      materialiseFault.regId = null;
    }
    expect((await loadWithGroup(w.reg.id)).status, "premise: the late entry was handled").toBe("waitlisted");
    expect(stripeMock.refundCreate, "premise: the late payment was refunded").toHaveBeenCalledTimes(1);
    expect((await loadWithGroup(w.b.id)).status, "premise: the sibling's confirm rolled back").toBe("pending");
    expect((await pointersOf(w.b.id)).cart, "the cart pointer still names the paid session").toBe(w.cs);

    // The sibling's status-page Pay: its payment is on its way, so no second session.
    const creates = stripeMock.checkoutCreate.mock.calls.length;
    const err = await rejection(resumeRegistrationCheckout(w.b.id, w.accessToken, ORIGIN));
    expect(err.status).toBe(409);
    expect(err.code).toBe("REGISTRATION_PAID_ONLINE");
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(creates);

    // Stripe's retry of the same event: the sibling is confirmed, the late refund is not repeated, and only now is the pointer cleared.
    await handleRegistrationCheckoutCompleted(paid);
    expect((await loadWithGroup(w.b.id)).status).toBe("confirmed");
    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    expect((await pointersOf(w.b.id)).cart).toBeNull();
  });

  it("positive pair: the same session with the sibling confirming cleanly clears the cart pointer in one pass", async () => {
    const w = await lateAndPendingSibling();
    await handleRegistrationCheckoutCompleted(payInStripe(w.cs));
    expect((await loadWithGroup(w.reg.id)).status).toBe("waitlisted");
    expect((await loadWithGroup(w.b.id)).status).toBe("confirmed");
    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    expect((await pointersOf(w.b.id)).cart).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fix round 1 (gap-wave review), F3: "already refunded" is a question about ONE payment, not the entry's running total. A
// re-promotion resets the fee but never `refunded_cents` (refund history is kept), so the running-total guard kept a second late
// payment, and the page read a re-promoted entry that paid in time as "refunded".
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("a late refund is decided per payment, and the page's refunded state is the current payment's (fix round 1, F3)", () => {
  const refundedIntents = () =>
    stripeMock.refundCreate.mock.calls.map((c) => (c[0] as Stripe.RefundCreateParams).payment_intent as string);

  /** Promoted, pays from the page after the promotion lapsed: one late refund. Returns the token, the session and its intent. */
  async function oneLateRefund() {
    const w = await promotedEntry();
    const token = await linkFor(w.reg);
    await payFromPayPage(token, ORIGIN);
    const cs = (await payPointer(w.reg.id))!;
    await lapse(w.reg.id);
    const paid = payInStripe(cs);
    await handleRegistrationCheckoutCompleted(paid);
    expect(refundedIntents(), "premise: the first late payment was refunded on its own intent").toEqual([paid.payment_intent]);
    return { ...w, token, first: paid };
  }

  async function repromote(w: { rig: StripeRigResult; reg: { id: string; group_id: string } }) {
    const row = await sql.begin((tx) => promoteWaitlistedRow(tx, w.reg.id, w.reg.group_id, w.rig.settings));
    expect(row?.status, "premise: re-promoted").toBe("pending");
  }

  it("lapse → late refund → re-promote → late again: the second payment is refunded on ITS intent; a redelivery refunds nothing more", async () => {
    const w = await oneLateRefund();
    await repromote(w);
    await payFromPayPage(w.token, ORIGIN);
    const cs2 = (await payPointer(w.reg.id))!;
    await lapse(w.reg.id);
    const second = payInStripe(cs2);
    expect(second.payment_intent, "premise: two different payments").not.toBe(w.first.payment_intent);

    await handleRegistrationCheckoutCompleted(second);

    expect(refundedIntents()).toEqual([w.first.payment_intent, second.payment_intent]);
    const row = await loadWithGroup(w.reg.id);
    expect(row.status).toBe("waitlisted");
    expect(row.refunded_cents, "history kept: both refunds counted").toBe(2 * 1500);

    // The sequence: Stripe delivers at least once. The same session again, and the first one again, move no more money.
    await handleRegistrationCheckoutCompleted(second);
    await handleRegistrationCheckoutCompleted(w.first);
    expect(refundedIntents()).toHaveLength(2);
    expect((await loadWithGroup(w.reg.id)).refunded_cents).toBe(2 * 1500);
  });

  it("lapse → late refund → re-promote → pays in time: the page reads paid (not refunded), refundedCents 0", async () => {
    const w = await oneLateRefund();
    await repromote(w);
    await payFromPayPage(w.token, ORIGIN);
    const cs2 = (await payPointer(w.reg.id))!;
    await handleRegistrationCheckoutCompleted(payInStripe(cs2));
    const row = await loadWithGroup(w.reg.id);
    expect(["paid", "confirmed"], "premise: the in-time payment seated the entry").toContain(row.status);
    expect(row.refunded_cents, "premise: the earlier late refund is still on the books").toBe(1500);

    const doc = await payPageDocByToken(w.token, new Date());
    expect(doc?.state).toBe("paid");
    expect(doc!.refundedCents).toBe(0);

    // The positive pair: a refund of THIS payment (the organiser's, on the books like any other) reads refunded, for that amount.
    await sql`update registrations set refunded_cents = refunded_cents + 700 where id = ${w.reg.id}`;
    const after = await payPageDocByToken(w.token, new Date());
    expect(after?.state).toBe("refunded");
    expect(after!.refundedCents).toBe(700);
  });

  // Polish wave P5, P1-review carry (b): every refund of the CURRENT payment is capped by that payment, not by the history.
  // `refunded_cents` keeps the late refund of the earlier payment, so the old cap (`amount - refunded`) read the re-promoted entry's
  // in-time payment as already sent back: the organiser's Refund 422'd and a withdrawal refunded nothing.
  /** Late refund, re-promotion, then an IN-TIME payment of the new promotion (through the page and the real webhook core). */
  async function paidAgainAfterLateRefund() {
    const w = await oneLateRefund();
    await repromote(w);
    await payFromPayPage(w.token, ORIGIN);
    const second = payInStripe((await payPointer(w.reg.id))!);
    await handleRegistrationCheckoutCompleted(second);
    const row = await loadWithGroup(w.reg.id);
    expect(["paid", "confirmed"], "premise: the in-time payment seated the entry").toContain(row.status);
    expect(row.entry_payment_intent_id, "premise: the entry's own payment is the second one").toBe(second.payment_intent);
    expect(row.refunded_cents, "premise: the earlier late refund is still on the books").toBe(1500);
    stripeMock.refundCreate.mockClear();
    return { ...w, second };
  }

  it("the late producer books what it sent back as LATE (V512), beside the history - and a redelivery books nothing more", async () => {
    const w = await oneLateRefund();
    const row = await loadWithGroup(w.reg.id);
    expect(row.refunded_cents).toBe(1500);
    expect(row.late_refunded_cents).toBe(1500);
    await handleRegistrationCheckoutCompleted(w.first);
    expect((await loadWithGroup(w.reg.id)).late_refunded_cents).toBe(1500);
  });

  it("(P5 carry b) paid again after a late refund: the organiser's Refund sends back the WHOLE fee on the new payment; a second Refund → 422", async () => {
    const w = await paidAgainAfterLateRefund();

    const after = await refundRegistration(w.rig.owner, w.reg.id, undefined);

    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.refundCreate.mock.calls[0]![0]).toMatchObject({ payment_intent: w.second.payment_intent, amount: 1500 });
    expect(after.refunded_cents, "history: the late refund and this one").toBe(3000);
    // The sequence: the current payment is now fully refunded.
    const err = await rejection(refundRegistration(w.rig.owner, w.reg.id, undefined));
    expect(err.status).toBe(422);
    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
  });

  it("(P5 carry b) paid again after a late refund: an organiser withdrawal before the lock refunds the new payment in full", async () => {
    const w = await paidAgainAfterLateRefund();

    await withdrawRegistrationOrganiser(w.rig.owner, w.reg.id);

    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.refundCreate.mock.calls[0]![0]).toMatchObject({ payment_intent: w.second.payment_intent, amount: 1500 });
    expect((await loadWithGroup(w.reg.id)).refunded_cents).toBe(3000);
  });

  it("(P5 carry b) paid again after a late refund: the status page's refund policy quotes the new payment's whole fee (the read twin)", async () => {
    const w = await paidAgainAfterLateRefund();

    const view = await groupById(w.reg.group_id, w.accessToken);

    const entry = view.entries.find((e) => e.id === w.reg.id)!;
    expect(entry.refund_policy.refundable).toBe(true);
    expect(entry.refund_policy.amount_cents).toBe(1500);
  });

  /** The same, on a division switched to MANUAL approval before the in-time payment: the payment leaves the entry `paid`, awaiting
   *  the organiser's decision. */
  async function paidAgainAwaitingApproval() {
    const w = await oneLateRefund();
    await repromote(w);
    await putRegistrationSettings(w.rig.owner, w.rig.division.id, { ...SETTINGS_BASE, payment_method: "stripe", fee_cents: 1500, approval: "manual" });
    await payFromPayPage(w.token, ORIGIN);
    const second = payInStripe((await payPointer(w.reg.id))!);
    await handleRegistrationCheckoutCompleted(second);
    expect((await loadWithGroup(w.reg.id)).status, "premise: awaiting the organiser's decision").toBe("paid");
    stripeMock.refundCreate.mockClear();
    return { ...w, second };
  }

  it("(P5 carry b) paid again after a late refund, awaiting approval: Reject refunds the new payment in full", async () => {
    const w = await paidAgainAwaitingApproval();

    await rejectRegistration(w.rig.owner, w.reg.id);

    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.refundCreate.mock.calls[0]![0]).toMatchObject({ payment_intent: w.second.payment_intent, amount: 1500 });
  });

  it("(P5 carry b) paid again after a late refund, awaiting approval: Approve is not refused as 'already refunded'", async () => {
    const w = await paidAgainAwaitingApproval();

    const row = await approveRegistration(w.rig.owner, w.reg.id);

    expect(row.status).toBe("confirmed");
    expect(stripeMock.refundCreate).not.toHaveBeenCalled();
  });

  it("a late refund recorded before the payment was named on it keeps the old whole-entry rule (no second refund on a redelivery)", async () => {
    const w = await oneLateRefund();
    // A row written before this change carries no payment_intent_id.
    const stripped = await sql`
      update competition_events set payload = payload - 'payment_intent_id'
      where type = 'registration.refunded' and payload->>'registration_id' = ${w.reg.id}`;
    expect(stripped.count, "premise: one late-refund row to strip").toBe(1);

    await handleRegistrationCheckoutCompleted(w.first);

    expect(refundedIntents()).toHaveLength(1);
    expect((await loadWithGroup(w.reg.id)).refunded_cents).toBe(1500);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fix round 1 (gap-wave review), F2: one entry, two Pay buttons, two pointers. Each button used to judge only its OWN pointer's
// session, so a payment still landing through the OTHER button (a SEPA debit processing) let it mint a second payable session -
// a double charge. Each now also judges the other pointer's session, when that session names this entry, by the same rule.
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("each Pay button also refuses while the OTHER button's session can still pay for this entry (fix round 1, F2)", () => {
  async function cartPointer(regId: string): Promise<string | null> {
    return (await loadWithGroup(regId)).checkout_session_id;
  }

  describe("the payment page, after a status-page session", () => {
    async function statusPageSession() {
      const { reg, accessToken } = await cardEntry();
      await resumeRegistrationCheckout(reg.id, accessToken, ORIGIN);
      const cs = (await cartPointer(reg.id))!;
      const token = await linkFor(reg);
      // Polish wave P5 (carry a): the status page's per-entry session is recorded on the entry's own pointer too.
      expect(await payPointer(reg.id), "premise: the status page's session sits on the entry's pointer").toBe(cs);
      return { reg, cs, token };
    }

    it("still processing (a SEPA debit) → 409 PAID_ONLINE, no mint", async () => {
      const { cs, token } = await statusPageSession();
      completeDelayed(cs, "processing");
      const err = await rejection(payFromPayPage(token, ORIGIN));
      expect(err.status).toBe(409);
      expect(err.code).toBe("REGISTRATION_PAID_ONLINE");
      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1); // the status page's only
    });

    it("complete + paid (webhook not landed) → 409 PAID_ONLINE, no mint", async () => {
      const { cs, token } = await statusPageSession();
      payInStripe(cs);
      const err = await rejection(payFromPayPage(token, ORIGIN));
      expect(err.code).toBe("REGISTRATION_PAID_ONLINE");
      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
    });

    it("the debit FAILED (dead session) → the page mints", async () => {
      const { reg, cs, token } = await statusPageSession();
      completeDelayed(cs, "requires_payment_method");
      await payFromPayPage(token, ORIGIN);
      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
      expect(await payPointer(reg.id)).not.toBe(cs);
    });

    it("a sibling's processing session on the cart pointer does not block this entry's page (the rule is per entry)", async () => {
      const { rig, reg: a, accessToken } = await cardEntry({ displayName: "Entry A" });
      const b = await seedSecondEntry(a.group_id, rig.division.id, 1500, "Entry B");
      await resumeRegistrationCheckout(b.id, accessToken, ORIGIN);
      completeDelayed((await cartPointer(a.id))!, "processing");
      await payFromPayPage(await linkFor(a), ORIGIN);
      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
      expect(createdParams(1).metadata?.registration_ids).toBe(a.id);
    });
  });

  describe("the status page, after a payment-page session the cart pointer has moved past", () => {
    /** A pays from its page (both pointers = csA); then B's status-page Pay moves the cart pointer to B's own session. */
    async function pageSessionThenSibling() {
      const { rig, reg: a, accessToken } = await cardEntry({ displayName: "Entry A" });
      const b = await seedSecondEntry(a.group_id, rig.division.id, 1500, "Entry B");
      await payFromPayPage(await linkFor(a), ORIGIN);
      const csA = (await payPointer(a.id))!;
      return { a, b, accessToken, csA };
    }

    it("still processing → 409 PAID_ONLINE, no mint", async () => {
      const { a, b, accessToken, csA } = await pageSessionThenSibling();
      completeDelayed(csA, "processing");
      await resumeRegistrationCheckout(b.id, accessToken, ORIGIN);
      expect(await cartPointer(a.id), "premise: the cart pointer moved to the sibling's session").not.toBe(csA);
      const creates = stripeMock.checkoutCreate.mock.calls.length;

      const err = await rejection(resumeRegistrationCheckout(a.id, accessToken, ORIGIN));
      expect(err.status).toBe(409);
      expect(err.code).toBe("REGISTRATION_PAID_ONLINE");
      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(creates);
    });

    it("the debit FAILED (dead session) → the status page mints", async () => {
      const { a, b, accessToken, csA } = await pageSessionThenSibling();
      completeDelayed(csA, "requires_payment_method");
      await resumeRegistrationCheckout(b.id, accessToken, ORIGIN);
      const creates = stripeMock.checkoutCreate.mock.calls.length;

      await resumeRegistrationCheckout(a.id, accessToken, ORIGIN);
      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(creates + 1);
      expect(createdParams(creates).metadata?.registration_ids).toBe(a.id);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Polish wave W5 (walkthrough S05, 2026-11-12): sign-up Checkout, a declined card / failed 3-D Secure / Back out of Checkout, then
// "Pay now" on the status page opened a NEW session every press (three cs_ ids on one entry, each older one expired). Root cause:
// `resumeRegistrationCheckout` had no reuse rule - every press minted, and the mint's supersede step expired the previous one.
// Stripe itself keeps the session `open` through all three events (observed in the walk: status open, PaymentIntent
// `requires_payment_method`), and the same URL takes another card. Rule under test (owner-approved rec): hand the stored session
// out again whenever it is `open`, covers exactly this entry, and has more than PAY_SESSION_REUSE_MARGIN_MS left, regardless of a
// prior decline; otherwise mint, and never leave two payable sessions for the entry.
// ---------------------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("the status page's Pay hands an open session out again (polish wave W5)", () => {
  async function cartPointer(regId: string): Promise<string | null> {
    return (await loadWithGroup(regId)).checkout_session_id;
  }
  /** A card entry submitted the way the public register route does it: `mintGroupCheckout` mints the sign-up Checkout. */
  async function signedUp() {
    const { rig, reg, accessToken } = await cardEntry();
    const url = await mintGroupCheckout(reg.group_id, rig.division.id, ORIGIN, accessToken);
    const s0 = (await cartPointer(reg.id))!;
    expect(url, "premise: the sign-up handed out the session the cart records").toBe(stripeMock.store.get(s0)!.url);
    return { rig, reg, accessToken, s0 };
  }
  /** What Stripe's session looks like after each walk event: still `open` and `unpaid`. A decline and a failed challenge leave a
   *  PaymentIntent at `requires_payment_method`; Back out of Checkout leaves the session untouched. */
  const EVENTS: [string, (s: FakeSession) => void][] = [
    ["a declined card (4000 0000 0000 0002)", (s) => ((s.payment_intent = `pi_test_decl_${s.id.slice(-6)}`), (s.pi_status = "requires_payment_method"))],
    ["a failed 3-D Secure challenge (4000 0025 0000 3155, Fail)", (s) => ((s.payment_intent = `pi_test_3ds_${s.id.slice(-6)}`), (s.pi_status = "requires_payment_method"))],
    ["the player backing out of Checkout (?checkout=cancelled)", () => undefined],
  ];

  it("sign-up → each walk event → Pay → Pay: the SAME session both times, no create, no expire; paying it confirms the entry (counted)", async () => {
    let checked = 0;
    for (const [label, event] of EVENTS) {
      const { reg, accessToken, s0 } = await signedUp();
      event(stripeMock.store.get(s0)!);
      expect(stripeMock.store.get(s0)!.status, `${label}: premise - Stripe keeps the session open`).toBe("open");
      const creates = stripeMock.checkoutCreate.mock.calls.length;
      const expires = stripeMock.checkoutExpire.mock.calls.length;

      const first = await resumeRegistrationCheckout(reg.id, accessToken, ORIGIN);
      const second = await resumeRegistrationCheckout(reg.id, accessToken, ORIGIN);

      expect(first.checkout_url, label).toBe(stripeMock.store.get(s0)!.url);
      expect(second.checkout_url, `${label}: the second press`).toBe(first.checkout_url);
      expect(stripeMock.checkoutCreate.mock.calls.length, `${label}: no new session`).toBe(creates);
      expect(stripeMock.checkoutExpire.mock.calls.length, `${label}: nothing expired`).toBe(expires);
      expect(await cartPointer(reg.id), label).toBe(s0);
      expect(payableFor(reg.id), `${label}: one payable session`).toEqual([s0]);

      // The reused session is the live one: paying it confirms the entry through the real completion core.
      await handleRegistrationCheckoutCompleted(payInStripe(s0));
      expect((await loadWithGroup(reg.id)).status, `${label}: paid on the reused session`).toBe("confirmed");
      checked++;
    }
    expect(checked, "anti-vacuity: every walk event checked").toBe(EVENTS.length);
  });

  it.each([
    { left: 9, reused: false },
    { left: 11, reused: true },
  ])("the cart's session with $left minutes left → reused: $reused (boundary pair around the margin)", async ({ left, reused }) => {
    const { reg, accessToken, s0 } = await signedUp();
    const now = new Date();
    stripeMock.store.get(s0)!.expires_at = Math.floor(now.getTime() / 1000) + left * 60;

    const { checkout_url } = await resumeRegistrationCheckout(reg.id, accessToken, ORIGIN, now);

    if (reused) {
      expect(checkout_url).toBe(stripeMock.store.get(s0)!.url);
      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1); // the sign-up only
    } else {
      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
      const s1 = (await cartPointer(reg.id))!;
      expect(s1).not.toBe(s0);
      expect(checkout_url).toBe(stripeMock.store.get(s1)!.url);
      expect(stripeMock.store.get(s0)!.status, "the short session is retired, not left payable").toBe("expired");
    }
    expect(payableFor(reg.id)).toHaveLength(1);
  });

  // Polish wave final fix m8: the cart's own session inside the margin was retired only by the mint's supersede step - AFTER the
  // create, and best-effort - so a Stripe hiccup there left two payable sessions for the entry. It is now expired BEFORE the mint,
  // fail-closed, exactly as the payment page's own session (the describe below).
  describe("the cart's own session inside the margin is retired before the mint, fail-closed (m8)", () => {
    async function shortSignUp() {
      const signed = await signedUp();
      const now = new Date();
      stripeMock.store.get(signed.s0)!.expires_at = Math.floor(now.getTime() / 1000) + 9 * 60;
      return { ...signed, now };
    }

    it("expired BEFORE the new session is created", async () => {
      const { reg, accessToken, s0, now } = await shortSignUp();

      await resumeRegistrationCheckout(reg.id, accessToken, ORIGIN, now);

      expect(stripeMock.checkoutExpire).toHaveBeenCalledWith(s0);
      const expireOrder = stripeMock.checkoutExpire.mock.invocationCallOrder[0]!;
      const createOrder = stripeMock.checkoutCreate.mock.invocationCallOrder.at(-1)!;
      expect(expireOrder, "the old one is retired before the new one exists").toBeLessThan(createOrder);
      expect(payableFor(reg.id)).toEqual([(await cartPointer(reg.id))!]);
    });

    it("an expire that fails while it is still open → 502, zero create, the old session still the only payable one", async () => {
      const { reg, accessToken, s0, now } = await shortSignUp();
      stripeMock.checkoutExpire.mockRejectedValueOnce(new Error("stripe down"));
      const creates = stripeMock.checkoutCreate.mock.calls.length;

      const err = await rejection(resumeRegistrationCheckout(reg.id, accessToken, ORIGIN, now));

      expect(err.status).toBe(502);
      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(creates);
      expect(payableFor(reg.id)).toEqual([s0]);
      expect(await cartPointer(reg.id)).toBe(s0);
    });

    it("paid in another tab between the read and the expire → 409 PAID_ONLINE, zero create", async () => {
      const { reg, accessToken, now } = await shortSignUp();
      stripeMock.checkoutExpire.mockImplementationOnce(async (id: string) => {
        payInStripe(id);
        throw Object.assign(new Error('Only Checkout Sessions with a status in ["open"] can be expired.'), { statusCode: 400 });
      });
      const creates = stripeMock.checkoutCreate.mock.calls.length;

      const err = await rejection(resumeRegistrationCheckout(reg.id, accessToken, ORIGIN, now));

      expect(err.status).toBe(409);
      expect(err.code).toBe("REGISTRATION_PAID_ONLINE");
      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(creates);
    });

    it("a session that also covers a SIBLING is not this entry's to expire: left alone, as the supersede rule leaves it", async () => {
      const { rig, reg: a, accessToken } = await cardEntry({ displayName: "Entry A" });
      await seedSecondEntry(a.group_id, rig.division.id, 1500, "Entry B");
      await mintGroupCheckout(a.group_id, rig.division.id, ORIGIN, accessToken);
      const sAB = (await cartPointer(a.id))!;
      const now = new Date();
      stripeMock.store.get(sAB)!.expires_at = Math.floor(now.getTime() / 1000) + 9 * 60;

      await resumeRegistrationCheckout(a.id, accessToken, ORIGIN, now);

      expect(stripeMock.checkoutExpire).not.toHaveBeenCalledWith(sAB);
      expect(stripeMock.store.get(sAB)!.status).toBe("open");
    });
  });

  it("a sign-up session covering [A,B] is not handed to A's Pay (it would charge B too); A's own session then is, on the next press", async () => {
    const { rig, reg: a, accessToken } = await cardEntry({ displayName: "Entry A" });
    const b = await seedSecondEntry(a.group_id, rig.division.id, 1500, "Entry B");
    await mintGroupCheckout(a.group_id, rig.division.id, ORIGIN, accessToken);
    const sAB = (await cartPointer(a.id))!;
    expect(stripeMock.store.get(sAB)!.metadata.registration_ids?.split(",").sort(), "premise").toEqual([a.id, b.id].sort());

    const first = await resumeRegistrationCheckout(a.id, accessToken, ORIGIN);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
    expect(createdParams(1).metadata?.registration_ids).toBe(a.id);
    const sA = (await cartPointer(a.id))!;
    expect(first.checkout_url).toBe(stripeMock.store.get(sA)!.url);

    const second = await resumeRegistrationCheckout(a.id, accessToken, ORIGIN);
    expect(second.checkout_url, "the second press reuses A's own session").toBe(first.checkout_url);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
  });

  describe("the payment page's session, after a sibling moved the cart pointer", () => {
    /** A pays from its page (both pointers = csA), then B's status-page Pay moves the cart pointer to B's own session. */
    async function pageSessionThenSibling() {
      const { rig, reg: a, accessToken } = await cardEntry({ displayName: "Entry A" });
      const b = await seedSecondEntry(a.group_id, rig.division.id, 1500, "Entry B");
      await payFromPayPage(await linkFor(a), ORIGIN);
      const csA = (await payPointer(a.id))!;
      await resumeRegistrationCheckout(b.id, accessToken, ORIGIN);
      expect(await cartPointer(a.id), "premise: the cart pointer moved to the sibling's session").not.toBe(csA);
      return { a, accessToken, csA };
    }

    it("still open with plenty left → handed out again, no create", async () => {
      const { a, accessToken, csA } = await pageSessionThenSibling();
      const creates = stripeMock.checkoutCreate.mock.calls.length;

      const { checkout_url } = await resumeRegistrationCheckout(a.id, accessToken, ORIGIN);

      expect(checkout_url).toBe(stripeMock.store.get(csA)!.url);
      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(creates);
      expect(payableFor(a.id)).toEqual([csA]);
    });

    it("open but inside the margin → expired BEFORE the mint, so A never holds two payable sessions", async () => {
      const { a, accessToken, csA } = await pageSessionThenSibling();
      const now = new Date();
      stripeMock.store.get(csA)!.expires_at = Math.floor(now.getTime() / 1000) + 5 * 60;
      const creates = stripeMock.checkoutCreate.mock.calls.length;

      await resumeRegistrationCheckout(a.id, accessToken, ORIGIN, now);

      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(creates + 1);
      expect(stripeMock.checkoutExpire).toHaveBeenCalledWith(csA);
      const expireOrder = stripeMock.checkoutExpire.mock.invocationCallOrder.at(-1)!;
      const createOrder = stripeMock.checkoutCreate.mock.invocationCallOrder.at(-1)!;
      expect(expireOrder, "the old one is retired before the new one exists").toBeLessThan(createOrder);
      const fresh = (await cartPointer(a.id))!;
      expect(payableFor(a.id)).toEqual([fresh]);
    });

    it("paid in another tab between the read and the expire → 409 PAID_ONLINE, zero create (never a second session beside it)", async () => {
      const { a, accessToken, csA } = await pageSessionThenSibling();
      const now = new Date();
      stripeMock.store.get(csA)!.expires_at = Math.floor(now.getTime() / 1000) + 5 * 60;
      stripeMock.checkoutExpire.mockImplementationOnce(async (id: string) => {
        payInStripe(id);
        throw Object.assign(new Error('Only Checkout Sessions with a status in ["open"] can be expired.'), { statusCode: 400 });
      });
      const creates = stripeMock.checkoutCreate.mock.calls.length;

      const err = await rejection(resumeRegistrationCheckout(a.id, accessToken, ORIGIN, now));

      expect(err.status).toBe(409);
      expect(err.code).toBe("REGISTRATION_PAID_ONLINE");
      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(creates);
    });

    it("an expire that fails while it is still open → 502, zero create (fail-closed, as the page itself)", async () => {
      const { a, accessToken, csA } = await pageSessionThenSibling();
      const now = new Date();
      stripeMock.store.get(csA)!.expires_at = Math.floor(now.getTime() / 1000) + 5 * 60;
      stripeMock.checkoutExpire.mockRejectedValueOnce(new Error("stripe down"));
      const creates = stripeMock.checkoutCreate.mock.calls.length;

      const err = await rejection(resumeRegistrationCheckout(a.id, accessToken, ORIGIN, now));

      expect(err.status).toBe(502);
      expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(creates);
      expect(payableFor(a.id)).toEqual([csA]);
    });
  });

  it("the refusals outrank reuse: a passed deadline → 422 and Connect off → 503, nothing handed out (counted)", async () => {
    const cases: [string, (r: { rig: StripeRigResult; groupId: string }) => Promise<void>, number][] = [
      ["deadline passed", ({ groupId }) => sql`update registration_groups set expires_at = now() - interval '1 minute' where id = ${groupId}`.then(() => undefined), 422],
      ["Connect off", ({ rig }) => sql`update organizations set stripe_charges_enabled = false where id = ${rig.orgId}`.then(() => undefined), 503],
    ];
    let checked = 0;
    for (const [label, apply, status] of cases) {
      const { rig, reg, accessToken } = await signedUp();
      await apply({ rig, groupId: reg.group_id });
      stripeMock.checkoutRetrieve.mockClear();
      const err = await rejection(resumeRegistrationCheckout(reg.id, accessToken, ORIGIN));
      expect(err.status, label).toBe(status);
      expect(stripeMock.checkoutRetrieve, `${label}: the stored session is never looked at, so never handed out`).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
  });

  it("the payment page after a decline on its own session → the SAME session (the rule holds on both Pay buttons)", async () => {
    const { reg } = await cardEntry();
    const token = await linkFor(reg);
    const first = await payFromPayPage(token, ORIGIN);
    const s1 = (await payPointer(reg.id))!;
    EVENTS[0]![1](stripeMock.store.get(s1)!); // declined

    const again = await payFromPayPage(token, ORIGIN);

    expect(again).toBe(first);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.checkoutExpire).not.toHaveBeenCalled();
  });

  it("ruling: the payment page never hands out the cart's sign-up session (its return URL carries the cart's access token) - it mints once, and the sign-up session is retired", async () => {
    const { reg, s0 } = await signedUp();
    expect(stripeMock.checkoutCreate.mock.calls[0]![0].success_url, "premise: the sign-up session returns with the access token").toContain("token=");
    const token = await linkFor(reg);

    const url = await payFromPayPage(token, ORIGIN);

    const own = (await payPointer(reg.id))!;
    expect(own).not.toBe(s0);
    expect(url).toBe(stripeMock.store.get(own)!.url);
    expect(createdParams(1).success_url).not.toContain("token=");
    expect(stripeMock.store.get(s0)!.status, "never two payable sessions").toBe("expired");
    expect(payableFor(reg.id)).toEqual([own]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Polish wave P5, P1-review carry (a): the cart holds ONE session pointer. A's status-page Pay minted SA, sibling B's Pay moved the
// cart pointer to SB, and A's next Pay saw neither SA (not on the cart any more, not on A's own pointer) and minted SA2: two payable
// sessions for A. Rule under test (owner-approved rec): the status page's per-entry session is recorded on the ENTRY's pointer
// (`registrations.pay_session_id`, the one the payment page uses), so A's next Pay finds it - handed out again while reusable,
// expired before any mint otherwise. And the payment page never hands that session out (its return carries the cart's access
// token, P1 Ruling 1): it expires it and mints its own.
// ---------------------------------------------------------------------------------------------------------------------------------
describe("returnsToPayPage: whose page a stored session returns to (P5 carry a)", () => {
  it("only a session returning to /r/pay/<token> is the payment page's; the status page's, a missing or unreadable URL are not (counted)", () => {
    const cases: [string | null, boolean][] = [
      [`${ORIGIN}/r/pay/tok_abc?src=pay&checkout=success&session_id={CHECKOUT_SESSION_ID}`, true],
      [`${ORIGIN}/live/org/comp/register/status?rid=g1&token=reg_secret&checkout=success`, false],
      [`${ORIGIN}/r/ABC123?src=email&checkout=success`, false],
      [null, false],
      ["not a url", false],
    ];
    let checked = 0;
    for (const [url, want] of cases) {
      expect(returnsToPayPage({ success_url: url }), String(url)).toBe(want);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
  });
});

describe.skipIf(!HAS_DB)("A → sibling B → A on the status page: one payable session per entry (P5 carry a)", () => {
  async function cartPointer(regId: string): Promise<string | null> {
    return (await loadWithGroup(regId)).checkout_session_id;
  }
  /** A card cart [A, B]; A presses Pay on the status page, then B does. */
  async function aThenB() {
    const { rig, reg: a, accessToken } = await cardEntry({ displayName: "Entry A" });
    const b = await seedSecondEntry(a.group_id, rig.division.id, 1500, "Entry B");
    const first = await resumeRegistrationCheckout(a.id, accessToken, ORIGIN);
    const sa = (await cartPointer(a.id))!;
    await resumeRegistrationCheckout(b.id, accessToken, ORIGIN);
    const sb = (await cartPointer(a.id))!;
    expect(sb, "premise: B's Pay moved the cart pointer off A's session").not.toBe(sa);
    expect(stripeMock.store.get(sa)!.status, "premise: B's mint does not expire A's session (disjoint)").toBe("open");
    return { a, b, accessToken, sa, sb, firstUrl: first.checkout_url };
  }

  it("empty case: A's first Pay records its session on A's own pointer", async () => {
    const { reg: a, accessToken } = await cardEntry();
    expect(await payPointer(a.id), "premise: nothing recorded yet").toBeNull();
    await resumeRegistrationCheckout(a.id, accessToken, ORIGIN);
    expect(await payPointer(a.id)).toBe(await cartPointer(a.id));
  });

  it("A → B → A: A's second Pay hands out SA again - no create, one payable session for each entry", async () => {
    const { a, b, accessToken, sa, sb, firstUrl } = await aThenB();
    const creates = stripeMock.checkoutCreate.mock.calls.length;

    const again = await resumeRegistrationCheckout(a.id, accessToken, ORIGIN);

    expect(again.checkout_url).toBe(firstUrl);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(creates);
    expect(payableFor(a.id)).toEqual([sa]);
    expect(payableFor(b.id)).toEqual([sb]);
  });

  it("A → B → A with SA inside the margin: SA is expired BEFORE the mint, so A still holds exactly one payable session", async () => {
    const { a, accessToken, sa } = await aThenB();
    const now = new Date();
    stripeMock.store.get(sa)!.expires_at = Math.floor(now.getTime() / 1000) + 5 * 60;
    const creates = stripeMock.checkoutCreate.mock.calls.length;

    await resumeRegistrationCheckout(a.id, accessToken, ORIGIN, now);

    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(creates + 1);
    const expireOrder = stripeMock.checkoutExpire.mock.invocationCallOrder.at(-1)!;
    expect(expireOrder).toBeLessThan(stripeMock.checkoutCreate.mock.invocationCallOrder.at(-1)!);
    const fresh = (await payPointer(a.id))!;
    expect(fresh).not.toBe(sa);
    expect(payableFor(a.id)).toEqual([fresh]);
  });

  it("A → B → A → B → A (sequence): every press of each entry lands on that entry's one session", async () => {
    const { a, b, accessToken, sa, sb } = await aThenB();
    for (let i = 0; i < 2; i++) {
      await resumeRegistrationCheckout(a.id, accessToken, ORIGIN);
      await resumeRegistrationCheckout(b.id, accessToken, ORIGIN);
    }
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
    expect(payableFor(a.id)).toEqual([sa]);
    expect(payableFor(b.id)).toEqual([sb]);
  });

  it("the payment page never hands out the status page's session (it returns with the cart's token): expired, then its own mint", async () => {
    const { reg: a, accessToken } = await cardEntry();
    await resumeRegistrationCheckout(a.id, accessToken, ORIGIN);
    const sa = (await payPointer(a.id))!;
    expect(stripeMock.store.get(sa)!.success_url, "premise: the status page's session returns with the access token").toContain("token=");
    const token = await linkFor(a);

    const url = await payFromPayPage(token, ORIGIN);

    const own = (await payPointer(a.id))!;
    expect(own).not.toBe(sa);
    expect(url).toBe(stripeMock.store.get(own)!.url);
    expect(stripeMock.store.get(own)!.success_url).not.toContain("token=");
    expect(stripeMock.store.get(sa)!.status, "never two payable sessions").toBe("expired");
    expect(payableFor(a.id)).toEqual([own]);
    // ...and the page's own session is then handed out again on its next press (the reuse rule still holds for its own).
    expect(await payFromPayPage(token, ORIGIN)).toBe(url);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Registration redesign B1 T5 (spec 2026-11-13 §3.3 item 3): the register route hands `mintGroupCheckout` the cart the submit has
// just written (`known_cart`): its payment method, its payable entry ids in cart order and its division context. The mint then skips
// its three reads of the same facts (the cart's method, its payable ids, the division context) and must create EXACTLY the session
// it would have created from those reads. The oracle for "the same session" is the mint's own read path on the same cart, in the
// same state; the oracle for "three fewer" is the three statements the read path issues and the known path does not.
//
// Sport: not applicable (Checkout is sport-agnostic).
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("mintGroupCheckout with the cart the submit just wrote (registration redesign B1 T5)", () => {
  /** A card cart of two pending paid entries and one waitlisted entry (never payable), and the known cart the submit would hand over. */
  async function cardCart() {
    const { rig, reg: a, accessToken } = await cardEntry();
    const b = await seedSecondEntry(a.group_id, rig.division.id, 1500, "Entry B");
    const w = await seedSecondEntry(a.group_id, rig.division.id, 1500, "Entry W", "waitlisted");
    const known: KnownCart = { paymentMethod: "stripe", payableIds: [a.id, b.id], ctx: await divisionCtx(sql, rig.division.id) };
    return { rig, a, b, w, accessToken, known };
  }

  /** Statements issued by one call. */
  async function counted<T>(fn: () => Promise<T>): Promise<{ value: T; statements: number }> {
    const before = statementCount();
    const value = await fn();
    return { value, statements: statementCount() - before };
  }

  /** Back to the state before any mint: no session stamped on the cart, so the next mint takes the same path as the first. */
  async function unstamp(groupId: string): Promise<void> {
    await sql`update registration_groups set checkout_session_id = null where id = ${groupId}`;
  }

  /** The same cart minted twice in the same state: once from the mint's own reads, once from the known cart. */
  async function bothWays() {
    const warm = await cardCart();
    await mintGroupCheckout(warm.a.group_id, warm.rig.division.id, ORIGIN, warm.accessToken); // warm-up: first-use caches, either way
    const c = await cardCart();
    stripeMock.checkoutCreate.mockClear();
    const read = await counted(() => mintGroupCheckout(c.a.group_id, c.rig.division.id, ORIGIN, c.accessToken));
    await unstamp(c.a.group_id);
    const known = await counted(() => mintGroupCheckout(c.a.group_id, c.rig.division.id, ORIGIN, c.accessToken, c.known));
    return { c, read, known };
  }

  it("mint with known cart issues 3 fewer statements than without (same cart, same state)", async () => {
    const { read, known } = await bothWays();
    expect(read.value, "premise: the read path minted").toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(known.value, "premise: the known path minted").toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(read.statements - known.statements, `read path ${read.statements}, known path ${known.statements}`).toBe(3);
  });

  it("mint with known cart creates the same Stripe session params, naming only the payable entries", async () => {
    const { c } = await bothWays();
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
    const [viaRead, viaKnown] = [createdParams(0), createdParams(1)];
    expect(viaKnown).toEqual(viaRead);
    // Anti-vacuity: the compared params do carry the cart, and never the waitlisted entry.
    expect(viaKnown.metadata!.registration_ids).toBe([c.a.id, c.b.id].join(","));
    expect(String(viaKnown.metadata!.registration_ids)).not.toContain(c.w.id);
    expect(viaKnown.line_items, "one line per payable entry").toHaveLength(2);
  });

  it("known.payableIds empty returns null without a read or a Stripe call (the empty case)", async () => {
    const c = await cardCart();
    const out = await counted(() =>
      mintGroupCheckout(c.a.group_id, c.rig.division.id, ORIGIN, c.accessToken, { ...c.known, payableIds: [] }),
    );
    expect(out).toEqual({ value: null, statements: 0 });
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it.each([["offline" as const], [null]])("known.paymentMethod %j returns null without a read or a Stripe call", async (paymentMethod) => {
    const c = await cardCart();
    const out = await counted(() =>
      mintGroupCheckout(c.a.group_id, c.rig.division.id, ORIGIN, c.accessToken, { ...c.known, paymentMethod }),
    );
    expect(out).toEqual({ value: null, statements: 0 });
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("keeps the 503 when the known context says Connect is not live, before any Stripe call", async () => {
    const c = await cardCart();
    const err = await rejection(
      mintGroupCheckout(c.a.group_id, c.rig.division.id, ORIGIN, c.accessToken, { ...c.known, ctx: { ...c.known.ctx, charges_enabled: false } }),
    );
    expect(err.status).toBe(503);
    expect(err.message).toBe("Payments are not set up for this organiser yet");
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("refuses a known cart whose context is another division's, before a read or a Stripe call", async () => {
    const c = await cardCart();
    const other = await cardCart();
    const before = statementCount();
    await expect(
      mintGroupCheckout(c.a.group_id, c.rig.division.id, ORIGIN, c.accessToken, { ...c.known, ctx: other.known.ctx }),
    ).rejects.toThrow("mintGroupCheckout: the known cart's context is not the division asked for");
    expect(statementCount() - before).toBe(0);
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("the sequence: a second mint from the same known cart supersedes the first, leaving one payable session per entry", async () => {
    const c = await cardCart();
    const first = await mintGroupCheckout(c.a.group_id, c.rig.division.id, ORIGIN, c.accessToken, c.known);
    const second = await mintGroupCheckout(c.a.group_id, c.rig.division.id, ORIGIN, c.accessToken, c.known);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    for (const id of [c.a.id, c.b.id]) expect(payableFor(id), `entry ${id}`).toHaveLength(1);
    expect(payableFor(c.w.id)).toEqual([]);
  });
});
