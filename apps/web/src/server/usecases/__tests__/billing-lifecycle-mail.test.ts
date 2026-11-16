// Billing lifecycle mails (2026-11-15): which Stripe event queues which mail, to whom, once.
//
// Every DB case is driven through the REAL webhook dispatch (`processStripeEvent`, the table the signed webhook and the staff replay
// share) with a REAL Stripe payload: events captured from a Stripe sandbox with test clocks (_billing-lifecycle-fixtures.ts), pointed at
// a seeded billing group and rebased in time. Expected values — dates, amounts, the once-key — are read off the rebased event, never
// off the code under test; subjects come from the dictionary on disk in the payer's language.
//
// What the sandbox settled (report-1.md): `cancellation_details.reason` reads `cancellation_requested` on EVERY deletion, the untouched
// trial included; the charge that ends a card trial is `subscription_cycle`, like a renewal, its line period starting at `trial_end`;
// an `invoice.upcoming` payload has no `id`, and Stripe sends one before a card trial's first charge too. And (2026-11-16, report-2.md): a
// renewal whose card asks the bank for authentication (3-D Secure) sends BOTH `invoice.payment_action_required` and
// `invoice.payment_failed` for one invoice, in the same second, with identical invoice objects: no charge, `attempt_count` 0, no retry.
// A declined card and a renewal with no card left are both counted (`attempt_count` 1, a retry scheduled).
//
// The pure guards are swept first (no database), each over the captured events it judges; the DB half then proves each guard is
// wired, each once-key holds a redelivery, and the sequences a payer actually lives through queue exactly the mails they should.
//
// Sport: not applicable. Billing does not vary by sport.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));
// No path here may reach Stripe for the mail. The renewal true-up (`syncGroupQuantity`) is best-effort and swallows its own error, so a
// throwing double is safe on that path and loud anywhere else.
vi.mock("@/lib/stripe", async (io) => ({
  ...(await io<typeof import("@/lib/stripe")>()),
  getStripe: () => {
    throw new Error("billing-lifecycle-mail.test: no Stripe call expected");
  },
}));

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { planLabel } from "@/lib/plan-label";
import { formatMoneyExact } from "@/lib/format-money-exact";
import type { Locale } from "@/lib/i18n-constants";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { openBody } from "@/server/email-outbox/seal";
import { log } from "@/server/logger";
import { CONNECT_SCOPED_EVENT_TYPES, HANDLED_EVENT_TYPES, processStripeEvent, runEvent } from "../billing-events";
import {
  BillingGroupNotLinkedError,
  annualRenewalLine,
  awaitsConfirmation,
  isFirstPayment,
  renewalReceiptsEnabled,
  subscriptionChange,
  trialRanOut,
} from "../billing-events/lifecycle-mail";
import { stubOutboxEnv } from "./_invite-mail";
import { cleanUpSponsorOrgs } from "./_money-fixtures";
import {
  CAPTURED_EVENT_NAMES,
  capturedEvent,
  capturedValue,
  freshInvoiceId,
  groupMail,
  nowSeconds,
  seedBillingGroup,
  type CapturedEventName,
} from "./_billing-lifecycle-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const DAY = 86_400;
const PRO = planLabel("pro");
const made = { orgIds: [] as string[], userIds: [] as string[] };

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where recipient_user_id = any(${made.userIds}::uuid[])`;
  await sql`delete from billing_events where id like 'evt_blm_%'`;
  await cleanUpSponsorOrgs(made.orgIds, made.userIds);
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

beforeEach(() => {
  // A test that turns the receipt gate off must not leak it into the next one.
  vi.unstubAllEnvs();
  stubOutboxEnv();
  deliverMock.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_blm_${randomUUID()}` }));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------------------------------------------------------------

// The payloads are Stripe's JSON, read field by field: typed loosely on purpose, every read is checked against the dictionary or the DB.
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const obj = (e: Stripe.Event): Obj => e.data.object as unknown as Obj;
const sub = (e: Stripe.Event): Stripe.Subscription => e.data.object as Stripe.Subscription;
const inv = (e: Stripe.Event): Stripe.Invoice => e.data.object as Stripe.Invoice;
const prev = (e: Stripe.Event): Partial<Stripe.Subscription> | undefined =>
  (e.data as { previous_attributes?: Partial<Stripe.Subscription> }).previous_attributes;
const day = (unix: number, locale: Locale): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(unix * 1000));
const ANY_SUB = "sub_blm_pure";
const at = (name: CapturedEventName, anchor: (o: Obj) => number, when: number, edit?: (o: Record<string, unknown>) => void) =>
  capturedEvent(name, { stripeSubId: ANY_SUB, anchor, at: when, edit });

async function body(rowId: string): Promise<string> {
  const [r] = await sql<{ body_sealed: Uint8Array | null }[]>`select body_sealed from email_outbox where id = ${rowId}`;
  expect(r?.body_sealed, "premise: the row still holds its sealed body (queued for the worker)").toBeTruthy();
  return openBody(r!.body_sealed!).text;
}

async function group(o: Parameters<typeof seedBillingGroup>[0]) {
  const g = await seedBillingGroup(o);
  made.orgIds.push(g.orgId);
  made.userIds.push(g.ownerId);
  return g;
}

const kinds = async (groupId: string): Promise<string[]> => (await groupMail(groupId)).map((r) => r.kind);

// ---------------------------------------------------------------------------------------------------------------------------------
// The pure guards (no database)
// ---------------------------------------------------------------------------------------------------------------------------------

