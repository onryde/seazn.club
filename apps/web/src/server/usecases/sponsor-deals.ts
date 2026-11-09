import "server-only";
// Sponsor deals — the console's deal usecases (plan 2026-11-07-sponsor-deals, Tasks 6 and 7; spec §5.2, §5.3, §8, §8a): create
// a deal on a sponsor, send its invoice (online), Mark as paid, Approve, End now, refund, list and get.
//
// The rules are lib/sponsor-deals.ts's (which status a deal starts in and moves to, which actions it offers); what a deal does
// to its sponsor is `applyDealsToSponsor`'s. This module only sequences them, and holds the four contracts every action keeps:
//   - F2, one lock order: read the deal's sponsor_id WITHOUT a lock, lock the sponsor, then its deals in (created_at, id)
//     order (`lockSponsorAndDeals`), then re-check the deal. A concurrent second call waits on the sponsor, sees the new
//     state, and is refused;
//   - F12: an action `allowedActions` does not offer is a 409 BEFORE any write, and no DealRuleError leaves this module —
//     `illegal_transition` is a 409 and `on_payment_needs_payment` a 422, at the boundary (`atBoundary`);
//   - F1: after its commit, every action AWAITS `expirePublicSponsors` (the organiser reads the public page next), never
//     `deferred`;
//   - every write ends with `applyDealsToSponsor` in the same transaction (D7).
// An online deal adds the session rule (D14, F3, F37; sponsors.ts `retireDealSession`): every path that replaces, abandons or
// deletes its stored Checkout session retires it first, outside any transaction, so two payable sessions never coexist.
import { deferred } from "@/lib/deferred";
import { sql, withTenant, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import {
  allowedActions,
  DealRuleError,
  initialPaymentStatus,
  initialStatus,
  statusAfterApproved,
  statusAfterInvoiceSent,
  statusAfterPaid,
  type DealAction,
  type DealStatus,
  type SponsorDeal,
} from "@/lib/sponsor-deals";
import type { SponsorTier } from "@/lib/sponsor-tiers";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateSponsorDeal } from "@/server/api-v1/schemas";
import {
  applyDealsToSponsor,
  clientDeal,
  isLegacyDeal,
  lockSponsorAndDeals,
  readDeal,
  readDeals,
  type ServerDeal,
} from "@/server/sponsors/deal-apply";
import { assertOnlineAllowed, assertPlacementAllowed } from "@/server/sponsors/deal-gates";
import { assertOutboxCanQueue, dispatchNow } from "@/server/email-outbox";
import {
  ensureDealCheckout,
  expirePublicSponsors,
  paidOnline,
  queueSponsorInvoice,
  refundSponsorOrder,
  retireDealSession,
  type DealCheckoutOrg,
} from "./sponsors";

/** The Add deal body (strict): the API schema itself, so the documented body and the enforced one cannot drift. */
export const CreateDealInput = CreateSponsorDeal;
/** What a caller passes: `end_current` may be omitted (it defaults to false). */
export type CreateDealInput = import("zod").input<typeof CreateSponsorDeal>;

/** F12: the one place a domain refusal becomes an HTTP answer. Every exported usecase runs inside it. */
async function atBoundary<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DealRuleError) {
      throw err.code === "on_payment_needs_payment"
        ? new HttpError(422, "a complimentary deal has no payment to go live on: pick Straight away or After I approve", err.code)
        : new HttpError(409, err.message, err.code);
    }
    throw err;
  }
}

/** Re-read a deal this transaction just wrote. It cannot be gone (the row is locked by this transaction): a guard. */
async function reread(tx: Tx, dealId: string): Promise<SponsorDeal> {
  const row = await readDeal(tx, dealId);
  if (!row) throw new Error(`sponsor deal ${dealId} vanished inside its own locked transaction`);
  return clientDeal(row);
}

