// Registration defects item 4 (2026-11-18): the organiser's list could not tell a dispute that is OPEN from one that was LOST (both left
// `registration_groups.disputed_at` set) or WON (clears it), so a lost dispute read only "Disputed" and a won one read as an ordinary paid
// entry. The outcome is not stored in a column; it is in the audit ledger the dispute handler writes (`registration.dispute_lost` /
// `registration.dispute_won`, each carrying the Stripe dispute id), and the cart keeps `dispute_id`. `RegistrationListRow.dispute` reads
// that: null (never disputed) | "open" | "lost" | "won".
//
// Producer under test: `handleRegistrationDispute` as the billing webhook calls it, then the REAL list read (`listRegistrations`) - the
// expected value is what the webhook was told (the dispute's status), never read back from the code under test. The dispute carries no
// `charge`, so the transfer recovery skips without a Stripe call (dispute-recovery.ts, `no_charge`); Stripe is mocked only because the
// fixtures import it. Another sport: N/A - a chargeback is sport-agnostic.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

const stripeMock = vi.hoisted(() => {
  const refundCreate = vi.fn();
  return { refundCreate, stripe: { refunds: { create: refundCreate } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn(async () => ({ ok: true, providerId: `re_${Math.random().toString(36).slice(2)}` })) }));

import { sql } from "@/lib/db";
import { handleRegistrationCheckoutCompleted, handleRegistrationDispute, listRegistrations } from "../registrations";
import { stubOutboxEnv } from "./_invite-mail";
import { fakeSession, loadWithGroup, seedRegistration, seedSecondEntry, stripeRig } from "./_registration-fixtures";

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
  stripeMock.refundCreate.mockReset().mockResolvedValue({ id: "re_x" });
});

let seq = 0;
const newDisputeId = (): string => `dp_${RUN}_${++seq}`;
const disputeOf = (id: string, intent: string, status: string) =>
  ({ id, payment_intent: intent, amount: FEE, status }) as unknown as Stripe.Dispute;

async function paidEntry() {
  const w = await stripeRig({ feeCents: FEE });
  made.orgIds.push(w.orgId);
  made.userIds.push(w.ownerId);
  const seeded = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: `dp-${randomUUID().slice(0, 8)}@test.local` });
  await handleRegistrationCheckoutCompleted(fakeSession(seeded.registration.id, FEE));
  const row = await loadWithGroup(seeded.registration.id);
  expect(row.status, "premise: the webhook confirmed the paid entry").toBe("confirmed");
  const intent = row.payment_intent_id!;
  const disputeOfEntry = async () =>
    (await listRegistrations(w.owner, w.division.id, null)).find((r) => r.id === seeded.registration.id)!.dispute;
  return { ...w, regId: seeded.registration.id, intent, dispute: disputeOfEntry };
}