describe("the captured payloads (no database)", () => {
  it("are the twenty-three events the suite reads, and an invoice.upcoming carries no invoice id (the coordinator's premise, measured)", () => {
    expect(CAPTURED_EVENT_NAMES, "anti-vacuity: the fixture file is not empty").toHaveLength(23);
    const upcoming = CAPTURED_EVENT_NAMES.filter((n) => n.startsWith("invoice.upcoming."));
    expect(upcoming).toHaveLength(3);
    for (const n of upcoming) {
      const o = obj(at(n, (x) => x.created, nowSeconds()));
      expect("id" in o, n).toBe(false);
      expect(o.billing_reason, n).toBe("upcoming");
    }
  });

  it("cancellation_details.reason cannot tell a trial that ran out from a cancel the payer asked for: all five deletions say the same", () => {
    const deleted = CAPTURED_EVENT_NAMES.filter((n) => n.startsWith("subscription.deleted."));
    expect(deleted).toHaveLength(5);
    const reasons = new Set(deleted.map((n) => obj(at(n, (x) => x.created, nowSeconds())).cancellation_details?.reason));
    expect([...reasons]).toEqual(["cancellation_requested"]);
  });

  it("a renewal the bank wants confirmed arrives TWICE, as payment_action_required and payment_failed, for one invoice with one object: no charge, no retry", () => {
    const now = nowSeconds();
    const asked = obj(at("invoice.payment_action_required.monthly_renewal", (x) => x.created, now));
    const failed = obj(at("invoice.payment_failed.monthly_renewal_needs_confirmation", (x) => x.created, now));
    expect(failed, "the sandbox sent the same invoice object on both events").toEqual(asked);
    expect(asked.billing_reason).toBe("subscription_cycle");
    expect(asked.attempt_count, "Stripe did not count it as a charge attempt").toBe(0);
    expect(asked.charge, "no charge was made").toBeUndefined();
    expect(asked.next_payment_attempt, "no retry is scheduled: the payer must act").toBeUndefined();
    expect(asked.hosted_invoice_url, "the Stripe-hosted page to confirm on").toMatch(/^https:\/\/invoice\.stripe\.com\//);
    // The other two failures are counted attempts with a retry: a declined card (a charge was made) and a renewal with no card left.
    for (const n of ["invoice.payment_failed.monthly_renewal", "invoice.payment_failed.monthly_renewal_no_card"] as const) {
      const o = obj(at(n, (x) => x.created, now));
      expect(o.attempt_count, n).toBe(1);
      expect(o.next_payment_attempt, n).toBeGreaterThan(o.created);
    }
  });
});

describe("awaitsConfirmation (no database)", () => {
  // Typed from the sandbox capture (2026-11-16): which failures stopped for the bank, and which were real failures.
  const cases: [CapturedEventName, boolean][] = [
    ["invoice.payment_action_required.monthly_renewal", true],
    ["invoice.payment_failed.monthly_renewal_needs_confirmation", true],
    ["invoice.payment_action_required.new_paid_monthly", true],
    ["invoice.payment_failed.monthly_renewal", false],
    ["invoice.payment_failed.monthly_renewal_no_card", false],
  ];
  it.each(cases)("%s -> %s", (name, expected) => {
    expect(awaitsConfirmation(inv(at(name, (o) => o.created, nowSeconds())))).toBe(expected);
  });
  it("judged five captured invoices, three of them waiting on the bank", () => {
    expect(cases).toHaveLength(5);
    expect(cases.filter((c) => c[1])).toHaveLength(3);
  });
  it("an invoice that says nothing about its attempts is not taken for one waiting on the bank (the dunning notice still goes)", () => {
    expect(awaitsConfirmation(inv(at("invoice.payment_failed.monthly_renewal", (o) => o.created, nowSeconds(), (o) => void delete o.attempt_count)))).toBe(false);
  });
});

describe("HANDLED_EVENT_TYPES: the confirmation request (no database)", () => {
  it("invoice.payment_action_required is subscribed, on the platform's own destination", () => {
    expect(HANDLED_EVENT_TYPES).toContain("invoice.payment_action_required");
    expect(CONNECT_SCOPED_EVENT_TYPES).not.toContain("invoice.payment_action_required");
  });
});

describe("trialRanOut (no database)", () => {
  const now = nowSeconds();
  // [case, event, mirror status before the delete, expected]. Each `false` row is the only guard that refuses it (one killer each).
  const cases: [string, Stripe.Event, string | null, boolean][] = [
    ["a no-card trial ran out", at("subscription.deleted.trial_ran_out_no_card", (o) => o.trial_end, now), "trialing", true],
    // Killer of the mirror guard: the same payload, but our mirror says the group had converted and was paying.
    ["the same payload on a group the mirror says was paying", at("subscription.deleted.trial_ran_out_no_card", (o) => o.trial_end, now), "active", false],
    // Killer of the scheduled-end guard (sandbox E and F: a cancel scheduled during the trial ends at trial_end too).
    ["a no-card trial the payer cancelled", at("subscription.deleted.trial_cancel_scheduled_no_card", (o) => o.trial_end, now), "trialing", false],
    ["a card trial the payer cancelled", at("subscription.deleted.trial_cancel_scheduled_card", (o) => o.trial_end, now), "trialing", false],
    // Killer of the ended-at-or-after guard: a cancel NOW during the trial (Dashboard), constructed from D by moving ended_at.
    [
      "a trial cancelled outright five days before its end",
      at("subscription.deleted.trial_ran_out_no_card", (o) => o.trial_end, now, (o) => {
        o.ended_at = (o.trial_end as number) - 5 * DAY;
        o.canceled_at = o.ended_at;
      }),
      "trialing",
      false,
    ],
    // Killer of the no-trial guard: the mirror says trialing but Stripe's payload names no trial (a mirror that disagrees). Stripe sends
    // the field as null (the capture pruned nulls), and `ended_at >= null` is TRUE in JavaScript, so the guard is load-bearing.
    [
      "a payload with trial_end null",
      at("subscription.deleted.trial_ran_out_no_card", (o) => o.trial_end, now, (o) => {
        o.trial_end = null;
      }),
      "trialing",
      false,
    ],
    // Killer of the at-most-an-hour-after guard (review m-5): a trial that converted and was paid for, then cancelled outright a
    // month later, while our mirror still says trialing (its conversion update stuck). A trial that runs out ends AT trial_end, or a
    // processing delay after it — so anything much later is not one.
    [
      "a converted trial cancelled a month after its end while the mirror still says trialing",
      at("subscription.deleted.trial_ran_out_no_card", (o) => o.trial_end, now, (o) => {
        o.ended_at = (o.trial_end as number) + 30 * DAY;
        o.canceled_at = o.ended_at;
      }),
      "trialing",
      false,
    ],
    // The same, cancelled two hours after the trial's end: past the hour the run-out is allowed (the window's upper edge).
    [
      "a converted trial cancelled two hours after its end while the mirror still says trialing",
      at("subscription.deleted.trial_ran_out_no_card", (o) => o.trial_end, now, (o) => {
        o.ended_at = (o.trial_end as number) + 2 * 3600;
        o.canceled_at = o.ended_at;
      }),
      "trialing",
      false,
    ],
    // Review round 2 m-c: the sandbox stamped ended_at == trial_end because a TEST CLOCK advances to the exact second; live Stripe
    // stamps when it processed the trial's end, which can be seconds or minutes later. That run-out must still mail.
    [
      "a no-card trial ran out and live Stripe stamped its end two minutes after trial_end",
      at("subscription.deleted.trial_ran_out_no_card", (o) => o.trial_end, now, (o) => {
        o.ended_at = (o.trial_end as number) + 120;
        o.canceled_at = o.ended_at;
      }),
      "trialing",
      true,
    ],
    // The window is one-sided: a cancel NOW ten minutes before the trial's end is the payer's, not a run-out (Stripe never ends a
    // trial early on its own).
    [
      "a trial cancelled outright ten minutes before its end",
      at("subscription.deleted.trial_ran_out_no_card", (o) => o.trial_end, now, (o) => {
        o.ended_at = (o.trial_end as number) - 600;
        o.canceled_at = o.ended_at;
      }),
      "trialing",
      false,
    ],
    ["a paid plan the payer cancelled at period end", at("subscription.deleted.paid_cancel_scheduled", (o) => o.ended_at, now), "active", false],
    ["a paid plan cancelled outright", at("subscription.deleted.paid_canceled_now", (o) => o.ended_at, now), "past_due", false],
  ];
  it.each(cases)("%s", (_name, event, before, expected) => {
    expect(trialRanOut(sub(event), before)).toBe(expected);
  });
  it("judged twelve cases, two of them positive; the sandbox's own run-out (a test clock) ends exactly at trial_end", () => {
    const d = at("subscription.deleted.trial_ran_out_no_card", (o) => o.trial_end, now);
    expect(obj(d).ended_at, "premise (sandbox D): a trial that runs out ends at trial_end").toBe(obj(d).trial_end);
    expect(cases).toHaveLength(12);
    expect(cases.filter((c) => c[3])).toHaveLength(2);
  });
});

describe("subscriptionChange (no database)", () => {
  const now = nowSeconds();
  it("a cancel scheduled: ends at the payload's cancel_at", () => {
    const e = at("subscription.updated.cancel_scheduled", (o) => o.cancel_at, now + 10 * DAY);
    expect(subscriptionChange(sub(e), prev(e))).toEqual({
      variant: "cancel_scheduled",
      endsAt: new Date(obj(e).cancel_at * 1000).toISOString(),
    });
  });
  it("a resume", () => {
    const e = at("subscription.updated.resumed", (o) => o.created, now);
    expect(subscriptionChange(sub(e), prev(e))).toEqual({ variant: "resumed" });
  });
  it("a monthly-to-annual switch: the new interval, and the plan item's period end as the next billing date", () => {
    const e = at("subscription.updated.interval_switch_to_annual", (o) => o.created, now);
    const item = obj(e).items.data[0];
    expect(item.price.recurring.interval, "premise: the payload moved TO annual").toBe("year");
    expect(subscriptionChange(sub(e), prev(e))).toEqual({
      variant: "plan_changed",
      interval: "year",
      nextBillingAt: new Date(item.current_period_end * 1000).toISOString(),
    });
  });
  it("a renewal, a trial converting and an update with no previous attributes earn nothing", () => {
    let checked = 0;
    for (const n of ["subscription.updated.trial_converted", "subscription.updated.annual_renewal"] as const) {
      const e = at(n, (o) => o.created, now);
      expect(prev(e)?.items, `premise: ${n} changed the items (the interval guard is what refuses it)`).toBeTruthy();
      expect(subscriptionChange(sub(e), prev(e)), n).toBeNull();
      checked++;
    }
    const e = at("subscription.updated.cancel_scheduled", (o) => o.created, now);
    expect(subscriptionChange(sub(e), undefined)).toBeNull();
    checked++;
    expect(checked).toBe(3);
  });
  it("a subscription that is no longer live earns nothing, whatever changed", () => {
    const e = at("subscription.updated.cancel_scheduled", (o) => o.created, now, (o) => {
      o.status = "canceled";
    });
    expect(subscriptionChange(sub(e), prev(e))).toBeNull();
  });
});

describe("isFirstPayment and annualRenewalLine (no database)", () => {
  const now = nowSeconds();
  it("a new paid subscription's invoice is its first payment", () => {
    const e = at("invoice.payment_succeeded.new_paid_monthly", (o) => o.created, now);
    expect(inv(e).billing_reason).toBe("subscription_create");
    expect(isFirstPayment(inv(e), null)).toBe(true);
  });
  it("the charge that ends a trial is `subscription_cycle`, told apart by its period starting at the trial's end", () => {
    const e = at("invoice.payment_succeeded.trial_conversion_annual", (o) => o.created, now);
    expect(inv(e).billing_reason, "premise (sandbox): a conversion is a cycle invoice").toBe("subscription_cycle");
    const trialEnd = new Date(obj(e).lines.data[0].period.start * 1000);
    expect(isFirstPayment(inv(e), trialEnd)).toBe(true);
    // Without the mirror's trial end it would read as a renewal: the discriminator is the period, not the reason.
    expect(isFirstPayment(inv(e), null)).toBe(false);
  });
  it("the renewal a year later, on the same group, is not", () => {
    const conversion = at("invoice.payment_succeeded.trial_conversion_annual", (o) => o.created, now - 365 * DAY);
    const trialEnd = new Date(obj(conversion).lines.data[0].period.start * 1000);
    const renewal = at("invoice.payment_succeeded.annual_renewal", (o) => o.created, now);
    expect(inv(renewal).billing_reason).toBe("subscription_cycle");
    expect(isFirstPayment(inv(renewal), trialEnd)).toBe(false);
  });
  it("an annual renewal is announced, a monthly one is not; the line is annual from 365 days (a calendar year is never shorter)", () => {
    const annual = at("invoice.upcoming.annual_renewal", (o) => o.period_end, now + 3 * DAY);
    expect(annualRenewalLine(inv(annual))).not.toBeNull();
    expect(annualRenewalLine(inv(at("invoice.upcoming.monthly_renewal", (o) => o.period_end, now + 3 * DAY)))).toBeNull();
    const span = (days: number) =>
      at("invoice.upcoming.annual_renewal", (o) => o.period_end, now, (o) => {
        const line = (o.lines as { data: { period: { start: number; end: number } }[] }).data[0]!;
        line.period.end = line.period.start + days * DAY;
      });
    expect(annualRenewalLine(inv(span(365)))).not.toBeNull();
    expect(annualRenewalLine(inv(span(364)))).toBeNull();
  });
});

describe("renewalReceiptsEnabled (no database)", () => {
  // OFF unless asked for (review m-6): help/billing/plans.md says Stripe already emails every invoice, so ours is opt-in until the owner
  // confirms Stripe's receipts are off.
  it.each([
    [undefined, false],
    ["", false],
    ["0", false],
    ["false", false],
    ["no", false],
    ["1", true],
    ["true", true],
    [" ON ", true],
    ["yes", true],
  ] as const)("BILLING_RENEWAL_RECEIPT_EMAILS=%j -> %s", (value, expected) => {
    expect(renewalReceiptsEnabled({ BILLING_RENEWAL_RECEIPT_EMAILS: value })).toBe(expected);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Through the webhook dispatch (DB)
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("trial_expired: customer.subscription.deleted", () => {
  it("a no-card trial that ran out mails its payer once, in their language, about the plan the trial was for", async () => {
    const trialEnd = nowSeconds() - 60;
    const g = await group({ status: "trialing", trialEnd: new Date(trialEnd * 1000), ownerLocale: "fr", orgDefaultLocale: "en" });
    const e = capturedEvent("subscription.deleted.trial_ran_out_no_card", { stripeSubId: g.stripeSubId, anchor: (o) => o.trial_end, at: trialEnd });
    await processStripeEvent(e);

    const rows = await groupMail(g.groupId);
    expect(rows).toHaveLength(1);
    const [r] = rows;
    expect(r).toMatchObject({
      kind: "trial_expired",
      status: "queued",
      ref_type: "subscription",
      ref_id: g.groupId,
      org_id: null,
      recipient: g.ownerEmail.toLowerCase(),
      recipient_user_id: g.ownerId,
      transactional: true,
      dedupe_key: g.stripeSubId,
    });
    // "Pro", not "Community": the plan is read before the downgrade writes community over it.
    expect(r!.subject).toBe(dictionarySubject("fr", "trialExpired.subject", { planName: PRO }));
    expect(await body(r!.id)).toContain(day(obj(e).trial_end, "fr"));
    expect(await body(r!.id)).toContain(`/o/${g.slug}/settings/billing`);
    const [mirror] = await sql<{ plan_key: string; status: string }[]>`select plan_key, status from subscriptions where id = ${g.groupId}`;
    expect(mirror, "the downgrade committed with the mail").toEqual({ plan_key: "community", status: "canceled" });
  });

  it("a redelivery queues nothing more — and the once-key holds it even when the mirror is put back to trialing", async () => {
    const trialEnd = nowSeconds() - 60;
    const g = await group({ status: "trialing", trialEnd: new Date(trialEnd * 1000) });
    const e = capturedEvent("subscription.deleted.trial_ran_out_no_card", { stripeSubId: g.stripeSubId, anchor: (o) => o.trial_end, at: trialEnd });
    await processStripeEvent(e);
    await processStripeEvent(e);
    expect(await kinds(g.groupId)).toEqual(["trial_expired"]);
    // The status guard would refuse a third run on its own (the mirror now says canceled). Put the mirror back so only the once-key
    // stands between the replay and a second row.
    await sql`update subscriptions set status = 'trialing', plan_key = 'pro' where id = ${g.groupId}`;
    await processStripeEvent({ ...e, id: `evt_blm_${randomUUID().slice(0, 12)}` } as Stripe.Event);
    expect(await kinds(g.groupId)).toEqual(["trial_expired"]);
  });

  it("no mail for any other deletion; the group is still downgraded each time (the handler ran)", async () => {
    const now = nowSeconds() - 60;
    const cases: [CapturedEventName, Parameters<typeof seedBillingGroup>[0], (o: Obj) => number, ((o: Record<string, unknown>) => void)?][] = [
      ["subscription.deleted.trial_cancel_scheduled_no_card", { status: "trialing", cancelAtPeriodEnd: true }, (o) => o.trial_end],
      ["subscription.deleted.trial_cancel_scheduled_card", { status: "trialing", hasPaymentMethod: true, cancelAtPeriodEnd: true }, (o) => o.trial_end],
      ["subscription.deleted.paid_cancel_scheduled", { status: "active", cancelAtPeriodEnd: true }, (o) => o.ended_at],
      ["subscription.deleted.paid_canceled_now", { status: "past_due" }, (o) => o.ended_at],
      // Converted and paying, then cancelled: the payload still carries its old trial_end.
      ["subscription.deleted.trial_ran_out_no_card", { status: "active" }, (o) => o.trial_end],
      [
        "subscription.deleted.trial_ran_out_no_card",
        { status: "trialing" },
        (o) => o.trial_end,
        (o) => {
          o.ended_at = (o.trial_end as number) - 5 * DAY;
        },
      ],
    ];
    let checked = 0;
    for (const [name, state, anchor, edit] of cases) {
      const g = await group(state);
      await processStripeEvent(capturedEvent(name, { stripeSubId: g.stripeSubId, anchor, at: now, edit }));
      expect(await kinds(g.groupId), name).toEqual([]);
      const [m] = await sql<{ status: string }[]>`select status from subscriptions where id = ${g.groupId}`;
      expect(m!.status, `${name}: positive pair, the delete was handled`).toBe("canceled");
      checked++;
    }
    expect(checked).toBe(6);
  });
});

describe.skipIf(!HAS_DB)("plan_activated and renewal_paid: invoice.payment_succeeded", () => {
  it("a new paid subscription: the activation mail, with the amount paid and the period it runs to", async () => {
    const g = await group({ status: "active", ownerLocale: "es" });
    const e = capturedEvent("invoice.payment_succeeded.new_paid_monthly", {
      stripeSubId: g.stripeSubId,
      anchor: (o) => o.created,
      at: nowSeconds(),
      edit: freshInvoiceId,
    });
    await processStripeEvent(e);
    const rows = await groupMail(g.groupId);
    expect(rows.map((r) => r.kind)).toEqual(["plan_activated"]);
    expect(rows[0]).toMatchObject({ dedupe_key: obj(e).id, transactional: true, recipient_user_id: g.ownerId });
    expect(rows[0]!.subject).toBe(dictionarySubject("es", "planActivated.subject", { planName: PRO }));
    const text = await body(rows[0]!.id);
    expect(text).toContain(formatMoneyExact(obj(e).amount_paid, obj(e).currency, "es"));
    expect(text).toContain(day(obj(e).lines.data[0].period.end, "es"));
    expect(text).toContain(obj(e).hosted_invoice_url);
  });

  it("the charge that ends a card trial is an ACTIVATION, not a receipt, though Stripe calls it subscription_cycle", async () => {
    const created = nowSeconds();
    const e0 = capturedEvent("invoice.payment_succeeded.trial_conversion_annual", { stripeSubId: "sub_x", anchor: (o) => o.created, at: created });
    const trialEnd = new Date(obj(e0).lines.data[0].period.start * 1000);
    const g = await group({ status: "trialing", hasPaymentMethod: true, trialEnd });
    const e = capturedEvent("invoice.payment_succeeded.trial_conversion_annual", {
      stripeSubId: g.stripeSubId,
      anchor: (o) => o.created,
      at: created,
      edit: freshInvoiceId,
    });
    await processStripeEvent(e);
    expect(await kinds(g.groupId)).toEqual(["plan_activated"]);
  });

  it("a renewal a year after the trial: the receipt only with BILLING_RENEWAL_RECEIPT_EMAILS=1 (default off, and 0, send nothing)", async () => {
    const trialEnd = new Date((nowSeconds() - 365 * DAY) * 1000);
    let checked = 0;
    for (const [flag, expected] of [
      [undefined, []],
      ["1", ["renewal_paid"]],
      ["0", []],
    ] as const) {
      vi.stubEnv("BILLING_RENEWAL_RECEIPT_EMAILS", flag);
      checked++;
      const g = await group({ status: "active", trialEnd });
      const e = capturedEvent("invoice.payment_succeeded.annual_renewal", {
        stripeSubId: g.stripeSubId,
        anchor: (o) => o.created,
        at: nowSeconds(),
        edit: freshInvoiceId,
      });
      await processStripeEvent(e);
      expect(await kinds(g.groupId), `flag=${flag}`).toEqual(expected);
      if (expected.length) {
        const [r] = await groupMail(g.groupId);
        expect(r!.subject).toBe(dictionarySubject("en", "renewalPaid.subject", { planName: PRO }));
        expect(await body(r!.id)).toContain(formatMoneyExact(obj(e).amount_paid, obj(e).currency, "en"));
      }
    }
    expect(checked).toBe(3);
  });

  it("the gate stops only the receipt: an activation still goes with BILLING_RENEWAL_RECEIPT_EMAILS=0", async () => {
    vi.stubEnv("BILLING_RENEWAL_RECEIPT_EMAILS", "0");
    const g = await group({ status: "active" });
    await processStripeEvent(
      capturedEvent("invoice.payment_succeeded.new_paid_monthly", { stripeSubId: g.stripeSubId, anchor: (o) => o.created, at: nowSeconds(), edit: freshInvoiceId }),
    );
    expect(await kinds(g.groupId)).toEqual(["plan_activated"]);
  });

  it("nothing for a $0 invoice (a trial opening, an interval switch inside a trial) or a proration", async () => {
    let checked = 0;
    for (const [name, edit] of [
      ["invoice.payment_succeeded.trial_start_zero", freshInvoiceId],
      ["invoice.payment_succeeded.interval_switch_in_trial_zero", freshInvoiceId],
      // A PAID proration (an interval switch after the trial): constructed from the paid monthly invoice by its reason.
      [
        "invoice.payment_succeeded.new_paid_monthly",
        (o: Record<string, unknown>) => {
          freshInvoiceId(o);
          o.billing_reason = "subscription_update";
        },
      ],
    ] as const) {
      const g = await group({ status: "active" });
      const e = capturedEvent(name, { stripeSubId: g.stripeSubId, anchor: (o) => o.created, at: nowSeconds(), edit });
      await processStripeEvent(e);
      expect(await kinds(g.groupId), name).toEqual([]);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("one mail per invoice: a redelivery, and a second event for the same invoice, queue nothing more", async () => {
    const g = await group({ status: "active" });
    const e = capturedEvent("invoice.payment_succeeded.new_paid_monthly", { stripeSubId: g.stripeSubId, anchor: (o) => o.created, at: nowSeconds(), edit: freshInvoiceId });
    await processStripeEvent(e);
    await processStripeEvent(e);
    await processStripeEvent({ ...e, id: `evt_blm_${randomUUID().slice(0, 12)}` } as Stripe.Event);
    expect(await kinds(g.groupId)).toEqual(["plan_activated"]);
  });

  it("an invoice that lands BEFORE customer.subscription.created links the group is refused and left unprocessed; once linked, the retry sends exactly one activation (review I-1)", async () => {
    const g = await group({ status: "active" });
    // Before the link: the group exists (checkout stamped its id on the subscription's metadata, which Stripe copies onto the
    // invoice's parent) but stores no Stripe subscription yet — only customer.subscription.created writes it.
    await sql`update subscriptions set stripe_subscription_id = null where id = ${g.groupId}`;
    const stamped = { org_id: g.orgId, subscription_id: g.groupId };
    const invoice = capturedEvent("invoice.payment_succeeded.new_paid_monthly", {
      stripeSubId: g.stripeSubId,
      anchor: (o) => o.created,
      at: nowSeconds(),
      edit: (o) => {
        freshInvoiceId(o);
        (o.parent as { subscription_details: { metadata: Record<string, string> } }).subscription_details.metadata = stamped;
      },
    });
    await expect(runEvent(invoice)).rejects.toThrow(BillingGroupNotLinkedError);
    expect(await kinds(g.groupId)).toEqual([]);
    const ledger = () => sql<{ processed_at: Date | null }[]>`select processed_at from billing_events where id = ${invoice.id}`;
    expect((await ledger())[0], "the ledger holds the event").toBeDefined();
    expect((await ledger())[0]!.processed_at, "left unprocessed, so it is retried").toBeNull();

    // The link: the REAL customer.subscription.created (a captured live subscription, re-typed and stamped as checkout stamps it).
    const link = capturedEvent("subscription.updated.resumed", {
      stripeSubId: g.stripeSubId,
      anchor: (o) => o.created,
      at: nowSeconds(),
      edit: (o) => {
        // A new PAID subscription (no trial), stamped as checkout stamps it.
        o.metadata = stamped;
        o.status = "active";
        o.trial_end = null;
      },
    });
    const created = { ...link, type: "customer.subscription.created", data: { object: link.data.object } } as unknown as Stripe.Event;
    await processStripeEvent(created);
    const [linked] = await sql<{ stripe_subscription_id: string | null }[]>`select stripe_subscription_id from subscriptions where id = ${g.groupId}`;
    expect(linked!.stripe_subscription_id, "premise: the real handler linked the group").toBe(g.stripeSubId);

    // The retry (Stripe's, or the stuck-event sweeper's once the 10-minute lease has passed).
    await sql`update billing_events set processing_started_at = now() - interval '11 minutes' where id = ${invoice.id}`;
    expect(await runEvent(invoice)).toBe(true);
    expect(await kinds(g.groupId)).toEqual(["plan_activated"]);
    expect((await ledger())[0]!.processed_at).not.toBeNull();
    // And again: nothing more.
    expect(await runEvent(invoice)).toBe(false);
    await processStripeEvent(invoice);
    expect(await kinds(g.groupId)).toEqual(["plan_activated"]);
  });

  it("an unlinked invoice that is NOT waiting for one of our groups is skipped, never retried: another environment's group, or a group that already bills a newer subscription", async () => {
    let checked = 0;
    // (1) Stamped with a group this database does not have (the test-mode Stripe account is shared by stg, CI and local).
    {
      const g = await group({ status: "active" });
      const e = capturedEvent("invoice.payment_succeeded.new_paid_monthly", {
        stripeSubId: `sub_blm_elsewhere_${randomUUID().slice(0, 8)}`,
        anchor: (o) => o.created,
        at: nowSeconds(),
        edit: (o) => {
          freshInvoiceId(o);
          (o.parent as { subscription_details: { metadata: Record<string, string> } }).subscription_details.metadata = { subscription_id: randomUUID() };
        },
      });
      await expect(processStripeEvent(e)).resolves.toBeUndefined();
      expect(await kinds(g.groupId)).toEqual([]);
      checked++;
    }
    // (2) A late invoice for a subscription this group has since REPLACED: it bills a newer, live one.
    {
      const g = await group({ status: "active" });
      const e = capturedEvent("invoice.payment_succeeded.new_paid_monthly", {
        stripeSubId: g.stripeSubId,
        anchor: (o) => o.created,
        at: nowSeconds(),
        edit: (o) => {
          freshInvoiceId(o);
          (o.parent as { subscription_details: { metadata: Record<string, string> } }).subscription_details.metadata = { subscription_id: g.groupId };
        },
      });
      await sql`update subscriptions set stripe_subscription_id = ${`sub_blm_new_${randomUUID().slice(0, 8)}`} where id = ${g.groupId}`;
      await expect(processStripeEvent(e)).resolves.toBeUndefined();
      expect(await kinds(g.groupId)).toEqual([]);
      checked++;
    }
    // (3) A stamp that is not a group id at all (metadata is free text): skipped, not a database error.
    {
      const g = await group({ status: "active" });
      const e = capturedEvent("invoice.payment_succeeded.new_paid_monthly", {
        stripeSubId: `sub_blm_elsewhere_${randomUUID().slice(0, 8)}`,
        anchor: (o) => o.created,
        at: nowSeconds(),
        edit: (o) => {
          freshInvoiceId(o);
          (o.parent as { subscription_details: { metadata: Record<string, string> } }).subscription_details.metadata = { subscription_id: "grp-legacy-7" };
        },
      });
      await expect(processStripeEvent(e)).resolves.toBeUndefined();
      expect(await kinds(g.groupId)).toEqual([]);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a RE-BUY's invoice that lands before its link waits, though the group still stores its old, dead subscription (review round 2 m-a)", async () => {
    // A departed customer comes back: the group keeps the cancelled subscription's id and status until customer.subscription.created
    // writes the new one. Storing an id is not billing a live subscription — this invoice is the group's, so it is refused and retried.
    const g = await group({ status: "active" });
    const dead = `sub_blm_dead_${randomUUID().slice(0, 8)}`;
    await sql`update subscriptions set stripe_subscription_id = ${dead}, status = 'canceled', plan_key = 'community' where id = ${g.groupId}`;
    const stamped = { org_id: g.orgId, subscription_id: g.groupId };
    const e = capturedEvent("invoice.payment_succeeded.new_paid_monthly", {
      stripeSubId: g.stripeSubId,
      anchor: (o) => o.created,
      at: nowSeconds(),
      edit: (o) => {
        freshInvoiceId(o);
        (o.parent as { subscription_details: { metadata: Record<string, string> } }).subscription_details.metadata = stamped;
      },
    });
    await expect(processStripeEvent(e)).rejects.toThrow(BillingGroupNotLinkedError);
    expect(await kinds(g.groupId)).toEqual([]);
    // Positive pair: once the new subscription is linked, the same invoice activates.
    await sql`update subscriptions set stripe_subscription_id = ${g.stripeSubId}, status = 'active', plan_key = 'pro' where id = ${g.groupId}`;
    await processStripeEvent(e);
    expect(await kinds(g.groupId)).toEqual(["plan_activated"]);
  });

  it("a payment that lands after the subscription was cancelled outright neither revives the group nor mails it (review round 2 m-b)", async () => {
    // Cancel NOW inside the retry window: Stripe deletes the subscription, then a retry it had already started succeeds. The group
    // stays cancelled (a revived 'active' would block the payer's next checkout) and is told nothing about a plan it no longer has.
    vi.stubEnv("BILLING_RENEWAL_RECEIPT_EMAILS", "1");
    let checked = 0;
    for (const name of ["invoice.payment_succeeded.new_paid_monthly", "invoice.payment_succeeded.annual_renewal"] as const) {
      const g = await group({ status: "past_due" });
      await processStripeEvent(capturedEvent("subscription.deleted.paid_canceled_now", { stripeSubId: g.stripeSubId, anchor: (o) => o.ended_at, at: nowSeconds() }));
      const status = async () => (await sql<{ status: string }[]>`select status from subscriptions where id = ${g.groupId}`)[0]!.status;
      expect(await status(), `${name}: premise, the real delete cancelled the group`).toBe("canceled");
      await processStripeEvent(capturedEvent(name, { stripeSubId: g.stripeSubId, anchor: (o) => o.created, at: nowSeconds(), edit: freshInvoiceId }));
      expect(await status(), `${name}: still cancelled`).toBe("canceled");
      expect(await kinds(g.groupId), `${name}: no activation, no receipt`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("an invoice that belongs to no subscription (a one-off, like an Event Pass) mails nothing", async () => {
    const g = await group({ status: "active" });
    const e = capturedEvent("invoice.payment_succeeded.new_paid_monthly", {
      stripeSubId: g.stripeSubId,
      anchor: (o) => o.created,
      at: nowSeconds(),
      edit: (o) => {
        freshInvoiceId(o);
        delete o.parent;
      },
    });
    await processStripeEvent(e);
    expect(await kinds(g.groupId)).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("renewal_failed: invoice.payment_failed", () => {
  it("a declined renewal: the dunning notice, the retry date from the payload and the 14-day grace from the first failure", async () => {
    const g = await group({ status: "active", ownerLocale: "nl" });
    const e = capturedEvent("invoice.payment_failed.monthly_renewal", { stripeSubId: g.stripeSubId, anchor: (o) => o.created, at: nowSeconds(), edit: freshInvoiceId });
    expect(obj(e).attempt_count, "premise (sandbox): the first attempt").toBe(1);
    await processStripeEvent(e);
    const rows = await groupMail(g.groupId);
    expect(rows.map((r) => r.kind)).toEqual(["renewal_failed"]);
    expect(rows[0]).toMatchObject({ dedupe_key: obj(e).id, transactional: true });
    expect(rows[0]!.subject).toBe(dictionarySubject("nl", "renewalFailed.subject", { planName: PRO }));
    const [m] = await sql<{ status: string; status_changed_at: Date }[]>`select status, status_changed_at from subscriptions where id = ${g.groupId}`;
    expect(m!.status).toBe("past_due");
    // The grace the brief and the resolver give: fourteen days from the first failure.
    const graceEnd = Math.floor(m!.status_changed_at.getTime() / 1000) + 14 * DAY;
    const text = await body(rows[0]!.id);
    // The countdown sentence itself, from the dictionary in the payer's language with the plural category the language's rule picks
    // (review m-1: a bare "14" was satisfied by the amount, "US$ 14,99").
    const graceKey = `renewalFailed.grace.${new Intl.PluralRules("nl").select(14)}`;
    expect(text).toContain(dictionarySubject("nl", graceKey, { planName: PRO, count: "14", date: day(graceEnd, "nl") }));
    expect(text).toContain(day(obj(e).next_payment_attempt, "nl"));
    expect(text).toContain(formatMoneyExact(obj(e).amount_due, obj(e).currency, "nl"));
  });

  it("ONE notice per invoice: Stripe's retry of the same invoice (a new event, attempt 2) queues nothing and does not re-arm the grace", async () => {
    const g = await group({ status: "active" });
    const first = capturedEvent("invoice.payment_failed.monthly_renewal", { stripeSubId: g.stripeSubId, anchor: (o) => o.created, at: nowSeconds(), edit: freshInvoiceId });
    await processStripeEvent(first);
    const [before] = await sql<{ status_changed_at: Date }[]>`select status_changed_at from subscriptions where id = ${g.groupId}`;
    const retry = {
      ...first,
      id: `evt_blm_${randomUUID().slice(0, 12)}`,
      data: { object: { ...obj(first), attempt_count: 2, next_payment_attempt: obj(first).next_payment_attempt + 3 * DAY } },
    } as unknown as Stripe.Event;
    await processStripeEvent(retry);
    expect(await kinds(g.groupId)).toEqual(["renewal_failed"]);
    const [after] = await sql<{ status_changed_at: Date }[]>`select status_changed_at from subscriptions where id = ${g.groupId}`;
    expect(after!.status_changed_at).toEqual(before!.status_changed_at);
  });

  it("a declined FIRST checkout (subscription_create) is not a renewal: no notice", async () => {
    const g = await group({ status: "active" });
    await processStripeEvent(
      capturedEvent("invoice.payment_failed.monthly_renewal", {
        stripeSubId: g.stripeSubId,
        anchor: (o) => o.created,
        at: nowSeconds(),
        edit: (o) => {
          freshInvoiceId(o);
          o.billing_reason = "subscription_create";
        },
      }),
    );
    expect(await kinds(g.groupId)).toEqual([]);
    const [m] = await sql<{ status: string }[]>`select status from subscriptions where id = ${g.groupId}`;
    expect(m!.status, "positive pair: the handler ran").toBe("past_due");
  });

  it("a failed invoice that asked for nothing (amount_due 0, e.g. covered by a credit balance) is no dunning notice", async () => {
    const g = await group({ status: "active" });
    await processStripeEvent(
      capturedEvent("invoice.payment_failed.monthly_renewal", {
        stripeSubId: g.stripeSubId,
        anchor: (o) => o.created,
        at: nowSeconds(),
        edit: (o) => {
          freshInvoiceId(o);
          o.amount_due = 0;
        },
      }),
    );
    expect(await kinds(g.groupId)).toEqual([]);
  });

  it("a renewal with no card left (captured: a counted attempt, no charge) is a failure, not a confirmation: the dunning notice", async () => {
    const g = await group({ status: "active" });
    const e = capturedEvent("invoice.payment_failed.monthly_renewal_no_card", { stripeSubId: g.stripeSubId, anchor: (o) => o.created, at: nowSeconds(), edit: freshInvoiceId });
    expect(obj(e).charge, "premise (sandbox): nothing was charged, there was no card").toBeUndefined();
    await processStripeEvent(e);
    expect(await kinds(g.groupId)).toEqual(["renewal_failed"]);
  });

  it("the payment_failed Stripe sends beside a confirmation request is no dunning notice: the card was not declined (the mirror still moves)", async () => {
    const g = await group({ status: "active" });
    await processStripeEvent(
      capturedEvent("invoice.payment_failed.monthly_renewal_needs_confirmation", { stripeSubId: g.stripeSubId, anchor: (o) => o.created, at: nowSeconds(), edit: freshInvoiceId }),
    );
    expect(await kinds(g.groupId)).toEqual([]);
    const [m] = await sql<{ status: string }[]>`select status from subscriptions where id = ${g.groupId}`;
    expect(m!.status, "positive pair: the handler ran and started the grace").toBe("past_due");
  });

  it("the grace already over (the group went past_due 20 days ago on another invoice): the lapsed sentence, no countdown", async () => {
    const g = await group({ status: "past_due", statusChangedAt: new Date(Date.now() - 20 * DAY * 1000) });
    const e = capturedEvent("invoice.payment_failed.monthly_renewal", { stripeSubId: g.stripeSubId, anchor: (o) => o.created, at: nowSeconds(), edit: freshInvoiceId });
    await processStripeEvent(e);
    const [r] = await groupMail(g.groupId);
    const text = await body(r!.id);
    const lapsed = dictionarySubject("en", "renewalFailed.lapsed", { planName: PRO });
    expect(text).toContain(lapsed);
  });
});

describe.skipIf(!HAS_DB)("renewal_action_required: invoice.payment_action_required", () => {
  const askedOf = (stripeSubId: string, edit: (o: Record<string, unknown>) => void = freshInvoiceId, name: CapturedEventName = "invoice.payment_action_required.monthly_renewal") =>
    capturedEvent(name, { stripeSubId, anchor: (o) => o.created, at: nowSeconds(), edit });
  const mirror = async (groupId: string) =>
    (await sql<{ status: string; status_changed_at: Date | null }[]>`select status, status_changed_at from subscriptions where id = ${groupId}`)[0]!;
  const sameInvoice = (id: string) => (o: Record<string, unknown>) => {
    o.id = id;
  };
  const invoiceId = () => `in_blm_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

  it("a renewal already in dunning: the request to confirm, in the payer's language, its button Stripe's confirm page, the grace the dunning notice gives", async () => {
    // Past due for two days (an earlier failure): the resolver's grace is fourteen days from that move, so twelve are left.
    const since = new Date(Date.now() - 2 * DAY * 1000);
    const g = await group({ status: "past_due", statusChangedAt: since, ownerLocale: "es" });
    const e = askedOf(g.stripeSubId);
    await processStripeEvent(e);
    const rows = await groupMail(g.groupId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "renewal_action_required",
      status: "queued",
      ref_type: "subscription",
      ref_id: g.groupId,
      org_id: null,
      recipient: g.ownerEmail.toLowerCase(),
      recipient_user_id: g.ownerId,
      transactional: true,
      dedupe_key: obj(e).id,
    });
    expect(rows[0]!.subject).toBe(dictionarySubject("es", "renewalActionRequired.subject", { planName: PRO }));
    const text = await body(rows[0]!.id);
    expect(text).toContain(`${dictionarySubject("es", "renewalActionRequired.cta", {})}: ${obj(e).hosted_invoice_url}`);
    expect(text).toContain(formatMoneyExact(obj(e).amount_due, obj(e).currency, "es"));
    expect(text).toContain(`/o/${g.slug}/settings/billing`);
    const graceEnd = Math.floor(since.getTime() / 1000) + 14 * DAY;
    const graceKey = `renewalActionRequired.grace.${new Intl.PluralRules("es").select(12)}`;
    expect(text).toContain(dictionarySubject("es", graceKey, { planName: PRO, count: "12", date: day(graceEnd, "es") }));
    // Mail only: the mirror is the payment_failed's to move.
    const after = await mirror(g.groupId);
    expect(after.status).toBe("past_due");
    expect(after.status_changed_at).toEqual(since);
  });

  it("the request lands BEFORE the payment_failed beside it: the grace starts now (the resolver's fourteen days), and the mirror is not moved", async () => {
    // Active since forty days ago: that move starts no grace (only a move to past_due does), so the countdown is a full fourteen.
    const g = await group({ status: "active", statusChangedAt: new Date(Date.now() - 40 * DAY * 1000) });
    const before = nowSeconds();
    await processStripeEvent(askedOf(g.stripeSubId));
    const after = nowSeconds();
    const [r] = await groupMail(g.groupId);
    expect(r?.kind).toBe("renewal_action_required");
    const text = await body(r!.id);
    const graceKey = `renewalActionRequired.grace.${new Intl.PluralRules("en").select(14)}`;
    const sentences = [before, after].map((t) => dictionarySubject("en", graceKey, { planName: PRO, count: "14", date: day(t + 14 * DAY, "en") }));
    expect(sentences.some((sentence) => text.includes(sentence)), `one of: ${sentences.join(" | ")}`).toBe(true);
    expect((await mirror(g.groupId)).status, "mail only: the request moves nothing").toBe("active");
  });

  it("ONE request per invoice: a redelivery, and Stripe asking again for the same invoice (a new event), queue nothing more", async () => {
    const g = await group({ status: "active" });
    const e = askedOf(g.stripeSubId);
    await processStripeEvent(e);
    await processStripeEvent(e);
    await processStripeEvent({ ...e, id: `evt_blm_${randomUUID().slice(0, 12)}` } as Stripe.Event);
    expect(await kinds(g.groupId)).toEqual(["renewal_action_required"]);
    // Positive pair: another invoice of the same group is another request.
    await processStripeEvent(askedOf(g.stripeSubId));
    expect(await kinds(g.groupId)).toEqual(["renewal_action_required", "renewal_action_required"]);
  });

  it("a first checkout (subscription_create, captured) is confirmed in the browser as it happens: no mail", async () => {
    const g = await group({ status: "active" });
    const e = askedOf(g.stripeSubId, freshInvoiceId, "invoice.payment_action_required.new_paid_monthly");
    expect(obj(e).billing_reason, "premise (sandbox)").toBe("subscription_create");
    expect(obj(e).hosted_invoice_url, "premise: it does carry a page, so only the renewal guard refuses it").toBeTruthy();
    await processStripeEvent(e);
    expect(await kinds(g.groupId)).toEqual([]);
  });

  it("no Stripe-hosted page to confirm on (null, or absent): no mail", async () => {
    let checked = 0;
    for (const strip of [
      (o: Record<string, unknown>) => {
        o.hosted_invoice_url = null;
      },
      (o: Record<string, unknown>) => {
        delete o.hosted_invoice_url;
      },
    ]) {
      const g = await group({ status: "active" });
      await processStripeEvent(
        askedOf(g.stripeSubId, (o) => {
          freshInvoiceId(o);
          strip(o);
        }),
      );
      expect(await kinds(g.groupId)).toEqual([]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("an invoice of a subscription no group bills through mails nobody, and the webhook completes", async () => {
    const g = await group({ status: "active" });
    await expect(processStripeEvent(askedOf(`sub_blm_none_${randomUUID().slice(0, 8)}`))).resolves.toBeUndefined();
    expect(await kinds(g.groupId)).toEqual([]);
    // Positive pair: the same payload pointed at the group mails it.
    await processStripeEvent(askedOf(g.stripeSubId));
    expect(await kinds(g.groupId)).toEqual(["renewal_action_required"]);
  });

  it("a payer who deleted their account is mailed nothing; the warning names the kind it skipped", async () => {
    const warn = vi.spyOn(log, "warn");
    try {
      const g = await group({ status: "active" });
      await sql`update users set deleted_at = now() where id = ${g.ownerId}`;
      await processStripeEvent(askedOf(g.stripeSubId));
      expect(await kinds(g.groupId)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "renewal_action_required", groupId: g.groupId }),
        expect.stringContaining("no reachable payer"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("the bank asks: Stripe sends payment_failed beside the request for the same invoice — ONE mail, the request, in either order; the grace still starts", async () => {
    let checked = 0;
    for (const order of ["request first", "failure first"] as const) {
      const g = await group({ status: "active" });
      const id = invoiceId();
      const asked = askedOf(g.stripeSubId, sameInvoice(id));
      const failed = capturedEvent("invoice.payment_failed.monthly_renewal_needs_confirmation", {
        stripeSubId: g.stripeSubId,
        anchor: (o) => o.created,
        at: nowSeconds(),
        edit: sameInvoice(id),
      });
      for (const e of order === "request first" ? [asked, failed] : [failed, asked]) await processStripeEvent(e);
      expect(await kinds(g.groupId), order).toEqual(["renewal_action_required"]);
      expect((await mirror(g.groupId)).status, `${order}: positive pair, the failure moved the mirror`).toBe("past_due");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a declined renewal, then Stripe's retry of the SAME invoice needs confirming: both mails (different kinds), each once, even redelivered", async () => {
    const g = await group({ status: "active" });
    const id = invoiceId();
    const declined = capturedEvent("invoice.payment_failed.monthly_renewal", { stripeSubId: g.stripeSubId, anchor: (o) => o.created, at: nowSeconds(), edit: sameInvoice(id) });
    const asked = askedOf(g.stripeSubId, sameInvoice(id));
    for (const e of [declined, asked, declined, asked]) await processStripeEvent(e);
    expect(await kinds(g.groupId)).toEqual(["renewal_failed", "renewal_action_required"]);
    expect((await groupMail(g.groupId)).map((r) => r.dedupe_key), "one invoice, two kinds").toEqual([id, id]);
  });
});

describe.skipIf(!HAS_DB)("renewal_upcoming: invoice.upcoming", () => {
  it("an annual renewal: the notice, keyed by subscription and renewal instant (the payload has no invoice id)", async () => {
    const g = await group({ status: "active", hasPaymentMethod: true, ownerLocale: "fr" });
    const renewal = nowSeconds() + 3 * DAY;
    const e = capturedEvent("invoice.upcoming.annual_renewal", { stripeSubId: g.stripeSubId, anchor: (o) => o.period_end, at: renewal });
    const lineStart = obj(e).lines.data[0].period.start;
    expect(lineStart, "premise (sandbox): the renewed period starts at the invoice's period_end").toBe(obj(e).period_end);
    await processStripeEvent(e);
    const rows = await groupMail(g.groupId);
    expect(rows.map((r) => r.kind)).toEqual(["renewal_upcoming"]);
    expect(rows[0]!.dedupe_key).toBe(`${g.stripeSubId}:${lineStart}`);
    expect(rows[0]!.subject).toBe(dictionarySubject("fr", "renewalUpcoming.subject", { planName: PRO, date: day(lineStart, "fr") }));
    expect(await body(rows[0]!.id)).toContain(formatMoneyExact(obj(e).amount_due, obj(e).currency, "fr"));
  });

  it("'nothing to do' only with a card on file; without one, the notice asks for a payment method before the renewal (review m-3)", async () => {
    let checked = 0;
    for (const hasPaymentMethod of [true, false]) {
      const g = await group({ status: "active", hasPaymentMethod });
      const e = capturedEvent("invoice.upcoming.annual_renewal", { stripeSubId: g.stripeSubId, anchor: (o) => o.period_end, at: nowSeconds() + 3 * DAY });
      await processStripeEvent(e);
      const [r] = await groupMail(g.groupId);
      const vars = { planName: PRO, date: day(obj(e).lines.data[0].period.start, "en"), amount: formatMoneyExact(obj(e).amount_due, obj(e).currency, "en") };
      const text = await body(r!.id);
      const [said, notSaid] = hasPaymentMethod ? ["renewalUpcoming.body", "renewalUpcoming.bodyNoCard"] : ["renewalUpcoming.bodyNoCard", "renewalUpcoming.body"];
      expect(text, `card=${hasPaymentMethod}`).toContain(dictionarySubject("en", said, vars));
      expect(text, `card=${hasPaymentMethod}`).not.toContain(dictionarySubject("en", notSaid, vars));
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a second invoice.upcoming for the same renewal (a new event id) queues nothing more", async () => {
    const g = await group({ status: "active" });
    const renewal = nowSeconds() + 3 * DAY;
    const e = capturedEvent("invoice.upcoming.annual_renewal", { stripeSubId: g.stripeSubId, anchor: (o) => o.period_end, at: renewal });
    await processStripeEvent(e);
    await processStripeEvent(capturedEvent("invoice.upcoming.annual_renewal", { stripeSubId: g.stripeSubId, anchor: (o) => o.period_end, at: renewal }));
    expect(await kinds(g.groupId)).toEqual(["renewal_upcoming"]);
  });

  it("nothing for a monthly renewal, a card trial's first charge, a plan set to end, a renewal that charges nothing, or one already past", async () => {
    const renewal = nowSeconds() + 3 * DAY;
    const cases: [CapturedEventName, Parameters<typeof seedBillingGroup>[0], number, ((o: Record<string, unknown>) => void)?][] = [
      ["invoice.upcoming.monthly_renewal", { status: "active" }, renewal],
      ["invoice.upcoming.card_trial_before_conversion", { status: "trialing", hasPaymentMethod: true }, renewal],
      ["invoice.upcoming.annual_renewal", { status: "active", cancelAtPeriodEnd: true }, renewal],
      ["invoice.upcoming.annual_renewal", { status: "active" }, renewal, (o) => { o.amount_due = 0; }],
      // A redelivery (or a staff replay) of a preview whose renewal has already happened.
      ["invoice.upcoming.annual_renewal", { status: "active" }, nowSeconds() - DAY],
    ];
    let checked = 0;
    for (const [name, state, when, edit] of cases) {
      const g = await group(state);
      await processStripeEvent(capturedEvent(name, { stripeSubId: g.stripeSubId, anchor: (o) => o.period_end, at: when, edit }));
      expect(await kinds(g.groupId), `${name} ${JSON.stringify(state)} at ${when}`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("the card trial's upcoming invoice IS annual: only the trialing guard keeps it out", () => {
    const e = capturedEvent("invoice.upcoming.card_trial_before_conversion", { stripeSubId: ANY_SUB, anchor: (o) => o.period_end, at: nowSeconds() });
    expect(annualRenewalLine(inv(e))).not.toBeNull();
    expect(inv(e).amount_due).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("subscription_changed: customer.subscription.updated", () => {
  it("cancel scheduled, then resumed: two confirmations; the resume REPLACES the still-queued cancel (one kind, the replace rule)", async () => {
    // A payer with a card on file: the resume really does mean "your plan will continue".
    const g = await group({ status: "active", hasPaymentMethod: true });
    const cancelAt = nowSeconds() + 10 * DAY;
    const cancel = capturedEvent("subscription.updated.cancel_scheduled", { stripeSubId: g.stripeSubId, anchor: (o) => o.cancel_at, at: cancelAt });
    await processStripeEvent(cancel);
    let rows = await groupMail(g.groupId);
    expect(rows.map((r) => [r.kind, r.status])).toEqual([["subscription_changed", "queued"]]);
    expect(rows[0]!.dedupe_key).toBe(cancel.id);
    expect(rows[0]!.subject).toBe(dictionarySubject("en", "subscriptionChanged.cancelScheduled.subject", { planName: PRO, date: day(cancelAt, "en") }));
    // A redelivery of the cancel queues nothing more.
    await processStripeEvent(cancel);
    expect(await groupMail(g.groupId)).toHaveLength(1);

    const resume = capturedEvent("subscription.updated.resumed", { stripeSubId: g.stripeSubId, anchor: (o) => o.created, at: nowSeconds() });
    await processStripeEvent(resume);
    rows = await groupMail(g.groupId);
    expect(rows.map((r) => [r.kind, r.status])).toEqual([
      ["subscription_changed", "replaced"],
      ["subscription_changed", "queued"],
    ]);
    expect(rows[1]!.subject).toBe(dictionarySubject("en", "subscriptionChanged.resumed.subject", { planName: PRO }));
  });

  it("an interval switch: the annual confirmation with the next billing date from the plan item", async () => {
    // A card-on-file trial: it WILL bill on that date. (A no-card trial gets the trial wording; see below.)
    const g = await group({ status: "trialing", hasPaymentMethod: true });
    const e = capturedEvent("subscription.updated.interval_switch_to_annual", { stripeSubId: g.stripeSubId, anchor: (o) => o.created, at: nowSeconds() });
    await processStripeEvent(e);
    const rows = await groupMail(g.groupId);
    expect(rows.map((r) => r.kind)).toEqual(["subscription_changed"]);
    expect(rows[0]!.subject).toBe(dictionarySubject("en", "subscriptionChanged.annual.subject", { planName: PRO }));
    expect(await body(rows[0]!.id)).toContain(day(obj(e).items.data[0].current_period_end, "en"));
  });

  it("a NO-CARD trial that resumes or switches interval is told its trial continues until its end, never 'your plan will continue' (review m-2)", async () => {
    const trialEnd = nowSeconds() + 9 * DAY;
    const asTrial = (o: Record<string, unknown>) => {
      o.status = "trialing";
      o.trial_end = trialEnd;
    };
    let checked = 0;
    for (const name of ["subscription.updated.resumed", "subscription.updated.interval_switch_to_annual"] as const) {
      const g = await group({ status: "trialing", hasPaymentMethod: false, ownerLocale: "es" });
      await processStripeEvent(capturedEvent(name, { stripeSubId: g.stripeSubId, anchor: (o) => o.created, at: nowSeconds(), edit: asTrial }));
      const rows = await groupMail(g.groupId);
      expect(rows.map((r) => r.kind), name).toEqual(["subscription_changed"]);
      expect(rows[0]!.subject, name).toBe(dictionarySubject("es", "subscriptionChanged.trialContinues.subject", { planName: PRO, date: day(trialEnd, "es") }));
      checked++;
    }
    expect(checked).toBe(2);
    // Positive pair: the same resume with a card on file is the ordinary "will continue" confirmation (the trial converts and bills).
    const g = await group({ status: "trialing", hasPaymentMethod: true });
    await processStripeEvent(capturedEvent("subscription.updated.resumed", { stripeSubId: g.stripeSubId, anchor: (o) => o.created, at: nowSeconds(), edit: asTrial }));
    const [r] = await groupMail(g.groupId);
    expect(r!.subject).toBe(dictionarySubject("en", "subscriptionChanged.resumed.subject", { planName: PRO }));
    // And a PAYING subscription (not trialing) resuming is the ordinary confirmation whatever the card mirror says: it is not a trial.
    const paid = await group({ status: "active", hasPaymentMethod: false });
    await processStripeEvent(
      capturedEvent("subscription.updated.resumed", {
        stripeSubId: paid.stripeSubId,
        anchor: (o) => o.created,
        at: nowSeconds(),
        edit: (o) => {
          o.status = "active";
        },
      }),
    );
    const [p] = await groupMail(paid.groupId);
    expect(p!.subject).toBe(dictionarySubject("en", "subscriptionChanged.resumed.subject", { planName: PRO }));
  });

  it("a renewal and a trial converting confirm nothing", async () => {
    let checked = 0;
    for (const name of ["subscription.updated.annual_renewal", "subscription.updated.trial_converted"] as const) {
      const g = await group({ status: "active" });
      await processStripeEvent(capturedEvent(name, { stripeSubId: g.stripeSubId, anchor: (o) => o.created, at: nowSeconds() }));
      expect(await kinds(g.groupId), name).toEqual([]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("an update for a subscription the group no longer bills through (a replaced one) mails nobody", async () => {
    const g = await group({ status: "active" });
    const e = capturedEvent("subscription.updated.cancel_scheduled", { stripeSubId: g.stripeSubId, anchor: (o) => o.cancel_at, at: nowSeconds() + DAY });
    // The group re-bought: it bills a NEW subscription now, on the same Stripe customer, so the late update for the old one still
    // RESOLVES to this group (by customer) and only the stale-event guard stands between it and a mail.
    await sql`update subscriptions set stripe_subscription_id = ${`sub_blm_new_${randomUUID().slice(0, 8)}`},
                                       stripe_customer_id = ${obj(e).customer} where id = ${g.groupId}`;
    await processStripeEvent(e);
    expect(await kinds(g.groupId)).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("who is mailed", () => {
  it("the payer's account language first, then the default of the org the link points at", async () => {
    const g = await group({ status: "active", ownerLocale: null, orgDefaultLocale: "nl" });
    await processStripeEvent(
      capturedEvent("invoice.payment_succeeded.new_paid_monthly", { stripeSubId: g.stripeSubId, anchor: (o) => o.created, at: nowSeconds(), edit: freshInvoiceId }),
    );
    const [r] = await groupMail(g.groupId);
    expect(r!.subject).toBe(dictionarySubject("nl", "planActivated.subject", { planName: PRO }));
  });

  it("a group whose payer deleted their account mails nobody (and the webhook still completes); the warning names the kind it skipped", async () => {
    vi.stubEnv("BILLING_RENEWAL_RECEIPT_EMAILS", "1");
    const warn = vi.spyOn(log, "warn");
    try {
      let checked = 0;
      for (const [name, kind, trialEnd] of [
        ["invoice.payment_succeeded.new_paid_monthly", "plan_activated", null],
        ["invoice.payment_succeeded.annual_renewal", "renewal_paid", new Date((nowSeconds() - 365 * DAY) * 1000)],
      ] as const) {
        const g = await group({ status: "active", trialEnd });
        await sql`update users set deleted_at = now() where id = ${g.ownerId}`;
        warn.mockClear();
        await processStripeEvent(capturedEvent(name, { stripeSubId: g.stripeSubId, anchor: (o) => o.created, at: nowSeconds(), edit: freshInvoiceId }));
        expect(await kinds(g.groupId), name).toEqual([]);
        expect(warn, name).toHaveBeenCalledWith(expect.objectContaining({ kind, groupId: g.groupId }), expect.stringContaining("no reachable payer"));
        checked++;
      }
      expect(checked).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe.skipIf(!HAS_DB)("sequences a payer lives through", () => {
  it("card trial -> converts (activated) -> annual renewal notice -> renewal paid (receipt) -> next renewal declined: four mails, each once, even replayed whole", async () => {
    vi.stubEnv("BILLING_RENEWAL_RECEIPT_EMAILS", "1");
    // One captured timeline (the sandbox's card trial B), moved by ONE shift so its events keep Stripe's own relations: the conversion
    // invoice's period starts exactly at the trial_end the subscription events carry. The trial ended 360 days ago.
    const capturedTrialEnd = capturedValue("invoice.payment_succeeded.trial_conversion_annual", (o: Obj) => o.lines.data[0].period.start as number);
    const shift = nowSeconds() - 360 * DAY - capturedTrialEnd;
    const trialEnd = new Date((capturedTrialEnd + shift) * 1000);
    const g = await group({ status: "trialing", hasPaymentMethod: true, trialEnd });
    const s = g.stripeSubId;
    const events: Stripe.Event[] = [
      // Before the trial ends Stripe previews the conversion: the trial warning's to announce, not this one's.
      capturedEvent("invoice.upcoming.card_trial_before_conversion", { stripeSubId: s, shift }),
      // The conversion: the real update moves our mirror to active (handleSubscriptionChanged), and confirms nothing.
      capturedEvent("subscription.updated.trial_converted", { stripeSubId: s, shift }),
      capturedEvent("invoice.payment_succeeded.trial_conversion_annual", { stripeSubId: s, shift, edit: freshInvoiceId }),
      capturedEvent("invoice.upcoming.annual_renewal", { stripeSubId: s, shift }),
      capturedEvent("subscription.updated.annual_renewal", { stripeSubId: s, shift }),
      capturedEvent("invoice.payment_succeeded.annual_renewal", { stripeSubId: s, shift, edit: freshInvoiceId }),
      // A later renewal declined (the sandbox's declined renewal, put after the annual one).
      capturedEvent("invoice.payment_failed.monthly_renewal", { stripeSubId: s, anchor: (o) => o.created, at: nowSeconds() + 7 * DAY, edit: freshInvoiceId }),
    ];
    for (const e of events) await processStripeEvent(e);
    const expected = ["plan_activated", "renewal_upcoming", "renewal_paid", "renewal_failed"];
    expect(await kinds(g.groupId)).toEqual(expected);
    for (const e of events) await processStripeEvent(e);
    expect(await kinds(g.groupId), "the whole sequence replayed: not one more row").toEqual(expected);
  });

  it("no-card trial: the trial warning, then the trial runs out: two mails, the warning and the end", async () => {
    const trialEnd = nowSeconds() - 60;
    const g = await group({ status: "trialing", trialEnd: new Date(trialEnd * 1000) });
    await processStripeEvent({
      id: `evt_blm_${randomUUID().slice(0, 12)}`,
      type: "customer.subscription.trial_will_end",
      data: { object: { id: g.stripeSubId, object: "subscription", status: "trialing", trial_end: trialEnd, metadata: {} } },
    } as unknown as Stripe.Event);
    await processStripeEvent(capturedEvent("subscription.deleted.trial_ran_out_no_card", { stripeSubId: g.stripeSubId, anchor: (o) => o.trial_end, at: trialEnd }));
    expect(await kinds(g.groupId)).toEqual(["trial_ending", "trial_expired"]);
  });

  it("no-card trial cancelled by the payer: the cancel confirmation, then the deletion at trial end mails nothing more", async () => {
    const trialEnd = nowSeconds() - 60;
    const g = await group({ status: "trialing", trialEnd: new Date(trialEnd * 1000) });
    await processStripeEvent(capturedEvent("subscription.updated.cancel_scheduled", { stripeSubId: g.stripeSubId, anchor: (o) => o.cancel_at, at: trialEnd }));
    await processStripeEvent(
      capturedEvent("subscription.deleted.trial_cancel_scheduled_no_card", { stripeSubId: g.stripeSubId, anchor: (o) => o.trial_end, at: trialEnd }),
    );
    expect(await kinds(g.groupId)).toEqual(["subscription_changed"]);
    // A cancel stays a cancel during a no-card trial (only a resume or an interval switch becomes "your trial continues").
    const [r] = await groupMail(g.groupId);
    expect(r!.subject).toBe(dictionarySubject("en", "subscriptionChanged.cancelScheduled.subject", { planName: PRO, date: day(trialEnd, "en") }));
  });
});
