import "server-only";
// Sponsor CRM (v10 PROMPT-56): first-class sponsor rows with tiers +
// per-competition scoping. The rows are the ONLY source (R4 fix batch 3: the
// legacy `branding.sponsors` blob is neither written nor read, and V492
// strips it). Tiers and competition scoping are the Pro line
// (`sponsors.tiers`); the un-tiered partner strip is free on every plan.
// Monetization (`sponsors.monetize`) sells priced packages over the entry-fee
// Connect rail: destination charge, platform application fee, billing-events
// webhook activation.
import type Stripe from "stripe";
import { z } from "zod";
import { sql, withTenant, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { sponsorRefusal } from "@/lib/sponsor-refusals";
import { requireFeature } from "@/lib/entitlements";
import { isPosterUrl, isRedirectableUrl, SPONSOR_URL_HTTP_ONLY } from "@/lib/sponsor-clicks";
import { patchOf } from "@/lib/zod-patch";
import { getStripe } from "@/lib/stripe";
import {
  sponsorInvoiceEmail,
  sponsorReceiptEmail,
  sponsorDealPaidEmail,
  sponsorRefundEmail,
  sponsorDisputeAlertEmail,
  sponsorDisputeWonEmail,
  sponsorDisputeLostEmail,
} from "@/lib/email";
import { deferred } from "@/lib/deferred";
import {
  dispatchNow,
  enqueueEmailOnce,
  expiryWithin,
  onceKey,
  recipientLocale,
} from "@/server/email-outbox";
import { log } from "@/server/logger";
import { expireCompetitionShell, fireOrgRevalidate } from "@/server/public-site/revalidate";
import type { AuthCtx } from "@/server/api-v1/auth";
import { applicationFeeCents, feePercentFor } from "./registrations";
import { recoverDisputedTransfer as recoverDisputedTransferCore } from "./dispute-recovery";
import { orgOwnerRecipient } from "./org-owner";
import { routes } from "@/lib/routes";
import { dealHref, sponsorsHref } from "@/lib/sponsors-hub";
import type { DealPaidNext, SponsorInvoiceArgs } from "@/lib/email-templates";
import { SPONSOR_TIERS, type SponsorTier } from "@/lib/sponsor-tiers";
import { placementNeedsTiers } from "@/lib/sponsor-deal-policy";
import { assertPlacementAllowed } from "@/server/sponsors/deal-gates";
import { ensureOrgStreamSettings } from "@/server/sponsors/stream-settings";
import { blocksArchive, DealRuleError, statusAfterPaid, type DealStatus, type PaymentStatus, type SponsorDeal } from "@/lib/sponsor-deals";
import { captureError } from "@/lib/sentry";
import {
  applyDealsToSponsor,
  assertSponsorPatchAllowed,
  isLegacyDeal,
  lockDealAndSponsor,
  lockSponsorAndDeals,
  readDeals,
  readOrgDeals,
  sponsorDealSummary,
  type LockedDeal,
  type ServerDeal,
  type SponsorDealSummary,
} from "@/server/sponsors/deal-apply";

// The tier list lives in the client-safe lib (R4 F10: this module imports the email outbox, so the planner and the
// overlay cannot import it). Re-exported, never re-declared — one authority.
export { SPONSOR_TIERS, type SponsorTier };

/** A sponsor row. Its deal summary (sponsor deals D8/D9: `deal`, `locked_by_deal`, `has_open_deal`, `last_billing_email`)
 *  rides on every read and write answer, computed by `sponsorDealSummary` from the sponsor's deals. */
export interface SponsorRow extends SponsorDealSummary {
  id: string;
  competition_id: string | null;
  name: string;
  url: string | null;
  logo_path: string | null;
  /** The optional 4:5 poster a Title sponsor shows in the public competition hero (V501). Holds the public CDN URL, as
   *  `logo_path` does; null means the hero draws the logo card instead. */
  poster_path: string | null;
  tier: SponsorTier;
  display_order: number;
  status: "active" | "pending" | "inactive";
  click_count: number;
  created_at: string;
  /** Ticked onto the stream's rotation (V492; R4 S12). Written only by PATCH; a created sponsor starts false. */
  on_stream: boolean;
  /** When the club archived this sponsor (V508, archive spec D8), or null. Orthogonal to `status`: an archived sponsor is hidden
   *  everywhere and keeps every record. Written ONLY by `archiveSponsor` / `unarchiveSponsor`, never by a PATCH (D11). */
  archived_at: string | null;
  /** The paid order that activated this placement, when it was bought
   *  through a package (list reads only — write paths return it unset). */
  paid_order_id?: string | null;
  /** Terminal outcome: a lost dispute wrote the paid order off — the
   *  placement stayed down and the row explains why (list reads only). */
  dispute_lost?: boolean;
  /** True while the dispute handler has the placement parked: its paid order
   *  carries an OPEN dispute (paid + disputed_at) AND the placement is down
   *  ('pending', the handler's park). An inquiry flags the order but leaves
   *  the placement live, so this stays false until the money is taken.
   *  Cleared when the dispute is won; a lost dispute flips the order off
   *  'paid' so this goes false with it (list reads only). */
  dispute_parked?: boolean;
}

const COLS = [
  "id", "competition_id", "name", "url", "logo_path", "poster_path",
  "tier", "display_order", "status", "click_count", "created_at", "on_stream", "archived_at",
] as const;

export const CreateSponsorInput = z.object({
  // Trimmed BEFORE it is measured (sponsor deals batch J review m3): "   " is no name, and the v1 API is not the form that trims in the
  // browser. patchOf below makes the same field the patch's.
  name: z.string().trim().min(1).max(80),
  // http(s) only (R4 S10 fix round 1, m1): zod's `.url()` alone accepts `javascript:` and `data:`, and this url is a
  // redirect target (`/s/[key]`) and a board's href.
  url: z.string().url().max(500).refine(isRedirectableUrl, { message: SPONSOR_URL_HTTP_ONLY }).nullish(),
  logo_path: z.string().max(500).nullish(),
  // Title sponsor poster (V501): an absolute http(s) URL of at most 500 characters, the DB's `sponsors_poster_path_check` is the
  // second guard. next/image throws on a src that is neither absolute nor `/`-rooted, so unlike `logo_path` this is never a bare
  // storage path; and a `javascript:` or `data:` value is refused here for the same reason `url` is.
  poster_path: z.string().url().max(500).refine(isPosterUrl, { message: SPONSOR_URL_HTTP_ONLY }).nullish(),
  tier: z.enum(SPONSOR_TIERS).default("partner"),
  competition_id: z.string().uuid().nullish(),
  status: z.enum(["active", "pending", "inactive"]).default("active"),
});
export type CreateSponsorInput = z.infer<typeof CreateSponsorInput>;

/** The create's `patchOf` twin (final review 2, m5): zod 4's `.partial()` on a field that `.default()`s still FILLS it when
 *  omitted, so a patch derived that way rewrote `tier` to "partner" and `status` to "active" on every PATCH that did not
 *  name them (R4 S12 found it on the first tick: a Title sponsor ticked onto the stream came back a Partner, and a parked
 *  one came back active). `on_stream` (R4 S12, controller row 30) is PATCH-ONLY and snake_case: `patchSponsor` writes the
 *  body's keys as columns. A created sponsor starts off the stream (V492's default), so `CreateSponsorInput` does not
 *  carry it. */
export const PatchSponsorInput = patchOf(CreateSponsorInput).extend({ on_stream: z.boolean().optional() });
export type PatchSponsorInput = z.infer<typeof PatchSponsorInput>;

export const ReorderSponsorsInput = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});
export type ReorderSponsorsInput = z.infer<typeof ReorderSponsorsInput>;

/** Tiers above `partner` and per-competition scoping are Pro
 *  (`sponsors.tiers`). Passing the competition lets an Event Pass lift the
 *  gate for its own competition, mirroring entry fees.
 *
 *  NOTE the asymmetry, which is intended and newly reachable: a non-partner
 *  tier with a NULL `competition_id` resolves ORG-WIDE. There is no competition
 *  to hand the resolver, so a pass holder gets the community answer and a 402 —
 *  the pass buys a tier ON ITS OWN COMPETITION, not org-wide sponsor tiers, and
 *  granting it here would be the leak the pass-scoping guard exists to stop.
 *
 *  This used to be unreachable: the settings tab hid the control from pass
 *  holders entirely. It now offers it (page.tsx asks `hasFeatureOnAnyPass`, an
 *  affordance question), so a pass holder CAN save an unscoped tiered sponsor
 *  and be refused. That surfaces as an error toast, not a silent no-op, so the
 *  failure is legible — pick the competition and it saves.
 *
 *  WHICH placements need the key is `placementNeedsTiers`'s answer (sponsor deals D17, F14; spec §10 Q1), the one
 *  predicate sponsors, packages and deals share — never re-decided here. A patch that names neither field judges what
 *  it introduces: an absent tier reads as partner and an absent scope as the whole org. */
async function assertTierAllowed(
  orgId: string,
  tier: SponsorTier | undefined,
  competitionId: string | null | undefined,
): Promise<void> {
  if (placementNeedsTiers(tier ?? "partner", competitionId ?? null)) {
    await requireFeature(orgId, "sponsors.tiers", competitionId ?? undefined);
  }
}

/** The competition an existing sponsor already sits on, so a patch that only
 *  moves the TIER is still judged against a competition. Tenant-scoped: a
 *  sponsor id from another org resolves to null, never to that org's scope. */
async function sponsorCompetitionId(orgId: string, id: string): Promise<string | null> {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx<{ competition_id: string | null }[]>`
      select competition_id from sponsors where id = ${id}`;
    return row?.competition_id ?? null;
  });
}

/** An ORGANISER's sponsor write (create, edit, reorder, delete, console refund): its author looks at the public page next, so the org tag
 *  expires BEFORE the use-case resolves - `expireCompetitionShell` awaits the slug and fires `{ expire: 0 }` inside the
 *  request (Next applies a request's revalidations when its handler finishes) and never rejects, the write having
 *  committed. Never `bustPublicSponsors` here: its `deferred` is Next's `after()`, which runs once the response has gone
 *  and fires its tags only when every tail task is done - smoke job 128625643038 read a free org's public page 3 ms after
 *  the 201 and was served the cached page without the new partner sponsor. Exported for the deal usecases (sponsor deals F1):
 *  every console deal action awaits it after its commit. */
export async function expirePublicSponsors(orgId: string, op: string): Promise<void> {
  await expireCompetitionShell(orgId, { op });
}

/** Sponsor changes nobody reads back at once: the same bust as tail work. Its only callers are `handleSponsorDispute`'s
 *  four branches. The paid-order and charge.refunded webhooks defer `fireOrgRevalidate` inline instead, after their own
 *  slug read. */
function bustPublicSponsors(orgId: string): void {
  deferred(async () => {
    const [org] = await sql<{ slug: string }[]>`
      select slug from organizations where id = ${orgId}`;
    if (org) fireOrgRevalidate(org.slug);
  });
}

/** What a sponsor list reads beyond the org's live rows. `includeArchived` (archive spec §6.2, D12): archived rows too, each with
 *  its `archived_at` - the console's Sponsors tab (its "Show archived (N)" switch needs N and the rows) and `GET /sponsors?archived=1`.
 *  By default an archived row is left out (the On stream tab, the plain `GET /sponsors`). */
export interface ListSponsorsOptions {
  includeArchived?: boolean;
}

/** Plain read for server pages (settings) — same rows as listSponsors.
 *  paid_order_id links a placement back to the package order that bought
 *  it, so the manager can mark it and guard its deletion. */
