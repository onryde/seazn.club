// Phase 3 wave 2, T10 (F7): a webhook writes ONE outbox row per Stripe event, whether Stripe redelivers the event or the event is
// re-run after a crash.
//
// There are two kinds of replay, and only the second can fail:
//  - REDELIVERED. The same event id arrives again after the ledger stamped it processed. `runEvent` returns false at the ledger claim
//    and never reaches the handler. As a row count this cannot fail (P-W2-9), so it is kept as a pin of the claim.
//  - RE-CLAIMED after a crash. The ledger row is put back the way a crash mid-handler leaves it (`processed_at` null) with its lease
//    aged past the 10 minutes `runEvent` honours. The next `runEvent` takes the lease over and RE-RUNS the handler, so the producer runs
//    twice for one event. Only its own transition guard or its once-key keeps a second row out.
//
// Each kind is driven by its real Stripe event shape through the real `runEvent`: the ledger claim, then the dispatch table the webhook
// and the staff replay share. Nothing reaches Stripe. The dispute events name no `charge`, so the lost legs skip the balance recovery,
// and every other handler on these paths reads the database only. The suite asserts that `getStripe` is never called. Only the outbox
// transport is replaced.
//
// What holds each kind on the re-run:
//  - registration_dispute_alert, sponsor_dispute_alert: the transition to this dispute (read under lock), then the once-key;
//  - sponsor_dispute_won: the flag's clear (read under lock), then the once-key;
//  - sponsor_receipt: the order's pending -> paid transition, then the once-key (the payment intent);
//  - sponsor_refund: the order's paid -> refunded transition, then the once-key;
//  - pass_revoked: the pass row's delete, then the once-key (the charge id). Its ref id IS its once-key, so a mutant that changes the key
//    also moves the row's ref: that leg then finds no row at all. That is the mutant's artifact, not a second row;
//  - registration_dispute_lost, sponsor_dispute_lost: the once-key alone. With no charge there is no reversal, so the `already` gate
//    stays open on the re-run (P-W2-4 was not built). This suite is their once-key's killer.
//  - trial_ending: the once-key alone (the Stripe event id).
//
// Not here: `sponsor_invoice` (a console request, not a webhook), and a re-run after a LATER handler of the same dispatch threw (Rare
// case 7; owner, 2026-10-26: dropped).
//
// Sport: not applicable. These emails do not vary by sport (spec, Test strategy 4).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

// The one network seam of the outbox.
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

// Stripe is never reached on these paths: a call is a failure, and it is asserted, not only thrown (a handler may swallow the throw).
const getStripeMock = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("this suite makes no Stripe call");
  }),
);
vi.mock("@/lib/stripe", async (io) => ({ ...(await io<typeof import("@/lib/stripe")>()), getStripe: getStripeMock }));

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import type { OutboxKind } from "@/server/email-outbox";
import { runEvent } from "../billing-events";
import { handleRegistrationCheckoutCompleted } from "../registrations";
import { stubOutboxEnv } from "./_invite-mail";
import { cleanUpSponsorOrgs, seedPassOrg, seedSponsorOrder, seedTrialingGroup } from "./_money-fixtures";
import { fakeSession, seedRegistration, stripeRig } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const FEE = 1200;

/** Typed from the spec's kind table: every wave-2 kind a Stripe webhook produces (all but `sponsor_invoice`), in the table's order. */
const SPEC_WEBHOOK_KINDS: readonly OutboxKind[] = [
  "registration_dispute_alert",
  "registration_dispute_lost",
  "sponsor_receipt",
  "sponsor_refund",
  "sponsor_dispute_alert",
  "sponsor_dispute_won",
  "sponsor_dispute_lost",
  "pass_revoked",
  "trial_ending",
];

const made = { orgIds: [] as string[], userIds: [] as string[], eventIds: [] as string[] };

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from billing_events where id = any(${made.eventIds}::text[])`;
  // The trial warning names no organisation, so it is found by its payer.
  await sql`delete from email_outbox where recipient_user_id = any(${made.userIds}::uuid[])`;
  await cleanUpSponsorOrgs(made.orgIds, made.userIds);
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

beforeEach(() => {
  stubOutboxEnv();
  getStripeMock.mockClear();
  deliverMock.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_f7_${randomUUID()}` }));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Stripe events, as the webhook receives them (a fresh event id each)