/** The 409 for an action the deal does not offer (F12), named for why. */
function notOffered(d: ServerDeal, action: DealAction): HttpError {
  switch (action) {
    case "mark_paid":
      if (d.payment_status === "paid" || d.payment_status === "refunded") {
        return new HttpError(409, "this deal is already paid", "deal_already_paid");
      }
      if (d.deal_status === "ended") return new HttpError(409, "this deal has ended", "deal_ended");
      return new HttpError(409, "this deal has no payment to mark: it is complimentary, or its invoice is not sent yet", "deal_not_payable");
    case "approve":
      return new HttpError(409, "this deal is not waiting for approval", "deal_not_awaiting_approval");
    case "end_now":
      return new HttpError(409, "this deal has ended", "deal_ended");
    case "refund":
      if (d.disputed_at) {
        return new HttpError(
          409,
          "This payment has been charged back — a disputed payment can't be refunded. Respond to the dispute instead.",
          "deal_disputed",
        );
      }
      return new HttpError(409, "only a paid deal can be refunded, once", "deal_not_refundable");
    case "send_invoice":
    case "resend_invoice":
      return new HttpError(409, "this deal has no invoice to send", "deal_not_invoiceable");
  }
}

/** Another live deal of the same sponsor, beside `d` (legacy rows never count). */
const otherLive = (deals: readonly ServerDeal[], d: Pick<ServerDeal, "id">): boolean =>
  deals.some((x) => x.id !== d.id && !isLegacyDeal(x) && x.deal_status === "live");

/** A deal read without a lock, refused (404, or 409 when it offers none of `accept`) BEFORE Stripe or any write (F12). The
 *  locked write asks again. */
async function preflight(auth: AuthCtx, dealId: string, accept: readonly DealAction[]): Promise<ServerDeal> {
  const deal = await withTenant(auth.orgId, (tx) => readDeal(tx, dealId));
  if (!deal) throw new HttpError(404, "deal not found");
  const offered = allowedActions(deal);
  if (!accept.some((a) => offered.includes(a))) throw notOffered(deal, accept[0]!);
  return deal;
}

/** The deal moved on between its unlocked read and its lock (a concurrent send minted another session, or a payment landed):
 *  the action is refused rather than leave a session it never retired. */
const dealChanged = () => new HttpError(409, "this deal changed while it was being updated; reload it and try again", "deal_changed");

/**
 * The session rule before a write that abandons a deal's stored session (F3, F37), outside any transaction: an open session is
 * expired, an expired one passes, and a completed one (money in flight) is refused (`refuse`: Mark as paid) or left as it is
 * (`carry_on`: End now, Review Focus 1 — the late payment lands on an ended deal and is refundable). Answers the session id it
 * retired, which the write then clears, or null.
 */
async function retireBefore(deal: ServerDeal, onComplete: "refuse" | "carry_on"): Promise<string | null> {
  const outcome = await retireDealSession(deal);
  if (outcome === "complete") {
    if (onComplete === "refuse") throw paidOnline();
    return null;
  }
  return outcome === "retired" ? deal.checkout_session_id : null;
}

/** Clear a retired session off its deal (only while it is still the stored one): the dead link is never offered again, and
 *  the prune policy refuses a row that holds one. */
async function clearSession(tx: Tx, dealId: string, retired: string | null): Promise<void> {
  if (retired === null) return;
  await tx`
    update sponsor_orders set checkout_session_id = null, checkout_url = null, checkout_expires_at = null
     where id = ${dealId} and checkout_session_id = ${retired}`;
}

/** The org a deal's Checkout session is minted on: Connect must take charges (409 `connect_required`). */
async function checkoutOrg(orgId: string): Promise<DealCheckoutOrg> {
  const [org] = await sql<{ slug: string; stripe_account_id: string | null; stripe_charges_enabled: boolean }[]>`
    select slug, stripe_account_id, stripe_charges_enabled from organizations where id = ${orgId}`;
  if (!org?.stripe_account_id || !org.stripe_charges_enabled) {
    throw new HttpError(409, "Connect Stripe (Get paid) before selling sponsorship packages", "connect_required");
  }
  return { id: orgId, slug: org.slug, stripe_account_id: org.stripe_account_id };
}

interface Locked {
  deal: ServerDeal;
  deals: ServerDeal[];
  /** Null on a legacy row (D6): no sponsor to lock or apply, so the deal row itself is locked. */
  sponsorId: string | null;
}

/**
 * Run one console action on a deal, in the one lock order (F2), refusing what `allowedActions` does not offer (F12) before
 * `write` touches anything, then applying the sponsor's deals (D7) in the same transaction, then expiring the public pages
 * once it has committed (F1). `write` answers the id of a deal it moved to ended, or null.
 */
