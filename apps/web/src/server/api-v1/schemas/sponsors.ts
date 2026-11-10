// /api/v1 contracts — sponsor CRM: sponsors, stream settings, report links, packages, sponsor deals.
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
import { isRedirectableUrl, SPONSOR_URL_HTTP_ONLY } from "../../../lib/sponsor-clicks.ts";
import { SPONSOR_FREQUENCIES } from "../../../lib/sponsor-frequencies.ts";
// The sponsor deal domain's value sets (strip-types-safe: its only import is `import type`).
import { DEAL_STATUSES, END_REASONS, GO_LIVE_RULES, PAYMENT_METHODS, PAYMENT_STATUSES } from "../../../lib/sponsor-deals.ts";
import { patchOf } from "../../../lib/zod-patch.ts";
import { Uuid } from "./common.ts";
import { ENDS_BEFORE_STARTS } from "./competitions.ts";

// Sponsor CRM (v10 PROMPT-56) -------------------------------------------------

export const SponsorTier = z.enum(["title", "gold", "silver", "partner"]);
export const SponsorStatus = z.enum(["active", "pending", "inactive"]);

/** Sponsor deals (plan 2026-11-07-sponsor-deals D2/D4): one deal as the console reads it — lib/sponsor-deals.ts's
 *  SponsorDeal, its value sets the domain's own (each mirrors a sponsor_orders CHECK). `payment_status` is the money column
 *  `status`; the snapshot (tier, includes_on_stream, package_name, competition_id, amount) is taken when the deal is made. */
export const SponsorDeal = z.object({
  id: z.string(),
  /** Null only on a legacy order, which is never a sponsor's shown deal. */
  sponsor_id: z.string().nullable(),
  package_id: z.string(),
  deal_status: z.enum(DEAL_STATUSES),
  payment_status: z.enum(PAYMENT_STATUSES),
  payment_method: z.enum(PAYMENT_METHODS),
  go_live: z.enum(GO_LIVE_RULES),
  package_name: z.string(),
  tier: SponsorTier,
  includes_on_stream: z.boolean(),
  /** The deal's scope; null is the whole organisation. */
  competition_id: z.string().nullable(),
  amount_cents: z.number().int(),
  currency: z.string(),
  sponsor_name: z.string(),
  sponsor_email: z.string().nullable(),
  ends_at: z.string().nullable(),
  created_at: z.string(),
  created_by: z.string().nullable(),
  invoice_sent_at: z.string().nullable(),
  paid_at: z.string().nullable(),
  marked_paid_by: z.string().nullable(),
  approved_at: z.string().nullable(),
  approved_by: z.string().nullable(),
  live_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  ended_reason: z.enum(END_REASONS).nullable(),
  /** Set while an open dispute parks a live deal: its sponsor is hidden until the dispute is resolved. */
  parked_at: z.string().nullable(),
  disputed_at: z.string().nullable(),
  dispute_id: z.string().nullable(),
  /** The deal records a Stripe payment intent. On a paid deal: a card payment at Stripe paid it, so a refund goes back to
   *  the card through Stripe; false for an offline deal and one marked as paid by hand. The intent id itself is never sent. */
  has_payment_intent: z.boolean(),
  /** Always null until invoices are numbered. */
  invoice_number: z.number().int().nullable(),
});

/** Sponsor deals, Task 6 (plan 2026-11-07-sponsor-deals D16; spec §5.1, §5.2): the Add deal body. STRICT — an unknown key
 *  is a 400, never silently dropped. The usecase reuses this very object (`CreateDealInput`), so the documented body and the
 *  enforced one are one schema. `competition_id` null is the whole organisation; `ends_on` is a date in the org's timezone
 *  (stored as the start of the next day there); `end_current` ends the sponsor's live deal in the same transaction. */
export const CreateSponsorDeal = z
  .object({
    package_id: Uuid,
    competition_id: Uuid.nullable(),
    payment_method: z.enum(PAYMENT_METHODS),
    go_live: z.enum(GO_LIVE_RULES),
    sponsor_email: z.string().email().max(320).nullish(),
    ends_on: z.iso.date().nullish(),
    end_current: z.boolean().default(false),
  })
  .strict();

/** F11: the create answers the deal and, for an online deal, the Checkout url its invoice carries (null otherwise). The url
 *  rides beside the deal, never on it: SponsorDeal stays url-free. */
export const SponsorDealCreated = z.object({
  deal: SponsorDeal,
  checkout_url: z.string().nullable(),
});

/** Send invoice (Task 7): the deal after the send and the Checkout url the invoice carries (beside the deal, never on it). */
export const SponsorDealInvoiceSent = z.object({
  deal: SponsorDeal,
  checkout_url: z.string(),
});

