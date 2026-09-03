import { z } from "zod";
import { isValidIana } from "@/lib/tz";

/** Authenticated user. `password_hash` is never sent to the client. */
export const userSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string(),
  email: z.string(),
  avatar_url: z.string().nullable(),
  /** IANA zone (spec 2026-07-14); null = follow the browser (seazn_tz cookie). */
  timezone: z.string().nullable(),
  /** Preferred UI locale (v5 i18n); null = negotiate from Accept-Language. */
  locale: z.string().nullable(),
});
export type User = z.infer<typeof userSchema>;

// ---- organizations / teams ---------------------------------------------------

/** Access levels within an organization, from most to least privileged.
 *  `scorer` (doc 13) is scoring-only: no org-wide read, assigned scope only. */
export const ORG_ROLES = ["owner", "admin", "viewer", "scorer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Roles allowed to edit (create tournaments, record results, manage members). */
export const EDITOR_ROLES = ["owner", "admin"] as const;

/** Roles with org-wide read access (doc 13 §2 — scorers see assigned scope only). */
export const READ_ROLES = ["owner", "admin", "viewer"] as const;

/** May this caller hold a WRITE-CAPABLE credential (today: a team join code)?
 *
 *  An API key resolves `role: null` whatever its scopes, so it cannot be shown
 *  to be write-capable and is refused — an integration that needs join codes
 *  gets a deliberate scope check, not a default. Declared once here because the
 *  rule is enforced on two different surfaces (the list read model and every
 *  single-registration action response) and a second copy would drift the first
 *  time the role set changes. */
export function mayHoldBearerCredential(role: OrgRole | null): boolean {
  return role !== null && (EDITOR_ROLES as readonly string[]).includes(role);
}

/** Scorer assignment scopes (doc 13 §3): fixture ⊂ division ⊂ competition. */
export const SCORER_SCOPE_TYPES = ["competition", "division", "fixture"] as const;
export type ScorerScopeType = (typeof SCORER_SCOPE_TYPES)[number];

/**
 * An organization as the IDENTITY lane sees it: nav, org switcher, page auth.
 *
 * Deliberately carries NO payout fields (#341). `payment_instructions` is free
 * text an owner writes to tell offline entrants how to pay them — in practice
 * bank details, IBANs, UPI IDs — and this shape is what `getUserOrgs` caches in
 * Redis for 120s and what `GET /api/orgs`, a nav endpoint, returns to every
 * member. The two places that genuinely need those columns read them
 * themselves, scoped to the one org being edited or paid:
 * `o/[orgSlug]/settings/connect/page.tsx` and `usecases/registrations.ts`.
 */
export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  created_by: string | null;
  created_at: string;
  logo_url: string | null;
  logo_storage_path: string | null;
  /** `{ colors: { primary: "#hex" } }` — same shape as competitions.branding. */
  branding: unknown;
  /**
   * VENUE-lane scheduling timezone (V305), inherited by every division that
   * has no stored tz of its own. Null = not set → 'UTC'. This is NOT
   * `users.timezone`: that is the personal display lane, and a London-based
   * organiser can run an event in Malaga.
   */
  timezone: string | null;
}

/** The identity shape plus the payout columns, for the org-settings lane. */
export interface Organization extends OrgSummary {
  payment_instructions: string | null;
  /** Preselect for NEW division registration settings (spec 2026-07-12 §3). */
  default_payment_method: "offline" | "stripe";
}

/** An organization paired with the current user's role in it. */
export interface OrgMembership extends OrgSummary {
  role: OrgRole;
}

/** A member row joined with the user's identity, for the members panel. */
export interface OrgMember {
  user_id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  role: OrgRole;
  created_at: string;
}

export interface OrgInvite {
  id: string;
  org_id: string;
  role: OrgRole;
  default_scope: { type: ScorerScopeType; id: string } | null;
  /** Invite-by-email: the recipient address; null for shareable links. */
  email: string | null;
  token: string;
  expires_at: string | null;
  max_uses: number;
  used_count: number;
  revoked: boolean;
  created_at: string;
}

/** Preview shown on the public /join/<token> page before joining. */
export interface InvitePreview {
  org_name: string;
  role: OrgRole;
  valid: boolean;
  reason?: string;
}

// ---- request payload schemas -------------------------------------------------

export const loginSchema = z.object({
  email: z.string().email().max(120),
  password: z.string().min(6).max(100),
  /** Post-auth redirect carried through invite links; validated server-side
   *  by safeNextPath. Without this key .strict() 400s every invite signup. */
  next: z.string().max(500).optional(),
}).strict();

export const signupSchema = loginSchema;

// ---- organization request payloads -------------------------------------------

