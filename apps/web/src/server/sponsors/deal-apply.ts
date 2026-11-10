import "server-only";
// Sponsor deals — the ONE owner of what a sponsor's deals do to its row (plan 2026-11-07-sponsor-deals D7/D8/D9, spec §5.3
// and §8a). Every path that moves a deal (the console's deal actions, the payment webhook, the dispute handler, the expiry
// sweep) ends by calling `applyDealsToSponsor` in its own transaction, and nothing else writes a deal's effect on a sponsor.
//
// One lock order, everywhere (F2): the sponsor row `for update`, then that sponsor's deals `for update` in (created_at, id)
// order, then re-check. A writer that starts from a deal reads its sponsor_id WITHOUT a lock, locks the sponsor through
// `lockSponsorAndDeals`, and only then re-checks the deal's state. Never a deal before its sponsor: two writes on two
// deals of one sponsor would deadlock (40P01).
//
// This module fires no public-page bust (F1): a console caller awaits `expirePublicSponsors` after its commit, and the
// webhook, dispute and sweep callers keep `deferred`. It exports nothing bust-shaped.
import type { Tx } from "@/lib/db";
import { sponsorRefusal } from "@/lib/sponsor-refusals";
import { pickRowDeal, type SponsorDeal } from "@/lib/sponsor-deals";
import type { SponsorTier } from "@/lib/sponsor-tiers";
import { ensureOrgStreamSettings } from "./stream-settings";

/** What `applyDealsToSponsor` did. `no_deals`: nothing written (no non-legacy deal, or every deal had already ended);
 *  `live` / `parked`: the live deal's snapshot is on the sponsor, active or held at pending by an open dispute;
 *  `hidden_open`: deals wait to go live, so the sponsor is hidden; `ended_all`: this call's caller ended the last live or
 *  open deal, and the sponsor went inactive — its placement reset only when a deal had written it (ruling (g)). */
export type ApplyOutcome = "no_deals" | "live" | "parked" | "hidden_open" | "ended_all";

/** A deal as the server reads it: the client-safe SponsorDeal plus the two money handles a server guard needs. */
export interface ServerDeal extends SponsorDeal {
  payment_intent_id: string | null;
  /** A stored Checkout session (Task 7 writes it). While one is open, the deal still has a payable link. */
  checkout_session_id: string | null;
  /** The stored session's pay link and its expiry (D14): reused while more than 10 minutes remain (F32). */
  checkout_url: string | null;
  checkout_expires_at: string | null;
  /** Invoices sent so far: the next send is `invoice_send_count + 1`, its Stripe key and its once-key. */
  invoice_send_count: number;
}

/** The sponsor row as `lockSponsorAndDeals` holds it. */
export interface LockedSponsor {
  id: string;
  org_id: string;
  status: "active" | "pending" | "inactive";
  tier: SponsorTier;
  competition_id: string | null;
  on_stream: boolean;
  /** Placement provenance (ruling (g), V493): the deal whose snapshot `tier`, `competition_id` and `on_stream` carry, set by
   *  the live write; null when the club set them by hand (or a hand PATCH of any of them has since taken them over). */
  placement_from_deal_id: string | null;
}

/** The sponsor_orders columns a deal is read from. The money column `status` is the API's `payment_status` (D1). */
const DEAL_ROW_COLS = [
  "id", "sponsor_id", "package_id", "deal_status", "status", "payment_method", "go_live", "package_name", "tier",
  "includes_on_stream", "competition_id", "amount_cents", "currency", "sponsor_name", "sponsor_email", "ends_at",
  "created_at", "created_by", "invoice_sent_at", "paid_at", "marked_paid_by", "approved_at", "approved_by", "live_at",
  "ended_at", "ended_reason", "parked_at", "disputed_at", "dispute_id", "payment_intent_id", "checkout_session_id",
  "checkout_url", "checkout_expires_at", "invoice_send_count",
] as const;