export async function listSponsorRows(orgId: string, opts: ListSponsorsOptions = {}): Promise<SponsorRow[]> {
  return withTenant(orgId, async (tx) => {
    const rows = await tx<Omit<SponsorRow, keyof SponsorDealSummary>[]>`
    select ${tx(COLS)},
           (select o.id from sponsor_orders o
            where o.sponsor_id = sponsors.id and o.status = 'paid'
            limit 1) as paid_order_id,
           -- Parked: a dispute holds the sponsor's LIVE deal (its parked_at), which applyDealsToSponsor holds at pending.
           exists(select 1 from sponsor_orders o
                  where o.sponsor_id = sponsors.id and o.deal_status = 'live'
                    and o.parked_at is not null) as dispute_parked,
           exists(select 1 from sponsor_orders o
                  where o.sponsor_id = sponsors.id and o.status = 'refunded'
                    and o.dispute_id is not null) as dispute_lost
    from sponsors
    ${opts.includeArchived === true ? tx`` : tx`where archived_at is null`}
    order by array_position(${[...SPONSOR_TIERS]}::text[], tier),
             display_order, created_at, id`;
    // The deal summary is computed in TS from the deals themselves (pickRowDeal), never a SQL copy of the selection.
    const bySponsor = new Map<string, ServerDeal[]>();
    for (const d of await readOrgDeals(tx, orgId)) {
      const list = bySponsor.get(d.sponsor_id!) ?? [];
      list.push(d);
      bySponsor.set(d.sponsor_id!, list);
    }
    return rows.map((r) => ({ ...r, ...sponsorDealSummary(bySponsor.get(r.id) ?? []) }));
  });
}

export async function listSponsors(auth: AuthCtx, opts: ListSponsorsOptions = {}): Promise<SponsorRow[]> {
  return listSponsorRows(auth.orgId, opts);
}

export async function createSponsor(
  auth: AuthCtx,
  input: CreateSponsorInput,
): Promise<SponsorRow> {
  await assertTierAllowed(auth.orgId, input.tier, input.competition_id);
  return withTenant(auth.orgId, async (tx) => {
    if (input.competition_id) {
      const [comp] = await tx`select 1 from competitions where id = ${input.competition_id}`;
      if (!comp) throw new HttpError(404, "competition not found");
    }
    const [row] = await tx<SponsorRow[]>`
      insert into sponsors (org_id, competition_id, name, url, logo_path, poster_path,
                            tier, display_order, status)
      values (${auth.orgId}, ${input.competition_id ?? null}, ${input.name},
              ${input.url ?? null}, ${input.logo_path ?? null}, ${input.poster_path ?? null}, ${input.tier},
              (select coalesce(max(display_order), -1) + 1 from sponsors
               where competition_id is not distinct from ${input.competition_id ?? null}
                 and tier = ${input.tier}),
              ${input.status})
      returning ${tx(COLS)}`;
    return { ...row!, ...sponsorDealSummary([]) };
  }).then(async (row) => {
    await expirePublicSponsors(auth.orgId, "sponsor.create");
    return row;
  });
}

/** The sponsor fields that make up its placement: what a live deal writes (deal-apply.ts step 3) and what a hand PATCH takes
 *  over from it (ruling (g)). */
const PLACEMENT_FIELDS = ["tier", "competition_id", "on_stream"] as const;

export async function patchSponsor(
  auth: AuthCtx,
  id: string,
  patch: PatchSponsorInput,
): Promise<SponsorRow> {
  const cols = Object.keys(patch);
  if (cols.length === 0) throw new HttpError(400, "empty patch");
  // Gate only what the patch introduces: promoting to a paid tier or scoping
  // to a competition needs sponsors.tiers. Editing name/url/logo on an
  // existing tiered sponsor stays allowed after a downgrade.
  //
  // The scope is the competition the sponsor ENDS UP on — the patch's own
  // `competition_id` when the patch sets one, otherwise the row's existing one.
  // Reading only the patch resolved a plain `{ tier: "title" }` promotion
  // ORG-WIDE, and lib/entitlements.ts consults `competition_passes` only when a
  // competition is in scope, so an Event Pass holder was refused the promotion
  // on the very competition they had paid to tier. The pass-scoping guard could
  // not see it: the argument was present, just carrying `undefined`.
  //
  // The extra read costs one query, and only on a promotion that does not
  // already name a competition — `{ name }` / `{ status }` patches are
  // untouched. Unscoping (`competition_id: null`) still resolves org-wide and
  // is still refused; that asymmetry is deliberate, see assertTierAllowed.
  const scope =
    "competition_id" in patch
      ? patch.competition_id
      : patch.tier && patch.tier !== "partner"
        ? await sponsorCompetitionId(auth.orgId, id)
        : undefined;
  // The plan gate runs FIRST, before the transaction: on a plan without `sponsors.tiers` a tier or scope PATCH answers 402
  // before any deal lock is consulted (sponsor deals F16).
  await assertTierAllowed(auth.orgId, patch.tier, scope);
  return withTenant(auth.orgId, async (tx) => {
    // ONE unconditional sponsor lock, for every patch (sponsor deals F16), in the one order every deal writer takes (F2):
    // the sponsor, then its deals. Every deal writer holds this lock while it moves a deal, so the deals read under it are
    // current — a deal another transaction made live while this PATCH waited is seen, and locks the patch below.
    const locked = await lockSponsorAndDeals(tx, id);
    if (!locked) throw new HttpError(404, "sponsor not found");
    // Archive spec D11: an archived sponsor's page is read-only, so ANY patch is refused - one rule, not a per-field list. Read
    // under the lock, so an archive committed while this PATCH waited is seen.
    if (locked.sponsor.archived_at !== null) throw sponsorArchived();
    // A placement parked by an open dispute (its paid order is flagged and
    // the handler took it down to 'pending') stays down until the dispute
    // closes — reactivating it by hand would put a charged-back sponsor
    // back on boards and public pages. Any status change is refused, not
    // just `active`: switched to `inactive` it would no longer read as
    // parked, and `active` would then pass. An inquiry flags the order but
    // leaves the placement live, so the organiser manages it as normal.
    // Checked before the deal lock, so a parked placement keeps saying why.
    if (patch.status !== undefined && patch.status !== "pending") {
      const openDispute = locked.deals.some((o) => o.payment_status === "paid" && o.disputed_at !== null);
      if (locked.sponsor.status === "pending" && openDispute) {
        throw sponsorRefusal(
          409,
          "this placement is parked by an open payment dispute — it comes back automatically if the dispute is won",
          "sponsor_dispute_parked",
        );
      }
    }
    // D9: a live deal owns tier, scope, stream and status; a deal waiting to go live holds status.
    assertSponsorPatchAllowed(locked.deals, cols);
    // Ruling (g): a hand write of the placement (tier, scope, or the On-stream tick) makes it the club's, so the reset that
    // undoes a deal's snapshot when its last deal ends (deal-apply.ts step 5) leaves it alone. Name, url, logo and status
    // writes leave the provenance as it is.
    const write: Record<string, unknown> = PLACEMENT_FIELDS.some((f) => cols.includes(f))
      ? { ...patch, placement_from_deal_id: null }
      : patch;
    const [row] = await tx<Omit<SponsorRow, keyof SponsorDealSummary>[]>`
      update sponsors set ${tx(write as never, ...(Object.keys(write) as never[]))}
      where id = ${id} returning ${tx(COLS)}`;
    // R12: the first tick turns the org's rotation on. After the update (a refused tick leaves no row), in its transaction.
    if (patch.on_stream === true) await ensureOrgStreamSettings(tx, auth.orgId, auth.userId);
    return { ...row!, ...sponsorDealSummary(locked.deals) };
  }).then(async (row) => {
    await expirePublicSponsors(auth.orgId, "sponsor.patch");
    return row;
  });
}

/** Money a deal holds as history: once paid (and so once refundable or refunded), its record is the audit trail. */
const MONEY_HISTORY: ReadonlySet<PaymentStatus> = new Set<PaymentStatus>(["paid", "refunded"]);

/** A deal that holds its sponsor (product ruling 2026-11-09, sponsor deals Task 5): it carries money or document history —
 *  money paid or refunded, an invoice number (Task 20, F10: a numbered invoice is a document, and its number is never reused,
 *  spec §7) — or it is a pre-deals legacy order (F16: the RESTRICT key covers it). Every other deal (a draft, an unpaid or
 *  failed one, a complimentary one, live or ended, with no number) goes with its sponsor. A stored Checkout session no longer
 *  holds it (Task 7, F3): `deleteSponsor` retires the session first, and refuses only when it cannot. The tenant's prune policy
 *  (V300's fence, widened by the sponsor-deals delta and narrowed again by the invoices delta's `invoice_number is null`) admits
 *  exactly the others once their session is cleared, so each refusal here is a 409, never a 23503. */
function dealHoldsHistory(d: ServerDeal): boolean {
  return MONEY_HISTORY.has(d.payment_status) || d.invoice_number !== null || isLegacyDeal(d);
}

const holdsHistory = () =>
  sponsorRefusal(
    409,
    "this sponsor has deal history (money paid or refunded, a numbered invoice, or a pre-deals order) — archive it instead",
    "sponsor_has_deal_history",
  );
const holdsOpenCheckout = () =>
  sponsorRefusal(
    409,
    "this sponsor has a deal whose payment link could not be closed, or was just paid — try again in a moment, or end the deal instead",
    "sponsor_has_open_checkout",
  );

/**
 * Delete a sponsor with its deals. Refused (409 `sponsor_has_deal_history`) while a deal holds money or document history
 * (`dealHoldsHistory`: a numbered invoice too, F10) — read FIRST, so a
 * delete that will be refused never closes a payment link. Then the session rule (F3), outside any transaction: every stored
 * Checkout session is retired; a completed one (money in flight) or an open one that cannot be expired refuses the delete (409
 * `sponsor_has_open_checkout`), because a later payment on a deleted deal would take money and record nothing. Each retired
 * session is forgotten at once, committed (`forgetDeadSession`), so the deals hold no session. Then ONE transaction in the one
 * lock order (F2) re-checks both — a session still stored was minted since, so it is payable and refuses — and deletes.
 */
export async function deleteSponsor(auth: AuthCtx, id: string): Promise<void> {
  const before = await withTenant(auth.orgId, (tx) => readDeals(tx, { sponsorId: id }));
  if (before.some(dealHoldsHistory)) throw holdsHistory();
  // Every refusal before the first expire (review I1): Stripe is asked about EVERY stored session first, so a completed one
  // (money in flight) or one nobody can read refuses the delete with no link closed. Then each open one is expired and
  // forgotten in its own statement: a later failure leaves no dead link stored on a deal that stays.
  // Since the invoices delta (Task 20, F10) this branch is reachable ONLY for an online deal made before that delta: every online
  // deal created since carries an invoice number, which `dealHoldsHistory` refused above, and the only other unnumbered online
  // rows (a webhook's duplicate payment) are paid, so they are refused there too. It stays for those pre-delta rows (staging).
  const held = before.flatMap((d): WithSession[] =>
    d.checkout_session_id === null ? [] : [{ id: d.id, checkout_session_id: d.checkout_session_id }]);
  const asStripeRefusal = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpError && err.status === 502) throw holdsOpenCheckout();
      throw err;
    }
  };
  const statuses: SessionStatus[] = [];
  for (const d of held) {
    const status = await asStripeRefusal(() => storedSessionStatus(d));
    if (status === "complete") throw holdsOpenCheckout();
    statuses.push(status);
  }
  for (const [i, d] of held.entries()) {
    await asStripeRefusal(() => (statuses[i] === "open" ? expireOpenSession(auth.orgId, d) : forgetDeadSession(auth.orgId, d)));
  }
  return withTenant(auth.orgId, async (tx) => {
    // The one lock order (F2): the sponsor, then its deals — legacy rows included, since the RESTRICT key covers them.
    const locked = await lockSponsorAndDeals(tx, id);
    if (!locked) throw new HttpError(404, "sponsor not found");
    if (locked.deals.some(dealHoldsHistory)) throw holdsHistory();
    // Every retired session was forgotten above, so a session still stored was minted since the read: it is still payable.
    // With none stored, the prune policy admits the rows.
    if (locked.deals.some((d) => d.checkout_session_id !== null)) throw holdsOpenCheckout();
    if (locked.deals.length > 0) await tx`delete from sponsor_orders where sponsor_id = ${id}`;
    await tx`delete from sponsors where id = ${id}`;
  }).then(() => expirePublicSponsors(auth.orgId, "sponsor.delete"));
}

