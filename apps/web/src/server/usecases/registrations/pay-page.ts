import "server-only";
// The player payment page's document (plan 2026-11-11-player-payment-page, Task 2; see ./index.ts): what `/r/pay/<token>` shows
// for one entry. A chase mail links the page; the entry's state at VIEW time - not the token, not the state when the mail went out -
// decides what it shows (an organiser who switches the division to offline, marks it paid or waives it after the mail is reflected
// the next time the page is opened).
import { sql } from "@/lib/db";
import { ownPaymentRefundedCents } from "@/lib/registration-status";
import type { Locale } from "@/lib/i18n-constants";
import { fillPaymentInstructions } from "@/lib/payment-instructions";
import { resolveVenueTz } from "@/lib/tz";
import { recipientLocale } from "@/server/email-outbox/locale";
import type { RegistrationRow, RegistrationWithGroupRow } from "./types";
import { regGroupCols, loadSettings, divisionCtx } from "./lookups";
import { registrationLineItems } from "./checkout";
import { registrationIdByPayToken } from "./pay-token";

export const PAY_PAGE_STATES = ["pay", "offline", "paid", "refunded", "deadline_passed", "waitlisted"] as const;
export type PayPageState = (typeof PAY_PAGE_STATES)[number];

export interface PayPageDoc {
  registrationId: string;
  groupId: string;
  orgId: string;
  /** The language the chase mail was written in (`recipientLocale`: the cart's pick, the linked account, the org default). */
  locale: Locale;
  state: PayPageState;
  competitionName: string;
  divisionName: string;
  startsOn: string | null;
  endsOn: string | null;
  entrantName: string;
  /** Roster display names in roster order; empty for an individual entry. */
  members: string[];
  currency: string;
  /** What Checkout charges for this entry (`registrationLineItems`), never `amount_cents` read on its own. */
  lines: { label: string; amountCents: number }[];
  totalCents: number;
  refundedCents: number;
  /** `promotion_expires_at ?? expires_at`: a promoted entry has its own window. */
  deadline: Date | null;
  /** The organiser's own zone (`organizations.timezone`, UTC when unset): the deadline is written in it, the same zone and spelling
   *  the status page writes it in (polish wave P3, W4). Always a valid IANA zone, never null. */
  timezone: string;
  refCode: string | null;
  orgName: string;
  /** Offline only: the division's instructions, else the org's, with `{{reference}}` filled. */
  paymentInstructions: string | null;
  /** Paid/refunded only: the first confirming audit row's time, or null when there is none. */
  paidAt: Date | null;
  paySessionId: string | null;
  /** Whether the organiser can take a card payment right now (`organizations.stripe_charges_enabled`, read at view time). Gap wave
   *  G4: a `pay` entry with this false shows a notice in place of the Pay button; the state stays `pay` (the entry still owes the
   *  money) and the Pay route keeps its 503 as the backstop. */
  cardPaymentsOn: boolean;
}

/** The facts the rule table decides on. */
export interface PayPageFacts {
  status: RegistrationRow["status"];
  refundedCents: number;
  deadline: Date | null;
  /** The division's method, falling back to the cart's (same resolution as `resumeRegistrationCheckout`). */
  method: "stripe" | "offline" | null;
}

const isPaidStatus = (s: PayPageFacts["status"]) => s === "paid" || s === "confirmed";

/** The page's states, FIRST MATCH WINS. `null` closes the page (one opaque not-found, the same as an unknown token). */
const PAY_PAGE_RULES: readonly { readonly result: PayPageState | null; readonly when: (f: PayPageFacts, now: Date) => boolean }[] = [
  // 1. withdrawn / rejected → closed (owner 2026-11-11: rejected is the same as withdrawn).
  { result: null, when: (f) => f.status === "withdrawn" || f.status === "rejected" },
  // 2.
  { result: "waitlisted", when: (f) => f.status === "waitlisted" },
  // 3. Paid outranks every deadline: a paid entry whose window has since passed is still paid. Held twice - by this order and by
  //    rule 4 being gated on pending/expired - so a rule 4 widened to "any passed deadline" is still answered here.
  { result: "refunded", when: (f) => isPaidStatus(f.status) && f.refundedCents > 0 },
  { result: "paid", when: (f) => isPaidStatus(f.status) },
  // 4. The hourly sweep may not have expired the row yet (Review Focus 2): a passed deadline closes it at view time.
  {
    result: "deadline_passed",
    when: (f, now) =>
      f.status === "expired" || (f.status === "pending" && f.deadline !== null && f.deadline.getTime() <= now.getTime()),
  },
  // 5.
  { result: "offline", when: (f) => f.status === "pending" && f.method === "offline" },
  // 6.
  { result: "pay", when: (f) => f.status === "pending" },
];