type Stamp = Date | string | null;
type DealRow = Omit<ServerDeal, "payment_status" | "invoice_number" | "has_payment_intent" | TimeKey> & {
  status: ServerDeal["payment_status"];
} & Record<TimeKey, Stamp>;
type TimeKey =
  | "ends_at" | "created_at" | "invoice_sent_at" | "paid_at" | "approved_at" | "live_at" | "ended_at" | "parked_at"
  | "disputed_at" | "checkout_expires_at";

const iso = (t: Stamp): string | null => (t === null ? null : new Date(t).toISOString());

function toServerDeal(r: DealRow): ServerDeal {
  return {
    id: r.id,
    sponsor_id: r.sponsor_id,
    package_id: r.package_id,
    deal_status: r.deal_status,
    payment_status: r.status,
    payment_method: r.payment_method,
    go_live: r.go_live,
    package_name: r.package_name,
    tier: r.tier,
    includes_on_stream: r.includes_on_stream,
    competition_id: r.competition_id,
    amount_cents: r.amount_cents,
    currency: r.currency,
    sponsor_name: r.sponsor_name,
    sponsor_email: r.sponsor_email,
    ends_at: iso(r.ends_at),
    created_at: iso(r.created_at)!,
    created_by: r.created_by,
    invoice_sent_at: iso(r.invoice_sent_at),
    paid_at: iso(r.paid_at),
    marked_paid_by: r.marked_paid_by,
    approved_at: iso(r.approved_at),
    approved_by: r.approved_by,
    live_at: iso(r.live_at),
    ended_at: iso(r.ended_at),
    ended_reason: r.ended_reason,
    parked_at: iso(r.parked_at),
    disputed_at: iso(r.disputed_at),
    dispute_id: r.dispute_id,
    // The client-safe twin of the intent (New-3): what a refund decides on, without the id.
    has_payment_intent: r.payment_intent_id !== null,
    // Numbered invoices are PR 3's (D11): no deal has a number before then.
    invoice_number: null,
    payment_intent_id: r.payment_intent_id,
    checkout_session_id: r.checkout_session_id,
    checkout_url: r.checkout_url,
    checkout_expires_at: iso(r.checkout_expires_at),
    invoice_send_count: r.invoice_send_count,
  };
}

/** A pre-deals order (D6): ignored by every deal rule, never a row's deal, never live. */
export const isLegacyDeal = (d: Pick<SponsorDeal, "ended_reason">): boolean => d.ended_reason === "legacy";
const isLive = (d: Pick<SponsorDeal, "deal_status">): boolean => d.deal_status === "live";
/** Waiting to go live: neither live nor ended (draft, awaiting payment or approval, scheduled). */
const isOpen = (d: Pick<SponsorDeal, "deal_status">): boolean => d.deal_status !== "live" && d.deal_status !== "ended";
/** The end date has been reached (`<=`: `ends_at = now` is over). No end date is never past. */
export const isPastEnd = (endsAt: Date | string | null, now: Date): boolean =>
  endsAt !== null && new Date(endsAt).getTime() <= now.getTime();

/**
 * F2's lock, the one order every deal writer takes: the sponsor `for update`, then ALL its deals `for update` in
 * (created_at, id) order (LockRows runs above the sort, so the rows lock in that order), legacy rows included. Null when the
 * sponsor is not there — or, under a tenant, is another org's. Re-locking rows the transaction already holds is a no-op.
 *
 * The deals are read in their OWN statement, after the sponsor lock is granted: a deal read folded into the locking
 * statement would answer from that statement's snapshot, taken before the wait, and miss a deal another writer made live
 * while this one waited (the F16 lock witness in sponsor-lock.test.ts).
 */
export async function lockSponsorAndDeals(
  tx: Tx,
  sponsorId: string,
): Promise<{ sponsor: LockedSponsor; deals: ServerDeal[] } | null> {
  const [sponsor] = await tx<LockedSponsor[]>`
    select id, org_id, status, tier, competition_id, on_stream, placement_from_deal_id
      from sponsors where id = ${sponsorId} for update`;
  if (!sponsor) return null;
  const rows = await tx<DealRow[]>`
    select ${tx(DEAL_ROW_COLS)} from sponsor_orders where sponsor_id = ${sponsorId}
     order by created_at, id for update`;
  return { sponsor, deals: rows.map(toServerDeal) };
}

