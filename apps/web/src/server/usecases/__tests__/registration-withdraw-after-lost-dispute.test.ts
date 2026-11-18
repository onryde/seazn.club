// Registration defects, fix round 1 Q: on an entry whose chargeback was LOST, the console still offers Withdraw. Stripe has already
// repaid the cardholder and the app wrote the loss off (`registration_groups.refunded_cents` raised to the disputed amount, a
// `registration.dispute_lost` ledger row), but the dispute handler never touches the ENTRY's own `refunded_cents`, and the withdrawal's
// auto-refund (and the organiser's manual Refund) read the entry's own. So both saw a fully refundable payment and sent a SECOND
// refund of money that was already gone, to Stripe. Real Stripe refuses a refund of a charged-back charge, which is not something
// the books may lean on: the attempt is a refund of already-repaid money, and a refusal is booked as a failed refund and alerted.
//
// Producer under test: `handleRegistrationDispute` (the real lost-dispute write) then the REAL `withdrawRegistrationOrganiser` and
// `refundRegistration`; only Stripe and the mail transport are replaced. Control: a WON dispute and a never-disputed entry still refund
// automatically on withdrawal (so the guard is not "never refund a disputed entry"). Sport: not applicable (money, not sport).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

const stripeMock = vi.hoisted(() => {
  const refundCreate = vi.fn();
  return { refundCreate, stripe: { refunds: { create: refundCreate }, charges: { retrieve: vi.fn() }, transfers: { retrieve: vi.fn(), listReversals: vi.fn(), createReversal: vi.fn() } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn(async () => ({ ok: true, providerId: "re_x" })) }));

import { sql } from "@/lib/db";
import { handleRegistrationCheckoutCompleted, handleRegistrationDispute, refundRegistration, withdrawRegistrationOrganiser } from "../registrations";
import { stubOutboxEnv } from "./_invite-mail";
import { asOwner, fakeSession, loadWithGroup, seedRegistration, stripeRig } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const FEE = 1200;
const made = { orgIds: [] as string[], userIds: [] as string[] };

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where org_id = any(${made.orgIds}::uuid[])`;
  if (made.orgIds.length > 0) await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  await sql`delete from subscriptions where owner_user_id = any(${made.userIds}::uuid[])`;
  await sql`delete from users where id = any(${made.userIds}::uuid[])`;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

beforeEach(() => {
  stubOutboxEnv();
  vi.stubEnv("STAFF_ALERT_EMAIL", "");
  stripeMock.refundCreate.mockReset().mockImplementation(async () => ({ id: `re_${RUN}_${randomUUID().slice(0, 8)}` }));
});

let seq = 0;
const disputeOf = (id: string, intent: string, status: string) => ({ id, payment_intent: intent, amount: FEE, currency: "gbp", status }) as unknown as Stripe.Dispute;

async function paidEntry() {
  const w = await stripeRig({ feeCents: FEE });
  made.orgIds.push(w.orgId);
  made.userIds.push(w.ownerId);
  const seeded = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: `wl-${randomUUID().slice(0, 8)}@test.local` });
  await handleRegistrationCheckoutCompleted(fakeSession(seeded.registration.id, FEE));
  const row = await loadWithGroup(seeded.registration.id);
  expect(row.status, "premise: confirmed by the paid webhook").toBe("confirmed");
  expect(row.entry_payment_intent_id, "premise: the entry has its own card payment").toBeTruthy();
  return { owner: asOwner(w.orgId, w.ownerId), regId: seeded.registration.id, intent: row.payment_intent_id! };
}
const dispute = async (e: Awaited<ReturnType<typeof paidEntry>>, closing: "lost" | "won" | null) => {
  const id = `dp_${RUN}_${++seq}`;
  await handleRegistrationDispute(disputeOf(id, e.intent, "needs_response"), "created");
  if (closing) await handleRegistrationDispute(disputeOf(id, e.intent, closing), "closed");
  return id;
};
const status = async (regId: string) => (await sql<{ status: string }[]>`select status from registrations where id = ${regId}`)[0]!.status;
const refunds = () => stripeMock.refundCreate.mock.calls.length;

describe.skipIf(!HAS_DB)("an entry whose dispute was LOST is never refunded again (fix round 1 Q)", () => {
  it("withdrawing it moves no money: the withdrawal lands, Stripe is not asked to refund", async () => {
    const e = await paidEntry();
    await dispute(e, "lost");
    await withdrawRegistrationOrganiser(e.owner, e.regId);
    expect(await status(e.regId), "the withdrawal itself still lands").toBe("withdrawn");
    expect(refunds(), "no refund of money the chargeback already returned").toBe(0);
  });

  it("the organiser's manual Refund is refused too (422), nothing sent to Stripe", async () => {
    const e = await paidEntry();
    await dispute(e, "lost");
    await expect(refundRegistration(e.owner, e.regId, undefined)).rejects.toMatchObject({ status: 422 });
    expect(refunds()).toBe(0);
  });

  it("control: a WON dispute still auto-refunds a withdrawal (the money stayed)", async () => {
    const e = await paidEntry();
    await dispute(e, "won");
    await withdrawRegistrationOrganiser(e.owner, e.regId);
    expect(refunds(), "won: nothing was taken, so the refund is owed").toBe(1);
  });

  it("control: an OPEN dispute (not decided) is left as it was; a never-disputed entry refunds", async () => {
    const open = await paidEntry();
    await dispute(open, null);
    const plain = await paidEntry();
    await withdrawRegistrationOrganiser(plain.owner, plain.regId);
    expect(refunds(), "the never-disputed withdrawal refunded once").toBe(1);
    await withdrawRegistrationOrganiser(open.owner, open.regId);
    expect(await status(open.regId)).toBe("withdrawn");
  });
});
