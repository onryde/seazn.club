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
import { sponsorRefusal } from "@/lib/sponsor-refusals";
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
  isPastEnd,
  lockDealAndSponsor,
  lockSponsorAndDeals,
  readDeal,
  readDeals,
  type LockedDeal,
  type ServerDeal,
} from "@/server/sponsors/deal-apply";
import { assertOnlineAllowed, assertPlacementAllowed } from "@/server/sponsors/deal-gates";
import { assertOutboxCanQueue, dispatchNow } from "@/server/email-outbox";
import { log } from "@/server/logger";
import { fireOrgRevalidate } from "@/server/public-site/revalidate";
import {
  ensureDealCheckout,
  expirePublicSponsors,
  paidOnline,
  queueSponsorInvoice,
  refundSponsorOrder,
  retireDealSession,
  type DealCheckoutOrg,
} from "./sponsors";
import { competitionPhase, getCompetitionDesk } from "./competition-desk";

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
        ? sponsorRefusal(422, "a complimentary deal has no payment to go live on: pick Straight away or After I approve", err.code)
        : sponsorRefusal(409, err.message, err.code);
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
        return sponsorRefusal(409, "this deal is already paid", "deal_already_paid");
      }
      if (d.deal_status === "ended") return sponsorRefusal(409, "this deal has ended", "deal_ended");
      return sponsorRefusal(409, "this deal has no payment to mark: it is complimentary, or its invoice is not sent yet", "deal_not_payable");
    case "approve":
      return sponsorRefusal(409, "this deal is not waiting for approval", "deal_not_awaiting_approval");
    case "end_now":
      return sponsorRefusal(409, "this deal has ended", "deal_ended");
    case "refund":
      if (d.disputed_at) {
        return sponsorRefusal(
          409,
          "This payment has been charged back — a disputed payment can't be refunded. Respond to the dispute instead.",
          "deal_disputed",
        );
      }
      return sponsorRefusal(409, "only a paid deal can be refunded, once", "deal_not_refundable");
    case "send_invoice":
    case "resend_invoice":
      return sponsorRefusal(409, "this deal has no invoice to send", "deal_not_invoiceable");
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
const dealChanged = () => sponsorRefusal(409, "this deal changed while it was being updated; reload it and try again", "deal_changed");

/**
 * The session rule before a write that abandons a deal's stored session (F3, F37), outside any transaction: an open session is
 * expired, an expired one passes, and a completed one (money in flight) is refused (`refuse`: Mark as paid) or left as it is
 * (`carry_on`: End now, Review Focus 1 — the late payment lands on an ended deal and is refundable). A retired session is
 * already forgotten, committed (review I1), so every refusal the caller can make up front comes BEFORE this. Answers the
 * session the deal should still hold under the lock: the completed one carried on over, else null — anything else is a
 * session stored since, which this rule never saw (409 `deal_changed`).
 */
async function retireBefore(
  orgId: string,
  deal: Pick<ServerDeal, "id" | "checkout_session_id">,
  onComplete: "refuse" | "carry_on",
): Promise<string | null> {
  const outcome = await retireDealSession(orgId, deal);
  if (outcome === "complete") {
    if (onComplete === "refuse") throw paidOnline();
    return deal.checkout_session_id;
  }
  return null;
}

/** The org a deal's Checkout session is minted on: Connect must take charges (409 `connect_required`). */
async function checkoutOrg(orgId: string): Promise<DealCheckoutOrg> {
  const [org] = await sql<{ slug: string; stripe_account_id: string | null; stripe_charges_enabled: boolean }[]>`
    select slug, stripe_account_id, stripe_charges_enabled from organizations where id = ${orgId}`;
  if (!org?.stripe_account_id || !org.stripe_charges_enabled) {
    throw sponsorRefusal(409, "Connect Stripe (Get paid) before selling sponsorship packages", "connect_required");
  }
  return { id: orgId, slug: org.slug, stripe_account_id: org.stripe_account_id };
}

