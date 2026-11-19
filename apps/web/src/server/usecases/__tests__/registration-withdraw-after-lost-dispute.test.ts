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
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn(async () => ({ ok: true, providerId: `re_${Math.random().toString(36).slice(2)}` })) }));

import { sql } from "@/lib/db";
import { handleRegistrationCheckoutCompleted, handleRegistrationDispute, listRegistrations, refundRegistration, withdrawRegistrationOrganiser } from "../registrations";
import { stubOutboxEnv } from "./_invite-mail";
import { asOwner, fakeSession, loadWithGroup, seedRegistration, seedSecondEntry, stripeRig } from "./_registration-fixtures";

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

// Fix round 2 I-1: the loss is judged on the ENTRY's own charge, not the cart's. A cart can be paid in several Checkout sessions (V387), so
// a chargeback on one session's charge says nothing about a sibling paid in another. Rule chosen for ONE session paying several entries:
// a lost dispute claws back the WHOLE charge, so EVERY entry on that charge refuses; an entry on another charge refunds in full.
describe.skipIf(!HAS_DB)("a lost dispute blocks only the entries paid on the disputed charge (fix round 2 I-1)", () => {
  const sessionFor = (regIds: string[], tag: string) => {
    const s = fakeSession(regIds, FEE * regIds.length);
    (s as unknown as { id: string }).id = `cs_test_l2_${tag}_${regIds[0]!.slice(0, 8)}`;
    (s as unknown as { payment_intent: string }).payment_intent = `pi_test_l2_${tag}_${regIds[0]!.slice(0, 8)}`;
    return s;
  };
  /** One cart, two entries, paid in TWO sessions (A then B); the cart's own intent ends up B's (last writer wins). */
  async function twoSessionCart() {
    const w = await stripeRig({ feeCents: FEE });
    made.orgIds.push(w.orgId);
    made.userIds.push(w.ownerId);
    const a = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: `ts-${randomUUID().slice(0, 8)}@test.local` });
    const bRow = await seedSecondEntry(a.registration.group_id, w.division.id, FEE, "Second entry");
    await handleRegistrationCheckoutCompleted(sessionFor([a.registration.id], "A"));
    await handleRegistrationCheckoutCompleted(sessionFor([bRow.id], "B"));
    const rowA = await loadWithGroup(a.registration.id);
    const rowB = await loadWithGroup(bRow.id);
    expect(rowA.entry_payment_intent_id, "premise: the two entries paid on different charges").not.toBe(rowB.entry_payment_intent_id);
    expect(rowA.payment_intent_id, "premise: the cart carries the LAST session's intent").toBe(rowB.entry_payment_intent_id);
    return { owner: asOwner(w.orgId, w.ownerId), w, a: rowA, b: rowB };
  }
  const lose = async (intent: string) => {
    const id = `dp_${RUN}_${++seq}`;
    await handleRegistrationDispute(disputeOf(id, intent, "needs_response"), "created");
    await handleRegistrationDispute(disputeOf(id, intent, "lost"), "closed");
    return id;
  };
  const refundedWith = () => stripeMock.refundCreate.mock.calls.map((c) => ({ intent: c[0].payment_intent as string, amount: c[0].amount as number | undefined }));

  it("two sessions, dispute lost on A: A refuses (withdraw sends nothing, manual Refund 422), B refunds in FULL", async () => {
    const c = await twoSessionCart();
    await lose(c.a.entry_payment_intent_id!);
    await withdrawRegistrationOrganiser(c.owner, c.a.id);
    await expect(refundRegistration(c.owner, c.a.id, undefined)).rejects.toMatchObject({ status: 422 });
    expect(refunds(), "A's own charge was charged back: nothing is sent for it").toBe(0);
    await refundRegistration(c.owner, c.b.id, undefined);
    expect(refundedWith(), "B's intact charge is refunded once, in full, against ITS OWN intent").toEqual([{ intent: c.b.entry_payment_intent_id, amount: FEE }]);
  });

  it("two sessions, dispute lost on A: withdrawing B auto-refunds B's payment", async () => {
    const c = await twoSessionCart();
    await lose(c.a.entry_payment_intent_id!);
    await withdrawRegistrationOrganiser(c.owner, c.b.id);
    expect(refundedWith()).toEqual([{ intent: c.b.entry_payment_intent_id, amount: FEE }]);
  });

  it("the other way round: dispute lost on B (the cart's current intent): B refuses, A (an OLDER charge, no longer on the cart) refunds in full", async () => {
    const c = await twoSessionCart();
    await lose(c.b.entry_payment_intent_id!);
    await withdrawRegistrationOrganiser(c.owner, c.b.id);
    expect(refunds()).toBe(0);
    await refundRegistration(c.owner, c.a.id, undefined);
    expect(refundedWith()).toEqual([{ intent: c.a.entry_payment_intent_id, amount: FEE }]);
  });

  it("ONE session paying both entries, dispute lost: EVERY entry on that charge refuses (withdraw and manual Refund), nothing sent", async () => {
    const w = await stripeRig({ feeCents: FEE });
    made.orgIds.push(w.orgId);
    made.userIds.push(w.ownerId);
    const a = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: `os-${randomUUID().slice(0, 8)}@test.local` });
    const b = await seedSecondEntry(a.registration.group_id, w.division.id, FEE, "Second entry");
    await handleRegistrationCheckoutCompleted(sessionFor([a.registration.id, b.id], "ONE"));
    const rowA = await loadWithGroup(a.registration.id);
    const rowB = await loadWithGroup(b.id);
    expect(rowA.entry_payment_intent_id, "premise: one shared charge").toBe(rowB.entry_payment_intent_id);
    expect(rowA.entry_payment_intent_id).toBeTruthy();
    await lose(rowA.entry_payment_intent_id!);
    const owner = asOwner(w.orgId, w.ownerId);
    for (const id of [a.registration.id, b.id]) {
      await expect(refundRegistration(owner, id, undefined)).rejects.toMatchObject({ status: 422 });
      await withdrawRegistrationOrganiser(owner, id);
    }
    expect(refunds(), "the whole charge was clawed back: no entry on it is refunded again").toBe(0);
  });

  it("the console's row says the same: only the entry on the lost charge reads lost (list read model, per entry payment)", async () => {
    const c = await twoSessionCart();
    const before = await listRegistrations(c.owner, c.w.division.id, null);
    expect(before.length, "premise: both entries listed").toBe(2);
    expect(before.map((r) => r.dispute), "nothing disputed yet").toEqual([null, null]);
    await lose(c.a.entry_payment_intent_id!);
    const rows = await listRegistrations(c.owner, c.w.division.id, null);
    expect(rows.find((r) => r.id === c.a.id)!.dispute, "A's own charge was lost").toBe("lost");
    expect(rows.find((r) => r.id === c.b.id)!.dispute, "B's charge was never disputed: no chip, no state").toBeNull();
    // The cart's own flag is still set (it speaks for the cart), but no per-entry state reads it.
    const groupRow = await loadWithGroup(c.b.id);
    expect(groupRow.disputed_at, "premise: the cart itself is flagged").not.toBeNull();
  });

  it("an open (undecided) dispute on A leaves both entries refundable; a WON one too", async () => {
    const c = await twoSessionCart();
    const id = `dp_${RUN}_${++seq}`;
    await handleRegistrationDispute(disputeOf(id, c.a.entry_payment_intent_id!, "needs_response"), "created");
    const rows = await listRegistrations(c.owner, c.w.division.id, null);
    expect(rows.map((r) => [r.id === c.a.id ? "A" : "B", r.dispute]).sort()).toEqual([["A", "open"], ["B", null]]);
    await handleRegistrationDispute(disputeOf(id, c.a.entry_payment_intent_id!, "won"), "closed");
    await refundRegistration(c.owner, c.a.id, undefined);
    expect(refundedWith()).toEqual([{ intent: c.a.entry_payment_intent_id, amount: FEE }]);
  });
});

