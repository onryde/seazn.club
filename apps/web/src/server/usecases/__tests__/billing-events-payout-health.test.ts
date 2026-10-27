// V411 — the five webhook events added for payout health and the trial warning.
//
// Driven through `processStripeEvent`, NEVER by calling the writers directly:
// the dispatch table IS the thing being added, and a test that calls
// `recordConnectPayout` by hand proves the writer while leaving the seam it
// hangs on unproven (the inert-seam class). So every case below builds a real
// `Stripe.Event` — including `event.account`, which is where the connected
// account id actually lives on all four Connect events — and asserts the row
// Postgres ends up holding.
//
// DB parts skipped without DATABASE_URL, same as billing-events.test.ts.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

// Both emails here are queued on the email outbox, so their rows are what gets
// asserted. The bank-removed staff alert (phase 3 wave 5, kind
// `staff_connect_bank_changed`, once per Stripe event) goes to this suite's own
// STAFF_ALERT_EMAIL; its builder is a spy that calls through, so what the alert
// SAYS is read where it enters the mail, and Sentry's issue capture is observed
// (call-through) so a test can assert the writer dropped nothing. The trial
// warning's whole purpose is to REACH A PERSON (phase 3 wave 2, email 10).
// Declared before the import of the module under test so the mocks are in place.
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, connectBankAlertEmail: vi.fn(actual.connectBankAlertEmail) };
});
vi.mock("@/lib/sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry")>();
  return { ...actual, captureError: vi.fn(actual.captureError) };
});
// The outbox's one network seam (the worker never runs here: the warning waits for it).
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));

const { sql } = await import("@/lib/db");
const { HANDLED_EVENT_TYPES, CONNECT_SCOPED_EVENT_TYPES, processStripeEvent } =
  await import("../billing-events");
const { seedTrialingGroup, staffAlertDrops, staffRows } = await import("./_money-fixtures");
const { stubOutboxEnv } = await import("./_invite-mail");
const { dictionarySubject } = await import("@/server/email-outbox/__tests__/_kind-harness");
const { connectBankAlertEmail } = await import("@/lib/email");
const { captureError } = await import("@/lib/sentry");
const { log } = await import("@/server/logger");

const HAS_DB = !!process.env.DATABASE_URL;

const bankAlert = vi.mocked(connectBankAlertEmail);
const BANK_KIND = "staff_connect_bank_changed";
const RUN = `ph-${randomUUID().slice(0, 8)}`;
let staff = "";
let errors: ReturnType<typeof vi.spyOn>;
/** What the writer's never-throws catch left (I2): an alert that was queued or deduplicated left nothing. */
const drops = () => staffAlertDrops(errors, vi.mocked(captureError));
/** One queued bank-removed alert to this test's staff address, keyed by the Stripe event. The subject is the builder's inline
 *  English, typed from its source. */
const bankRow = (eventId: string, orgName: string) => ({
  ref_id: eventId,
  dedupe_key: eventId,
  status: "queued",
  recipient: staff,
  subject: `Connect bank account removed: ${orgName}`,
});

/** The five events this wave added, as the brief specifies them. Kept as a
 *  literal on purpose: it is the CONTRACT against the two live Stripe
 *  destinations, so a handler quietly dropped from the table must fail here
 *  rather than be re-derived from whatever the table currently says. */
const ADDED = [
  "payout.paid",
  "payout.failed",
  "account.external_account.updated",
  "account.external_account.deleted",
  "customer.subscription.trial_will_end",
] as const;

interface EventOpts {
  type: string;
  object: unknown;
  account?: string;
}

function event({ type, object, account }: EventOpts): Stripe.Event {
  return {
    id: `evt_${randomUUID().replace(/-/g, "")}`,
    type,
    account,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  } as unknown as Stripe.Event;
}

