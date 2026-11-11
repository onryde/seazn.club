// Sponsor deals — the ONE owner of a deal's rules (plan 2026-11-07-sponsor-deals, D2, spec §5.2): the value sets, the
// transitions, which actions a deal offers, which deal a sponsor's row shows and what its chip says. Client-safe on
// purpose: it imports only the tier authority, so the console's sheets and rows read the same rules the usecases
// enforce. Pure: no I/O, no clock; a refusal is a DealRuleError, which Task 6 maps to an HttpError at the usecase
// boundary (F12: illegal_transition → 409, on_payment_needs_payment → 422).
//
// Each value set mirrors a named CHECK on sponsor_orders (the sponsor-deals delta);
// server/sponsors/__tests__/deal-values-db.test.ts reads them back and compares (F31).
import type { MessageKey } from "@/lib/messages";
import type { SponsorTier } from "./sponsor-tiers.ts";

/** D2: the lifecycle. `scheduled` = every condition of the rule is met, but the sponsor already has a live deal (§8a). */
export const DEAL_STATUSES = ["draft", "awaiting_payment", "awaiting_approval", "scheduled", "live", "ended"] as const;
export const PAYMENT_METHODS = ["online", "offline", "complimentary"] as const;
export const GO_LIVE_RULES = ["on_payment", "immediate", "on_approval"] as const;
/** D2: the money column `status` (the API's `payment_status`), plus `none` for a complimentary deal. */
export const PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded", "none"] as const;
/** `legacy`: a pre-deals order (D6). `duplicate_payment`: a second, different payment on a paid deal, recorded as its own
 *  ended, paid row (F3). `written_off`: the club waived an offline invoice still due after its deal ended (`endedStillDue`,
 *  Task 23): the deal was already ended, its money stays unpaid, and the reason says why nothing is owed. */
export const END_REASONS = [
  "refunded", "dispute_lost", "ended_now", "expired", "competition_finished", "legacy", "duplicate_payment", "written_off",
] as const;
/** The order allowedActions answers in. */
export const DEAL_ACTIONS = ["send_invoice", "resend_invoice", "mark_paid", "write_off", "approve", "refund", "end_now"] as const;