/** A deal held under F2's lock, found from the deal. */
export interface LockedDeal {
  deal: ServerDeal;
  /** Every deal of its sponsor, locked, in (created_at, id) order; just the deal itself on a sponsor-less legacy row. */
  deals: ServerDeal[];
  /** Null on a legacy row (D6) with no sponsor: nothing to lock or apply, so the deal row itself is locked. */
  sponsorId: string | null;
  orgId: string;
}

/**
 * F2's lock for a writer that starts from a deal (the console's deal actions, the payment, refund and dispute webhooks): the
 * deal's sponsor_id read WITHOUT a lock, then `lockSponsorAndDeals`, then the deal found among the locked rows. Null when the
 * deal is gone, or moved to another sponsor, in between (the re-check). A sponsor-less legacy row (D6) locks only itself.
 * Never a deal before its sponsor.
 */
export async function lockDealAndSponsor(tx: Tx, dealId: string): Promise<LockedDeal | null> {
  const [ref] = await tx<{ sponsor_id: string | null; org_id: string }[]>`
    select sponsor_id, org_id from sponsor_orders where id = ${dealId}`;
  if (!ref) return null;
  if (ref.sponsor_id === null) {
    await tx`select 1 from sponsor_orders where id = ${dealId} for update`;
    const deal = await readDeal(tx, dealId);
    return deal && deal.sponsor_id === null ? { deal, deals: [deal], sponsorId: null, orgId: ref.org_id } : null;
  }
  const held = await lockSponsorAndDeals(tx, ref.sponsor_id);
  const deal = held?.deals.find((d) => d.id === dealId);
  return held && deal ? { deal, deals: held.deals, sponsorId: ref.sponsor_id, orgId: ref.org_id } : null;
}

/** Every deal of an org's sponsors (legacy rows included), unlocked, oldest first: the console list's read. */
export async function readOrgDeals(tx: Tx, orgId: string): Promise<ServerDeal[]> {
  const rows = await tx<DealRow[]>`
    select ${tx(DEAL_ROW_COLS)} from sponsor_orders where org_id = ${orgId} and sponsor_id is not null
     order by created_at, id`;
  return rows.map(toServerDeal);
}

/** One deal of the tenant's org (legacy rows included), unlocked; null when there is none — or, under a tenant, it is another
 *  org's. The read a deal writer answers with after its write, inside its transaction. */
export async function readDeal(tx: Tx, dealId: string): Promise<ServerDeal | null> {
  const [row] = await tx<DealRow[]>`select ${tx(DEAL_ROW_COLS)} from sponsor_orders where id = ${dealId}`;
  return row ? toServerDeal(row) : null;
}

/** The tenant org's deals, newest first (created_at, then id) — one sponsor's when `sponsorId` is given. Legacy rows are
 *  included, a sponsor-less one too (D6: the money history of a pre-deals order). The console's deal list. */
export async function readDeals(tx: Tx, opts: { sponsorId?: string } = {}): Promise<ServerDeal[]> {
  const rows = await tx<DealRow[]>`
    select ${tx(DEAL_ROW_COLS)} from sponsor_orders
     ${opts.sponsorId === undefined ? tx`` : tx`where sponsor_id = ${opts.sponsorId}`}
     order by created_at desc, id desc`;
  return rows.map(toServerDeal);
}

/** What a sponsor's console row says about its deals. */
export interface SponsorDealSummary {
  /** The deal the row shows: `pickRowDeal` over the sponsor's deals (legacy rows are never shown). */
  deal: SponsorDeal | null;
  /** A live deal exists: tier, scope, stream and status are the deal's (D9). */
  locked_by_deal: boolean;
  /** A deal waits to go live (draft, awaiting payment or approval, scheduled): status is held (D9). */
  has_open_deal: boolean;
  /** The billing email the Add deal sheet opens at (D22): the latest of this sponsor's deals that carries one. */
  last_billing_email: string | null;
}

