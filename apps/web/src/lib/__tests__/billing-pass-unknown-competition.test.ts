// A PAID Event Pass can name a competition that has no row in this database.
// Two ways to get there, and the foreign key is identical for both:
//
//  1. The competition was deleted between checkout and fulfilment. A real
//     buyer has been charged and holds nothing.
//  2. The event was minted against a DIFFERENT environment that shares this
//     Stripe account. Observed live on 2026-09-20: four webhook 500s in about
//     two minutes, every one of them
//     `competition_passes_competition_id_fkey`, because local development was
//     paying against staging's Stripe test account.
//
// Before this fix the insert simply threw, so the route returned 5xx and
// Stripe retried the same doomed event for three days while nobody was told.
// Now it is a distinct, ACKed outcome that alerts — the retry cannot help,
// and case 1 must not be silent.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

const stripeMock = vi.hoisted(() => {
  const refundCreate = vi.fn().mockResolvedValue({ id: "re_test" });
  return { refundCreate, stripe: { refunds: { create: refundCreate } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

// The alert is the whole point of the fix — a silent ACK would be the bug it
// replaces — so the email helper is spied on rather than sent.
const emailMock = vi.hoisted(() => ({
  sendPassUnknownCompetitionAlertEmail: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendPassUnknownCompetitionAlertEmail: emailMock.sendPassUnknownCompetitionAlertEmail,
}));

import { sql } from "@/lib/db";
import { recordPassPurchase } from "@/lib/billing";
import { processStripeEvent } from "@/server/usecases/billing-events";
import { setOrgPlan } from "./_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;

/** Unique per RUN, not merely per test. V314's partial unique index on
 *  `subscriptions.stripe_customer_id` is global over the whole table, and a
 *  test database survives between runs — so a customer id built from a literal
 *  collides with the row the PREVIOUS run left behind, and surfaces as an
 *  unrelated `subscriptions_stripe_customer_uniq` error in whichever assertion
 *  happens to touch it. Caught during this change's own mutation sweep, where
 *  it masked the real verdicts. */
const RUN = randomUUID().slice(0, 8);

const passCheckoutEvent = (orgId: string, competitionId: string, intent: string) =>
  ({
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_unknown_comp",
        metadata: { org_id: orgId, competition_id: competitionId, pass_key: "event_pass" },
        payment_status: "paid",
        payment_intent: intent,
        customer: `cus_${intent}_${RUN}`,
        currency: "gbp",
      },
    },
  }) as unknown as Stripe.Event;

/** An org that DOES exist, so the only missing parent is the competition —
 *  i.e. deliberately the "deleted competition" case (1) and not the
 *  foreign-environment one, because case 1 is the one with a real customer
 *  behind it and the one a test can actually pin. */
async function seedOrgOnly(): Promise<{ orgId: string; subscriptionId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${"unkcomp-" + suffix + "@test.local"}, 'Unk Payer') returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Unk Org " + suffix}, ${"unk-org-" + suffix}, ${userId}) returning id`;
  // The billing GROUP has to exist or the money-trace assertion below is
  // vacuous: linkStripeCustomer returns early when subscriptionIdForOrg finds
  // nothing, so a NULL stripe_customer_id would prove nothing about whether
  // the trace ran. With the row present, NULL is a real verdict.
  const subscriptionId = await setOrgPlan(orgId, "community");
  return { orgId, subscriptionId };
}

/** The same seed plus a REAL competition — the positive control for the
 *  money-trace assertion. */
async function seedOrgWithComp(): Promise<{
  orgId: string;
  subscriptionId: string;
  compId: string;
}> {
  const { orgId, subscriptionId } = await seedOrgOnly();
  const suffix = randomUUID().slice(0, 8);
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${"Unk Cup " + suffix}, ${"unk-cup-" + suffix}) returning id`;
  return { orgId, subscriptionId, compId };
}

beforeEach(() => {
  stripeMock.refundCreate.mockClear();
  emailMock.sendPassUnknownCompetitionAlertEmail.mockClear();
  process.env.STAFF_ALERT_EMAIL = "ops@test.local";
});

afterAll(async () => {
  if (!HAS_DB) return;
  delete process.env.STAFF_ALERT_EMAIL;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("recordPassPurchase — unknown competition", () => {
  it("reports unknownCompetition instead of throwing", async () => {
    const { orgId } = await seedOrgOnly();
    // Well-formed uuid, no row: exactly what a deleted competition, or another
    // environment's competition, looks like from here.
    const res = await recordPassPurchase({
      orgId,
      competitionId: randomUUID(),
      passKey: "event_pass",
      paymentIntent: "pi_unknown_comp",
    });
    expect(res).toEqual({
      recorded: false,
      duplicateIntent: null,
      unknownCompetition: true,
    });
  });

  it("still THROWS for a foreign key that is not the competition's", async () => {
    // The negative half, and the one that keeps the catch honest. A blanket
    // `catch` — or a predicate that only tested SQLSTATE 23503 — would swallow
    // this too, and an unknown ORG is a different bug needing a different
    // answer: it must stay a 5xx that Stripe retries, because an org row can
    // legitimately arrive late.
    const suffix = randomUUID().slice(0, 8);
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name)
      values (${"unkorg-" + suffix + "@test.local"}, 'Unk Org Payer') returning id`;
    const [{ id: realOrgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by)
      values (${"Real Org " + suffix}, ${"real-org-" + suffix}, ${userId}) returning id`;
    const [{ id: realCompId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug)
      values (${realOrgId}, ${"Real Cup " + suffix}, ${"real-cup-" + suffix}) returning id`;
    await expect(
      recordPassPurchase({
        orgId: randomUUID(), // the org is the missing parent this time
        competitionId: realCompId,
        passKey: "event_pass",
        paymentIntent: "pi_unknown_org",
      }),
    ).rejects.toThrow();
  });
});