export const Sponsor = z.object({
  id: z.string(),
  competition_id: z.string().nullable(),
  name: z.string(),
  url: z.string().nullable(),
  logo_path: z.string().nullable(),
  tier: SponsorTier,
  display_order: z.number().int(),
  status: SponsorStatus,
  click_count: z.number().int(),
  created_at: z.string(),
  /** R4 sponsors on stream (V492): ticked onto the stream's rotation. Written only through PATCH; a new sponsor starts false. */
  on_stream: z.boolean(),
  /** Set on list reads when a paid package order activated this placement. */
  paid_order_id: z.string().nullable().optional(),
  /** List reads: true while a payment dispute has the placement parked — that
   *  order carries an open dispute AND the placement is down ('pending'). An
   *  inquiry that has taken no money leaves it live, so this stays false.
   *  While true the placement can't be re-activated by hand. */
  dispute_parked: z.boolean().optional(),
  /** List reads: a lost dispute wrote the activating order off — the
   *  placement stays down and this explains why. */
  dispute_lost: z.boolean().optional(),
  /** Sponsor deals: the deal this sponsor's row shows (a live one first, then one waiting to go live, then the latest
   *  ended), or null when it has none. */
  deal: SponsorDeal.nullable(),
  /** A live deal sets this sponsor's tier, scope, stream and status: a PATCH of any of them answers 409
   *  `sponsor_locked_by_deal`. */
  locked_by_deal: z.boolean(),
  /** A deal waits to go live: the sponsor is hidden until it does, and a status PATCH answers 409 `sponsor_has_open_deal`. */
  has_open_deal: z.boolean(),
  /** The billing email of this sponsor's latest deal that has one (what a new deal's form opens at). */
  last_billing_email: z.string().nullable(),
});

export const CreateSponsor = z.object({
  name: z.string().min(1).max(80),
  // http(s) only (R4 S10 fix round 1, m1): zod's `.url()` alone accepts `javascript:` and `data:`.
  url: z.string().url().max(500).refine(isRedirectableUrl, { message: SPONSOR_URL_HTTP_ONLY }).nullish(),
  logo_path: z.string().max(500).nullish(),
  tier: SponsorTier.default("partner"),
  competition_id: Uuid.nullish(),
  status: SponsorStatus.default("active"),
});

// `patchOf`, not `.partial()`: a partial still fills `tier` and `status` from their defaults, rewriting both on a PATCH that
// never named them (R4 S12; final review 2, m5). `on_stream` is PATCH-ONLY (R4 S12, row 30): a created sponsor starts off the
// stream, and the first tick is what turns the org's rotation on (ruling R12). It is declared HERE, beside the patch, and
// never on `CreateSponsor`.
export const PatchSponsor = patchOf(CreateSponsor).extend({ on_stream: z.boolean().optional() });

/** R4 sponsors on stream, S12: one scope's dial (spec §3.2, §5.1). `competitionId: null` is the org row. */
export const SponsorStreamFrequency = z.enum(SPONSOR_FREQUENCIES);
export const PutSponsorStreamSettings = z.object({
  competitionId: Uuid.nullable(),
  enabled: z.boolean(),
  frequency: SponsorStreamFrequency,
});
export const SponsorStreamSettings = PutSponsorStreamSettings;

/** R4 sponsors on stream, S13 (spec §4, §5.2): a shareable report link for one sponsor over inclusive DATES (V492 from_date /
 *  to_date), optionally one competition. The usecase re-checks the dates (server/sponsors/report.ts), so a caller that skips
 *  this schema is refused the same way. */
export const CreateSponsorReportLink = z
  .object({
    competitionId: Uuid.nullable(),
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .superRefine((v, ctx) => {
    if (v.to < v.from) ctx.addIssue({ code: "custom", path: ["to"], message: ENDS_BEFORE_STARTS });
  });
/** The url is root-relative (`/r/sponsor/<token>`) and answered ONCE: only the token's hash is kept. */
export const CreatedSponsorReportLink = z.object({ id: z.string(), url: z.string() });
export const RevokedSponsorReportLink = z.object({ revoked: z.literal(true) });

export const ReorderSponsors = z.object({ ids: z.array(Uuid).min(1).max(200) });

export const SponsorPackage = z.object({
  id: z.string(),
  competition_id: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  price_cents: z.number().int(),
  currency: z.string(),
  tier: SponsorTier,
  active: z.boolean(),
  created_at: z.string(),
  /** A deal on this package puts its sponsor on the stream too. */
  includes_on_stream: z.boolean(),
  /** How many distinct sponsors hold an open (non-ended) deal on this package. */
  used_by: z.number().int().nonnegative(),
});

export const CreateSponsorPackage = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  price_cents: z.number().int().positive().max(5_000_000),
  currency: z.string().length(3).toLowerCase().default("gbp"),
  tier: SponsorTier.default("partner"),
  competition_id: Uuid.nullish(),
  includes_on_stream: z.boolean().default(false),
});
