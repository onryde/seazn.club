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
// The alert (`alertPassUnknownCompetition`) is queued on the email outbox
// (phase 3 wave 5, kind `staff_pass_unknown_competition`, once per Checkout
// Session) to this suite's own STAFF_ALERT_EMAIL, so the tests read its row
// (`staffRows`). Sport: not applicable (no staff alert names a sport).
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

const stripeMock = vi.hoisted(() => {
  const refundCreate = vi.fn().mockResolvedValue({ id: "re_test" });
  // Reconcile-on-return reads the session back from Stripe. The line-item read
  // FAILS on purpose: the rung guard then mints unverified (its documented
  // fail-open), so a concurrently stubbed `plans` price cannot turn this
  // suite's sessions into rung refusals.
  const retrieve = vi.fn();
  const listLineItems = vi.fn().mockRejectedValue(new Error("line items not stubbed here"));
  return { refundCreate, retrieve, stripe: { refunds: { create: refundCreate }, checkout: { sessions: { retrieve, listLineItems } } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

// The alert is the whole point of the fix — a silent ACK would be the bug it
// replaces. Its builder is a spy that calls through (what each call said, and
// how many calls reached it), and Sentry's issue capture is observed
// (call-through) so a test can assert the writer dropped nothing.
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, passUnknownCompetitionAlertEmail: vi.fn(actual.passUnknownCompetitionAlertEmail) };
});
vi.mock("@/lib/sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry")>();
  return { ...actual, captureError: vi.fn(actual.captureError) };
});

import { sql } from "@/lib/db";
import { reconcilePassCheckout, recordPassPurchase } from "@/lib/billing";
import { passUnknownCompetitionAlertEmail } from "@/lib/email";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import { processStripeEvent } from "@/server/usecases/billing-events";
import { openBody } from "@/server/email-outbox/seal";
import { setOrgPlan } from "./_billing-group";
import { staffAlertDrops, staffRows } from "@/server/usecases/__tests__/_money-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const KIND = "staff_pass_unknown_competition";
const alertMock = vi.mocked(passUnknownCompetitionAlertEmail);
/** The sender's subject, typed from its source. */
const unknownSubject = (competitionId: string) => `Event Pass NOT granted — unknown competition: ${competitionId}`;

/** Unique per RUN, not merely per test. V314's partial unique index on
 *  `subscriptions.stripe_customer_id` is global over the whole table, and a
 *  test database survives between runs — so a customer id built from a literal
 *  collides with the row the PREVIOUS run left behind, and surfaces as an
 *  unrelated `subscriptions_stripe_customer_uniq` error in whichever assertion
 *  happens to touch it. Caught during this change's own mutation sweep, where
 *  it masked the real verdicts. */
const RUN = randomUUID().slice(0, 8);

/** The session id is the staff alert's once-key, so it is unique per payment
 *  (per intent, per run) — a literal would dedupe one test's page against
 *  another's. */
const sessionIdFor = (intent: string) => `cs_unknown_comp_${intent}_${RUN}`;

const passSession = (orgId: string, competitionId: string, intent: string) => ({
  id: sessionIdFor(intent),
  metadata: { org_id: orgId, competition_id: competitionId, pass_key: "event_pass" },
  payment_status: "paid",
  payment_intent: intent,
  customer: `cus_${intent}_${RUN}`,
  currency: "gbp",
});

