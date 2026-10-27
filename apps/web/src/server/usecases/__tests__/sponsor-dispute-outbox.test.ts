// Phase 3 wave 2, Batch C: the organiser's sponsorship-chargeback mail goes through the email outbox. All three are addressed to the org's
// current owner (an account: the address is resolved at send), in the owner's language (D4: the account's, then the org default), with
// ref `dispute/<Stripe dispute id>`, and the worker makes the first attempt (a webhook has no response to defer behind).
//   - Email 6, `sponsor_dispute_alert`: a dispute that opens on a sponsor's payment queues the alert (once-key `<dispute id>:created`) in
//     the transaction that flags the order, and only on the transition to THIS dispute (the order's prior dispute, read under lock).
//     A formal dispute takes the money at once, so the same transaction parks the placement. An inquiry (`warning_*`) takes no money:
//     the order is flagged and the owner alerted, but the placement stays live until Stripe reports the money taken
//     (`charge.dispute.funds_withdrawn`), which parks it and queues nothing (owner, 2026-10-26).
//   - Email 7, `sponsor_dispute_won`: a dispute that closes won queues the notice (once-key `<dispute id>:won`) in the transaction that
//     clears the flag, and only on the transition (the order, read under lock, still carried the flag). An inquiry that closes without
//     a chargeback (`warning_closed`) is the same outcome: no money was taken, so it takes the won path and its notice. The placement
//     comes back and the notice goes only while the order is still paid: an inquiry answered with a full refund stays down.
//   - Email 8, `sponsor_dispute_lost`: a dispute that closes lost writes the order off, recovers the club's share from its balance, then
//     queues the notice (once-key `<dispute id>:lost`) carrying what was recovered. A replayed close that finds its own reversal already
//     made (the recovery's metadata guard) queues nothing.
//
// Producer under test: `handleSponsorDispute`, driven directly as the billing webhook calls it (and, for the withdrawal's routing, through
// the real `runEvent`: the ledger claim, then the dispatch the webhook and the staff replay share). Only the network seams are replaced
// (Stripe, for the lost dispute's balance recovery; `@/server/email-outbox/transport`). The enqueue is the real one, observed through a
// spy that calls through, so a test can tell "not written because the key was taken" from "never asked".
//
// Sport: not applicable. A chargeback notice does not vary by sport (spec, Test strategy 4); the locale is the axis that varies.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Stripe, as the lost dispute's balance recovery sees it: the charge (expanded with its transfer to the club), the transfer's reversals
// (the recovery's replay guard reads them back by `metadata.dispute_id`) and the reversal it makes.
const stripeMock = vi.hoisted(() => {
  const reversals: { amount: number; metadata: Record<string, string> }[] = [];
  const chargesRetrieve = vi.fn();
  const listReversals = vi.fn();
  const createReversal = vi.fn();
  return { reversals, chargesRetrieve, listReversals, createReversal, stripe: { charges: { retrieve: chargesRetrieve }, transfers: { listReversals, createReversal } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

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
import { CONNECT_SCOPED_EVENT_TYPES, HANDLED_EVENT_TYPES, runEvent } from "../billing-events";
import { handleRegistrationCheckoutCompleted } from "../registrations";
import { handleSponsorChargeRefunded, handleSponsorDispute, listSponsorRows, patchSponsor } from "../sponsors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { stubOutboxEnv } from "./_invite-mail";
import { cleanUpSponsorOrgs, seedSponsorOrder } from "./_money-fixtures";
import { fakeSession, loadWithGroup, seedRegistration, stripeRig } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const ALERT = "sponsor_dispute_alert" as const;
const WON = "sponsor_dispute_won" as const;
const LOST = "sponsor_dispute_lost" as const;
/** The charge the fixture's order paid (25000), its platform fee, and the transfer that carried the rest to the club. */
const CHARGE_CENTS = 25000;
const APP_FEE_CENTS = 1250;
/** An entry fee, for the one test that disputes an entry next to a sponsorship. */
const ENTRY_FEE_CENTS = 1200;

const made = { orgIds: [] as string[], userIds: [] as string[], eventIds: [] as string[] };

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from billing_events where id = any(${made.eventIds}::text[])`;
  await cleanUpSponsorOrgs(made.orgIds, made.userIds);
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

beforeEach(() => {
  stubOutboxEnv();
  vi.mocked(enqueueEmailOnce).mockClear();
  deliverMock.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_spo_${randomUUID()}` }));
  stripeMock.reversals.length = 0;
  stripeMock.chargesRetrieve.mockReset().mockImplementation(async (id: string) => ({
    id,
    amount: CHARGE_CENTS,
    application_fee_amount: APP_FEE_CENTS,
    transfer: { id: `tr_spo_${RUN}`, amount: CHARGE_CENTS, amount_reversed: 0 },
  }));
  stripeMock.listReversals.mockReset().mockImplementation(async () => ({ data: [...stripeMock.reversals] }));
  stripeMock.createReversal.mockReset().mockImplementation(async (_transfer: string, params: { amount: number; metadata: Record<string, string> }) => {
    stripeMock.reversals.push({ amount: params.amount, metadata: params.metadata });
    return { id: `trr_spo_${randomUUID().slice(0, 8)}`, amount: params.amount };
  });
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

/** The org owner, managing placements in the console. */
const ownerAuth = (o: { orgId: string; ownerId: string }): AuthCtx => ({ orgId: o.orgId, via: "session", userId: o.ownerId, role: "owner", keyId: null });

/** The placement's row as the sponsor console lists it. */
const consoleRow = async (o: { orgId: string; sponsorId: string | null }) => {
  const row = (await listSponsorRows(o.orgId)).find((r) => r.id === o.sponsorId);
  expect(row, "premise: the console lists the placement").toBeDefined();
  return row!;
};

/** A `charge.dispute.*` event as the webhook receives it (a fresh event id each), for the tests that go through `runEvent`. */
const disputeEvent = (type: "created" | "funds_withdrawn", disputeId: string, intent: string, amount: number, status: string): Stripe.Event => {
  const id = `evt_spo_${RUN}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  made.eventIds.push(id);
  return {
    id,
    type: `charge.dispute.${type}`,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: disputeId, object: "dispute", payment_intent: intent, amount, status } },
  } as unknown as Stripe.Event;
};

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
    // A formal dispute (`needs_response`) takes the money at once: the order is flagged and the placement parked, in the same transaction.
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

  it("an org with no owner: every dispute step is recorded all the same, and nothing is queued", async () => {
    const o = await paidOrder({ ownerLocale: "fr", defaultLocale: "en" });
    await sql`update org_members set role = 'admin' where org_id = ${o.orgId} and role = 'owner'`;
    const a = newDisputeId();
    const b = newDisputeId();

    await expect(handleSponsorDispute(disputeOf(a, o.intent), "created")).resolves.toBe(true);
    const flagged = await orderState(o.orderId);
    expect(flagged.dispute_id, "the dispute is recorded").toBe(a);
    expect(flagged.sponsor_status, "and the placement is parked: that does not wait on someone to tell").toBe("pending");

    await expect(handleSponsorDispute(disputeOf(a, o.intent, { status: "won" }), "closed")).resolves.toBe(true);
    const cleared = await orderState(o.orderId);
    expect(cleared.disputed_at, "a win clears the flag").toBeNull();
    expect(cleared.sponsor_status, "and restores the placement").toBe("active");

    await handleSponsorDispute(disputeOf(b, o.intent), "created");
    // No charge on the dispute: the recovery is skipped (nothing reaches Stripe).
    await expect(handleSponsorDispute(disputeOf(b, o.intent, { status: "lost" }), "closed")).resolves.toBe(true);
    const writtenOff = await orderState(o.orderId);
    expect(writtenOff.status, "a loss writes the order off").toBe("refunded");
    expect(writtenOff.sponsor_status, "and takes the placement down").toBe("inactive");

    for (const kind of [ALERT, WON, LOST] as const) {
      expect(await rowsOf(kind, [a, b]), `${kind}: no row`).toHaveLength(0);
      expect(enqueueCalls(kind, a).length + enqueueCalls(kind, b).length, `${kind}: never asked`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// A card inquiry alerts the owner and leaves the sponsor live; the money taken hides it (owner, 2026-10-26)
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("a card inquiry leaves the sponsor live; the money taken hides it (DB)", () => {
  it("an inquiry (warning_needs_response) flags the order and alerts the owner, and the sponsor stays active", async () => {
    // Stripe (docs, disputes/how-disputes-work): an inquiry is the cardholder's bank asking questions. Only a formal dispute "initiates a
    // chargeback", where "the card network pulls the funds". No money has left the club, so the sponsor it paid for stays on show.
    const o = await paidOrder({ ownerLocale: "fr", defaultLocale: "en" });
    const id = newDisputeId();

    await expect(handleSponsorDispute(disputeOf(id, o.intent, { status: "warning_needs_response" }), "created")).resolves.toBe(true);

    const after = await orderState(o.orderId);
    expect(after.dispute_id, "the inquiry is recorded on the order").toBe(id);
    expect(after.disputed_at).not.toBeNull();
    expect(after.status, "nothing is written off").toBe("paid");
    expect(after.sponsor_status, "and the placement stays live").toBe("active");
    const rows = await rowsOf(ALERT, [id]);
    expect(rows, "the owner is alerted").toHaveLength(1);
    expect(rows[0]).toMatchObject({ dedupe_key: `${id}:created`, recipient_user_id: o.ownerId, recipient: o.ownerEmail, status: "queued" });
  });

  it("money taken on the inquiry (funds_withdrawn) hides the sponsor once", async () => {
    // Stripe sends `charge.dispute.funds_withdrawn` when a dispute takes the money ("funds are removed from your account due to a
    // dispute"): for an inquiry, when the network escalates it to a chargeback. That hides the placement. It queues nothing: the owner
    // was alerted when the inquiry opened.
    const o = await paidOrder({ ownerLocale: "fr", defaultLocale: "en" });
    const id = newDisputeId();
    const withdrawn = disputeOf(id, o.intent, { status: "needs_response" });

    await handleSponsorDispute(disputeOf(id, o.intent, { status: "warning_needs_response" }), "created");
    expect((await orderState(o.orderId)).sponsor_status, "premise: the inquiry left the placement live").toBe("active");

    await expect(handleSponsorDispute(withdrawn, "funds_withdrawn")).resolves.toBe(true);
    const hidden = await orderState(o.orderId);
    expect(hidden.sponsor_status, "the money is taken: the placement is hidden").toBe("pending");
    expect(hidden.disputed_at, "the dispute is still open").not.toBeNull();
    expect(hidden.status, "and nothing is written off before it is lost").toBe("paid");

    await handleSponsorDispute(withdrawn, "funds_withdrawn"); // Stripe's retry, or an /admin/billing-events replay
    expect((await orderState(o.orderId)).sponsor_status, "a redelivery changes nothing").toBe("pending");

    // Once: the dispute is won and the placement comes back (the won path, unchanged); a withdrawal delivered after that does not hide
    // it again.
    await handleSponsorDispute(disputeOf(id, o.intent, { status: "won" }), "closed");
    expect((await orderState(o.orderId)).sponsor_status, "premise: the win brought the placement back").toBe("active");
    await handleSponsorDispute(withdrawn, "funds_withdrawn");
    expect((await orderState(o.orderId)).sponsor_status, "a withdrawal delivered after the win leaves it live").toBe("active");

    expect(await rowsOf(ALERT, [id]), "still exactly one alert").toHaveLength(1);
    expect(enqueueCalls(ALERT, id), "asked once: a withdrawal queues no mail").toHaveLength(1);
  });

  it("empty: with no dispute, a placement the organiser holds as pending is not parked and goes live", async () => {
    const o = await paidOrder({ ownerLocale: "fr", defaultLocale: "en" });

    await expect(patchSponsor(ownerAuth(o), o.sponsorId!, { status: "pending" })).resolves.toMatchObject({ status: "pending" });
    expect((await consoleRow(o)).dispute_parked, "held by the organiser, not parked by a dispute").toBe(false);
    await expect(patchSponsor(ownerAuth(o), o.sponsorId!, { status: "active" })).resolves.toMatchObject({ status: "active" });
  });

  it("during an inquiry the console does not call the live placement parked, and the organiser can switch it off and on", async () => {
    const o = await paidOrder({ ownerLocale: "fr", defaultLocale: "en" });
    const id = newDisputeId();

    await handleSponsorDispute(disputeOf(id, o.intent, { status: "warning_needs_response" }), "created");
    expect((await orderState(o.orderId)).disputed_at, "premise: the inquiry flagged the order").not.toBeNull();

    expect((await consoleRow(o)).dispute_parked, "not parked: the placement is live").toBe(false);
    await expect(patchSponsor(ownerAuth(o), o.sponsorId!, { status: "inactive" })).resolves.toMatchObject({ status: "inactive" });
    await expect(patchSponsor(ownerAuth(o), o.sponsorId!, { status: "active" })).resolves.toMatchObject({ status: "active" });
  });

  it("once the money is taken the console calls the placement parked, and no status change by hand brings it back", async () => {
    const o = await paidOrder({ ownerLocale: "fr", defaultLocale: "en" });
    const id = newDisputeId();

    await handleSponsorDispute(disputeOf(id, o.intent, { status: "warning_needs_response" }), "created");
    await handleSponsorDispute(disputeOf(id, o.intent, { status: "needs_response" }), "funds_withdrawn");
    expect((await orderState(o.orderId)).sponsor_status, "premise: the withdrawal parked the placement").toBe("pending");

    expect((await consoleRow(o)).dispute_parked, "parked by the dispute").toBe(true);
    await expect(patchSponsor(ownerAuth(o), o.sponsorId!, { status: "active" }), "not straight back on").rejects.toMatchObject({ status: 409 });
    // Nor the long way round: switched off by hand, the placement would no longer read as parked, and `active` would then pass.
    await expect(patchSponsor(ownerAuth(o), o.sponsorId!, { status: "inactive" }), "nor off, then on").rejects.toMatchObject({ status: 409 });
    expect((await orderState(o.orderId)).sponsor_status, "the placement stays parked").toBe("pending");
  });

  it("through the real dispatch, a funds_withdrawn event hides the sponsor and leaves an entry fee's dispute as it was", async () => {
    // A platform event: a sponsorship or an entry fee is a destination charge, so its dispute is the platform's, as for
    // `charge.dispute.created`, and arrives on the platform's own destination, not the connected accounts'.
    expect(HANDLED_EVENT_TYPES, "the console's Stripe filter asks for it").toContain("charge.dispute.funds_withdrawn");
    expect(CONNECT_SCOPED_EVENT_TYPES).not.toContain("charge.dispute.funds_withdrawn");

    // A sponsorship's inquiry, then the money taken.
    const o = await paidOrder({ ownerLocale: "fr", defaultLocale: "en" });
    const sp = newDisputeId();
    expect(await runEvent(disputeEvent("created", sp, o.intent, CHARGE_CENTS, "warning_needs_response")), "premise: the dispatch ran").toBe(true);
    expect((await orderState(o.orderId)).sponsor_status, "premise: the inquiry left the placement live").toBe("active");
    expect(await runEvent(disputeEvent("funds_withdrawn", sp, o.intent, CHARGE_CENTS, "needs_response"))).toBe(true);
    expect((await orderState(o.orderId)).sponsor_status, "the withdrawal reached the sponsor's handler").toBe("pending");

    // An entry fee's dispute, then the money taken. The entry-fee path records a dispute at `created` and settles it at `closed`; the
    // withdrawal is not its event, so the cart's record does not move (a `created` would re-stamp `disputed_at` and audit again).
    const w = await stripeRig({ feeCents: ENTRY_FEE_CENTS });
    made.orgIds.push(w.orgId);
    made.userIds.push(w.ownerId);
    const seeded = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: `spo-${RUN}-${++seq}@test.local` });
    await handleRegistrationCheckoutCompleted(fakeSession(seeded.registration.id, ENTRY_FEE_CENTS));
    const entryIntent = (await loadWithGroup(seeded.registration.id)).payment_intent_id;
    expect(entryIntent, "premise: the paid cart carries its payment intent").toBeTruthy();
    const rg = newDisputeId();
    const cartDispute = async () => {
      const g = await loadWithGroup(seeded.registration.id);
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from competition_events
         where competition_id = ${w.competition.id} and type like 'registration.%' and payload->>'dispute_id' = ${rg}`;
      return { disputed_at: g.disputed_at, dispute_id: g.dispute_id, cart_refunded_cents: g.group_refunded_cents, audits: n };
    };
    await runEvent(disputeEvent("created", rg, entryIntent!, ENTRY_FEE_CENTS, "needs_response"));
    const before = await cartDispute();
    expect(before.dispute_id, "premise: the entry fee's dispute is recorded").toBe(rg);
    expect(before.audits, "premise: and audited once").toBe(1);

    expect(await runEvent(disputeEvent("funds_withdrawn", rg, entryIntent!, ENTRY_FEE_CENTS, "needs_response")), "taken, not refused").toBe(true);
    expect(await cartDispute(), "the cart's dispute record is unchanged").toEqual(before);
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

  it("a closed inquiry (warning_closed) clears the flag, leaves the placement live and queues the won notice once", async () => {
    // Stripe's inquiry: it opens as `charge.dispute.created` with status `warning_needs_response` (no money is withdrawn), and when the
    // bank drops it without a chargeback it closes as `charge.dispute.closed` with status `warning_closed`. The money stays with the
    // club, so the placement stays live throughout and the owner hears the dispute closed in their favour.
    const o = await paidOrder({ ownerLocale: "fr", defaultLocale: "en" });
    const id = newDisputeId();

    await handleSponsorDispute(disputeOf(id, o.intent, { status: "warning_needs_response" }), "created");
    const flagged = await orderState(o.orderId);
    expect(flagged.disputed_at, "premise: the inquiry flagged the order").not.toBeNull();
    expect(flagged.sponsor_status, "premise: and left the placement live (an inquiry takes no money)").toBe("active");

    await expect(handleSponsorDispute(disputeOf(id, o.intent, { status: "warning_closed" }), "closed")).resolves.toBe(true);
    await handleSponsorDispute(disputeOf(id, o.intent, { status: "warning_closed" }), "closed"); // Stripe's retry, or a replay

    const after = await orderState(o.orderId);
    expect(after.disputed_at, "the flag is cleared").toBeNull();
    expect(after.sponsor_status, "and the placement is still live").toBe("active");
    expect(after.status, "nothing was written off: an inquiry takes no money").toBe("paid");
    const rows = await rowsOf(WON, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dedupe_key: `${id}:won`, recipient_user_id: o.ownerId, recipient: o.ownerEmail, status: "queued" });
    expect(rows[0]!.subject).toBe(dictionarySubject("fr", "sponsorDisputeWon.subject", { orgName: o.orgName }));
    expect(enqueueCalls(WON, id), "asked once: the redelivery found the flag already clear").toHaveLength(1);
    expect(await rowsOf(LOST, [id]), "and no loss was recorded").toHaveLength(0);
  });

  it("an inquiry closed after the organiser switched the placement off leaves it off", async () => {
    // The inquiry leaves the placement live, so the organiser may switch it off on reading the alert. The close clears the dispute; it
    // brings back only a placement the dispute parked, never one the organiser chose to hide.
    const o = await paidOrder({ ownerLocale: "fr", defaultLocale: "en" });
    const id = newDisputeId();

    await handleSponsorDispute(disputeOf(id, o.intent, { status: "warning_needs_response" }), "created");
    await patchSponsor(ownerAuth(o), o.sponsorId!, { status: "inactive" });
    await expect(handleSponsorDispute(disputeOf(id, o.intent, { status: "warning_closed" }), "closed")).resolves.toBe(true);

    const after = await orderState(o.orderId);
    expect(after.disputed_at, "the dispute is over: the flag is cleared").toBeNull();
    expect(after.sponsor_status, "and the placement stays off").toBe("inactive");
  });

  it("an inquiry that parked its placement before inquiries stopped parking comes back on its close", async () => {
    // Inquiries opened before this change parked the placement at `created`; their `warning_closed` can arrive up to 120 days later.
    // That earlier park is staged as the old `created` left it: the order flagged, the placement 'pending'.
    const o = await paidOrder({ ownerLocale: "fr", defaultLocale: "en" });
    const id = newDisputeId();

    await handleSponsorDispute(disputeOf(id, o.intent, { status: "warning_needs_response" }), "created");
    await sql`update sponsors set status = 'pending' where id = ${o.sponsorId}`;
    expect((await consoleRow(o)).dispute_parked, "premise: the placement reads as parked by the dispute").toBe(true);

    await expect(handleSponsorDispute(disputeOf(id, o.intent, { status: "warning_closed" }), "closed")).resolves.toBe(true);
    expect((await orderState(o.orderId)).sponsor_status, "the close brings it back").toBe("active");
  });

  it("an inquiry answered with a full refund closes with the placement still down and no won notice", async () => {
    // Stripe names a full refund as one of the two ways to resolve an inquiry (docs: disputes/how-disputes-work, "Inquiries"). The
    // refund takes the placement down (charge.refunded); the inquiry's later `warning_closed` must not put a refunded sponsor back on
    // the boards, nor tell the owner "the money stays with you".
    const o = await paidOrder({ ownerLocale: "fr", defaultLocale: "en" });
    const id = newDisputeId();

    await handleSponsorDispute(disputeOf(id, o.intent, { status: "warning_needs_response" }), "created");
    await handleSponsorChargeRefunded({ payment_intent: o.intent, refunded: true } as unknown as Stripe.Charge);
    const refunded = await orderState(o.orderId);
    expect(refunded.status, "premise: the refund wrote the order down").toBe("refunded");
    expect(refunded.sponsor_status, "premise: and took the placement down").toBe("inactive");

    await expect(handleSponsorDispute(disputeOf(id, o.intent, { status: "warning_closed" }), "closed")).resolves.toBe(true);

    const after = await orderState(o.orderId);
    expect(after.disputed_at, "the dispute is over: the flag is cleared").toBeNull();
    expect(after.status, "the order stays refunded").toBe("refunded");
    expect(after.sponsor_status, "and the placement stays down").toBe("inactive");
    expect(await rowsOf(WON, [id]), "no won notice").toHaveLength(0);
    expect(enqueueCalls(WON, id), "never asked").toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Email 8: the notice when a dispute closes lost
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("a sponsorship dispute that closes lost tells the org owner through the outbox (DB)", () => {
  it("lost queues one notice carrying the recovered amount; a replay with the metadata guard hit queues none", async () => {
    const o = await paidOrder({ ownerLocale: "es", defaultLocale: "en" });
    const id = newDisputeId();
    const lost = disputeOf(id, o.intent, { status: "lost", charge: `ch_${id}` });

    await handleSponsorDispute(disputeOf(id, o.intent), "created");
    await expect(handleSponsorDispute(lost, "closed")).resolves.toBe(true);
    await handleSponsorDispute(lost, "closed"); // Stripe's retry, or an /admin/billing-events replay: its reversal is made already

    // Premise: the first close reversed the club's share once, and the replay found that reversal (the recovery's guard).
    expect(stripeMock.createReversal).toHaveBeenCalledTimes(1);
    expect(stripeMock.reversals[0]!.metadata.dispute_id).toBe(id);
    const recoveredCents = stripeMock.reversals[0]!.amount;
    expect(recoveredCents, "premise: something was recovered, and it is not the disputed amount").toBeGreaterThan(0);
    expect(recoveredCents).not.toBe(CHARGE_CENTS);

    const rows = await rowsOf(LOST, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: LOST,
      ref_type: "dispute",
      ref_id: id,
      dedupe_key: `${id}:lost`,
      org_id: o.orgId,
      recipient_user_id: o.ownerId,
      recipient: o.ownerEmail,
      transactional: false,
      status: "queued",
      attempts: 0,
    });
    const subject = dictionarySubject("es", "sponsorDisputeLost.subject", { orgName: o.orgName });
    expect(subject, "the Spanish subject is not the English one").not.toBe(dictionarySubject("en", "sponsorDisputeLost.subject", { orgName: o.orgName }));
    expect(rows[0]!.subject).toBe(subject);
    expect(transportCallsFor(rows[0]!.id), "the webhook did not attempt the send: the first attempt is the worker's").toHaveLength(0);
    // Asked once: the replay's recovery reported the reversal already made, so the producer never asked again.
    const calls = enqueueCalls(LOST, id);
    expect(calls).toHaveLength(1);
    // The notice states what Stripe was asked to reverse (every amount in these mails is en-GB money).
    const recovered = `£${(recoveredCents / 100).toFixed(2)}`;
    expect(calls[0]![1].text).toContain(dictionarySubject("es", "sponsorDisputeLost.textRecovered", { recovered }));
    const after = await orderState(o.orderId);
    expect(after.status, "the order is written off").toBe("refunded");
    expect(after.sponsor_status, "and the placement taken down").toBe("inactive");
  });

  it("created then lost are two rows, neither replaced", async () => {
    const o = await paidOrder({ ownerLocale: "fr", defaultLocale: "en" });
    const a = newDisputeId();

    await handleSponsorDispute(disputeOf(a, o.intent), "created");
    // No charge on the dispute: the recovery is skipped (nothing reaches Stripe) and nothing is recovered.
    await handleSponsorDispute(disputeOf(a, o.intent, { status: "lost" }), "closed");

    const alert = await rowsOf(ALERT, [a]);
    const lostRows = await rowsOf(LOST, [a]);
    expect(alert.map((r) => r.dedupe_key)).toEqual([`${a}:created`]);
    expect(lostRows.map((r) => r.dedupe_key)).toEqual([`${a}:lost`]);
    expect([...alert, ...lostRows].map((r) => r.status), "neither replaced the other").toEqual(["queued", "queued"]);
    expect([...alert, ...lostRows].map((r) => r.recipient_user_id)).toEqual([o.ownerId, o.ownerId]);
    expect(stripeMock.chargesRetrieve, "premise: the recovery was skipped").not.toHaveBeenCalled();
    expect(enqueueCalls(LOST, a)[0]![1].text, "the notice says nothing was recovered").toContain(
      dictionarySubject("fr", "sponsorDisputeLost.textNotRecovered", {}),
    );
  });
});