async function runAction(
  auth: AuthCtx,
  dealId: string,
  action: DealAction,
  op: string,
  write: (tx: Tx, l: Locked, now: Date) => Promise<string | null>,
): Promise<SponsorDeal> {
  return atBoundary(async () => {
    const out = await withTenant(auth.orgId, async (tx) => {
      // Unlocked: only the sponsor to lock first. A deal is never locked before its sponsor (F2).
      const [ref] = await tx<{ sponsor_id: string | null }[]>`select sponsor_id from sponsor_orders where id = ${dealId}`;
      if (!ref) throw new HttpError(404, "deal not found");
      let locked: Locked | null;
      if (ref.sponsor_id === null) {
        // A legacy row (D6) has no sponsor: lock the row itself. Only a refund can be offered on one.
        await tx`select 1 from sponsor_orders where id = ${dealId} for update`;
        const deal = await readDeal(tx, dealId);
        locked = deal && deal.sponsor_id === null ? { deal, deals: [deal], sponsorId: null } : null;
      } else {
        const held = await lockSponsorAndDeals(tx, ref.sponsor_id);
        const deal = held?.deals.find((d) => d.id === dealId);
        locked = held && deal ? { deal, deals: held.deals, sponsorId: ref.sponsor_id } : null;
      }
      // Re-checked under the lock: a deal gone, or moved to another sponsor, in between is not this one.
      if (!locked) throw new HttpError(404, "deal not found");
      if (!allowedActions(locked.deal).includes(action)) throw notOffered(locked.deal, action);
      const now = new Date();
      const endedDealId = await write(tx, locked, now);
      if (locked.sponsorId !== null) await applyDealsToSponsor(tx, locked.sponsorId, auth.userId, { now, endedDealId });
      return reread(tx, dealId);
    });
    await expirePublicSponsors(auth.orgId, op);
    return out;
  });
}

interface PackageRow {
  id: string;
  competition_id: string | null;
  name: string;
  price_cents: number;
  currency: string;
  tier: SponsorTier;
  active: boolean;
  includes_on_stream: boolean;
}

/**
 * Add a deal to a sponsor (spec §5.1, §5.2). Today's checkout order: every refusal comes before any row — the package (404;
 * retired 422), the scope inside the package's (422; the competition the org's, 404), the plan (the placement gate, and
 * `sponsors.monetize` plus Connect for online), the billing email for online (422), the rule (complimentary cannot go live
 * on payment, 422), the end date (today or later in the org's timezone, 422). Then ONE transaction: lock the sponsor and its
 * deals, end the live one when `end_current` asks, insert the deal with the package's snapshot (D4) in its first status
 * (queued as `scheduled` behind a live deal, §8a), and apply. An online deal is created as a draft: its invoice is Task 7's.
 */
