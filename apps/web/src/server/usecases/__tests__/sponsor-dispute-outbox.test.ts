// Phase 3 wave 2, Batch C: the organiser's sponsorship-chargeback mail goes through the email outbox. All three are addressed to the org's
// current owner (an account: the address is resolved at send), in the owner's language (D4: the account's, then the org default), with
// ref `dispute/<Stripe dispute id>`, and the worker makes the first attempt (a webhook has no response to defer behind).
//   - Email 6, `sponsor_dispute_alert`: a dispute that opens on a sponsor's payment queues the alert (once-key `<dispute id>:created`) in
//     the transaction that flags the order, and only on the transition to THIS dispute (the order's prior dispute, read under lock).
//   - Email 7, `sponsor_dispute_won`: a dispute that closes won queues the notice (once-key `<dispute id>:won`) in the transaction that
//     clears the flag, and only on the transition (the order, read under lock, still carried the flag).
//
// Producer under test: `handleSponsorDispute`, driven directly as the billing webhook calls it. Only the network seam is replaced
// (`@/server/email-outbox/transport`). The enqueue is the real one, observed through a spy that calls through, so a test can tell "not
// written because the key was taken" from "never asked".
//
// Sport: not applicable. A chargeback notice does not vary by sport (spec, Test strategy 4); the locale is the axis that varies.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The one network seam of the outbox.
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

// The enqueue, observed: every call reaches the real writer.
vi.mock("@/server/email-outbox", async (io) => { const m = await io<typeof import("@/server/email-outbox")>(); return { ...m, enqueueEmailOnce: vi.fn(m.enqueueEmailOnce) }; });

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { enqueueEmailOnce, type OutboxKind } from "@/server/email-outbox";
import { idempotencyKey } from "@/server/email-outbox/constants";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { handleSponsorDispute } from "../sponsors";
import { stubOutboxEnv } from "./_invite-mail";
import { cleanUpSponsorOrgs, seedSponsorOrder } from "./_money-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const ALERT = "sponsor_dispute_alert" as const;
const WON = "sponsor_dispute_won" as const;

const made = { orgIds: [] as string[], userIds: [] as string[] };

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanUpSponsorOrgs(made.orgIds, made.userIds);
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