export type DealStatus = (typeof DEAL_STATUSES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type GoLiveRule = (typeof GO_LIVE_RULES)[number];
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type EndReason = (typeof END_REASONS)[number];
export type DealAction = (typeof DEAL_ACTIONS)[number];

/** One deal: a `sponsor_orders` row. Timestamps are ISO strings on the wire; a server row may carry Date objects, and
 *  every comparison here reads either. */
export interface SponsorDeal {
  id: string;
  /** Null only on a legacy row (the V495 CHECK sponsor_or_legacy). */
  sponsor_id: string | null;
  package_id: string;
  deal_status: DealStatus;
  payment_status: PaymentStatus;
  payment_method: PaymentMethod;
  go_live: GoLiveRule;
  /** The snapshot taken at creation (D4): a later package edit never moves it. */
  package_name: string;
  tier: SponsorTier;
  includes_on_stream: boolean;
  /** The deal's scope; null is the whole org. */
  competition_id: string | null;
  amount_cents: number;
  currency: string;
  sponsor_name: string;
  sponsor_email: string | null;
  ends_at: string | null;
  created_at: string;
  created_by: string | null;
  invoice_sent_at: string | null;
  paid_at: string | null;
  marked_paid_by: string | null;
  approved_at: string | null;
  approved_by: string | null;
  live_at: string | null;
  ended_at: string | null;
  ended_reason: EndReason | null;
  /** Set while an open dispute parks a live deal (the sponsor is hidden until it is resolved). */
  parked_at: string | null;
  disputed_at: string | null;
  dispute_id: string | null;
  /** The deal records a Stripe payment intent (batch G, New-3): the fact `refundDeal` decides a Stripe refund on, so the
   *  console's refund words key on it too. On a paid deal it means a card payment at Stripe paid it; Mark as paid clears it.
   *  The intent id itself never leaves the server. */
  has_payment_intent: boolean;
  /** The deal's invoice number (D11), per org from 1 (`formatInvoiceNumber` shows it): allocated when an online or offline deal is
   *  created, kept when it ends, never reused. Null on a complimentary deal (no invoice), a legacy order, and a deal made before
   *  invoices were numbered. */
  invoice_number: number | null;
}

export type DealRuleCode = "on_payment_needs_payment" | "illegal_transition";

/** A domain refusal. Domain-only: Task 6 maps it to an HttpError at the usecase boundary (F12). */
export class DealRuleError extends Error {
  readonly code: DealRuleCode;

  constructor(code: DealRuleCode, message?: string) {
    super(message ?? code);
    this.name = "DealRuleError";
    this.code = code;
  }
}

/** F15: a failed payment is still unpaid — Task 8 keeps it payable, so it offers what a pending one offers. */
export function isUnpaid(p: PaymentStatus): boolean {
  return p === "pending" || p === "failed";
}

/** Is this deal LIVE? The ONE definition: the server's sponsor lock (`locked_by_deal`) and the console both read it. */
export const isLiveDeal = (d: Pick<SponsorDeal, "deal_status">): boolean => d.deal_status === "live";

/** Is this deal OPEN - waiting to go live (draft, awaiting payment or approval, scheduled)? Neither live nor ended. The ONE
 *  definition: the server's `has_open_deal` and the console's "this sponsor already has one of these" both read it. */
export const isOpenDeal = (d: Pick<SponsorDeal, "deal_status">): boolean => d.deal_status !== "live" && d.deal_status !== "ended";

/** The end date has been reached (`<=`: `ends_at = now` is over). No end date is never past. The one definition: the sweep, the
 *  queue's promotion (server/sponsors/deal-apply.ts) and the Add deal sheet's summary all ask it. */
export const isPastEnd = (endsAt: Date | string | null, now: Date): boolean =>
  endsAt !== null && new Date(endsAt).getTime() <= now.getTime();

/** The day the club typed as "Ends on", read back from the `ends_at` the producer stored (YYYY-MM-DD). `createDeal` writes the START OF
 *  THE NEXT DAY in the ORG's timezone (`(ends_on::date + 1)::timestamp at time zone <org tz>`, NULL = UTC), so the last day the deal
 *  runs is that instant minus one millisecond, read in the same zone: never the viewer's, which moves it a day either way. An
 *  unknown zone (a bad stored value) reads as UTC rather than throwing. */
export function endsOnOf(endsAt: string, orgTz: string): string {
  const last = new Date(Date.parse(endsAt) - 1);
  const read = (timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(last);
  try {
    return read(orgTz);
  } catch {
    return read("UTC");
  }
}

/** The deal a sponsor's queue promotes when none is live (spec §8a, deal-apply step 2): the first `scheduled` one, in the order
 *  given (the server's is `created_at, id`), whose own end has not passed. A scheduled deal already past its end is never promoted
 *  (F19): it would go live for the hour until the sweep ends it. Null when nothing waits. */
export function nextScheduledDeal<T extends Pick<SponsorDeal, "deal_status" | "ends_at">>(deals: readonly T[], now: Date): T | null {
  return deals.find((d) => d.deal_status === "scheduled" && !isPastEnd(d.ends_at, now)) ?? null;
}

/** The rule list the Add deal sheet offers: "When paid" is not offered for a complimentary deal (spec §5.2). */
export function goLiveRulesFor(m: PaymentMethod): readonly GoLiveRule[] {
  return m === "complimentary" ? GO_LIVE_RULES.filter((r) => r !== "on_payment") : GO_LIVE_RULES;
}

/** Complimentary has no payment states (`none`, the V495 CHECK none_iff_complimentary); the others start pending. */
export function initialPaymentStatus(m: PaymentMethod): PaymentStatus {
  return m === "complimentary" ? "none" : "pending";
}

/** Where a new deal starts (spec §5.2). `otherLive`: the sponsor already has a live deal, so a deal whose rule is met
 *  queues as `scheduled` (§8a, at most one live deal per sponsor, D3). */
export function initialStatus(m: PaymentMethod, r: GoLiveRule, otherLive: boolean): DealStatus {
  if (m === "complimentary" && r === "on_payment") {
    throw new DealRuleError("on_payment_needs_payment", "a complimentary deal has no payment to go live on");
  }
  if (r === "immediate") return otherLive ? "scheduled" : "live";
  if (m === "online") return "draft";
  if (m === "offline") return "awaiting_payment";
  return "awaiting_approval";
}

function illegal(what: string, from: DealStatus): DealRuleError {
  return new DealRuleError("illegal_transition", `${what} is not allowed on a ${from} deal`);
}

/** Sending (or resending) the invoice: a draft now awaits payment. An unpaid deal that is already awaiting payment,
 *  live or scheduled (an immediate deal) stays where it is. */
export function statusAfterInvoiceSent(d: Pick<SponsorDeal, "deal_status">): DealStatus {
  switch (d.deal_status) {
    case "draft":
      return "awaiting_payment";
    case "awaiting_payment":
    case "live":
    case "scheduled":
      return d.deal_status;
    default:
      throw illegal("sending an invoice", d.deal_status);
  }
}

/** The payment landed (the webhook, or Mark as paid). On `on_payment` the deal goes live (or queues); on `on_approval`
 *  it waits for the club. A deal already live, scheduled or ended is unchanged (an immediate deal paid late, a
 *  redelivered event). */
export function statusAfterPaid(d: Pick<SponsorDeal, "deal_status" | "go_live">, otherLive: boolean): DealStatus {
  switch (d.deal_status) {
    case "awaiting_payment":
      if (d.go_live === "on_payment") return otherLive ? "scheduled" : "live";
      if (d.go_live === "on_approval") return "awaiting_approval";
      throw illegal(`a payment on an ${d.go_live} rule`, d.deal_status);
    case "live":
    case "scheduled":
    case "ended":
      return d.deal_status;
    default:
      throw illegal("a payment", d.deal_status);
  }
}

/** The club approved: live, or scheduled behind the sponsor's live deal. Only an awaiting_approval deal is approved. */
export function statusAfterApproved(d: Pick<SponsorDeal, "deal_status">, otherLive: boolean): DealStatus {
  if (d.deal_status !== "awaiting_approval") throw illegal("approving", d.deal_status);
  return otherLive ? "scheduled" : "live";
}

/** End reasons after which a paid deal is no longer refundable: a refund already made (or in flight), or the money lost
 *  to a dispute. */
const NOT_REFUNDABLE_AFTER: ReadonlySet<EndReason> = new Set<EndReason>(["refunded", "dispute_lost"]);

/** End reasons that leave an offline deal's money still owed: its term ran out (`expired`) or its competition finished, both by
 *  the sweep. `ended_now` is the club cancelling (nothing due, the invoice reads void), and every other reason is money already
 *  settled or a row that was never a deal. */
const STILL_DUE_AFTER: ReadonlySet<EndReason> = new Set<EndReason>(["expired", "competition_finished"]);

/** Is this an ENDED deal whose invoice is still due (review I3; Task 23 carries 1 and 4)? An OFFLINE deal that went live
 *  (`live_at`), then ended unpaid because its term ran out or its competition finished: the sponsor had the placement, so the
 *  money is owed. The club can still mark it paid (the deal stays ended) or write it off (`written_off`). An online deal ended
 *  unpaid claims nothing (its card link is gone), and one that never went live had nothing to pay for. The invoice reads it as
 *  `unpaid` (server/sponsors/invoice-doc.ts `invoiceState`). */
export function endedStillDue(
  d: Pick<SponsorDeal, "deal_status" | "payment_method" | "payment_status" | "live_at" | "ended_reason">,
): boolean {
  return (
    d.deal_status === "ended" &&
    d.payment_method === "offline" &&
    isUnpaid(d.payment_status) &&
    d.live_at !== null &&
    d.ended_reason !== null &&
    STILL_DUE_AFTER.has(d.ended_reason)
  );
}

/** The fields `allowedActions` reads. */
export type DealActionFacts = Pick<
  SponsorDeal,
  "deal_status" | "payment_method" | "payment_status" | "disputed_at" | "ended_reason" | "sponsor_email" | "live_at" | "invoice_number"
>;

/** The actions a deal offers, in DEAL_ACTIONS order. TOTAL (F15): every deal_status × payment_status × method answers.
 *  Task 6 refuses with 409, before any write, every action this does not offer (F12). `send_invoice` is online-only (a draft
 *  waits for it). `resend_invoice` is offered on an unpaid deal that is due: an online one, or an offline one with a billing
 *  email to send it to (F13) - an offline invoice is emailed, never paid by card - and an offline deal still due after it ended
 *  (`endedStillDue`) with an email. Neither send is offered on a deal with no invoice number (made before invoices were numbered,
 *  T23 review m5): it has no invoice page for the email to link, so the server would refuse it. `mark_paid` on every unpaid deal
 *  that is due, ended-and-still-due included (the deal stays ended); `write_off` only on an ended deal still due. */
export function allowedActions(d: DealActionFacts): DealAction[] {
  const s = d.deal_status;
  const online = d.payment_method === "online";
  const offline = d.payment_method === "offline";
  const paidFor = d.payment_method !== "complimentary";
  const unpaid = paidFor && isUnpaid(d.payment_status);
  const payable = s === "awaiting_payment" || s === "live" || s === "scheduled";
  const hasEmail = d.sponsor_email !== null && d.sponsor_email !== "";
  const endedDue = endedStillDue(d);
  const numbered = d.invoice_number !== null;
  const offered: Record<DealAction, boolean> = {
    send_invoice: numbered && s === "draft" && online && unpaid,
    resend_invoice: numbered && ((payable && unpaid && (online || (offline && hasEmail))) || (endedDue && hasEmail)),
    mark_paid: (payable && unpaid) || endedDue,
    write_off: endedDue,
    approve: s === "awaiting_approval",
    refund:
      paidFor &&
      d.payment_status === "paid" &&
      !d.disputed_at &&
      !(s === "ended" && d.ended_reason !== null && NOT_REFUNDABLE_AFTER.has(d.ended_reason)),
    end_now: s !== "ended",
  };
  return DEAL_ACTIONS.filter((a) => offered[a]);
}

/** Which deal a sponsor's row shows: the first status in this order, then the latest ended (by ended_at). */
const ROW_PRECEDENCE: readonly DealStatus[] = ["live", "awaiting_approval", "awaiting_payment", "draft", "scheduled"];

function time(t: string | Date): number {
  return new Date(t).getTime();
}

/** The deal a sponsor's row shows, or null when it has none. Legacy deals (D6) are never shown. Within one open
 *  status the oldest wins (the queue order, created_at then id); among ended deals the latest ended_at. */
export function pickRowDeal(deals: readonly SponsorDeal[]): SponsorDeal | null {
  const candidates = deals.filter((d) => d.ended_reason !== "legacy");
  for (const status of ROW_PRECEDENCE) {
    let best: SponsorDeal | null = null;
    for (const d of candidates) {
      if (d.deal_status !== status) continue;
      if (best === null) best = d;
      else {
        const dt = time(d.created_at) - time(best.created_at);
        if (dt < 0 || (dt === 0 && d.id < best.id)) best = d;
      }
    }
    if (best) return best;
  }
  let latest: SponsorDeal | null = null;
  for (const d of candidates) {
    if (d.deal_status !== "ended") continue;
    if (latest === null) latest = d;
    else {
      const dt = time(d.ended_at ?? d.created_at) - time(latest.ended_at ?? latest.created_at);
      if (dt > 0 || (dt === 0 && d.id > latest.id)) latest = d;
    }
  }
  return latest;
}

/** The one action a sponsor's row offers. There is no "send_invoice": a draft row opens the deal (F15). */
export type RowAction = "add_deal" | "open_deal" | "resend_invoice" | "mark_paid" | "approve";

/** F15's precedence, first match wins:
 *  1. no deal, or ended → add_deal;
 *  2. awaiting_approval → approve;
 *  3. unpaid and not draft or scheduled → resend_invoice (online) or mark_paid (offline);
 *  4. draft or scheduled → open_deal;
 *  5. otherwise (live with payment paid or none) → null. */
export function rowNextAction(d: SponsorDeal | null): RowAction | null {
  if (d === null || d.deal_status === "ended") return "add_deal";
  if (d.deal_status === "awaiting_approval") return "approve";
  const queued = d.deal_status === "draft" || d.deal_status === "scheduled";
  if (isUnpaid(d.payment_status) && !queued) {
    if (d.payment_method === "online") return "resend_invoice";
    if (d.payment_method === "offline") return "mark_paid";
  }
  if (queued) return "open_deal";
  return null;
}

/** A deal's status chip. `paid` is derived (D2): a scheduled deal that is paid. "Live · awaiting payment" is a live
 *  deal still unpaid; "on hold" is a live deal parked by a dispute. */
export type DealChip = {
  kind: "draft" | "awaiting_payment" | "paid" | "scheduled" | "awaiting_approval" | "live" | "ended";
  awaitingPayment: boolean;
  onHold: boolean;
};

export function dealChip(d: SponsorDeal): DealChip {
  const live = d.deal_status === "live";
  const kind: DealChip["kind"] = d.deal_status === "scheduled" && d.payment_status === "paid" ? "paid" : d.deal_status;
  return {
    kind,
    awaitingPayment: live && isUnpaid(d.payment_status),
    onHold: live && Boolean(d.parked_at),
  };
}

/** The Add deal sheet's primary button: an online deal sends its invoice; a deal that goes live on save says so. */
export function primaryLabel(m: PaymentMethod, r: GoLiveRule, otherLive: boolean): "send_invoice" | "save_deal" | "save_and_go_live" {
  if (m === "online") return "send_invoice";
  return r === "immediate" && !otherLive ? "save_and_go_live" : "save_deal";
}

/** After an ONLINE create whose invoice could not be sent (Stripe's 502), which invoice action the saved deal offers (spec §5.2:
 *  a deal that waits for its rule is a draft, an immediate one is live - or scheduled behind a live deal - with its payment
 *  pending). Read from `allowedActions` of the deal the server made, never typed beside it. `queued`: the sponsor has a live deal
 *  that stays live. */
export function invoiceActionOnCreate(rule: GoLiveRule, queued: boolean): "send_invoice" | "resend_invoice" {
  const offered = allowedActions({
    deal_status: initialStatus("online", rule, queued),
    payment_method: "online",
    payment_status: initialPaymentStatus("online"),
    disputed_at: null,
    ended_reason: null,
    sponsor_email: "billing@example.invalid", // an online deal always has one (the V495 CHECK online_has_email)
    live_at: null,
    invoice_number: 1, // every online deal is numbered when it is created (D11, createDeal)
  });
  if (offered.includes("send_invoice")) return "send_invoice";
  if (offered.includes("resend_invoice")) return "resend_invoice";
  throw new DealRuleError("illegal_transition", `a new online ${rule} deal offers neither Send invoice nor Resend invoice`);
}

/** The Add deal sheet's summary, as the dictionary keys and the values that fill them (the i18n house rule bans a dynamic `msg()` key,
 *  and this module is client-safe with no dictionary of its own): the sheet renders each part and joins them with a space. */
export type SummaryParts = { key: MessageKey; params: Record<string, string> }[];

/** What the Add deal sheet says will happen (mockup screen 3), from the choices on the sheet and nothing else:
 *   - the head: who gets which package for which scope, and what it costs how (an online deal then says where its invoice goes);
 *   - when they go live (spec §5.2). A deal queued behind a live one (`otherLive`, §8a) drops "straight away" - that would be false -
 *     and says it waits for the live deal to end; the other rules keep the condition they wait on and add the wait;
 *   - the sponsor coming off the pages in the meantime (spec §8a): a sponsor on the pages today (`currentlyShown`) whose new deal does
 *     not go live now is hidden until it does. A LIVE deal keeps its sponsor on the pages whatever is queued behind it
 *     (server/sponsors/deal-apply.ts, step 3), so `otherLive` says nothing is hidden. `otherLive` is the EFFECTIVE flag: false once
 *     the organiser ends the current deal now - and then a deal already WAITING behind it is promoted (step 2) and keeps the
 *     sponsor on the pages (`promotesWaiting`), so nothing is hidden either.
 *  `scopeName` null is the whole organisation. `amount` is the price as the sheet shows it. A complimentary deal cannot go live on
 *  payment - the server's refusal (422 `on_payment_needs_payment`), here the same DealRuleError the lifecycle table throws. */
export function dealSummary(i: {
  sponsorName: string;
  packageName: string;
  scopeName: string | null;
  method: PaymentMethod;
  rule: GoLiveRule;
  amount: string;
  email: string | null;
  otherLive: boolean;
  /** Ending the current deal now would promote a deal already waiting behind it (deal-apply step 2): the sponsor stays on the pages. */
  promotesWaiting?: boolean;
  currentlyShown: boolean;
}): SummaryParts {
  if (i.method === "complimentary" && i.rule === "on_payment") {
    throw new DealRuleError("on_payment_needs_payment", "a complimentary deal has no payment to go live on");
  }
  const whole = i.scopeName === null;
  const who: Record<string, string> = { name: i.sponsorName, package: i.packageName };
  if (i.scopeName !== null) who.scope = i.scopeName;
  const parts: SummaryParts = [];
  if (i.method === "online") {
    parts.push({ key: whole ? "sponsors.dealSheet.summary.head.onlineAll" : "sponsors.dealSheet.summary.head.online", params: who });
    parts.push(
      i.email
        ? { key: "sponsors.dealSheet.summary.invoiceTo", params: { amount: i.amount, email: i.email } }
        : { key: "sponsors.dealSheet.summary.invoice", params: { amount: i.amount } },
    );
  } else if (i.method === "offline") {
    parts.push({ key: whole ? "sponsors.dealSheet.summary.head.offlineAll" : "sponsors.dealSheet.summary.head.offline", params: { ...who, amount: i.amount } });
  } else {
    parts.push({ key: whole ? "sponsors.dealSheet.summary.head.complimentaryAll" : "sponsors.dealSheet.summary.head.complimentary", params: who });
  }

  if (!(i.rule === "immediate" && i.otherLive)) {
    const live: Record<GoLiveRule, Partial<Record<PaymentMethod, MessageKey>>> = {
      on_payment: { online: "sponsors.dealSheet.summary.live.whenPaid", offline: "sponsors.dealSheet.summary.live.whenMarked" },
      immediate: {
        online: "sponsors.dealSheet.summary.live.now",
        offline: "sponsors.dealSheet.summary.live.now",
        complimentary: "sponsors.dealSheet.summary.live.onSave",
      },
      on_approval: {
        online: "sponsors.dealSheet.summary.live.approvalPaid",
        offline: "sponsors.dealSheet.summary.live.approvalMarked",
        complimentary: "sponsors.dealSheet.summary.live.approvalOnly",
      },
    };
    const key = live[i.rule][i.method];
    if (key === undefined) throw new Error(`dealSummary: no go-live sentence for ${i.method}/${i.rule}`);
    parts.push({ key, params: {} });
  }
  if (i.otherLive) parts.push({ key: "sponsors.dealSheet.summary.queued", params: { name: i.sponsorName } });
  if (i.currentlyShown && !i.otherLive && !i.promotesWaiting && i.rule !== "immediate") {
    parts.push({ key: "sponsors.dealSheet.summary.hidden", params: { name: i.sponsorName } });
  }
  return parts;
}

/** One step of a deal's timeline (spec §6.5, mockup screen 5). `at` is the ISO time the step happened, or null.
 *  `done`: it happened. `next`: the ONE step an open deal is waiting on. `not_yet`: still to come. `skipped`: this deal has no such
 *  step (a complimentary deal has no invoice or payment) - the screen does not draw it. `missed`: the deal HAS the step, it never
 *  happened, and the deal has ended, so it never will (an unpaid deal ended now: "Not paid") - the screen DOES draw it, so the club
 *  can see why nothing came of the deal.
 *  `detail` keys by step: `created.by`; `invoice_sent.to`; `paid.method|amountCents|currency`; `ends.competitionEndsOn|
 *  competitionFinished`; `ended.reason`. */
export type TimelineStep = {
  key: "created" | "invoice_sent" | "paid" | "approved" | "live" | "ends" | "ended";
  at: string | null;
  state: "done" | "next" | "not_yet" | "skipped" | "missed";
  detail?: Record<string, string>;
};

/**
 * The deal page's timeline, top to bottom as mockup screen 5 draws it: created, invoice_sent, paid, approved, live, then `ends`
 * for an open deal or `ended` for an ended one. Every deal answers all six rows (a step that does not apply is `skipped`; the
 * screen hides those), so two deals' timelines line up.
 *
 * Applies: `invoice_sent` to an online deal (an offline one only once a send is recorded - the mockup's offline deal shows no
 * invoice step), never to a complimentary one; `paid` to every deal but a complimentary one; `approved` to the `on_approval` rule
 * only. An open deal waits on its first applicable step that has not happened (`next`); later ones are `not_yet`, but a step that
 * HAS happened is `done` wherever it sits (an immediate deal is live while its payment is still awaited). `ends` is a future
 * date, never the thing a deal waits on.
 *
 * An ENDED deal waits on nothing: each step it has that never happened is `missed` (drawn, e.g. "Not paid"); a step it never had
 * stays `skipped` (hidden). A LEGACY one (a pre-deals order) knows only its money: the steps the migration never recorded are
 * `skipped` too, not `missed`.
 *
 * `ctx.competitionEndsOn` is a DISPLAY hint (the competition's end date, YYYY-MM-DD, or null): an open deal scoped to a
 * competition with no end date of its own ends when that competition finishes (spec §8a), so its `ends` step carries the date the
 * competition is scheduled to end. It never decides anything here - a deal ends on the competition's derived phase (the sweep),
 * not on a date this function reads - so a hint in the past leaves the deal open.
 * `ctx.competitionFinished` is the DESK's answer (the competition's derived phase, server/usecases/sponsor-deals.ts
 * `isDealCompetitionFinished`), never the date: for an open deal that ends with its competition, the `ends` step says the
 * competition has finished - the deal is still open only until the sweep's next hourly check.
 * `ctx.createdBy` is the creator's display name, or null when it could not be resolved (a removed member, a deleted user): the
 * created step then names no one rather than guess.
 */
export function dealTimeline(
  d: SponsorDeal,
  ctx: { competitionEndsOn: string | null; competitionFinished: boolean; createdBy: string | null },
): TimelineStep[] {
  const ended = d.deal_status === "ended";
  const complimentary = d.payment_method === "complimentary";
  const invoiceSent = d.invoice_sent_at !== null;
  const paid = d.payment_status === "paid" || d.payment_status === "refunded";
  // A pre-deals order (V495, ended_reason `legacy`): the migration backfilled the MONEY and left invoice_sent_at / approved_at / live_at
  // NULL, so "never sent" and "never went live" would be guesses. Only the payment stays a known fact (paid, or never arrived).
  const legacy = d.ended_reason === "legacy";

  const raw: { key: TimelineStep["key"]; at: string | null; applies: boolean; done: boolean; detail?: Record<string, string> }[] = [
    { key: "created", at: d.created_at, applies: true, done: true, ...(ctx.createdBy ? { detail: { by: ctx.createdBy } } : {}) },
    {
      key: "invoice_sent",
      at: d.invoice_sent_at,
      applies: !complimentary && (d.payment_method === "online" || invoiceSent),
      done: invoiceSent,
      ...(invoiceSent && d.sponsor_email ? { detail: { to: d.sponsor_email } } : {}),
    },
    {
      key: "paid",
      at: d.paid_at,
      applies: !complimentary,
      done: paid,
      ...(paid ? { detail: { method: d.payment_method, amountCents: String(d.amount_cents), currency: d.currency } } : {}),
    },
    { key: "approved", at: d.approved_at, applies: d.go_live === "on_approval", done: d.approved_at !== null },
    { key: "live", at: d.live_at, applies: true, done: d.live_at !== null || d.deal_status === "live" },
  ];

  let waiting = false;
  const steps: TimelineStep[] = raw.map((r) => {
    const base = { key: r.key, at: r.at, ...(r.detail ? { detail: r.detail } : {}) };
    if (!r.applies) return { ...base, state: "skipped" };
    if (r.done) return { ...base, state: "done" };
    if (legacy && r.key !== "paid") return { ...base, state: "skipped" };
    // An ended deal waits on nothing: what it had and never got, it never will - shown as missed, not hidden.
    if (ended) return { ...base, state: "missed" };
    if (!waiting) {
      waiting = true;
      return { ...base, state: "next" };
    }
    return { ...base, state: "not_yet" };
  });

  if (ended) {
    steps.push({ key: "ended", at: d.ended_at, state: "done", ...(d.ended_reason ? { detail: { reason: d.ended_reason } } : {}) });
    return steps;
  }
  // Only a deal that ends WITH its competition (a competition scope and no end date of its own: the sweep's `competition_finished`
  // arm) carries either note; a deal with its own `ends_at` ends on that, and a whole-organisation deal has no competition.
  const withCompetition = d.ends_at === null && d.competition_id !== null;
  const detail: Record<string, string> = {};
  if (withCompetition && ctx.competitionEndsOn !== null) detail.competitionEndsOn = ctx.competitionEndsOn;
  if (withCompetition && ctx.competitionFinished) detail.competitionFinished = "yes";
  steps.push({ key: "ends", at: d.ends_at, state: "not_yet", ...(Object.keys(detail).length > 0 ? { detail } : {}) });
  return steps;
}

/** D11: how an invoice number reads — "SP-" and at least four digits (1 → SP-0001, 12345 → SP-12345: padded, never cut). Only
 *  what the per-org allocator hands out (an integer from 1) is a number; anything else is a RangeError, never a printed SP-0000. */
export function formatInvoiceNumber(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`not an invoice number: ${n}`);
  return `SP-${String(n).padStart(4, "0")}`;
}