export async function createDeal(
  auth: AuthCtx,
  sponsorId: string,
  input: CreateDealInput,
  origin: string,
): Promise<{ deal: SponsorDeal; checkout_url: string | null }> {
  return atBoundary(async () => {
    const method = input.payment_method;
    const rule = input.go_live;
    const pkg = await withTenant(auth.orgId, async (tx) => {
      const [row] = await tx<PackageRow[]>`
        select id, competition_id, name, price_cents, currency, tier, active, includes_on_stream
          from sponsor_packages where id = ${input.package_id}`;
      if (!row) throw new HttpError(404, "package not found");
      if (!row.active) throw new HttpError(422, "This package is no longer on sale", "package_retired");
      const [sp] = await tx`select 1 from sponsors where id = ${sponsorId}`;
      if (!sp) throw new HttpError(404, "sponsor not found");
      return row;
    });

    // The scope is inside the package's: a one-competition package fixes it.
    const scope = input.competition_id;
    if (pkg.competition_id !== null && scope !== pkg.competition_id) {
      throw new HttpError(422, "this package is for one competition: the deal must be scoped to it", "scope_outside_package");
    }
    if (scope !== null) {
      const found = await withTenant(auth.orgId, (tx) => tx`select 1 from competitions where id = ${scope}`);
      if (found.length === 0) throw new HttpError(404, "competition not found");
    }

    // The plan: the placement (D17), then online selling and Connect.
    await assertPlacementAllowed(auth.orgId, pkg.tier, scope);
    const [org] = await sql<{ stripe_account_id: string | null; stripe_charges_enabled: boolean; timezone: string | null }[]>`
      select stripe_account_id, stripe_charges_enabled, timezone from organizations where id = ${auth.orgId}`;
    if (method === "online") {
      await assertOnlineAllowed(auth.orgId, scope);
      if (!org?.stripe_account_id || !org.stripe_charges_enabled) {
        throw new HttpError(409, "Connect Stripe (Get paid) before selling sponsorship packages", "connect_required");
      }
      if (!input.sponsor_email) {
        throw new HttpError(422, "an online deal needs the sponsor's billing email: its invoice goes there", "sponsor_email_required");
      }
      // P-W2-1: refuse now, before the deal and its Checkout session, if this box cannot queue the invoice.
      assertOutboxCanQueue();
    }
    // ends_on: a day in the org's timezone (V305; NULL is UTC), today or later there, stored as the start of the NEXT day.
    let endsAt: Date | null = null;
    if (input.ends_on) {
      const [end] = await sql<{ ok: boolean; ends_at: Date }[]>`
        select ${input.ends_on}::date >= (now() at time zone tz)::date as ok,
               (${input.ends_on}::date + 1)::timestamp at time zone tz as ends_at
          from (select coalesce(${org?.timezone ?? null}::text, 'UTC') as tz) z`;
      if (!end?.ok) throw new HttpError(422, "a deal cannot end on a day that has passed", "ends_on_in_past");
      endsAt = end.ends_at;
    }

    // end_current abandons the live deal's stored session: the session rule first (F3), outside any transaction.
    let seen: { dealId: string; session: string | null; retired: string | null } | null = null;
    if (input.end_current) {
      const current = await withTenant(auth.orgId, (tx) => readDeals(tx, { sponsorId }));
      const live = current.find((d) => !isLegacyDeal(d) && d.deal_status === "live");
      if (live) seen = { dealId: live.id, session: live.checkout_session_id, retired: await retireBefore(live, "carry_on") };
    }

    const deal = await withTenant(auth.orgId, async (tx) => {
      const locked = await lockSponsorAndDeals(tx, sponsorId);
      if (!locked) throw new HttpError(404, "sponsor not found");
      const now = new Date();
      let endedDealId: string | null = null;
      const live = locked.deals.find((d) => !isLegacyDeal(d) && d.deal_status === "live") ?? null;
      if (input.end_current && live) {
        // A session on the live deal is the one the rule above saw (and retired, or found completed): a session minted since
        // was never retired, so the create is refused rather than leave it payable on an ended deal.
        if (live.checkout_session_id !== null && (seen?.dealId !== live.id || live.checkout_session_id !== seen.session)) {
          throw dealChanged();
        }
        await tx`update sponsor_orders set deal_status = 'ended', ended_at = ${now}, ended_reason = 'ended_now' where id = ${live.id}`;
        await clearSession(tx, live.id, seen?.dealId === live.id ? seen.retired : null);
        endedDealId = live.id;
      }
      const status: DealStatus = initialStatus(method, rule, live !== null && endedDealId === null);
      const [sponsor] = await tx<{ name: string }[]>`select name from sponsors where id = ${sponsorId}`;
      if (!sponsor) throw new Error(`sponsor ${sponsorId} vanished while this transaction held its lock`);
      const [row] = await tx<{ id: string }[]>`
        insert into sponsor_orders (
          org_id, package_id, sponsor_id, sponsor_name, sponsor_email, amount_cents, currency, status,
          deal_status, payment_method, go_live, tier, includes_on_stream, package_name, competition_id, ends_at,
          created_by, live_at)
        values (
          ${auth.orgId}, ${pkg.id}, ${sponsorId}, ${sponsor.name}, ${input.sponsor_email ?? null}, ${pkg.price_cents},
          ${pkg.currency}, ${initialPaymentStatus(method)},
          ${status}, ${method}, ${rule}, ${pkg.tier}, ${pkg.includes_on_stream}, ${pkg.name}, ${scope}, ${endsAt},
          ${auth.userId}, ${status === "live" ? now : null})
        returning id`;
      if (!row) throw new Error("insert into sponsor_orders returned no row");
      await applyDealsToSponsor(tx, sponsorId, auth.userId, { now, endedDealId });
      return reread(tx, row.id);
    });
    await expirePublicSponsors(auth.orgId, "sponsor.deal.create");
    // F11: an online deal sends its invoice now and answers the link. A Stripe failure is a 502 that leaves the deal as it
    // committed (a draft; or an immediate deal live with its payment pending): Send invoice retries it.
    if (method === "online") return sendDealInvoice(auth, deal.id, origin);
    return { deal, checkout_url: null };
  });
}