// The slug is generated automatically; only a display name is collected.
export const createOrgSchema = z.object({
  name: z.string().min(1).max(60),
  /** Opt in to sharing a bill at creation (#212): attach the new org onto this
   *  billing group the actor pays for. Absent = its own bill (the default). */
  attachToGroupId: z.string().uuid().optional(),
}).strict();

export const renameOrgSchema = z.object({
  name: z.string().min(1).max(60),
}).strict();

export const updateProfileSchema = z.object({
  display_name: z.string().trim().min(1).max(80).optional(),
  /** IANA zone or null to clear ("follow my browser"). Rejects bogus zones so
   *  the column only ever holds a value the render layer's Intl accepts. */
  timezone: z
    .string()
    .trim()
    .refine((v) => isValidIana(v), { message: "Unknown timezone" })
    .nullable()
    .optional(),
  /** UI locale (v5 i18n); null clears back to negotiated. Widen the enum when
   *  hi/ta land. */
  locale: z.enum(["en", "fr", "es", "nl"]).nullable().optional(),
}).strict().refine(
  (v) => v.display_name !== undefined || v.timezone !== undefined || v.locale !== undefined,
  { message: "Nothing to update" },
);

export const createInviteSchema = z.object({
  role: z.enum(["admin", "viewer", "scorer"]),
  max_uses: z.number().int().min(0).max(1000).default(1),
  /** Invite-by-email: send the join link to this address (forces single-use). */
  email: z.string().trim().email().max(120).nullable().optional(),
  expires_in_days: z.number().int().min(1).max(365).nullable().optional(),
  /** Scorer invites only (doc 13 §4): accept creates this assignment too. */
  default_scope: z
    .object({ type: z.enum(SCORER_SCOPE_TYPES), id: z.string().uuid() })
    .nullable()
    .optional(),
}).strict();

export const setRoleSchema = z.object({
  role: z.enum(ORG_ROLES),
}).strict();

export const setActiveOrgSchema = z.object({
  org_id: z.string().uuid(),
}).strict();

// ---- account lifecycle schemas -----------------------------------------------

export const transferOwnerSchema = z.object({
  new_owner_id: z.string().uuid(),
}).strict();

export const changeEmailSchema = z.object({
  new_email: z.string().email().max(120),
}).strict();

export const deleteAccountSchema = z.object({
  confirm: z.literal("DELETE"),
}).strict();

// ---- billing request schemas -------------------------------------------------

/**
 * The plan keys a self-serve `POST /api/billing/checkout` — and a plan
 * SWITCH via `/api/billing/plan` + its `preview` sibling, which validate a
 * different request shape but draw from the same purchasable set — may
 * name. Narrower than `PlanKey` below: `enterprise` is never self-serve
 * (design §4 — comped only, through `admin-plan.ts` or a bespoke Stripe
 * subscription mapped by `planKeyForPrice`) and `community` is never
 * something checkout buys, only a state you leave. One named constant so
 * the three `z.enum` sites that used to hand-type this list independently
 * can't drift from each other or silently reopen a path to a retired plan.
 */
export const PURCHASABLE_PLAN_KEYS = ["pro"] as const;
export type PurchasablePlanKey = (typeof PURCHASABLE_PLAN_KEYS)[number];

export const checkoutSchema = z.object({
  plan_key: z.enum(PURCHASABLE_PLAN_KEYS),
  interval: z.enum(["monthly", "annual"]),
}).strict();

// ---- billing types -----------------------------------------------------------

// Entitlements v18 (V392): `pro_plus` is retired. Its rows moved to a new,
// non-public `enterprise` plan reached only through Contact-us / staff comp —
// never a wider self-serve Pro — so `PlanKey` gains `enterprise`, not a
// bigger `pro_plus`. It stays deliberately wider than what checkout can buy;
// see `PURCHASABLE_PLAN_KEYS` above for that narrower set.
export const PLAN_KEYS = ["community", "pro", "enterprise"] as const;
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "suspended",
] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface Plan {
  key: PlanKey;
  name: string;
  stripe_price_id_monthly: string | null;
  stripe_price_id_annual: string | null;
  is_public: boolean;
  created_at: string;
}

export interface Subscription {
  /** The BILLING GROUP's own id (V314). The row stopped being keyed by org and
   *  gained an identity of its own; `org_id` below is now projected from
   *  whichever org was asked about, because several may share this row. */
  id: string;
  org_id: string;
  plan_key: PlanKey;
  status: SubscriptionStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  /** One trial per org (V277): stamped when the first trial starts, never cleared. */
  trial_used_at: string | null;
  cancel_at_period_end: boolean;
  /** Local mirror of "a card is on file at Stripe" (V304), so the trial banner
   *  on org home never needs a live Stripe read. Written by
   *  syncPaymentMethodFlag() and syncSubscription(). */
  has_payment_method: boolean;
  updated_at: string;
}