/** Archive spec D4, D9: a deal still holds the sponsor (`blocksArchive`: live, open, or ended with money still due). */
const holdsCurrentDeal = () =>
  sponsorRefusal(409, "this sponsor has a deal that is live, waiting to go live or still due — end or settle it first", "sponsor_has_current_deal");

/** Archive spec D10, D11: an archived sponsor takes no edit and no new deal until it is unarchived. Exported for `createDeal`
 *  (usecases/sponsor-deals.ts), which refuses it twice: early, and again under the sponsor lock. */
export const sponsorArchived = () =>
  sponsorRefusal(409, "this sponsor is archived — unarchive it first", "sponsor_archived");

/**
 * Archive a sponsor (archive spec §6.2, D8, D9): it is hidden from the console list, every public surface, the stream and the `/s/`
 * redirect, and every record stays (deals, invoice numbers, payments, click counts). ONE transaction in the one lock order (F2):
 * the sponsor, then its deals - so a deal another writer is moving is seen, and `createDeal`'s own re-check under the same lock
 * sees this archive. Then:
 *  1. not there (or another org's, under the tenant) - 404;
 *  2. already archived - the row as it is: idempotent, the FIRST `archived_at` kept;
 *  3. a deal holds it (`blocksArchive`, the one rule the console's Archive card reads too) - 409 `sponsor_has_current_deal`;
 *  4. `archived_at = now()`, and nothing else: status, tier, scope, stream tick, order, logo and poster stay, so Unarchive is
 *     exact by construction.
 * Ungated (D25): every plan. The public pages expire before it resolves (D22).
 */
export async function archiveSponsor(auth: AuthCtx, id: string): Promise<SponsorRow> {
  const row = await withTenant(auth.orgId, async (tx) => {
    const locked = await lockSponsorAndDeals(tx, id);
    if (!locked) throw new HttpError(404, "sponsor not found");
    if (locked.sponsor.archived_at !== null) return readSponsorRow(tx, id, locked.deals);
    if (locked.deals.some((d) => blocksArchive(d))) throw holdsCurrentDeal();
    const [updated] = await tx<Omit<SponsorRow, keyof SponsorDealSummary>[]>`
      update sponsors set archived_at = now() where id = ${id} returning ${tx(COLS)}`;
    return { ...updated!, ...sponsorDealSummary(locked.deals) };
  });
  await expirePublicSponsors(auth.orgId, "sponsor.archive");
  log.info({ orgId: auth.orgId, sponsorId: id }, "sponsor_archived");
  return row;
}

/** Unarchive (archive spec §6.2, D6): the sponsor comes back exactly as it was - `archived_at` is the only column Archive wrote.
 *  The lock order of every sponsor write (F2); 404 as Archive; a sponsor that is not archived answers as it is (idempotent).
 *  A later new deal works normally. */
export async function unarchiveSponsor(auth: AuthCtx, id: string): Promise<SponsorRow> {
  const row = await withTenant(auth.orgId, async (tx) => {
    const locked = await lockSponsorAndDeals(tx, id);
    if (!locked) throw new HttpError(404, "sponsor not found");
    if (locked.sponsor.archived_at === null) return readSponsorRow(tx, id, locked.deals);
    const [updated] = await tx<Omit<SponsorRow, keyof SponsorDealSummary>[]>`
      update sponsors set archived_at = null where id = ${id} returning ${tx(COLS)}`;
    return { ...updated!, ...sponsorDealSummary(locked.deals) };
  });
  await expirePublicSponsors(auth.orgId, "sponsor.unarchive");
  log.info({ orgId: auth.orgId, sponsorId: id }, "sponsor_unarchived");
  return row;
}

/** A sponsor row as the writes answer it, with its deal summary, read inside the caller's transaction (which holds the lock). */
async function readSponsorRow(tx: Tx, id: string, deals: ServerDeal[]): Promise<SponsorRow> {
  const [row] = await tx<Omit<SponsorRow, keyof SponsorDealSummary>[]>`select ${tx(COLS)} from sponsors where id = ${id}`;
  if (!row) throw new Error(`sponsor ${id} vanished while this transaction held its lock`);
  return { ...row, ...sponsorDealSummary(deals) };
}

/** Persist a new display order: `ids` in the order they should render.
 *  Order is scoped per (scope, tier) group by the reads, so indices are
 *  simply assigned in sequence — groups keep their relative order.
 *
 *  An ARCHIVED id is skipped, not refused: the console sends every id of the
 *  list it shows, archived rows included, and an archived row keeps its order
 *  so that unarchive is exact (archive spec §9). The skip is the update's own
 *  `archived_at is null`, so an archive that commits first is re-checked on
 *  the row itself; it is not counted in `reordered`. An unknown id is 422. */
export async function reorderSponsors(
  auth: AuthCtx,
  input: ReorderSponsorsInput,
): Promise<{ reordered: number }> {
  return withTenant(auth.orgId, async (tx) => {
    let reordered = 0;
    for (let i = 0; i < input.ids.length; i++) {
      const id = input.ids[i]!;
      const [row] = await tx<{ id: string }[]>`
        update sponsors set display_order = ${i}
        where id = ${id} and archived_at is null returning id`;
      if (row) {
        reordered++;
        continue;
      }
      const [held] = await tx`select 1 from sponsors where id = ${id}`;
      if (!held) throw new HttpError(422, "reorder references an unknown sponsor");
    }
    return { reordered };
  }).then(async (res) => {
    await expirePublicSponsors(auth.orgId, "sponsor.reorder");
    return res;
  });
}

// ---------------------------------------------------------------------------
// Public resolver (placement) — the sponsors table only
// ---------------------------------------------------------------------------

export interface ResolvedSponsor {
  /** The sponsors row: every resolved sponsor has one since the blob shim went (R4 fix batch 3), so every board link is
   *  the tracked `/s/` redirect. */
  id: string;
  name: string;
  url: string | null;
  logo: string | null;
  /** The sponsor's 4:5 poster (V501), or null. Only the competition hero's Title placement draws it; every other surface
   *  carries the field and ignores it. */
  poster: string | null;
  tier: SponsorTier;
}

/**
 * Sponsors for a public surface: competition-scoped rows first, then
 * org-wide, deduped by name, ordered tier rank → display_order. The
 * `sponsors` table is the only source: no rows means no sponsors (R4 fix
 * batch 3, m9 — the branding-blob shim brought deleted sponsors back).
 * Runs on the privileged connection: public pages have no tenant context.
 * An archived row is left out IN SQL, before the dedupe (archive spec D28):
 * a new row is never hidden behind an archived one of the same name.
 * Orgs without `sponsors.tiers` get the un-tiered free strip — every row
 * collapses to `partner` so tier grouping stays a Pro-visible feature.
 *
 * `onStream` (R4 S5, the stream's card source): only rows ticked onto the
 * stream, filtered BEFORE the name dedupe — a ticked row must never be hidden
 * behind an unticked one of the same name (a paid renewal inserts a new row
 * under the old name).
 */
export async function resolveSponsors(
  orgId: string,
  competitionId?: string,
  opts: { tiered?: boolean; onStream?: boolean } = {},
): Promise<ResolvedSponsor[]> {
  const onStream = opts.onStream === true;
  const rows = await sql<
    (Pick<SponsorRow, "id" | "name" | "url" | "tier"> & { logo_path: string | null; poster_path: string | null })[]
  >`
    select id, name, url, logo_path, poster_path, tier from sponsors
    where org_id = ${orgId} and status = 'active' and archived_at is null
      and (competition_id is null or competition_id = ${competitionId ?? null})
      ${onStream ? sql`and on_stream` : sql``}
    order by (competition_id is null),
             array_position(${[...SPONSOR_TIERS]}::text[], tier),
             display_order, created_at, id`;

  const resolved: ResolvedSponsor[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    logo: r.logo_path,
    poster: r.poster_path,
    tier: r.tier,
  }));

  const seen = new Set<string>();
  const deduped = resolved.filter((s) => !seen.has(s.name) && seen.add(s.name));
  if (opts.tiered === false) {
    return deduped.map((s) => ({ ...s, tier: "partner" as const }));
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// Packages (every plan; a placement, so the placement gate) + Connect checkout (Pro `sponsors.monetize`)
// ---------------------------------------------------------------------------

export interface SponsorPackageRow {
  id: string;
  /** Null: any competition (the deal picks), V495. */
  competition_id: string | null;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  tier: SponsorTier;
  active: boolean;
  created_at: string;
  /** A deal on this package puts its sponsor on the stream too (V495; snapshotted onto the deal, D4). */
  includes_on_stream: boolean;
  /** How many DISTINCT sponsors hold an open (non-ended, non-legacy) deal on this package. */
  used_by: number;
}

const PKG_COLS = [
  "id", "competition_id", "name", "description", "price_cents",
  "currency", "tier", "active", "created_at", "includes_on_stream",
] as const;

/** `used_by`, read beside a package row (select or returning). Non-ended is non-legacy too: V495 rewrote every pre-deals
 *  order as an ENDED deal, and `sponsor_orders_ended_shape` keeps a non-ended deal reason-free. */
function packageUsedBy(tx: Tx) {
  return tx`(select count(distinct o.sponsor_id)::int from sponsor_orders o
              where o.package_id = sponsor_packages.id and o.deal_status <> 'ended') as used_by`;
}

export const CreateSponsorPackageInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  price_cents: z.number().int().positive().max(5_000_000),
  currency: z.string().length(3).toLowerCase().default("gbp"),
  tier: z.enum(SPONSOR_TIERS).default("partner"),
  competition_id: z.string().uuid().nullish(),
  includes_on_stream: z.boolean().default(false),
});
export type CreateSponsorPackageInput = z.infer<typeof CreateSponsorPackageInput>;

/** A package is a placement, so every plan may create one (spec §8) and it passes the ONE placement gate (D17, F14):
 *  a tier other than partner, or a competition, needs `sponsors.tiers`. Selling it online is `sponsors.monetize`'s,
 *  asked when an online deal is made, never here. */
export async function createSponsorPackage(
  auth: AuthCtx,
  input: CreateSponsorPackageInput,
): Promise<SponsorPackageRow> {
  await assertPlacementAllowed(auth.orgId, input.tier, input.competition_id ?? null);
  return withTenant(auth.orgId, async (tx) => {
    if (input.competition_id) {
      const [comp] = await tx`select 1 from competitions where id = ${input.competition_id}`;
      if (!comp) throw new HttpError(404, "competition not found");
    }
    const [row] = await tx<SponsorPackageRow[]>`
      insert into sponsor_packages (org_id, competition_id, name, description,
                                    price_cents, currency, tier, includes_on_stream)
      values (${auth.orgId}, ${input.competition_id ?? null}, ${input.name},
              ${input.description ?? null}, ${input.price_cents},
              ${input.currency}, ${input.tier}, ${input.includes_on_stream})
      returning ${tx(PKG_COLS)}, ${packageUsedBy(tx)}`;
    return row!;
  });
}

