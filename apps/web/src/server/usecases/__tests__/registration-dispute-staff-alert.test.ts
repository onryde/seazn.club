// Registration defects, fix round 1 I3 (owner decision 2026-11-18): staff MUST be told when an entry-fee dispute opens and closes. The
// organiser's mail now says "Seazn Club responds to the bank on your behalf", and nobody at Seazn Club was told a dispute existed
// (entry fees are destination charges: the dispute lands on the PLATFORM account and Express accounts have no dispute screen).
//
// Producer under test: `handleRegistrationDispute`, driven directly as the billing webhook calls it, then the REAL outbox rows
// (`email_outbox`, kind `staff_dispute_alert`, to this suite's own STAFF_ALERT_EMAIL, set per test: CI sets none and the database is
// shared). Only the network seams are replaced: Stripe (the lost dispute's transfer recovery) and the mail transport. What the alert
// SAYS is judged against literals taken from the fixtures and from the dispute the test sent (names, amounts, ids, the due date), never
// from the template. Sport: not applicable (a chargeback does not vary by sport).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

const stripeMock = vi.hoisted(() => {
  const refundCreate = vi.fn();
  const retrieve = vi.fn();
  const transferRetrieve = vi.fn();
  const listReversals = vi.fn();
  const createReversal = vi.fn();
  return {
    refundCreate,
    retrieve,
    transferRetrieve,
    listReversals,
    createReversal,
    stripe: {
      refunds: { create: refundCreate },
      charges: { retrieve },
      transfers: { retrieve: transferRetrieve, listReversals, createReversal },
    },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn(async () => ({ ok: true, providerId: "re_x" })) }));

// The enqueue is the real one; a test can arm a failure for the STAFF kind only (the organiser's mail must still be written).
// The outbox seals every body at rest, so what a staff alert SAYS is read where it enters the writer: the real enqueue is called
// through, and the first body offered under each staff once-key is kept (a replay offers the same key again and the writer drops it).
const gate = vi.hoisted(() => ({ failStaff: false, failOwnerLost: false, probe: null as null | (() => Promise<void>), bodies: new Map<string, { html: string; text: string }>() }));
vi.mock("@/server/email-outbox", async (io) => {
  const m = await io<typeof import("@/server/email-outbox")>();
  return {
    ...m,
    enqueueEmailOnce: vi.fn(async (...args: Parameters<typeof m.enqueueEmailOnce>) => {
      const msg = args[1] as { kind: string; dedupeKey: string; html: string; text: string };
      if (msg.kind === "registration_dispute_lost") {
        if (gate.failOwnerLost) throw new Error("outbox is down (owner)");
        if (!gate.bodies.has(msg.dedupeKey)) gate.bodies.set(msg.dedupeKey, { html: msg.html, text: msg.text });
      }
      if (msg.kind === "staff_dispute_alert") {
        if (gate.failStaff) throw new Error("outbox is down");
        await gate.probe?.();
        if (!gate.bodies.has(msg.dedupeKey)) gate.bodies.set(msg.dedupeKey, { html: msg.html, text: msg.text });
      }
      return m.enqueueEmailOnce(...args);
    }),
  };
});

