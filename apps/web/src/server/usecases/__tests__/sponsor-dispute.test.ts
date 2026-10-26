// Sponsor dispute lifecycle (payments-hardening Task 6, P0-2): a chargeback on
// a sponsor package charge is a destination-charge dispute exactly like an
// entry fee — the platform is liable, so `created` flags the order + parks the
// placement, `closed won` restores it, and `closed lost` writes the order off
// and reverses the club's transfer through the shared recovery core. Stripe is
// NOT mocked here: the keyless test env makes getStripe() throw, so recovery
// takes its audited failure path — we assert the money-record flips stuck and
// nothing threw. Real Postgres required; skipped without DATABASE_URL.
//
// Test hygiene: every seed is run-unique (randomUUID) — payment_intent_id and
// dispute ids included — so re-running the file never collides with rows a
// prior run left behind (the handler keys off payment_intent_id).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

// Observe the organiser notifications without touching the rest of the email
// module (send() is a no-op without RESEND_API_KEY either way).
const emailMock = vi.hoisted(() => ({
  lost: vi.fn().mockResolvedValue(true),
  won: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendSponsorDisputeLostEmail: emailMock.lost,
  sendSponsorDisputeWonEmail: emailMock.won,
}));
// The notices that have moved to the email outbox are observed there: the
// enqueue is the real one, through a spy that calls through, and the one
// network seam of the outbox is replaced.
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));
vi.mock("@/server/email-outbox", async (io) => { const m = await io<typeof import("@/server/email-outbox")>(); return { ...m, enqueueEmailOnce: vi.fn(m.enqueueEmailOnce) }; });

import { sql } from "@/lib/db";
import { enqueueEmailOnce, type OutboxKind } from "@/server/email-outbox";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { handleSponsorDispute } from "../sponsors";
import { processStripeEvent } from "@/server/usecases/billing-events";
import { stubOutboxEnv } from "./_invite-mail";
import { seedSponsorOrder } from "./_money-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

const uniq = () => randomUUID().slice(0, 12);

/** Every dispute id a test used, so the outbox rows they queued are removed after the file. */
const disputeIds: string[] = [];
const disputeFor = (intent: string, id: string, status = "needs_response") => {
  disputeIds.push(id);
  return ({ id, payment_intent: intent, amount: 25000, status, charge: "ch_x" }) as unknown as Stripe.Dispute;
};

/** The outbox rows of a kind queued for a dispute. */
const outboxRows = (kind: OutboxKind, disputeId: string) =>
  sql<{ recipient: string; recipient_user_id: string | null; dedupe_key: string | null }[]>`
    select recipient, recipient_user_id, dedupe_key from email_outbox
     where kind = ${kind} and ref_type = 'dispute' and ref_id = ${disputeId}`;
/** The enqueue calls made for a kind and dispute (the spy sees every caller, so it is filtered). */
const enqueued = (kind: OutboxKind, disputeId?: string) =>
  vi.mocked(enqueueEmailOnce).mock.calls.filter(([, m]) => m.kind === kind && (disputeId === undefined || m.refId === disputeId));

beforeEach(() => {
  stubOutboxEnv();
  vi.mocked(enqueueEmailOnce).mockClear();
  deliverMock.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_spd_${randomUUID()}` }));
  emailMock.lost.mockClear();
  emailMock.won.mockClear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where ref_type = 'dispute' and ref_id = any(${disputeIds}::text[])`;
  await sql.end();
});