/** A deal under the one lock order (F2); a legacy row (D6) with no sponsor locks only itself. */
type Locked = LockedDeal;

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
      // The sponsor, then its deals; never the deal first (F2). A legacy row (D6) with no sponsor locks only itself: only a
      // refund can be offered on one. Re-checked under the lock: a deal gone, or moved to another sponsor, in between is not
      // this one.
      const locked = await lockDealAndSponsor(tx, dealId);
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
      if (!row.active) throw sponsorRefusal(422, "This package is no longer on sale", "package_retired");
      const [sp] = await tx`select 1 from sponsors where id = ${sponsorId}`;
      if (!sp) throw new HttpError(404, "sponsor not found");
      return row;
    });

    // The scope is inside the package's: a one-competition package fixes it.
    const scope = input.competition_id;
    if (pkg.competition_id !== null && scope !== pkg.competition_id) {
      throw sponsorRefusal(422, "this package is for one competition: the deal must be scoped to it", "scope_outside_package");
    }
    if (scope !== null) {
      const found = await withTenant(auth.orgId, (tx) => tx`select 1 from competitions where id = ${scope}`);
      if (found.length === 0) throw new HttpError(404, "competition not found");
    }
    // A package for a competition that has FINISHED is not sold (batch F review m4): the sweep would end the deal within the
    // hour (§8a) and expire the pay link it emailed. The same authority as the sweep, the derived phase; a phase nobody can read
    // throws, so nothing is sold on a guess.
    if (pkg.competition_id !== null && (await isCompetitionFinished(auth.orgId, pkg.competition_id, new Date()))) {
      throw sponsorRefusal(409, "this package's competition has finished: it can no longer be sold", "competition_finished");
    }

    // The plan: the placement (D17), then online selling and Connect.
    await assertPlacementAllowed(auth.orgId, pkg.tier, scope);
    const [org] = await sql<{ stripe_account_id: string | null; stripe_charges_enabled: boolean; timezone: string | null }[]>`
      select stripe_account_id, stripe_charges_enabled, timezone from organizations where id = ${auth.orgId}`;
    if (method === "online") {
      await assertOnlineAllowed(auth.orgId, scope);
      if (!org?.stripe_account_id || !org.stripe_charges_enabled) {
        throw sponsorRefusal(409, "Connect Stripe (Get paid) before selling sponsorship packages", "connect_required");
      }
      if (!input.sponsor_email) {
        throw sponsorRefusal(422, "an online deal needs the sponsor's billing email: its invoice goes there", "sponsor_email_required");
      }
      // P-W2-1: refuse now, before the deal and its Checkout session, if this box cannot queue the invoice.
      assertOutboxCanQueue();
    }
    // The rule combination (422 `on_payment_needs_payment`) is refused HERE, before end_current's session rule closes the live
    // deal's pay link at Stripe (review I1): a refusal after that expire would leave the live deal with a dead link.
    initialStatus(method, rule, false);
    // ends_on: a day in the org's timezone (V305; NULL is UTC), today or later there, stored as the start of the NEXT day.
    let endsAt: Date | null = null;
    if (input.ends_on) {
      const [end] = await sql<{ ok: boolean; ends_at: Date }[]>`
        select ${input.ends_on}::date >= (now() at time zone tz)::date as ok,
               (${input.ends_on}::date + 1)::timestamp at time zone tz as ends_at
          from (select coalesce(${org?.timezone ?? null}::text, 'UTC') as tz) z`;
      if (!end?.ok) throw sponsorRefusal(422, "a deal cannot end on a day that has passed", "ends_on_in_past");
      endsAt = end.ends_at;
    }

    // end_current abandons the live deal's stored session: the session rule first (F3), outside any transaction.
    let seen: { dealId: string; session: string | null } | null = null;
    if (input.end_current) {
      const current = await withTenant(auth.orgId, (tx) => readDeals(tx, { sponsorId }));
      const live = current.find((d) => !isLegacyDeal(d) && d.deal_status === "live");
      if (live) seen = { dealId: live.id, session: await retireBefore(auth.orgId, live, "carry_on") };
    }

    const deal = await withTenant(auth.orgId, async (tx) => {
      const locked = await lockSponsorAndDeals(tx, sponsorId);
      if (!locked) throw new HttpError(404, "sponsor not found");
      const now = new Date();
      let endedDealId: string | null = null;
      const live = locked.deals.find((d) => !isLegacyDeal(d) && d.deal_status === "live") ?? null;
      if (input.end_current && live) {
        // A session on the live deal is the completed one the rule above carried on over (a retired one is already gone): a
        // session minted since was never retired, so the create is refused rather than leave it payable on an ended deal.
        if (live.checkout_session_id !== null && (seen?.dealId !== live.id || live.checkout_session_id !== seen.session)) {
          throw dealChanged();
        }
        await tx`update sponsor_orders set deal_status = 'ended', ended_at = ${now}, ended_reason = 'ended_now' where id = ${live.id}`;
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
 * 10 minutes are left of it AND Stripe still calls it open, else retires it (a session Stripe cannot read is a 502 and
 * nothing is minted) and mints `sponsor-deal-<id>-<count + 1>`. ONE transaction in the lock order
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
    // What the deal holds now: the reused session, or none (a retired or dead one is forgotten; the new one is stored below).
    const expected = session.minted ? null : pre.checkout_session_id;

    let queued: string | null = null;
    const deal = await withTenant(auth.orgId, async (tx) => {
      const locked = await lockSponsorAndDeals(tx, pre.sponsor_id!);
      const current = locked?.deals.find((d) => d.id === dealId);
      if (!locked || !current) throw new HttpError(404, "deal not found");
      const offered = allowedActions(current);
      if (!offered.includes("send_invoice") && !offered.includes("resend_invoice")) throw notOffered(current, "send_invoice");
      if (current.checkout_session_id !== expected || current.invoice_send_count !== pre.invoice_send_count) {
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
 *  goes live (or queues), on After-I-approve it waits for the club (anti-goal 2), and a live or scheduled one stays put.
 *
 *  The rule (T8 review I1): `payment_intent_id` names the Stripe charge that PAID the deal — the payment webhook writes it with
 *  `paid`, and a refund goes through Stripe exactly when it is set. A payment marked by hand has no charge, so it clears the
 *  intent a declined card left (`payment_failed` records one): else the refund would ask Stripe to refund an intent that never
 *  charged, 502 every time, and the deal could never be refunded. */
export async function markDealPaid(auth: AuthCtx, dealId: string): Promise<SponsorDeal> {
  // An online deal's session rule first (F37): a completed session is the sponsor's own payment in flight — 409, nothing
  // changes; an open one is expired, so the sponsor cannot pay twice.
  const pre = await atBoundary(() => preflight(auth, dealId, ["mark_paid"]));
  const expected = await retireBefore(auth.orgId, pre, "refuse");
  return runAction(auth, dealId, "mark_paid", "sponsor.deal.mark_paid", async (tx, { deal, deals }, now) => {
    if (deal.checkout_session_id !== expected) throw dealChanged();
    const next = statusAfterPaid(deal, otherLive(deals, deal));
    await tx`
      update sponsor_orders
         set status = 'paid', paid_at = ${now}, marked_paid_by = ${auth.userId}, deal_status = ${next}, payment_intent_id = null,
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
  const expected = await retireBefore(auth.orgId, pre, "carry_on");
  return runAction(auth, dealId, "end_now", "sponsor.deal.end", async (tx, { deal }, now) => {
    if (deal.checkout_session_id !== expected) throw dealChanged();
    await tx`update sponsor_orders set deal_status = 'ended', ended_at = ${now}, ended_reason = 'ended_now' where id = ${deal.id}`;
    return deal.id;
  });
}

/** Refund a paid deal, once. A deal a charge paid refunds through Stripe: `refundSponsorOrder` keeps its call (transfer
 *  reversed, fee returned, keyed per deal), its disputed refusal and its awaited expiry (F1), and its charge.refunded path
 *  ends the deal as refunded and applies it to the sponsor (Task 8). A deal no charge paid (offline, or online marked paid by hand: T2-I1) is recorded only — no money moves and nothing
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

/** What one run of the sweep did. `checked`: the live AND open deals examined; `expired` / `finished`: deals it ended, by their
 *  own `ends_at` / by their competition finishing; `promoted`: scheduled deals it put live; `failed`: deals it could not move,
 *  left as they were for the next run (the cron Worker alerts on this one). */
export interface SweepResult {
  checked: number;
  expired: number;
  finished: number;
  promoted: number;
  failed: number;
}

/** The sweep's view of one live or open deal: just what deciding whether it is due needs, read without a lock. */
interface SweepRow {
  id: string;
  org_id: string;
  deal_status: DealStatus;
  competition_id: string | null;
  ends_at: Date | null;
  checkout_session_id: string | null;
}

type SweepReason = "expired" | "competition_finished";

/**
 * The hourly sweep (plan D20, F19; spec §5.2, §8a): every live or open deal (draft, awaiting payment or approval, scheduled) is
 * examined, on the privileged connection and one transaction per deal, and ended when it is due:
 *  - `ends_at` has passed (`<=`, so `ends_at = now` is due): ended `expired`. A deal still waiting to go live is ended too, and
 *    a scheduled deal past its OWN end is never promoted — it is ended `expired` instead (F19);
 *  - a deal (live OR still waiting to go live: spec §8a says "a deal") with a competition and no `ends_at`, once that
 *    competition's derived phase is `finished`: ended `competition_finished`. The PHASE decides, never the competition's
 *    stored date, so moving its dates moves the end with them; a competition with no divisions is `setting_up` forever and
 *    its deal never ends this way (End now still works).
 * Then `applyDealsToSponsor` promotes the sponsor's next scheduled deal in the same transaction (never one whose own end has
 * passed: apply skips it, whoever ended the live deal).
 *
 * Order and locks. Deals still waiting go first and live ones last, so a scheduled deal that is itself due (past its end, or on
 * a finished competition) has left the queue before the live deal ahead of it ends and promotes: it is never promoted for the
 * hour. Each transaction takes the one lock order (F2: the sponsor, then its deals by (created_at, id), then re-checks that
 * the deal is still due); a deal another writer got to first is left alone.
 *
 * Stripe, outside any transaction (D14, F3): a deal being ended that holds a stored Checkout session retires it first
 * (`retireBefore`: retrieve, expire only when open, a completed one carried on over). A session that cannot be read or
 * expired is a `failed` deal, left as it was. A competition's desk is read before any transaction (it opens its own).
 *
 * A deal that throws is counted in `failed`, logged, and the sweep moves on. The public pages of the orgs that changed are
 * revalidated as tail work (`deferred`, F1: nobody reads a sweep back at once).
 *
 * `now` is injectable (the end date is proven against it). `orgIds` scopes the run to those orgs — the test seam for a shared
 * database (the route never passes it); an empty list examines nothing.
 */
export async function sweepSponsorDeals(now: Date = new Date(), opts: { orgIds?: readonly string[] } = {}): Promise<SweepResult> {
  const scope = opts.orgIds === undefined ? sql`` : sql`and org_id = any(${[...opts.orgIds]}::uuid[])`;
  const rows = await sql<SweepRow[]>`
    select id, org_id, deal_status, competition_id, ends_at, checkout_session_id
      from sponsor_orders
     where deal_status <> 'ended' ${scope}
     order by created_at, id`;
  const result: SweepResult = { checked: rows.length, expired: 0, finished: 0, promoted: 0, failed: 0 };

  // Decide who is due. A competition's phase is asked once per (org, competition), before any transaction.
  const due: { row: SweepRow; reason: SweepReason }[] = [];
  const phases = new Map<string, Promise<"finished" | "not_finished" | "unreadable">>();
  for (const row of rows) {
    if (isPastEnd(row.ends_at, now)) {
      due.push({ row, reason: "expired" });
      continue;
    }
    // §8a: "a deal" scoped to one competition with no end date ends when it finishes — live OR still waiting to go live.
    if (row.ends_at !== null || row.competition_id === null) continue;
    const key = `${row.org_id}/${row.competition_id}`;
    let phase = phases.get(key);
    if (!phase) {
      phase = competitionPhaseOf(row.org_id, row.competition_id, now);
      phases.set(key, phase);
    }
    const verdict = await phase;
    if (verdict === "finished") due.push({ row, reason: "competition_finished" });
    else if (verdict === "unreadable") {
      result.failed++;
      log.error({ dealId: row.id, competitionId: row.competition_id }, "sponsor deals sweep: the competition's phase could not be read");
    }
  }
  // Deals still waiting before live ones (a stable sort: oldest first within each).
  due.sort((a, b) => Number(a.row.deal_status === "live") - Number(b.row.deal_status === "live"));

  const changedOrgs = new Set<string>();
  for (const { row, reason } of due) {
    try {
      const out = await endDueDeal(row, reason, now);
      if (out === null) continue; // another writer got there first: nothing to do
      if (reason === "expired") result.expired++;
      else result.finished++;
      if (out.promoted) result.promoted++;
      changedOrgs.add(row.org_id);
    } catch (err) {
      result.failed++;
      log.error({ err, dealId: row.id, reason }, "sponsor deals sweep: a deal could not be ended; it is left for the next run");
    }
  }

  // F1: the sweep is not a console path (nobody reads it back), so the bust is tail work, after its own slug read.
  for (const orgId of changedOrgs) {
    deferred(async () => {
      const [org] = await sql<{ slug: string }[]>`select slug from organizations where id = ${orgId}`;
      if (org) fireOrgRevalidate(org.slug);
    });
  }
  return result;
}

/** THE authority on "this competition has finished" for sponsor deals (§8a): its derived phase, read as an org's viewer (the
 *  context this repo synthesizes elsewhere). The sweep ends a deal on it, `createDeal` refuses a package on it, and the
 *  Packages tab marks such a package "finished" while the Add deal sheet shows it locked (both via
 *  `finishedPackageCompetitions`). Throws when the desk cannot be read. */
async function isCompetitionFinished(orgId: string, competitionId: string, now: Date): Promise<boolean> {
  const desk = await getCompetitionDesk({ orgId, via: "session", userId: null, role: "viewer", keyId: null }, competitionId, now);
  return competitionPhase(desk).kind === "finished";
}

/**
 * The competitions of the org's ACTIVE packages that have finished (`isCompetitionFinished`), each once: the Packages tab marks
 * those packages "finished" and the Add deal sheet shows them locked (batch F review m4; `createDeal` refuses them anyway with
 * 409 `competition_finished`). The Packages tab has no Send invoice any more - a deal is added from the sheet. A competition whose
 * phase cannot be read is left out here (a display hint, logged), and the create's own guard still refuses it. Whole-org packages ask nothing.
 */
export async function finishedPackageCompetitions(orgId: string, now: Date = new Date()): Promise<string[]> {
  const rows = await withTenant(orgId, (tx) => tx<{ competition_id: string }[]>`
    select distinct competition_id from sponsor_packages
     where active and competition_id is not null
     order by competition_id`);
  // One desk read per distinct competition, all at once (batch G New-4): the page waits on the slowest, not on their sum. The
  // set is bounded by the org's own active packages. The answer keeps the read's id order, whatever order the desks finish in.
  const phases = await Promise.all(rows.map(({ competition_id }) => competitionPhaseOf(orgId, competition_id, now)));
  return rows.filter((_, i) => phases[i] === "finished").map((r) => r.competition_id);
}

/**
 * Has this deal's competition finished - the deal page's timeline says so on a deal that ends with its competition (Task 17)?
 * `isCompetitionFinished`'s answer (the derived phase, never the competition's stored end date), for ONE competition. A whole-
 * organisation deal (`null`) has none and reads no desk. This is a DISPLAY hint, so a desk that cannot be read answers false
 * (logged): the page never claims an end it could not check, and the sweep's own guard is what ends the deal.
 */
export async function isDealCompetitionFinished(orgId: string, competitionId: string | null, now: Date = new Date()): Promise<boolean> {
  if (competitionId === null) return false;
  return (await competitionPhaseOf(orgId, competitionId, now)) === "finished";
}

/**
 * The name the deal page puts beside "Created": the creator's display name, or null when it cannot honestly be named. A deal's
 * `created_by` is a user id; it is resolved only while that user is STILL a member of this org (a removed member's name is not
 * for the org's other members to read, and a deleted user has none), and a blank name is no name. The page then draws "Created"
 * with a date and no author rather than guess.
 */
export async function dealCreatorName(orgId: string, userId: string | null): Promise<string | null> {
  if (userId === null) return null;
  const [row] = await sql<{ display_name: string | null }[]>`
    select u.display_name
      from users u
      join org_members m on m.user_id = u.id and m.org_id = ${orgId}
     where u.id = ${userId} and u.deleted_at is null`;
  const name = row?.display_name?.trim() ?? "";
  return name === "" ? null : name;
}

/** A competition's derived phase for the sweep (`isCompetitionFinished`). A read that throws is `unreadable` — never
 *  `finished`. */
async function competitionPhaseOf(orgId: string, competitionId: string, now: Date): Promise<"finished" | "not_finished" | "unreadable"> {
  try {
    return (await isCompetitionFinished(orgId, competitionId, now)) ? "finished" : "not_finished";
  } catch (err) {
    log.error({ err, orgId, competitionId }, "sponsor deals sweep: the competition desk could not be read");
    return "unreadable";
  }
}

/**
 * End ONE due deal. Stripe first (outside any transaction), then one transaction in the one lock order: lock the sponsor and
 * its deals, re-check that this deal is still due (null: it is not — ended by another writer, or its dates moved), end it,
 * and apply. Answers whether apply promoted a scheduled deal, or null when the deal was not ended.
 */
async function endDueDeal(row: SweepRow, reason: SweepReason, now: Date): Promise<{ promoted: boolean } | null> {
  const expected = row.checkout_session_id === null ? null : await retireBefore(row.org_id, row, "carry_on");
  return sql.begin(async (tx) => {
    const locked = await lockDealAndSponsor(tx, row.id);
    if (!locked || locked.sponsorId === null) return null;
    const { deal, deals } = locked;
    const stillDue =
      deal.deal_status !== "ended" &&
      (reason === "expired"
        ? isPastEnd(deal.ends_at, now)
        : deal.ends_at === null && deal.competition_id === row.competition_id);
    if (!stillDue) return null;
    if (deal.checkout_session_id !== expected) throw dealChanged();

    await tx`update sponsor_orders set deal_status = 'ended', ended_at = ${now}, ended_reason = ${reason} where id = ${deal.id}`;
    // F7: the sponsor is reset only when this step ended the LAST live or open deal.
    const last = !deals.some((d) => d.id !== deal.id && !isLegacyDeal(d) && d.deal_status !== "ended");
    // F19: `applyDealsToSponsor` itself never promotes a scheduled deal whose own end has passed (it stays scheduled, for its own
    // step of this sweep or the next run to end `expired`), so an unreadable session on that deal cannot hold this one up.
    const applied = await applyDealsToSponsor(tx, locked.sponsorId, null, { now, endedDealId: last ? deal.id : null });
    return { promoted: applied.promotedDealId !== null };
  });
}