/**
 * Send (or resend) an online deal's invoice (spec §5.2; D14, F32, F3): online only, for a draft, or an unpaid deal awaiting
 * payment, live or scheduled — else 409 `deal_not_invoiceable` before Stripe (F12). The plan is asked again
 * (`sponsors.monetize`: an org that lost it mints nothing), Connect must take charges, and the outbox must be able to queue
 * (P-W2-1) — all before Stripe. Then `ensureDealCheckout` (outside any transaction) reuses the stored session while more than
 * 10 minutes are left of it, else retires it and mints `sponsor-deal-<id>-<count + 1>`. ONE transaction in the lock order
 * (F2) stores the session, counts the send, moves a draft to awaiting payment and queues the invoice with once-key
 * `<id>:<count + 1>`. After commit, the request makes the invoice's first attempt and awaits the public expiry (F1).
 */
export async function sendDealInvoice(
  auth: AuthCtx,
  dealId: string,
  origin: string,
): Promise<{ deal: SponsorDeal; checkout_url: string }> {
  return atBoundary(async () => {
    const pre = await preflight(auth, dealId, ["send_invoice", "resend_invoice"]);
    if (pre.sponsor_id === null) throw notOffered(pre, "send_invoice"); // a legacy row is never invoiceable
    await assertOnlineAllowed(auth.orgId, pre.competition_id);
    const org = await checkoutOrg(auth.orgId);
    assertOutboxCanQueue();
    const session = await ensureDealCheckout(pre, org, origin);

    let queued: string | null = null;
    const deal = await withTenant(auth.orgId, async (tx) => {
      const locked = await lockSponsorAndDeals(tx, pre.sponsor_id!);
      const current = locked?.deals.find((d) => d.id === dealId);
      if (!locked || !current) throw new HttpError(404, "deal not found");
      const offered = allowedActions(current);
      if (!offered.includes("send_invoice") && !offered.includes("resend_invoice")) throw notOffered(current, "send_invoice");
      if (current.checkout_session_id !== pre.checkout_session_id || current.invoice_send_count !== pre.invoice_send_count) {
        throw dealChanged();
      }
      const sendNo = current.invoice_send_count + 1;
      const now = new Date();
      await tx`
        update sponsor_orders
           set checkout_session_id = ${session.id}, checkout_url = ${session.url},
               checkout_expires_at = to_timestamp(${session.expires_at}),
               invoice_send_count = ${sendNo}, invoice_sent_at = ${now}, deal_status = ${statusAfterInvoiceSent(current)}
         where id = ${dealId}`;
      queued = await queueSponsorInvoice(tx, { deal: { ...current, org_id: auth.orgId }, checkoutUrl: session.url, sendNo });
      await applyDealsToSponsor(tx, pre.sponsor_id!, auth.userId, { now });
      return reread(tx, dealId);
    });
    const first = queued as string | null;
    if (first) deferred(() => dispatchNow([first]));
    await expirePublicSponsors(auth.orgId, "sponsor.deal.send_invoice");
    return { deal, checkout_url: session.url };
  });
}

/** Mark as paid (offline). Only an unpaid deal (`pending`, or `failed`: F15) the deal offers it on; on a When-paid rule it
 *  goes live (or queues), on After-I-approve it waits for the club (anti-goal 2), and a live or scheduled one stays put. */