export async function listSponsorPackages(auth: AuthCtx): Promise<SponsorPackageRow[]> {
  return withTenant(auth.orgId, (tx) => tx<SponsorPackageRow[]>`
    select ${tx(PKG_COLS)}, ${packageUsedBy(tx)} from sponsor_packages
    order by active desc, created_at desc, id`);
}

/** Packages are referenced by orders, so retiring one is a soft flip. */
export async function deactivateSponsorPackage(
  auth: AuthCtx,
  id: string,
): Promise<SponsorPackageRow> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<SponsorPackageRow[]>`
      update sponsor_packages set active = false
      where id = ${id} returning ${tx(PKG_COLS)}, ${packageUsedBy(tx)}`;
    if (!row) throw new HttpError(404, "package not found");
    return row;
  });
}

export interface SponsorOrderRow {
  id: string;
  package_id: string;
  sponsor_name: string;
  sponsor_email: string;
  payment_intent_id: string | null;
  amount_cents: number;
  currency: string;
  status: "pending" | "paid" | "failed" | "refunded";
  sponsor_id: string | null;
  created_at: string;
  paid_at: string | null;
  disputed_at: string | null;
  dispute_id: string | null;
}

const ORDER_COLS = [
  "id", "package_id", "sponsor_name", "sponsor_email", "payment_intent_id",
  "amount_cents", "currency", "status", "sponsor_id", "created_at", "paid_at",
  "disputed_at", "dispute_id",
] as const;

// ---------------------------------------------------------------------------
// An online deal's Checkout session (sponsor deals Task 7, D14, F3, F32, F37)
// ---------------------------------------------------------------------------

/** The deal fields a Checkout session and its invoice are built from (the deal's snapshot, D4). */
type SponsorDealView = Pick<
  SponsorDeal,
  "id" | "package_id" | "package_name" | "sponsor_name" | "sponsor_email" | "amount_cents" | "currency" | "competition_id"
>;

/** The org fields a deal's Checkout session needs. */
export interface DealCheckoutOrg {
  id: string;
  slug: string;
  stripe_account_id: string;
}

/** A Checkout session as a deal stores it: id, pay link, and its expiry in Unix seconds (Stripe's own unit). */
export interface DealSession {
  id: string;
  url: string;
  expires_at: number;
}

/** A stored session is reused while more than this is left of it (F32): a link mailed with minutes to live is no link. */
const SESSION_REUSE_MARGIN_MS = 10 * 60_000;

/** Stripe could not do what the deal needs; the deal is left exactly as it was. */
function stripeUnavailable(what: string, err: unknown, deal: { id: string }): HttpError {
  log.error({ err, dealId: deal.id }, `sponsors: Stripe could not ${what}`);
  return sponsorRefusal(502, `Stripe could not ${what}, so nothing was changed; try again`, "stripe_unavailable");
}

/**
 * Mint a deal's Checkout session: a destination charge on the org's connected account (the amount to the org, the platform's
 * entry-fee application fee kept), exactly like a registration's. Outside any transaction (house rule). `attempt` is the send
 * number, so the Stripe idempotency key `sponsor-deal-<id>-<attempt>` pins a retried send to ONE session and a later send to a
 * new one. Success and cancel return to the org's public hub, `routes.publicHub(slug)` (`/live/<slug>`, F25). Any Stripe
 * failure is a 502 (`stripe_unavailable`).
 */
export async function mintDealCheckout(
  deal: SponsorDealView,
  org: DealCheckoutOrg,
  origin: string,
  attempt: number,
): Promise<DealSession> {
  const returnBase = `${origin}${routes.publicHub(org.slug)}`;
  const fee = applicationFeeCents(deal.amount_cents, await feePercentFor(org.id, deal.competition_id ?? undefined));
  let session: Stripe.Checkout.Session;
  try {
    session = await getStripe().checkout.sessions.create(
      {
        mode: "payment",
        customer_email: deal.sponsor_email ?? undefined,
        metadata: { kind: "sponsor", order_id: deal.id, org_id: org.id },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: deal.currency,
              unit_amount: deal.amount_cents,
              product_data: { name: `${deal.package_name} — sponsorship (${deal.sponsor_name})` },
            },
          },
        ],
        payment_intent_data: {
          application_fee_amount: fee,
          transfer_data: { destination: org.stripe_account_id },
          metadata: { kind: "sponsor", order_id: deal.id, package_id: deal.package_id, org_id: org.id },
        },
        success_url: `${returnBase}?sponsorship=success`,
        cancel_url: `${returnBase}?sponsorship=cancelled`,
      },
      { idempotencyKey: `sponsor-deal-${deal.id}-${attempt}` },
    );
  } catch (err) {
    throw stripeUnavailable("create the payment link", err, deal);
  }
  if (!session.url) throw stripeUnavailable("return a payment link", new Error("no checkout url"), deal);
  return { id: session.id, url: session.url, expires_at: session.expires_at };
}

/** What Stripe says of a session; the session rule decides on `retrieve` alone. */
type SessionStatus = "open" | "complete" | "expired";

/** A deal holding a stored session. */
type WithSession = { id: string; checkout_session_id: string };

/** Ask Stripe what a stored session is (`retrieve`). A read error, or any status but open / complete / expired, is a 502
 *  (`stripe_unavailable`): nothing is decided on a session nobody could read. */
async function storedSessionStatus(deal: WithSession): Promise<SessionStatus> {
  let status: Stripe.Checkout.Session["status"];
  try {
    status = (await getStripe().checkout.sessions.retrieve(deal.checkout_session_id)).status;
  } catch (err) {
    throw stripeUnavailable("read this deal's payment link", err, deal);
  }
  if (status === "open" || status === "complete" || status === "expired") return status;
  throw stripeUnavailable(`read this deal's payment link (status ${String(status)})`, null, deal);
}

/**
 * Forget a dead session at once, in its OWN committed statement (review I1): a later refusal in the caller's transaction must
 * not roll the dead id, url and expiry back onto the deal, where the next Send invoice would offer it. Compare-and-clear: only
 * while it is still the stored session (a session stored since is left alone, and the caller's lock re-check sees it).
 */
async function forgetDeadSession(orgId: string, deal: WithSession): Promise<void> {
  await withTenant(orgId, (tx) => tx`
    update sponsor_orders set checkout_session_id = null, checkout_url = null, checkout_expires_at = null
     where id = ${deal.id} and checkout_session_id = ${deal.checkout_session_id}`);
}

/** Expire an open session at Stripe, then forget it. Keyed per SESSION (never per deal: a later session of the same deal
 *  would replay the first one's answer and stay open). An `expire` error is a 502 and is never parsed; nothing is forgotten. */
async function expireOpenSession(orgId: string, deal: WithSession): Promise<void> {
  try {
    await getStripe().checkout.sessions.expire(
      deal.checkout_session_id,
      {},
      { idempotencyKey: `sponsor-session-expire-${deal.checkout_session_id}` },
    );
  } catch (err) {
    throw stripeUnavailable("close this deal's open payment link", err, deal);
  }
  await forgetDeadSession(orgId, deal);
}

/**
 * The session rule (D14, F3, F37): two payable sessions for one deal must never coexist, so every path that replaces, abandons
 * or deletes a stored session retires it first. Outside any transaction. Decided ONLY on the status `retrieve` reports (an
 * `expire` error is never parsed): `open` is expired, then `retired`; `expired` is `retired` with no call; `complete` is money
 * in flight, answered as `complete` for the caller to refuse or carry on. No stored session is `none`. A session that cannot be
 * read, or that is open and cannot be expired, is a 502 (`stripe_unavailable`) and nothing else happens: carrying on would leave
 * two payable sessions. A retired session is forgotten at once, committed (review I1), so callers refuse BEFORE retiring and
 * compare the stored session against null after. (registrations.ts expires a stale session best-effort; here a failed expire
 * stops.)
 */
export async function retireDealSession(
  orgId: string,
  deal: { id: string; checkout_session_id: string | null },
): Promise<"none" | "retired" | "complete"> {
  if (deal.checkout_session_id === null) return "none";
  const held: WithSession = { id: deal.id, checkout_session_id: deal.checkout_session_id };
  const status = await storedSessionStatus(held);
  if (status === "complete") return "complete";
  if (status === "open") await expireOpenSession(orgId, held);
  else await forgetDeadSession(orgId, held);
  return "retired";
}

/** A completed session: the sponsor has paid at Stripe and the webhook is on its way (F37). */
export function paidOnline(): HttpError {
  return sponsorRefusal(
    409,
    "The sponsor has already paid this deal online; the payment is being recorded. Refresh in a moment.",
    "deal_paid_online",
  );
}

/**
 * The ONE reuse-or-retire-and-mint rule (F32; Task 22's `payInvoice` calls it too): the stored session while more than 10
 * minutes are left of it AND Stripe still calls it open (review I1: the stored expiry alone is no proof — an expired one is
 * forgotten and replaced), else the stored one retired by the session rule and a new one minted with attempt
 * `invoice_send_count + 1`. A completed stored session is 409 `deal_paid_online`: no re-mint. Outside any transaction.
 * `minted: false` means the stored session is reused; after a mint the deal holds no session until the caller stores it.
 */
export async function ensureDealCheckout(
  deal: ServerDeal,
  org: DealCheckoutOrg,
  origin: string,
): Promise<DealSession & { minted: boolean }> {
  const expiresMs = deal.checkout_expires_at === null ? null : Date.parse(deal.checkout_expires_at);
  const sessionId = deal.checkout_session_id;
  if (sessionId && deal.checkout_url && expiresMs !== null && expiresMs > Date.now() + SESSION_REUSE_MARGIN_MS) {
    const held: WithSession = { id: deal.id, checkout_session_id: sessionId };
    const status = await storedSessionStatus(held);
    if (status === "open") return { id: sessionId, url: deal.checkout_url, expires_at: Math.floor(expiresMs / 1000), minted: false };
    if (status === "complete") throw paidOnline();
    await forgetDeadSession(org.id, held);
  } else if ((await retireDealSession(org.id, deal)) === "complete") throw paidOnline();
  return { ...(await mintDealCheckout(deal, org, origin, deal.invoice_send_count + 1)), minted: true };
}

/**
 * Queue a deal's invoice on the email outbox, on `tx` (the transaction that records the send): kind `sponsor_invoice`, ref
 * `sponsor_order/<deal id>`, once-key `<deal id>:<sendNo>` — so a resend is a new invoice and a retried send (the same count)
 * is not. To the deal's billing email, a literal address, in the org's language. The email carries the invoice's number and
 * links its page (`invoiceUrl`, the token the same transaction minted: Task 23, D14), never a Checkout session; `pay` says how
 * the sponsor pays (card on the page, or transfer to the club's bank details). Returns the outbox id, or `null` when this send
 * already has its invoice. No catch: a refused enqueue rolls the send back (an online send's session is pinned by its Stripe
 * key, so a retry gets the same one). The caller asked `assertOutboxCanQueue` before it touched Stripe (P-W2-1).
 */