/** Applies the ordered rule table. Throws for a status no rule covers: every `registrations.status` value is covered, so reaching
 *  the end means the status set grew without this table. */
export function payPageState(f: PayPageFacts, now: Date): PayPageState | null {
  for (const rule of PAY_PAGE_RULES) if (rule.when(f, now)) return rule.result;
  throw new Error(`payPageState: no rule covers registration status "${f.status}"`);
}

const PAID_EVENT_TYPES = [
  "registration.confirmed",
  "registration.paid_awaiting_approval",
  "registration.offline_paid",
  "registration.fee_waived",
] as const;

/**
 * The document `/r/pay/<token>` renders, or null for an unknown token and for a withdrawn or rejected entry. Privileged pool reads:
 * the visitor has no org, the token is what names one.
 */
export async function payPageDocByToken(token: string, now: Date): Promise<PayPageDoc | null> {
  const registrationId = await registrationIdByPayToken(token);
  if (registrationId === null) return null;
  const [reg] = await sql<(RegistrationWithGroupRow & { pay_session_id: string | null; division_name: string })[]>`
    select ${regGroupCols(sql)}, r.pay_session_id, d.name as division_name
    from registrations r
    join registration_groups g on g.id = r.group_id
    join divisions d on d.id = r.division_id
    where r.id = ${registrationId}`;
  if (!reg) return null; // the token row cascades with its entry; kept for a delete racing this read

  const settings = await loadSettings(sql, reg.division_id);
  const deadline = reg.promotion_expires_at ?? reg.expires_at;
  const method = settings?.payment_method ?? reg.payment_method;
  const ctx = await divisionCtx(sql, reg.division_id);
  // Fix round 1 (F3): "refunded" is about the payment the entry holds NOW. `refunded_cents` keeps the whole history, including a
  // late payment sent back while the entry was off the list (lapsed, expired): that money was never this payment, so a re-promoted
  // entry that then paid in time is paid, not refunded. Polish wave P5 (carry b): the late part is booked on the entry
  // (`late_refunded_cents`, V512, backfilled from the late-refund audit rows this read used to sum), and the rule is the one every
  // refund cap reads.
  const refundedCents = ownPaymentRefundedCents(reg);
  const state = payPageState({ status: reg.status, refundedCents, deadline, method }, now);
  if (state === null) return null;

  const locale = await recipientLocale(sql, { pick: reg.locale, userId: reg.user_id, orgDefault: ctx.default_locale });
  const lines = registrationLineItems([reg], ctx.comp_name).map((li) => ({
    label: li.price_data.product_data.name,
    amountCents: li.price_data.unit_amount * li.quantity,
  }));
  // Captain first, then entry order: the roster this entry becomes (materialise.ts) and the organiser's export list it so (gap wave G6).
  const members = await sql<{ full_name: string }[]>`
    select full_name from registration_players where registration_id = ${reg.id} order by is_captain desc, created_at, id`;

  let paidAt: Date | null = null;
  if (state === "paid" || state === "refunded") {
    const [ev] = await sql<{ created_at: Date }[]>`
      select created_at from competition_events
      where competition_id = ${ctx.competition_id}
        and type in ${sql(PAID_EVENT_TYPES as unknown as string[])}
        and payload->>'registration_id' = ${reg.id}
      order by created_at
      limit 1`;
    paidAt = ev?.created_at ?? null;
  }

  const instructions = settings?.payment_instructions ?? ctx.payment_instructions;
  return {
    registrationId: reg.id,
    groupId: reg.group_id,
    orgId: reg.org_id,
    locale,
    state,
    competitionName: ctx.comp_name,
    divisionName: reg.division_name,
    startsOn: ctx.starts_on,
    endsOn: ctx.ends_on,
    entrantName: reg.display_name,
    members: members.map((m) => m.full_name),
    currency: reg.currency,
    lines,
    totalCents: lines.reduce((s, l) => s + l.amountCents, 0),
    refundedCents,
    deadline,
    timezone: resolveVenueTz(null, ctx.org_timezone),
    refCode: reg.ref_code,
    orgName: ctx.org_name,
    paymentInstructions: state === "offline" && instructions ? fillPaymentInstructions(instructions, reg.ref_code) : null,
    paidAt,
    paySessionId: reg.pay_session_id,
    cardPaymentsOn: ctx.charges_enabled,
  };
}