describe.skipIf(!HAS_DB)("webhook — paid pass naming an unknown competition", () => {
  it("ACKs, alerts, refunds nothing, and writes no money trace", async () => {
    const { orgId, subscriptionId } = await seedOrgOnly();
    const missingCompId = randomUUID();

    // ACK: the handler resolves. Before the fix this rejected, which is what
    // the route turns into a 5xx and Stripe retries for three days.
    await expect(
      processStripeEvent(passCheckoutEvent(orgId, missingCompId, "pi_ack")),
    ).resolves.toBeUndefined();

    // ...but never silently. A human has to decide refund-or-noise.
    expect(emailMock.sendPassUnknownCompetitionAlertEmail).toHaveBeenCalledTimes(1);
    const alert = emailMock.sendPassUnknownCompetitionAlertEmail.mock.calls[0][0];
    // The three identifiers the responder needs to tell case 1 from case 2 and
    // to act on either. Pinned by VALUE, not merely present: an alert naming
    // the wrong competition sends someone to the wrong place.
    expect(alert).toMatchObject({
      to: "ops@test.local",
      orgId,
      competitionId: missingCompId,
      paymentIntent: "pi_ack",
      source: "webhook",
    });

    // Not a duplicate: nothing to send back. A refund here would return a
    // payment that may be perfectly valid for another environment's database.
    expect(stripeMock.refundCreate).not.toHaveBeenCalled();

    // No money trace. linkStripeCustomer/pinBillingCurrency describe a purchase
    // that was NOT recorded; writing them would leave the org looking like it
    // bought something it does not have. The group row EXISTS (seedOrgOnly
    // makes it) so this NULL is a verdict rather than an early return, and the
    // positive control below is what proves the same probe can come back set.
    const [row] = await sql<{ stripe_customer_id: string | null; currency: string | null }[]>`
      select stripe_customer_id, currency from subscriptions where id = ${subscriptionId}`;
    expect(row?.stripe_customer_id ?? null).toBeNull();
    expect(row?.currency ?? null).toBeNull();

    // And no pass row was conjured.
    const passes = await sql<{ competition_id: string }[]>`
      select competition_id from competition_passes where org_id = ${orgId}`;
    expect(passes).toHaveLength(0);
  });

  it("POSITIVE CONTROL: the same probe DOES see the trace when the competition exists", async () => {
    // Without this, the assertions above pass for a handler that never writes
    // a money trace at all, and the test would witness nothing.
    const { orgId, subscriptionId, compId } = await seedOrgWithComp();
    await processStripeEvent(passCheckoutEvent(orgId, compId, "pi_real"));

    const [row] = await sql<{ stripe_customer_id: string | null; currency: string | null }[]>`
      select stripe_customer_id, currency from subscriptions where id = ${subscriptionId}`;
    expect(row?.stripe_customer_id).toBe(`cus_pi_real_${RUN}`);
    expect(row?.currency).toBe("gbp");

    const passes = await sql<{ competition_id: string }[]>`
      select competition_id from competition_passes where org_id = ${orgId}`;
    expect(passes).toHaveLength(1);
    // ...and no alert, because nothing was wrong.
    expect(emailMock.sendPassUnknownCompetitionAlertEmail).not.toHaveBeenCalled();
  });

  it("ACKs even with no STAFF_ALERT_EMAIL configured", async () => {
    // The alert is best-effort; an unset address must never turn a handled
    // outcome back into a retrying 5xx.
    delete process.env.STAFF_ALERT_EMAIL;
    const { orgId } = await seedOrgOnly();
    await expect(
      processStripeEvent(passCheckoutEvent(orgId, randomUUID(), "pi_no_alert_addr")),
    ).resolves.toBeUndefined();
    expect(emailMock.sendPassUnknownCompetitionAlertEmail).not.toHaveBeenCalled();
  });
});
