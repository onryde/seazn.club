// Phase 3 wave 2, Batch A: the organiser's chargeback mail goes through the email outbox. A disputed entry fee alerts the org's owner (kind
// `registration_dispute_alert`, ref `dispute/<Stripe dispute id>`, once-key `<dispute id>:created`), queued in the transaction that records
// the dispute on the cart and written only on the transition to THIS dispute. A dispute that closes lost tells the owner what was written
// off and recovered (kind `registration_dispute_lost`, the same ref, once-key `<dispute id>:lost`). The owner is an account (the address is
// resolved at send), the mail is in the owner's language (D4: the account's, then the org default), and the first attempt is the worker's
// (a webhook has no response to defer behind). The lost notice's own tests are the dispute-loss suite of registrations.test.ts.
//
// Producer under test: `handleRegistrationDispute`, driven directly as the billing webhook calls it. Only the network seams are replaced
// (Stripe, for the withdrawal's refund; `@/server/email-outbox/transport`). The enqueue is the real one, observed through a spy that calls
// through, so a test can tell "not written because the key was taken" from "never asked".
//
// Sport: not applicable. A chargeback notice does not vary by sport (spec, Test strategy 4); the locale is the axis that varies.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

const stripeMock = vi.hoisted(() => {
  const refundCreate = vi.fn();
  return { refundCreate, stripe: { refunds: { create: refundCreate } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

// The one network seam of the outbox.
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

// The enqueue, observed: every call reaches the real writer.
vi.mock("@/server/email-outbox", async (io) => { const m = await io<typeof import("@/server/email-outbox")>(); return { ...m, enqueueEmailOnce: vi.fn(m.enqueueEmailOnce) }; });

// The dispute's audit write fails once, armed immediately before the call under test.
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

import { sql } from "@/lib/db";
import { enqueueEmailOnce, type OutboxKind } from "@/server/email-outbox";
import { idempotencyKey } from "@/server/email-outbox/constants";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { handleRegistrationCheckoutCompleted, handleRegistrationDispute, withdrawRegistrationPublic } from "../registrations";
import { stubOutboxEnv } from "./_invite-mail";
import { fakeSession, loadWithGroup, makeUser, seedRegistration, stripeRig } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const ALERT = "registration_dispute_alert" as const;
const LOST = "registration_dispute_lost" as const;
const FEE = 1200;

const made = { orgIds: [] as string[], userIds: [] as string[] };

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where org_id = any(${made.orgIds}::uuid[]) or ref_id like ${`dp_${RUN}_%`}`;
  if (made.orgIds.length > 0) await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  await sql`delete from subscriptions where owner_user_id = any(${made.userIds}::uuid[])`;
  await sql`delete from users where id = any(${made.userIds}::uuid[])`;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

beforeEach(() => {
  stubOutboxEnv();
  auditGate.failOnce = false;
  vi.mocked(enqueueEmailOnce).mockClear();
  deliverMock.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_dp_${randomUUID()}` }));
  stripeMock.refundCreate.mockReset().mockImplementation(async () => ({ id: `re_dp_${RUN}_${randomUUID().slice(0, 8)}` }));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fixtures and readers
// ---------------------------------------------------------------------------------------------------------------------------------

const address = (tag: string): string => `dp-${tag}-${randomUUID().slice(0, 8)}@test.local`;

/** A card-paid division whose one owner has the given account language, in an org with the given default. */
async function world(o: { ownerLocale: string | null; orgDefault: string }) {
  const w = await stripeRig({ feeCents: FEE });
  made.orgIds.push(w.orgId);
  made.userIds.push(w.ownerId);
  await sql`update users set locale = ${o.ownerLocale} where id = ${w.ownerId}`;
  await sql`update organizations set default_locale = ${o.orgDefault} where id = ${w.orgId}`;
  const [owner] = await sql<{ email: string }[]>`select email from users where id = ${w.ownerId}`;
  return { ...w, ownerEmail: owner!.email };
}

/** An entry the webhook confirmed as paid. Its cart carries the payment intent a dispute names. */
async function paidEntry(w: Awaited<ReturnType<typeof world>>) {
  const seeded = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("entry") });
  await handleRegistrationCheckoutCompleted(fakeSession(seeded.registration.id, FEE));
  const row = await loadWithGroup(seeded.registration.id);
  expect(row.status, "premise: the webhook confirmed the paid entry").toBe("confirmed");
  expect(row.payment_intent_id, "premise: the cart carries its payment intent").toBeTruthy();
  return { regId: seeded.registration.id, token: seeded.access_token, intent: row.payment_intent_id! };
}

