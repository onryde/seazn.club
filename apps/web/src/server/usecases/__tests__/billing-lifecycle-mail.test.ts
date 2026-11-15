// Billing lifecycle mails (2026-11-15): which Stripe event queues which mail, to whom, once.
//
// Every DB case is driven through the REAL webhook dispatch (`processStripeEvent`, the table the signed webhook and the staff replay
// share) with a REAL Stripe payload: events captured from a Stripe sandbox with test clocks (_billing-lifecycle-fixtures.ts), pointed at
// a seeded billing group and rebased in time. Expected values — dates, amounts, the once-key — are read off the rebased event, never
// off the code under test; subjects come from the dictionary on disk in the payer's language.
//
// What the sandbox settled (report-1.md): `cancellation_details.reason` reads `cancellation_requested` on EVERY deletion, the untouched
// trial included; the charge that ends a card trial is `subscription_cycle`, like a renewal, its line period starting at `trial_end`;
// an `invoice.upcoming` payload has no `id`, and Stripe sends one before a card trial's first charge too.
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
import { processStripeEvent, runEvent } from "../billing-events";
import {
  BillingGroupNotLinkedError,
  annualRenewalLine,
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
  it("are the nineteen events the suite reads, and an invoice.upcoming carries no invoice id (the coordinator's premise, measured)", () => {
    expect(CAPTURED_EVENT_NAMES, "anti-vacuity: the fixture file is not empty").toHaveLength(19);
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
    // Killer of the ended-EXACTLY-at-trial_end guard (review m-5): a trial that converted and was paid for, then cancelled outright a
    // month later, while our mirror still says trialing (its conversion update stuck). A trial that runs out ends AT trial_end — the
    // sandbox's D has ended_at == trial_end == canceled_at — so anything later is not one.
    [
      "a converted trial cancelled a month after its end while the mirror still says trialing",
      at("subscription.deleted.trial_ran_out_no_card", (o) => o.trial_end, now, (o) => {
        o.ended_at = (o.trial_end as number) + 30 * DAY;
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
  it("judged nine cases, one of them positive; the sandbox's own run-out ends exactly at trial_end", () => {
    const d = at("subscription.deleted.trial_ran_out_no_card", (o) => o.trial_end, now);
    expect(obj(d).ended_at, "premise (sandbox D): a trial that runs out ends at trial_end").toBe(obj(d).trial_end);
    expect(cases).toHaveLength(9);
    expect(cases.filter((c) => c[3])).toHaveLength(1);
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