export async function queueSponsorInvoice(
  tx: Tx,
  a: {
    deal: SponsorDealView & { org_id: string };
    number: string;
    invoiceUrl: string;
    pay: SponsorInvoiceArgs["pay"];
    sendNo: number;
  },
): Promise<string | null> {
  const { deal, invoiceUrl, sendNo } = a;
  if (!deal.sponsor_email) throw new Error(`sponsors: deal ${deal.id} has no billing email, so its invoice has nowhere to go`);
  const [org] = await tx<{ name: string; default_locale: string }[]>`
    select name, default_locale from organizations where id = ${deal.org_id}`;
  const locale = await recipientLocale(tx, { pick: null, userId: null, orgDefault: org?.default_locale ?? null });
  const content = await sponsorInvoiceEmail(
    {
      orgName: org?.name ?? "the organiser",
      packageName: deal.package_name,
      sponsorName: deal.sponsor_name,
      amountCents: deal.amount_cents,
      currency: deal.currency,
      number: a.number,
      invoiceUrl,
      pay: a.pay,
    },
    locale,
  );
  return enqueueEmailOnce(tx, {
    kind: "sponsor_invoice",
    refType: "sponsor_order",
    refId: deal.id,
    dedupeKey: onceKey("sponsor_invoice", "sponsor_order", deal.id, String(sendNo)),
    orgId: deal.org_id,
    to: deal.sponsor_email,
    transactional: false,
    expiresAt: expiryWithin(null),
    ...content,
  });
}

// ---------------------------------------------------------------------------
// Webhook activation (billing-events dispatch; replay-safe)
// ---------------------------------------------------------------------------

/** Why a sponsor payment needs the owner's eye: money taken that did not move a deal the way a payment should. */
type DealPaymentAlert =
  /** The deal had ended (End now over a completed session, Review Focus 1): recorded, refundable, the sponsor untouched. */
  | "deal_ended"
  /** The deal's rule cannot take a payment (a draft, or awaiting approval; F12): recorded, refundable, the deal as it was. */
  | "deal_not_payable"
  /** A second, different payment on a deal already paid (F3): its own ended, refundable row. */
  | "duplicate_payment"
  /** The deal the payment names is not there (T8 review m1): money taken with nothing to record it on. */
  | "deal_missing";

/**
 * The platform's eye on a payment the club may owe back (Review Focus 1, F3, F12): a Sentry event carrying the reason, the deal
 * and the intent, raised after the commit and only on the transition (a redelivery of the same intent is a no-op before it).
 * The OWNER hears through the `sponsor_deal_paid` notice (`queueDealPaidNotice`, Task 23), queued in the payment's transaction
 * with its "check the deal" or "second payment" line; `deal_missing` has no deal to name and no notice, so Sentry alone carries it.
 */
function alertDealPayment(
  reason: DealPaymentAlert,
  a: { orgId: string | null; dealId: string; intentId: string; recordedOn: string | null },
): void {
  captureError(new Error(`sponsors: ${reason} (deal ${a.dealId})`), {
    orgId: a.orgId ?? undefined,
    route: "billing.sponsor_payment",
    extra: { reason, dealId: a.dealId, intentId: a.intentId, recordedOn: a.recordedOn },
  });
}

/** What a payment did, decided under the lock and acted on after the commit. */
type PaymentOutcome = {
  /** Null only when the deal is not there and the intent names no org. */
  orgId: string | null;
  /** The deal applied to its sponsor: the public pages are busted. */
  applied: boolean;
  alert: { reason: DealPaymentAlert; dealId: string; recordedOn: string | null; err?: unknown } | null;
};

/**
 * payment_intent.succeeded with metadata.kind === 'sponsor' (spec §5.2, §5.3; D7): the payment moves its DEAL, and the deal
 * reaches its sponsor only through `applyDealsToSponsor`. Nothing here inserts a sponsor (anti-goal 1, F17).
 *
 * In the one lock order (F2): the deal's sponsor, then its deals (`lockDealAndSponsor`), then re-checked:
 *  - unpaid (`pending`, or `failed`: Stripe lets a failed intent succeed on a retry, and a re-sent invoice pays on a new
 *    intent): money paid, the intent that took it recorded (overwriting a declined one, so its refund and disputes find the
 *    deal), and the receipt queued in the same transaction. Then the go-live rule (`statusAfterPaid`) moves the deal — live,
 *    scheduled behind a live deal, or awaiting approval — and the sponsor's deals are applied. The owner's `sponsor_deal_paid`
 *    notice, saying which, is queued in the same transaction (D13, Task 23). An ENDED deal (legacy included) keeps its status
 *    and its sponsor is not touched: `log.warn`, the Sentry alert, and the owner's notice saying "check the deal". A deal its
 *    rule cannot move (a draft, awaiting approval) keeps its status: the `DealRuleError` is caught here, never escapes (F12: a
 *    throw would 500 the webhook and Stripe would retry forever), and is logged with the deal id plus the same alert and notice.
 *    Both stay refundable.
 *  - already paid on the SAME intent (on this deal or the row a second payment made): a redelivery, a no-op. Stripe's own
 *    idempotency keys expire ~24h, so this DB guard is the real one.
 *  - paid (or refunded) on another intent: a second payment (F3). Its own row — the deal's snapshot, `online`, money `paid`
 *    on its own intent, amount and currency, ended `duplicate_payment` — so the club sees the money and can refund it; the
 *    deal and its sponsor stay as they were; the Sentry alert, and the owner's notice saying "a second payment". No sponsor
 *    receipt.
 *
 * The worker makes the receipt's and the notice's first attempt: a webhook has no response to defer behind. Nobody reads a webhook's result back
 * at once, so the public pages are busted as tail work (`deferred`, F1).
 */
export async function handleSponsorPaymentSucceeded(
  intent: Stripe.PaymentIntent,
): Promise<void> {
  if (intent.metadata?.kind !== "sponsor") return;
  const dealId = intent.metadata.order_id;
  if (!dealId) return;

  const out = await sql.begin(async (tx): Promise<PaymentOutcome | null> => {
    const locked = await lockDealAndSponsor(tx, dealId);
    // Money taken with no deal to record it on (deleted in a race after its session completed): never quiet (T8 review m1).
    if (!locked) {
      return { orgId: intent.metadata.org_id ?? null, applied: false, alert: { reason: "deal_missing", dealId, recordedOn: null } };
    }
    const { deal, orgId } = locked;
    if (deal.payment_status !== "pending" && deal.payment_status !== "failed") {
      if (locked.deals.some((d) => d.payment_intent_id === intent.id)) return null; // a redelivery
      const recordedOn = await recordDuplicatePayment(tx, locked, intent);
      // What the second payment took, as its row records it (`recordDuplicatePayment`).
      const paid = { amountCents: intent.amount_received ?? intent.amount, currency: intent.currency };
      await queueDealPaidNotice(tx, { locked, dealId: recordedOn ?? deal.id, intentId: intent.id, paid, next: "duplicate" });
      return { orgId, applied: false, alert: { reason: "duplicate_payment", dealId: deal.id, recordedOn } };
    }

    const now = new Date();
    let next: DealStatus | null = null; // null: the deal does not move
    let refused: DealRuleError | null = null;
    if (deal.deal_status !== "ended") {
      const otherLive = locked.deals.some((d) => d.id !== deal.id && d.deal_status === "live");
      try {
        next = statusAfterPaid(deal, otherLive);
      } catch (err) {
        if (!(err instanceof DealRuleError)) throw err;
        refused = err;
      }
    }
    const goesLive = next === "live" && deal.deal_status !== "live";
    await tx`
      update sponsor_orders
         set status = 'paid', paid_at = ${now}, payment_intent_id = ${intent.id},
             deal_status = ${next ?? deal.deal_status}${goesLive ? tx`, live_at = ${now}` : tx``}
       where id = ${deal.id}`;
    if (deal.sponsor_email !== null) {
      await queueSponsorReceipt(tx, {
        order: {
          id: deal.id,
          org_id: orgId,
          sponsor_name: deal.sponsor_name,
          sponsor_email: deal.sponsor_email,
          amount_cents: deal.amount_cents,
          currency: deal.currency,
        },
        packageName: deal.package_name,
        intentId: intent.id,
      });
    }
    const paid = { amountCents: deal.amount_cents, currency: deal.currency }; // the invoiced amount, as the receipt says it
    await queueDealPaidNotice(tx, { locked, dealId: deal.id, intentId: intent.id, paid, next: dealPaidNext(next) });
    if (next === null) {
      const reason = refused ? "deal_not_payable" : "deal_ended";
      return { orgId, applied: false, alert: { reason, dealId: deal.id, recordedOn: deal.id, err: refused ?? undefined } };
    }
    if (locked.sponsorId !== null) await applyDealsToSponsor(tx, locked.sponsorId, null, { now });
    return { orgId, applied: true, alert: null };
  });
  if (!out) return;

  if (out.alert) {
    const { reason, dealId: alerted, recordedOn, err } = out.alert;
    const at = { dealId: alerted, intentId: intent.id, recordedOn };
    if (reason === "deal_ended") log.warn({ dealId: alerted }, "sponsors: payment on an ended deal");
    else if (reason === "deal_not_payable") log.error({ err, ...at }, "sponsors: payment on a deal its rule cannot move");
    else if (reason === "deal_missing") log.error(at, "sponsors: payment on a deal that is not there");
    else log.error(at, "sponsors: a second payment on a paid deal");
    alertDealPayment(reason, { orgId: out.orgId, ...at });
  }
  if (out.applied && out.orgId !== null) {
    const [org] = await sql<{ slug: string }[]>`
      select slug from organizations where id = ${out.orgId}`;
    if (org) deferred(() => fireOrgRevalidate(org.slug));
  }
}

/** The owner's next step after a card payment moved (or did not move) a deal to `next` (null: it did not move). `statusAfterPaid`
 *  answers only live, scheduled or awaiting_approval for a deal it moves; anything else is no step we can name, so the owner is
 *  told to check the deal rather than told something false. */
export function dealPaidNext(next: DealStatus | null): DealPaidNext {
  if (next === "live") return "live";
  if (next === "scheduled") return "scheduled";
  if (next === "awaiting_approval") return "approve";
  return "check";
}

/**
 * The owner's "a sponsor has paid" notice (spec D13; plan 2026-11-07-sponsor-deals, Task 23), queued on `tx`, the transaction that
 * records the card payment, so the notice and the paid deal commit together or not at all (no catch: a refused enqueue rolls the
 * payment back and Stripe delivers the webhook again). Kind `sponsor_deal_paid`, to the org's owner (`orgOwnerRecipient`) as an
 * account, in the owner's language; once-key the payment intent, so a redelivered or replayed event never mails twice. It names
 * the sponsor, the amount paid, and the next step, and links the deal (`dealHref`; a sponsor-less legacy row links the
 * Sponsors tab). An org with no current owner records the payment and mails nobody. Card payments only: an offline mark-paid,
 * an offline refund and a complimentary deal send nothing (D13).
 */
async function queueDealPaidNotice(
  tx: Tx,
  a: {
    locked: LockedDeal;
    dealId: string;
    intentId: string;
    paid: { amountCents: number; currency: string };
    next: DealPaidNext;
  },
): Promise<string | null> {
  const { locked } = a;
  const owner = await orgOwnerRecipient(tx, locked.orgId);
  if (!owner) return null;
  const [org] = await tx<{ slug: string; name: string; default_locale: string }[]>`
    select slug, name, default_locale from organizations where id = ${locked.orgId}`;
  if (!org) return null;
  const locale = await recipientLocale(tx, { pick: null, userId: owner.userId, orgDefault: org.default_locale });
  const path = locked.sponsorId !== null ? dealHref(org.slug, locked.sponsorId, a.dealId) : sponsorsHref(org.slug, "sponsors");
  const kind = "sponsor_deal_paid";
  return enqueueEmailOnce(tx, {
    kind,
    refType: "sponsor_order",
    refId: a.dealId,
    dedupeKey: onceKey(kind, "sponsor_order", a.intentId),
    orgId: locked.orgId,
    to: owner.email,
    recipientUserId: owner.userId,
    transactional: false,
    expiresAt: expiryWithin(null),
    ...(await sponsorDealPaidEmail(
      {
        orgName: org.name,
        packageName: locked.deal.package_name,
        sponsorName: locked.deal.sponsor_name,
        amountCents: a.paid.amountCents,
        currency: a.paid.currency,
        next: a.next,
        dealUrl: `${sponsorEmailOrigin()}${path}`,
      },
      locale,
    )),
  });
}