let seq = 0;
/** A Stripe dispute id unique to this run (the once-key index is global, so a fixed id would collide with an earlier run's row). */
const newDisputeId = (): string => `dp_${RUN}_${++seq}`;
const disputeOf = (id: string, intent: string | null, over: Record<string, unknown> = {}) =>
  ({ id, payment_intent: intent, amount: FEE, status: "needs_response", ...over }) as unknown as Stripe.Dispute;

type Row = {
  id: string;
  kind: string;
  ref_type: string;
  ref_id: string;
  org_id: string | null;
  recipient: string;
  recipient_user_id: string | null;
  subject: string;
  status: string;
  attempts: number;
  transactional: boolean;
  dedupe_key: string | null;
};

const rowsOf = (kind: OutboxKind, disputeIds: string[]) =>
  sql<Row[]>`
    select id, kind, ref_type, ref_id, org_id, recipient, recipient_user_id, subject, status, attempts, transactional, dedupe_key
      from email_outbox
     where kind = ${kind} and ref_id = any(${disputeIds}::text[])
     order by created_at, id`;

/** The enqueue calls this producer made for a kind and dispute (the spy sees every caller, so it is filtered). */
const enqueueCalls = (kind: OutboxKind, disputeId: string) =>
  vi.mocked(enqueueEmailOnce).mock.calls.filter(([, m]) => m.kind === kind && m.refId === disputeId);

const transportCallsFor = (rowId: string) =>
  deliverMock.mock.calls.filter((c) => (c[0] as { idempotencyKey: string }).idempotencyKey === idempotencyKey(rowId));