describe.skipIf(!HAS_DB)("RegistrationListRow.dispute - open, lost, won (registration defects item 4)", () => {
  it("the empty case first: an entry that was never disputed reads null", async () => {
    const e = await paidEntry();
    expect(await e.dispute()).toBeNull();
  });

  it("created -> open; closed lost -> lost; closed won -> won; closed warning_closed -> won (a bank inquiry that dropped)", async () => {
    const cases: [label: string, closing: string, want: "lost" | "won"][] = [
      ["a lost chargeback", "lost", "lost"],
      ["a won chargeback", "won", "won"],
      ["an inquiry the bank closed without a chargeback", "warning_closed", "won"],
    ];
    let checked = 0;
    for (const [label, closing, want] of cases) {
      const e = await paidEntry();
      const id = newDisputeId();
      await handleRegistrationDispute(disputeOf(id, e.intent, "needs_response"), "created");
      expect(await e.dispute(), `${label}: open while the dispute is`).toBe("open");
      await handleRegistrationDispute(disputeOf(id, e.intent, closing), "closed");
      expect(await e.dispute(), label).toBe(want);
      checked += 1;
    }
    expect(checked, "anti-vacuity: outcomes checked").toBe(cases.length);
  });

  it("the three outcomes are three different values (a lost dispute is not 'open', a won one is not 'never disputed')", async () => {
    const seen = new Set<string | null>();
    for (const closing of [null, "lost", "won"] as const) {
      const e = await paidEntry();
      const id = newDisputeId();
      await handleRegistrationDispute(disputeOf(id, e.intent, "needs_response"), "created");
      if (closing) await handleRegistrationDispute(disputeOf(id, e.intent, closing), "closed");
      seen.add(await e.dispute());
    }
    expect([...seen].sort()).toEqual(["lost", "open", "won"]);
  });

  it("a replayed 'closed lost' (the webhook redelivered) stays lost", async () => {
    const e = await paidEntry();
    const id = newDisputeId();
    await handleRegistrationDispute(disputeOf(id, e.intent, "needs_response"), "created");
    await handleRegistrationDispute(disputeOf(id, e.intent, "lost"), "closed");
    await handleRegistrationDispute(disputeOf(id, e.intent, "lost"), "closed");
    expect(await e.dispute()).toBe("lost");
  });

  it("sequence: a NEW dispute on a cart whose earlier one was won is open again, and the old outcome does not leak into it", async () => {
    const e = await paidEntry();
    const first = newDisputeId();
    await handleRegistrationDispute(disputeOf(first, e.intent, "needs_response"), "created");
    await handleRegistrationDispute(disputeOf(first, e.intent, "won"), "closed");
    expect(await e.dispute()).toBe("won");
    const second = newDisputeId();
    await handleRegistrationDispute(disputeOf(second, e.intent, "needs_response"), "created");
    expect(await e.dispute(), "the second dispute is open").toBe("open");
    await handleRegistrationDispute(disputeOf(second, e.intent, "lost"), "closed");
    expect(await e.dispute()).toBe("lost");
  });

  // Fix round 3 (changed on purpose): the state is per PAYMENT, so a second dispute on a charge that was already LOST stays lost: the money
  // is gone and written off, there is nothing left for a new dispute to be "open" about. (Before, the cart's current dispute id decided.)
  it("sequence: a further dispute on an already-LOST charge still reads lost (the charge was written off)", async () => {
    const e = await paidEntry();
    const first = newDisputeId();
    await handleRegistrationDispute(disputeOf(first, e.intent, "needs_response"), "created");
    await handleRegistrationDispute(disputeOf(first, e.intent, "lost"), "closed");
    expect(await e.dispute()).toBe("lost");
    const second = newDisputeId();
    await handleRegistrationDispute(disputeOf(second, e.intent, "needs_response"), "created");
    expect(await e.dispute()).toBe("lost");
  });

  // Fix round 3: the state belongs to the entry's own PAYMENT, not the cart. Three shapes the cart's single flag/id could not tell apart.
  async function sessionsCart(shared: boolean) {
    const w = await stripeRig({ feeCents: FEE });
    made.orgIds.push(w.orgId);
    made.userIds.push(w.ownerId);
    const a = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: `ss-${randomUUID().slice(0, 8)}@test.local` });
    const b = await seedSecondEntry(a.registration.group_id, w.division.id, FEE, "Second entry");
    const session = (ids: string[], tag: string) => {
      const s = fakeSession(ids, FEE * ids.length);
      (s as unknown as { id: string }).id = `cs_r3_${tag}_${ids[0]!.slice(0, 8)}`;
      (s as unknown as { payment_intent: string }).payment_intent = `pi_r3_${tag}_${ids[0]!.slice(0, 8)}`;
      return s;
    };
    if (shared) await handleRegistrationCheckoutCompleted(session([a.registration.id, b.id], "ONE"));
    else {
      await handleRegistrationCheckoutCompleted(session([a.registration.id], "A"));
      await handleRegistrationCheckoutCompleted(session([b.id], "B"));
    }
    const rowA = await loadWithGroup(a.registration.id);
    const rowB = await loadWithGroup(b.id);
    expect(rowA.entry_payment_intent_id, shared ? "premise: one shared charge" : "premise: two charges").toBe(shared ? rowB.entry_payment_intent_id : rowA.entry_payment_intent_id);
    if (!shared) expect(rowA.entry_payment_intent_id).not.toBe(rowB.entry_payment_intent_id);
    const states = async () => {
      const rows = await listRegistrations(w.owner, w.division.id, null);
      return { A: rows.find((r) => r.id === a.registration.id)!.dispute, B: rows.find((r) => r.id === b.id)!.dispute };
    };
    return { intentA: rowA.entry_payment_intent_id!, intentB: rowB.entry_payment_intent_id!, states };
  }

  it("two sessions, A lost and B never disputed: A reads lost, B reads null (the cart's flag does not bleed onto B)", async () => {
    const c = await sessionsCart(false);
    expect(await c.states(), "premise: nothing disputed").toEqual({ A: null, B: null });
    const id = newDisputeId();
    await handleRegistrationDispute(disputeOf(id, c.intentA, "needs_response"), "created");
    expect(await c.states()).toEqual({ A: "open", B: null });
    await handleRegistrationDispute(disputeOf(id, c.intentA, "lost"), "closed");
    expect(await c.states()).toEqual({ A: "lost", B: null });
  });

  it("two sessions, A WON while B is still OPEN: B stays open (the win clears the CART's disputed_at, which no entry state reads)", async () => {
    const c = await sessionsCart(false);
    const idA = newDisputeId();
    const idB = newDisputeId();
    await handleRegistrationDispute(disputeOf(idA, c.intentA, "needs_response"), "created");
    await handleRegistrationDispute(disputeOf(idB, c.intentB, "needs_response"), "created");
    expect(await c.states(), "premise: both open").toEqual({ A: "open", B: "open" });
    await handleRegistrationDispute(disputeOf(idA, c.intentA, "won"), "closed");
    const [g] = await sql<{ disputed_at: Date | null; dispute_id: string | null }[]>`
      select g.disputed_at, g.dispute_id from registration_groups g join registrations r on r.group_id = g.id where r.payment_intent_id = ${c.intentA}`;
    expect(g!.disputed_at, "premise: the cart's single flag WAS cleared by A's win while B is open").toBeNull();
    expect(await c.states(), "yet B is still open and A is won").toEqual({ A: "won", B: "open" });
    await handleRegistrationDispute(disputeOf(idB, c.intentB, "lost"), "closed");
    expect(await c.states()).toEqual({ A: "won", B: "lost" });
  });

  it("one session paying both entries: a dispute is one dispute on one charge, so both entries read the same at every step", async () => {
    const c = await sessionsCart(true);
    const id = newDisputeId();
    await handleRegistrationDispute(disputeOf(id, c.intentA, "needs_response"), "created");
    expect(await c.states()).toEqual({ A: "open", B: "open" });
    await handleRegistrationDispute(disputeOf(id, c.intentA, "lost"), "closed");
    expect(await c.states()).toEqual({ A: "lost", B: "lost" });
  });

  it("an entry with no card payment of its own never reads a dispute, whatever its cart says", async () => {
    const w = await stripeRig({ feeCents: FEE });
    made.orgIds.push(w.orgId);
    made.userIds.push(w.ownerId);
    const a = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: `np-${randomUUID().slice(0, 8)}@test.local` });
    const b = await seedSecondEntry(a.registration.group_id, w.division.id, FEE, "Unpaid sibling");
    await handleRegistrationCheckoutCompleted(fakeSession(a.registration.id, FEE));
    const intent = (await loadWithGroup(a.registration.id)).entry_payment_intent_id!;
    const id = newDisputeId();
    await handleRegistrationDispute(disputeOf(id, intent, "needs_response"), "created");
    const rows = await listRegistrations(w.owner, w.division.id, null);
    expect(rows.find((r) => r.id === a.registration.id)!.dispute).toBe("open");
    expect(rows.find((r) => r.id === b.id)!.dispute, "the unpaid sibling has no payment to dispute").toBeNull();
  });

  // Fix round 3 item 5 (V531): without these the list's per-row probe walked every ledger row of the competition (EXPLAIN: ~254 ms and
  // ~68,900 buffers at 500 entries x 7,400 events; ~7 ms and ~500 buffers with them). Pinned from pg_indexes, like migration-shape.test.ts.
  it("V531's two partial indexes exist: by (competition, payment intent) for disputed/lost rows and by (competition, dispute id) for won rows", async () => {
    const rows = await sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
       where tablename = 'competition_events' and indexname in ('competition_events_reg_dispute_intent_idx', 'competition_events_reg_dispute_won_idx')`;
    expect(rows.length, "anti-vacuity: both indexes read back").toBe(2);
    const def = (name: string) => rows.find((r) => r.indexname === name)!.indexdef;
    expect(def("competition_events_reg_dispute_intent_idx")).toMatch(/payment_intent_id/);
    expect(def("competition_events_reg_dispute_intent_idx")).toMatch(/registration\.dispute_lost/);
    expect(def("competition_events_reg_dispute_won_idx")).toMatch(/dispute_id/);
    expect(def("competition_events_reg_dispute_won_idx")).toMatch(/registration\.dispute_won/);
  });

  it("another organisation's ledger cannot make this entry lost (the read is tenant-scoped; the competition predicate in the SQL is the index path, RLS is the wall)", async () => {
    const e = await paidEntry();
    const other = await paidEntry();
    const id = newDisputeId();
    await handleRegistrationDispute(disputeOf(id, e.intent, "needs_response"), "created");
    // A `dispute_lost` event naming the same dispute id AND payment intent, but written in ANOTHER org's competition: it must not count here. (Mutating out
    // the SQL's `competition_id` predicate leaves this green: RLS on competition_events already hides the row, so that predicate is
    // defence in depth and the index path, an equivalent mutant at this seam.)
    await sql`
      insert into competition_events (competition_id, org_id, type, payload, actor_id)
      values (${other.competition.id}, ${other.orgId}, 'registration.dispute_lost', ${sql.json({ dispute_id: id, payment_intent_id: e.intent })}, null)`;
    expect(await e.dispute()).toBe("open");
  });
});