/**
 * F3: a second, different payment on a deal already paid. Recorded as its own row under the same lock, so the money stays
 * visible and refundable: the deal's snapshot (sponsor, package, scope, tier, stream), `online`, money `paid` on its own intent,
 * amount and currency, ended `duplicate_payment` at once (applyDealsToSponsor reads it as an ordinary ended deal). A sponsor-less
 * legacy row, or a deal with no billing email, cannot carry such a row (`sponsor_or_legacy`, `online_has_email`): then nothing
 * is written and the alert alone carries it (null). Answers the new row's id.
 */
async function recordDuplicatePayment(tx: Tx, locked: LockedDeal, intent: Stripe.PaymentIntent): Promise<string | null> {
  const { deal } = locked;
  if (locked.sponsorId === null || deal.sponsor_email === null) return null;
  const [row] = await tx<{ id: string }[]>`
    insert into sponsor_orders (org_id, sponsor_id, package_id, package_name, tier, includes_on_stream, competition_id,
                                sponsor_name, sponsor_email, payment_method, go_live, amount_cents, currency, status,
                                payment_intent_id, paid_at, deal_status, ended_at, ended_reason)
    values (${locked.orgId}, ${locked.sponsorId}, ${deal.package_id}, ${deal.package_name}, ${deal.tier},
            ${deal.includes_on_stream}, ${deal.competition_id}, ${deal.sponsor_name}, ${deal.sponsor_email}, 'online',
            ${deal.go_live}, ${intent.amount_received ?? intent.amount}, ${intent.currency}, 'paid', ${intent.id}, now(),
            'ended', now(), 'duplicate_payment')
    returning id`;
  return row!.id;
}

/**
 * Queue the sponsor's payment receipt on the email outbox, on `tx`: the
 * transaction that pays the deal (R1), so the receipt and the paid
 * deal commit together or not at all. Kind `sponsor_receipt`, ref
 * `sponsor_order/<order id>`, once-key the payment intent: one receipt per
 * payment, whatever redelivers it. Literal address (the sponsor contact), in
 * the org's language (D4: the order has no pick and no account). The org is
 * read through `tx` (#996). There is no catch (D1): a refused enqueue rolls the
 * payment back and fails the webhook, which Stripe delivers again. Returns
 * the outbox id, or `null` when this payment already has its receipt.
 * Exported for the once-key test.
 */
export async function queueSponsorReceipt(
  tx: Tx,
  a: {
    order: {
      id: string;
      org_id: string;
      sponsor_name: string;
      sponsor_email: string;
      amount_cents: number;
      currency: string;
    };
    packageName: string;
    intentId: string;
  },
): Promise<string | null> {
  const { order, packageName, intentId } = a;
  const [org] = await tx<{ slug: string; name: string; default_locale: string }[]>`
    select slug, name, default_locale from organizations where id = ${order.org_id}`;
  const locale = await recipientLocale(tx, { pick: null, userId: null, orgDefault: org?.default_locale ?? null });
  const content = await sponsorReceiptEmail(
    {
      orgName: org?.name ?? "the organiser",
      packageName,
      sponsorName: order.sponsor_name,
      amountCents: order.amount_cents,
      currency: order.currency,
      publicUrl: org ? `${sponsorEmailOrigin()}${routes.publicHub(org.slug)}` : null,
    },
    locale,
  );
  return enqueueEmailOnce(tx, {
    kind: "sponsor_receipt",
    refType: "sponsor_order",
    refId: order.id,
    dedupeKey: onceKey("sponsor_receipt", "sponsor_order", intentId),
    orgId: order.org_id,
    to: order.sponsor_email,
    transactional: false,
    expiresAt: expiryWithin(null),
    ...content,
  });
}

/** payment_intent.payment_failed for a sponsor order: pending → failed
 *  (a paid order is never clobbered by a stray late failure event). The
 *  deal's status is unchanged: the sponsor can retry in the same session, and
 *  nothing reaches the sponsor. One autocommit statement on the deal row alone,
 *  which waits on no other lock while it holds it, so it cannot deadlock
 *  against the sponsor-first order (F2). */
export async function handleSponsorPaymentFailed(
  intent: Stripe.PaymentIntent,
): Promise<void> {
  if (intent.metadata?.kind !== "sponsor") return;
  const orderId = intent.metadata.order_id;
  if (!orderId) return;
  await sql`
    update sponsor_orders
    set status = 'failed', payment_intent_id = coalesce(payment_intent_id, ${intent.id})
    where id = ${orderId} and status = 'pending'`;
}

/**
 * Console-initiated refund (owner action): full refund of a paid order —
 * the transfer to the org reverses and the platform returns its
 * application fee, exactly like entry-fee refunds. The local flip reuses
 * the charge.refunded path, so the later Stripe event replays as a no-op.
 * The sponsor's refund notice is queued by that path; this request makes its
 * first attempt after it returns.
 */
export async function refundSponsorOrder(
  auth: AuthCtx,
  orderId: string,
): Promise<SponsorOrderRow> {
  const order = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<SponsorOrderRow[]>`
      select ${tx(ORDER_COLS)} from sponsor_orders where id = ${orderId}`;
    if (!row) throw new HttpError(404, "order not found");
    return row;
  });
  // A refund that lost the race to another (or to Stripe's own charge.refunded) is the deal's refusal, coded (review m2).
  if (order.status !== "paid" || !order.payment_intent_id) {
    throw sponsorRefusal(409, "Only a paid deal can be refunded, and only once", "deal_not_refundable");
  }
  // Stripe refuses refunds on charged-back charges; surface the state in our
  // own words before ever calling out (raw Stripe text leaked to the console).
  if (order.disputed_at) {
    throw sponsorRefusal(
      409,
      "This payment has been charged back — a disputed payment can't be refunded. Respond to the dispute instead.",
      "deal_disputed",
    );
  }
  // Stripe OUTSIDE any sql transaction (house rule). A Stripe failure is the documented 502 `stripe_unavailable`, never a
  // 500 carrying Stripe's own text (review m2); nothing was recorded, and the key makes the retry safe.
  try {
    await getStripe().refunds.create(
      {
        payment_intent: order.payment_intent_id,
        reverse_transfer: true,
        refund_application_fee: true,
      },
      { idempotencyKey: `sponsor-refund-${orderId}` },
    );
  } catch (err) {
    throw stripeUnavailable("refund this payment", err, { id: orderId });
  }
  const notice = await handleSponsorChargeRefunded({
    payment_intent: order.payment_intent_id,
    refunded: true,
  } as Stripe.Charge);
  if (notice) deferred(() => dispatchNow([notice]));
  // The organiser refunded from the console and looks at the public page next: the placement leaves it NOW, not after the
  // response (the webhook handler's own bust above is `after()` tail work - see expirePublicSponsors).
  await expirePublicSponsors(auth.orgId, "sponsor.refund");
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<SponsorOrderRow[]>`
      select ${tx(ORDER_COLS)} from sponsor_orders where id = ${orderId}`;
    return row!;
  });
}

/**
 * charge.refunded for a sponsor deal (the console's refund and Stripe-dashboard refunds alike): the paid deal's money flips to
 * `refunded` and the deal ENDS as refunded in the same transaction, then its sponsor's deals are applied (spec §5.2; D8): a
 * scheduled deal behind it goes live, else the sponsor is reset when this refund ended its last live or open deal. A deal that
 * had already ended passes no `endedDealId` (F7: not a transition), so a hand switch-back-on survives it. A legacy row (D6,
 * F18) flips its money only: its deal columns stay and nothing is applied. No sponsor is ever written here except through
 * `applyDealsToSponsor`. In the one lock order (F2): the deal is found unlocked, then its sponsor and deals are locked and the
 * deal re-checked (still paid, on this intent). Idempotent: only a `paid` deal flips, and a non-sponsor charge matches none.
 *
 * The flip queues the sponsor's refund notice in the same transaction (`queueSponsorRefundReceipt`), so only the transition
 * writes one. Returns its outbox id (null: no flip, or no notice) for the console refund, which makes the first attempt; a
 * webhook (a refund made in the Stripe dashboard) leaves it to the worker.
 */
