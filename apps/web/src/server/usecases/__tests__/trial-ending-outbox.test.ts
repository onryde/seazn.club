// Phase 3 wave 2, Batch D / email 10: Stripe's three-day trial warning (`customer.subscription.trial_will_end`) goes through the email
// outbox (kind `trial_ending`). It is addressed to the billing group's payer (`subscriptions.owner_user_id`, an account: the address is
// resolved at send), in the payer's language (D4: the account's, then the default of the group's org the billing link points at), with
// ref `subscription/<group id>`, no organisation (P-W2-12: a group can span several), and the Stripe event id as its once-key. It is
// TRANSACTIONAL, as its sender was: the only notice before a no-card trial stops or a card-on-file trial charges, so a payer who
// unsubscribed from product mail still hears that their money is about to move. The worker makes the first attempt.
//
// Producer under test: `handleTrialWillEnd`, driven through `processStripeEvent` (the dispatch table the webhook and the staff replay
// share). Only the outbox transport is replaced. The enqueue is the real one, observed through a spy that calls through, so "not written
// because the key was taken" and "never asked" are told apart.
//
// Changed while queued: the plan, the end date, the card-or-no-card variant and the billing link can all change while the row waits. A
// changed trial sends a second `trial_will_end` with a new event id, and its row replaces a still-queued first one through the wave-1
// replace trigger (kind + ref + account): no code here does it, and test 4 pins it. A card added inside the worker window without a new
// event is rare — recorded.
//
// Sport: not applicable. A billing notice does not vary by sport (spec, Test strategy 4); the locale is the axis that varies.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The one network seam of the outbox.
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

// The enqueue, observed: every call reaches the real writer.
vi.mock("@/server/email-outbox", async (io) => { const m = await io<typeof import("@/server/email-outbox")>(); return { ...m, enqueueEmailOnce: vi.fn(m.enqueueEmailOnce) }; });

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { planLabel } from "@/lib/plan-label";
import { enqueueEmailOnce } from "@/server/email-outbox";
import { idempotencyKey } from "@/server/email-outbox/constants";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { processStripeEvent } from "../billing-events";
import { stubOutboxEnv } from "./_invite-mail";
import { cleanUpSponsorOrgs, seedTrialingGroup } from "./_money-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const KIND = "trial_ending" as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const made = { orgIds: [] as string[], userIds: [] as string[] };