// ---------------------------------------------------------------------------------------------------------------------------------
// Email 1: the alert when a dispute opens
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("a disputed entry fee alerts the org owner through the outbox (DB)", () => {
  it("a dispute queues one alert to the org owner, in the owner's language, for the worker", async () => {
    const w = await world({ ownerLocale: "fr", orgDefault: "es" });
    const e = await paidEntry(w);
    const id = newDisputeId();

    await expect(handleRegistrationDispute(disputeOf(id, e.intent), "created")).resolves.toBe(true);

    const rows = await rowsOf(ALERT, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: ALERT,
      ref_type: "dispute",
      ref_id: id,
      dedupe_key: `${id}:created`,
      org_id: w.orgId,
      recipient_user_id: w.ownerId,
      recipient: w.ownerEmail,
      transactional: false,
      status: "queued",
      attempts: 0,
    });
    const subject = dictionarySubject("fr", "disputeAlert.subject", { competitionName: w.competition.name });
    // The right answer is not a wrong one's constant: not English, and not the org default's language.
    expect(subject).not.toBe(dictionarySubject("en", "disputeAlert.subject", { competitionName: w.competition.name }));
    expect(subject).not.toBe(dictionarySubject("es", "disputeAlert.subject", { competitionName: w.competition.name }));
    expect(rows[0]!.subject).toBe(subject);
    expect(transportCallsFor(rows[0]!.id), "the webhook did not attempt the send: the first attempt is the worker's").toHaveLength(0);
    // The cart records the dispute in the same transaction.
    const after = await loadWithGroup(e.regId);
    expect(after.dispute_id).toBe(id);
    expect(after.disputed_at).not.toBeNull();
  });

  it("the same dispute delivered twice queues one alert", async () => {
    const w = await world({ ownerLocale: "fr", orgDefault: "en" });
    const e = await paidEntry(w);
    const id = newDisputeId();

    await handleRegistrationDispute(disputeOf(id, e.intent), "created");
    await handleRegistrationDispute(disputeOf(id, e.intent), "created"); // Stripe's retry, or an /admin/billing-events replay

    expect(await rowsOf(ALERT, [id])).toHaveLength(1);
    // Asked once: the second delivery is not a transition (the cart already names this dispute), so it never reaches the once-key.
    expect(enqueueCalls(ALERT, id)).toHaveLength(1);
  });

  it("an older dispute's created, arriving after a newer one's, does not alert twice", async () => {
    const w = await world({ ownerLocale: "fr", orgDefault: "en" });
    const e = await paidEntry(w);
    const a = newDisputeId();
    const b = newDisputeId();

    await handleRegistrationDispute(disputeOf(a, e.intent), "created");
    await handleRegistrationDispute(disputeOf(b, e.intent), "created");
    await handleRegistrationDispute(disputeOf(a, e.intent), "created"); // a's created again, after b moved the cart on

    // The third call IS a transition (b -> a), so the producer asks again; the once-key is what keeps a's alert single.
    expect(enqueueCalls(ALERT, a).length + enqueueCalls(ALERT, b).length, "three asks").toBe(3);
    const rows = await rowsOf(ALERT, [a, b]);
    expect(rows.map((r) => r.dedupe_key)).toEqual([`${a}:created`, `${b}:created`]);
    expect(rows.map((r) => r.status), "neither was replaced").toEqual(["queued", "queued"]);
  });

  it("empty: a dispute on a charge that is not an entry fee queues nothing", async () => {
    const unknown = newDisputeId();
    const noIntent = newDisputeId();

    await expect(handleRegistrationDispute(disputeOf(unknown, `pi_${RUN}_no_such_cart`), "created")).resolves.toBe(false);
    await expect(handleRegistrationDispute(disputeOf(noIntent, null), "created")).resolves.toBe(false);

    expect(await rowsOf(ALERT, [unknown, noIntent])).toHaveLength(0);
    expect(enqueueCalls(ALERT, unknown)).toHaveLength(0);
    expect(enqueueCalls(ALERT, noIntent)).toHaveLength(0);
  });

  it("an org with no owner records the dispute and queues nothing", async () => {
    const w = await world({ ownerLocale: "fr", orgDefault: "en" });
    const e = await paidEntry(w);
    await sql`update org_members set role = 'admin' where org_id = ${w.orgId} and role = 'owner'`;
    const id = newDisputeId();

    await expect(handleRegistrationDispute(disputeOf(id, e.intent), "created")).resolves.toBe(true);

    expect((await loadWithGroup(e.regId)).dispute_id, "the dispute is recorded all the same").toBe(id);
    expect(await rowsOf(ALERT, [id])).toHaveLength(0);
    expect(enqueueCalls(ALERT, id)).toHaveLength(0);
  });

  it("D4: an owner with no language gets the org's default", async () => {
    const w = await world({ ownerLocale: null, orgDefault: "nl" });
    const e = await paidEntry(w);
    const id = newDisputeId();

    await handleRegistrationDispute(disputeOf(id, e.intent), "created");

    const rows = await rowsOf(ALERT, [id]);
    expect(rows).toHaveLength(1);
    const subject = dictionarySubject("nl", "disputeAlert.subject", { competitionName: w.competition.name });
    expect(subject).not.toBe(dictionarySubject("en", "disputeAlert.subject", { competitionName: w.competition.name }));
    expect(rows[0]!.subject).toBe(subject);
  });

  it("rollback: a failing audit leaves no alert", async () => {
    const w = await world({ ownerLocale: "fr", orgDefault: "en" });
    const e = await paidEntry(w);
    const id = newDisputeId();

    auditGate.failOnce = true;
    await expect(handleRegistrationDispute(disputeOf(id, e.intent), "created")).rejects.toThrow(/audit is down/);

    // The enqueue ran before the audit failed: the rollback, not a skipped enqueue, is why no row is left.
    expect(enqueueCalls(ALERT, id), "premise: the alert was written inside the transaction").toHaveLength(1);
    expect(await rowsOf(ALERT, [id]), "the alert did not outlive the rollback").toHaveLength(0);
    const after = await loadWithGroup(e.regId);
    expect(after.dispute_id, "and neither did the dispute's own record").toBeNull();
    expect(after.disputed_at).toBeNull();
  });

  it("ownership transfer: the alert goes to the current owner", async () => {
    const w = await world({ ownerLocale: "fr", orgDefault: "en" });
    const e = await paidEntry(w);
    // The transfer flips the old owner to admin and seats the new one (organizations.created_by stays on the old one).
    const newOwnerId = await makeUser("newowner");
    made.userIds.push(newOwnerId);
    await sql`update org_members set role = 'admin' where org_id = ${w.orgId} and role = 'owner'`;
    await sql`insert into org_members (org_id, user_id, role) values (${w.orgId}, ${newOwnerId}, 'owner')`;
    const [{ email: newOwnerEmail }] = await sql<{ email: string }[]>`select email from users where id = ${newOwnerId}`;
    const id = newDisputeId();

    await handleRegistrationDispute(disputeOf(id, e.intent), "created");

    const rows = await rowsOf(ALERT, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient_user_id: newOwnerId, recipient: newOwnerEmail });
  });

  it("after a withdrawal: a dispute on a withdrawn, refunded entry still alerts", async () => {
    const w = await world({ ownerLocale: "fr", orgDefault: "en" });
    const e = await paidEntry(w);
    await withdrawRegistrationPublic(e.regId, e.token);
    const withdrawn = await loadWithGroup(e.regId);
    expect(withdrawn.status, "premise: the entry is withdrawn").toBe("withdrawn");
    expect(withdrawn.refunded_cents, "premise: and refunded in full").toBe(FEE);
    const id = newDisputeId();

    await expect(handleRegistrationDispute(disputeOf(id, e.intent), "created")).resolves.toBe(true);

    // The chargeback is about money, whatever the entry's state.
    expect(await rowsOf(ALERT, [id])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Email 2: the notice when a dispute closes lost
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("a lost dispute notifies the org owner through the outbox (DB)", () => {
  it("one dispute's alert and lost notice are two rows, and neither replaces the other", async () => {
    const w = await world({ ownerLocale: "fr", orgDefault: "en" });
    const e = await paidEntry(w);
    const id = newDisputeId();

    await handleRegistrationDispute(disputeOf(id, e.intent), "created");
    // Closed lost, with no charge on the dispute: the balance recovery is skipped and Stripe is not called.
    await handleRegistrationDispute(disputeOf(id, e.intent, { status: "lost" }), "closed");

    const alert = await rowsOf(ALERT, [id]);
    const lost = await rowsOf(LOST, [id]);
    // Same ref and recipient, different kinds: the replace rule (kind + ref + recipient) pairs neither with the other.
    expect(alert.map((r) => ({ dedupe_key: r.dedupe_key, status: r.status }))).toEqual([{ dedupe_key: `${id}:created`, status: "queued" }]);
    expect(lost.map((r) => ({ dedupe_key: r.dedupe_key, status: r.status }))).toEqual([{ dedupe_key: `${id}:lost`, status: "queued" }]);
    for (const r of [...alert, ...lost]) {
      expect(r, `${r.kind}: the owner's account, for the worker`).toMatchObject({ ref_type: "dispute", ref_id: id, recipient_user_id: w.ownerId, attempts: 0 });
    }
    expect(lost[0]!.subject).toBe(dictionarySubject("fr", "disputeLost.subject", { competitionName: w.competition.name }));
    expect(transportCallsFor(lost[0]!.id), "the webhook did not attempt the send").toHaveLength(0);
  });
});
