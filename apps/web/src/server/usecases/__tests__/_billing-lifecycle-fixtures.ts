// Billing lifecycle mails (2026-11-15): REAL Stripe event payloads, and a billing group to point them at.
//
// fixtures/stripe-billing-lifecycle-events.json holds events captured from a Stripe SANDBOX with test clocks (a no-card trial running
// out, a card trial converting and renewing a year later, a monthly renewal declined, cancels scheduled and resumed, an interval switch):
// what Stripe actually sends, with null and empty fields pruned. A test takes one, points it at its own seeded group (every occurrence of
// the captured subscription id is replaced) and REBASES it in time: every unix timestamp in the payload moves by one offset, chosen so
// that one anchor field lands where the test needs it. The relations inside the payload — a line period starting exactly at
// `trial_end`, a retry an hour after the renewal, a year between period start and end — are therefore Stripe's own, and a test reads
// its expected values off the rebased event, never off the code under test.
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import type { Locale } from "@/lib/i18n-constants";
import { seedTrialingGroup } from "./_money-fixtures";
import captured from "./fixtures/stripe-billing-lifecycle-events.json";

type Captured = { id: string; type: string; created: number; livemode: boolean; data: { object: Record<string, unknown>; previous_attributes?: Record<string, unknown> } };
const CAPTURED = captured.events as unknown as Record<string, Captured>;

/** The captured events, by name: `<object>.<event>.<situation>`. */
export type CapturedEventName = keyof typeof captured.events;

/** Every captured name, for a test that sweeps them all (anti-vacuity: the count is pinned where it is used). */
export const CAPTURED_EVENT_NAMES = Object.keys(CAPTURED) as CapturedEventName[];

/** A unix timestamp in the captured payloads: anything in 2020-2039 (amounts and counts are far below). */
const isTimestamp = (n: number): boolean => Number.isInteger(n) && n > 1_577_836_800 && n < 2_208_988_800;

function rewrite(x: unknown, from: string, to: string, shift: number): unknown {
  if (typeof x === "string") return x === from ? to : x;
  if (typeof x === "number") return isTimestamp(x) ? x + shift : x;
  if (Array.isArray(x)) return x.map((v) => rewrite(v, from, to, shift));
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, rewrite(v, from, to, shift)]));
  return x;
}

/** The captured subscription id an event is about (the object's own id for a subscription, the parent's for an invoice). */
function capturedSubId(e: Captured): string {
  const o = e.data.object as { object?: string; id?: string; parent?: { subscription_details?: { subscription?: string } } };
  const id = o.object === "subscription" ? o.id : o.parent?.subscription_details?.subscription;
  if (!id) throw new Error(`captured event ${e.id} names no subscription`);
  return id;
}

/** A value read off a captured event AS CAPTURED (before any rebase): for a test that rebases several events of one timeline by one shift. */
export function capturedValue<T>(name: CapturedEventName, read: (object: Record<string, never>) => T): T {
  const e = CAPTURED[name];
  if (!e) throw new Error(`no captured event ${name}`);
  return read(e.data.object as Record<string, never>);
}

/**
 * A captured event, pointed at `stripeSubId`, with a fresh event id (so the outbox once-key is this test's own), rebased in time: either
 * so that `anchor(object)` lands on `at` (unix seconds), or by an explicit `shift` (seconds) when several events of one captured timeline
 * must keep their relations to each other. `edit` may then change the object — named in the test, so a constructed case reads as one.
 */
export function capturedEvent(
  name: CapturedEventName,
  o: { stripeSubId: string; eventId?: string; edit?: (object: Record<string, unknown>) => void } & (
    | { anchor: (object: Record<string, never>) => number; at: number }
    | { shift: number }
  ),
): Stripe.Event {
  const e = CAPTURED[name];
  if (!e) throw new Error(`no captured event ${name}`);
  const shift = "shift" in o ? o.shift : o.at - o.anchor(e.data.object as Record<string, never>);
  const rebased = rewrite(e, capturedSubId(e), o.stripeSubId, shift) as Captured;
  rebased.id = o.eventId ?? `evt_blm_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  o.edit?.(rebased.data.object);
  return rebased as unknown as Stripe.Event;
}

/** Give a captured invoice a fresh id (its once-key) — an invoice id is unique to the test that uses it. */
export const freshInvoiceId = (object: Record<string, unknown>): void => {
  object.id = `in_blm_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
};

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * A billing group in a given mirror state: a payer (account language `ownerLocale`), one org they created (default `orgDefaultLocale`),
 * a Stripe subscription id. Built on `seedTrialingGroup`, then moved to the state asked for.
 */
export async function seedBillingGroup(o: {
  status: "trialing" | "active" | "past_due";
  hasPaymentMethod?: boolean;
  trialEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  statusChangedAt?: Date | null;
  ownerLocale?: string | null;
  orgDefaultLocale?: Locale;
  prefix?: string;
}): Promise<{ groupId: string; stripeSubId: string; ownerId: string; ownerEmail: string; slug: string; orgId: string }> {
  const g = await seedTrialingGroup({
    hasPaymentMethod: o.hasPaymentMethod ?? false,
    ownerLocale: o.ownerLocale,
    orgDefaultLocale: o.orgDefaultLocale,
    prefix: o.prefix ?? "blm",
  });
  await sql`
    update subscriptions
       set status = ${o.status},
           trial_end = ${o.trialEnd ?? null},
           cancel_at_period_end = ${o.cancelAtPeriodEnd ?? false},
           status_changed_at = ${o.statusChangedAt ?? null}
     where id = ${g.groupId}`;
  return g;
}

export type OutboxRow = {
  id: string;
  kind: string;
  status: string;
  ref_type: string;
  ref_id: string;
  org_id: string | null;
  recipient: string;
  recipient_user_id: string | null;
  subject: string;
  transactional: boolean;
  dedupe_key: string | null;
};

/** Every outbox row about this group, oldest first. */
export const groupMail = (groupId: string) =>
  sql<OutboxRow[]>`
    select id, kind, status, ref_type, ref_id, org_id, recipient, recipient_user_id, subject, transactional, dedupe_key
      from email_outbox where ref_type = 'subscription' and ref_id = ${groupId}
     order by created_at, id`;