export async function handleSponsorChargeRefunded(charge: Stripe.Charge): Promise<string | null> {
  const intent =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id;
  if (!intent || !charge.refunded) return null;
  const refunded = await sql.begin(async (tx) => {
    // Unlocked: only the deal, to lock its sponsor first (F2).
    const [ref] = await tx<{ id: string }[]>`
      select id from sponsor_orders where payment_intent_id = ${intent} and status = 'paid'`;
    if (!ref) return null;
    const locked = await lockDealAndSponsor(tx, ref.id);
    if (!locked || locked.deal.payment_status !== "paid" || locked.deal.payment_intent_id !== intent) return null;
    const { deal, orgId } = locked;
    if (locked.sponsorId === null || isLegacyDeal(deal)) {
      await tx`update sponsor_orders set status = 'refunded' where id = ${deal.id}`;
    } else {
      const now = new Date();
      const wasOpen = deal.deal_status !== "ended";
      await tx`
        update sponsor_orders
           set status = 'refunded', deal_status = 'ended', ended_at = coalesce(ended_at, ${now}), ended_reason = 'refunded'
         where id = ${deal.id}`;
      await applyDealsToSponsor(tx, locked.sponsorId, null, { now, endedDealId: wasOpen ? deal.id : null });
    }
    const notice =
      deal.sponsor_email === null
        ? null
        : await queueSponsorRefundReceipt(tx, {
            id: deal.id,
            org_id: orgId,
            sponsor_name: deal.sponsor_name,
            sponsor_email: deal.sponsor_email,
            amount_cents: deal.amount_cents,
            currency: deal.currency,
            package_id: deal.package_id,
          });
    return { orgId, notice };
  });
  if (!refunded) return null;
  const [org] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${refunded.orgId}`;
  if (org) deferred(() => fireOrgRevalidate(org.slug));
  return refunded.notice;
}

/**
 * Queue the sponsor's refund notice on the email outbox, on `tx`: the
 * transaction that flips the order to `refunded`. Kind `sponsor_refund`, ref
 * `sponsor_order/<order id>`, once-key `<order id>:refunded` (an order is
 * refunded once). Literal address (the sponsor contact), in the org's language.
 *
 * The notice is about money that has ALREADY moved at Stripe, so a failure
 * here must never undo the refund's record (R4). It is contained at its own
 * savepoint: a statement that errors inside a Postgres transaction aborts the
 * whole transaction, which would roll back the flip and fail the refund. The
 * reads and the render run inside the same savepoint and the same try, so
 * any of them failing is contained too: logged, and `null` is returned.
 * Exported for the once-key test.
 */
export async function queueSponsorRefundReceipt(
  tx: Tx,
  order: {
    id: string;
    org_id: string;
    sponsor_name: string;
    sponsor_email: string;
    amount_cents: number;
    currency: string;
    package_id: string;
  },
): Promise<string | null> {
  try {
    return await tx.savepoint(async (sp) => {
      const [org] = await sp<{ name: string; default_locale: string }[]>`
        select name, default_locale from organizations where id = ${order.org_id}`;
      const [pkg] = await sp<{ name: string }[]>`
        select name from sponsor_packages where id = ${order.package_id}`;
      const locale = await recipientLocale(sp, { pick: null, userId: null, orgDefault: org?.default_locale ?? null });
      const content = await sponsorRefundEmail(
        {
          orgName: org?.name ?? "the organiser",
          packageName: pkg?.name ?? "sponsorship",
          sponsorName: order.sponsor_name,
          amountCents: order.amount_cents,
          currency: order.currency,
        },
        locale,
      );
      return enqueueEmailOnce(sp, {
        kind: "sponsor_refund",
        refType: "sponsor_order",
        refId: order.id,
        dedupeKey: onceKey("sponsor_refund", "sponsor_order", order.id, "refunded"),
        orgId: order.org_id,
        to: order.sponsor_email,
        transactional: false,
        expiresAt: expiryWithin(null),
        ...content,
      });
    });
  } catch (err) {
    log.error({ err, orderId: order.id }, "sponsors: refund notice could not be queued");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dispute lifecycle (payments-hardening Task 6, P0-2)
// ---------------------------------------------------------------------------

/** Origin for sponsor emails fired from webhook (request-less) paths — the
 *  same override order as registrations' fallbackOrigin. NEXT_PUBLIC_APP_URL
 *  (the previous source) is not set in any environment, so receipts went out
 *  with relative "/live/…" links no mail client could open. */
function sponsorEmailOrigin(): string {
  return (
    process.env.OAUTH_BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

/** Who a sponsorship dispute notice goes to: the org's current owner (the
 *  oldest, `orgOwnerRecipient`, owner ruling Q2) as an account, in their
 *  language (D4: the account's, then the org default). Read on the pool,
 *  before any transaction opens. `null`: the org has no current owner, so the
 *  dispute is recorded and nobody is mailed. */
async function sponsorDisputeRecipient(orgId: string, orgDefault: string | null) {
  const owner = await orgOwnerRecipient(sql, orgId);
  return owner && {
    ...owner,
    locale: await recipientLocale(sql, { pick: null, userId: owner.userId, orgDefault }),
  };
}

/** Actorless audit breadcrumb for a sponsor recovery, on the same
 *  competition_events ledger the registration recovery writes to. A sponsor
 *  package can be org-wide (no competition) and there is no actorless
 *  org-scoped audit table (staff_audit_log needs a staff actor), so an org-wide
 *  order records no breadcrumb — the money records on sponsor_orders stay the
 *  source of truth. Must NOT throw (the core's auditNote contract). */
async function auditSponsorRecovery(
  order: { org_id: string; competition_id: string | null },
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!order.competition_id) return;
  await sql`
    insert into competition_events (competition_id, org_id, type, payload, actor_id)
    values (${order.competition_id}, ${order.org_id}, ${type},
            ${sql.json(payload as never)}, ${null})`;
}

/** Sponsor-flavoured wrapper over the shared dispute-recovery core
 *  (dispute-recovery.ts, Task 5): the charge→transfer→reversal mechanics and
 *  the dispute_id replay guard live in the core; this namespaces the audit
 *  under `sponsor.` and tags the reversal with sponsor_order_id. Never throws;
 *  Stripe calls stay OUTSIDE any sql tx. */
async function recoverSponsorDispute(
  dispute: Stripe.Dispute,
  order: { id: string; org_id: string; competition_id: string | null },
): Promise<{ recoveredCents: number; already: boolean }> {
  return recoverDisputedTransferCore(dispute, {
    auditNote: (type, extra) =>
      auditSponsorRecovery(order, `sponsor.${type}`, { order_id: order.id, ...extra }),
    reversalMetadata: { sponsor_order_id: order.id },
  });
}

/** A dispute parks the deal (D8: a parked live deal holds its sponsor at pending; a parked scheduled deal goes live parked),
 *  then applies. `coalesce` keeps the first park time under replay. A legacy row (D6, F18) is never parked: its deal columns
 *  are not this path's to write. */
async function parkDeal(tx: Tx, locked: LockedDeal): Promise<void> {
  if (locked.sponsorId === null || isLegacyDeal(locked.deal)) return;
  await tx`update sponsor_orders set parked_at = coalesce(parked_at, now()) where id = ${locked.deal.id}`;
  await applyDealsToSponsor(tx, locked.sponsorId, null);
}

/** A dispute that closes without taking the money (won, or an inquiry dropped) unparks the deal, then applies. */
async function unparkDeal(tx: Tx, locked: LockedDeal): Promise<void> {
  if (locked.sponsorId === null || isLegacyDeal(locked.deal)) return;
  await tx`update sponsor_orders set parked_at = null where id = ${locked.deal.id}`;
  await applyDealsToSponsor(tx, locked.sponsorId, null);
}

/**
 * charge.dispute.created / .funds_withdrawn / .closed for a sponsor package
 * charge (P0-2 — destination charges make the PLATFORM liable, exactly like
 * entry fees). `created` flags the order and alerts the owner, and parks the
 * DEAL (`parked_at`) for a formal dispute, which takes the money at once.
 * An inquiry (`warning_*`) takes no money, so its deal stays live until
 * `funds_withdrawn` reports the money taken and parks it (owner, 2026-10-26).
 * `closed` clears the flag and, on a win (or a closed inquiry,
 * `warning_closed`) while the order is still paid, unparks the deal; on a
 * loss it writes the order off, ENDS the deal (`dispute_lost`) and reverses
 * the club's transfer. Every move reaches the sponsor only through
 * `applyDealsToSponsor` (D8: a parked live deal holds its sponsor at
 * pending; an ended last deal resets it, only on that transition, F7), in
 * the one lock order (F2: the deal's sponsor, then its deals). A legacy row
 * (D6, F18) flips its money and dispute columns only. Dispatched after
 * handleRegistrationDispute for `created` and `closed`, and alone for
 * `funds_withdrawn` — a non-sponsor intent matches no order row and no-ops.
 *
 * The owner's notices go through the email outbox (kinds
 * `sponsor_dispute_alert`, `sponsor_dispute_won`, `sponsor_dispute_lost`, ref
 * `dispute/<id>`), addressed to the owner's account in their language; the
 * worker makes the first attempt.
 *
 * Replay-safe: the disputed_at/dispute_id + status writes converge, the
 * created alert and the won notice are queued only on their transition, the
 * withdrawal's park holds only while THIS dispute is open on a paid order, the
 * lost recovery + its notice short-circuit on the core's dispute_id metadata
 * guard, and each once-key holds its dispute to one row of its kind. Stripe
 * calls stay OUTSIDE any sql tx.
 */
export async function handleSponsorDispute(
  dispute: Stripe.Dispute,
  phase: "created" | "funds_withdrawn" | "closed",
): Promise<boolean> {
  const intent =
    typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  if (!intent) return false;
  const [order] = await sql<
    (SponsorOrderRow & {
      org_id: string;
      disputed_at: Date | null;
      dispute_id: string | null;
      competition_id: string | null;
      org_name: string | null;
      org_default_locale: string | null;
      package_name: string | null;
    })[]
  >`
    select ${sql(ORDER_COLS as unknown as string[])}, org_id, disputed_at, dispute_id,
           -- The deal's own scope (its snapshot, D4), never the package's: a deal scoped to C on an any-competition package
           -- audits on C (F35).
           competition_id,
           (select name from sponsor_packages p where p.id = sponsor_orders.package_id)
             as package_name,
           (select name from organizations g where g.id = sponsor_orders.org_id) as org_name,
           (select default_locale from organizations g where g.id = sponsor_orders.org_id)
             as org_default_locale
    from sponsor_orders where payment_intent_id = ${intent}`;
  if (!order) return false; // not a sponsor charge (or it doesn't know its intent YET)

  // What a dispute notice says about the order, read with it, before any
  // transaction. Rendering needs no handle.
  const noticeArgs = {
    orgName: order.org_name ?? "your organisation",
    packageName: order.package_name ?? "sponsorship",
    sponsorName: order.sponsor_name,
    amountCents: dispute.amount,
    currency: order.currency,
  };

  if (phase === "created") {
    const recipient = await sponsorDisputeRecipient(order.org_id, order.org_default_locale);
    // ONE transaction flags the order and queues the owner's alert, so the
    // alert exists exactly when the flag does (R1). The alert and the
    // placement park run only on the TRANSITION to this dispute (the order,
    // read under lock, named another dispute or none): a redelivered `created`
    // is not one, and coalesce keeps the first flag time. The once-key keeps
    // an older dispute's `created`, arriving again after a newer one moved the
    // order on, from alerting twice.
    //
    // The park is for a formal dispute only. An inquiry (Stripe's `warning_`
    // statuses) is the cardholder's bank asking questions: no money is taken,
    // and Stripe can take 120 days to close one, so the sponsor who paid stays
    // on show. If the network escalates it, `funds_withdrawn` parks it then.
    const inquiry = dispute.status.startsWith("warning_");
    await sql.begin(async (tx) => {
      const locked = await lockDealAndSponsor(tx, order.id);
      if (!locked) return;
      await tx`update sponsor_orders
               set disputed_at = coalesce(disputed_at, now()), dispute_id = ${dispute.id}
               where id = ${order.id}`;
      const firstFlag = locked.deal.dispute_id !== dispute.id;
      if (firstFlag && recipient) {
        const kind = "sponsor_dispute_alert";
        await enqueueEmailOnce(tx, {
          kind,
          refType: "dispute",
          refId: dispute.id,
          orgId: order.org_id,
          to: recipient.email,
          recipientUserId: recipient.userId,
          ...(await sponsorDisputeAlertEmail(noticeArgs, recipient.locale)),
          transactional: false,
          expiresAt: expiryWithin(null),
          dedupeKey: onceKey(kind, "dispute", dispute.id, "created"),
        });
      }
      if (firstFlag && !inquiry) await parkDeal(tx, locked);
    });
    bustPublicSponsors(order.org_id);
    return true;
  }

  if (phase === "funds_withdrawn") {
    // The money is taken (Stripe: "funds are removed from your account due to
    // a dispute"), at once for a formal dispute, or when the network escalates
    // an inquiry: this is what parks an inquiry's placement. No mail: the
    // owner was alerted at `created`. Parked only while THIS dispute is open
    // on a paid order (read under lock): a withdrawal delivered after the
    // dispute closed, or one for a dispute the order no longer carries, must
    // not take a placement down that nothing will bring back. A formal
    // dispute's `created` has parked it already, so the write converges, and
    // a withdrawal that beats its `created` leaves the park to that event.
    await sql.begin(async (tx) => {
      const locked = await lockDealAndSponsor(tx, order.id);
      if (!locked) return;
      const prior = locked.deal;
      const open = prior.payment_status === "paid" && prior.disputed_at !== null && prior.dispute_id === dispute.id;
      if (open) await parkDeal(tx, locked);
    });
    bustPublicSponsors(order.org_id);
    return true;
  }

  // An inquiry (opened as `warning_needs_response`) that the bank drops without a chargeback closes `warning_closed`: no money was
  // ever taken, which is a win in all but name. Without this arm the flag stayed for good, and with it the organiser's refusal to
  // reactivate by hand. An inquiry no longer parks its placement, but one opened before that change did, and this brings it back. It
  // reuses the won notice and its key.
  if (dispute.status === "won" || dispute.status === "warning_closed") {
    const recipient = await sponsorDisputeRecipient(order.org_id, order.org_default_locale);
    // ONE transaction clears the flag and queues the owner's notice (R1),
    // only on the TRANSITION (replay-safe): the order, read under lock, still
    // carried the flag. A redelivered `won` finds it clear. The once-key keeps
    // the notice single should this dispute flag the order again and win again.
    // The placement comes back, and the notice ("the money stays with you")
    // goes, only while the order is still paid: a full refund is one of the
    // two ways Stripe offers to resolve an inquiry, and a refunded sponsor
    // never goes back on boards and public pages.
    await sql.begin(async (tx) => {
      const locked = await lockDealAndSponsor(tx, order.id);
      if (!locked) return;
      const prior = locked.deal;
      await tx`update sponsor_orders set disputed_at = null where id = ${order.id}`;
      const firstClear = prior.disputed_at !== null;
      const stillPaid = prior.payment_status === "paid";
      if (firstClear && stillPaid && recipient) {
        const kind = "sponsor_dispute_won";
        await enqueueEmailOnce(tx, {
          kind,
          refType: "dispute",
          refId: dispute.id,
          orgId: order.org_id,
          to: recipient.email,
          recipientUserId: recipient.userId,
          ...(await sponsorDisputeWonEmail(noticeArgs, recipient.locale)),
          transactional: false,
          expiresAt: expiryWithin(null),
          dedupeKey: onceKey(kind, "dispute", dispute.id, "won"),
        });
      }
      // The deal is unparked and applied: a live deal puts its sponsor back (an inquiry never parked it, and a live deal's
      // status is the deal's, never a hand switch, D9). A refunded deal has ended, and an ended deal never comes back.
      if (stillPaid) await unparkDeal(tx, locked);
    });
    bustPublicSponsors(order.org_id);
    return true;
  }

  if (dispute.status === "lost") {
    // The write-off must land whatever Stripe does next — same contract as the
    // registration dispute-lost path: committed BEFORE the recovery's Stripe
    // calls. The money is written off and the deal ENDS (`dispute_lost`), then
    // the sponsor's deals are applied: `endedDealId` only when this loss ended a
    // live or open deal (F7), so a replay, or a loss on an already-ended deal,
    // leaves a hand switch-back-on alone. Idempotent under replay.
    await sql.begin(async (tx) => {
      const locked = await lockDealAndSponsor(tx, order.id);
      if (!locked) return;
      const { deal } = locked;
      if (locked.sponsorId === null || isLegacyDeal(deal)) {
        await tx`update sponsor_orders set status = 'refunded' where id = ${deal.id}`;
        return;
      }
      const now = new Date();
      const wasOpen = deal.deal_status !== "ended";
      await tx`
        update sponsor_orders
           set status = 'refunded', deal_status = 'ended', ended_at = coalesce(ended_at, ${now}), ended_reason = 'dispute_lost'
         where id = ${deal.id}`;
      await applyDealsToSponsor(tx, locked.sponsorId, null, { now, endedDealId: wasOpen ? deal.id : null });
    });
    const recovery = await recoverSponsorDispute(dispute, order);
    // `already` = a replayed close (metadata guard hit) — the write-off + email
    // already happened on the first run.
    if (!recovery.already) {
      // The owner's notice states the write-off and what the recovery pulled
      // back, both fixed now, in the owner's language (D4). It is queued once
      // per dispute (`<dispute id>:lost`) and the worker makes the first
      // attempt. No catch: a refused enqueue fails the webhook (D1).
      const recipient = await sponsorDisputeRecipient(order.org_id, order.org_default_locale);
      if (recipient) {
        const kind = "sponsor_dispute_lost";
        await enqueueEmailOnce(sql, {
          kind,
          refType: "dispute",
          refId: dispute.id,
          orgId: order.org_id,
          to: recipient.email,
          recipientUserId: recipient.userId,
          ...(await sponsorDisputeLostEmail({ ...noticeArgs, recoveredCents: recovery.recoveredCents }, recipient.locale)),
          transactional: false,
          expiresAt: expiryWithin(null),
          dedupeKey: onceKey(kind, "dispute", dispute.id, "lost"),
        });
      }
    }
    bustPublicSponsors(order.org_id);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Dispute evidence pack — sponsor twin of registrations' buildDisputeEvidence
// ---------------------------------------------------------------------------

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The evidence pack's delivery-proof click line (S13, S10 review m5). `sponsors.click_count` is bumped by every sponsor link
 *  tap S10 records - board and sponsor-page links AND on-stream short codes - and also holds the clicks counted before click
 *  rows existed, so it is labelled as exactly that: never "logo" clicks, never visitors or people. */
export const SPONSOR_EVIDENCE_CLICKS_LABEL = "Sponsor link clicks recorded (boards and on-stream codes)";

function evRow(label: string, value: string): string {
  return `<tr><td style="padding:6px 14px 6px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${escHtml(label)}</td><td style="padding:6px 0;font-weight:600">${escHtml(value)}</td></tr>`;
}