// ---------------------------------------------------------------------------------------------------------------------------------

const eventOf = (type: string, object: Record<string, unknown>): Stripe.Event => {
  const id = `evt_f7_${RUN}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  made.eventIds.push(id);
  return { id, type, created: Math.floor(Date.now() / 1000), data: { object } } as unknown as Stripe.Event;
};

/** `charge.dispute.created` / `.closed` for a payment intent. No `charge`: the lost legs' balance recovery is skipped. */
const disputeEvent = (phase: "created" | "closed", disputeId: string, intent: string, amount: number, status: string) =>
  eventOf(`charge.dispute.${phase}`, { id: disputeId, object: "dispute", payment_intent: intent, amount, status });

/** `charge.refunded` for a full refund of a payment intent. */
const refundedEvent = (chargeId: string, intent: string, amount: number) =>
  eventOf("charge.refunded", { id: chargeId, object: "charge", payment_intent: intent, refunded: true, amount_refunded: amount });

let seq = 0;
/** An id unique to this run (the once-key index is global, so a fixed id would meet an earlier run's row). */
const newId = (prefix: string): string => `${prefix}_f7_${RUN}_${++seq}`;

// ---------------------------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------------------------

/** A card-paid entry (the real checkout webhook confirmed it) in a fresh org: the payment intent a dispute names. */
async function paidEntryIntent(): Promise<string> {
  const w = await stripeRig({ feeCents: FEE });
  made.orgIds.push(w.orgId);
  made.userIds.push(w.ownerId);
  const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: `f7-${RUN}-${++seq}@test.local` });
  await handleRegistrationCheckoutCompleted(fakeSession(registration.id, FEE));
  const [cart] = await sql<{ payment_intent_id: string | null }[]>`select payment_intent_id from registration_groups where id = ${registration.group_id}`;
  expect(cart?.payment_intent_id, "premise: the paid cart carries its payment intent").toBeTruthy();
  return cart!.payment_intent_id!;
}

async function sponsorOrder(status: "pending" | "paid") {
  const o = await seedSponsorOrder({ status, prefix: `f7-${RUN}` });
  made.orgIds.push(o.orgId);
  made.userIds.push(o.ownerId);
  return o;
}

/** One leg: the events that come before (a won or lost dispute was created first), the event under test, and where its row lives. */
type Leg = { before: Stripe.Event[]; event: Stripe.Event; refType: string; refId: string };

const LEGS: Readonly<Record<string, () => Promise<Leg>>> = {
  registration_dispute_alert: async () => {
    const intent = await paidEntryIntent();
    const disputeId = newId("dp");
    return { before: [], event: disputeEvent("created", disputeId, intent, FEE, "needs_response"), refType: "dispute", refId: disputeId };
  },
  registration_dispute_lost: async () => {
    const intent = await paidEntryIntent();
    const disputeId = newId("dp");
    return {
      before: [disputeEvent("created", disputeId, intent, FEE, "needs_response")],
      event: disputeEvent("closed", disputeId, intent, FEE, "lost"),
      refType: "dispute",
      refId: disputeId,
    };
  },
  sponsor_receipt: async () => {
    const o = await sponsorOrder("pending");
    const event = eventOf("payment_intent.succeeded", { id: o.intent, object: "payment_intent", metadata: { kind: "sponsor", order_id: o.orderId } });
    return { before: [], event, refType: "sponsor_order", refId: o.orderId };
  },
  sponsor_refund: async () => {
    const o = await sponsorOrder("paid");
    return { before: [], event: refundedEvent(newId("ch"), o.intent, 25000), refType: "sponsor_order", refId: o.orderId };
  },
  sponsor_dispute_alert: async () => {
    const o = await sponsorOrder("paid");
    const disputeId = newId("dp");
    return { before: [], event: disputeEvent("created", disputeId, o.intent, 25000, "needs_response"), refType: "dispute", refId: disputeId };
  },
  sponsor_dispute_won: async () => {
    const o = await sponsorOrder("paid");
    const disputeId = newId("dp");
    return {
      before: [disputeEvent("created", disputeId, o.intent, 25000, "needs_response")],
      event: disputeEvent("closed", disputeId, o.intent, 25000, "won"),
      refType: "dispute",
      refId: disputeId,
    };
  },
  sponsor_dispute_lost: async () => {
    const o = await sponsorOrder("paid");
    const disputeId = newId("dp");
    return {
      before: [disputeEvent("created", disputeId, o.intent, 25000, "needs_response")],
      event: disputeEvent("closed", disputeId, o.intent, 25000, "lost"),
      refType: "dispute",
      refId: disputeId,
    };
  },
  pass_revoked: async () => {
    const intent = newId("pi");
    const o = await seedPassOrg({ intent, prefix: `f7-${RUN}` });
    made.orgIds.push(o.orgId);
    made.userIds.push(o.ownerId, o.trapId);
    const chargeId = newId("ch");
    return { before: [], event: refundedEvent(chargeId, intent, 2900), refType: "charge", refId: chargeId };
  },
  trial_ending: async () => {
    const g = await seedTrialingGroup({ hasPaymentMethod: false, prefix: `f7-${RUN}` });
    made.orgIds.push(g.orgId);
    made.userIds.push(g.ownerId);
    const trialEnd = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;
    const event = eventOf("customer.subscription.trial_will_end", {
      id: g.stripeSubId,
      object: "subscription",
      status: "trialing",
      trial_end: trialEnd,
      metadata: {},
    });
    return { before: [], event, refType: "subscription", refId: g.groupId };
  },
};

const rowCount = async (kind: OutboxKind, refType: string, refId: string): Promise<number> =>
  (await sql<{ id: string }[]>`select id from email_outbox where kind = ${kind} and ref_type = ${refType} and ref_id = ${refId}`).length;

describe.skipIf(!HAS_DB)("F7: a redelivered or re-claimed webhook writes no second email row", () => {
  it("every webhook kind writes one row, whether its event is redelivered or re-run after a crash", async () => {
    expect(Object.keys(LEGS), "a leg for exactly the spec's webhook kinds, in its order").toEqual([...SPEC_WEBHOOK_KINDS]);
    // What each kind must show, from the spec: the first delivery runs and writes its one row; a redelivery is refused at the ledger; a
    // re-claim after the lease runs the handler again; and there is still exactly one row (in any status: a replaced row counts).
    const expected = Object.fromEntries(
      SPEC_WEBHOOK_KINDS.map((k) => [k, { first: true, rowsAfterFirst: 1, redelivered: false, rowsAfterRedelivery: 1, reclaimed: true, rowsAfterReclaim: 1 }]),
    );
    const observed: Record<string, unknown> = {};
    let checked = 0;
    for (const kind of SPEC_WEBHOOK_KINDS) {
      const leg = await LEGS[kind]!();
      for (const e of leg.before) expect(await runEvent(e), `premise: ${kind}'s earlier ${e.type} ran`).toBe(true);
      const first = await runEvent(leg.event);
      const rowsAfterFirst = await rowCount(kind, leg.refType, leg.refId);
      const redelivered = await runEvent(leg.event);
      const rowsAfterRedelivery = await rowCount(kind, leg.refType, leg.refId);
      // A crash mid-handler: the ledger row was never stamped, and its lease (10 minutes) has run out.
      const reset = await sql`
        update billing_events set processed_at = null, processing_started_at = now() - interval '11 minutes' where id = ${leg.event.id}`;
      expect(reset.count, `premise: ${kind}'s event has its one ledger row`).toBe(1);
      const reclaimed = await runEvent(leg.event);
      const rowsAfterReclaim = await rowCount(kind, leg.refType, leg.refId);
      observed[kind] = { first, rowsAfterFirst, redelivered, rowsAfterRedelivery, reclaimed, rowsAfterReclaim };
      checked += 1;
    }
    // Judged over the whole table, so a failure names every kind that broke, with what it showed, not just the first one.
    const broken = SPEC_WEBHOOK_KINDS.filter((k) => !isDeepStrictEqual(observed[k], expected[k])).map((k) => ({ kind: k, ...(observed[k] as object) }));
    expect(broken, "the kinds whose replay wrote a second row, or did not run as the ledger says").toEqual([]);
    expect(observed).toEqual(expected);
    expect(checked, "anti-vacuity: every webhook kind was replayed").toBe(9);
    expect(getStripeMock, "nothing reached Stripe").not.toHaveBeenCalled();
  }, 60_000);
});
