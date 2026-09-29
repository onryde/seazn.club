// Reconcile-on-return for a match-credit purchase (Task 14 fix round 1, G1).
//
// The embedded checkout sends the buyer straight back to the division page's
// `?checkout=success&session_id=…` URL, and that render can happen BEFORE
// Stripe's webhook arrives — so the club that just paid was shown "Buy match
// credits" again. The page now reconciles the session itself, the way the
// billing, upgrade and registration pages already do. This is a MONEY path, so
// every refusal below is its own test and its own mutant:
//
//   * THIS org's settled relay session → exactly one purchase row;
//   * a replay — reconcile twice, reconcile then the webhook, the webhook then
//     reconcile — still exactly one row (both writers go through the SAME
//     idempotent `recordPurchase`, keyed on the Checkout Session id);
//   * unpaid, open, another org's, a non-relay session, and a Stripe read that
//     throws → nothing written and NO throw (a throw here would 500 the page
//     the buyer is returning to).
//
// The ledger ROW COUNT is asserted directly, never inferred from the balance: a
// second row carrying a compensating delta would leave the balance unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { seedOrg } from "./_rig";
import { runEvent } from "../billing-events";
import { creditBalance } from "../stream-credits";
import { reconcileStreamCreditsCheckout } from "../stream-credits-checkout";
import { buildRelayCheckoutParams } from "@/lib/relay-checkout";
import { streamPack } from "@/lib/stream-credit-packs";

vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendStreamCreditGrantFailedAlertEmail: vi.fn(async () => true),
}));

// The ONE Stripe call the reconcile makes is `checkout.sessions.retrieve`; the
// table below is what Stripe "holds". Anything else (customers.retrieve, via
// linkStripeCustomer's card-flag re-derivation) rejects, and that path swallows
// its own failure — the assertions read the DATABASE, never this double.
const stripeHolds = vi.hoisted(() => new Map<string, unknown>());
const retrieve = vi.hoisted(() => vi.fn());
vi.mock("@/lib/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stripe")>()),
  getStripe: () => ({
    checkout: { sessions: { retrieve } },
    customers: { retrieve: async () => { throw new Error("no customers in this suite"); } },
  }),
}));

const HAS_DB = !!process.env.DATABASE_URL;

/** A Checkout Session as Stripe returns it on retrieve. The metadata is the REAL
 *  builder's (lib/relay-checkout.ts), so a renamed key reds here rather than being
 *  typed identically on both ends. */
function relaySession(orgId: string, id: string, over: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  const pack = streamPack(5)!;
  const params = buildRelayCheckoutParams({
    priceId: "price_test", orgId, fixtureId: "00000000-0000-4000-8000-000000000000", pack, returnUrl: "https://x.test/r",
  });
  return {
    id,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    currency: "gbp",
    amount_total: 2500,
    customer: null,
    payment_intent: `pi_${id}`,
    metadata: params.metadata as Record<string, string>,
    ...over,
  } as Stripe.Checkout.Session;
}

function completedEvent(session: Stripe.Checkout.Session): Stripe.Event {
  return {
    id: `evt_${session.id}`,
    type: "checkout.session.completed",
    data: { object: session },
  } as unknown as Stripe.Event;
}

async function purchaseRows(orgId: string): Promise<{ delta: number; stripe_event_id: string }[]> {
  return sql<{ delta: number; stripe_event_id: string }[]>`
    select delta, stripe_event_id from org_stream_credits where org_id = ${orgId} and reason = 'purchase'`;
}