/** The summary of ONE sponsor's deals (any order; legacy rows may be among them). Computed here, never in SQL. */
export function sponsorDealSummary(deals: readonly ServerDeal[]): SponsorDealSummary {
  const current = deals.filter((d) => !isLegacyDeal(d));
  const shown = pickRowDeal(current);
  let latest: ServerDeal | null = null;
  for (const d of deals) {
    if (d.sponsor_email === null) continue;
    if (latest === null || d.created_at > latest.created_at || (d.created_at === latest.created_at && d.id > latest.id)) {
      latest = d;
    }
  }
  return {
    deal: shown === null ? null : clientDeal(shown as ServerDeal),
    locked_by_deal: current.some(isLive),
    has_open_deal: current.some(isOpen),
    last_billing_email: latest?.sponsor_email ?? null,
  };
}

/** A ServerDeal without its money handles: the shape the console and the API carry. The pay link is never on the deal
 *  (F11): it is answered once, by the call that minted or reused it. */
export function clientDeal(d: ServerDeal): SponsorDeal {
  const {
    payment_intent_id: _intent,
    checkout_session_id: _session,
    checkout_url: _url,
    checkout_expires_at: _expires,
    invoice_send_count: _sends,
    ...deal
  } = d;
  return deal;
}

/** D9 (spec §8a "what a live deal locks"): the sponsor fields a live deal owns. */
const LOCKED_BY_LIVE_DEAL = ["tier", "competition_id", "on_stream", "status"] as const;

/**
 * D9: a PATCH naming any of `fields` on a sponsor with these deals. A live deal owns tier, scope, stream and status (409
 * `sponsor_locked_by_deal`); a deal waiting to go live holds status only (409 `sponsor_has_open_deal`), since apply hides
 * the sponsor until it is live. Name, url and logo are always editable, and once every deal has ended (legacy rows count
 * as ended) the sponsor is back under manual control. The caller holds the sponsor lock (F16), so the deals are current.
 */
export function assertSponsorPatchAllowed(deals: readonly ServerDeal[], fields: readonly string[]): void {
  const current = deals.filter((d) => !isLegacyDeal(d));
  if (current.some(isLive) && LOCKED_BY_LIVE_DEAL.some((f) => fields.includes(f))) {
    throw sponsorRefusal(
      409,
      "this sponsor has a live deal: its tier, scope, stream and visibility come from the deal — end the deal or add a new one to change them",
      "sponsor_locked_by_deal",
    );
  }
  if (current.some(isOpen) && fields.includes("status")) {
    throw sponsorRefusal(
      409,
      "this sponsor has a deal waiting to go live: it shows once that deal is live",
      "sponsor_has_open_deal",
    );
  }
}

type SponsorWrite = Pick<LockedSponsor, "status"> &
  Partial<Pick<LockedSponsor, "tier" | "competition_id" | "on_stream" | "placement_from_deal_id">>;

async function writeSponsor(tx: Tx, sponsorId: string, w: SponsorWrite): Promise<void> {
  const cols = Object.keys(w) as (keyof SponsorWrite)[];
  await tx`update sponsors set ${tx(w as never, ...(cols as never[]))} where id = ${sponsorId}`;
}

/**
 * Apply a sponsor's deals to its row (D8, the order matters). The CALLER holds the sponsor lock (F2): it locked the sponsor
 * before it read and moved any deal. This re-takes the same lock through `lockSponsorAndDeals` — a no-op for that caller,
 * and the order's guarantee for any that did not — and refuses a sponsor that is not there.
 *
 *  1. Legacy rows are ignored (D6). No other deal: `no_deals`, nothing written (manual control, §8a "1 Ok").
 *  2. No live deal: the earliest `scheduled` one (created_at, id) whose own `ends_at` has not passed goes live, `live_at = now`
 *     (§8a queue, Review Focus 5; F19: a past-end one is left for the sweep to end, whoever ended the live deal).
 *  3. A live deal: the sponsor takes its snapshot (tier, scope, stream) and `active`, or `pending` while a dispute parks it,
 *     and records that deal as its placement's provenance (ruling (g)). An on-stream deal turns the org's rotation on the way
 *     the first tick does (R12).
 *  4. Else, a deal waiting to go live: `inactive`, and nothing else (hidden until live). A placement a deal swapped out by
 *     end_current wrote stays on the row, with its provenance, until the last open deal ends.
 *  5. Else every deal has ended. ONLY on the transition — `endedDealId` names the deal this call's caller just moved from
 *     live or open to ended — the sponsor goes inactive (`ended_all`). Its tier, scope and stream are reset (partner, whole
 *     org, off the stream) ONLY when a deal wrote them (`placement_from_deal_id` set), and the provenance is cleared: a
 *     placement the club set by hand is the club's, so ending a deal that never went live never wipes it (ruling (g); spec
 *     §5.1, §5.3). Any other apply that finds every deal ended writes nothing (`no_deals`), so a late event on an old deal (a
 *     dispute created or closed, a refund of an ended deal) never undoes the club's hand switch-back-on (F7, spec §10 Q3).
 *
 * Fires no bust (F1); the caller expires the public pages after its commit.
 */
