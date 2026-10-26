// Phase 3 wave 2, Batch D / email 9: the Event Pass refund notice goes through the email outbox (kind `pass_revoked`). A fully refunded
// pass charge (a dashboard refund included) revokes the pass and, in the SAME transaction as the delete (R1, through
// `revokePassForRefundedCharge`'s `inRevoke` seam), queues the notice to the org's current owner: an account (the oldest owner by
// membership, `orgOwnerRecipient`, never `organizations.created_by`), in the owner's language (D4: the account's, then the org default),
// with ref `charge/<charge id>` and the charge id as its once-key. The worker makes the first attempt (a webhook has no response to defer
// behind).
//
// Producer under test: `revokePassForRefundedChargeAndNotify`, driven through `processStripeEvent` (the dispatch table the webhook and
// the staff replay share), and `queuePassRevokedEmail` for the once-key alone. Only the outbox transport is replaced. The enqueue is the
// real one, observed through a spy that calls through, so "not written because the key was taken" and "never asked" are told apart.
//
// Changed while queued: nothing can change. The pass row is gone, and a pass bought again does not make the notice untrue.
//
// Sport: not applicable. A refund notice does not vary by sport (spec, Test strategy 4); the locale is the axis that varies.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The one network seam of the outbox.
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

// The enqueue, observed: every call reaches the real writer.
vi.mock("@/server/email-outbox", async (io) => { const m = await io<typeof import("@/server/email-outbox")>(); return { ...m, enqueueEmailOnce: vi.fn(m.enqueueEmailOnce) }; });

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { enqueueEmailOnce } from "@/server/email-outbox";
import { idempotencyKey } from "@/server/email-outbox/constants";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { processStripeEvent, queuePassRevokedEmail } from "../billing-events";
import { stubOutboxEnv } from "./_invite-mail";
import { cleanUpSponsorOrgs, seedPassOrg } from "./_money-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const KIND = "pass_revoked" as const;

const made = { orgIds: [] as string[], userIds: [] as string[] };

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanUpSponsorOrgs(made.orgIds, made.userIds);
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