describe.skipIf(!HAS_DB)("reconcileStreamCreditsCheckout — the return render learns the purchase itself", () => {
  beforeEach(() => {
    stripeHolds.clear();
    retrieve.mockReset();
    retrieve.mockImplementation(async (id: string) => {
      const s = stripeHolds.get(id);
      if (!s) throw Object.assign(new Error(`No such checkout.session: '${id}'`), { statusCode: 404 });
      return s;
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("THIS org's settled relay session: one purchase row for the pack's credits, and the balance moves", async () => {
    const { auth } = await seedOrg();
    const sid = `cs_test_rec_paid_${auth.orgId.slice(0, 8)}`;
    stripeHolds.set(sid, relaySession(auth.orgId, sid));
    expect(await reconcileStreamCreditsCheckout(auth.orgId, sid)).toBe(true);
    expect(retrieve).toHaveBeenCalledWith(sid);
    // The pack's credits off the CATALOGUE (the builder snapshotted them into metadata.credits), never a typed 5.
    expect(await purchaseRows(auth.orgId)).toEqual([{ delta: streamPack(5)!.credits, stripe_event_id: sid }]);
    expect(await creditBalance(sql, auth.orgId)).toBe(streamPack(5)!.credits);
  });

  it("a replay converges on ONE row: reconcile twice, reconcile then the webhook, the webhook then reconcile", async () => {
    let checked = 0;
    for (const order of [["reconcile", "reconcile"], ["reconcile", "webhook"], ["webhook", "reconcile"]] as const) {
      const { auth } = await seedOrg();
      const sid = `cs_test_rec_${order.join("_")}_${auth.orgId.slice(0, 8)}`;
      const session = relaySession(auth.orgId, sid);
      stripeHolds.set(sid, session);
      for (const writer of order) {
        if (writer === "reconcile") expect(await reconcileStreamCreditsCheckout(auth.orgId, sid), order.join("→")).toBe(true);
        else expect(await runEvent(completedEvent(structuredClone(session))), order.join("→")).toBe(true);
      }
      expect(await purchaseRows(auth.orgId), order.join("→")).toHaveLength(1);
      expect(await creditBalance(sql, auth.orgId), order.join("→")).toBe(streamPack(5)!.credits);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("an UNPAID session (complete, payment still pending) writes nothing", async () => {
    const { auth } = await seedOrg();
    const sid = `cs_test_rec_unpaid_${auth.orgId.slice(0, 8)}`;
    stripeHolds.set(sid, relaySession(auth.orgId, sid, { payment_status: "unpaid" }));
    expect(await reconcileStreamCreditsCheckout(auth.orgId, sid)).toBe(false);
    expect(await purchaseRows(auth.orgId)).toEqual([]);
  });

  it("an OPEN session writes nothing — whatever its payment_status says, a checkout the buyer has not completed grants nothing", async () => {
    // `status` and `payment_status` are separate fields on a Checkout Session. The settled gate reads the second; this
    // one reads the first — so it is driven with a payment_status the settled gate ACCEPTS, or the two guards would
    // cover for each other and neither would be tested (AGENTS.md class 3).
    const { auth } = await seedOrg();
    const sid = `cs_test_rec_open_${auth.orgId.slice(0, 8)}`;
    stripeHolds.set(sid, relaySession(auth.orgId, sid, { status: "open", payment_status: "no_payment_required" }));
    expect(await reconcileStreamCreditsCheckout(auth.orgId, sid)).toBe(false);
    expect(await purchaseRows(auth.orgId)).toEqual([]);
  });

  it("ANOTHER org's session writes nothing for either org, and does not throw — the caller's org is not the payer", async () => {
    const payer = (await seedOrg()).auth;
    const visitor = (await seedOrg()).auth;
    const sid = `cs_test_rec_other_${payer.orgId.slice(0, 8)}`;
    stripeHolds.set(sid, relaySession(payer.orgId, sid));
    await expect(reconcileStreamCreditsCheckout(visitor.orgId, sid)).resolves.toBe(false);
    expect(await purchaseRows(visitor.orgId)).toEqual([]);
    expect(await purchaseRows(payer.orgId), "the payer's grant is the webhook's, or its own return render's").toEqual([]);
  });

  it("a NON-relay session (the AI credit wallet's credit_pack, a plan) writes no match credits", async () => {
    const { auth } = await seedOrg();
    let checked = 0;
    for (const kind of ["credit_pack", undefined] as const) {
      const sid = `cs_test_rec_kind_${kind ?? "none"}_${auth.orgId.slice(0, 8)}`;
      const base = relaySession(auth.orgId, sid);
      const metadata = { ...base.metadata } as Record<string, string>;
      if (kind) metadata.kind = kind;
      else delete metadata.kind;
      stripeHolds.set(sid, { ...base, metadata });
      expect(await reconcileStreamCreditsCheckout(auth.orgId, sid), String(kind)).toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
    expect(await purchaseRows(auth.orgId)).toEqual([]);
  });

  it("a Stripe read that throws (an unknown id, an outage) is false, never a throw that 500s the return render", async () => {
    const { auth } = await seedOrg();
    await expect(reconcileStreamCreditsCheckout(auth.orgId, "cs_test_unknown")).resolves.toBe(false);
    retrieve.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(reconcileStreamCreditsCheckout(auth.orgId, "cs_test_outage")).resolves.toBe(false);
    expect(await purchaseRows(auth.orgId)).toEqual([]);
  });
});