export async function applyDealsToSponsor(
  tx: Tx,
  sponsorId: string,
  actorUserId: string | null,
  opts: { now?: Date; endedDealId?: string | null } = {},
): Promise<{ outcome: ApplyOutcome; promotedDealId: string | null }> {
  const now = opts.now ?? new Date();
  const locked = await lockSponsorAndDeals(tx, sponsorId);
  if (!locked) {
    throw new Error(`applyDealsToSponsor: no sponsor ${sponsorId} — its caller locks the sponsor before it moves a deal (F2)`);
  }
  const deals = locked.deals.filter((d) => !isLegacyDeal(d));
  const endedDealId = opts.endedDealId ?? null;
  if (endedDealId !== null) {
    const ended = deals.find((d) => d.id === endedDealId);
    if (!ended || ended.deal_status !== "ended") {
      throw new Error(
        `applyDealsToSponsor: endedDealId ${endedDealId} is not an ended deal of sponsor ${sponsorId} — pass it only for ` +
          "the deal this call moved from live or open to ended (F7)",
      );
    }
  }
  if (deals.length === 0) return { outcome: "no_deals", promotedDealId: null };

  let live = deals.find(isLive) ?? null;
  let promotedDealId: string | null = null;
  if (live === null) {
    // `deals` is in (created_at, id) order, so the first scheduled deal is the head of the queue. A scheduled deal whose own
    // end has already passed is never promoted (F19): it would go live for the hour until the sweep ends it. It stays
    // scheduled (the sponsor stays hidden behind it, below) for that sweep to end `expired`.
    const next = deals.find((d) => d.deal_status === "scheduled" && !isPastEnd(d.ends_at, now));
    if (next) {
      await tx`update sponsor_orders set deal_status = 'live', live_at = ${now} where id = ${next.id}`;
      live = { ...next, deal_status: "live", live_at: now.toISOString() };
      promotedDealId = next.id;
    }
  }

  if (live !== null) {
    const parked = live.parked_at !== null;
    await writeSponsor(tx, sponsorId, {
      status: parked ? "pending" : "active",
      tier: live.tier,
      competition_id: live.competition_id,
      on_stream: live.includes_on_stream,
      placement_from_deal_id: live.id,
    });
    if (live.includes_on_stream) await ensureOrgStreamSettings(tx, locked.sponsor.org_id, actorUserId);
    return { outcome: parked ? "parked" : "live", promotedDealId };
  }

  if (deals.some(isOpen)) {
    await writeSponsor(tx, sponsorId, { status: "inactive" });
    return { outcome: "hidden_open", promotedDealId: null };
  }

  if (endedDealId !== null) {
    // Ruling (g): D8's reset undoes what a DEAL wrote. A placement with no provenance is the club's own (set by hand, or taken
    // over by a hand PATCH since): only the status changes.
    await writeSponsor(
      tx,
      sponsorId,
      locked.sponsor.placement_from_deal_id !== null
        ? { status: "inactive", tier: "partner", competition_id: null, on_stream: false, placement_from_deal_id: null }
        : { status: "inactive" },
    );
    return { outcome: "ended_all", promotedDealId: null };
  }
  return { outcome: "no_deals", promotedDealId: null };
}