beforeEach(() => {
  stubOutboxEnv();
  vi.mocked(enqueueEmailOnce).mockClear();
  deliverMock.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_spo_${randomUUID()}` }));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fixtures and readers
// ---------------------------------------------------------------------------------------------------------------------------------

/** A paid sponsor order (its placement live), its organisation tracked for cleanup. The owner is the dispute mail's recipient. */
async function paidOrder(o: { ownerLocale: string | null; defaultLocale: "en" | "es" | "fr" | "nl" }) {
  const s = await seedSponsorOrder({ status: "paid", ...o });
  made.orgIds.push(s.orgId);
  made.userIds.push(s.ownerId);
  return s;
}

let seq = 0;
/** A Stripe dispute id unique to this run (the once-key index is global, so a fixed id would collide with an earlier run's row). */
const newDisputeId = (): string => `dp_spo_${RUN}_${++seq}`;
const disputeOf = (id: string, intent: string | null, over: Record<string, unknown> = {}) =>
  ({ id, payment_intent: intent, amount: 25000, status: "needs_response", ...over }) as unknown as Stripe.Dispute;

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

/** The enqueue calls the producer made for a kind and dispute (the spy sees every caller, so it is filtered). */
const enqueueCalls = (kind: OutboxKind, disputeId: string) =>
  vi.mocked(enqueueEmailOnce).mock.calls.filter(([, m]) => m.kind === kind && m.refId === disputeId);

const transportCallsFor = (rowId: string) =>
  deliverMock.mock.calls.filter((c) => (c[0] as { idempotencyKey: string }).idempotencyKey === idempotencyKey(rowId));

const orderState = async (orderId: string) =>
  (
    await sql<{ dispute_id: string | null; disputed_at: Date | null; status: string; sponsor_status: string | null }[]>`
      select o.dispute_id, o.disputed_at, o.status, s.status as sponsor_status
        from sponsor_orders o left join sponsors s on s.id = o.sponsor_id
       where o.id = ${orderId}`
  )[0]!;

// ---------------------------------------------------------------------------------------------------------------------------------
// Email 6: the alert when a dispute opens
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("a disputed sponsorship alerts the org owner through the outbox (DB)", () => {
  it("created queues one alert to the owner, in the owner's language, for the worker", async () => {
    const o = await paidOrder({ ownerLocale: "fr", defaultLocale: "es" });
    const id = newDisputeId();

    await expect(handleSponsorDispute(disputeOf(id, o.intent), "created")).resolves.toBe(true);

    const rows = await rowsOf(ALERT, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: ALERT,
      ref_type: "dispute",
      ref_id: id,
      dedupe_key: `${id}:created`,
      org_id: o.orgId,
      recipient_user_id: o.ownerId,
      recipient: o.ownerEmail,
      transactional: false,
      status: "queued",
      attempts: 0,
    });
    const subject = dictionarySubject("fr", "sponsorDisputeAlert.subject", { orgName: o.orgName });
    // The right answer is not a wrong one's constant: not English, and not the org default's language.
    expect(subject).not.toBe(dictionarySubject("en", "sponsorDisputeAlert.subject", { orgName: o.orgName }));
    expect(subject).not.toBe(dictionarySubject("es", "sponsorDisputeAlert.subject", { orgName: o.orgName }));
    expect(rows[0]!.subject).toBe(subject);
    expect(transportCallsFor(rows[0]!.id), "the webhook did not attempt the send: the first attempt is the worker's").toHaveLength(0);
    // R1: the row was written on the transaction that flags the order, not on the pool.
    const calls = enqueueCalls(ALERT, id);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0], "the enqueue ran on a transaction handle, not the pool").not.toBe(sql);
    // The order is flagged and the placement parked, in the same transaction.
    const after = await orderState(o.orderId);
    expect(after.dispute_id).toBe(id);
    expect(after.disputed_at).not.toBeNull();
    expect(after.sponsor_status).toBe("pending");
  });

  it("a redelivered created queues nothing new", async () => {
    const o = await paidOrder({ ownerLocale: "fr", defaultLocale: "en" });
    const id = newDisputeId();

    await handleSponsorDispute(disputeOf(id, o.intent), "created");
    await handleSponsorDispute(disputeOf(id, o.intent), "created"); // Stripe's retry, or an /admin/billing-events replay

    expect(await rowsOf(ALERT, [id])).toHaveLength(1);
    // Asked once: the second delivery is not a transition (the order already names this dispute), so it never reaches the once-key.
    expect(enqueueCalls(ALERT, id)).toHaveLength(1);
  });

  it("an older dispute's created after a newer one's does not alert twice", async () => {
    const o = await paidOrder({ ownerLocale: "fr", defaultLocale: "en" });
    const a = newDisputeId();
    const b = newDisputeId();

    await handleSponsorDispute(disputeOf(a, o.intent), "created");
    await handleSponsorDispute(disputeOf(b, o.intent), "created");
    await handleSponsorDispute(disputeOf(a, o.intent), "created"); // a's created again, after b moved the order on

    // The third call IS a transition (b -> a), so the producer asks again; the once-key is what keeps a's alert single.
    expect(enqueueCalls(ALERT, a).length + enqueueCalls(ALERT, b).length, "three asks").toBe(3);
    const rows = await rowsOf(ALERT, [a, b]);
    expect(rows.map((r) => r.dedupe_key)).toEqual([`${a}:created`, `${b}:created`]);
    expect(rows.map((r) => r.recipient_user_id)).toEqual([o.ownerId, o.ownerId]);
    expect(rows.map((r) => r.status), "neither was replaced").toEqual(["queued", "queued"]);
  });

  it("empty: a dispute on a charge that is not a sponsor's queues nothing", async () => {
    const unknown = newDisputeId();
    const noIntent = newDisputeId();

    await expect(handleSponsorDispute(disputeOf(unknown, `pi_spo_${RUN}_no_such_order`), "created")).resolves.toBe(false);
    await expect(handleSponsorDispute(disputeOf(noIntent, null), "created")).resolves.toBe(false);

    expect(await rowsOf(ALERT, [unknown, noIntent])).toHaveLength(0);
    expect(enqueueCalls(ALERT, unknown)).toHaveLength(0);
    expect(enqueueCalls(ALERT, noIntent)).toHaveLength(0);
  });

  it("an org with no owner: the order is flagged and the placement parked all the same, and nothing is queued", async () => {
    const o = await paidOrder({ ownerLocale: "fr", defaultLocale: "en" });
    await sql`update org_members set role = 'admin' where org_id = ${o.orgId} and role = 'owner'`;
    const id = newDisputeId();

    await expect(handleSponsorDispute(disputeOf(id, o.intent), "created")).resolves.toBe(true);

    const after = await orderState(o.orderId);
    expect(after.dispute_id, "the dispute is recorded").toBe(id);
    expect(after.sponsor_status, "and the placement is parked: that does not wait on someone to tell").toBe("pending");
    expect(await rowsOf(ALERT, [id])).toHaveLength(0);
    expect(enqueueCalls(ALERT, id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Email 7: the notice when a dispute closes won
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("a sponsorship dispute that closes won tells the org owner through the outbox (DB)", () => {
  it("won after created queues one won notice; a redelivered won queues nothing", async () => {
    // D4: the owner's account has no language, so the org default's.
    const o = await paidOrder({ ownerLocale: null, defaultLocale: "nl" });
    const id = newDisputeId();

    await handleSponsorDispute(disputeOf(id, o.intent), "created");
    await expect(handleSponsorDispute(disputeOf(id, o.intent, { status: "won" }), "closed")).resolves.toBe(true);
    await handleSponsorDispute(disputeOf(id, o.intent, { status: "won" }), "closed"); // Stripe's retry, or an /admin/billing-events replay

    const rows = await rowsOf(WON, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: WON,
      ref_type: "dispute",
      ref_id: id,
      dedupe_key: `${id}:won`,
      org_id: o.orgId,
      recipient_user_id: o.ownerId,
      recipient: o.ownerEmail,
      transactional: false,
      status: "queued",
      attempts: 0,
    });
    const subject = dictionarySubject("nl", "sponsorDisputeWon.subject", { orgName: o.orgName });
    expect(subject, "the Dutch subject is not the English one").not.toBe(dictionarySubject("en", "sponsorDisputeWon.subject", { orgName: o.orgName }));
    expect(rows[0]!.subject).toBe(subject);
    expect(transportCallsFor(rows[0]!.id), "the webhook did not attempt the send: the first attempt is the worker's").toHaveLength(0);
    // Asked once: the redelivery found the flag already clear, so it never reached the once-key.
    const calls = enqueueCalls(WON, id);
    expect(calls).toHaveLength(1);
    // R1: the row was written on the transaction that clears the flag, not on the pool.
    expect(calls[0]![0], "the enqueue ran on a transaction handle, not the pool").not.toBe(sql);
    const after = await orderState(o.orderId);
    expect(after.disputed_at, "the flag is cleared").toBeNull();
    expect(after.sponsor_status, "and the placement is live again").toBe("active");
  });

  it("won's once-key alone: a dispute flagged again after its win, and won again, is one notice", async () => {
    const o = await paidOrder({ ownerLocale: "fr", defaultLocale: "en" });
    const a = newDisputeId();

    await handleSponsorDispute(disputeOf(a, o.intent), "created");
    await handleSponsorDispute(disputeOf(a, o.intent, { status: "won" }), "closed");
    await handleSponsorDispute(disputeOf(a, o.intent), "created"); // a's created again: it re-flags the order (coalesce), no new alert
    expect((await orderState(o.orderId)).disputed_at, "premise: the order carries the flag again").not.toBeNull();
    await handleSponsorDispute(disputeOf(a, o.intent, { status: "won" }), "closed");

    // The second won IS a transition (the flag was set again), so the producer asks again; the once-key is what keeps the notice single.
    expect(enqueueCalls(WON, a), "two asks").toHaveLength(2);
    const rows = await rowsOf(WON, [a]);
    expect(rows.map((r) => r.dedupe_key)).toEqual([`${a}:won`]);
    expect(rows[0]).toMatchObject({ recipient_user_id: o.ownerId, status: "queued" });
  });
});