afterAll(async () => {
  if (!HAS_DB) return;
  // The warning names no organisation, so it is found by its payer.
  await sql`delete from email_outbox where kind = ${KIND} and recipient_user_id = any(${made.userIds}::uuid[])`;
  await cleanUpSponsorOrgs(made.orgIds, made.userIds);
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

beforeEach(() => {
  stubOutboxEnv();
  vi.mocked(enqueueEmailOnce).mockClear();
  deliverMock.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_teo_${randomUUID()}` }));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fixtures and readers
// ---------------------------------------------------------------------------------------------------------------------------------

/** A trialing billing group (plan `pro`) and its payer, tracked for cleanup. */
async function trialingGroup(o: { hasPaymentMethod: boolean; ownerLocale: string | null; orgDefaultLocale: "en" | "es" | "fr" | "nl" }) {
  const g = await seedTrialingGroup(o);
  made.orgIds.push(g.orgId);
  made.userIds.push(g.ownerId);
  return g;
}

/** A trial end `days` ahead, to Stripe's whole second (Stripe sends epoch seconds). */
const trialEndIn = (days: number): Date => new Date(Math.floor((Date.now() + days * DAY_MS) / 1000) * 1000);

/** `customer.subscription.trial_will_end` as Stripe sends it, a fresh event id each time. */
const warningEvent = (stripeSubId: string, trialEnd: Date) =>
  ({
    id: `evt_teo_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    type: "customer.subscription.trial_will_end",
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: stripeSubId, object: "subscription", status: "trialing", trial_end: Math.floor(trialEnd.getTime() / 1000), metadata: {} } },
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

/** Every trial warning about this billing group, in every status. */
const rowsOf = (groupId: string) =>
  sql<Row[]>`
    select id, kind, ref_type, ref_id, org_id, recipient, recipient_user_id, subject, status, attempts, transactional, dedupe_key
      from email_outbox
     where kind = ${KIND} and ref_id = ${groupId}
     order by created_at, id`;

/** The enqueue calls the producer made for a group (the spy sees every caller, so it is filtered). */
const enqueueCalls = (groupId: string) => vi.mocked(enqueueEmailOnce).mock.calls.filter(([, m]) => m.kind === KIND && m.refId === groupId);

const transportCallsFor = (rowId: string) =>
  deliverMock.mock.calls.filter((c) => (c[0] as { idempotencyKey: string }).idempotencyKey === idempotencyKey(rowId));

/** The warning's subject, read from the locale's `emails` dictionary on disk: `card` is the no-card variant (add a card or the trial
 *  stops), `charge` the card-on-file one. The date is the trial end as that locale writes a long date, in UTC. */
const subjectFor = (locale: "en" | "es" | "fr" | "nl", variant: "card" | "charge", trialEnd: Date, plan = "pro") =>
  dictionarySubject(locale, `trialEnding.subject.${variant}`, {
    planName: planLabel(plan),
    date: new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(trialEnd),
  });

// ---------------------------------------------------------------------------------------------------------------------------------
// Email 10
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("Stripe's trial warning reaches the payer through the outbox (DB)", () => {
  it("a no-card trial queues one transactional warning to the payer, in the payer's language, for the worker", async () => {
    const g = await trialingGroup({ hasPaymentMethod: false, ownerLocale: "fr", orgDefaultLocale: "en" });
    const trialEnd = trialEndIn(3);
    const ev = warningEvent(g.stripeSubId, trialEnd);

    await expect(processStripeEvent(ev)).resolves.toBeUndefined();

    const rows = await rowsOf(g.groupId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: KIND,
      ref_type: "subscription",
      ref_id: g.groupId,
      dedupe_key: ev.id,
      org_id: null,
      recipient: g.ownerEmail,
      recipient_user_id: g.ownerId,
      transactional: true,
      status: "queued",
      attempts: 0,
    });
    // The right answer is not a wrong one's constant: not English (the org default here), and not the other variant.
    expect(subjectFor("fr", "card", trialEnd)).not.toBe(subjectFor("en", "card", trialEnd));
    expect(subjectFor("fr", "card", trialEnd)).not.toBe(subjectFor("fr", "charge", trialEnd));
    expect(rows[0]!.subject).toBe(subjectFor("fr", "card", trialEnd));
    expect(transportCallsFor(rows[0]!.id), "the webhook did not attempt the send: the first attempt is the worker's").toHaveLength(0);
    expect(enqueueCalls(g.groupId)).toHaveLength(1);
  });

  it("a card-on-file trial gets the charge variant", async () => {
    const g = await trialingGroup({ hasPaymentMethod: true, ownerLocale: "fr", orgDefaultLocale: "en" });
    const trialEnd = trialEndIn(3);

    await processStripeEvent(warningEvent(g.stripeSubId, trialEnd));

    const rows = await rowsOf(g.groupId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipient_user_id).toBe(g.ownerId);
    expect(rows[0]!.transactional).toBe(true);
    expect(rows[0]!.subject).toBe(subjectFor("fr", "charge", trialEnd));
  });

  it("the same event processed twice queues one row", async () => {
    const g = await trialingGroup({ hasPaymentMethod: false, ownerLocale: "fr", orgDefaultLocale: "en" });
    const ev = warningEvent(g.stripeSubId, trialEndIn(3));

    await processStripeEvent(ev);
    await processStripeEvent(ev); // Stripe's retry, the stuck-event sweeper, or an /admin/billing-events replay

    // Asked twice: nothing but the once-key (the event id) stands between the second delivery and a second warning.
    expect(enqueueCalls(g.groupId), "asked twice").toHaveLength(2);
    const rows = await rowsOf(g.groupId);
    expect(rows.map((r) => r.dedupe_key), "one row in every status: nothing replaced it").toEqual([ev.id]);
    expect(rows[0]!.status).toBe("queued");
  });

  it("a second warning event for the same trial replaces the still-queued first", async () => {
    const g = await trialingGroup({ hasPaymentMethod: false, ownerLocale: "fr", orgDefaultLocale: "en" });
    const first = warningEvent(g.stripeSubId, trialEndIn(3));
    // The trial changed (here: extended), so Stripe sends a new warning, with a new event id.
    const laterEnd = trialEndIn(10);
    const second = warningEvent(g.stripeSubId, laterEnd);

    await processStripeEvent(first);
    await processStripeEvent(second);

    const rows = await rowsOf(g.groupId);
    expect(rows.map((r) => [r.dedupe_key, r.status])).toEqual([
      [first.id, "replaced"],
      [second.id, "queued"],
    ]);
    expect(rows.filter((r) => r.status !== "replaced"), "one live warning").toHaveLength(1);
    expect(rows[1]!.subject, "the live one carries the changed trial's date").toBe(subjectFor("fr", "card", laterEnd));
  });

  it("D4: a payer with no language gets the billing org's default", async () => {
    const g = await trialingGroup({ hasPaymentMethod: false, ownerLocale: null, orgDefaultLocale: "nl" });
    const trialEnd = trialEndIn(3);

    await processStripeEvent(warningEvent(g.stripeSubId, trialEnd));

    const rows = await rowsOf(g.groupId);
    expect(rows).toHaveLength(1);
    expect(subjectFor("nl", "card", trialEnd), "premise: nl differs from en").not.toBe(subjectFor("en", "card", trialEnd));
    expect(rows[0]!.subject).toBe(subjectFor("nl", "card", trialEnd));
  });

  it("a payer whose account is deleted gets no row, and the event is not parked", async () => {
    const g = await trialingGroup({ hasPaymentMethod: false, ownerLocale: "fr", orgDefaultLocale: "en" });
    await sql`update users set deleted_at = now() where id = ${g.ownerId}`;

    // A throw is what parks an event (the ledger stamps processed_at only after the handler returns).
    await expect(processStripeEvent(warningEvent(g.stripeSubId, trialEndIn(3)))).resolves.toBeUndefined();

    expect(await rowsOf(g.groupId)).toHaveLength(0);
    expect(enqueueCalls(g.groupId)).toHaveLength(0);
  });
});