/** Seconds since the epoch, which is how Stripe timestamps every object. */
function epoch(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function payout(over: Partial<Stripe.Payout> = {}): Stripe.Payout {
  return {
    id: `po_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    object: "payout",
    status: "paid",
    created: epoch(new Date()),
    arrival_date: epoch(new Date()),
    ...over,
  } as Stripe.Payout;
}

/** A connected org with a Stripe account id, which is the only thing the
 *  payout/bank writers key on. */
async function connectedOrg(): Promise<{ orgId: string; accountId: string; ownerId: string; orgName: string }> {
  const suffix = randomUUID().slice(0, 8);
  const accountId = `acct_${suffix}${randomUUID().slice(0, 8)}`;
  const [owner] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${`payout-${suffix}@test.local`}, 'Owner') returning id`;
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, stripe_account_id)
    values (${`Payout ${suffix}`}, ${`payout-${suffix}`}, ${owner!.id}, ${accountId})
    returning id`;
  return { orgId: org!.id, accountId, ownerId: owner!.id, orgName: `Payout ${suffix}` };
}

async function alertRow(orgId: string) {
  const [row] = await sql<
    {
      stripe_payout_alert: string | null;
      stripe_payout_alert_at: Date | null;
      stripe_payout_alert_detail: string | null;
      stripe_last_payout_at: Date | null;
    }[]
  >`
    select stripe_payout_alert, stripe_payout_alert_at,
           stripe_payout_alert_detail, stripe_last_payout_at
    from organizations where id = ${orgId}`;
  return row!;
}

/** Put a standing alert on an org without going through the dispatch, so a
 *  test can assert what the NEXT event does to an existing one. */
async function seedAlert(orgId: string, alert: string, at: Date, detail = "seeded") {
  await sql`
    update organizations
    set stripe_payout_alert = ${alert},
        stripe_payout_alert_at = ${at.toISOString()},
        stripe_payout_alert_detail = ${detail}
    where id = ${orgId}`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where kind = ${BANK_KIND} and lower(recipient) like ${`staff-${RUN}-%`}`;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe("HANDLED_EVENT_TYPES (pure)", () => {
  // The staff console asks Stripe for exactly this filter, and the two live
  // destinations are configured from it. An event handled here but absent from
  // the list is invisible to the console; one listed but unhandled is a silent
  // ACK. Both directions are worth a line.
  it.each(ADDED)("%s is subscribed", (type) => {
    expect(HANDLED_EVENT_TYPES).toContain(type);
  });

  it("the two events the brief deferred are NOT subscribed", () => {
    // Positive pair for the assertions above: proves the list is a real filter
    // and not something that contains everything asked of it.
    expect(HANDLED_EVENT_TYPES).not.toContain("invoice.upcoming");
    expect(HANDLED_EVENT_TYPES).not.toContain("radar.early_fraud_warning.created");
  });
});

describe.skipIf(!HAS_DB)("payout health — payout.failed / payout.paid", () => {

  it("payout.failed raises payout_failed and records Stripe's failure code", async () => {
    const { orgId, accountId } = await connectedOrg();
    await processStripeEvent(
      event({
        type: "payout.failed",
        account: accountId,
        object: payout({ status: "failed", failure_code: "account_closed" }),
      }),
    );
    const row = await alertRow(orgId);
    expect(row.stripe_payout_alert).toBe("payout_failed");
    expect(row.stripe_payout_alert_detail).toBe("account_closed");
    expect(row.stripe_payout_alert_at).not.toBeNull();
  });

  it("payout.paid CLEARS a standing alert — the banner cannot outlive the fault", async () => {
    const { orgId, accountId } = await connectedOrg();
    // Alert raised BEFORE the payout was created: the payout is the newer
    // evidence, so it wins.
    await seedAlert(orgId, "payout_failed", new Date(Date.now() - 60 * 60 * 1000));
    await processStripeEvent(
      event({ type: "payout.paid", account: accountId, object: payout({ status: "paid" }) }),
    );
    const row = await alertRow(orgId);
    expect(row.stripe_payout_alert).toBeNull();
    expect(row.stripe_payout_alert_at).toBeNull();
    expect(row.stripe_payout_alert_detail).toBeNull();
    expect(row.stripe_last_payout_at).not.toBeNull();
  });

  it("payout.paid does NOT clear an alert raised after that payout was created", async () => {
    // Defeats the time guard: delete the `stripe_payout_alert_at <= created`
    // condition and this goes green with a null alert. The real shape is a
    // payout that left before the club's bank account was removed and landed
    // after — a stale success must not cancel a newer, still-true alert.
    const { orgId, accountId } = await connectedOrg();
    const payoutCreated = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await seedAlert(orgId, "bank_removed", new Date(Date.now() - 30 * 60 * 1000));
    await processStripeEvent(
      event({
        type: "payout.paid",
        account: accountId,
        object: payout({ status: "paid", created: epoch(payoutCreated) }),
      }),
    );
    const row = await alertRow(orgId);
    expect(row.stripe_payout_alert).toBe("bank_removed");
    // ...and the money still demonstrably landed, so this half is recorded.
    expect(row.stripe_last_payout_at).not.toBeNull();
  });

  it("a payout event with no event.account writes nothing", async () => {
    // The account id is on `event.account`, never on the Payout. Without the
    // guard the writer would be handed `undefined` and match no org — this
    // pins that no OTHER org is touched either.
    const { orgId, accountId } = await connectedOrg();
    await seedAlert(orgId, "payout_failed", new Date(Date.now() - 60 * 60 * 1000));
    await processStripeEvent(
      event({ type: "payout.paid", object: payout({ status: "paid" }) }),
    );
    expect((await alertRow(orgId)).stripe_payout_alert).toBe("payout_failed");
    // Positive pair: the same event WITH the account does clear it, so the
    // assertion above is about the missing account and not about the event
    // being inert.
    await processStripeEvent(
      event({ type: "payout.paid", account: accountId, object: payout({ status: "paid" }) }),
    );
    expect((await alertRow(orgId)).stripe_payout_alert).toBeNull();
  });

  it("a payout for an account no org owns is a silent no-op, not a throw", async () => {
    await expect(
      processStripeEvent(
        event({
          type: "payout.failed",
          account: `acct_${randomUUID().replace(/-/g, "")}`,
          object: payout({ status: "failed", failure_code: "no_account" }),
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe.skipIf(!HAS_DB)("payout health — external account changes", () => {
  beforeEach(() => {
    bankAlert.mockClear();
    vi.mocked(captureError).mockClear();
    // This test's own staff address: CI sets none, and the database is shared.
    staff = `staff-${RUN}-${randomUUID().slice(0, 8)}@x.test`;
    vi.stubEnv("STAFF_ALERT_EMAIL", staff);
    errors = vi.spyOn(log, "error");
  });
  afterEach(() => {
    errors.mockRestore();
    vi.unstubAllEnvs();
  });

  it("account.external_account.deleted raises bank_removed and pages staff", async () => {
    const { orgId, accountId, orgName } = await connectedOrg();
    const ev = event({
      type: "account.external_account.deleted",
      account: accountId,
      object: { id: "ba_deleted1", object: "bank_account", last4: "6789" },
    });
    await processStripeEvent(ev);
    const row = await alertRow(orgId);
    expect(row.stripe_payout_alert).toBe("bank_removed");
    expect(row.stripe_payout_alert_detail).toContain("ba_deleted1");
    expect(bankAlert).toHaveBeenCalledTimes(1);
    expect(bankAlert.mock.calls[0]![0]).toMatchObject({ orgId, accountId });
    expect(await staffRows(BANK_KIND, "stripe_event", ev.id)).toEqual([bankRow(ev.id, orgName)]);
  });

  it("account.external_account.updated raises bank_changed and does NOT page staff", async () => {
    // The `.updated` event fires for benign edits. Its DB half is the positive
    // pair for the negative assertion on the email: the handler demonstrably
    // ran, so "no email" is a decision and not a no-op.
    const { orgId, accountId } = await connectedOrg();
    await processStripeEvent(
      event({
        type: "account.external_account.updated",
        account: accountId,
        object: { id: "ba_updated1", object: "bank_account", last4: "1111" },
      }),
    );
    expect((await alertRow(orgId)).stripe_payout_alert).toBe("bank_changed");
    expect(bankAlert).not.toHaveBeenCalled();
  });

  it("a deleted external account pages once under the event", async () => {
    const { orgId, accountId, orgName } = await connectedOrg();
    const ev = event({
      type: "account.external_account.deleted",
      account: accountId,
      object: { id: "ba_gone", object: "bank_account", last4: "4321" },
    });

    await processStripeEvent(ev);

    expect(await staffRows(BANK_KIND, "stripe_event", ev.id)).toEqual([bankRow(ev.id, orgName)]);
    expect(bankAlert, "what the alert says").toHaveBeenCalledWith({
      orgId,
      orgName,
      accountId,
      detail: "bank_account ba_gone ••••4321",
    });
    expect(drops(), "the alert was queued, not dropped").toEqual({ logged: 0, issues: 0 });
  });

  it("the same event redelivered pages nothing more", async () => {
    const { accountId, orgName } = await connectedOrg();
    const ev = event({
      type: "account.external_account.deleted",
      account: accountId,
      object: { id: "ba_twice", object: "bank_account", last4: "5555" },
    });

    await processStripeEvent(ev);
    await processStripeEvent(ev);

    expect(bankAlert, "premise: the redelivery reached the alert again").toHaveBeenCalledTimes(2);
    expect(await staffRows(BANK_KIND, "stripe_event", ev.id)).toEqual([bankRow(ev.id, orgName)]);
    expect(drops(), "deduplicated, not dropped").toEqual({ logged: 0, issues: 0 });
  });

  it("a second removal on the same account is a second event, and a second alert", async () => {
    // The once-key is the Stripe EVENT, not the account: the club removing one
    // bank account and then its replacement is two things a human must see.
    const { accountId, orgName } = await connectedOrg();
    const first = event({
      type: "account.external_account.deleted",
      account: accountId,
      object: { id: "ba_one", object: "bank_account", last4: "1000" },
    });
    const second = event({
      type: "account.external_account.deleted",
      account: accountId,
      object: { id: "ba_two", object: "bank_account", last4: "2000" },
    });

    await processStripeEvent(first);
    await processStripeEvent(second);

    expect(await staffRows(BANK_KIND, "stripe_event", first.id)).toEqual([bankRow(first.id, orgName)]);
    expect(await staffRows(BANK_KIND, "stripe_event", second.id)).toEqual([bankRow(second.id, orgName)]);
  });

  it("an updated external account pages nothing", async () => {
    // The existing `.updated` guard, read as a row: STAFF_ALERT_EMAIL is set,
    // the org's banner moved (the handler ran), and nothing is queued.
    const { orgId, accountId } = await connectedOrg();
    const ev = event({
      type: "account.external_account.updated",
      account: accountId,
      object: { id: "ba_edit", object: "bank_account", last4: "7777" },
    });

    await processStripeEvent(ev);

    expect((await alertRow(orgId)).stripe_payout_alert, "premise: the handler ran").toBe("bank_changed");
    expect(await staffRows(BANK_KIND, "stripe_event", ev.id)).toEqual([]);
    expect(drops()).toEqual({ logged: 0, issues: 0 });
  });

  it("a routine bank edit does NOT bury a standing payout_failed", async () => {
    // Defeats the severity ladder: make `raiseAlert` write unconditionally and
    // this goes green with "bank_changed", replacing "your payout failed" with
    // "your bank details changed" for someone whose money is stuck.
    const { orgId, accountId } = await connectedOrg();
    await processStripeEvent(
      event({
        type: "payout.failed",
        account: accountId,
        object: payout({ status: "failed", failure_code: "debit_not_authorized" }),
      }),
    );
    await processStripeEvent(
      event({
        type: "account.external_account.updated",
        account: accountId,
        object: { id: "ba_noise", object: "bank_account", last4: "2222" },
      }),
    );
    const row = await alertRow(orgId);
    expect(row.stripe_payout_alert).toBe("payout_failed");
    expect(row.stripe_payout_alert_detail).toBe("debit_not_authorized");
  });

  it("a DELETED bank account DOES replace a standing bank_changed", async () => {
    // The ladder's other direction — without it, the test above would also
    // pass with a rule that simply never overwrites anything.
    const { orgId, accountId } = await connectedOrg();
    await processStripeEvent(
      event({
        type: "account.external_account.updated",
        account: accountId,
        object: { id: "ba_first", object: "bank_account", last4: "3333" },
      }),
    );
    await processStripeEvent(
      event({
        type: "account.external_account.deleted",
        account: accountId,
        object: { id: "ba_second", object: "bank_account", last4: "4444" },
      }),
    );
    expect((await alertRow(orgId)).stripe_payout_alert).toBe("bank_removed");
  });
});

describe.skipIf(!HAS_DB)("customer.subscription.trial_will_end", () => {
  const payers: string[] = [];

  beforeEach(() => {
    stubOutboxEnv();
  });

  afterAll(async () => {
    await sql`delete from email_outbox where kind = 'trial_ending' and recipient_user_id = any(${payers}::uuid[])`;
  });

  async function trialingGroup(hasPaymentMethod: boolean, planKey = "pro") {
    const g = await seedTrialingGroup({ hasPaymentMethod, planKey, ownerLocale: "fr" });
    payers.push(g.ownerId);
    return g;
  }

  /** The trial warnings an event queued (its id is the once-key), in every status. */
  const warningsOf = (eventId: string) =>
    sql<{ recipient: string; recipient_user_id: string | null; subject: string; body_sealed: Buffer | null }[]>`
      select recipient, recipient_user_id, subject, body_sealed from email_outbox
       where kind = 'trial_ending' and dedupe_key = ${eventId}`;

  /** The date line of the warning, as the reader's own locale writes Stripe's trial_end. */
  const longDate = (locale: string, at: Date) => new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(at);

  function trialSub(stripeSubId: string, trialEnd: Date): Stripe.Subscription {
    return {
      id: stripeSubId,
      object: "subscription",
      status: "trialing",
      trial_end: epoch(trialEnd),
      metadata: {},
    } as unknown as Stripe.Subscription;
  }

  it("a no-card trial is warned it will STOP, in the owner's own locale", async () => {
    const { planLabel } = await import("@/lib/plan-label");
    const g = await trialingGroup(false);
    const endsAt = new Date(epoch(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)) * 1000);
    const ev = event({ type: "customer.subscription.trial_will_end", object: trialSub(g.stripeSubId, endsAt) });
    await processStripeEvent(ev);
    const rows = await warningsOf(ev.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipient).toBe(g.ownerEmail);
    expect(rows[0]!.recipient_user_id).toBe(g.ownerId);
    // `card`: the no-card variant (add a card or the trial stops), in fr.
    expect(rows[0]!.subject).toBe(
      dictionarySubject("fr", "trialEnding.subject.card", { planName: planLabel("pro"), date: longDate("fr", endsAt) }),
    );
  });

  it("a card-on-file trial is warned it will CHARGE — the other variant", async () => {
    // Paired with the case above deliberately: `hasPaymentMethod` picks which
    // email this is, so one case alone cannot witness the split. Read from OUR
    // mirror, never the event, which carries no payment method for a trial.
    const { planLabel } = await import("@/lib/plan-label");
    const { openBody } = await import("@/server/email-outbox/seal");
    const g = await trialingGroup(true);
    const endsAt = new Date(epoch(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)) * 1000);
    const ev = event({ type: "customer.subscription.trial_will_end", object: trialSub(g.stripeSubId, endsAt) });
    await processStripeEvent(ev);
    const rows = await warningsOf(ev.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject).toBe(
      dictionarySubject("fr", "trialEnding.subject.charge", { planName: planLabel("pro"), date: longDate("fr", endsAt) }),
    );
    // The link goes to the billing page of the org the payer owns.
    expect(openBody(rows[0]!.body_sealed!).text).toContain(`/o/${g.slug}/settings/billing`);
  });

  it("the plan NAME comes from planLabel, not from the raw key", async () => {
    // Derived from the source of truth rather than a table typed in here: a
    // renamed plan moves this expectation with it.
    const { planLabel } = await import("@/lib/plan-label");
    const g = await trialingGroup(true, "enterprise");
    const ev = event({
      type: "customer.subscription.trial_will_end",
      object: trialSub(g.stripeSubId, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)),
    });
    await processStripeEvent(ev);
    const rows = await warningsOf(ev.id);
    expect(rows).toHaveLength(1);
    expect(planLabel("enterprise"), "premise: the label is not the key").not.toBe("enterprise");
    expect(rows[0]!.subject).toContain(planLabel("enterprise"));
  });

  it("an event whose group cannot be resolved queues nothing and does not throw", async () => {
    // A throw here would park the event and have the sweeper run it again.
    const ev = event({
      type: "customer.subscription.trial_will_end",
      object: trialSub(`sub_${randomUUID().replace(/-/g, "")}`, new Date()),
    });
    await expect(processStripeEvent(ev)).resolves.toBeUndefined();
    expect(await warningsOf(ev.id)).toHaveLength(0);
  });

  it("an event carrying no trial_end queues nothing — there is no date to warn about", async () => {
    const g = await trialingGroup(false);
    const ev = event({
      type: "customer.subscription.trial_will_end",
      object: {
        id: g.stripeSubId,
        object: "subscription",
        status: "trialing",
        trial_end: null,
        metadata: {},
      },
    });
    await expect(processStripeEvent(ev)).resolves.toBeUndefined();
    expect(await warningsOf(ev.id)).toHaveLength(0);
  });
});

describe("event scope partition (pure)", () => {
  // The trap this guards is silent: an event subscribed on the wrong Stripe
  // destination is never delivered, and the handler stays green in every test
  // that posts the event directly. Nothing in CI can reach Stripe to check the
  // real subscription, so the least-bad guard is to force the SPLIT to be
  // declared in code and keep it honest against the handled set.
  it("every connect-scoped type is actually handled", () => {
    for (const type of CONNECT_SCOPED_EVENT_TYPES) {
      expect(HANDLED_EVENT_TYPES).toContain(type);
    }
  });

  it("the four events added this wave are on the CONNECT destination", () => {
    // These describe the club's own Stripe account, so they arrive with an
    // `event.account` and on the connected-accounts secret. Getting this wrong
    // is the whole failure mode above.
    for (const type of [
      "payout.paid",
      "payout.failed",
      "account.external_account.updated",
      "account.external_account.deleted",
    ]) {
      expect(CONNECT_SCOPED_EVENT_TYPES).toContain(type);
    }
  });

  it("the trial warning is NOT connect-scoped — it is a platform subscription", () => {
    // The positive pair for the assertions above: without it, a partition that
    // simply claimed every event would satisfy them. A subscription belongs to
    // the PLATFORM's own customer, never to a connected account, so putting it
    // on the connect destination would mean it is never delivered at all.
    expect(CONNECT_SCOPED_EVENT_TYPES).not.toContain("customer.subscription.trial_will_end");
    expect(HANDLED_EVENT_TYPES).toContain("customer.subscription.trial_will_end");
  });
});