export async function markDealPaid(auth: AuthCtx, dealId: string): Promise<SponsorDeal> {
  // An online deal's session rule first (F37): a completed session is the sponsor's own payment in flight — 409, nothing
  // changes; an open one is expired, so the sponsor cannot pay twice.
  const pre = await atBoundary(() => preflight(auth, dealId, ["mark_paid"]));
  const retired = await retireBefore(pre, "refuse");
  return runAction(auth, dealId, "mark_paid", "sponsor.deal.mark_paid", async (tx, { deal, deals }, now) => {
    if (deal.checkout_session_id !== pre.checkout_session_id) throw dealChanged();
    await clearSession(tx, deal.id, retired);
    const next = statusAfterPaid(deal, otherLive(deals, deal));
    await tx`
      update sponsor_orders
         set status = 'paid', paid_at = ${now}, marked_paid_by = ${auth.userId}, deal_status = ${next},
             live_at = ${next === "live" && deal.deal_status !== "live" ? now : deal.live_at}
       where id = ${deal.id}`;
    return null;
  });
}

/** Approve: an awaiting-approval deal goes live, or queues behind the sponsor's live deal. */
export async function approveDeal(auth: AuthCtx, dealId: string): Promise<SponsorDeal> {
  return runAction(auth, dealId, "approve", "sponsor.deal.approve", async (tx, { deal, deals }, now) => {
    const next = statusAfterApproved(deal, otherLive(deals, deal));
    await tx`
      update sponsor_orders
         set approved_at = ${now}, approved_by = ${auth.userId}, deal_status = ${next},
             live_at = ${next === "live" ? now : null}
       where id = ${deal.id}`;
    return null;
  });
}

/** End now: any deal that has not ended. Apply then promotes the next scheduled deal, or resets the sponsor (D8). */
export async function endDealNow(auth: AuthCtx, dealId: string): Promise<SponsorDeal> {
  // The session rule first (F3): an ended deal leaves no payable session behind. A completed one ends anyway (Review Focus 1).
  const pre = await atBoundary(() => preflight(auth, dealId, ["end_now"]));
  const retired = await retireBefore(pre, "carry_on");
  return runAction(auth, dealId, "end_now", "sponsor.deal.end", async (tx, { deal }, now) => {
    if (deal.checkout_session_id !== pre.checkout_session_id) throw dealChanged();
    await clearSession(tx, deal.id, retired);
    await tx`update sponsor_orders set deal_status = 'ended', ended_at = ${now}, ended_reason = 'ended_now' where id = ${deal.id}`;
    return deal.id;
  });
}

/** Refund a paid deal, once. A deal a charge paid refunds through Stripe: `refundSponsorOrder` keeps its call (transfer
 *  reversed, fee returned, keyed per deal), its disputed refusal and its awaited expiry (F1); Task 8 makes that refund end the
 *  deal. A deal no charge paid (offline, or online marked paid by hand: T2-I1) is recorded only — no money moves and nothing
 *  is mailed (§5.2): money `refunded`, the deal ended as refunded. */
export async function refundDeal(auth: AuthCtx, dealId: string): Promise<SponsorDeal> {
  const pre = await atBoundary(() => preflight(auth, dealId, ["refund"]));
  if (pre.payment_intent_id !== null) {
    await refundSponsorOrder(auth, dealId);
    return getDeal(auth, dealId);
  }
  return runAction(auth, dealId, "refund", "sponsor.deal.refund", async (tx, { deal }, now) => {
    // A charge recorded since the read above is refunded through Stripe, never written down by hand.
    if (deal.payment_intent_id !== null) throw dealChanged();
    const wasOpen = deal.deal_status !== "ended";
    await tx`
      update sponsor_orders
         set status = 'refunded', deal_status = 'ended', ended_at = coalesce(ended_at, ${now}), ended_reason = 'refunded'
       where id = ${deal.id}`;
    return wasOpen ? deal.id : null;
  });
}

/** The org's deals, newest first; one sponsor's with `sponsorId`. */
export async function listDeals(auth: AuthCtx, opts: { sponsorId?: string } = {}): Promise<SponsorDeal[]> {
  return withTenant(auth.orgId, async (tx) => (await readDeals(tx, opts)).map(clientDeal));
}

export async function getDeal(auth: AuthCtx, dealId: string): Promise<SponsorDeal> {
  const deal = await withTenant(auth.orgId, (tx) => readDeal(tx, dealId));
  if (!deal) throw new HttpError(404, "deal not found");
  return clientDeal(deal);
}