/**
 * Everything the platform holds that shows a disputed sponsorship was
 * genuine, as one printable HTML document mapped to Stripe's evidence
 * fields: the order record, the reconstructed payment receipt (customer
 * communication), the placement's delivery proof (live period, public page,
 * click count) and the audit trail. Organisers download it from the
 * disputed order row and paste/upload into the dispute response.
 */
export async function buildSponsorDisputeEvidence(
  auth: AuthCtx,
  orderId: string,
  origin: string,
): Promise<{ ref: string; html: string }> {
  const order = await withTenant(auth.orgId, async (tx) => {
    // Any deal, not only one paid online: an offline or complimentary deal has no billing email and pays `none` (V495).
    const [row] = await tx<
      (Omit<SponsorOrderRow, "sponsor_email" | "status"> & {
        sponsor_email: string | null;
        status: string;
        dispute_id: string | null;
        package_name: string | null;
      })[]
    >`select ${tx(ORDER_COLS)}, dispute_id, package_name from sponsor_orders where id = ${orderId}`;
    if (!row) throw new HttpError(404, "order not found");
    return row;
  });
  const [pkg] = await sql<
    { name: string; tier: SponsorTier; competition_id: string | null }[]
  >`select name, tier, competition_id from sponsor_packages where id = ${order.package_id}`;
  const [org] = await sql<{ name: string; slug: string; default_locale: string }[]>`
    select name, slug, default_locale from organizations where id = ${auth.orgId}`;
  const [comp] = pkg?.competition_id
    ? await sql<{ name: string; slug: string }[]>`
        select name, slug from competitions where id = ${pkg.competition_id}`
    : [undefined];
  const [placement] = order.sponsor_id
    ? await sql<{ tier: string; status: string; click_count: number; created_at: Date }[]>`
        select tier, status, click_count, created_at from sponsors where id = ${order.sponsor_id}`
    : [undefined];

  const events = await sql<{ type: string; payload: unknown; created_at: Date }[]>`
    select e.type, e.payload, e.created_at
    from competition_events e
    join competitions c on c.id = e.competition_id
    where c.org_id = ${auth.orgId} and e.payload->>'order_id' = ${orderId}
    order by e.created_at`;

  // The receipt, reconstructed with the exact sender inputs, in the language
  // it was sent in: the org's (queueSponsorReceipt resolves it the same way).
  // Its package name is the deal's snapshot, as the payment webhook sends it (D4, T8 review m3): a package renamed since must
  // not make the evidence disagree with the mail the sponsor received.
  const publicUrl = org ? `${origin}${routes.publicHub(org.slug)}` : null;
  const locale = await recipientLocale(sql, { pick: null, userId: null, orgDefault: org?.default_locale ?? null });
  const emailText = (
    await sponsorReceiptEmail(
      {
        orgName: org?.name ?? "the organiser",
        packageName: order.package_name ?? "sponsorship",
        sponsorName: order.sponsor_name,
        amountCents: order.amount_cents,
        currency: order.currency,
        publicUrl,
      },
      locale,
    )
  ).text;

  const when = (d: Date | string | null) => (d ? new Date(d).toISOString() : "—");
  const ref = orderId.slice(0, 8);

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Dispute evidence — sponsorship ${escHtml(ref)}</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,sans-serif;color:#18181b">
<div style="background:#150b36;color:#f5f0e8;padding:18px 32px 8px">
  <div style="font-size:18px;font-weight:800;letter-spacing:2px">SEAZN <span style="color:#a3e635">CLUB</span></div>
  <div style="text-align:right;color:#ef4444;font-size:14px;line-height:8px">&#9679;</div>
</div>
<div style="height:4px;background:#a3e635"></div>
<div style="max-width:760px;margin:0 auto;padding:28px 32px">
  <h1 style="font-size:22px;margin:0 0 2px">Dispute evidence pack — sponsorship ${escHtml(ref)}</h1>
  <p style="margin:0 0 20px;color:#6b7280;font-size:13px">
    Generated ${new Date().toISOString()} · ${escHtml(org?.name ?? "")} · for the Stripe dispute response${order.dispute_id ? ` (${escHtml(order.dispute_id)})` : ""}.
  </p>

  <h2 style="font-size:15px;margin:20px 0 6px">Sponsorship order (product/service + customer)</h2>
  <table style="font-size:14px;border-collapse:collapse">
    ${evRow("Order", orderId)}
    ${evRow("Sponsor", order.sponsor_name)}
    ${evRow("Customer email", order.sponsor_email ?? "—")}
    ${evRow("Package", `${pkg?.name ?? "—"} (${pkg?.tier ?? "—"})`)}
    ${evRow("Scope", comp ? comp.name : "whole organisation")}
    ${evRow("Amount", `${(order.amount_cents / 100).toFixed(2)} ${order.currency.toUpperCase()}`)}
    ${evRow("Payment intent", order.payment_intent_id ?? "—")}
    ${evRow("Ordered at", when(order.created_at))}
    ${evRow("Paid at", when(order.paid_at))}
    ${evRow("Status", order.status)}
    ${evRow("Disputed at", when(order.disputed_at ?? null))}
  </table>

  <h2 style="font-size:15px;margin:24px 0 6px">Receipt email (customer communication)</h2>
  <p style="margin:0 0 6px;color:#6b7280;font-size:12px">${order.sponsor_email ? `Reconstruction of the transactional receipt sent to ${escHtml(order.sponsor_email)} on payment.` : "This deal has no billing email: no receipt was mailed. Reconstruction of the receipt it would have carried."}</p>
  <pre style="background:#f6f5f8;border-radius:8px;padding:14px;font-size:12px;white-space:pre-wrap">${escHtml(emailText)}</pre>

  <h2 style="font-size:15px;margin:24px 0 6px">Placement delivered (service provided)</h2>
  ${
    placement
      ? `<table style="font-size:14px;border-collapse:collapse">
    ${evRow("Placement tier", placement.tier)}
    ${evRow("Live from", when(order.paid_at))}
    ${evRow("Current state", placement.status === "pending" ? "parked by this dispute" : placement.status)}
    ${evRow("Public page", publicUrl ?? "—")}
    ${evRow(SPONSOR_EVIDENCE_CLICKS_LABEL, String(placement.click_count))}
  </table>`
      : `<p style="color:#6b7280;font-size:13px;margin:0">No placement row (payment did not activate one).</p>`
  }

  <h2 style="font-size:15px;margin:24px 0 6px">Activity log (${events.length})</h2>
  ${
    events.length === 0
      ? `<p style="color:#6b7280;font-size:13px;margin:0">No competition-scoped events reference this order.</p>`
      : `<table style="font-size:13px;border-collapse:collapse">${events
          .map((e) =>
            evRow(new Date(e.created_at).toISOString(), `${e.type} ${JSON.stringify(e.payload)}`),
          )
          .join("")}</table>`
  }

  <h2 style="font-size:15px;margin:24px 0 6px">How to use</h2>
  <ol style="font-size:13px;color:#374151;padding-left:18px;margin:0">
    <li>Open the dispute in your Stripe Dashboard (platform account).</li>
    <li>Product/service: paste the Sponsorship order section; the service is the placement period above.</li>
    <li>Customer communication / receipt: paste the receipt reconstruction.</li>
    <li>Placement + activity log: upload this document as supporting evidence.</li>
  </ol>
</div>
</body></html>`;

  return { ref, html };
}
