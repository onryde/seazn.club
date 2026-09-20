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
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

// The trial warning's whole purpose is to REACH A PERSON — a DB write would be
// an inert seam, since `trial_end` is already mirrored elsewhere. So the send
// is what gets asserted, which means the email module is mocked here. Declared
// before the import of the module under test so the mock is in place.
type TrialEndingEmail = import("@/lib/email").TrialEndingEmail;
type ConnectBankAlertEmail = import("@/lib/email").ConnectBankAlertEmail;

// The bodies read `opts` so the recorded call is typed all the way through —
// `mock.calls[0][0]` is then a real TrialEndingEmail, not an empty tuple.
const sendTrialEndingEmail = vi.fn(async (opts: TrialEndingEmail) => Boolean(opts.to));
const sendConnectBankAlertEmail = vi.fn(async (opts: ConnectBankAlertEmail) => Boolean(opts.to));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendTrialEndingEmail,
  sendConnectBankAlertEmail,
}));

const { sql } = await import("@/lib/db");
const { HANDLED_EVENT_TYPES, CONNECT_SCOPED_EVENT_TYPES, processStripeEvent } =
  await import("../billing-events");

const HAS_DB = !!process.env.DATABASE_URL;

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
async function connectedOrg(): Promise<{ orgId: string; accountId: string; ownerId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const accountId = `acct_${suffix}${randomUUID().slice(0, 8)}`;
  const [owner] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${`payout-${suffix}@test.local`}, 'Owner') returning id`;
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, stripe_account_id)
    values (${`Payout ${suffix}`}, ${`payout-${suffix}`}, ${owner!.id}, ${accountId})
    returning id`;
  return { orgId: org!.id, accountId, ownerId: owner!.id };
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
  beforeEach(() => {
    sendConnectBankAlertEmail.mockClear();
    sendTrialEndingEmail.mockClear();
  });

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
    sendConnectBankAlertEmail.mockClear();
  });

  it("account.external_account.deleted raises bank_removed and pages staff", async () => {
    const { orgId, accountId } = await connectedOrg();
    process.env.STAFF_ALERT_EMAIL = "ops@test.local";
    await processStripeEvent(
      event({
        type: "account.external_account.deleted",
        account: accountId,
        object: { id: "ba_deleted1", object: "bank_account", last4: "6789" },
      }),
    );
    const row = await alertRow(orgId);
    expect(row.stripe_payout_alert).toBe("bank_removed");
    expect(row.stripe_payout_alert_detail).toContain("ba_deleted1");
    expect(sendConnectBankAlertEmail).toHaveBeenCalledTimes(1);
    expect(sendConnectBankAlertEmail.mock.calls[0]![0]).toMatchObject({
      to: "ops@test.local",
      orgId,
      accountId,
    });
  });

  it("account.external_account.updated raises bank_changed and does NOT page staff", async () => {
    // The `.updated` event fires for benign edits. Its DB half is the positive
    // pair for the negative assertion on the email: the handler demonstrably
    // ran, so "no email" is a decision and not a no-op.
    const { orgId, accountId } = await connectedOrg();
    process.env.STAFF_ALERT_EMAIL = "ops@test.local";
    await processStripeEvent(
      event({
        type: "account.external_account.updated",
        account: accountId,
        object: { id: "ba_updated1", object: "bank_account", last4: "1111" },
      }),
    );
    expect((await alertRow(orgId)).stripe_payout_alert).toBe("bank_changed");
    expect(sendConnectBankAlertEmail).not.toHaveBeenCalled();
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
  beforeEach(() => {
    sendTrialEndingEmail.mockClear();
  });

  async function trialingGroup(hasPaymentMethod: boolean, planKey = "pro") {
    const suffix = randomUUID().slice(0, 8);
    const [owner] = await sql<{ id: string }[]>`
      insert into users (email, display_name, locale)
      values (${`trial-${suffix}@test.local`}, 'Owner', 'fr') returning id`;
    const stripeSubId = `sub_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const [group] = await sql<{ id: string }[]>`
      insert into subscriptions
        (owner_user_id, plan_key, status, has_payment_method, stripe_subscription_id)
      values (${owner!.id}, ${planKey}, 'trialing', ${hasPaymentMethod}, ${stripeSubId})
      returning id`;
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by, subscription_id)
      values (${`Trial ${suffix}`}, ${`trial-${suffix}`}, ${owner!.id}, ${group!.id})
      returning id`;
    return {
      groupId: group!.id,
      stripeSubId,
      ownerEmail: `trial-${suffix}@test.local`,
      slug: `trial-${suffix}`,
      orgId: org!.id,
    };
  }

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
    const g = await trialingGroup(false);
    const endsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await processStripeEvent(
      event({
        type: "customer.subscription.trial_will_end",
        object: trialSub(g.stripeSubId, endsAt),
      }),
    );
    expect(sendTrialEndingEmail).toHaveBeenCalledTimes(1);
    expect(sendTrialEndingEmail.mock.calls[0]![0]).toMatchObject({
      to: g.ownerEmail,
      locale: "fr",
      hasPaymentMethod: false,
      orgSlug: g.slug,
    });
  });

  it("a card-on-file trial is warned it will CHARGE — the other variant", async () => {
    // Paired with the case above deliberately: `hasPaymentMethod` picks which
    // email this is, so one case alone cannot witness the split. Read from OUR
    // mirror, never the event, which carries no payment method for a trial.
    const g = await trialingGroup(true);
    await processStripeEvent(
      event({
        type: "customer.subscription.trial_will_end",
        object: trialSub(g.stripeSubId, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)),
      }),
    );
    expect(sendTrialEndingEmail).toHaveBeenCalledTimes(1);
    expect(sendTrialEndingEmail.mock.calls[0]![0]).toMatchObject({
      hasPaymentMethod: true,
      orgSlug: g.slug,
    });
  });

  it("the plan NAME comes from planLabel, not from the raw key", async () => {
    // Derived from the source of truth rather than a table typed in here: a
    // renamed plan moves this expectation with it.
    const { planLabel } = await import("@/lib/plan-label");
    const g = await trialingGroup(true, "enterprise");
    await processStripeEvent(
      event({
        type: "customer.subscription.trial_will_end",
        object: trialSub(g.stripeSubId, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)),
      }),
    );
    expect(sendTrialEndingEmail.mock.calls[0]![0]).toMatchObject({
      planName: planLabel("enterprise"),
    });
  });

  it("an event whose group cannot be resolved sends nothing and does not throw", async () => {
    // A throw here would park the event and have the sweeper re-send the same
    // warning up to three more times.
    await expect(
      processStripeEvent(
        event({
          type: "customer.subscription.trial_will_end",
          object: trialSub(`sub_${randomUUID().replace(/-/g, "")}`, new Date()),
        }),
      ),
    ).resolves.toBeUndefined();
    expect(sendTrialEndingEmail).not.toHaveBeenCalled();
  });

  it("an event carrying no trial_end sends nothing — there is no date to warn about", async () => {
    const g = await trialingGroup(false);
    await processStripeEvent(
      event({
        type: "customer.subscription.trial_will_end",
        object: {
          id: g.stripeSubId,
          object: "subscription",
          status: "trialing",
          trial_end: null,
          metadata: {},
        },
      }),
    );
    expect(sendTrialEndingEmail).not.toHaveBeenCalled();
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
