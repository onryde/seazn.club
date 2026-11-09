// Sponsor deals — the ONE owner of a deal's rules (plan 2026-11-07-sponsor-deals, D2, spec §5.2): the value sets, the
// transitions, which actions a deal offers, which deal a sponsor's row shows and what its chip says. Client-safe on
// purpose: it imports only the tier authority, so the console's sheets and rows read the same rules the usecases
// enforce. Pure: no I/O, no clock; a refusal is a DealRuleError, which Task 6 maps to an HttpError at the usecase
// boundary (F12: illegal_transition → 409, on_payment_needs_payment → 422).
//
// Each value set mirrors a named CHECK on sponsor_orders (the sponsor-deals delta);
// server/sponsors/__tests__/deal-values-db.test.ts reads them back and compares (F31).
import type { SponsorTier } from "./sponsor-tiers";

/** D2: the lifecycle. `scheduled` = every condition of the rule is met, but the sponsor already has a live deal (§8a). */
export const DEAL_STATUSES = ["draft", "awaiting_payment", "awaiting_approval", "scheduled", "live", "ended"] as const;
export const PAYMENT_METHODS = ["online", "offline", "complimentary"] as const;
export const GO_LIVE_RULES = ["on_payment", "immediate", "on_approval"] as const;
/** D2: the money column `status` (the API's `payment_status`), plus `none` for a complimentary deal. */
export const PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded", "none"] as const;
/** `legacy`: a pre-deals order (D6). `duplicate_payment`: a second, different payment on a paid deal, recorded as its own
 *  ended, paid row (F3). */
export const END_REASONS = [
  "refunded", "dispute_lost", "ended_now", "expired", "competition_finished", "legacy", "duplicate_payment",
] as const;
/** The order allowedActions answers in. */
export const DEAL_ACTIONS = ["send_invoice", "resend_invoice", "mark_paid", "approve", "refund", "end_now"] as const;

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
  /** Null only on a legacy row (the V493 CHECK sponsor_or_legacy). */
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
  /** Always null until PR 3 numbers invoices (D11). */
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
function isUnpaid(p: PaymentStatus): boolean {
  return p === "pending" || p === "failed";
}

/** The rule list the Add deal sheet offers: "When paid" is not offered for a complimentary deal (spec §5.2). */
export function goLiveRulesFor(m: PaymentMethod): readonly GoLiveRule[] {
  return m === "complimentary" ? GO_LIVE_RULES.filter((r) => r !== "on_payment") : GO_LIVE_RULES;
}

/** Complimentary has no payment states (`none`, the V493 CHECK none_iff_complimentary); the others start pending. */
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

/** The actions a deal offers, in DEAL_ACTIONS order. TOTAL (F15): every deal_status × payment_status × method answers.
 *  Task 6 refuses with 409, before any write, every action this does not offer (F12). `*_invoice` is online-only here;
 *  Task 23 adds resend_invoice for offline deals with an email (F13). */
export function allowedActions(d: SponsorDeal): DealAction[] {
  const s = d.deal_status;
  const online = d.payment_method === "online";
  const paidFor = d.payment_method !== "complimentary";
  const unpaid = paidFor && isUnpaid(d.payment_status);
  const payable = s === "awaiting_payment" || s === "live" || s === "scheduled";
  const offered: Record<DealAction, boolean> = {
    send_invoice: s === "draft" && online && unpaid,
    resend_invoice: payable && online && unpaid,
    mark_paid: payable && unpaid,
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
