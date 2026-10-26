// Phase 3 wave 1, Task 11: the refund receipt goes through the email outbox (kind `refund_issued`, ref `refund/<Stripe refund id>`, once-key
// the same refund id). Producers under test, each driven through its REAL entry point:
//   - request sites, which leave the first attempt to the request that did the refund: the organiser's manual refund (`refundRegistration`),
//     a withdrawal's auto-refund (`withdrawRegistrationPublic`), the organiser's reject of a paid entry (`rejectRegistration`);
//   - worker sites, which queue the row and leave the first attempt to the worker: the webhook's late and duplicate refunds
//     (`handleRegistrationCheckoutCompleted`) and the pool-deadline sweep (`sweepRegistrations`).
// The receipt is queued in the SAME transaction that records the refund's `refunded_cents`; it is a fact about money that already moved, so a
// receipt that cannot be queued never turns a refund into a refund failure (`queueRefundReceipt` contains its own failure).
// Only the network seams are replaced (Stripe, and `@/server/email-outbox/transport`). Rows, claim, retry and replace rule are the real ones.
//
// Sport: not applicable. The receipt does not vary by sport (spec, Test strategy 4); the locale is the axis that varies.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  const refundCreate = vi.fn();
  return { refundCreate, stripe: { refunds: { create: refundCreate } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

// The one network seam. The kind harness reads this same mock back (it imports `deliver` from the same module).
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

// The manual refund's audit write fails once, armed immediately before the call under test.
const auditGate = vi.hoisted(() => ({ failOnce: false }));
vi.mock("@/server/usecases/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/audit")>();
  return {
    ...actual,
    audit: async (...args: Parameters<typeof actual.audit>) => {
      if (auditGate.failOnce) {
        auditGate.failOnce = false;
        throw new Error("audit is down");
      }
      return actual.audit(...args);
    },
  };
});

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import {
  divisionCtx,
  handleRegistrationCheckoutCompleted,
  putRegistrationSettings,
  queueRefundReceipt,
  refundRegistration,
  sweepRegistrations,
  withdrawRegistrationPublic,
} from "../registrations";
import { rejectRegistration } from "../registration-approval";
import { idempotencyKey } from "@/server/email-outbox/constants";
import { assertNothingMoreToSend, dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { stubOutboxEnv } from "./_invite-mail";
import { SETTINGS_BASE, asOwner, fakeSession, loadWithGroup, rig, seedOrg, seedRegistration, stripeRig } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const KIND = "refund_issued" as const;

const made = { orgIds: [] as string[], userIds: [] as string[] };

async function cleanUp(): Promise<void> {
  await sql`delete from email_outbox where org_id = any(${made.orgIds}::uuid[])`;
  if (made.orgIds.length > 0) await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  await sql`delete from subscriptions where owner_user_id = any(${made.userIds}::uuid[])`;
  await sql`delete from users where id = any(${made.userIds}::uuid[])`;
}

afterAll(async () => {
  if (HAS_DB) {
    await cleanUp();
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
});

const ok = async () => ({ ok: true, providerId: `re_t11_${randomUUID()}` });

/** Every Stripe refund id handed out in this test, in order (the receipt's ref and once-key are taken from these, never typed). */
let refundIds: string[] = [];

beforeEach(() => {
  stubOutboxEnv();
  auditGate.failOnce = false;
  deliverMock.mockReset();
  deliverMock.mockImplementation(ok);
  refundIds = [];
  stripeMock.refundCreate.mockReset().mockImplementation(async () => {
    const id = `re_t11_${randomUUID().slice(0, 12)}`;
    refundIds.push(id);
    return { id };
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fixtures and readers
// ---------------------------------------------------------------------------------------------------------------------------------

const address = (tag: string): string => `t11-${tag}-${randomUUID().slice(0, 8)}@test.local`;

/** A stripe-paid individual division. Tracks its org for cleanup. */
async function stripeWorld(feeCents = 700) {
  const w = await stripeRig({ feeCents });
  made.orgIds.push(w.orgId);
  made.userIds.push(w.ownerId);
  return w;
}

/** A registrant who has paid (the webhook confirmed the entry), with their own locale and address. */
async function paidEntry(w: Awaited<ReturnType<typeof stripeWorld>>, locale: string | null = "es") {
  const email = address("paid");
  const made1 = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: email, locale });
  await handleRegistrationCheckoutCompleted(fakeSession(made1.registration.id, w.settings.fee_cents));
  const row = await loadWithGroup(made1.registration.id);
  expect(row.status, "premise: the webhook confirmed the paid entry").toBe("confirmed");
  stripeMock.refundCreate.mockClear();
  refundIds = [];
  return { email, regId: made1.registration.id, token: made1.access_token, row };
}

type Row = {
  id: string;
  kind: string;
  ref_type: string;
  ref_id: string;
  org_id: string | null;
  recipient: string;
  subject: string;
  status: string;
  attempts: number;
  transactional: boolean;
  dedupe_key: string | null;
};

const rowsTo = (email: string) =>
  sql<Row[]>`
    select id, kind, ref_type, ref_id, org_id, recipient, subject, status, attempts, transactional, dedupe_key
      from email_outbox
     where kind = ${KIND} and lower(recipient) = lower(${email})
     order by created_at, id`;

type Sent = { to: string; subject: string; idempotencyKey: string };
const callsTo = (email: string): Sent[] =>
  deliverMock.mock.calls.map((c) => c[0] as Sent).filter((c) => c.to.toLowerCase() === email.toLowerCase());
const callsFor = (id: string): Sent[] => deliverMock.mock.calls.map((c) => c[0] as Sent).filter((c) => c.idempotencyKey === idempotencyKey(id));

/** Wait until the address's rows have left `queued`/`sending` (the dispatch after the response runs on its own). */
async function settledTo(email: string, n: number): Promise<Row[]> {
  await vi.waitFor(
    async () => {
      const rows = await rowsTo(email);
      if (rows.length !== n) throw new Error(`${rows.length} row(s), waiting for ${n}`);
      const open = rows.filter((r) => r.status === "queued" || r.status === "sending");
      if (open.length > 0) throw new Error(`${open.length} row(s) still ${open[0]!.status}`);
    },
    { timeout: 10_000, interval: 50 },
  );
  return rowsTo(email);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The request sites
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("the refund receipt rides the outbox (DB)", () => {
  it("an organiser refund queues one receipt in the registrant's locale and sends it", async () => {
    const w = await stripeWorld(700);
    const e = await paidEntry(w, "es");

    await refundRegistration(w.owner, e.regId, undefined);

    expect(refundIds, "premise: one Stripe refund was made").toHaveLength(1);
    const [row] = await settledTo(e.email, 1);
    expect(row).toMatchObject({
      kind: KIND,
      ref_type: "refund",
      ref_id: refundIds[0],
      org_id: w.orgId,
      recipient: e.email,
      transactional: false,
      dedupe_key: refundIds[0],
      status: "sent",
    });
    const subject = dictionarySubject("es", "refundIssued.subject", { competitionName: w.competition.name });
    expect(subject, "the Spanish subject is not the English one").not.toBe(dictionarySubject("en", "refundIssued.subject", { competitionName: w.competition.name }));
    expect(row!.subject).toBe(subject);
    expect(callsFor(row!.id), "one transport call under the row's key").toHaveLength(1);
    expect(callsFor(row!.id)[0]).toMatchObject({ to: e.email, subject });

    // The second call: the request path again and a tick over a row made to look due send nothing more.
    await assertNothingMoreToSend(KIND, [row!.id]);
  });

  it("the same Stripe refund twice gives one receipt", async () => {
    const w = await stripeWorld(700);
    const e = await paidEntry(w, "es");
    const ctx = await divisionCtx(sql, e.row.division_id);
    const refundId = `re_t11_same_${randomUUID().slice(0, 8)}`;

    const first = await sql.begin((tx) => queueRefundReceipt(tx, { reg: e.row, ctx, amountCents: 700, refundId }));
    const second = await sql.begin((tx) => queueRefundReceipt(tx, { reg: e.row, ctx, amountCents: 700, refundId }));

    expect(first, "the first call queued a row").not.toBeNull();
    expect(second, "the second call is a duplicate: no id, nothing thrown").toBeNull();
    const rows = await rowsTo(e.email);
    expect(rows, "one row in total, none replaced or cancelled").toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first, ref_id: refundId, dedupe_key: refundId, status: "queued" });
  });

  it("two partial refunds give two receipts", async () => {
    const w = await stripeWorld(700);
    const e = await paidEntry(w, "es");

    await refundRegistration(w.owner, e.regId, 200);
    await refundRegistration(w.owner, e.regId, 300);

    expect(refundIds, "premise: two distinct Stripe refunds").toHaveLength(2);
    expect(new Set(refundIds).size).toBe(2);
    const rows = await settledTo(e.email, 2);
    expect(rows.map((r) => r.ref_id).sort()).toEqual([...refundIds].sort());
    // Distinct refs: the second receipt does not supersede the first (the replace rule keys on kind + ref + recipient).
    expect(rows.map((r) => r.status), "neither receipt was replaced").toEqual(["sent", "sent"]);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
  });

  it("a withdrawal's auto-refund queues its receipt and sends it", async () => {
    const w = await stripeWorld(700);
    const e = await paidEntry(w, "es");

    await withdrawRegistrationPublic(e.regId, e.token);

    const after = await loadWithGroup(e.regId);
    expect(after.refunded_cents, "premise: the withdrawal refunded the entry in full").toBe(700);
    expect(refundIds).toHaveLength(1);
    const [row] = await settledTo(e.email, 1);
    expect(row).toMatchObject({ ref_type: "refund", ref_id: refundIds[0], dedupe_key: refundIds[0], status: "sent", org_id: w.orgId });
    expect(row!.subject).toBe(dictionarySubject("es", "refundIssued.subject", { competitionName: w.competition.name }));
    expect(callsFor(row!.id)).toHaveLength(1);
  });

  it("the organiser's reject of a paid entry queues its receipt and sends it", async () => {
    const w = await stripeWorld(800);
    // A manual-approval division: a paid entry waits at 'paid' for the organiser's decision (the webhook's own manual-mode gate).
    await putRegistrationSettings(w.owner, w.division.id, { ...SETTINGS_BASE, payment_method: "stripe", fee_cents: 800, approval: "manual" });
    const email = address("reject");
    const seeded = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: email, locale: "nl" });
    await sql`update registrations set status = 'paid' where id = ${seeded.registration.id}`;
    await sql`update registration_groups set payment_intent_id = ${"pi_t11_" + randomUUID().slice(0, 8)} where id = ${seeded.registration.group_id}`;

    const rejected = await rejectRegistration(w.owner, seeded.registration.id);

    expect(rejected.status).toBe("rejected");
    expect(refundIds, "premise: the reject refunded the paid entry").toHaveLength(1);
    const [row] = await settledTo(email, 1);
    expect(row).toMatchObject({ ref_type: "refund", ref_id: refundIds[0], dedupe_key: refundIds[0], status: "sent" });
    expect(row!.subject).toBe(dictionarySubject("nl", "refundIssued.subject", { competitionName: w.competition.name }));
    expect(callsFor(row!.id)).toHaveLength(1);
  });

  it("rollback: a manual refund whose audit fails queues nothing and records no refund", async () => {
    const w = await stripeWorld(700);
    const e = await paidEntry(w, "es");

    auditGate.failOnce = true;
    await expect(refundRegistration(w.owner, e.regId, undefined)).rejects.toThrow(/audit is down/);

    expect(await rowsTo(e.email), "the receipt is part of the refund's transaction: it did not outlive the rollback").toHaveLength(0);
    expect((await loadWithGroup(e.regId)).refunded_cents, "and neither did the refund's own record").toBe(0);
    expect(callsTo(e.email)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The worker sites: the row is queued, the first attempt is the worker's
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("the refund receipt of a webhook or sweep refund waits for the worker (DB)", () => {
  it("the webhook's late refund queues a receipt and leaves the first attempt to the worker", async () => {
    const w = await stripeWorld(500);
    const email = address("late");
    const seeded = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: email, locale: "fr" });
    await withdrawRegistrationPublic(seeded.registration.id, seeded.access_token);
    expect(await rowsTo(email), "premise: the pre-payment withdrawal refunded nothing").toHaveLength(0);

    // The abandoned checkout completes AFTER the withdrawal.
    await handleRegistrationCheckoutCompleted(fakeSession(seeded.registration.id, 500));

    expect((await loadWithGroup(seeded.registration.id)).refunded_cents, "premise: the late payment was refunded").toBe(500);
    expect(refundIds).toHaveLength(1);
    const rows = await rowsTo(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ref_type: "refund", ref_id: refundIds[0], dedupe_key: refundIds[0], status: "queued", attempts: 0, org_id: w.orgId });
    expect(rows[0]!.subject).toBe(dictionarySubject("fr", "refundIssued.subject", { competitionName: w.competition.name }));
    expect(callsTo(email), "the webhook did not attempt the send").toHaveLength(0);
  });

  it("the webhook's duplicate refund queues a receipt, and a replay of the same session adds none", async () => {
    const w = await stripeWorld(500);
    const e = await paidEntry(w, "fr");

    // A second tab pays with a DIFFERENT intent: the duplicate is refunded.
    const dup = { ...fakeSession(e.regId, 500), payment_intent: "pi_t11_dup_" + randomUUID().slice(0, 8) } as unknown as Stripe.Checkout.Session;
    await handleRegistrationCheckoutCompleted(dup);

    expect(refundIds, "premise: the duplicate intent was refunded").toHaveLength(1);
    const rows = await rowsTo(e.email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ref_id: refundIds[0], dedupe_key: refundIds[0], status: "queued", attempts: 0 });
    expect(callsTo(e.email)).toHaveLength(0);

    // The second call: the SAME completed session delivered again refunds nothing more and queues nothing more.
    await handleRegistrationCheckoutCompleted(fakeSession(e.regId, 500));
    expect(refundIds).toHaveLength(1);
    expect(await rowsTo(e.email)).toHaveLength(1);
  });

  it("the pool-deadline sweep's refund queues a receipt and leaves the first attempt to the worker", async () => {
    // A team division that takes solo sign-ups, paid by card, whose place-by date has passed (the sweep withdraws and refunds the unplaced).
    const { orgId, ownerId } = await seedOrg("pro");
    made.orgIds.push(orgId);
    made.userIds.push(ownerId);
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations set stripe_charges_enabled = true, stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)} where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      entrant_kind: "team",
      allow_free_agents: true,
      payment_method: "stripe",
      fee_cents: 500,
      closes_at: "2020-01-01T00:00:00Z",
    });
    const email = address("pool");
    const seeded = await seedRegistration(competition.id, division.id, settings, { contactEmail: email, locale: "es", players: [{ name: "Solo Signer" }] });
    await sql`update registrations set free_agent = true where id = ${seeded.registration.id}`;
    await handleRegistrationCheckoutCompleted(fakeSession(seeded.registration.id, 500));
    stripeMock.refundCreate.mockClear();
    refundIds = [];

    const out = await sweepRegistrations("https://test.local");

    expect(out.poolDeadlinePassed, "premise: the sweep withdrew the unplaced sign-up").toBeGreaterThanOrEqual(1);
    expect((await loadWithGroup(seeded.registration.id)).refunded_cents).toBe(500);
    expect(refundIds).toHaveLength(1);
    const rows = await rowsTo(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ref_type: "refund", ref_id: refundIds[0], dedupe_key: refundIds[0], status: "queued", attempts: 0, org_id: orgId });
    expect(rows[0]!.subject).toBe(dictionarySubject("es", "refundIssued.subject", { competitionName: competition.name }));
    expect(callsTo(email), "the sweep did not attempt the send").toHaveLength(0);
  });
});