const passCheckoutEvent = (orgId: string, competitionId: string, intent: string) =>
  ({
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionIdFor(intent),
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

/** This test's own staff address: CI sets none, and the database is shared. */
let staff = "";
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  stripeMock.refundCreate.mockClear();
  stripeMock.retrieve.mockReset();
  alertMock.mockClear();
  vi.mocked(captureError).mockClear();
  staff = `staff-${RUN}-${randomUUID().slice(0, 8)}@x.test`;
  vi.stubEnv("STAFF_ALERT_EMAIL", staff);
  errors = vi.spyOn(log, "error");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where kind = ${KIND} and lower(recipient) like ${`staff-${RUN}-%`}`;
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
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(await staffRows(KIND, "checkout_session", sessionIdFor("pi_ack"))).toMatchObject([{ status: "queued", recipient: staff }]);
    const alert = alertMock.mock.calls[0]![0];
    // The three identifiers the responder needs to tell case 1 from case 2 and
    // to act on either. Pinned by VALUE, not merely present: an alert naming
    // the wrong competition sends someone to the wrong place.
    expect(alert).toMatchObject({
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
    expect(alertMock).not.toHaveBeenCalled();
    expect(await staffRows(KIND, "checkout_session", sessionIdFor("pi_real"))).toHaveLength(0);
  });

  it("ACKs even with no STAFF_ALERT_EMAIL configured", async () => {
    // The alert is best-effort; an unset address must never turn a handled
    // outcome back into a retrying 5xx.
    vi.stubEnv("STAFF_ALERT_EMAIL", "");
    const { orgId } = await seedOrgOnly();
    await expect(
      processStripeEvent(passCheckoutEvent(orgId, randomUUID(), "pi_no_alert_addr")),
    ).resolves.toBeUndefined();
    expect(alertMock).not.toHaveBeenCalled();
    expect(await staffRows(KIND, "checkout_session", sessionIdFor("pi_no_alert_addr")), "no row, to any recipient").toHaveLength(0);
    expect(staffAlertDrops(errors, vi.mocked(captureError)), "unset is not a drop").toEqual({ logged: 0, issues: 0 });
  });

  it("a paid pass for a competition not in this database pages once", async () => {
    // Two deliveries of the same event (Stripe's at-least-once): each reaches
    // the alert, and the session's once-key makes them one page.
    const { orgId } = await seedOrgOnly();
    const missingCompId = randomUUID();
    const intent = `pi_once_${RUN}`;
    const sid = sessionIdFor(intent);

    await processStripeEvent(passCheckoutEvent(orgId, missingCompId, intent));
    await processStripeEvent(passCheckoutEvent(orgId, missingCompId, intent));

    expect(alertMock, "premise: both deliveries reached the alert").toHaveBeenCalledTimes(2);
    expect(await staffRows(KIND, "checkout_session", sid)).toEqual([
      { ref_id: sid, dedupe_key: sid, status: "queued", recipient: staff, subject: unknownSubject(missingCompId) },
    ]);
    expect(alertMock).toHaveBeenCalledWith({
      sessionId: sid,
      orgId,
      competitionId: missingCompId,
      passKey: "event_pass",
      paymentIntent: intent,
      source: "webhook",
    });
    expect(staffAlertDrops(errors, vi.mocked(captureError)), "deduplicated, not dropped").toEqual({ logged: 0, issues: 0 });
  });

  it("the webhook and then reconcile-on-return for the same session page once", async () => {
    // The body is sealed only when the box has a key: this test reads it, so
    // it gives the box one (a test key; no Resend key, so nothing is sent).
    vi.stubEnv("EMAIL_OUTBOX_KEK", "cd".repeat(32));
    const { orgId } = await seedOrgOnly();
    const missingCompId = randomUUID();
    const intent = `pi_both_${RUN}`;
    const sid = sessionIdFor(intent);

    await processStripeEvent(passCheckoutEvent(orgId, missingCompId, intent));
    stripeMock.retrieve.mockResolvedValue(passSession(orgId, missingCompId, intent));
    expect(await reconcilePassCheckout(orgId, sid), "the return page holds no pass").toBe(false);

    expect(alertMock.mock.calls.map((c) => c[0].source), "premise: both paths reached the alert, webhook first").toEqual([
      "webhook",
      "reconcile",
    ]);
    const rows = await staffRows(KIND, "checkout_session", sid);
    expect(rows).toEqual([
      { ref_id: sid, dedupe_key: sid, status: "queued", recipient: staff, subject: unknownSubject(missingCompId) },
    ]);
    // The one page is the webhook's: its body names the webhook as the source.
    const [row] = await sql<{ body_sealed: Uint8Array }[]>`
      select body_sealed from email_outbox where kind = ${KIND} and ref_type = 'checkout_session' and ref_id = ${sid}`;
    const { text, html } = openBody(row!.body_sealed);
    expect(text).toContain("source webhook");
    expect(text).not.toContain("source reconcile");
    expect(html).toContain("source: webhook");
    expect(staffAlertDrops(errors, vi.mocked(captureError)), "deduplicated, not dropped").toEqual({ logged: 0, issues: 0 });
  });
});