describe.skipIf(!HAS_DB)("a lost close writes the write-off and its ledger row in ONE transaction (fix round 2 M-5)", () => {
  it("a ledger row that cannot be written leaves the cart's write-off unwritten, and a retry lands both", async () => {
    const e = await paidEntry();
    const id = `dp_${RUN}_atomic_${++seq}`;
    await handleRegistrationDispute(disputeOf(id, e.intent, "needs_response"), "created");
    const fn = `regdef_fail_lost_${RUN}`;
    await sql.unsafe(`create or replace function ${fn}() returns trigger language plpgsql as $f$ begin raise exception 'regdef: ledger refused'; end $f$`);
    await sql.unsafe(`create trigger ${fn} before insert on competition_events for each row when (new.type = 'registration.dispute_lost' and new.payload->>'dispute_id' = '${id}') execute function ${fn}()`);
    try {
      await expect(handleRegistrationDispute(disputeOf(id, e.intent, "lost"), "closed")).rejects.toThrow();
      const [g] = await sql<{ refunded_cents: number }[]>`select g.refunded_cents from registration_groups g join registrations r on r.group_id = g.id where r.id = ${e.regId}`;
      expect(g!.refunded_cents, "the write-off rolled back with the failed ledger row").toBe(0);
    } finally {
      await sql.unsafe(`drop trigger if exists ${fn} on competition_events`);
      await sql.unsafe(`drop function if exists ${fn}()`);
    }
    await handleRegistrationDispute(disputeOf(id, e.intent, "lost"), "closed");
    const [g] = await sql<{ refunded_cents: number }[]>`select g.refunded_cents from registration_groups g join registrations r on r.group_id = g.id where r.id = ${e.regId}`;
    expect(g!.refunded_cents, "the retry lands the write-off").toBe(FEE);
    await expect(refundRegistration(e.owner, e.regId, undefined)).rejects.toMatchObject({ status: 422 });
  });
});