import { sql } from "@/lib/db";
import { handleRegistrationCheckoutCompleted, handleRegistrationDispute } from "../registrations";
import { stubOutboxEnv } from "./_invite-mail";
import { fakeSession, loadWithGroup, seedRegistration, stripeRig } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const FEE = 1200;
const STAFF = `staff-${RUN}@test.local`;
const KIND = "staff_dispute_alert";
// Stripe's evidence deadline: 2026-12-01 23:59 UTC, as unix seconds.
const DUE_BY = Date.UTC(2026, 11, 1, 23, 59) / 1000;
const made = { orgIds: [] as string[], userIds: [] as string[] };

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where recipient = ${STAFF} or org_id = any(${made.orgIds}::uuid[])`;
  if (made.orgIds.length > 0) await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  await sql`delete from subscriptions where owner_user_id = any(${made.userIds}::uuid[])`;
  await sql`delete from users where id = any(${made.userIds}::uuid[])`;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

beforeEach(() => {
  stubOutboxEnv();
  vi.stubEnv("STAFF_ALERT_EMAIL", STAFF);
  gate.failStaff = false;
  gate.failOwnerLost = false;
  gate.bodies.clear();
  gate.probe = null;
  stripeMock.refundCreate.mockReset().mockResolvedValue({ id: "re_x" });
  for (const f of [stripeMock.retrieve, stripeMock.transferRetrieve, stripeMock.listReversals, stripeMock.createReversal]) f.mockReset();
});

let seq = 0;
const newDisputeId = (): string => `dp_${RUN}_${++seq}`;
const disputeOf = (id: string, intent: string, status: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    payment_intent: intent,
    amount: FEE,
    currency: "gbp",
    status,
    evidence_details: { due_by: DUE_BY },
    ...over,
  }) as unknown as Stripe.Dispute;

async function paidEntry() {
  const w = await stripeRig({ feeCents: FEE });
  made.orgIds.push(w.orgId);
  made.userIds.push(w.ownerId);
  const seeded = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: `dp-${randomUUID().slice(0, 8)}@test.local` });
  // The seeded cart carries no reference code (the public submit mints one); give it a run-unique one so the entry reference is judged.
  const refCode = `RD${randomUUID().slice(0, 8).toUpperCase()}`;
  await sql`update registration_groups set ref_code = ${refCode} where id = (select group_id from registrations where id = ${seeded.registration.id})`;
  await handleRegistrationCheckoutCompleted(fakeSession(seeded.registration.id, FEE));
  const row = await loadWithGroup(seeded.registration.id);
  expect(row.ref_code, "premise: the cart's reference code is the one set").toBe(refCode);
  expect(row.status, "premise: the webhook confirmed the paid entry").toBe("confirmed");
  const [org] = await sql<{ name: string }[]>`select name from organizations where id = ${w.orgId}`;
  const [comp] = await sql<{ name: string }[]>`select name from competitions where id = ${w.competition.id}`;
  return { ...w, regId: seeded.registration.id, intent: row.payment_intent_id!, refCode: row.ref_code, orgName: org!.name, compName: comp!.name };
}

interface StaffRow { ref_id: string; recipient: string; subject: string; html: string; text: string; status: string }
/** The queued rows (from the database) joined to the body the writer was offered under the same key. */
const staffRows = async (disputeId: string): Promise<StaffRow[]> => {
  const rows = await sql<Omit<StaffRow, "html" | "text">[]>`
    select ref_id, recipient, subject, status from email_outbox
     where kind = ${KIND} and ref_id like ${disputeId + ":%"} order by created_at, id`;
  return rows.map((r) => ({ ...r, html: gate.bodies.get(r.ref_id)?.html ?? "", text: gate.bodies.get(r.ref_id)?.text ?? "" }));
};
const ownerMailCount = (disputeId: string) =>
  sql<{ n: number }[]>`select count(*)::int as n from email_outbox where kind = 'registration_dispute_alert' and ref_id = ${disputeId}`.then((r) => r[0]!.n);

describe.skipIf(!HAS_DB)("entry-fee dispute -> staff alert (fix round 1 I3)", () => {
  it("opened: ONE staff alert to STAFF_ALERT_EMAIL carrying what staff need to act", async () => {
    const e = await paidEntry();
    const id = newDisputeId();
    await handleRegistrationDispute(disputeOf(id, e.intent, "needs_response"), "created");
    const rows = await staffRows(id);
    expect(rows, "exactly one alert").toHaveLength(1);
    const row = rows[0]!;
    expect(row.ref_id).toBe(`${id}:created`);
    expect(row.recipient).toBe(STAFF);
    expect(row.status).toBe("queued");
    const text = row.text;
    for (const [label, needle] of [
      ["organisation", e.orgName],
      ["competition", e.compName],
      ["entry reference", e.refCode!],
      ["amount", "12.00"],
      ["Stripe dispute id", id],
      ["evidence due date", "2026-12-01 23:59 UTC"],
      ["where the evidence pack is", `/api/v1/registrations/${e.regId}/evidence`],
    ] as const) {
      expect(text, `text part names the ${label}`).toContain(needle);
      expect(row.html, `html part names the ${label}`).toContain(needle);
    }
    expect(row.subject).toContain(e.orgName);
    expect(row.subject.toLowerCase()).toContain("entry fee");
    expect(text, "an opened dispute says what happened, not an outcome").toMatch(/flagged/i);
  });

  it("opened with NO evidence deadline in the webhook: says so instead of printing a bogus date", async () => {
    const e = await paidEntry();
    const id = newDisputeId();
    await handleRegistrationDispute(disputeOf(id, e.intent, "needs_response", { evidence_details: undefined }), "created");
    const [row] = await staffRows(id);
    expect(row!.text).not.toMatch(/1970|NaN|Invalid/);
    expect(row!.text.toLowerCase()).toContain("not given by stripe");
  });

  it("a replayed webhook: no second staff alert (and no second organiser mail either)", async () => {
    const e = await paidEntry();
    const id = newDisputeId();
    await handleRegistrationDispute(disputeOf(id, e.intent, "needs_response"), "created");
    await handleRegistrationDispute(disputeOf(id, e.intent, "needs_response"), "created");
    expect(await staffRows(id)).toHaveLength(1);
    expect(await ownerMailCount(id)).toBe(1);
    // ...and the close, replayed, is one more alert in total, not two.
    await handleRegistrationDispute(disputeOf(id, e.intent, "won"), "closed");
    await handleRegistrationDispute(disputeOf(id, e.intent, "won"), "closed");
    expect((await staffRows(id)).map((r) => r.ref_id).sort()).toEqual([`${id}:closed`, `${id}:created`]);
  });

  it("closed WON (and a bank inquiry closed without a chargeback): the outcome says nothing was taken", async () => {
    let checked = 0;
    for (const closing of ["won", "warning_closed"]) {
      const e = await paidEntry();
      const id = newDisputeId();
      await handleRegistrationDispute(disputeOf(id, e.intent, "needs_response"), "created");
      await handleRegistrationDispute(disputeOf(id, e.intent, closing), "closed");
      const closed = (await staffRows(id)).find((r) => r.ref_id === `${id}:closed`);
      expect(closed, `${closing}: a closing alert exists`).toBeTruthy();
      expect(closed!.text, closing).toMatch(/won/i);
      expect(closed!.text, closing).toMatch(/nothing was taken/i);
      expect(closed!.text, `${closing}: never the platform-product wording`).not.toMatch(/revoked|downgraded/i);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("closed LOST with the transfer recovered: states the amount recovered from the organiser's connected balance, and never 'revoked'", async () => {
    const e = await paidEntry();
    const id = newDisputeId();
    await handleRegistrationDispute(disputeOf(id, e.intent, "needs_response"), "created");
    // A 1200 charge, 100 application fee: the connected account's net share of the disputed 1200 is 1100.
    stripeMock.retrieve.mockResolvedValue({ amount: FEE, application_fee_amount: 100, transfer: { id: "tr_1", amount: FEE, amount_reversed: 0 } });
    stripeMock.listReversals.mockResolvedValue({ data: [] });
    stripeMock.createReversal.mockResolvedValue({ id: "trr_1" });
    await handleRegistrationDispute(disputeOf(id, e.intent, "lost", { charge: "ch_1" }), "closed");
    const closed = (await staffRows(id)).find((r) => r.ref_id === `${id}:closed`)!;
    expect(closed.text).toMatch(/lost/i);
    expect(closed.text, "the recovered amount").toContain("11.00");
    expect(closed.text).toMatch(/recovered from the organiser's connected balance/i);
    expect(closed.text, "an entry fee is not a plan or a pass").not.toMatch(/revoked|downgraded|plan allowance/i);
    expect(closed.html).toContain("11.00");
  });

  it("a REPLAYED lost close still alerts staff, with the amount the first run recovered (fix round 2 M-4)", async () => {
    // The first delivery could not queue the staff alert (it is dropped silently); the redelivery finds the reversal already made
    // (`already`) and used to skip the alert, so staff were never told. The recovered figure must come from the reversal Stripe holds,
    // not the 0 of a run that made no reversal.
    const e = await paidEntry();
    const id = newDisputeId();
    await handleRegistrationDispute(disputeOf(id, e.intent, "needs_response"), "created");
    stripeMock.retrieve.mockResolvedValue({ amount: FEE, application_fee_amount: 100, transfer: { id: "tr_1", amount: FEE, amount_reversed: 0 } });
    stripeMock.listReversals.mockResolvedValue({ data: [] });
    stripeMock.createReversal.mockResolvedValue({ id: "trr_1" });
    gate.failStaff = true;
    await handleRegistrationDispute(disputeOf(id, e.intent, "lost", { charge: "ch_1" }), "closed");
    expect(stripeMock.createReversal, "premise: the first run made the reversal").toHaveBeenCalledTimes(1);
    expect((await staffRows(id)).filter((r) => r.ref_id === `${id}:closed`), "premise: the first alert could not be queued").toEqual([]);
    gate.failStaff = false;
    stripeMock.listReversals.mockResolvedValue({ data: [{ id: "trr_1", amount: 1100, metadata: { dispute_id: id } }] });
    await handleRegistrationDispute(disputeOf(id, e.intent, "lost", { charge: "ch_1" }), "closed");
    expect(stripeMock.createReversal, "the replay reverses nothing more").toHaveBeenCalledTimes(1);
    const closed = (await staffRows(id)).filter((r) => r.ref_id === `${id}:closed`);
    expect(closed.length, "the replay queued the alert").toBe(1);
    expect(closed[0]!.text, "the recovered figure is the first run's, not 0").toContain("11.00");
    expect(closed[0]!.text).not.toMatch(/nothing was recovered/i);
    // A THIRD delivery changes nothing: the once-key holds the line.
    await handleRegistrationDispute(disputeOf(id, e.intent, "lost", { charge: "ch_1" }), "closed");
    expect((await staffRows(id)).filter((r) => r.ref_id === `${id}:closed`).length, "still one alert").toBe(1);
  });

  it("a REPLAYED lost close still tells the OWNER, with the recovered amount, when the first delivery's owner notice was refused (fix round 3)", async () => {
    // The owner's enqueue failing fails the webhook (D1), so Stripe redelivers; the redelivery finds the reversal already made
    // (`already`) and used to skip the notice, so the owner was never told. Exactly one notice must exist after the replay, and a
    // third delivery must not add another (the once-key).
    const e = await paidEntry();
    const id = newDisputeId();
    await handleRegistrationDispute(disputeOf(id, e.intent, "needs_response"), "created");
    stripeMock.retrieve.mockResolvedValue({ amount: FEE, application_fee_amount: 100, transfer: { id: "tr_1", amount: FEE, amount_reversed: 0 } });
    stripeMock.listReversals.mockResolvedValue({ data: [] });
    stripeMock.createReversal.mockResolvedValue({ id: "trr_1" });
    gate.failOwnerLost = true;
    await expect(handleRegistrationDispute(disputeOf(id, e.intent, "lost", { charge: "ch_1" }), "closed")).rejects.toThrow(/outbox is down/);
    expect(stripeMock.createReversal, "premise: the first run made the reversal").toHaveBeenCalledTimes(1);
    const lostMails = async () => (await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where kind = 'registration_dispute_lost' and ref_id = ${id}`)[0]!.n;
    expect(await lostMails(), "premise: the owner's notice was not written").toBe(0);
    gate.failOwnerLost = false;
    stripeMock.listReversals.mockResolvedValue({ data: [{ id: "trr_1", amount: 1100, metadata: { dispute_id: id } }] });
    await handleRegistrationDispute(disputeOf(id, e.intent, "lost", { charge: "ch_1" }), "closed");
    expect(stripeMock.createReversal, "the replay reverses nothing more").toHaveBeenCalledTimes(1);
    expect(await lostMails(), "the replay told the owner").toBe(1);
    const ownerBody = [...gate.bodies.entries()].find(([k]) => k.includes(id) && k.includes("lost"))?.[1];
    expect(ownerBody, "premise: the owner's body was captured at enqueue").toBeTruthy();
    expect(ownerBody!.text, "the recovered figure is the reversal's, not 0").toContain("11.00");
    await handleRegistrationDispute(disputeOf(id, e.intent, "lost", { charge: "ch_1" }), "closed");
    expect(await lostMails(), "a third delivery does not mail again").toBe(1);
  });

  it("closed LOST with NOTHING recovered (no transfer to reverse): says it was not recovered, not that it was", async () => {
    const e = await paidEntry();
    const id = newDisputeId();
    await handleRegistrationDispute(disputeOf(id, e.intent, "needs_response"), "created");
    await handleRegistrationDispute(disputeOf(id, e.intent, "lost"), "closed"); // no `charge`: recovery is skipped (no_charge)
    const closed = (await staffRows(id)).find((r) => r.ref_id === `${id}:closed`)!;
    expect(closed.text).toMatch(/lost/i);
    expect(closed.text).toMatch(/nothing was recovered/i);
    expect(closed.text).not.toMatch(/recovered from the organiser's connected balance/i);
    expect(closed.text).not.toMatch(/revoked|downgraded/i);
  });

  it("the lost outcome differs from the won outcome (the two arms are not the same sentence)", async () => {
    const a = await paidEntry();
    const b = await paidEntry();
    const lost = newDisputeId();
    const won = newDisputeId();
    for (const [e, id, closing] of [[a, lost, "lost"], [b, won, "won"]] as const) {
      await handleRegistrationDispute(disputeOf(id, e.intent, "needs_response"), "created");
      await handleRegistrationDispute(disputeOf(id, e.intent, closing), "closed");
    }
    const lostText = (await staffRows(lost)).find((r) => r.ref_id.endsWith(":closed"))!.text;
    const wonText = (await staffRows(won)).find((r) => r.ref_id.endsWith(":closed"))!.text;
    expect(lostText).not.toBe(wonText);
    expect(lostText).not.toMatch(/nothing was taken/i);
  });

  it("STAFF_ALERT_EMAIL unset: no throw, nothing queued, and the dispute is still recorded and the owner still mailed", async () => {
    vi.stubEnv("STAFF_ALERT_EMAIL", "");
    const e = await paidEntry();
    const id = newDisputeId();
    await expect(handleRegistrationDispute(disputeOf(id, e.intent, "needs_response"), "created")).resolves.toBe(true);
    await expect(handleRegistrationDispute(disputeOf(id, e.intent, "lost"), "closed")).resolves.toBe(true);
    expect(await staffRows(id)).toEqual([]);
    expect(await ownerMailCount(id)).toBe(1);
    const [g] = await sql<{ dispute_id: string }[]>`select dispute_id from registration_groups g join registrations r on r.group_id = g.id where r.id = ${e.regId}`;
    expect(g!.dispute_id).toBe(id);
  });

  it("a staff alert that CANNOT be queued never blocks the webhook or undoes the write: the dispute is recorded, the owner mailed, the loss written off", async () => {
    gate.failStaff = true;
    const e = await paidEntry();
    const id = newDisputeId();
    await expect(handleRegistrationDispute(disputeOf(id, e.intent, "needs_response"), "created")).resolves.toBe(true);
    await expect(handleRegistrationDispute(disputeOf(id, e.intent, "lost"), "closed")).resolves.toBe(true);
    expect(await staffRows(id), "nothing could be queued").toEqual([]);
    expect(await ownerMailCount(id), "the organiser's mail was still written").toBe(1);
    const [g] = await sql<{ dispute_id: string; refunded_cents: number }[]>`
      select g.dispute_id, g.refunded_cents from registration_groups g join registrations r on r.group_id = g.id where r.id = ${e.regId}`;
    expect(g).toMatchObject({ dispute_id: id, refunded_cents: FEE });
  });

  it("the staff alert is queued AFTER the dispute's transaction commits: the cart's dispute record is already visible to another connection", async () => {
    // Probed at the moment the staff alert is offered to the writer, on the pool (a different connection from the dispute's own
    // transaction): an uncommitted write would not be visible, so a staff alert queued inside that transaction reads null.
    const e = await paidEntry();
    const id = newDisputeId();
    const seen: (string | null)[] = [];
    gate.probe = async () => {
      const [g] = await sql<{ dispute_id: string | null }[]>`
        select g.dispute_id from registration_groups g join registrations r on r.group_id = g.id where r.id = ${e.regId}`;
      seen.push(g?.dispute_id ?? null);
    };
    await handleRegistrationDispute(disputeOf(id, e.intent, "needs_response"), "created");
    expect(seen, "the staff alert was offered exactly once, after the cart named this dispute").toEqual([id]);
  });
});