describe.skipIf(!HAS_DB)("handleSponsorDispute", () => {
  it("created: flags the order and takes the placement to pending", async () => {
    const { intent, orderId, sponsorId, ownerId, ownerEmail, orgName } = await seedSponsorOrder({ status: "paid" });
    const did = "dp_" + uniq();
    await handleSponsorDispute(disputeFor(intent, did), "created");
    const [o] = await sql`select disputed_at, dispute_id from sponsor_orders where id = ${orderId}`;
    expect(o.dispute_id).toBe(did);
    expect(o.disputed_at).not.toBeNull();
    const [s] = await sql`select status from sponsors where id = ${sponsorId}`;
    expect(s.status).toBe("pending");
    // The organiser is alerted, once, addressed to the owner (org_members),
    // on the outbox.
    const rows = await outboxRows("sponsor_dispute_alert", did);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient: ownerEmail, recipient_user_id: ownerId });
    const calls = enqueued("sponsor_dispute_alert", did);
    expect(calls).toHaveLength(1);
    // The alert names the package, the sponsor and the disputed amount (the
    // owner has no language and the org default is en).
    const text = calls[0]![1].text;
    expect(text).toContain(dictionarySubject("en", "sponsorDisputeAlert.textLine", { packageName: "Gold package", orgName }));
    expect(text).toContain(dictionarySubject("en", "sponsorDisputeAlert.textAmount", { amount: "£250.00", sponsorName: "Acme Corp" }));
  });

  it("created replay: idempotent flag, no second alert email", async () => {
    const { intent, orderId, ownerEmail } = await seedSponsorOrder({ status: "paid" });
    const did = "dp_" + uniq();
    await handleSponsorDispute(disputeFor(intent, did), "created");
    const [first] = await sql<{ disputed_at: Date }[]>`
      select disputed_at from sponsor_orders where id = ${orderId}`;
    // /admin/billing-events replay of the same created event.
    await handleSponsorDispute(disputeFor(intent, did), "created");
    const [second] = await sql<{ disputed_at: Date }[]>`
      select disputed_at from sponsor_orders where id = ${orderId}`;
    expect(second.disputed_at).toEqual(first.disputed_at); // flag time preserved
    expect(enqueued("sponsor_dispute_alert", did)).toHaveLength(1); // not re-notified
    const rows = await outboxRows("sponsor_dispute_alert", did);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient: ownerEmail });
  });

  it("closed lost: order refunded-state, placement inactive, recovery audited", async () => {
    const { intent, orderId, sponsorId } = await seedSponsorOrder({ status: "paid" });
    const did = "dp_" + uniq();
    await handleSponsorDispute(disputeFor(intent, did), "created");
    await handleSponsorDispute(disputeFor(intent, did, "lost"), "closed");
    const [o] = await sql`select status from sponsor_orders where id = ${orderId}`;
    expect(o.status).toBe("refunded");
    const [s] = await sql`select status from sponsors where id = ${sponsorId}`;
    expect(s.status).toBe("inactive");
    // Recovery ran through the shared core: keyless env → getStripe() throws →
    // the core catches and audits `sponsor.dispute_recovery_failed`. The flip
    // above must NOT depend on Stripe, and nothing may throw out of the handler.
    const audits = await sql`
      select 1 from competition_events
      where type = 'sponsor.dispute_recovery_failed' and payload->>'order_id' = ${orderId}`;
    expect(audits).toHaveLength(1);
    // Organiser hears about the loss (recoveredCents 0 — recovery could not run).
    expect(emailMock.lost).toHaveBeenCalledTimes(1);
    expect(emailMock.lost.mock.calls[0]![0]).toMatchObject({ recoveredCents: 0 });
  });

  it("closed lost replay: order + placement stay written off (idempotent)", async () => {
    const { intent, orderId, sponsorId } = await seedSponsorOrder({ status: "paid" });
    const did = "dp_" + uniq();
    await handleSponsorDispute(disputeFor(intent, did), "created");
    const lost = disputeFor(intent, did, "lost");
    await handleSponsorDispute(lost, "closed");
    await handleSponsorDispute(lost, "closed"); // replay
    const [o] = await sql`select status from sponsor_orders where id = ${orderId}`;
    expect(o.status).toBe("refunded");
    const [s] = await sql`select status from sponsors where id = ${sponsorId}`;
    expect(s.status).toBe("inactive");
  });

  it("closed won: flag cleared, placement re-activated (idempotent on replay)", async () => {
    const { intent, orderId, sponsorId, ownerEmail } = await seedSponsorOrder({ status: "paid" });
    const did = "dp_" + uniq();
    await handleSponsorDispute(disputeFor(intent, did), "created");
    const won = disputeFor(intent, did, "won");
    await handleSponsorDispute(won, "closed");
    await handleSponsorDispute(won, "closed"); // replay converges, not toggles
    const [o] = await sql`select disputed_at from sponsor_orders where id = ${orderId}`;
    expect(o.disputed_at).toBeNull();
    const [s] = await sql`select status from sponsors where id = ${sponsorId}`;
    expect(s.status).toBe("active");
    expect(emailMock.lost).not.toHaveBeenCalled(); // a win is not a loss
    // The organiser hears about the win exactly once — the replay above must
    // not re-notify (the flag was already clear on the second pass).
    expect(emailMock.won).toHaveBeenCalledTimes(1);
    expect(emailMock.won.mock.calls[0]![0]).toMatchObject({ to: ownerEmail });
  });

  it("ignores non-sponsor intents (reports no match)", async () => {
    await expect(
      handleSponsorDispute(disputeFor("pi_not_sponsor_" + uniq(), "dp_" + uniq()), "created"),
    ).resolves.toBe(false);
    expect(enqueued("sponsor_dispute_alert")).toHaveLength(0);
  });

  it("dispatch wires charge.dispute.created/closed to the sponsor handler", async () => {
    const { intent, orderId, sponsorId } = await seedSponsorOrder({ status: "paid" });
    const did = "dp_" + uniq();
    await processStripeEvent({
      type: "charge.dispute.created",
      data: { object: disputeFor(intent, did) },
    } as unknown as Stripe.Event);
    const [flagged] = await sql`select dispute_id from sponsor_orders where id = ${orderId}`;
    expect(flagged.dispute_id).toBe(did);

    await processStripeEvent({
      type: "charge.dispute.closed",
      data: { object: disputeFor(intent, did, "won") },
    } as unknown as Stripe.Event);
    const [s] = await sql`select status from sponsors where id = ${sponsorId}`;
    expect(s.status).toBe("active");
  });
});