beforeEach(() => {
  stubOutboxEnv();
  vi.mocked(enqueueEmailOnce).mockClear();
  deliverMock.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_pro_${randomUUID()}` }));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fixtures and readers
// ---------------------------------------------------------------------------------------------------------------------------------

let seq = 0;
/** A payment intent and a charge id unique to this run (the once-key index is global, so a fixed id would meet an earlier run's row). */
const newIds = () => {
  seq += 1;
  return { intent: `pi_pro_${RUN}_${seq}`, chargeId: `ch_pro_${RUN}_${seq}` };
};

/** An org whose competition holds an Event Pass bought with `intent`; the owner (by membership) is not `created_by`. Tracked for cleanup. */
async function passOrg(o: { intent: string; passKey?: "event_pass" | "event_pass_l"; ownerLocale: string | null; defaultLocale: "en" | "es" | "fr" | "nl" }) {
  const s = await seedPassOrg(o);
  made.orgIds.push(s.orgId);
  made.userIds.push(s.ownerId, s.trapId);
  return s;
}

/** `charge.refunded` as Stripe sends it for the pass's charge: a full refund unless `refunded` is false. */
const refundEvent = (chargeId: string, intent: string, over: { refunded?: boolean; amount_refunded?: number } = {}) =>
  ({
    id: `evt_pro_${randomUUID().slice(0, 12)}`,
    type: "charge.refunded",
    data: { object: { id: chargeId, payment_intent: intent, refunded: true, amount_refunded: 2900, ...over } },
  }) as unknown as Stripe.Event;

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

/** Every pass notice about these charges, in every status. */
const rowsOf = (chargeIds: string[]) =>
  sql<Row[]>`
    select id, kind, ref_type, ref_id, org_id, recipient, recipient_user_id, subject, status, attempts, transactional, dedupe_key
      from email_outbox
     where kind = ${KIND} and ref_id = any(${chargeIds}::text[])
     order by created_at, id`;

/** The enqueue calls the producer made for a charge (the spy sees every caller, so it is filtered). */
const enqueueCalls = (chargeId: string) => vi.mocked(enqueueEmailOnce).mock.calls.filter(([, m]) => m.kind === KIND && m.refId === chargeId);

const transportCallsFor = (rowId: string) =>
  deliverMock.mock.calls.filter((c) => (c[0] as { idempotencyKey: string }).idempotencyKey === idempotencyKey(rowId));

const passOf = async (intent: string) => (await sql`select 1 from competition_passes where stripe_payment_intent = ${intent}`)[0];

/** The pass notice's subject in a locale, for a rung: both read from that locale's `emails` dictionary on disk. */
const subjectFor = (locale: "en" | "es" | "fr" | "nl", rung: "m" | "l") =>
  dictionarySubject(locale, "passRevoked.subject", { rung: dictionarySubject(locale, `passRevoked.rung.${rung}`, {}) });

// ---------------------------------------------------------------------------------------------------------------------------------
// Email 9
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("a refunded Event Pass tells the org owner through the outbox (DB)", () => {
  it("a fully refunded pass charge queues one notice to the org owner, for the worker", async () => {
    const { intent, chargeId } = newIds();
    const o = await passOrg({ intent, ownerLocale: "nl", defaultLocale: "en" });

    await expect(processStripeEvent(refundEvent(chargeId, intent))).resolves.toBeUndefined();

    expect(await passOf(intent), "the pass is revoked").toBeUndefined();
    const rows = await rowsOf([chargeId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: KIND,
      ref_type: "charge",
      ref_id: chargeId,
      dedupe_key: chargeId,
      org_id: o.orgId,
      recipient_user_id: o.ownerId,
      recipient: o.ownerEmail,
      transactional: false,
      status: "queued",
      attempts: 0,
    });
    expect(rows[0]!.recipient_user_id, "the owner by membership, never created_by").not.toBe(o.trapId);
    // The right answer is not a wrong one's constant: not English (the org default here).
    expect(subjectFor("nl", "m")).not.toBe(subjectFor("en", "m"));
    expect(rows[0]!.subject).toBe(subjectFor("nl", "m"));
    expect(transportCallsFor(rows[0]!.id), "the webhook did not attempt the send: the first attempt is the worker's").toHaveLength(0);
    // R1: the row was written on the transaction that deletes the pass, not on the pool.
    const calls = enqueueCalls(chargeId);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0], "the enqueue ran on a transaction handle, not the pool").not.toBe(sql);
  });

  it("a later refund event for the same charge queues nothing", async () => {
    const { intent, chargeId } = newIds();
    await passOrg({ intent, ownerLocale: "nl", defaultLocale: "en" });

    await processStripeEvent(refundEvent(chargeId, intent));
    expect(enqueueCalls(chargeId), "premise: the first event queued the notice").toHaveLength(1);
    vi.mocked(enqueueEmailOnce).mockClear();
    // A new event about the same charge (a second refund line, a dashboard re-sync): the pass is already gone, so nothing is revoked.
    await processStripeEvent(refundEvent(chargeId, intent));

    expect(enqueueCalls(chargeId), "the second event never asked").toHaveLength(0);
    expect(await rowsOf([chargeId])).toHaveLength(1);
  });

  it("the pass notice's once-key alone", async () => {
    const { intent, chargeId } = newIds();
    const o = await passOrg({ intent, ownerLocale: null, defaultLocale: "en" });
    const queue = () =>
      sql.begin((tx) =>
        queuePassRevokedEmail(tx, {
          chargeId,
          orgId: o.orgId,
          owner: { userId: o.ownerId, email: o.ownerEmail },
          locale: "en",
          args: { orgName: o.orgName, competitionName: o.compName, passKey: "event_pass" },
        }),
      );

    const first = await queue();
    const second = await queue();

    expect(first, "the first is written").toEqual(expect.any(String));
    expect(second, "the second is the once-key's: nothing written").toBeNull();
    const rows = await rowsOf([chargeId]);
    expect(rows.map((r) => r.id), "one row in every status: nothing replaced it").toEqual([first]);
    expect(rows[0]!.status).toBe("queued");
  });

  it("a partial refund keeps the pass and queues nothing", async () => {
    const { intent, chargeId } = newIds();
    await passOrg({ intent, ownerLocale: "nl", defaultLocale: "en" });

    await processStripeEvent(refundEvent(chargeId, intent, { refunded: false, amount_refunded: 500 }));

    expect(await passOf(intent), "the pass stays").toBeTruthy();
    expect(await rowsOf([chargeId])).toHaveLength(0);
    expect(enqueueCalls(chargeId)).toHaveLength(0);
  });

  it("empty: an org with no owner loses the pass and queues nothing", async () => {
    const { intent, chargeId } = newIds();
    const o = await passOrg({ intent, ownerLocale: "nl", defaultLocale: "en" });
    await sql`update org_members set role = 'admin' where org_id = ${o.orgId} and role = 'owner'`;

    await expect(processStripeEvent(refundEvent(chargeId, intent))).resolves.toBeUndefined();

    expect(await passOf(intent), "the refund still revokes the pass: that does not wait on someone to tell").toBeUndefined();
    expect(await rowsOf([chargeId])).toHaveLength(0);
    expect(enqueueCalls(chargeId)).toHaveLength(0);
  });

  it("an L pass names its rung (and an owner with no language is told in the org's default)", async () => {
    const { intent, chargeId } = newIds();
    // D4: the owner's account has no language, so the org default's (es).
    const o = await passOrg({ intent, passKey: "event_pass_l", ownerLocale: null, defaultLocale: "es" });

    await processStripeEvent(refundEvent(chargeId, intent));

    const rows = await rowsOf([chargeId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipient_user_id).toBe(o.ownerId);
    expect(subjectFor("es", "l"), "premise: the rungs read differently").not.toBe(subjectFor("es", "m"));
    expect(subjectFor("es", "l"), "premise: es differs from en").not.toBe(subjectFor("en", "l"));
    expect(rows[0]!.subject).toBe(subjectFor("es", "l"));
  });
});
