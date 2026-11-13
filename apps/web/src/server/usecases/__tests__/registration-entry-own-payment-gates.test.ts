// Registration polish wave, P5 (P1 carry, money semantics): the organiser's Approve, Confirm and Mark paid read the CART's
// payment intent as "this entry paid". On a card cart where only a SIBLING paid, the cart's `payment_intent_id` is the
// sibling's (set by whichever entry paid; `checkout-completion.ts`), so:
// - Approve / Confirm on the UNPAID entry passed their "awaiting payment" gate and seated it without its fee;
// - Mark paid on the unpaid entry was refused "paid by card", although it had paid nothing.
// The rule under test: those gates read THIS entry's own payment (`registrations.payment_intent_id`, V387, read as
// `entry_payment_intent_id`), the one P1's refund fix (133d9ce0d7) moved the refund onto.
// Polish wave P5 (W12): Approve on an entry whose own fee is still due no longer refuses - it APPROVES (stays pending, `approved_at`)
// and seats nobody. The money gate is the same one: what it decides is whether Approve seats the entry, so the assertions below pin
// "not seated, still pending" rather than a 422.
//
// Every payment lands through the REAL webhook core (`handleRegistrationCheckoutCompleted`) with a session naming exactly the
// entry it paid, so the premise (the cart carries the sibling's intent) is the producer's own output, not a hand-seeded column.
//
// Sport: not applicable - the money gates never read the sport.
// Real Postgres required; skipped without DATABASE_URL (matches every sibling usecase suite in this directory).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const stripeMock = vi.hoisted(() => ({ stripe: { refunds: { create: vi.fn() } } }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import {
  confirmRegistration,
  handleRegistrationCheckoutCompleted,
  markRegistrationPaidOffline,
  putRegistrationSettings,
} from "../registrations";
import { approveRegistration } from "../registration-approval";
import { SETTINGS_BASE, fakeSession, loadWithGroup, seedRegistration, seedSecondEntry, stripeRig } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

beforeEach(() => {
  deliverMock.mockReset().mockResolvedValue({ ok: true, providerId: "p5-gates" });
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

function paidSession(regIds: string[], amount: number, tag: string): Stripe.Checkout.Session {
  const s = fakeSession(regIds, amount);
  (s as unknown as { id: string }).id = `cs_test_p5g_${tag}_${regIds[0]!.slice(0, 8)}`;
  (s as unknown as { payment_intent: string }).payment_intent = `pi_test_p5g_${tag}_${regIds[0]!.slice(0, 8)}`;
  return s;
}

/** A card cart of two: Open £15 and Masters £10, both pending. */
async function twoEntryCart(approval: "auto" | "manual") {
  const rig = await stripeRig({ feeCents: 1500 });
  await putRegistrationSettings(rig.owner, rig.division.id, { ...SETTINGS_BASE, payment_method: "stripe", fee_cents: 1500, approval });
  const open = await seedRegistration(rig.competition.id, rig.division.id, rig.settings, { displayName: "Open Singles", amountCents: 1500 });
  const masters = await seedSecondEntry(open.registration.group_id, rig.division.id, 1000, "Masters Singles");
  return { rig, open: open.registration, masters };
}

async function entrantOf(regId: string): Promise<string | null> {
  const [row] = await sql<{ entrant_id: string | null }[]>`select entrant_id from registrations where id = ${regId}`;
  return row!.entrant_id;
}

describe.skipIf(!HAS_DB)("Approve / Confirm / Mark paid read the entry's own payment, never the cart's (P1 carry)", () => {
  it("empty case: nobody in the cart has paid - Approve seats nothing (W12: approved, fee due), Confirm refuses, Mark paid records it", async () => {
    const manual = await twoEntryCart("manual");
    expect((await loadWithGroup(manual.masters.id)).payment_intent_id, "premise: no intent anywhere").toBeNull();
    const approvedDue = await approveRegistration(manual.rig.owner, manual.masters.id);
    expect(approvedDue.status, "approved with its fee due: still pending").toBe("pending");
    expect(approvedDue.approved_at).not.toBeNull();
    expect(await entrantOf(manual.masters.id), "nobody seated without the money").toBeNull();
    const auto = await twoEntryCart("auto");
    expect((await rejection(confirmRegistration(auto.rig.owner, auto.masters.id))).status).toBe(422);
    const marked = await markRegistrationPaidOffline(auto.rig.owner, auto.masters.id);
    expect(marked.status).toBe("confirmed");
  });

  it("only the sibling paid (manual): Approve on the UNPAID entry seats nobody (W12: approved, fee due); the paid sibling approves and is seated", async () => {
    const { rig, open, masters } = await twoEntryCart("manual");
    const paid = paidSession([open.id], 1500, "appr");
    await handleRegistrationCheckoutCompleted(paid);
    const before = await loadWithGroup(masters.id);
    expect(before.payment_intent_id, "premise: the CART carries the sibling's intent").toBe(paid.payment_intent);
    expect(before.entry_payment_intent_id, "premise: the unpaid entry has no payment of its own").toBeNull();
    expect(before.status).toBe("pending");

    const due = await approveRegistration(rig.owner, masters.id);
    expect(due.approved_at, "the approval is recorded").not.toBeNull();
    expect((await loadWithGroup(masters.id)).status, "the unpaid entry is not confirmed (the sibling's payment is not its own)").toBe("pending");
    expect(await entrantOf(masters.id), "and no entrant was seated for it").toBeNull();

    // The positive pair: the entry that DID pay approves and is seated.
    const approved = await approveRegistration(rig.owner, open.id);
    expect(approved.status).toBe("confirmed");
    expect(await entrantOf(open.id)).not.toBeNull();
  });

  it("only the sibling paid (auto): Confirm on the UNPAID entry refuses 422; Mark paid is NOT refused as 'paid by card' and confirms it", async () => {
    const { rig, open, masters } = await twoEntryCart("auto");
    const paid = paidSession([open.id], 1500, "conf");
    await handleRegistrationCheckoutCompleted(paid);
    expect((await loadWithGroup(open.id)).status, "premise: the sibling's payment confirmed it").toBe("confirmed");
    expect((await loadWithGroup(masters.id)).payment_intent_id, "premise: the CART carries the sibling's intent").toBe(paid.payment_intent);

    const err = await rejection(confirmRegistration(rig.owner, masters.id));
    expect(err.status).toBe(422);
    expect(await entrantOf(masters.id)).toBeNull();

    const marked = await markRegistrationPaidOffline(rig.owner, masters.id);
    expect(marked.status).toBe("confirmed");
    expect(marked.entry_payment_intent_id, "an offline payment carries no card intent").toBeNull();
  });

  it("an entry that paid by card itself is still refused Mark paid (its money trail is on Stripe) - sequence: pay, then mark", async () => {
    const { rig, masters } = await twoEntryCart("manual");
    await handleRegistrationCheckoutCompleted(paidSession([masters.id], 1000, "self"));
    // Manual approval leaves it at 'paid'; mark-paid only ever applied to pending, and a card-paid entry must stay refused.
    const err = await rejection(markRegistrationPaidOffline(rig.owner, masters.id));
    expect(err.status).toBe(422);
  });
});
