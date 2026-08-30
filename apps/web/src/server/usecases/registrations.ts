import "server-only";
// Online registration & entry fees (doc 16 §1.1, PROMPT-20a).
//
// Lifecycle: public submit → pending (holds a spot) | waitlisted (over
// capacity) → paid (Stripe checkout completed) → confirmed (entrant
// materialised, entrant_id set EXACTLY once — idempotent) → withdrawn
// (frees the spot; oldest waitlisted auto-promotes; auto-refund before
// refund_lock_at, organiser-discretion after — all audited on the
// competition_events ledger).
//
// Public paths (submit / status / withdraw / pay) run on the superuser
// connection like the public read models — registrants have no org session;
// the access token (sha256 stored, shown once) is their credential.
// Organiser paths ride withTenant/RLS as usual.
import { createHash, timingSafeEqual } from "node:crypto";
import type postgres from "postgres";
import type Stripe from "stripe";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { mayHoldBearerCredential } from "@/lib/types";
import { isTerminalRegistrationStatus } from "@/lib/registration-status";
import { getLimit, hasFeature, requireFeature } from "@/lib/entitlements";
import { platformFeeDefault } from "@/lib/platform-settings";
import { getStripe } from "@/lib/stripe";
import { isRegistrationCurrency } from "@/lib/currency";
import { SPOT_HOLDERS } from "@/lib/registration-status";
import {
  sendPaymentReminderEmail,
  sendRegistrationEmail,
  sendRegistrationPromotedEmail,
  sendRefundIssuedEmail,
  sendDisputeAlertEmail,
  sendDisputeLostEmail,
  sendRegistrationRefundFailedAlertEmail,
  sendClaimInviteEmail,
} from "@/lib/email";
import type { RegistrationEmailArgs } from "@/lib/email-templates";
import { routes } from "@/lib/routes";
import { toLocale } from "@/lib/i18n-constants";
import { isValidRefCode, normalizeRefCode } from "@/lib/ref-code";
import { anyOptedOut, resolvePersonDisplayName } from "@/lib/name-display";
import { isoFromZonedParts } from "@/lib/zoned-datetime";
import { resolveVenueTz } from "@/lib/tz";
import { rateLimit } from "@/lib/rate-limit";
import { icsText, foldLine } from "@/lib/public-site";
import { msgFor } from "@/lib/messages-i18n";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import type { PutRegistrationSettings, RegistrationFormField } from "@/server/api-v1/schemas";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { resolveLogoUrl } from "@/server/public-site/data";
import { assertNotFrozen, frozenCompetitionIds } from "./entitlement-freeze";
import { recoverDisputedTransfer as recoverDisputedTransferCore } from "./dispute-recovery";
import { createSystemClaimInvite } from "./person-claims";
import {
  FIRST_PAID_EARN,
  recordEarnGrant,
  REFERRAL_EARN,
  tryEarnGrant,
  walletIdFor,
} from "@/lib/credits";
import { ageAt, isMinor, requiresDob, requiresGender } from "./registration-eligibility";

type Tx = postgres.TransactionSql;

// ---------------------------------------------------------------------------
// Pure helpers — fee math, form validation, #402 submit-linking policy
// (unit-tested directly). Eligibility itself (age/gender rules, first-class
// category/age columns, roster composition) lives in
// `./registration-eligibility` — re-exported below, verbatim, for every
// existing importer.
// ---------------------------------------------------------------------------

export const REGISTRATION_TOKEN_PREFIX = "rg_";

/** The platform cut for THIS org + competition (v3/07 §2 fee row): per-org
 *  override → `registration.fee_percent` entitlement (pro 2, event-pass 5) →
 *  the admin-set platform default (spec §1). */
export async function feePercentFor(orgId: string, competitionId?: string): Promise<number> {
  const pct = await getLimit(orgId, "registration.fee_percent", competitionId);
  return pct == null || pct <= 0 ? platformFeeDefault() : pct;
}

/**
 * The rate a charge in THIS competition must use (V312).
 *
 * Once a competition has taken a paid entry its rate is locked
 * (`competitions.fee_percent`) and every later entry pays that same rate, immune
 * to any plan change or group detach that happens mid-competition. Until then
 * the rate is live, so an organiser can still fix their plan before sales open.
 *
 * The lock can be 0 in only one impossible case (a plan row of 0), which
 * `feePercentFor` already treats as "unset"; a locked rate is always a real
 * charged percent, so `> 0` is the correct guard for "is it locked".
 */
export async function effectiveFeePercentFor(
  competitionId: string,
  orgId: string,
): Promise<number> {
  const [c] = await sql<{ fee_percent: number | null }[]>`
    select fee_percent from competitions where id = ${competitionId}`;
  if (c?.fee_percent != null && c.fee_percent > 0) return c.fee_percent;
  return feePercentFor(orgId, competitionId);
}

/** application_fee_amount for a destination charge. Never exceeds the fee. */
export function applicationFeeCents(feeCents: number, percent: number): number {
  return Math.min(feeCents, Math.round((feeCents * percent) / 100));
}

export function hashRegistrationToken(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * #402 — the session captured onto `registrations.user_id`, or null.
 *
 * The session is captured ONLY under an explicit affirmation, from a registrant
 * whose own dob proves them an ADULT, with no guardian field filled in. Each
 * clause is load-bearing:
 *
 *  - Affirmation, because a guardian, a spouse and a team captain are all
 *    signed in too; being signed in is never enough on its own.
 *  - A PRESENT dob, because `dob` is nullish: a parent entering two children
 *    with no dob triggers no guardian requirement anywhere, so an affirmation
 *    alone would link both siblings to one account and fuse them into one
 *    persons row — the exact harm `contact_email` was rejected for.
 *  - ADULT, because a minor's date of birth is guardian territory whether or
 *    not the guardian fields were filled in. `submitRegistration` also refuses
 *    that submission with a 422, but the invariant must not depend on that
 *    refusal staying where it is.
 *
 * The veto lives server-side so a forged request cannot reach the person
 * resolver; the schema's matching rule is only the useful error message.
 *
 * Orphaned by the RS001 registration demolition — its only caller,
 * `submitRegistration`, is deleted (the public submit route is gone until
 * RS003). Kept, with its schema coupling removed, because the #402 rule
 * itself is unchanged and RS002/RS003 need it verbatim for the new
 * group-shaped submit flow.
 */
export function deriveLinkUserId(
  sessionUserId: string | null,
  input: {
    registering_self?: boolean;
    guardian_name?: string | null;
    guardian_consent?: boolean;
    dob?: string | null;
  },
  now: Date,
): string | null {
  if (!sessionUserId) return null;
  if (!input.registering_self) return null;
  if (!input.dob || isMinor(input.dob, now)) return null;
  if (input.guardian_name || input.guardian_consent) return null;
  return sessionUserId;
}

// `ageAt`, `isMinor`, `requiresDob` moved to `./registration-eligibility`
// (RS002 wave 2) — imported above for local use (`isMinor` by
// `deriveLinkUserId`, `requiresDob` by `publicRegistrationInfo` below) and
// re-exported here verbatim so every existing importer of this file keeps
// compiling unchanged. The legacy `eligibilityIssues` string[] wrapper that
// used to be part of this trio was deleted at its source (RS002 W5
// whole-branch review — zero production callers repo-wide); nothing here
// re-exports it any more.
export { ageAt, isMinor, requiresDob };

/** Validate answers against the bounded form definition; returns the kept
 *  subset (unknown keys dropped — the form is the contract). */
export function validateAnswers(
  fields: RegistrationFormField[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const f of fields) {
    const v = answers[f.key];
    const empty = v === undefined || v === null || v === "";
    if (f.required && (empty || v === false)) {
      throw new HttpError(422, `"${f.label}" is required`);
    }
    if (empty) continue;
    if (f.kind === "checkbox") {
      if (typeof v !== "boolean") throw new HttpError(422, `"${f.label}" must be true/false`);
      kept[f.key] = v;
    } else if (f.kind === "select") {
      if (typeof v !== "string" || !(f.options ?? []).includes(v)) {
        throw new HttpError(422, `"${f.label}" must be one of the offered options`);
      }
      kept[f.key] = v;
    } else {
      if (typeof v !== "string" || v.length > 1000) {
        throw new HttpError(422, `"${f.label}" must be text (max 1000 chars)`);
      }
      kept[f.key] = v;
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Rows & shared internals
// ---------------------------------------------------------------------------

export interface RegistrationSettingsRow {
  division_id: string;
  enabled: boolean;
  entrant_kind: "team" | "individual" | "pair";
  opens_at: Date | null;
  closes_at: Date | null;
  capacity: number | null;
  fee_cents: number;
  /** No `currency` here on purpose (RS001b): currency is org-level
   *  (`organizations.currency`), because one cart can span divisions and one
   *  Stripe checkout session has one currency. Reads resolve it from
   *  `OrgPaymentDefaults` / `DivisionCtx`. */
  refund_lock_at: Date | null;
  form_fields: RegistrationFormField[];
  payment_method: "offline" | "stripe";
  /** Per-division override; null → org.payment_instructions. */
  payment_instructions: string | null;
  /** V364/RS004. 'auto' reproduces pre-RS004 behaviour untouched — every
   *  entry auto-confirms. Read by registration-approval.ts via its own
   *  loadApprovalSettings, not via loadSettings above. */
  approval: "auto" | "manual";
  /** V364/RS004: team divisions only — putRegistrationSettings rejects
   *  `true` on a non-team division. Read by registration-submit.ts. */
  allow_free_agents: boolean;
  /**
   * V388/RS009 — what ONE person pays to enter this team division alone.
   *
   * NULL is meaningful and is the default: "no separate price, charge
   * `fee_cents`". On a team division `fee_cents` is a price PER TEAM, so
   * before this column a lone player entering a £60-per-team division paid
   * £60, and an organiser who then placed them on a team that also paid £60
   * had collected twice for one roster.
   *
   * 0 is a real price (a free solo sign-up in a paid division), NOT "unset" —
   * `?? fee_cents` is therefore the only correct fallback, and `|| fee_cents`
   * would charge the full team fee to someone told it was free.
   */
  free_agent_fee_cents: number | null;
  updated_at: Date | null;
}

/**
 * `registrations` (V364): one entry (team/pair/individual) inside a cart.
 * Payment/contact/identity columns moved off this row onto its
 * `registration_groups` parent — see `RegistrationGroupRow` — because one
 * cart pays once, but a cart can hold several entries (design §3). Roster
 * players moved to `registration_players` — see `RegistrationPlayerRow`.
 */
export interface RegistrationRow {
  id: string;
  division_id: string;
  org_id: string;
  status:
    | "pending" | "paid" | "confirmed" | "waitlisted" | "withdrawn" | "expired"
    | "rejected";
  display_name: string;
  answers: Record<string, unknown>;
  /** This entry's own fee — stays per-entry because a cart can be partially
   *  waitlisted (design §3); the cart's charged subtotal lives on the group. */
  amount_cents: number;
  /** This entry's OWN accumulated refund total (V368) — additive, never
   *  overwritten, never decreases. Distinct from the group's
   *  `refunded_cents` (the cart's total); see the block comment above
   *  `RegistrationWithGroupRow`, which exposes the group's as
   *  `group_refunded_cents` to keep the two from colliding in one SELECT. */
  refunded_cents: number;
  entrant_id: string | null;
  promoted_at: Date | null;
  /** V378/RS007: THIS entry's own pay-by deadline, set only when a
   *  promotion out of the waitlist needs a Stripe window (mirrors
   *  `promoted_at`'s null-ness — see `promoteWaitlistedRow`). Distinct from
   *  the cart-level `expires_at` on `RegistrationGroupRow`, which still
   *  governs a never-paid submit; see the block comment above
   *  `promoteWaitlistedRow` for why the cart clock cannot serve both. */
  promotion_expires_at: Date | null;
  /** V378/RS007: when this row (re)joined the waitlist. Null for a row that
   *  has never lapsed off a promotion — `promoteOldestWaitlisted` falls back
   *  to `created_at` for those, so an ordinary first-time waitlist join is
   *  unaffected. Set to `now()` only by `sweepRegistrations`' lapse branch,
   *  which sorts a lapsed row BEHIND anyone still waiting on their original
   *  `created_at` (the waitlist tail), rather than letting it keep its old
   *  place in line. */
  waitlisted_at: Date | null;
  withdrawn_at: Date | null;
  /** Finding #18b: set exactly once, the moment a REAL Stripe charge lands
   *  for THIS entry — in the SAME statement as `status = 'paid'`, before the
   *  manual/auto approval fork, so it covers a manual-approval entry that
   *  never reaches materialise() too. Never cleared afterwards (not even by
   *  withdrawCore). Durable proof that "a live charge existed for this
   *  entry before it was withdrawn", independent of whether it was ever
   *  SEATED (entrant_id, #18's own signal, which only auto-approval sets). */
  charged_at: Date | null;
  /** The cart this entry belongs to — every entry has exactly one (V364). */
  group_id: string;
  /** Set when this (team) entry can hand out a self-join link. */
  join_code: string | null;
  free_agent: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * `registration_groups` (V363): the cart — contact, access token, ref code
 * and the whole payment envelope, shared by every entry inside it. Column
 * names are unchanged from the pre-V364 `registrations` row they moved off,
 * so every read that used to say `r.<col>` now says `g.<col>`.
 */
export interface RegistrationGroupRow {
  id: string;
  org_id: string;
  competition_id: string;
  contact_name: string;
  contact_email: string;
  user_id: string | null;
  locale: string | null;
  /** Human-quotable reference (v3/05 §3), shared by every entry in the cart. */
  ref_code: string | null;
  access_token_hash: string;
  amount_cents: number;
  /** The org currency snapshotted when this cart was submitted (RS001b, design
   *  §3). NOT NULL in the DB and never rewritten afterwards — a later
   *  org-currency change (including the Connect same-currency lock converging)
   *  must not re-denominate a cart the registrant was already quoted. */
  currency: string;
  payment_method: "offline" | "stripe" | null;
  checkout_session_id: string | null;
  payment_intent_id: string | null;
  /** Card pendings only: pay-by deadline (spec §2, 48h). */
  expires_at: Date | null;
  reminded_at: Date | null;
  refunded_cents: number;
  refunded_at: Date | null;
  disputed_at: Date | null;
  dispute_id: string | null;
  offline_marked_paid_at: Date | null;
  offline_marked_paid_by: string | null;
  /** The platform-fee rate this card charge used, frozen at checkout creation
   *  (V312). Null for offline registrations. Stamps the competition's locked
   *  rate on the first paid entry. */
  fee_percent: number | null;
  privacy_consent_at: Date | null;
  privacy_consent_version: string | null;
  /** Optional, versioned the same way as privacy consent (RS006 §A) — never
   *  blocks submit; null means "not given", not "unknown". */
  media_consent_at: Date | null;
  media_consent_version: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * `registration_players` (V363): one row per roster player — replaces the
 * old `registrations.roster` jsonb (design §3/§6).
 */
export interface RegistrationPlayerRow {
  id: string;
  registration_id: string;
  org_id: string;
  full_name: string;
  email: string | null;
  dob: string | null;
  gender: string | null;
  guardian_name: string | null;
  /**
   * How this roster row came to exist. `organiser_assigned` (RS009) is an
   * organiser placing a pooled solo sign-up onto this team — nobody typed
   * the name here and the player did not pick this team, so it is neither of
   * the other two.
   *
   * This union and the `registration_players_source_check` CHECK constraint
   * (`V363`, widened by `V388`) are the ONLY two definitions of this set —
   * there is no zod enum for it anywhere. Nothing connects them: `tsc`
   * cannot read a CHECK, Postgres cannot read a union. Change one and you
   * must change the other, or you get code that compiles and then violates a
   * constraint in production. `registration-player-source-contract.test.ts`
   * asserts they agree, in both directions.
   */
  source: "captain_entered" | "self_joined" | "organiser_assigned";
  consent_status: "pending" | "granted" | "guardian";
  consent_at: Date | null;
  /**
   * The account this player row belongs to — set for the submitter's own row at
   * submit ("I'm playing"), and at claim/join. `materialise` resolves a LINKED
   * person (`resolvePlayerPerson`) when it is present and an anonymous one when
   * it is not. It lives here rather than on the group because a group is a cart:
   * a club rep may enter other people, and linking their entries to the rep's
   * account would attach strangers to that identity.
   */
  user_id: string | null;
  claim_token_hash: string | null;
  person_id: string | null;
  squad_number: number | null;
  is_captain: boolean;
  created_at: Date;
  updated_at: Date;
}

/** r.* plus the group's payment/contact columns — every read below that
 *  needs both the entry and its cart's envelope selects this shape off a
 *  `registrations r join registration_groups g on g.id = r.group_id`.
 *
 *  ── CART-LEVEL MONEY ON AN ENTRY-LEVEL ROW — RS002 FIXED THIS ─────────────
 *  This type used to FLATTEN a cart's money onto one entry — exactly right
 *  while carts were 1:1 with entries (nothing created a multi-entry cart
 *  until RS002/RS003 ship group submit), but wrong the moment a cart holds
 *  two entries. Three shapes in this file used to be wrong, and none of them
 *  failed a typecheck:
 *
 *   1. `stripeRefund(intent, undefined)` refunded the FULL remaining balance
 *      of the cart's payment intent. Refunding or withdrawing ONE entry would
 *      hand back its siblings' money too. FIXED: every call site now passes
 *      the entry's own remaining amount explicitly.
 *   2. `set refunded_cents = <this entry's fee>` OVERWROTE the cart's total
 *      instead of accumulating into it. FIXED: the webhook and auto-refund
 *      writes are additive now, matching the pattern `refundRegistration`
 *      already used.
 *   3. `remaining = reg.amount_cents - reg.refunded_cents` subtracted a CART
 *      total from an ENTRY fee. FIXED (V368): `registrations.refunded_cents`
 *      is now this entry's own column, so `refunded_cents` below resolves to
 *      it, never to the group's.
 *
 *  The decision RS001 deliberately deferred is now taken: per-entry refunds
 *  get their OWN column (V368) rather than being derived from the cart's.
 *  `registration_groups.refunded_cents` is UNCHANGED — it stays the cart's
 *  accumulated total — and this type deliberately does NOT pick it under the
 *  name `refunded_cents`: that would collide with `RegistrationRow`'s own
 *  column of the same name and leave whichever the SELECT lists last to win
 *  silently (tsc cannot see a raw-SQL column collision — `select r.*, g.*`
 *  would silently yield one of them). Code that needs the cart's total reads
 *  `group_refunded_cents` instead — today that is only the dispute-lost
 *  write-off and the Stripe-dashboard refund mirror, both genuinely
 *  cart-scoped (a dispute/charge is against the intent, not one entry), so
 *  neither gets a per-entry write — that part is deliberately out of RS002's
 *  scope. That scoping choice does NOT make the write itself safe: the
 *  dispute-lost write-off was a fourth, unlisted site of hazard 2's class
 *  (flat-overwrote using the earliest entry's own `amount_cents` instead of
 *  `dispute.amount`) until a review pass caught it — it is
 *  `greatest(refunded_cents, dispute.amount)` now, same monotonic pattern as
 *  the dashboard mirror. No per-entry `refunded_at` either — deliberately
 *  out of scope; the cart's last-refund timestamp is enough.
 *  ───────────────────────────────────────────────────────────────────────── */
export type RegistrationWithGroupRow = RegistrationRow &
  Pick<
    RegistrationGroupRow,
    | "contact_name" | "contact_email" | "user_id" | "locale" | "ref_code"
    | "access_token_hash" | "currency" | "payment_method" | "checkout_session_id"
    | "payment_intent_id" | "expires_at" | "reminded_at"
    | "refunded_at" | "disputed_at" | "dispute_id" | "offline_marked_paid_at"
    | "offline_marked_paid_by" | "fee_percent" | "privacy_consent_at"
    | "privacy_consent_version" | "media_consent_at" | "media_consent_version"
  > & {
    /** The CART's accumulated refund total (`registration_groups.refunded_cents`,
     *  V363) — aliased so it can never collide with `RegistrationRow`'s own
     *  entry-scoped `refunded_cents` (V368) in the same SELECT. */
    group_refunded_cents: number;
    /** THIS entry's own payment intent (`registrations.payment_intent_id`,
     *  V387) — aliased for exactly the same reason `group_refunded_cents` is:
     *  the group carries a `payment_intent_id` too, and `select r.*, g.*`
     *  would silently yield whichever the list mentions last, with tsc unable
     *  to see the collision. PR #677 finding H1: a cart can hold TWO live
     *  intents (sessions are minted against a `registration_ids` subset, and
     *  a promoted entry pays in its own session), so the unaliased
     *  `payment_intent_id` — the cart's most recent — must never be what a
     *  per-entry refund sends to Stripe. Null on a paid row means "not
     *  recorded": fail CLOSED, never fall back to the cart's. */
    entry_payment_intent_id: string | null;
  };

/** r.* ∪ g.* for `RegistrationWithGroupRow` — every SELECT that needs the
 *  joined shape interpolates `${regGroupCols(db)}` (same convention as
 *  org-posts.ts's `COLS`/discipline.ts's `SELECT_SUSPENSION`), built from the
 *  SAME `sql`/`tx` instance as the surrounding query so the two tables'
 *  column list can only drift in one place. `g.refunded_cents` is aliased to
 *  `group_refunded_cents` so it never collides with `r.refunded_cents`
 *  (V368) — see the block comment above `RegistrationWithGroupRow`. */
export function regGroupCols(db: AnySql) {
  return db`
    r.id, r.division_id, r.org_id, r.status, r.display_name, r.answers,
    r.amount_cents, r.refunded_cents, r.entrant_id, r.promoted_at, r.withdrawn_at,
    r.charged_at, r.promotion_expires_at, r.waitlisted_at,
    r.payment_intent_id as entry_payment_intent_id,
    r.group_id, r.join_code, r.free_agent, r.created_at, r.updated_at,
    g.contact_name, g.contact_email, g.user_id, g.locale, g.ref_code,
    g.access_token_hash, g.currency, g.payment_method, g.checkout_session_id,
    g.payment_intent_id, g.expires_at, g.reminded_at,
    g.refunded_cents as group_refunded_cents,
    g.refunded_at, g.disputed_at, g.dispute_id, g.offline_marked_paid_at,
    g.offline_marked_paid_by, g.fee_percent, g.privacy_consent_at,
    g.privacy_consent_version, g.media_consent_at, g.media_consent_version`;
}

const SETTINGS_COLS = [
  "division_id", "enabled", "entrant_kind", "opens_at", "closes_at",
  "capacity", "fee_cents", "refund_lock_at", "form_fields",
  "payment_method", "payment_instructions", "approval", "allow_free_agents",
  "free_agent_fee_cents", "updated_at",
] as const;

/** Statuses that hold a capacity spot. Imported from `@/lib/registration-
 *  status` (RS004 W3b review finding 1) rather than declared here: that
 *  module is dependency-free, so the registration hub's read-only page.tsx
 *  can import the SAME array without dragging this module's Stripe/email
 *  clients along. Re-exported below so `registration-submit.ts` and
 *  `registration-approval.ts` keep importing it from `"./registrations"`
 *  unchanged. */
export { SPOT_HOLDERS };

// Both the superuser client and a withTenant tx serve the shared helpers
// (TransactionSql omits connection controls, so it isn't a plain Sql).
type AnySql = Tx | postgres.Sql;

/** Exported for `registration-approval.ts` (RS002 W5) — approve/reject/
 *  promote all need the same live division-settings read `confirmRegistration`
 *  et al. already use. */
export async function loadSettings(db: AnySql, divisionId: string): Promise<RegistrationSettingsRow | null> {
  const [row] = await db<RegistrationSettingsRow[]>`
    select ${sql(SETTINGS_COLS as unknown as string[])} from registration_settings
    where division_id = ${divisionId}`;
  return row ?? null;
}

/** Append to the competition_events audit ledger (016 pattern). Exported for
 *  `registration-approval.ts` (RS002 W5) — every approval transition writes
 *  the same ledger the existing organiser transitions do. */
export async function audit(
  db: AnySql,
  competitionId: string,
  orgId: string,
  type: string,
  payload: Record<string, unknown>,
  actorId: string | null,
): Promise<void> {
  await db`
    insert into competition_events (competition_id, org_id, type, payload, actor_id)
    values (${competitionId}, ${orgId}, ${type}, ${sql.json(payload as never)}, ${actorId})`;
}

/** Exported for `registration-approval.ts` (RS002 W5) — `promoteFromWaitlist`
 *  needs the same org/comp/name context `notifyPromoted` does. */
export interface DivisionCtx {
  id: string;
  competition_id: string;
  org_id: string;
  comp_name: string;
  comp_slug: string;
  comp_visibility: string;
  starts_on: string | null;
  ends_on: string | null;
  div_slug: string;
  org_slug: string;
  org_name: string;
  /** Organiser's public default locale — the fallback for a registrant who made
   *  no explicit locale pick (v5 i18n cycle 47). */
  default_locale: string | null;
  payment_instructions: string | null;
  charges_enabled: boolean;
  /** RS007: the org's scheduling timezone (`organizations.timezone`, nullable
   *  — resolves to UTC via `resolveVenueTz`). Feeds `resolveRefundPolicy`'s
   *  `starts_on` fallback — deliberately the ORG's zone only, never a
   *  division's own `schedule_settings.tz` override (see that function's own
   *  doc comment for why `starts_on`, a competition-level field, cannot
   *  resolve per-division without risking two entries in one cart
   *  disagreeing about the same date). */
  org_timezone: string | null;
  /** The org's CURRENT currency (RS001b/RS003) — read fresh on every call so
   *  `createRegistrationCheckout` can 422 a group whose snapshot has gone
   *  stale (the org's currency moved since submit) BEFORE any Stripe call,
   *  never as a Stripe-side error on a registrant's pay page. Every OTHER
   *  currency read in this file still resolves from the cart's own snapshot
   *  (`RegistrationGroupRow.currency`) — this field exists only to compare
   *  against that snapshot, never to replace it. */
  currency: string;
}

export async function divisionCtx(db: AnySql, divisionId: string): Promise<DivisionCtx> {
  const [row] = await db<DivisionCtx[]>`
    select d.id, d.competition_id, d.org_id, d.slug as div_slug,
           c.name as comp_name, c.slug as comp_slug, c.visibility as comp_visibility,
           c.starts_on, c.ends_on,
           o.slug as org_slug, o.name as org_name, o.default_locale, o.payment_instructions,
           o.stripe_charges_enabled as charges_enabled, o.currency, o.timezone as org_timezone
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    where d.id = ${divisionId}`;
  if (!row) throw new HttpError(404, "division not found");
  return row;
}


/** Origin for emails fired from request-less paths (withdraw promotions):
 *  same override order as lib/base-url, localhost as the dev fallback.
 *  Exported for `registration-approval.ts` (RS002 W5) — `promoteFromWaitlist`
 *  is request-less too. */
export function fallbackOrigin(): string {
  return (
    process.env.OAUTH_BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

/** Exported for `registration-submit.ts` (RS002 W4) — the submit path's
 *  per-division window gate reuses this VERBATIM rather than re-deriving it. */
export function windowOpen(s: RegistrationSettingsRow, now: Date): boolean {
  if (!s.enabled) return false;
  if (s.opens_at && now < new Date(s.opens_at)) return false;
  if (s.closes_at && now > new Date(s.closes_at)) return false;
  return true;
}

/**
 * Materialise a confirmed registration into an entrant (doc 16 §1.1:
 * "Registration → entrant on confirm"). Idempotent: entrant_id is set exactly
 * once under a row lock; a second call is a no-op. Individuals also get a
 * person (dob/gender feed eligibility). New persons are created with
 * consent.public_name = true (owner ruling 5 — registering is consent to a
 * public name); a REUSED or user_id-linked person's own consent, including
 * any opt-out, is left untouched — see findOrCreatePlayerPerson below.
 */
/**
 * #402 — resolve the registrant's player-lane person, or create it.
 *
 * The upsert (not select-then-insert) is what closes the race: two divisions
 * confirmed concurrently by one signed-in registrant both miss a select, and
 * both insert. Here `persons_org_user_lane_uq` arbitrates and the loser is
 * handed the winner's id. `do update set full_name = persons.full_name` is a
 * deliberate no-op — `do nothing` returns no row, and the existing person's own
 * data must win, so a later entry never overwrites full_name/dob/gender. A
 * divergence is a signal for #404's review queue, never an in-place edit.
 *
 * #404: the WHERE below must repeat `persons_org_user_lane_uq`'s predicate
 * VERBATIM, `and merged_into is null` included. Postgres infers a partial index
 * only when the index's predicate is implied by the statement's, so a stale
 * predicate here fails at RUNTIME with 42P10 ("no unique or exclusion
 * constraint matching the ON CONFLICT specification") — never at compile time.
 * The tombstone clause is also what lets a merged duplicate release the
 * identity slot so the survivor can hold it.
 *
 * Restored to `materialise`'s call path (RS001 follow-up): the account
 * lives on `registration_players.user_id` — set for the submitter's own row
 * at submit (design §4 step 1) or at claim/join (design §2 item 4), never on
 * the group, whose contact is often a rep entering OTHER people's entries
 * (see `loadPlayers`'s doc comment). `materialise` calls this per player, in
 * both the individual and team branches, whenever that player's row carries a
 * `user_id`; a row with none keeps the plain unlinked insert.
 */
export async function resolvePlayerPerson(
  tx: Tx,
  orgId: string,
  userId: string,
  fullName: string,
  dob: string | null,
  gender: string | null,
): Promise<string> {
  // consent defaults to public_name=true on the INSERT branch only (ruling
  // 5, review BLOCKER — this is the PRIMARY path a signed-in registrant's
  // own first-ever linked person takes, so it owes the ruling exactly like
  // findOrCreatePlayerPerson's anonymous-path insert does). The DO UPDATE
  // branch stays untouched: it never mentions consent, so a returning
  // person's own consent (including an opt-out) is never overwritten.
  const [person] = await tx<{ id: string }[]>`
    insert into persons (org_id, full_name, dob, gender, user_id, lane, consent)
    values (
      ${orgId}, ${fullName}, ${dob}, ${gender}, ${userId}, 'player',
      ${tx.json({ public_name: true } as never)}
    )
    on conflict (org_id, user_id, lane)
      where user_id is not null and lane = 'player' and merged_into is null
    do update set full_name = persons.full_name
    returning id`;
  return person.id;
}

/**
 * #22 — exact-one player-lane person match by email, org-scoped, tombstones
 * excluded. Same conservatism as the dob rule below: zero or ambiguous
 * matches return null rather than guessing. Exported so
 * `registration-submit.ts`'s `joinTeamEntry` can reconcile a claim against
 * the directory too (module topology: that file already imports from this
 * one; never the other way).
 */
export async function findPlayerPersonByEmail(
  db: AnySql,
  orgId: string,
  email: string,
): Promise<string | null> {
  const trimmed = email.trim();
  if (!trimmed) return null;
  const matches = await db<{ id: string }[]>`
    select id from persons
    where org_id = ${orgId} and lane = 'player' and merged_into is null
      and lower(email) = lower(${trimmed})`;
  return matches.length === 1 ? matches[0]!.id : null;
}

/**
 * RS008 review fix #8 (Minor) — like `findPlayerPersonByEmail` above, but for
 * a DISPLAY-NAME MASKING decision rather than identity resolution.
 * `findPlayerPersonByEmail`'s "zero or ambiguous both return null" rule is
 * correct for IDENTITY (never guess which of several duplicate people —
 * merge/#404 — a row belongs to), but wrong for a PRIVACY decision built on
 * top of it: treating "ambiguous" the same as "no match" makes the decision
 * fail OPEN (preview raw) exactly when it is least certain it should. This
 * returns every matching person's consent, org-scoped, tombstones excluded —
 * `anyOptedOut` (lib/name-display.ts) then applies its own "stricter wins
 * across several people" rule (ANY match opted out masks) the same way it
 * already does for a pair/team's several roster members. Zero matches
 * returns `[]` (`anyOptedOut([])` is `false`, identical to today's
 * behaviour for that case). Never used for identity/reconciliation — those
 * callers need `findPlayerPersonByEmail`'s EXACT-ONE guarantee and must keep
 * failing toward "create/leave as-is," not toward a privacy default.
 */
export async function playerPersonConsentsByEmail(
  db: AnySql,
  orgId: string,
  email: string,
): Promise<({ public_name?: boolean } | null)[]> {
  const trimmed = email.trim();
  if (!trimmed) return [];
  const matches = await db<{ consent: { public_name?: boolean } | null }[]>`
    select consent from persons
    where org_id = ${orgId} and lane = 'player' and merged_into is null
      and lower(email) = lower(${trimmed})`;
  return matches.map((m) => m.consent);
}

/**
 * #22 — fills a MISSING email onto an already-resolved person; never
 * overwrites one that differs (the `email is null` guard IS the rule, not
 * just an optimisation — a concurrent backfill from two rows racing the
 * same person is then a harmless double no-op instead of a decision about
 * which value wins). Matches the standing "never touch an existing
 * person's own data" rule's one stated exception (#22 brief: "adding an
 * email to a person that has none is acceptable"). Exported for
 * `registration-submit.ts`'s `joinTeamEntry` — a claim that finds no
 * BETTER match than the dummy person already on its row still gives that
 * dummy the email it was minted without.
 */
export async function backfillPersonEmail(tx: Tx, personId: string, email: string): Promise<void> {
  const trimmed = email.trim();
  if (!trimmed) return;
  await tx`update persons set email = ${trimmed} where id = ${personId} and email is null`;
}

/**
 * RS002 — person get-or-create for a player row with NO `user_id`.
 *
 * The only persons identity index (`persons_org_user_lane_uq`) is scoped to
 * `user_id is not null`, so it arbitrates nothing for an anonymous player.
 * Ruling taken this session (design §6, `_INDEX.md` "Person get-or-create
 * does NOT dedupe on name alone" — there is no `(org, name, dob)` unique
 * index and this does not add one): reuse an existing person ONLY when the
 * row carries a `dob` AND exactly one non-merged, player-lane person in this
 * org matches on `(lower(trim(full_name)), dob)`. No dob, zero matches, or
 * an AMBIGUOUS (2+) match all mint a new person rather than guess — a
 * duplicate person is a one-click #404 merge, whereas silently fusing two
 * different humans (same-named juniors, for instance) is not cleanly
 * reversible. A small per-org query by design; no index added for it.
 *
 * #22 (2026-08-30): EMAIL is now tried FIRST, ahead of dob — a captain-
 * entered row essentially never carries a dob (nothing requires one unless
 * the registrant ticks "I'm playing"), so the dob rule above rarely even
 * runs; email is the signal that is actually usually present (the cart
 * contact always has one, a claimer always gives one at their own claim
 * moment). Same conservatism, same "never guess" shape — see
 * `findPlayerPersonByEmail`. A person found via EITHER rule gets its email
 * backfilled if (and only if) it doesn't have one yet, so the NEXT
 * registration for the same human can match on email even if this one
 * matched on dob.
 *
 * Never touches an EXISTING person's own data (name/dob/gender/consent) —
 * that person may already carry answers, including a consent opt-out, that a
 * later same-named entry must not overwrite. New persons are created with
 * `consent.public_name = true` (owner ruling 5: registering is consent to a
 * public name; opt-out happens later, on the person, never here).
 */
async function findOrCreatePlayerPerson(
  tx: Tx,
  orgId: string,
  fullName: string,
  dob: string | null,
  gender: string | null,
  email: string | null,
): Promise<string> {
  const trimmedEmail = email?.trim() || null;
  if (trimmedEmail) {
    const matchId = await findPlayerPersonByEmail(tx, orgId, trimmedEmail);
    if (matchId) {
      await backfillPersonEmail(tx, matchId, trimmedEmail);
      return matchId;
    }
  }
  if (dob) {
    const matches = await tx<{ id: string }[]>`
      select id from persons
      where org_id = ${orgId} and lane = 'player' and merged_into is null
        and dob = ${dob} and lower(trim(full_name)) = lower(trim(${fullName}))`;
    if (matches.length === 1) {
      if (trimmedEmail) await backfillPersonEmail(tx, matches[0]!.id, trimmedEmail);
      return matches[0]!.id;
    }
  }
  const [created] = await tx<{ id: string }[]>`
    insert into persons (org_id, full_name, dob, gender, email, consent)
    values (${orgId}, ${fullName}, ${dob}, ${gender}, ${trimmedEmail}, ${tx.json({ public_name: true } as never)})
    returning id`;
  return created!.id;
}

/**
 * #22 — reconciles a JOIN/CLAIM against the directory, for
 * `registration-submit.ts`'s `joinTeamEntry` (a claim is the strongest
 * identity moment in the whole flow: the human gives their own email, or is
 * signed in). Returns an EXISTING person only — never creates one, unlike
 * `findOrCreatePlayerPerson` — because a fresh person for a row that
 * resolves to neither a user_id nor a known email is exactly what
 * `materialise()` already handles correctly whenever it eventually runs
 * (immediately for a free auto-approval entry, later for a paid or
 * manual-approval one); this function's whole job is to catch the case
 * `materialise()` CANNOT retry — a claim landing on an entry that is
 * already confirmed, where `materialise()`'s own `if (reg.entrant_id)
 * return` guard means it will never run again for this registration.
 *
 * `userId` (signed-in claimer) is the stronger signal and is tried first:
 * `resolvePlayerPerson` already reuses-or-creates atomically via the
 * unique `(org, user, lane)` index, so it always resolves to SOME person —
 * matching materialise()'s own precedence (`p.user_id ? resolvePlayerPerson
 * : findOrCreatePlayerPerson`). Email is the fallback, and unlike the
 * userId branch it can genuinely find nothing (zero or ambiguous matches),
 * in which case this returns null and the caller leaves the row exactly as
 * it is today.
 */
export async function reconcileClaimedPerson(
  tx: Tx,
  orgId: string,
  fullName: string,
  dob: string | null,
  gender: string | null,
  userId: string | null,
  email: string | null,
): Promise<string | null> {
  if (userId) return resolvePlayerPerson(tx, orgId, userId, fullName, dob, gender);
  const trimmedEmail = email?.trim() || null;
  return trimmedEmail ? findPlayerPersonByEmail(tx, orgId, trimmedEmail) : null;
}

/**
 * Roster reads (RS001 registration demolition): players now come from
 * `registration_players` (design §6) instead of the dropped `registrations.roster`
 * jsonb. `is_captain desc` orders a team's captain first — the closest
 * available analogue of the old "declared self" row, for callers that only
 * want one representative player (there is none of those left in this file,
 * but the order is a harmless, cheap default for whoever reads `players[0]`
 * next).
 *
 * #402 self-link note: `registration_players.user_id` replaces the old
 * roster's boolean `self` flag — instead of a flag `materialise` had to
 * interpret itself, whichever caller wrote the row (RS002/RS003 at submit,
 * RS008 at claim) decides directly which ONE row, if any, carries the
 * account. `materialise` (via `resolvePlayerPerson`, above) trusts that
 * decision verbatim: a row with a `user_id` resolves into the linked
 * player-lane person; a row without one still mints a fresh, unlinked person
 * exactly as before.
 */
// Projected off RegistrationPlayerRow rather than restated: the row type is the
// table's shape, so a column that appears in the SELECT but never in the
// interface (as `user_id` briefly did) fails the typecheck instead of drifting
// quietly — this file has no other consumer of the type to catch it.
// `email` added for #22 — materialise() below threads it through to
// findOrCreatePlayerPerson so a captain-entered row that DOES carry one
// (typed at submit, or persisted by a claim before this entry's own
// materialise() call fires) dedupes on it.
async function loadPlayers(tx: Tx, registrationId: string): Promise<
  Pick<
    RegistrationPlayerRow,
    "id" | "full_name" | "dob" | "gender" | "email" | "squad_number" | "user_id" | "is_captain"
  >[]
> {
  return tx`
    select id, full_name, dob, gender, email, squad_number, user_id, is_captain from registration_players
    where registration_id = ${registrationId}
    order by is_captain desc, created_at`;
}

/**
 * Clears the cart's shared `expires_at` ONLY when no OTHER entry in it is
 * still `pending` — i.e. nothing else still depends on the deadline. The
 * counterpart to `promoteWaitlistedRow`'s monotonic-extend ruling (RS002 W5
 * whole-branch review): a deadline can only be EXTENDED while money is still
 * owed, but must still be CLEARED once nothing does, or it lingers stale
 * forever and `groupByRef`/`publicRegistrationStatus` keep surfacing a dead
 * deadline. Call whenever an entry LEAVES `pending` for a reason that is not
 * a fresh promotion: confirm (`materialise`, below — the original site this
 * was factored out of), withdraw (`withdrawCore`), and expiry
 * (`sweepRegistrations`'s overdue branch). Exported for
 * `registration-approval.ts`'s `rejectRegistration`, which has the identical
 * gap on its own reject-a-pending-entry path.
 */
export async function clearExpiresIfNoLongerNeeded(
  tx: Tx,
  groupId: string,
  exceptRegId: string,
): Promise<void> {
  await tx`
    update registration_groups
    set expires_at = case
          when not exists (
            select 1 from registrations
            where group_id = ${groupId} and id <> ${exceptRegId} and status = 'pending'
          ) then null
          else expires_at
        end,
        updated_at = now()
    where id = ${groupId}`;
}

/** Exported for `registration-submit.ts` (RS002 W4) — the submit path
 *  auto-confirms a free, auto-approval, non-waitlisted entry INLINE in the
 *  same transaction by calling this directly, rather than re-deriving
 *  materialization. */
export async function materialise(
  tx: Tx,
  reg: RegistrationRow,
  entrantKind: string,
): Promise<string | null> {
  if (reg.entrant_id) return reg.entrant_id;
  // RS009 — a SOLO SIGN-UP is not a team of one, and must not become an
  // entrant of its own. Design §6 of record: "Free agents materialize as
  // members of the team they were assigned to, or stay unmaterialized until
  // assigned."
  //
  // Without this guard, confirming one — which the card-payment webhook does
  // automatically, with no organiser involved — minted a one-person `team`
  // entrant. That entrant is schedulable and shows in standings, and once the
  // organiser then placed the person on a real team, the SAME person sat on
  // two entrants with a phantom one-player team left in the fixture list that
  // nothing ever removed.
  //
  // Returning null rather than throwing: confirmation itself is legitimate
  // (they have paid, and their entry is real), it simply seats nobody yet.
  // `assignSoloSignUp` is what puts them on a roster, through
  // `joinExistingEntrant`, onto the TEAM's entrant.
  if (reg.free_agent) {
    // Still CONFIRM them — they have paid and their entry is real; they are
    // simply not seated yet. `materialise` owns the status flip as well as
    // the entrant insert, so returning before this update left a paid solo
    // sign-up stuck at `pending` forever, with no organiser action able to
    // move it. Caught by the very test written for this guard.
    await tx`
      update registrations
      set status = 'confirmed', updated_at = now()
      where id = ${reg.id}`;
    return null;
  }
  const [entrant] = await tx<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, status)
    values (${reg.division_id}, ${entrantKind}, ${reg.display_name}, 'confirmed')
    returning id`;
  const players = await loadPlayers(tx, reg.id);
  if (entrantKind === "individual") {
    // No player row yet (nothing populates registration_players until
    // RS002/RS003 ship the new submit flow) falls back to the entry's own
    // display_name with no dob/gender — byte-for-byte the old anonymous path.
    // A player row that DOES exist but carries only whitespace (review
    // MINOR) falls back the same way — `.trim() || …` matches the
    // team/pair branch below, which already trims and skips blank names.
    const p = players[0];
    const fullName = p?.full_name?.trim() || reg.display_name;
    const dob = p?.dob ?? null;
    const gender = p?.gender ?? null;
    const email = p?.email ?? null;
    // A player row carrying a user_id (#402) resolves into that account's
    // linked person — see resolvePlayerPerson. Otherwise
    // findOrCreatePlayerPerson applies the email/dob reuse rule (RS002, #22),
    // which also covers the no-player-row fallback above: no email and a
    // null dob there always mints fresh, byte-for-byte the old anonymous
    // path.
    const personId = p?.user_id
      ? await resolvePlayerPerson(tx, reg.org_id, p.user_id, fullName, dob, gender)
      : await findOrCreatePlayerPerson(tx, reg.org_id, fullName, dob, gender, email);
    // A RESOLVED person can already sit on this entrant (re-confirm), which the
    // fresh-insert path could never hit — so the membership write is idempotent.
    await tx`
      insert into entrant_members (entrant_id, person_id)
      values (${entrant.id}, ${personId})
      on conflict (entrant_id, person_id) do nothing`;
    // No player row when the fallback above ran (nothing to stamp).
    if (p) {
      await tx`
        update registration_players set person_id = ${personId}, updated_at = now()
        where id = ${p.id}`;
    }
  } else if ((entrantKind === "team" || entrantKind === "pair") && players.length > 0) {
    // Team/pair roster → a person + squad member per player row. Same #402
    // link check as the individual branch above, per player. `pair` (RS002:
    // registration_players now carries real rows for a pair entry, so it
    // takes the same per-player path team always has) carries squad_number
    // and is_captain exactly as team does — both columns already exist on
    // entrant_members and loadPlayers already selects them. Delegates to
    // `joinExistingEntrant` (#23) — same person-resolution precedence, same
    // idempotent entrant_members upsert, one copy instead of two that could
    // silently drift apart (RS007 review, medium).
    for (const p of players) {
      await joinExistingEntrant(tx, reg.org_id, entrant.id, {
        id: p.id,
        full_name: p.full_name,
        dob: p.dob,
        gender: p.gender,
        email: p.email,
        user_id: p.user_id,
        squad_number: p.squad_number,
        is_captain: p.is_captain,
      });
    }
  }
  await tx`
    update registrations
    set entrant_id = ${entrant.id}, status = 'confirmed', updated_at = now()
    where id = ${reg.id}`;
  // expires_at (the pay-by deadline) lives on the cart, shared by every
  // entry in it (RS002 W5 review MAJOR — this used to clear it
  // UNCONDITIONALLY on every confirm, from all five confirm call sites:
  // confirmRegistration, markRegistrationPaidOffline,
  // confirmRegistrationWaived, confirmPaidRegistration, and
  // approveRegistration. A pending SIBLING's still-live Stripe deadline was
  // wiped whenever ANY other entry in its cart confirmed; that sibling then
  // never expired via sweepRegistrations, and groupByRef stopped showing a
  // deadline for money still owed on it). clearExpiresIfNoLongerNeeded, above,
  // clears only when nothing else in the cart still needs it — the SAME
  // helper withdrawCore and sweepRegistrations' expiry branch now call too.
  await clearExpiresIfNoLongerNeeded(tx, reg.group_id, reg.id);
  return entrant.id;
}

/**
 * Person-resolve one player row onto an entrant that already exists, and
 * write its `entrant_members` row + `registration_players.person_id` stamp.
 * Shared by two callers with different reasons for needing it:
 *
 *  - `materialise()`'s own team/pair branch, above — every player row
 *    present AT materialise time, `squad_number`/`is_captain` carried
 *    through as-is.
 *  - `joinTeamEntry`'s INSERT branch (#23, 2026-08-30) — a self-joiner
 *    landing on an entry that was ALREADY materialised before they joined.
 *    `materialise()`'s own idempotency guard (`if (reg.entrant_id) return`,
 *    above) means it never revisits that registration once confirmed, so
 *    the per-player `entrant_members` insert above never runs for a row
 *    inserted after — the joiner's `registration_players` row would exist
 *    and the join page would tell them "you're in", but nothing rosters
 *    them onto the entrant that actually gets fielded. Called with no
 *    `squad_number`/`is_captain` (a self-joiner is never seeded as either).
 *    Never called for the CLAIM branch — a claimed row's person resolution
 *    is `reconcileClaimedPerson`'s job, not this one's, because a claim
 *    UPDATES a row `materialise()` already turned into a member (dummy or
 *    real); there is no membership missing to create.
 *
 * Extracted (RS007 review, medium, 2026-08-30) rather than left as two
 * hand-copies of the same person-resolution + idempotent-upsert sequence —
 * a future change to it (a new column, a different resolution precedence)
 * is easy to apply to one copy and forget in the other.
 */
export async function joinExistingEntrant(
  tx: Tx,
  orgId: string,
  entrantId: string,
  player: {
    id: string;
    full_name: string;
    dob: string | null;
    gender: string | null;
    email: string | null;
    user_id: string | null;
    squad_number?: number | null;
    is_captain?: boolean;
  },
): Promise<void> {
  const name = player.full_name.trim();
  if (!name) return;
  const personId = player.user_id
    ? await resolvePlayerPerson(tx, orgId, player.user_id, name, player.dob, player.gender)
    : await findOrCreatePlayerPerson(tx, orgId, name, player.dob, player.gender, player.email);
  await tx`
    insert into entrant_members (entrant_id, person_id, squad_number, is_captain)
    values (${entrantId}, ${personId}, ${player.squad_number ?? null}, ${player.is_captain ?? false})
    on conflict (entrant_id, person_id) do nothing`;
  await tx`
    update registration_players set person_id = ${personId}, updated_at = now()
    where id = ${player.id}`;
}

/**
 * Oldest waitlisted → pending (doc 16 §1.1 auto-promotion). Waitlisted rows
 * hold amount 0, so promotion SNAPSHOTS the current fee + method (spec §2);
 * card divisions get a fresh 48h pay window. Returns the promoted row.
 *
 * `currency` is NOT re-snapshotted (RS001b). It is org-level now and the group
 * captured it at submit; design §3 is explicit that a later org-currency change
 * never touches an existing group, and a promotion is not a new quote. Writing
 * the org's CURRENT currency here would silently re-denominate a cart the
 * registrant was already shown a price for.
 *
 * Exported for `registration-approval.ts` (RS002 W5) — `promoteFromWaitlist`'s
 * default (no explicit id) mode calls this directly rather than re-deriving
 * the oldest-first pick.
 *
 * "Oldest" is `coalesce(waitlisted_at, created_at)`, not bare `created_at`
 * (V378/RS007). A row that has never lapsed has `waitlisted_at = null`, so
 * this is byte-for-byte the old ordering for every pre-existing waitlisted
 * row. A row `sweepRegistrations`' lapse branch just returned to the
 * waitlist carries a fresh `waitlisted_at = now()`, which sorts it BEHIND
 * every row still waiting on its original `created_at` — the tail, not a
 * reclaimed place in line — even though its OWN `created_at` may be far
 * older than theirs.
 */
/**
 * REVIEW FIX (money-path defect #5) — `excludeId` is optional, additive, and
 * ONLY ever passed by `sweepRegistrations`' lapse branch. `for update skip
 * locked` skips rows locked by an OTHER transaction, never one this same
 * transaction already holds — so a call made in the SAME tx that just
 * flipped a row to 'waitlisted' can, when that row is the only (or oldest)
 * candidate, re-select and immediately re-promote the very row that just
 * lapsed, in the same instant it was returned to the queue. Every OTHER
 * caller (withdrawCore, the sweep's expiry branch, registration-approval.ts's
 * promoteFromWaitlist) omits it and is byte-for-byte unchanged: none of them
 * lock a waitlisted candidate ahead of this call the way the lapse branch
 * does.
 */
export async function promoteOldestWaitlisted(
  tx: Tx,
  divisionId: string,
  settings: RegistrationSettingsRow | null,
  excludeId?: string,
): Promise<RegistrationWithGroupRow | null> {
  const [picked] = await tx<{ id: string; group_id: string }[]>`
    select id, group_id from registrations
    where division_id = ${divisionId} and status = 'waitlisted'
      ${excludeId ? tx`and id <> ${excludeId}` : tx``}
    order by coalesce(waitlisted_at, created_at), id limit 1
    for update skip locked`;
  if (!picked) return null;
  return promoteWaitlistedRow(tx, picked.id, picked.group_id, settings);
}

/**
 * Mechanical promotion of ONE already-locked waitlisted row — factored out of
 * `promoteOldestWaitlisted` so `registration-approval.ts`'s explicit-id
 * override (`promoteFromWaitlist`) shares the identical write rather than
 * re-deriving it. Callers own locking the row and confirming it is actually
 * `waitlisted` first.
 *
 * ── ROUTED MAJOR FIX (RS002 W5, wave-4 finding; REFINED in review) ─────────
 * `payment_method`/`expires_at` live on the entry's CART (`registration_groups`),
 * shared by every entry in it — see the block comment above
 * `RegistrationWithGroupRow`. The pre-wave-5 code unconditionally overwrote
 * both on every promotion, which could null out or redirect a SIBLING
 * entry's live Stripe deadline/method.
 *
 * Both writes are folded into ONE atomic UPDATE (review MAJOR: a separate
 * SELECT-then-conditionally-UPDATE has a race window a lock alone does not
 * close cheaply — two concurrent promotions of DIFFERENT waitlisted siblings
 * in the same cart could each read "no pending sibling" before either
 * commits, reintroducing the clobber). Postgres's own row lock on the
 * `registration_groups` row serializes two transactions that both try to
 * update the SAME cart: the second one's `not exists` subquery only
 * evaluates once it acquires the lock, i.e. after the first commits, so it
 * correctly sees the first promotion's own `status = 'pending'` write — no
 * explicit `for update` needed here for that guarantee.
 *
 * `payment_method`: NOT-EXISTS-guarded exactly as before — only overwritten
 * when no OTHER entry in the cart is still `pending` (the same predicate
 * `sweepRegistrations`' own due/overdue queries use for "still watching this
 * envelope"). Skipped writes leave the cart's existing method untouched.
 * Wave 4's `assertUniformPaymentMethod` already makes every PAID division in
 * one cart agree on method at submit time, so a live divergence here can
 * only mean a division's `registration_settings.payment_method` changed
 * AFTER submit — this function does not attempt to reconcile that; it only
 * guarantees it never clobbers a still-`pending` sibling.
 *
 * `expires_at`: MONOTONIC, not conditional (review MAJOR — the conditional
 * skip above protected a SIBLING's deadline but left the newly-PROMOTED
 * entry with NO deadline of its own whenever it inherited an offline/null
 * envelope: a card-fee promotion into a cart whose only other write was
 * offline got no checkout link and no `expires_at`, and because
 * `sweepRegistrations`' overdue query requires `expires_at is not null`, it
 * could never expire — a permanently unpayable, permanently un-expirable
 * promotion). When THIS promotion itself needs a Stripe window, the
 * deadline can only ever EXTEND — `greatest(coalesce(expires_at, now()),
 * now() + 48h)` — never shorten or null a sibling's existing (possibly
 * later) deadline; same additive pattern the refund paths already use
 * (`greatest(refunded_cents, …)`). When it does not (free/offline
 * promotion), the column is left exactly as it was.
 *
 * ── promotion_expires_at (V378/RS007) — ADDITIVE, alongside the group write
 * above, not instead of it ────────────────────────────────────────────────
 * The group's `expires_at` is shared by every entry in the cart, so
 * `sweepRegistrations` cannot use it to decide THIS entry's own pay window
 * without also catching (or missing) its siblings — see the STRUCTURAL
 * finding in `_INDEX.md`'s RS007 section. `promotion_expires_at` is this
 * row's own clock: same window, same `stripeWindow` gate, but scoped to
 * `regId` alone via a plain overwrite rather than `greatest(...)` — unlike
 * the group's column, nothing else ever writes this one, so there is no
 * sibling deadline to protect from shortening. Left null on an
 * offline/free promotion, exactly like the group's would be if nothing else
 * in the cart needed it.
 * ───────────────────────────────────────────────────────────────────────── */
export async function promoteWaitlistedRow(
  tx: Tx,
  regId: string,
  groupId: string,
  settings: RegistrationSettingsRow | null,
): Promise<RegistrationWithGroupRow | null> {
  const feeCents = settings?.fee_cents ?? 0;
  const method = settings?.payment_method ?? "offline";
  const stripeWindow = method === "stripe" && feeCents > 0;
  await tx`
    update registrations
    set status = 'pending', promoted_at = now(), updated_at = now(),
        amount_cents = ${feeCents},
        promotion_expires_at = case
          when ${stripeWindow} then now() + interval '48 hours'
          else null
        end,
        -- REVIEW FIX (money-path defect #12): every promotion opens a FRESH
        -- reminder window — a re-promotion (lapsed once, re-offered later)
        -- must not carry its FIRST promotion's "already reminded" mark into
        -- this one. Unconditional: a row promoted for the first time already
        -- has this null, so the write is a no-op there.
        promotion_reminded_at = null,
        promotion_reminder_claimed_at = null
    where id = ${regId}`;
  await tx`
    update registration_groups
    set payment_method = case
          when not exists (
            select 1 from registrations
            where group_id = ${groupId} and id <> ${regId} and status = 'pending'
          ) then ${method}
          else payment_method
        end,
        expires_at = case
          when ${stripeWindow} then greatest(coalesce(expires_at, now()), now() + interval '48 hours')
          else expires_at
        end,
        updated_at = now()
    where id = ${groupId}`;
  const [row] = await tx<RegistrationWithGroupRow[]>`
    select ${regGroupCols(tx)}
    from registrations r join registration_groups g on g.id = r.group_id
    where r.id = ${regId}`;
  return row ?? null;
}

/** Post-tx promoted email (fire-and-forget): card entries get a fresh
 *  token-free checkout link, offline entries the resolved instructions.
 *  Exported for `registration-approval.ts` (RS002 W5) — `promoteFromWaitlist`
 *  reuses this verbatim rather than re-deriving the promoted-email shape. */
export async function notifyPromoted(
  promoted: RegistrationWithGroupRow,
  ctx: DivisionCtx,
  settings: RegistrationSettingsRow | null,
  origin: string,
): Promise<void> {
  try {
    // REVIEW FIX (#10): the DIVISION's own payment method — never
    // `promoted.payment_method` (registration_groups.payment_method, the
    // cart's shared envelope column). promoteWaitlistedRow only writes that
    // shared column when no OTHER entry in the cart is still 'pending' (see
    // its own doc comment), so it can stay null/stale forever past exactly
    // the promotion this function emails — reading it here silently dropped
    // BOTH the pay link (stripe divisions) and the instructions (offline
    // divisions). Same fallback convention promoteWaitlistedRow's own
    // `method` already uses.
    const method = settings?.payment_method ?? "offline";
    let payUrl: string | null = null;
    if (method === "stripe" && promoted.amount_cents > 0 && ctx.charges_enabled) {
      try {
        payUrl = await createRegistrationCheckout(promoted.group_id, [promoted.id], ctx, origin, null);
      } catch {
        /* the reminder sweep mints another */
      }
    }
    await sendRegistrationPromotedEmail({
      to: promoted.contact_email,
      locale: toLocale(promoted.locale),
      orgName: ctx.org_name,
      competitionName: ctx.comp_name,
      displayName: promoted.display_name,
      feeCents: promoted.amount_cents,
      currency: promoted.currency,
      payUrl,
      // REVIEW FIX (#13b): this entry's OWN promotion_expires_at, never
      // `promoted.expires_at` (the GROUP's shared column, which a sibling's
      // own earlier/later promotion can leave disagreeing with this row) —
      // the lapse sweep enforces THIS entry's own clock (sweepRegistrations
      // pass 1b, keyed on `r.promotion_expires_at`), so emailing the
      // group's could tell a registrant they have longer than they
      // actually do. Same column pass (1b)'s own reminder mail already
      // uses. Null on an offline/free promotion, exactly as before.
      payDeadline: promoted.promotion_expires_at,
      paymentInstructions:
        method === "offline" && promoted.amount_cents > 0
          ? (settings?.payment_instructions ?? ctx.payment_instructions)
          : null,
      refCode: promoted.ref_code,
      refStatusUrl: promoted.ref_code ? `${origin}/r/${promoted.ref_code}` : null,
    });
  } catch {
    /* fire-and-forget */
  }
}

/**
 * RS008 — invite ONE person to claim their profile, post-commit,
 * best-effort. Guards against the double-send `_INDEX.md` calls out: an
 * unclaimed person with several registrations (across unrelated
 * competitions, or a materialise() re-run) must never be re-invited (and
 * have their still-pending invite silently revoked) every time one of them
 * converges here — so this checks for an OPEN (unclaimed, unrevoked) claim
 * FIRST and skips silently if one already exists, rather than relying on
 * `createSystemClaimInvite`'s own revoke-and-replace (correct for the
 * deliberate, session-authed organiser action it was written for; wrong for
 * an automatic sweep that can run many times for the same person). Never
 * throws — a mail-provider hiccup, or any other failure here, must never
 * break the registration flow that triggered it.
 */
async function maybeInviteClaim(orgId: string, personId: string, email: string): Promise<void> {
  try {
    // RS008 review fix #7 — this guard used to check ONLY claimed_at/
    // revoked_at, never expires_at. person-claims.ts's natural-expiry path
    // never sets revoked_at (only claimPerson/revokeClaimInvite/unlinkPerson
    // do), so an unclaimed invite that simply lapsed past its 14-day window
    // still reads as "open" here forever — this guard returned early
    // FOREVER, and createSystemClaimInvite (the only place that would ever
    // revoke-and-replace that stale row) was never even reached again. A
    // person whose one invite lapsed unclaimed could NEVER be auto-invited a
    // second time, permanently defeating the whole point of C (RS008's
    // claim-invite sweep). `expires_at > now()` makes an expired-but-not-
    // revoked row read as NOT open, so the sweep proceeds to
    // createSystemClaimInvite below — which ALREADY revokes any row matching
    // `claimed_at is null and revoked_at is null` (regardless of its own
    // expiry) before inserting the new one, so the stale row is revoked
    // there rather than needing a second, redundant revoke here. This is
    // also what keeps the partial unique index `person_claims_open_uq` (V276,
    // `where claimed_at is null and revoked_at is null` — no expiry
    // predicate of its own) from ever seeing two "open" rows at once.
    const [openClaim] = await sql<{ id: string }[]>`
      select id from person_claims
      where person_id = ${personId} and claimed_at is null and revoked_at is null
        and expires_at > now()
      limit 1`;
    if (openClaim) return;
    const invite = await createSystemClaimInvite(sql, orgId, personId, email);
    if (!invite) return;
    const claimUrl = `${fallbackOrigin()}${routes.claim(invite.secret)}`;
    await sendClaimInviteEmail(email, {
      orgName: invite.org_name,
      personName: invite.person_name,
      claimUrl,
    });
  } catch (err) {
    log.error({ err, event: "registration.claim_invite_failed", org_id: orgId, person_id: personId }, "RS008 claim invite failed");
  }
}

/**
 * RS008 — fire-and-forget, called AFTER the caller's own transaction has
 * committed (never from inside one: this reads via the pooled `sql`, so a
 * call from inside an open tx would see none of that tx's own uncommitted
 * writes, and the email send below is network I/O that must never run
 * inside a held connection). Re-derives, fresh, every current member of
 * `entrantId`'s roster whose row is consented (`granted`/`guardian`, never
 * `pending` — nobody has agreed to anything for those yet) with an email on
 * file and no linked account — the exact gap RS008 closes: a captain-
 * entered player (or an anonymous captain's own row) whose consent is real
 * but who has no way to ever reach the `/me` opt-out that already exists
 * for everyone else.
 *
 * Safe to call unconditionally, repeatedly, from every convergence point
 * (`materialise()`'s callers, `joinTeamEntry`) — re-deriving fresh rather
 * than trusting a caller-supplied candidate list means it never matters
 * WHICH write caused a row to newly qualify, and `maybeInviteClaim`'s own
 * open-claim guard makes a repeat sweep of the same entrant a cheap no-op.
 * `person_id is not null` excludes a row nobody has resolved a person for
 * yet (an unmaterialised captain-entered slot) — nothing to invite there.
 */
export async function inviteUnclaimedMembers(orgId: string, entrantId: string): Promise<void> {
  try {
    const rows = await sql<{ person_id: string; email: string | null }[]>`
      select rp.person_id, coalesce(rp.email, p.email) as email
      from registration_players rp
      join registrations r on r.id = rp.registration_id
      join persons p on p.id = rp.person_id
      where r.entrant_id = ${entrantId}
        and rp.consent_status in ('granted', 'guardian')
        and rp.person_id is not null
        and p.user_id is null`;
    for (const row of rows) {
      if (!row.email) continue;
      await maybeInviteClaim(orgId, row.person_id, row.email);
    }
  } catch (err) {
    log.error({ err, event: "registration.claim_invite_sweep_failed", org_id: orgId, entrant_id: entrantId }, "RS008 claim invite sweep failed");
  }
}

/**
 * Assembles the CART-shaped confirmation mail for one group — every
 * CURRENT entry with its own display name/status/fee, the cart's total/
 * currency/deadline/ref code, and (for an offline cart with money owed)
 * the resolved payment instructions. Shared by the submit-time send
 * (`notifySubmitted`), the organiser resend action
 * (`resendRegistrationConfirmation`) and the dispute-evidence
 * reconstruction (`buildDisputeEvidence`) — one query decides what "this
 * cart's confirmation email" contains, the same re-select-fresh-state
 * convention `mintGroupCheckout` uses rather than trusting a caller's
 * snapshot. Returns null (never throws) for a nonexistent group or one
 * with no entries — should not happen in practice; kept as a defensive
 * no-op for the fire-and-forget submit-time caller.
 *
 * `token`: the plaintext access token, only ever available at the SUBMIT
 * moment (only its sha256 is stored afterwards). When given, `statusUrl`
 * carries it — the same full-access status-page URL shape
 * `createRegistrationCheckout`'s own `returnBase` builds. When null
 * (every other caller), it falls back to the token-less `/r/[ref]` page,
 * mirroring that same function's fallback.
 *
 * `payUrl`: never minted here — a caller with a fresh checkout link
 * resolves it itself and passes it straight through, exactly as
 * `notifyPromoted` (above) does inline.
 */
async function buildCartMail(
  groupId: string,
  origin: string,
  token: string | null,
  payUrl: string | null,
): Promise<{ to: string; locale: string | null; competitionId: string; args: RegistrationEmailArgs } | null> {
  const [group] = await sql<
    Pick<
      RegistrationGroupRow,
      | "contact_email" | "locale" | "ref_code" | "amount_cents" | "currency"
      | "expires_at" | "payment_method" | "competition_id"
    >[]
  >`
    select contact_email, locale, ref_code, amount_cents, currency, expires_at,
           payment_method, competition_id
    from registration_groups where id = ${groupId}`;
  if (!group) {
    // Silent before RS005 F1: a caller (notifySubmitted, resendRegistration-
    // Confirmation, buildDisputeEvidence) just got a null it could not
    // explain — the dispute-evidence caller in particular falls back to a
    // placeholder that reads as "no receipt was sent" on a document
    // submitted to Stripe as evidence. Should not happen in practice
    // (registrations FK to their group), which is exactly why it needs a
    // trace when it does.
    log.error({ groupId }, "registration: buildCartMail found no group for this id — cart mail cannot be built");
    return null;
  }

  const entries = await sql<
    { id: string; division_id: string; display_name: string; status: RegistrationRow["status"]; amount_cents: number }[]
  >`
    select id, division_id, display_name, status, amount_cents
    from registrations where group_id = ${groupId}
    order by created_at, id`;
  if (entries.length === 0) {
    // Same "should not happen, but must not be invisible if it does" as the
    // !group branch above — see this function's own doc comment on this
    // defensive no-op.
    log.error({ groupId }, "registration: buildCartMail's group has no entries — cart mail cannot be built");
    return null;
  }

  const ctx = await divisionCtx(sql, entries[0]!.division_id);

  // The cart's payable subtotal, derived FRESH from the entries actually in
  // it right now — never `group.amount_cents` (RS005 F1 finding 2). That
  // column is a SUBMIT-TIME snapshot (registration-submit.ts's own
  // `subtotal`) with exactly one other writer: `promoteWaitlistedRow`
  // updates the promoted entry's own `registrations.amount_cents` but never
  // this mirror, so a cart mail rebuilt after a promotion (resend, dispute
  // evidence) read a stale 0 for an entry that now genuinely owes money.
  // Summing the live entries here — the same "non-waitlisted" rule
  // submit-time subtotal itself uses — self-heals regardless of which
  // entry-level writer last touched a fee, matching this function's own
  // re-select-fresh-state convention (see its doc comment re
  // `mintGroupCheckout`) rather than adding a second mirror write that can
  // drift again the next time a new promotion-shaped writer appears.
  const totalCents = entries.reduce(
    (sum, e) => sum + (e.status === "waitlisted" ? 0 : e.amount_cents),
    0,
  );

  // Same gate `notifyPromoted` uses for its single entry: offline AND money
  // actually owed — reading the SAME derived `totalCents` above, not the
  // stale column, for the identical reason (a promotion into an offline
  // cart must surface its instructions too).  A cart's paid divisions
  // share one payment_method (assertUniformPaymentMethod at submit), so
  // the first entry that still carries a fee is representative of the
  // whole cart, not a guess across divisions that disagree.
  let paymentInstructions: string | null = null;
  if (group.payment_method === "offline" && totalCents > 0) {
    const firstPaid = entries.find((e) => e.amount_cents > 0) ?? entries[0]!;
    const settings = await loadSettings(sql, firstPaid.division_id);
    paymentInstructions = settings?.payment_instructions ?? ctx.payment_instructions;
  }

  const statusUrl = token
    ? `${origin}/shared/${ctx.org_slug}/${ctx.comp_slug}/register/status?rid=${groupId}&token=${encodeURIComponent(token)}`
    : `${origin}/r/${group.ref_code}`;

  return {
    to: group.contact_email,
    locale: group.locale,
    competitionId: group.competition_id,
    args: {
      orgName: ctx.org_name,
      competitionName: ctx.comp_name,
      entries: entries.map((e) => ({ displayName: e.display_name, status: e.status, feeCents: e.amount_cents })),
      totalCents,
      currency: group.currency,
      paymentInstructions,
      payUrl,
      payDeadline: group.expires_at,
      statusUrl,
      refCode: group.ref_code,
      refStatusUrl: group.ref_code ? `${origin}/r/${group.ref_code}` : null,
    },
  };
}

/**
 * Post-submit confirmation (RS005 W4) — fire-and-forget, cart-shaped: every
 * entry in the group with its own status/fee, the group's payable total,
 * and `payUrl` exactly as resolved by the caller (the public register
 * route, after its own `mintGroupCheckout` attempt succeeds, fails, or is
 * skipped for a zero-subtotal cart) — this function never mints anything
 * itself. `sendRegistrationEmail` had ZERO callers before this wave; this
 * is the first one. A registrant who gets no mail because the provider
 * rejected it, or because this function itself threw, still keeps a
 * committed, capacity-holding cart — that is the entire reason this wraps
 * everything in one try/catch, matching `notifyPromoted`'s contract
 * exactly: a mail failure must never fail the submit that already
 * committed.
 */
export async function notifySubmitted(
  groupId: string,
  origin: string,
  token: string,
  payUrl: string | null,
): Promise<void> {
  try {
    const mail = await buildCartMail(groupId, origin, token, payUrl);
    if (!mail) return; // buildCartMail already logged why
    await sendRegistrationEmail({ to: mail.to, locale: toLocale(mail.locale), ...mail.args });
  } catch (err) {
    // RS005 F1 (owner: new code ships logging, 2026-08-12) — this used to
    // swallow silently. That is exactly how the single biggest finding of
    // this session went unnoticed for weeks: the confirmation send failed
    // and nothing recorded it. Still fire-and-forget — the point is that a
    // failure stops being invisible, not that submit starts failing.
    log.error({ err, groupId }, "registration: submit confirmation send failed");
  }
}

/**
 * Organiser: resend the cart's confirmation email (RS005 W4) — the WHOLE
 * cart `regId` belongs to, not just that one entry, since the mail itself
 * is cart-shaped. No fresh checkout is minted here (unlike the submit-time
 * send): the plaintext access token no longer exists once the cart is
 * committed (only its hash is stored), and re-minting a live Stripe session
 * on every resend click would leave a fresh abandoned session behind each
 * time for no ask in this wave — the registrant reaches payment through the
 * emailed status link, which already knows how to resume checkout.
 */
export async function resendRegistrationConfirmation(
  auth: AuthCtx,
  regId: string,
  origin: string,
): Promise<{ sent: boolean }> {
  const reg = await withTenant(auth.orgId, (tx) => orgReg(tx, regId));
  // A withdrawn/rejected/expired entry gets no confirmation. Observed live:
  // the organiser could resend on a WITHDRAWN entry and the send succeeded, so
  // someone who had pulled out received an email confirming their
  // registration — and because the mail is cart-shaped, it re-stated their
  // whole cart to them as though nothing had happened.
  //
  // Guarded HERE and not only in the UI: the button gate is a courtesy, this
  // is the rule. The route is reachable directly with a session or an API key.
  if (isTerminalRegistrationStatus(reg.status)) {
    // RS005 F1: an organiser clicking Resend and getting a 422 with nothing
    // recorded anywhere left no trace of who tried what on which entry.
    log.warn(
      { registrationId: regId, orgId: auth.orgId, actorId: auth.userId, status: reg.status },
      "registration: confirmation resend refused — entry is terminal",
    );
    throw new HttpError(
      422,
      `This registration is ${reg.status} — a confirmation would tell the registrant they are entered`,
    );
  }
  const mail = await buildCartMail(reg.group_id, origin, null, null);
  if (!mail) return { sent: false }; // buildCartMail already logged why
  const sent = await sendRegistrationEmail({ to: mail.to, locale: toLocale(mail.locale), ...mail.args });
  if (!sent) {
    // Same standing rule as the terminal-refusal branch above: an organiser
    // clicking Resend and getting nothing must leave a trace, distinct from
    // the generic provider-level warn in lib/email.ts (which carries no
    // registration/actor context to tie back to this click).
    log.warn(
      { registrationId: regId, orgId: auth.orgId, actorId: auth.userId, groupId: reg.group_id, to: mail.to },
      "registration: confirmation resend — email provider did not accept the send",
    );
  }
  await withTenant(auth.orgId, (tx) =>
    audit(
      tx,
      mail.competitionId,
      auth.orgId,
      "registration.confirmation_resent",
      { registration_id: regId },
      auth.userId,
    ),
  );
  return { sent };
}

/**
 * Registrant self-service resend (RS007) — the token-gated sibling of
 * `resendRegistrationConfirmation` above. Keyed on the GROUP (`rid`), not one
 * entry: the confirmation mail is cart-shaped (`buildCartMail`), so gating on
 * one arbitrarily-picked entry's own status — the way the organiser path's
 * `regId` does — would refuse a resend for a cart that still has other
 * active entries. This refuses only once EVERY entry in the cart is
 * terminal.
 *
 * Unlike the organiser path — which never holds the plaintext token past
 * submit, only its hash survives — this path is called from the very page
 * that already has the real token in its URL, so it threads it through to
 * `buildCartMail`: the resent mail's `statusUrl` is the full rid+token
 * status page, not the masked `/r/[ref]` fallback `token: null` produces.
 */
export async function resendRegistrationConfirmationPublic(
  groupId: string,
  token: string,
  origin: string,
): Promise<{ sent: boolean }> {
  const [group] = await sql<
    Pick<RegistrationGroupRow, "org_id" | "competition_id" | "access_token_hash">[]
  >`
    select org_id, competition_id, access_token_hash
    from registration_groups where id = ${groupId}`;
  if (!group || !tokenMatchesHash(token, group.access_token_hash)) {
    throw new HttpError(404, "registration not found");
  }
  const entries = await sql<{ status: RegistrationRow["status"] }[]>`
    select status from registrations where group_id = ${groupId}`;
  if (entries.length === 0 || entries.every((e) => isTerminalRegistrationStatus(e.status))) {
    throw new HttpError(
      422,
      "This registration is no longer active — a confirmation would tell the registrant they are entered",
    );
  }
  const mail = await buildCartMail(groupId, origin, token, null);
  if (!mail) return { sent: false }; // buildCartMail already logged why
  const sent = await sendRegistrationEmail({ to: mail.to, locale: toLocale(mail.locale), ...mail.args });
  await audit(
    sql,
    group.competition_id,
    group.org_id,
    "registration.confirmation_resent",
    { group_id: groupId },
    null,
  );
  return { sent };
}

// ---------------------------------------------------------------------------
// Organiser: settings
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: Omit<RegistrationSettingsRow, "division_id"> = {
  enabled: false,
  entrant_kind: "individual",
  opens_at: null,
  closes_at: null,
  capacity: null,
  fee_cents: 0,
  refund_lock_at: null,
  form_fields: [],
  payment_method: "offline",
  payment_instructions: null,
  approval: "auto",
  allow_free_agents: false,
  free_agent_fee_cents: null,
  updated_at: null,
};

export interface OrgPaymentDefaults {
  charges_enabled: boolean;
  org_payment_instructions: string | null;
  org_default_payment_method: string;
  /** The org's one preferred currency (RS001b). Read-only on the division
   *  settings surface — RS004 renders it as a chip linking to org settings,
   *  and the same-currency lock pins it to the connected account's settlement
   *  currency while connected. */
  currency: string;
}

async function orgPaymentDefaults(orgId: string): Promise<OrgPaymentDefaults> {
  const [row] = await sql<OrgPaymentDefaults[]>`
    select stripe_charges_enabled as charges_enabled,
           payment_instructions as org_payment_instructions,
           default_payment_method as org_default_payment_method,
           currency
    from organizations where id = ${orgId}`;
  if (!row) throw new HttpError(404, "organization not found");
  return row;
}

export async function getRegistrationSettings(
  auth: AuthCtx,
  divisionId: string,
): Promise<RegistrationSettingsRow & OrgPaymentDefaults> {
  const org = await orgPaymentDefaults(auth.orgId);
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const row = await loadSettings(tx, divisionId);
    return { division_id: divisionId, ...DEFAULT_SETTINGS, ...(row ?? {}), ...org };
  });
}

export async function putRegistrationSettings(
  auth: AuthCtx,
  divisionId: string,
  input: PutRegistrationSettings,
): Promise<RegistrationSettingsRow & OrgPaymentDefaults> {
  await requireFeature(auth.orgId, "registration.enabled");
  const [regDiv] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`;
  const org = await orgPaymentDefaults(auth.orgId);

  // Offline (cash/bank) fees are free on every plan — they fill the funnel.
  // Card collection is the paid layer (doc 16 §1.1): it needs a live Connect
  // account AND the registration.paid entitlement, and the fee must clear
  // Stripe's minimum charge (spec issue #13).
  // Zod defaults apply on the route; direct callers (tests, scripts) may omit
  // defaulted fields, so normalise exactly like the schema does.
  const method = input.payment_method ?? "offline";
  const feeCents = input.fee_cents ?? 0;
  const entrantKind = input.entrant_kind ?? "individual";
  const formFields = input.form_fields ?? [];
  const approval = input.approval ?? "auto";
  const allowFreeAgents = input.allow_free_agents ?? false;
  // `?? null`, never `|| null`: 0 is a real price ("solo sign-ups are free in
  // this paid division") and `||` would silently turn it back into "unset",
  // charging the full team fee to someone the panel told was free.
  const freeAgentFeeCents = input.free_agent_fee_cents ?? null;
  // Free agents (an entry with no roster yet, RS004/V364) only make sense
  // where there IS a roster to join later — registration-submit.ts's own
  // guard already refuses a free-agent submit outside entrant_kind 'team';
  // this rejects the setting itself at save time instead of letting an
  // organiser turn on a toggle that can never take effect.
  if (allowFreeAgents && entrantKind !== "team") {
    throw new HttpError(422, "allow_free_agents requires entrant_kind 'team'");
  }
  // A price for something the division does not offer is a setting that reads
  // as a promise: the panel would show a solo sign-up fee on a division where
  // nobody can sign up solo. Same rule the toggle itself already follows.
  if (freeAgentFeeCents !== null && !allowFreeAgents) {
    throw new HttpError(
      422,
      "A solo sign-up price only applies where solo sign-ups are allowed — turn those on first",
    );
  }
  if (freeAgentFeeCents !== null && freeAgentFeeCents < 0) {
    throw new HttpError(422, "A solo sign-up price cannot be negative");
  }
  // The Stripe minimum applies to whatever is actually CHARGED, and a solo
  // sign-up is charged this instead of fee_cents — so a division can pass the
  // fee_cents check below and still mint a checkout Stripe rejects.
  if (method === "stripe" && freeAgentFeeCents !== null && freeAgentFeeCents > 0 && freeAgentFeeCents < 100) {
    throw new HttpError(422, "Card entry fees must be at least 1.00 (or 0 for free)");
  }
  if (method === "stripe") {
    if (!org.charges_enabled) {
      throw new HttpError(
        422,
        "Connect Stripe under Settings → Connect before choosing card payments",
      );
    }
    await requireFeature(auth.orgId, "registration.paid", regDiv?.competition_id);
    if (feeCents > 0 && feeCents < 100) {
      throw new HttpError(422, "Card entry fees must be at least 1.00 (or 0 for free)");
    }
  }

  // Capacity can't promise more than the plan's entrant quota (doc 10 §1) —
  // confirm would hit the wall after money changed hands.
  if (input.capacity != null) {
    const limit = await getLimit(auth.orgId, "entrants.per_division.max", regDiv?.competition_id);
    if (limit !== null && input.capacity > limit) {
      throw new HttpError(
        422,
        `Capacity exceeds your plan's entrant limit (${limit}) — raise the plan or lower the capacity`,
      );
    }
  }
  if (input.opens_at && input.closes_at && new Date(input.opens_at) >= new Date(input.closes_at)) {
    throw new HttpError(422, "closes_at must be after opens_at");
  }

  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const [row] = await tx<RegistrationSettingsRow[]>`
      insert into registration_settings
        (division_id, enabled, entrant_kind, opens_at, closes_at, capacity,
         fee_cents, refund_lock_at, form_fields,
         payment_method, payment_instructions, approval, allow_free_agents,
         free_agent_fee_cents, updated_at)
      values
        (${divisionId}, ${input.enabled}, ${entrantKind},
         ${input.opens_at ?? null}, ${input.closes_at ?? null},
         ${input.capacity ?? null}, ${feeCents},
         ${input.refund_lock_at ?? null}, ${tx.json(formFields as never)},
         ${method}, ${input.payment_instructions?.trim() || null},
         ${approval}, ${allowFreeAgents}, ${freeAgentFeeCents}, now())
      on conflict (division_id) do update set
        enabled              = excluded.enabled,
        entrant_kind         = excluded.entrant_kind,
        opens_at             = excluded.opens_at,
        closes_at            = excluded.closes_at,
        capacity             = excluded.capacity,
        fee_cents            = excluded.fee_cents,
        refund_lock_at       = excluded.refund_lock_at,
        form_fields          = excluded.form_fields,
        payment_method       = excluded.payment_method,
        payment_instructions = excluded.payment_instructions,
        approval             = excluded.approval,
        allow_free_agents    = excluded.allow_free_agents,
        free_agent_fee_cents = excluded.free_agent_fee_cents,
        updated_at           = now()
      returning ${sql(SETTINGS_COLS as unknown as string[])}`;
    return { ...row, ...org };
  });
}

// ---------------------------------------------------------------------------
// Public: register panel info
// ---------------------------------------------------------------------------

export interface PublicDivisionInfo {
  division_id: string;
  name: string;
  slug: string;
  sport_key: string;
  // Needlessly widened to `string` before RS006; the row this is built from
  // (RegistrationSettingsRow, via the `rs.*` select above) already carries
  // the narrow union, and the wire contract (PublicRegistrationDivision,
  // schemas.ts) already declares it as the EntrantKind enum — tightened
  // here too so a client-side exhaustive switch (RS006's division-card.tsx)
  // doesn't need a defensive `string` fallback for a value that can only
  // ever be one of these three.
  entrant_kind: "team" | "individual" | "pair";
  fee_cents: number;
  currency: string;
  /** How the entry fee is collected (spec §3). */
  payment_method: "offline" | "stripe";
  opens_at: string | null;
  closes_at: string | null;
  capacity: number | null;
  remaining: number | null;
  /** Spots already taken — drives the masthead capacity meter (v3/05 §2). */
  taken: number;
  open: boolean;
  /** 'window' | 'full' | 'payments_unavailable' | null */
  closed_reason: string | null;
  /** V364 first-class columns (RS006 W1), alongside the derived booleans
   *  below — the ENTRIES step badges these directly and runs the SAME
   *  category/age-band predicates (@/lib/registration-rules) to grey a
   *  self-ineligible division, rather than forking new rules client-side. */
  category: string | null;
  age_min: number | null;
  age_max: number | null;
  /** RS007/V380 — the age-band cutoff override (default 1 January when
   *  null). Threaded onto the wire so the ENTRIES step's client-side self-
   *  check (`ageBandEligibilityIssues`, @/lib/registration-rules) evaluates
   *  the SAME cutoff the server enforces at submit — before this field
   *  existed here, the client silently defaulted to 1 January for every
   *  division, and would disagree with the server for any division with a
   *  real cutoff (the exact "two cutoffs disagree" defect V380 exists to
   *  kill, resurfaced client-side). */
  age_cutoff_month: number | null;
  age_cutoff_day: number | null;
  /** Team-only; drives the ENTRIES step's free-agent option. */
  allow_free_agents: boolean;
  requires_dob: boolean;
  requires_gender: boolean;
  /** Youth division (v3/11 gap 8): the form always adds guardian consent. */
  youth: boolean;
  /** Queue length behind a full division (PROMPT-52) — public. */
  waitlisted: number;
  form_fields: RegistrationFormField[];
  /** RS007/V380 — the retired jsonb "custom rule" note, now a first-class
   *  `divisions` column the ENTRIES step renders as an organiser notice
   *  (design: "manual, shown as a warning" — components/public-site/
   *  register/division-card.tsx). Organiser-authored free text: render as
   *  TEXT, never as HTML/markdown. */
  eligibility_note: string | null;
}

export interface PublicRegistrationInfoResult {
  competition: {
    id: string;
    name: string;
    slug: string;
    starts_on: string | null;
    ends_on: string | null;
  };
  org: { name: string; slug: string; logo_url: string | null };
  divisions: PublicDivisionInfo[];
}

/** The public register panel (superuser read; public/unlisted comps only). */
export async function publicRegistrationInfo(
  orgSlug: string,
  compSlug: string,
): Promise<PublicRegistrationInfoResult> {
  const [comp] = await sql<
    {
      id: string; name: string; slug: string; org_id: string; charges_enabled: boolean;
      starts_on: string | null; ends_on: string | null;
      org_name: string; logo_storage_path: string | null; logo_url: string | null;
      currency: string;
    }[]
  >`
    select c.id, c.name, c.slug, c.org_id, o.stripe_charges_enabled as charges_enabled,
           c.starts_on, c.ends_on,
           o.name as org_name, o.logo_storage_path, o.logo_url, o.currency
    from competitions c join organizations o on o.id = c.org_id
    where o.slug = ${orgSlug} and c.slug = ${compSlug}
      and c.visibility in ('public','unlisted') and o.status = 'active'`;
  if (!comp) throw new HttpError(404, "competition not found");

  const rows = await sql<
    (RegistrationSettingsRow & {
      name: string;
      slug: string;
      sport_key: string;
      // V364 first-class columns: `age_min`/`age_max` also drive
      // `requires_dob` below (a category-only division needs no DOB).
      // `category` drives `requires_gender` the same way, and both ship on
      // the wire (RS006 W1: the ENTRIES step badges category/age and greys
      // a self-ineligible division, so the client needs the raw values, not
      // just the derived booleans).
      category: string | null;
      age_min: number | null;
      age_max: number | null;
      age_cutoff_month: number | null;
      age_cutoff_day: number | null;
      youth: boolean;
      active: number;
      waitlisted: number;
      eligibility_note: string | null;
    })[]
  >`
    select rs.*, d.name, d.slug, d.sport_key, d.category, d.age_min, d.age_max, d.youth,
           d.age_cutoff_month, d.age_cutoff_day,
           d.eligibility_note,
           (select count(*)::int from registrations r
             where r.division_id = rs.division_id
               and r.status in ${sql([...SPOT_HOLDERS])}) as active,
           (select count(*)::int from registrations r
             where r.division_id = rs.division_id
               and r.status = 'waitlisted') as waitlisted
    from registration_settings rs
    join divisions d on d.id = rs.division_id
    where d.competition_id = ${comp.id} and rs.enabled
    order by d.name`;

  // Card intake also depends on the paid entitlement (P2-10): an org that
  // dropped to community (lost dispute, canceled sub, past_due grace expiry —
  // Task 9 resolves the last as community at read time) can still have OPEN
  // Stripe-fee divisions with Connect live. Scope by competition so an Event
  // Pass keeps THAT comp's paid intake open.
  const paidEntitled = await hasFeature(comp.org_id, "registration.paid", comp.id);

  const now = new Date();
  const divisions: PublicDivisionInfo[] = rows.map((r) => {
    const remaining =
      r.capacity === null ? null : Math.max(0, r.capacity - r.active);
    // A card division can't take submissions when Connect is broken OR the
    // paid entitlement is gone — closing it with an honest reason beats
    // accepting money we can't keep (spec #9, P2-10).
    const paymentsBroken =
      r.payment_method === "stripe" && r.fee_cents > 0 &&
      (!comp.charges_enabled || !paidEntitled);
    const open = windowOpen(r, now) && !paymentsBroken;
    let reason: string | null = open ? null : paymentsBroken ? "payments_unavailable" : "window";
    if (open && remaining === 0) reason = "full"; // still open — joins the waitlist
    return {
      division_id: r.division_id,
      name: r.name,
      slug: r.slug,
      sport_key: r.sport_key,
      entrant_kind: r.entrant_kind,
      fee_cents: r.fee_cents,
      // Org-level (RS001b): every division on this panel quotes the same
      // currency, which is what makes a multi-division cart payable in one
      // Stripe session.
      currency: comp.currency,
      payment_method: r.payment_method,
      opens_at: r.opens_at ? new Date(r.opens_at).toISOString() : null,
      closes_at: r.closes_at ? new Date(r.closes_at).toISOString() : null,
      capacity: r.capacity,
      remaining,
      taken: r.active,
      open,
      closed_reason: reason,
      // V364 first-class columns (RS006 W1): raw values, so the ENTRIES step
      // can badge category/age and grey a self-ineligible division using the
      // SAME evaluation the server ships (@/lib/registration-rules), instead
      // of forking its own rules client-side.
      category: r.category,
      age_min: r.age_min,
      age_max: r.age_max,
      age_cutoff_month: r.age_cutoff_month,
      age_cutoff_day: r.age_cutoff_day,
      // Team-only (registration-eligibility's putRegistrationSettings rejects
      // `true` on a non-team division) — drives the ENTRIES step's free-agent
      // option (design §4 step 2).
      allow_free_agents: r.allow_free_agents,
      // V364/V380: a division requires a DOB when either first-class age
      // column is set.
      requires_dob: requiresDob({
        age_min: r.age_min,
        age_max: r.age_max,
      }),
      // Same idea as requires_dob, for gender (RS006 WHO step): a
      // mens/womens/mixed category, OR a free-text eligibility_note, which
      // after V380 is the only surviving channel for a restriction the
      // category enum cannot express. Passing the note is not optional: the
      // join-page preview (registration-submit.ts) already does, so omitting
      // it here would make the SAME division collect gender on one public
      // surface and not the other.
      requires_gender: requiresGender({ category: r.category, eligibility_note: r.eligibility_note }),
      youth: r.youth,
      waitlisted: r.waitlisted,
      form_fields: r.form_fields ?? [],
      eligibility_note: r.eligibility_note,
    };
  });
  return {
    competition: {
      id: comp.id,
      name: comp.name,
      slug: comp.slug,
      starts_on: comp.starts_on,
      ends_on: comp.ends_on,
    },
    org: {
      name: comp.org_name,
      slug: orgSlug,
      logo_url: resolveLogoUrl(comp.logo_storage_path, comp.logo_url),
    },
    divisions,
  };
}

// ---------------------------------------------------------------------------
// Public: submit — REMOVED (RS001 registration demolition)
// ---------------------------------------------------------------------------
//
// `submitRegistration` and its `SubmitResult` return shape inserted a single
// `registrations` row carrying the whole old per-entry payment/contact/roster
// envelope in one INSERT — exactly the shape V363/V364 split across
// `registration_groups` (cart) and `registration_players` (per-player rows).
// There is no mechanical translation of a single-row INSERT into "create a
// cart, then one-or-more entries, then their players" — that is a new group
// submit flow, not a re-pointed query, so it is out of this session's
// "mechanical re-pointing" scope. RS002/RS003 own it (design §4, §7 P1);
// until that PR merges the public register route stays deleted and the
// public pages show the closed state (see the three rewritten pages).
//
// Pure helpers this function used stay exported for RS002 to reuse verbatim:
// `validateAnswers`, `deriveLinkUserId`, `isMinor`, `ageAt`,
// `hashRegistrationToken`. `mintRegistrationToken` (private, token-minting
// only) and `generateRefCode`'s only call site here went with it.
// `eligibilityIssues` was ALSO in this list originally, but the legacy
// string[] wrapper it named was deleted at its source (RS002 W5
// whole-branch review — zero production callers repo-wide, dead since W2).

/**
 * Payment-integrity fix: `createRegistrationCheckout` overwrites
 * `registration_groups.checkout_session_id` every time it mints — nothing
 * expired the session it replaced, so a registrant who clicks "Pay now"
 * twice (an abandoned tab resumed, a reminder email re-minting the same
 * still-open session) leaves a SECOND live, payable Stripe session behind
 * for ~24h. Paying both is already handled (confirmPaidRegistration's
 * `kind: "duplicate"` auto-refund), but preventing the second charge is
 * better than reversing it days later.
 *
 * Design correction: this used to expire the prior session on ANY
 * INTERSECTION between its `registration_ids` and the ids being minted now —
 * wrong, because it also fires on a PARTIAL overlap and strands whatever the
 * prior session covered that the new mint doesn't. Concretely: session S1
 * covers {A,B}; entry A is promoted off the waitlist and S2 is minted for
 * {A} alone; the old intersection check expired S1 outright, so B lost its
 * only payable link and that money was never collected. The correct
 * predicate is SUBSUMPTION: expire the prior session only when the new
 * mint's id set is a superset of (or equal to) the prior session's own ids —
 * every entry the old session could still pay for is also payable through
 * the new one, so nothing is stranded.
 *
 * Must NOT fire for a DISJOINT (or partially-overlapping) prior session:
 * `registrationIds` is an explicit subset (a waitlist promotion pays one
 * entry while its siblings stay separately payable), but
 * `registration_groups` has only ONE `checkout_session_id` column shared by
 * the whole cart — so the "prior" session this reads back could belong to a
 * sibling entry's own, still-legitimate mint. Expired ONLY when BOTH: the
 * prior session is still `open` (a `complete` session is a paid session —
 * never touch it), AND its own `registration_ids` metadata is FULLY covered
 * by the ids being minted now (a prior session with no readable
 * `registration_ids` at all — foreign or malformed — can never be proven
 * covered, so it is left alone too).
 *
 * Best-effort, like every other Stripe side-call in this file: never blocks
 * minting the new session, never surfaces to the registrant.
 */
async function expireSupersededCheckoutSession(
  priorSessionId: string,
  newRegistrationIds: string[],
): Promise<void> {
  try {
    const prior = await getStripe().checkout.sessions.retrieve(priorSessionId);
    if (prior.status !== "open") return; // paid/expired/foreign — never touch it
    const priorIds = checkoutRegistrationIds(prior);
    // Subsumption, not intersection (see doc comment above): expire only
    // when EVERY id the prior session covered is also covered by the new
    // mint. `.every` on an empty array is vacuously true, so priorIds.length
    // is checked explicitly — an unreadable prior coverage set must never
    // read as "fully covered".
    if (priorIds.length === 0) return; // unreadable metadata — can't prove subsumption
    if (!priorIds.every((id) => newRegistrationIds.includes(id))) return; // partial/disjoint — a legitimate sibling session
    await getStripe().checkout.sessions.expire(priorSessionId);
    log.info(
      { priorSessionId, newRegistrationIds },
      "registration: expired a superseded checkout session on re-mint",
    );
  } catch (err) {
    log.error(
      { err, priorSessionId },
      "registration: failed to expire a superseded checkout session — the new session still mints",
    );
  }
}

/**
 * Runs a Checkout Session create and translates Stripe's `amount_too_small`
 * refusal into a clean 422 with a stable code. Every OTHER Stripe failure is
 * now sanitized into a generic 502 (RS007 review finding) instead of
 * rethrown untouched: v1()'s catch-all (http.ts) forwards a non-HttpError's
 * `.message` to the client verbatim, and a Stripe-authored message can name
 * the connected account, a session id, or another identifier that must never
 * reach a registrant (concrete leak: a disconnected/restricted Connect
 * account makes transfer_data.destination invalid below, and Stripe's
 * invalid-request message echoes the account id). Logged server-side at
 * error level before being replaced, so diagnosis stays possible while
 * nothing Stripe-authored is ever rendered.
 */
async function mintOrTranslate(
  create: () => Promise<Stripe.Checkout.Session>,
): Promise<Stripe.Checkout.Session> {
  try {
    return await create();
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "amount_too_small") {
      throw new HttpError(
        422,
        "This entry fee is below the minimum a card payment can charge",
        "REGISTRATION_AMOUNT_TOO_SMALL",
      );
    }
    log.error({ err }, "registration: checkout session create failed (Stripe)");
    throw new HttpError(502, "Stripe was unable to start this checkout — please try again shortly.");
  }
}

/**
 * ONE Stripe checkout session for a SET of a cart's entries (RS003 W3a,
 * owner ruling 1) — not necessarily the whole cart: a waitlist promotion
 * pays for a single entry while its siblings may already be paid, so the
 * unit this function takes is an explicit list of registration ids, always
 * scoped to one `groupId`. One line item per entry (kept the existing
 * per-entry product-name style); charged amount = sum of those entries'
 * `amount_cents`; `application_fee_amount` computed over that SAME sum.
 * Destination charge on the org's Connect account; the platform keeps
 * application_fee_amount (doc 16 §1.1). `token` builds the status-page
 * return URLs (now keyed by the GROUP, since a session can cover more than
 * one entry); null falls back to the token-free /r/[ref] pair (email-minted
 * sessions — the reminder can't recover the hashed token).
 *
 * Currency is validated BEFORE any Stripe call (owner ruling 4): the
 * group's snapshot must both be an allowlisted registration currency and
 * match the org's CURRENT currency (`ctx.currency`, read fresh by the
 * caller's `divisionCtx` call) — a snapshot gone stale since submit 422s
 * here, never as a Stripe-side error on a registrant's pay page.
 *
 * Greenfield conversion (owner ruling 3): this used to key its metadata by
 * one entry alone, singular-registration-id shaped, until this session;
 * there is no compat branch for that old shape — every caller now passes an
 * explicit id list, even when that list has exactly one element.
 */
async function createRegistrationCheckout(
  groupId: string,
  registrationIds: string[],
  ctx: DivisionCtx,
  origin: string,
  token: string | null,
): Promise<string> {
  const entries = await sql<RegistrationWithGroupRow[]>`
    select ${regGroupCols(sql)}
    from registrations r join registration_groups g on g.id = r.group_id
    where r.group_id = ${groupId} and r.id in ${sql(registrationIds)}
    order by r.created_at`;
  if (entries.length === 0) throw new HttpError(422, "No registrations to pay for");
  const firstEntry = entries[0]!;
  const subtotal = entries.reduce((sum, e) => sum + e.amount_cents, 0);
  if (subtotal <= 0) throw new HttpError(422, "This registration has no entry fee");
  // Owner ruling 4: validate the group's currency snapshot BEFORE any Stripe
  // call. Both conditions below share one machine-readable code — "this
  // cart cannot be charged in the currency it quoted right now" is one
  // failure class whether the snapshot was delisted or the org's currency
  // has since moved (same-currency lock pins it to the connected account's
  // settlement currency) — never a Stripe-side error on a registrant's pay
  // page. Every entry shares one currency (a group column), so the first
  // entry's is authoritative.
  if (!isRegistrationCurrency(firstEntry.currency)) {
    throw new HttpError(
      422,
      "This organiser no longer accepts payment in this cart's currency",
      "REGISTRATION_CURRENCY_UNAVAILABLE",
    );
  }
  if (firstEntry.currency !== ctx.currency) {
    throw new HttpError(
      422,
      "This organiser's currency has changed since this cart was created",
      "REGISTRATION_CURRENCY_UNAVAILABLE",
    );
  }
  const [org] = await sql<{ stripe_account_id: string | null }[]>`
    select stripe_account_id from organizations where id = ${ctx.org_id}`;
  if (!org?.stripe_account_id) {
    throw new HttpError(503, "Payments are not set up for this organiser yet");
  }
  // Bound to a const because the session params are now built inside a closure
  // (`mintOrTranslate`): TypeScript's narrowing from the guard above does not
  // survive into a callback, since it cannot prove `org` is not reassigned
  // meanwhile. Caught by `next build`'s type check, which runs the whole app —
  // not by the vitest suites, which never typecheck.
  const destination = org.stripe_account_id;
  const returnBase = token
    ? `${origin}/shared/${ctx.org_slug}/${ctx.comp_slug}/register/status` +
      `?rid=${groupId}&token=${encodeURIComponent(token)}`
    : `${origin}/r/${firstEntry.ref_code}?src=email`;
  // The rate this charge uses: the competition's locked rate if it has one,
  // otherwise the live plan rate. Resolved ONCE and both charged and frozen onto
  // the registration, so the paid transition can stamp the competition with the
  // exact percent this payer was billed — never a re-resolved one that a
  // mid-competition plan change could have moved.
  const feePercent = await effectiveFeePercentFor(ctx.competition_id, ctx.org_id);
  const idsJoined = registrationIds.join(",");
  // Stripe refuses a session whose total converts to less than its minimum
  // charge in the PLATFORM's currency (~30p on this GB platform). That is an
  // organiser misconfiguration — an entry fee set too low — but it lands here,
  // at the moment a registrant tries to pay, and an unmapped Stripe error on a
  // public pay page is precisely what owner ruling 4's currency check exists to
  // prevent. Found by the live per-currency probe: a 500+700 cart is £12.00 in
  // gbp but ₹12.00 in inr, which converts to about 9p and is rejected outright.
  // Mapped narrowly: only `amount_too_small` becomes a clean 422, so any other
  // Stripe failure still surfaces as itself rather than being swallowed.
  const session = await mintOrTranslate(() => getStripe().checkout.sessions.create({
    mode: "payment",
    customer_email: firstEntry.contact_email,
    // fee_percent rides the session so the paid transition can stamp the
    // competition with the rate THIS session was billed at — not
    // reg.fee_percent, which a later re-mint (resume, reminder) overwrites.
    // Without it, paying a stale still-open session after a plan change
    // would lock the competition at a rate no entrant was ever charged.
    //
    // Re-keyed to the GROUP (owner ruling 2): kind:"registration_group",
    // an explicit registration_ids list (comma-joined — Stripe metadata
    // values cap at 500 chars; a maximal 10-entry cart of 36-char uuids
    // joins to ~370, proven in registrations.test.ts) rather than a single
    // registration_id. Wave 3b's webhook rework reads this to flip exactly
    // the listed entries.
    //
    // destination_account rides the session the same way fee_percent does
    // (payment-integrity fix): the Connect account THIS charge's
    // transfer_data.destination is frozen to, right now, at mint time. If
    // the org reconnects a DIFFERENT account before this still-open session
    // is paid, fulfilment compares this stamped value against the org's
    // CURRENT stripe_account_id to detect the drift — see
    // checkDestinationAccountDrift below. A short value (an account id),
    // so it never threatens registration_ids' own near-budget cap above.
    metadata: {
      kind: "registration_group",
      registration_group_id: groupId,
      registration_ids: idsJoined,
      org_id: ctx.org_id,
      fee_percent: String(feePercent),
      destination_account: destination,
    },
    line_items: entries.map((reg) => ({
      quantity: 1,
      price_data: {
        currency: reg.currency,
        unit_amount: reg.amount_cents,
        product_data: { name: `${ctx.comp_name} — entry fee (${reg.display_name})` },
      },
    })),
    payment_intent_data: {
      application_fee_amount: applicationFeeCents(subtotal, feePercent),
      transfer_data: { destination },
      metadata: { registration_group_id: groupId, registration_ids: idsJoined, org_id: ctx.org_id },
    },
    success_url: `${returnBase}&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${returnBase}&checkout=cancelled`,
  }));
  if (!session.url) throw new HttpError(502, "Stripe did not return a checkout URL");
  // checkout_session_id/fee_percent live on the cart (V364) — one row to
  // stamp regardless of how many entries this session covers.
  //
  // Ordering fix: stamped BEFORE expiring the prior session below (used to
  // run the other way round). If this update throws (DB failover, statement
  // timeout, lock wait) the group must still name the OLD, still-open
  // session rather than one this call has already told Stripe to expire —
  // every reader (organiser console, reconcile-by-session, resume) would
  // otherwise be looking at a dead session with no live successor on
  // record.
  //
  // Concurrency fix: the update is conditional on `checkout_session_id`
  // still being the exact value THIS call observed before minting
  // (`firstEntry.checkout_session_id`, read at the top of this function).
  // Two concurrent calls for the same group (a double-clicked "Pay now", two
  // open tabs) each mint a real Stripe session before either commits;
  // without this guard neither would expire the other and the later
  // `update` would silently overwrite the earlier mint's stamp, leaving TWO
  // live, payable sessions — a real double-charge risk (the
  // `kind:"duplicate"` auto-refund path only reverses it after the fact).
  // `is not distinct from` treats a still-null prior value as a match,
  // unlike `=`, so this also protects a cart's very first mint. Deliberately
  // NOT a row lock held across the Stripe call above — serialising every
  // checkout mint on one row for the length of a network round-trip is worse
  // than the race it closes.
  const [stamped] = await sql<{ id: string }[]>`
    update registration_groups
    set checkout_session_id = ${session.id}, fee_percent = ${feePercent}, updated_at = now()
    where id = ${groupId}
      and checkout_session_id is not distinct from ${firstEntry.checkout_session_id}
    returning id`;
  if (!stamped) {
    // Lost the race: a concurrent mint already stamped a DIFFERENT session
    // in between this call's read and this update. Nobody has THIS
    // session's URL yet (it is only ever returned below), so it can't be
    // paid — best-effort expire it so it doesn't sit open on Stripe for
    // ~24h, then surface a clean, retryable error. The registrant's own
    // retry re-reads the now-current checkout_session_id and mints cleanly
    // against it.
    try {
      await getStripe().checkout.sessions.expire(session.id);
    } catch (err) {
      log.error(
        { err, sessionId: session.id, groupId },
        "registration: failed to expire our own session after losing the checkout re-mint race",
      );
    }
    throw new HttpError(
      409,
      "Another checkout was just started for this registration — please refresh and try again",
      "REGISTRATION_CHECKOUT_CONFLICT",
    );
  }
  // Payment-integrity fix: best-effort; never blocks the mint that already
  // committed above even if the expire attempt below fails.
  if (firstEntry.checkout_session_id) {
    await expireSupersededCheckoutSession(firstEntry.checkout_session_id, registrationIds);
  }
  return session.url;
}

/**
 * Mints the group's checkout session right after submit, when the cart has
 * at least one payable (`pending`, `amount_cents > 0`) entry priced through
 * Stripe. Called by the public register route so `submitRegistrationGroup`
 * itself (registration-submit.ts, RS002) stays payment-agnostic — it never
 * imports Stripe. Re-reads `payment_method` and the payable entry ids
 * straight from the DB rather than trusting the caller's copy of
 * `SubmitGroupResult` (which has no `payment_method` field at all — it
 * predates this session, when the submit path had no Stripe concern to
 * expose): this keeps "should this mint, and for which entries" logic in
 * exactly one place. Returns null, never throws, for a
 * zero-payable or non-stripe cart (owner ruling 5: an all-waitlisted,
 * all-free, or offline-payment-method group mints nothing) — it only
 * throws for a genuine failure (Connect not live, currency gone stale, a
 * real Stripe error).
 */
export async function mintGroupCheckout(
  groupId: string,
  divisionId: string,
  origin: string,
  token: string,
): Promise<string | null> {
  const [group] = await sql<{ payment_method: string | null }[]>`
    select payment_method from registration_groups where id = ${groupId}`;
  if (!group || group.payment_method !== "stripe") return null;
  const payable = await sql<{ id: string }[]>`
    select id from registrations
    where group_id = ${groupId} and status = 'pending' and amount_cents > 0
    order by created_at`;
  if (payable.length === 0) return null;
  const ctx = await divisionCtx(sql, divisionId);
  if (!ctx.charges_enabled) {
    throw new HttpError(503, "Payments are not set up for this organiser yet");
  }
  return createRegistrationCheckout(
    groupId,
    payable.map((r) => r.id),
    ctx,
    origin,
    token,
  );
}

// ---------------------------------------------------------------------------
// Payment completion (webhook + reconcile-on-return)
// ---------------------------------------------------------------------------

/**
 * checkout.session.completed for a registration (webhook path — reuses the
 * billing_events idempotency shell in the stripe route). Marks paid, then
 * confirms + materialises in one tx. Safe to re-run: paid/confirmed short-
 * circuit, entrant_id is set once.
 */
/** A group checkout session's comma-joined registration_ids metadata (W3a),
 *  parsed to a clean id list — a stray/foreign session with no such field
 *  becomes `[]`, never a false-positive single blank id. */
function checkoutRegistrationIds(session: Stripe.Checkout.Session): string[] {
  return (session.metadata?.registration_ids ?? "").split(",").filter(Boolean);
}

/**
 * Payment-integrity fix: `createRegistrationCheckout` freezes
 * `transfer_data.destination` from the org's `stripe_account_id` AT MINT
 * TIME (stamped onto `metadata.destination_account`, alongside
 * `fee_percent`, above). If the org reconnects a DIFFERENT Stripe account
 * before a still-open session is paid, Stripe has ALREADY routed the charge
 * to the frozen (now stale) destination by the time this webhook fires —
 * there is nothing left here to redirect, and `stripeRefund`'s
 * `reverse_transfer: true` would fail against an account this platform no
 * longer holds besides. Deliberately does NOT block, refund, or leave the
 * entry pending — the registrant paid in good faith and must not lose their
 * place over an organiser-side reconnect; this only records the drift for
 * the organiser console. Metadata absent (every session minted before this
 * change) means "cannot tell", and is always treated that way, never as a
 * mismatch — same fallback shape as `chargedFeePercent` below.
 *
 * Resolved off `regIds[0]` (already parsed by the caller via
 * `checkoutRegistrationIds`, always non-empty by the time this is called)
 * rather than `session.metadata.registration_group_id` — every entry named
 * in one session shares one group's org/competition, so any one of them is
 * enough, and this mirrors `handleRegistrationCheckoutAsyncPaymentFailed`'s
 * own registrations→divisions resolution below rather than adding a second,
 * parallel lookup path off a metadata field nothing else in this file reads.
 *
 * Review fixup (HIGH): the whole body is wrapped in try/catch, the same
 * shape as `expireSupersededCheckoutSession` above — a transient failure on
 * this function's OWN select or its OWN audit insert used to propagate out
 * of `handleRegistrationCheckoutCompleted` and abort the confirmPaidRegistration
 * loop that runs after it, contradicting this doc comment's own "does NOT
 * block, refund, or leave the entry pending". Telemetry must never be able
 * to break the path it observes.
 *
 * Review fixup (LOW): also idempotent against a redelivery. This function
 * can run more than once for the SAME session — `checkout.session.completed`
 * and `checkout.session.async_payment_succeeded` both dispatch through
 * `handleRegistrationCheckoutCompleted` (billing-events.ts), and Stripe's own
 * retry re-enters it whenever `billing_events.processed_at` stays null (a
 * later failure elsewhere in the same event, or Stripe's plain at-least-once
 * delivery). Unlike `confirmPaidRegistration`, this path is audit-only and
 * has no status column of its own to short-circuit on, so it checks the
 * ledger it writes to instead — the same "read state, then act" shape as
 * confirmPaidRegistration's status check and the late-refund path's
 * `refunded_cents` guard below, applied to the one thing an audit-only path
 * actually has: a matching row already on record for this exact session.
 */
async function checkDestinationAccountDrift(
  session: Stripe.Checkout.Session,
  regIds: string[],
  paymentIntentId: string | null,
): Promise<void> {
  try {
    const mintedDestination = session.metadata?.destination_account;
    if (!mintedDestination) return;
    const [row] = await sql<
      { org_id: string; competition_id: string; stripe_account_id: string | null }[]
    >`
      select r.org_id, d.competition_id, o.stripe_account_id
      from registrations r
      join divisions d on d.id = r.division_id
      join organizations o on o.id = r.org_id
      where r.id = ${regIds[0]!}`;
    if (!row || row.stripe_account_id === mintedDestination) return;
    const [already] = await sql<{ n: number }[]>`
      select 1 as n from competition_events
      where type = 'registration.destination_account_mismatch'
        and payload->>'checkout_session_id' = ${session.id}
      limit 1`;
    if (already) return; // redelivery of a drift already on record — silent no-op
    log.error(
      {
        registrationId: regIds[0],
        orgId: row.org_id,
        mintedDestination,
        currentDestination: row.stripe_account_id,
        sessionId: session.id,
        paymentIntentId,
      },
      "registration: destination account changed since checkout was minted — funds routed to the old account",
    );
    await audit(
      sql,
      row.competition_id,
      row.org_id,
      "registration.destination_account_mismatch",
      {
        checkout_session_id: session.id,
        payment_intent_id: paymentIntentId,
        minted_destination_account: mintedDestination,
        current_destination_account: row.stripe_account_id,
      },
      null,
    );
  } catch (err) {
    log.error(
      { err, sessionId: session.id, registrationId: regIds[0] },
      "registration: destination-account drift check failed — fulfilment continues",
    );
  }
}

/**
 * Fulfilment for a `registration_group` checkout session (RS003 W3b —
 * re-keyed from a single `registration_id` to the group's comma-joined
 * `registration_ids`, W3a's `createRegistrationCheckout`): every NAMED entry
 * is confirmed, never a sibling outside that list.
 *
 * The SINGLE gate on `payment_status` for this kind, deliberately, so none of
 * its three callers has to remember one: the `checkout.session.completed`
 * AND `checkout.session.async_payment_succeeded` dispatch branches
 * (billing-events.ts) both call straight through, and so do the two
 * reconcile-on-return paths below. Before this wave the dispatch branch had
 * NO gate at all — every sibling kind in that file already checked
 * `payment_status`, this one didn't — so a delayed-notification payment
 * method's `checkout.session.completed` (fired while still `unpaid`; the
 * success arrives later on `async_payment_succeeded` — Stripe skill,
 * "Webhooks and fulfillment") would have confirmed and materialised an
 * entrant before any money actually moved.
 *
 * `session.amount_total` is deliberately NOT forwarded to
 * `confirmPaidRegistration`, and that function no longer takes an amount at
 * all. `amount_total` is the CART's total across every named entry, so
 * feeding it in per-entry would smear the whole cart's sum onto each entry's
 * own `amount_cents` — and, worse, onto a late/duplicate refund, which reads
 * that same value. Each entry's own `amount_cents` is already exactly what
 * `createRegistrationCheckout` charged it, so it is the only correct source.
 *
 * The parameter was removed rather than passed `null`: this is its only
 * non-test caller, so every `amountTotal ?? …` fallback had an unreachable
 * non-null side, three of them in refund math. Left in place it reads like
 * "the amount actually charged" and invites precisely the smear above back.
 */
export async function handleRegistrationCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  if (session.payment_status !== "paid") return;
  const regIds = checkoutRegistrationIds(session);
  if (regIds.length === 0) return;
  const paymentIntent =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);
  // The rate THIS session was billed at (see createRegistrationCheckout). Absent
  // on sessions minted before V312 — the stamp falls back to reg.fee_percent.
  const raw = session.metadata?.fee_percent;
  const chargedFeePercent =
    raw != null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
  // Payment-integrity fix: detect (never block on) a Connect account that
  // changed since this session was minted. Session-scoped, so it runs once
  // per webhook, not once per named entry.
  await checkDestinationAccountDrift(session, regIds, paymentIntent);
  // Sequential, not Promise.all, and no per-id try/catch: each call is its
  // own locked transaction, so a failure partway through must abort the rest
  // and leave the WHOLE event unprocessed (billing_events.processed_at stays
  // null) for Stripe's retry — every entry already flipped is idempotent on
  // replay, but silently swallowing one entry's failure here would land the
  // event as "processed" while that one entry stays paid-for and unconfirmed
  // forever, with nothing left to retry it.
  for (const regId of regIds) {
    await confirmPaidRegistration(regId, paymentIntent, chargedFeePercent);
  }
}

/**
 * Delayed-notification counterpart of the handler above
 * (`checkout.session.async_payment_failed` — Stripe skill, "Webhooks and
 * fulfillment"): the payment that looked pending never landed.
 * `handleRegistrationCheckoutCompleted` never ran fulfilment for this session
 * (it gates on `payment_status`, and a failed session never reaches `paid`),
 * so there is nothing to undo — every named entry is left exactly where it
 * is, still `pending`, still payable. Only the failure is recorded, the same
 * "audit but do not act" shape as `registration.refund_failed` above.
 */
export async function handleRegistrationCheckoutAsyncPaymentFailed(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const regIds = checkoutRegistrationIds(session);
  if (regIds.length === 0) return;
  const rows = await sql<{ id: string; org_id: string; competition_id: string }[]>`
    select r.id, r.org_id, d.competition_id
    from registrations r join divisions d on d.id = r.division_id
    where r.id in ${sql(regIds)}`;
  for (const row of rows) {
    await audit(
      sql,
      row.competition_id,
      row.org_id,
      "registration.payment_failed",
      { registration_id: row.id, checkout_session_id: session.id },
      null,
    );
  }
}

type PayOutcome =
  | { kind: "confirmed"; divisionId: string; competitionId: string; orgId: string; entrantId: string }
  // RULING B (RS002 W5 review): a Stripe payment is the MACHINE, not the
  // organiser — on a manual-approval division it leaves the entry at 'paid'
  // and waits for a human (approveRegistration). Distinct from "confirmed"
  // so the growth-loop earn grants below (keyed on a genuine confirmation)
  // never fire for a payment still awaiting review.
  | { kind: "paid_awaiting_approval"; divisionId: string; competitionId: string }
  | { kind: "late" | "duplicate"; reg: RegistrationWithGroupRow; competitionId: string; intent: string }
  | null;

async function confirmPaidRegistration(
  regId: string,
  paymentIntentId: string | null,
  chargedFeePercent: number | null = null,
): Promise<void> {
  const outcome = (await sql.begin(async (tx) => {
    const [reg] = await tx<RegistrationWithGroupRow[]>`
      select ${regGroupCols(tx)}
      from registrations r join registration_groups g on g.id = r.group_id
      where r.id = ${regId} for update`;
    if (!reg) return null;
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    // Already paid/confirmed: a replay of the SAME session is a no-op, but a
    // DIFFERENT intent means the registrant paid twice (two open checkout
    // tabs, spec issue #2) — refund the duplicate, keep the original.
    if (reg.status === "confirmed" || reg.status === "paid") {
      // V387/H1: compare against THIS ENTRY's intent, never the cart's. The
      // cart column is last-writer-wins, so on a two-session cart (a promoted
      // sibling paying in its own session) it holds the SIBLING's intent by
      // the time a webhook for this entry replays — and this comparison would
      // then read a legitimate replay of PI_A as a duplicate and refund it.
      // Falls back to the cart column only when the entry has none recorded,
      // which is a pre-V387 row: same behaviour as before for those.
      const ownIntent = reg.entry_payment_intent_id ?? reg.payment_intent_id;
      if (paymentIntentId && ownIntent && paymentIntentId !== ownIntent) {
        return { kind: "duplicate", reg, competitionId: div.competition_id, intent: paymentIntentId };
      }
      return null;
    }
    // Money landing on a dead registration (withdrawn/expired/rejected, spec
    // issue #1 + RULING A, RS002 W5 review BLOCKER — the worst finding of
    // the session): record the intent for the audit trail and send it
    // straight back, NEVER confirm. A rejected reg with a live
    // payment_intent_id used to fall through to the branch below and be
    // silently confirmed — with an entrant materialised — on a late or
    // replayed webhook. Rejected reuses this exact path unchanged: refund,
    // never confirm, is precisely what "the organiser said no" requires.
    // payment_intent_id lives on the cart now (V364).
    //
    // REVIEW FIX (money-path defect #2): 'waitlisted' added to this list.
    // A promoted entry that misses its OWN promotion_expires_at window
    // lapses back to 'waitlisted' (V378/RS007's sweep lapse pass) — it is
    // exactly as dead as withdrawn/expired/rejected here: its slot has
    // already been re-offered to the next waitlist candidate by the time a
    // late/in-flight checkout completes. Without this, the payment silently
    // fell through to the branch below (status='paid', then materialised on
    // auto-approval) — an entrant seated in a slot the sweep had already
    // handed to someone else, and the late payer never refunded.
    //
    // Finding #18 (money-matrix S4, CRITICAL): 'withdrawn' is reachable two
    // structurally different ways, and reg.status alone cannot tell them
    // apart. (a) The row was NEVER paid/confirmed — it was cancelled before
    // any money moved, and a stale checkout now completes for a spot the
    // entrant never held; that is exactly what the branch below exists for
    // (refund in full, ignore refund_lock_at — the organiser never had a
    // seated entrant to keep the money for). (b) The row WAS confirmed —
    // materialise() already ran, an entrant was seated — and was withdrawn
    // AFTERWARDS: the ordinary post-lock cancellation refund_lock_at exists
    // to govern. Reaching this function again for case (b) is not a late
    // payment; it is a REPLAY of an already-fulfilled payment.
    // reconcileRegistrationGroupBySession (the status page's
    // reconcile-on-return, register/status/page.tsx) deliberately has no
    // status pre-check — a multi-entry cart can have a settled
    // representative sibling — so cancel-entry.tsx's router.refresh() right
    // after a successful withdrawal re-renders the SAME URL (same
    // ?checkout=success&session_id=... query string) and re-enters here
    // with the SAME session, which Stripe still happily reports as paid —
    // a refund never changes a Checkout Session's own payment_status.
    // Refunding again here would silently overrule withdrawCore's own
    // already-correct policy decision for this entry.
    //
    // Finding #18b (the residual gap #18 left open): #18 shipped this guard
    // keyed on `entrant_id` — which only answers "was this entry ever
    // SEATED". `entrant_id` is written by materialise(), and materialise()
    // only runs on the auto-approval path a few lines below (or once an
    // organiser later approves it). On a MANUAL-approval division, RULING B
    // (above) stops confirmPaidRegistration's own auto-approval branch
    // short: the entry sits at status = 'paid', a REAL charge already on
    // it, entrant_id still null, awaiting the organiser's decision. If it
    // is withdrawn from there — refund_lock_at long past, withdrawCore
    // correctly declines to refund (its own `locked.status === 'paid'`
    // branch already treats 'paid' as "genuinely charged") — the identical
    // reconcile replay #18 pinned reads entrant_id null and falls straight
    // through to the unconditional refund below. Same bug, narrower
    // population (manual-approval divisions only), same money leaving past
    // the lock.
    //
    // `charged_at` (added alongside this fix) answers the question this
    // branch actually needs answered — "did a live charge exist for THIS
    // entry before it was withdrawn" — directly, for both approval modes:
    // it is stamped in the SAME statement that writes `status = 'paid'`,
    // before the manual/auto fork, so a manual-approval entry gets it exactly
    // as reliably as an auto-approval one. `entrant_id` is a strict subset
    // (every row materialise() ever touches was charged_at-stamped first, in
    // the same earlier statement of this same function), so this replaces
    // rather than supplements it — one durable signal, not two overlapping
    // ones. Like entrant_id, nothing ever clears it: withdrawCore only
    // flips the linked ENTRANT row's own status (if one was ever
    // materialised), never registrations.charged_at.
    //
    // Scoped to 'withdrawn' alone, by construction (the condition above
    // only matches that one status) — 'expired'/'rejected'/'waitlisted'
    // fall through to the unconditional refund below completely unchanged,
    // regardless of charged_at. That is correct independent of this guard:
    // only withdrawCore can ever act on an already-'paid'/'confirmed' row,
    // and nothing else in this branch reaches it. 'expired'/'waitlisted'
    // only ever fire from a still-'pending' row (sweepRegistrations' own
    // `locked.status !== "pending"` guards on both its expiry and lapse
    // passes) — charged_at would be null there regardless. 'rejected' is
    // reachable from 'paid' too (rejectRegistration explicitly allows it,
    // RULING B's declined counterpart), but rejectRegistration refunds a
    // paid entry directly, in its own call, and never writes 'withdrawn' —
    // so a rejected row never reaches this guard at all, whatever
    // charged_at holds.
    if (reg.status === "withdrawn" && reg.charged_at) {
      // PR #677 finding H2. Returning null unconditionally kept a genuinely
      // DUPLICATE charge: two open tabs, S1 pays and the entry is confirmed,
      // the entry is withdrawn past the refund lock (correctly unrefunded),
      // then S2 completes with a different intent — money neither refunded,
      // nor recorded, nor audited.
      //
      // Symmetric with the paid/confirmed branch above rather than the fix
      // first proposed in review (`&& paymentIntentId === reg.payment_intent_id`),
      // which would let a differing intent fall through to the `late` branch
      // below — and that branch refunds `reg.payment_intent_id ?? paymentIntentId`,
      // i.e. the FIRST intent. It would have refunded the original charge,
      // the one this guard exists to let the organiser keep, and still left
      // the duplicate sitting there.
      const ownIntent = reg.entry_payment_intent_id ?? reg.payment_intent_id;
      if (paymentIntentId && ownIntent && paymentIntentId !== ownIntent) {
        return { kind: "duplicate", reg, competitionId: div.competition_id, intent: paymentIntentId };
      }
      return null;
    }
    if (
      reg.status === "withdrawn" ||
      reg.status === "expired" ||
      reg.status === "rejected" ||
      reg.status === "waitlisted"
    ) {
      await tx`update registration_groups
               set payment_intent_id = coalesce(payment_intent_id, ${paymentIntentId}),
                   updated_at = now()
               where id = ${reg.group_id}`;
      if (!paymentIntentId && !reg.payment_intent_id) return null;
      return {
        kind: "late",
        reg,
        competitionId: div.competition_id,
        intent: (reg.payment_intent_id ?? paymentIntentId) as string,
      };
    }
    const settings = await loadSettings(tx, reg.division_id);
    // Finding #18b: charged_at is stamped HERE, unconditionally, before the
    // manual/auto approval fork below — the moment money actually lands for
    // this entry, regardless of whether materialise() ever runs for it.
    // `coalesce` makes it idempotent, the same convention entrant_id already
    // relies on being written exactly once.
    await tx`
      update registrations
      set status = 'paid',
          charged_at = coalesce(charged_at, now()),
          payment_intent_id = coalesce(payment_intent_id, ${paymentIntentId}),
          updated_at = now()
      where id = ${regId}`;
    // payment_intent_id lives on the cart now (V364).
    await tx`
      update registration_groups
      set payment_intent_id = coalesce(${paymentIntentId}, payment_intent_id),
          updated_at = now()
      where id = ${reg.group_id}`;
    // Lock the competition's fee rate on its FIRST paid entry (V312), from the
    // rate the PAID SESSION was billed at — not reg.fee_percent, which a later
    // re-mint overwrites, so paying a stale session after a plan change would
    // otherwise lock a rate no entrant was charged. reg.fee_percent is the
    // fallback only for sessions minted before the rate rode the metadata.
    // `is null` makes it first-wins and idempotent: a replay, or a second
    // concurrent payment, cannot move a rate already set. Offline entries carry
    // no rate and leave the competition unlocked for the first card payer.
    const lockRate = chargedFeePercent ?? reg.fee_percent;
    if (lockRate != null) {
      await tx`
        update competitions set fee_percent = ${lockRate}
         where id = ${div.competition_id} and fee_percent is null`;
    }
    // RULING B (RS002 W5 review): manual approval blocks the AUTOMATIC
    // confirmation a Stripe payment would otherwise trigger here — the
    // entry is already 'paid' (written above) and stays there for a human
    // to review via approveRegistration. Organiser-explicit paths
    // (confirmRegistration/markRegistrationPaidOffline/confirmRegistrationWaived)
    // are UNCHANGED by this ruling: an organiser clicking confirm IS the
    // approval decision. A dedicated one-column query rather than widening
    // `loadSettings`/`RegistrationSettingsRow` (this wave's ownership keeps
    // those export-only) — same "local superset, don't touch the shared
    // type" precedent as registration-submit.ts's SubmitSettingsRow and
    // registration-approval.ts's ApprovalSettingsRow.
    const [approvalRow] = await tx<{ approval: "auto" | "manual" }[]>`
      select approval from registration_settings where division_id = ${reg.division_id}`;
    if (approvalRow?.approval === "manual") {
      await audit(tx, div.competition_id, reg.org_id, "registration.paid_awaiting_approval", {
        registration_id: regId,
        amount_cents: reg.amount_cents,
      }, null);
      return {
        kind: "paid_awaiting_approval",
        divisionId: reg.division_id,
        competitionId: div.competition_id,
      };
    }
    const entrantId = await materialise(
      tx,
      { ...reg, status: "paid" },
      settings?.entrant_kind ?? "individual",
    );
    await audit(tx, div.competition_id, reg.org_id, "registration.confirmed", {
      registration_id: regId,
      entrant_id: entrantId,
      paid: true,
      amount_cents: reg.amount_cents,
    }, null);
    return {
      kind: "confirmed",
      divisionId: reg.division_id,
      competitionId: div.competition_id,
      orgId: reg.org_id,
      entrantId,
    };
  })) as unknown as PayOutcome;

  if (!outcome) return;
  if (outcome.kind === "paid_awaiting_approval") {
    // Public status page changed (pending -> paid), so still revalidate —
    // but no growth-loop earn grant: money moved, but nothing is confirmed
    // yet, and a manual reviewer can still reject it next.
    fireDivisionRevalidate(outcome.divisionId, outcome.competitionId);
    return;
  }
  if (outcome.kind === "confirmed") {
    log.info(
      { registrationId: regId, orgId: outcome.orgId, divisionId: outcome.divisionId },
      "registration: checkout confirmed",
    );
    fireDivisionRevalidate(outcome.divisionId, outcome.competitionId);
    // RS008: fire-and-forget, strictly AFTER the transaction above has
    // committed — see confirmRegistration's identical wiring for why.
    void inviteUnclaimedMembers(outcome.orgId, outcome.entrantId);
    // Growth loop (SPEC-5 §2 C): the organiser's FIRST competition to take a paid
    // registration earns free AI credits. Fires only on a genuine first-time paid
    // CONFIRMATION (not a replay, a double-pay duplicate, or a late payment to a
    // withdrawn/expired reg that gets refunded), so the org's once-per-earn grant
    // is never spent on a payment that bounced back. Keyed once-per-ORG
    // (`earn:first_paid:${orgId}`) — every later paid registration no-ops on the
    // idempotency key. Best-effort (tryEarnGrant never throws) so a grant hiccup
    // never blocks the webhook ACK; orgId is the ORGANISER (reg.org_id mirrors the
    // division's/competition's org), not the registrant.
    await tryEarnGrant(outcome.orgId, "first_paid", FIRST_PAID_EARN);
    // Growth loop (SPEC-5 §2): if THIS org was itself referred, its first paid
    // competition earns the REFERRER credits. Keyed on the referred org
    // (ref = outcome.orgId) → once per referred org; a later paid comp no-ops.
    // Grantee/wallet = the referrer; the referrer's lifetime cap bounds a prolific
    // referrer. Self-referral was blocked when referred_by_org_id was stamped (T2),
    // so no self-check needed. Best-effort — never block the webhook ACK.
    try {
      const [refRow] = await sql<{ referred_by_org_id: string | null }[]>`
        select referred_by_org_id from organizations where id = ${outcome.orgId}`;
      const referrerOrgId = refRow?.referred_by_org_id ?? null;
      if (referrerOrgId) {
        const referrerWallet = await walletIdFor(referrerOrgId);
        await recordEarnGrant(referrerWallet, referrerOrgId, "referral", outcome.orgId, REFERRAL_EARN);
      }
    } catch (err) {
      log.error({ err, orgId: outcome.orgId }, "credits: referral grant failed for referrer");
    }
    return;
  }
  // Refunds happen OUTSIDE the tx (network). A failure surfaces on the
  // organiser console via the audit trail, never blocks the webhook ACK.
  try {
    // RS002 (V368): refund exactly THIS entry's own charged amount, never the
    // cart's whole remaining balance — a sibling entry's money must never
    // move on a late/duplicate refund for this one (block comment above
    // RegistrationWithGroupRow, hazard 1).
    const entryRefundCents = outcome.reg.amount_cents;
    // Webhook redelivery guard (review fixup): Stripe delivers "at least
    // once", so the SAME stale checkout session can complete more than once
    // for a withdrawn/expired registration. withdrawCore avoids a double
    // refund by flipping status inside the locked tx before its refund
    // block; this path enters ALREADY withdrawn/expired, so it checks the
    // entry's own refunded_cents instead — a redelivery is then a silent
    // no-op rather than a second real Stripe refund (nothing enforced that
    // before; relying on Stripe to reject an over-refund is not guaranteed
    // once a partial refund or dispute has left headroom on the intent).
    if (outcome.kind === "late" && outcome.reg.refunded_cents >= outcome.reg.amount_cents) {
      return;
    }
    const refund = await stripeRefund(outcome.intent, entryRefundCents);
    if (outcome.kind === "late") {
      // Additive on BOTH tables (hazard 2 fixed), in ONE transaction (review
      // fixup — these were two separate autocommit statements; if the
      // second failed after the first committed, Stripe would already have
      // refunded the money while the entry and cart totals silently
      // diverged, and the whole attempt would still land in the catch below
      // as `refund_failed` — a misleading audit trail for a refund that
      // actually succeeded).
      await sql.begin(async (tx) => {
        await tx`
          update registrations
          set refunded_cents = refunded_cents + ${entryRefundCents}, updated_at = now()
          where id = ${outcome.reg.id}`;
        await tx`
          update registration_groups
          set refunded_cents = refunded_cents + ${entryRefundCents},
              refunded_at = now(), updated_at = now()
          where id = ${outcome.reg.group_id}`;
      });
    }
    await audit(sql, outcome.competitionId, outcome.reg.org_id, "registration.refunded", {
      registration_id: regId,
      amount_cents: outcome.reg.amount_cents,
      mode: outcome.kind === "late" ? "late_payment" : "duplicate",
      stripe_refund_id: refund.id,
    }, null);
    const ctxLate = await divisionCtx(sql, outcome.reg.division_id);
    notifyRefund(outcome.reg, ctxLate, outcome.reg.amount_cents);
  } catch (err) {
    await audit(sql, outcome.competitionId, outcome.reg.org_id, "registration.refund_failed", {
      registration_id: regId,
      mode: outcome.kind,
    }, null);
    await maybeAlertRegistrationRefundFailed({
      registrationId: regId,
      orgId: outcome.reg.org_id,
      competitionId: outcome.competitionId,
      amountCents: outcome.reg.amount_cents,
      currency: outcome.reg.currency,
      paymentIntentId: outcome.intent,
      reason: errText(err),
    });
  }
}

/**
 * Dispute lifecycle (spec issue #5 — destination charges make the PLATFORM
 * liable): `created` flags the registration + alerts the org owner; `closed`
 * either clears the flag (won) or writes the money off (lost). No automatic
 * entrant changes — contested entries are the organiser's call.
 */
export async function handleRegistrationDispute(
  dispute: Stripe.Dispute,
  phase: "created" | "closed",
): Promise<boolean> {
  const intent =
    typeof dispute.payment_intent === "string"
      ? dispute.payment_intent
      : dispute.payment_intent?.id;
  if (!intent) return false;
  // payment_intent_id lives on the cart now (V364).
  const [reg] = await sql<RegistrationWithGroupRow[]>`
    select ${regGroupCols(sql)}
    from registrations r join registration_groups g on g.id = r.group_id
    where g.payment_intent_id = ${intent}
    order by r.created_at, r.id limit 1`;
  if (!reg) return false; // not an entry-fee charge (or intent not written yet)
  const ctx = await divisionCtx(sql, reg.division_id);

  if (phase === "created") {
    // disputed_at/dispute_id live on the cart now (V364).
    await sql`update registration_groups
              set disputed_at = now(), dispute_id = ${dispute.id}, updated_at = now()
              where id = ${reg.group_id}`;
    await audit(sql, ctx.competition_id, reg.org_id, "registration.disputed", {
      registration_id: reg.id,
      dispute_id: dispute.id,
      amount_cents: dispute.amount,
    }, null);
    const owner = await currentOwnerEmail(reg.org_id);
    if (owner) {
      void sendDisputeAlertEmail({
        to: owner,
        orgName: ctx.org_name,
        competitionName: ctx.comp_name,
        displayName: reg.display_name,
        amountCents: dispute.amount,
        currency: reg.currency,
        refCode: reg.ref_code,
      }).catch(() => {});
    }
    return true;
  }
  if (dispute.status === "won") {
    await sql`update registration_groups set disputed_at = null, updated_at = now()
              where id = ${reg.group_id}`;
    await audit(sql, ctx.competition_id, reg.org_id, "registration.dispute_won", {
      registration_id: reg.id,
      dispute_id: dispute.id,
    }, null);
  } else if (dispute.status === "lost") {
    // The write-off must land whatever Stripe does next — same contract as
    // refund failure never undoing a withdrawal. refunded_cents/refunded_at
    // live on the cart now (V364). Cart-scoped by design (review fixup —
    // this used to read `reg.amount_cents`, the EARLIEST entry sharing the
    // intent, and flat-overwrite with it: a fourth, unlisted site of hazard
    // 2's class, wrong on two counts — wrong source value once a cart holds
    // more than one entry, AND non-monotonic like the other three sites).
    // `dispute.amount` is the actual disputed amount — already used the same
    // way in the "created" phase's audit above (line ~1386) — and `greatest`
    // matches syncRegistrationRefund's mirror: never regress what an
    // entry-level refund may already have recorded.
    await sql`update registration_groups
              set refunded_cents = greatest(refunded_cents, ${dispute.amount}),
                  refunded_at = coalesce(refunded_at, now()), updated_at = now()
              where id = ${reg.group_id}`;
    await audit(sql, ctx.competition_id, reg.org_id, "registration.dispute_lost", {
      registration_id: reg.id,
      dispute_id: dispute.id,
    }, null);
    const recovery = await recoverDisputedTransfer(dispute, reg, ctx);
    // `already` = a replayed close (metadata guard hit) — everything below
    // already happened on the first run.
    if (!recovery.already) {
      const owner = await currentOwnerEmail(reg.org_id);
      if (owner) {
        void sendDisputeLostEmail({
          to: owner,
          orgName: ctx.org_name,
          competitionName: ctx.comp_name,
          displayName: reg.display_name,
          amountCents: dispute.amount,
          currency: reg.currency,
          refCode: reg.ref_code,
          recoveredCents: recovery.recoveredCents,
          // divisionRegistrations route deleted (RS001 demolition) —
          // point at the competition page for now; RS004's hub re-points
          // this at the new competition-level Registration hub.
          consoleUrl: fallbackOrigin() + routes.competition(ctx.org_slug, ctx.comp_slug),
        }).catch(() => {});
      }
    }
  }
  return true;
}

/** Current owner via org_members, NOT organizations.created_by — ownership
 *  transfers flip the role but leave created_by on the original creator. */
async function currentOwnerEmail(orgId: string): Promise<string | null> {
  const [owner] = await sql<{ email: string }[]>`
    select u.email from org_members m join users u on u.id = m.user_id
    where m.org_id = ${orgId} and m.role = 'owner' limit 1`;
  return owner?.email ?? null;
}

/**
 * PROMPT-55: on a LOST entry-fee dispute, pull the club's net back off its
 * connected balance so the platform's loss is Stripe's dispute fee only.
 *
 * Thin registration-flavoured wrapper over the shared dispute-recovery core
 * (dispute-recovery.ts, payments-hardening Task 5): all the charge→transfer→
 * reversal mechanics + replay guard live in the core; this builds the audit
 * closure that namespaces the ledger event under `registration.` and folds in
 * registration_id/dispute_id/org context, and tags the reversal with
 * registration_id. Behaviour is unchanged from the pre-extraction inline
 * version — see the core's doc comment for the transfer/reversal economics.
 *
 * Never throws: recovery failure is audited and must not block the webhook
 * ACK or the write-off above. Stripe calls stay OUTSIDE any sql tx.
 */
async function recoverDisputedTransfer(
  dispute: Stripe.Dispute,
  reg: RegistrationRow,
  ctx: DivisionCtx,
): Promise<{ recoveredCents: number; already: boolean }> {
  return recoverDisputedTransferCore(dispute, {
    auditNote: (type, extra) =>
      audit(sql, ctx.competition_id, reg.org_id, `registration.${type}`, {
        registration_id: reg.id,
        dispute_id: dispute.id,
        ...extra,
      }, null),
    reversalMetadata: { registration_id: reg.id },
  });
}

/** Mirror refunds made outside the app (Stripe dashboard) so the console
 *  never shows money we no longer hold. Monotonic — never regresses. */
export async function syncRegistrationRefund(charge: Stripe.Charge): Promise<void> {
  const intent =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id;
  if (!intent) return;
  // The whole payment envelope (payment_intent_id, refunded_cents,
  // refunded_at) lives on registration_groups now (V364).
  await sql`
    update registration_groups
    set refunded_cents = greatest(refunded_cents, ${charge.amount_refunded}),
        refunded_at = coalesce(refunded_at, now()), updated_at = now()
    where payment_intent_id = ${intent}`;
}

/**
 * Reconcile-on-return (billing.ts pattern): the status page calls this so a
 * paid registration confirms even when the webhook is delayed or missing
 * (local dev). Best-effort; never throws.
 */
export async function reconcileRegistration(regId: string, token: string): Promise<boolean> {
  try {
    // access_token_hash/checkout_session_id live on the cart now (V364).
    const [reg] = await sql<{ status: string; checkout_session_id: string | null }[]>`
      select r.status, g.checkout_session_id
      from registrations r join registration_groups g on g.id = r.group_id
      where r.id = ${regId} and g.access_token_hash = ${hashRegistrationToken(token)}`;
    if (!reg || reg.status !== "pending" || !reg.checkout_session_id) return false;
    const session = await getStripe().checkout.sessions.retrieve(reg.checkout_session_id);
    if (session.payment_status !== "paid") return false;
    // Re-keyed to the GROUP (W3b): the session may cover a whole cart now —
    // membership in registration_ids, not equality on the old singular key.
    if (!checkoutRegistrationIds(session).includes(regId)) return false;
    await handleRegistrationCheckoutCompleted(session);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile-on-return for the token-free /r/[ref] flow (email-minted sessions,
 * spec T6): the session's own metadata must point at the ref's registration —
 * the ref is a lookup, the session is the proof. Best-effort; never throws.
 *
 * Security fix: `sessionId` is attacker-controlled (an unauthenticated,
 * `force-dynamic` GET query param on a public page) — the old code called
 * `sessions.retrieve(sessionId)` on that raw value before any binding check,
 * so anyone holding a ref whose oldest entry is `pending` could loop
 * `GET /r/{ref}?session_id=cs_test_anything` and drive one real Stripe API
 * call per request, billed to the PLATFORM account and counting against its
 * rate limits. Fixed by comparing the supplied id against
 * `registration_groups.checkout_session_id` — the session THIS cart's own
 * mint actually stamped — BEFORE calling Stripe at all. An id that isn't the
 * cart's current session now never reaches `sessions.retrieve`; the
 * `payment_status`/`registration_ids` checks below are unchanged for the one
 * id that does match.
 *
 * Known trade-off, accepted: if a NEWER session has since superseded the
 * stored id (a later re-mint), an older-but-legitimate `session_id` from
 * Stripe's own success redirect no longer reconciles here. The webhook
 * remains the primary fulfilment path and still covers it — do not add a
 * fallback that re-introduces the arbitrary retrieve to recover this case.
 */
export async function reconcileRegistrationBySession(
  ref: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const reg = await regByRef(ref);
    if (reg.status !== "pending") return false;
    if (sessionId !== reg.checkout_session_id) return false;
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") return false;
    // Re-keyed to the GROUP (W3b): the session may cover a whole cart now —
    // membership in registration_ids, not equality on the old singular key.
    if (!checkoutRegistrationIds(session).includes(reg.id)) return false;
    await handleRegistrationCheckoutCompleted(session);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile-on-return for the rid+token status page (RS007) — the group-id
 * sibling of `reconcileRegistrationBySession` above. That function resolves
 * its group via `ref_code`, which is nullable (a submit whose ref-mint
 * retries were exhausted still commits the cart) — exactly the case
 * `groupById`'s own doc comment says THIS page exists to still serve, so
 * reconciling here cannot depend on a ref existing either. Keyed on the
 * group's DB id + the emailed access token instead, matching `groupById`'s
 * own lookup exactly.
 *
 * Same security posture as the ref-based sibling: the caller-supplied
 * `sessionId` is compared against the group's OWN stored
 * `checkout_session_id` BEFORE any Stripe call, closing the identical
 * arbitrary-retrieve hole that function's doc comment describes.
 *
 * Deliberately has NO "is some representative entry still pending" pre-check
 * — `handleRegistrationCheckoutCompleted` already re-derives everything from
 * the session's own `registration_ids` metadata and confirms each named
 * entry independently (`confirmPaidRegistration`'s own row-locked status
 * check), so such a gate would only be an optimisation, and the wrong one
 * for a multi-entry cart: a promotion mints a checkout for a SINGLE entry
 * (V378), so picking one arbitrary sibling to gate on could refuse to even
 * look at Stripe for a session that is genuinely paid. Best-effort; never
 * throws.
 *
 * RS007 follow-up: this is the ONLY reconcile path with no self-limit at
 * all — `reconcileRegistration`/`reconcileRegistrationBySession` both gate
 * on `status !== "pending"` before ever calling Stripe, but that exact gate
 * is wrong HERE (see the paragraph above), so this is rate-limited instead,
 * keyed on the group. The status page calls this on every qualifying GET
 * (`?checkout=success&session_id=...`), and that URL sits in browser
 * history and referrers — without a limiter, one repeat visit (or a leaked
 * link) is unbounded outbound amplification, one `checkout.sessions.retrieve`
 * per hit, against the platform's own Stripe read limit. A throttled call
 * folds into the same `false` every other early-return here already means
 * ("could not reconcile just now") — the caller discards the return value
 * either way and simply falls through to reading the group's current DB
 * state, so this never surfaces to the registrant.
 */
export async function reconcileRegistrationGroupBySession(
  groupId: string,
  token: string,
  sessionId: string,
): Promise<boolean> {
  try {
    if (!GROUP_ID_RE.test(groupId)) return false;
    await rateLimit(`reg-reconcile:${groupId}`, { max: 5, windowSeconds: 60 });
    const [group] = await sql<
      Pick<RegistrationGroupRow, "access_token_hash" | "checkout_session_id">[]
    >`
      select access_token_hash, checkout_session_id
      from registration_groups where id = ${groupId}`;
    if (!group || !tokenMatchesHash(token, group.access_token_hash)) return false;
    if (sessionId !== group.checkout_session_id) return false;
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") return false;
    await handleRegistrationCheckoutCompleted(session);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public: status / withdraw / resume payment (token-gated)
// ---------------------------------------------------------------------------

export interface PublicStatusView {
  id: string;
  status: string;
  /** Quotable reference (v3/05 §3); null on pre-v2 rows. */
  ref_code: string | null;
  display_name: string;
  division_name: string;
  competition_name: string;
  competition_slug: string;
  org_slug: string;
  org_name: string;
  starts_on: string | null;
  ends_on: string | null;
  fee_cents: number;
  amount_cents: number;
  currency: string | null;
  refunded_cents: number;
  payment_due: boolean;
  /** How this entry pays (snapshot; spec §3). */
  payment_method: "offline" | "stripe" | null;
  /** Card pendings: the pay-by deadline (spec §2). */
  expires_at: string | null;
  /** Pay CTA gate: card pending + fee due + Connect live. */
  can_pay_online: boolean;
  payment_instructions: string | null;
  /** 1-based place in the waitlist queue; null unless waitlisted (PROMPT-52). */
  position: number | null;
  created_at: string;
}

async function regByToken(regId: string, token: string): Promise<RegistrationWithGroupRow> {
  // access_token_hash lives on the cart now (V364).
  const [reg] = await sql<RegistrationWithGroupRow[]>`
    select ${regGroupCols(sql)}
    from registrations r join registration_groups g on g.id = r.group_id
    where r.id = ${regId} and g.access_token_hash = ${hashRegistrationToken(token)}`;
  if (!reg) throw new HttpError(404, "registration not found");
  return reg;
}

export async function publicRegistrationStatus(
  regId: string,
  token: string,
): Promise<PublicStatusView> {
  const reg = await regByToken(regId, token);
  const ctx = await divisionCtx(sql, reg.division_id);
  const settings = await loadSettings(sql, reg.division_id);
  const [div] = await sql<{ name: string; youth: boolean; player_name_display: string | null }[]>`
    select name, youth, player_name_display from divisions where id = ${reg.division_id}`;
  // RS008 review fix #3 — bring this to parity with its sibling
  // publicRegistrationStatusByRef, which has had both the youth AND consent
  // axes since RS008: display_name is a PERSON's name for individual/pair,
  // but a TEAM's own declared name for team — no personal consent applies
  // there (public.ts/public_entrants_v precedent, established throughout
  // this session).
  // Post-merge review fix (2026-08-30, free-agent gap): entrant_kind ===
  // "team" at the DIVISION level also covers a FREE AGENT — design's own
  // "one unassigned person, not a named team" case (registration-submit.ts's
  // entryDisplayName treats `entrant_kind === "team" && !free_agent` as the
  // actual team branch; a free agent falls through to the solo player's own
  // name, same as individual). Nothing stops a division from being BOTH
  // youth AND allow_free_agents (the only rule is "allow_free_agents
  // requires entrant_kind 'team'") — without the `!reg.free_agent` guard, a
  // solo minor's free-agent entry rode the team bypass below and printed
  // their real name unmasked.
  const isTeam = (settings?.entrant_kind ?? "individual") === "team" && !reg.free_agent;
  const optedOut = isTeam ? new Set<string>() : await anyOptedOutByRegistration(sql, [reg.id]);
  // Code-review fix (2026-08-30, item 2): `isTeam` above only ever bypassed
  // the CONSENT axis (optedOut stays empty for a team) — resolvePersonDisplayName
  // was still being CALLED for a team's own display_name, and the YOUTH axis
  // lives INSIDE that function, not in the isTeam guard around it. A team on
  // a youth division still fell into maskDisplayName via the youth branch,
  // e.g. "Thunder Strikers" -> "Thunder S.", even though a team's own
  // declared name carries no personal-consent OR safeguarding meaning at
  // all. Bypass the resolver call itself for a team, same as every other
  // already-correct site (maskPublicEntrantNames, public.ts's publicEntrants).
  const displayName = isTeam
    ? reg.display_name
    : resolvePersonDisplayName(
        reg.display_name,
        optedOut.has(reg.id) ? { public_name: false } : null,
        div?.player_name_display ?? null,
        div?.youth ?? false,
      );
  // Amount due follows the SNAPSHOT (reg row), not live settings — fee edits
  // never change what an in-flight registrant owes (spec issue #8).
  const paymentDue = reg.status === "pending" && reg.amount_cents > 0;
  const offline = reg.payment_method !== "stripe";
  // Queue position (PROMPT-52): created_at-then-id order — identical to the
  // oldest-first order auto-promotion consumes, so "#N" never lies.
  // The row's own created_at is read back in SQL (not passed from JS): a JS
  // Date truncates to ms while timestamptz keeps µs, and the tuple compare
  // would then exclude the row itself.
  const [posRow] = reg.status === "waitlisted"
    ? await sql<{ position: number }[]>`
        select count(*)::int as position from registrations r
        where r.division_id = ${reg.division_id} and r.status = 'waitlisted'
          and (r.created_at, r.id) <=
              (select created_at, id from registrations where id = ${reg.id})`
    : [];
  return {
    id: reg.id,
    status: reg.status,
    ref_code: reg.ref_code,
    display_name: displayName,
    division_name: div?.name ?? "",
    competition_name: ctx.comp_name,
    competition_slug: ctx.comp_slug,
    org_slug: ctx.org_slug,
    org_name: ctx.org_name,
    starts_on: ctx.starts_on,
    ends_on: ctx.ends_on,
    fee_cents: settings?.fee_cents ?? 0,
    amount_cents: reg.amount_cents,
    currency: reg.currency,
    refunded_cents: reg.refunded_cents,
    payment_due: paymentDue,
    payment_method: reg.payment_method,
    expires_at: reg.expires_at ? new Date(reg.expires_at).toISOString() : null,
    can_pay_online: paymentDue && !offline && ctx.charges_enabled,
    payment_instructions:
      paymentDue && offline
        ? (settings?.payment_instructions ?? ctx.payment_instructions)
        : null,
    position: posRow?.position ?? null,
    created_at: new Date(reg.created_at).toISOString(),
  };
}

/** Registrant withdraw (token). Frees the spot, auto-promotes the oldest
 *  waitlisted, auto-refunds before refund_lock_at (doc 16 §1.1). */
export async function withdrawRegistrationPublic(
  regId: string,
  token: string,
): Promise<PublicStatusView> {
  const reg = await regByToken(regId, token);
  await withdrawCore(reg, null);
  return publicRegistrationStatus(regId, token);
}

// ---------------------------------------------------------------------------
// Reference-number lookups — /r/[ref] (v3/05 §3, PROMPT-34)
// ---------------------------------------------------------------------------

/** What /r/[ref] shows the world: never more than the success screen, and
 *  the name honours the division's public name display (v3/11 gap 8). */
export interface PublicRefView {
  ref_code: string;
  status: string;
  display_name: string;
  division_name: string;
  division_slug: string;
  competition_name: string;
  competition_slug: string;
  org_slug: string;
  org_name: string;
  starts_on: string | null;
  ends_on: string | null;
  created_at: string;
  /** True when the ?token= the viewer presented matches — unlocks withdraw. */
  can_withdraw: boolean;
}

async function regByRef(ref: string): Promise<RegistrationWithGroupRow> {
  // Checksum rejects typos before the DB sees them; normalise dashes/case so
  // "sz abcd efgh" read over a phone still resolves.
  const canonical = normalizeRefCode(ref);
  if (!isValidRefCode(canonical)) throw new HttpError(404, "registration not found");
  // ref_code lives on the cart now (V364) — shared by every entry in it. A
  // cart can hold more than one entry (RS002/RS003 shipped group submit) —
  // this picks the oldest deterministically rather than an arbitrary one,
  // which is exactly right for THIS function's actual callers: the
  // single-entry ticket.png render, self-withdraw's target row, and
  // reconcile's status check — none of which need every entry. RS006
  // decided /r/[ref] itself shows the WHOLE cart: see publicCartByRef below,
  // which calls this for the checksum/lookup/404 behaviour and then
  // re-selects every entry in the resolved group.
  const [reg] = await sql<RegistrationWithGroupRow[]>`
    select ${regGroupCols(sql)}
    from registrations r join registration_groups g on g.id = r.group_id
    where g.ref_code = ${canonical}
    order by r.created_at, r.id limit 1`;
  if (!reg) throw new HttpError(404, "registration not found");
  return reg;
}

/**
 * RS008 — batched "does ANY roster player on this registration have an
 * explicit consent opt-out" check, keyed by registration id, for the
 * PERSON-shaped public reads below (`publicRegistrationStatus`,
 * `publicRegistrationStatusByRef`, `publicCartByRef`) — a multi-entry cart
 * costs ONE query here, not one per entry. INNER JOINs persons on purpose: a
 * row with no `person_id` yet (unclaimed, never materialised) has no consent
 * object to check and can never contribute an opt-out, so it is correctly
 * invisible to this query rather than needing an explicit null-check.
 * Delegates the actual "stricter wins across several people sharing one
 * display_name" rule to `anyOptedOut` (lib/name-display.ts) — never
 * re-implements it.
 *
 * Exported (RS008 review fix #6): `registration-submit.ts`'s
 * `previewJoinEntry` reuses this SAME function for its own join-page
 * heading mask, rather than a parallel local query — this file already
 * flows one way into that one (module topology comment, registration-submit.ts),
 * never the reverse.
 *
 * Takes the sql/tx client as an explicit first parameter (code-review fix,
 * 2026-08-30): `exports.ts`'s `buildAdmitTicketsDoc` needs to run this same
 * query from inside its own `withTenant` transaction and used to carry a
 * byte-for-byte duplicate differing only in that one parameter — the exact
 * "two lookup paths drift" defect class this codebase has hit before.
 * Deduped: `exports.ts` now imports and calls this function directly.
 */
export async function anyOptedOutByRegistration(db: AnySql, regIds: string[]): Promise<Set<string>> {
  if (regIds.length === 0) return new Set();
  const rows = await db<{ registration_id: string; consent: { public_name?: boolean } | null }[]>`
    select rp.registration_id, p.consent
    from registration_players rp
    join persons p on p.id = rp.person_id
    where rp.registration_id in ${db(regIds)}`;
  const consentsByReg = new Map<string, ({ public_name?: boolean } | null)[]>();
  for (const r of rows) {
    const list = consentsByReg.get(r.registration_id) ?? [];
    list.push(r.consent);
    consentsByReg.set(r.registration_id, list);
  }
  const optedOut = new Set<string>();
  for (const [regId, consents] of consentsByReg) {
    if (anyOptedOut(consents)) optedOut.add(regId);
  }
  return optedOut;
}

export async function publicRegistrationStatusByRef(
  ref: string,
  token?: string | null,
): Promise<PublicRefView> {
  const reg = await regByRef(ref);
  const ctx = await divisionCtx(sql, reg.division_id);
  const [div] = await sql<
    { name: string; slug: string; youth: boolean; player_name_display: string | null }[]
  >`
    select name, slug, youth, player_name_display from divisions
    where id = ${reg.division_id}`;
  // RS008: display_name is a PERSON's name for individual/pair, but a TEAM's
  // own declared name for team — no personal consent applies there, same
  // `kind === "team"` bypass public.ts's publicEntrants already established.
  const settings = await loadSettings(sql, reg.division_id);
  // Post-merge review fix (2026-08-30, free-agent gap): same as
  // publicRegistrationStatus above — entrant_kind === "team" at the division
  // level also covers a FREE AGENT (one unassigned person, not a named
  // team; registration-submit.ts's entryDisplayName draws this same
  // distinction). Without `!reg.free_agent`, a free-agent entry on a
  // youth+allow_free_agents division rides the team bypass and prints the
  // real person's name unmasked.
  const isTeam = (settings?.entrant_kind ?? "individual") === "team" && !reg.free_agent;
  // A team entry's roster can still carry an opted-out member — never
  // queried for one, so `optedOut` is always empty and the mask stays
  // youth-only, exactly like the pre-RS008 behaviour.
  const optedOut = isTeam ? new Set<string>() : await anyOptedOutByRegistration(sql, [reg.id]);
  // Code-review fix (2026-08-30, item 2): same gap as publicRegistrationStatus
  // above — `isTeam` only bypassed the consent axis; the youth axis lives
  // inside resolvePersonDisplayName itself, so a team on a youth division
  // still got masked. Bypass the resolver call entirely for a team.
  const displayName = isTeam
    ? reg.display_name
    : resolvePersonDisplayName(
        reg.display_name,
        optedOut.has(reg.id) ? { public_name: false } : null,
        div?.player_name_display ?? null,
        div?.youth ?? false,
      );
  // access_token_hash already rode the join in regByRef — no separate fetch
  // needed (it lives on the cart now, V364).
  const canWithdraw =
    !!token && reg.status !== "withdrawn" && hashRegistrationToken(token) === reg.access_token_hash;
  return {
    ref_code: reg.ref_code!,
    status: reg.status,
    display_name: displayName,
    division_name: div?.name ?? "",
    division_slug: div?.slug ?? "",
    competition_name: ctx.comp_name,
    competition_slug: ctx.comp_slug,
    org_slug: ctx.org_slug,
    org_name: ctx.org_name,
    starts_on: ctx.starts_on,
    ends_on: ctx.ends_on,
    created_at: new Date(reg.created_at).toISOString(),
    can_withdraw: canWithdraw,
  };
}

/** Resolves ONE specific cart entry for a ref, verifying in a SINGLE query
 *  that (a) `entryId` belongs to the group `ref` itself names and (b) the
 *  supplied token matches THAT group's access_token_hash — mirrors
 *  `regByToken` exactly (same SQL-side hash equality, same no-row-means-404
 *  contract), just scoped by ref_code too. `ref_code` carries a unique index
 *  (V363), so `g.ref_code = canonical` can join at most one group: an
 *  entryId from a different cart simply has no row satisfying all three
 *  predicates at once, regardless of whether the token is otherwise valid
 *  for THAT other cart. A wrong ref, a wrong token, and a foreign entryId
 *  all 404 identically (RS006 follow-up: withdraw is per-entry now — see
 *  `withdrawRegistrationByRef`). */
async function regByRefAndToken(
  ref: string,
  entryId: string,
  token: string,
): Promise<RegistrationWithGroupRow> {
  const canonical = normalizeRefCode(ref);
  if (!isValidRefCode(canonical)) throw new HttpError(404, "registration not found");
  const [reg] = await sql<RegistrationWithGroupRow[]>`
    select ${regGroupCols(sql)}
    from registrations r join registration_groups g on g.id = r.group_id
    where g.ref_code = ${canonical} and r.id = ${entryId}
      and g.access_token_hash = ${hashRegistrationToken(token)}`;
  if (!reg) throw new HttpError(404, "registration not found");
  return reg;
}

/** Self-withdraw from /r/[ref] — the ref is a LOOKUP, NOT auth: the email
 *  token is still required (v3/05 §4). RS006 follow-up (data-integrity fix):
 *  a cart can hold more than one entry, and this used to always resolve+act
 *  on the OLDEST one (`regByRef`'s deterministic pick) regardless of what the
 *  registrant meant to withdraw — a multi-entry cart rendered one
 *  undifferentiated Withdraw control that silently withdrew the wrong row.
 *  The caller now names the target entry explicitly; `regByRefAndToken`
 *  verifies it belongs to the ref's OWN group before `withdrawCore` ever
 *  runs, so a valid token can never be paired with a foreign registration id
 *  to withdraw someone else's entry. Returns the whole cart (the same shape
 *  the page renders) so every entry's post-withdraw status is visible, not
 *  just the one just acted on. */
export async function withdrawRegistrationByRef(
  ref: string,
  entryId: string,
  token: string,
): Promise<PublicCartView> {
  const reg = await regByRefAndToken(ref, entryId, token);
  await withdrawCore(reg, null);
  return publicCartByRef(ref, token);
}

/** One entry as /r/[ref] shows it to the general public — masked per THIS
 *  entry's own division policy (see `PublicCartView`). */
export interface PublicCartEntryView {
  id: string;
  status: RegistrationRow["status"];
  display_name: string;
  division_name: string;
  /** True when the viewer's token is valid for this cart AND this specific
   *  entry isn't already withdrawn — RS006 follow-up: withdraw acts on ONE
   *  named entry now (`withdrawRegistrationByRef` takes an explicit entry
   *  id), so each entry states its OWN eligibility instead of the whole
   *  cart inheriting one entry's (that mismatch — one flag, evaluated
   *  against only the oldest entry, driving a single cart-wide control —
   *  was the data-integrity bug: nothing told the registrant WHICH entry a
   *  click would act on). Mirrors the single-entry sibling's predicate
   *  (`PublicRefView.can_withdraw`) exactly, just evaluated per row. */
  can_withdraw: boolean;
}

/**
 * What /r/[ref] shows the world for the WHOLE cart (RS006 — the owner's
 * ruling, recorded here: a multi-entry cart shows every entry, not just the
 * oldest, now that RS002/RS003 make multi-entry carts real). The group-level
 * sibling of `PublicRefView`, same "never more than the success screen"
 * contract — NOT `GroupStatusView` (`groupByRef`/`groupById`), which is
 * token-GATED and deliberately unmasked for that reason. This is reachable
 * by anyone with a bare ref code, so contact info, amounts/fees/currency,
 * payment method and the access token are never on this shape, and every
 * entry's `display_name` is masked through `resolvePersonDisplayName` for
 * ITS OWN division AND its own roster's consent (RS008) — a cart can span a
 * youth division and a non-youth one at once, so one mask for the whole cart
 * would be wrong in either direction. A `team` entry's own name is never
 * personal, so it skips the consent axis entirely (`entrantKindByDivision`
 * below) — same bypass `public.ts`'s `publicEntrants` already established.
 */
export interface PublicCartView {
  ref_code: string;
  competition_name: string;
  competition_slug: string;
  org_slug: string;
  org_name: string;
  starts_on: string | null;
  ends_on: string | null;
  created_at: string;
  /** True when the viewer's ?token= matches this cart's access token. RS006
   *  follow-up: no longer tied to any one entry's status — it used to mirror
   *  the OLDEST entry's (the exact bug: a cart-wide flag standing in for a
   *  per-entry fact). That check now lives per entry, see
   *  `PublicCartEntryView.can_withdraw`; this only gates whether the viewer
   *  has write access to the cart AT ALL. */
  can_withdraw: boolean;
  entries: PublicCartEntryView[];
}

export async function publicCartByRef(ref: string, token?: string | null): Promise<PublicCartView> {
  // regByRef owns the checksum/normalise/404 contract (shared with the
  // single-entry read) and hands back the oldest entry joined to the cart's
  // own columns — enough to resolve competition/org context (divisionCtx,
  // same source `publicRegistrationStatusByRef` reads) and the access-token
  // hash, without a second group lookup.
  const reg = await regByRef(ref);
  const ctx = await divisionCtx(sql, reg.division_id);

  const entries = await sql<
    {
      id: string;
      status: RegistrationRow["status"];
      display_name: string;
      division_id: string;
      division_name: string;
      youth: boolean;
      player_name_display: string | null;
      // Post-merge review fix (2026-08-30, free-agent gap): needed below so
      // the team bypass can exclude a free-agent entry (one unassigned
      // person, not a named team) from its own division's team treatment.
      free_agent: boolean;
    }[]
  >`
    select r.id, r.status, r.display_name, r.division_id, d.name as division_name,
           d.youth, d.player_name_display, r.free_agent
    from registrations r join divisions d on d.id = r.division_id
    where r.group_id = ${reg.group_id}
    order by r.created_at, r.id`;

  // access_token_hash lives on the GROUP (V364) — shared by every entry, so
  // any one of them (regByRef's oldest pick) reads it correctly regardless
  // of which entry is actually being withdrawn. Not constant-time: the
  // token is OPTIONAL here, so unlike groupByRef's required-token gate there
  // is no ref-vs-token enumeration distinction to protect (same rule
  // publicRegistrationStatusByRef's canWithdraw already applies).
  const tokenValid = !!token && hashRegistrationToken(token) === reg.access_token_hash;

  // RS008: entrant_kind per DIVISION (a cart can span more than one, same
  // reason buildGroupStatusView's own entrantKindByDivision map exists) —
  // a TEAM entry's display_name is the team's own name, never a person's,
  // so it never takes the consent axis. Batched: one query for the whole
  // cart's distinct divisions, not one per entry.
  const divisionIds = [...new Set(entries.map((e) => e.division_id))];
  const settingsRows =
    divisionIds.length > 0
      ? await sql<{ division_id: string; entrant_kind: RegistrationSettingsRow["entrant_kind"] }[]>`
          select division_id, entrant_kind from registration_settings
          where division_id in ${sql(divisionIds)}`
      : [];
  const entrantKindByDivision = new Map(settingsRows.map((s) => [s.division_id, s.entrant_kind]));
  // Post-merge review fix (2026-08-30, free-agent gap): a FREE AGENT entry
  // carries `entrant_kind: "team"` at the division level but is one
  // unassigned person, not a named team (registration-submit.ts's
  // entryDisplayName draws this same distinction) — it must still take the
  // consent axis like any individual entry, or a free agent's real name
  // rides the team bypass straight past `anyOptedOutByRegistration`.
  const nonTeamEntryIds = entries
    .filter(
      (e) => (entrantKindByDivision.get(e.division_id) ?? "individual") !== "team" || e.free_agent,
    )
    .map((e) => e.id);
  const optedOut = await anyOptedOutByRegistration(sql, nonTeamEntryIds);

  return {
    ref_code: reg.ref_code!,
    competition_name: ctx.comp_name,
    competition_slug: ctx.comp_slug,
    org_slug: ctx.org_slug,
    org_name: ctx.org_name,
    starts_on: ctx.starts_on,
    ends_on: ctx.ends_on,
    created_at: new Date(reg.created_at).toISOString(),
    can_withdraw: tokenValid,
    entries: entries.map((e) => {
      // Code-review fix (2026-08-30, item 2): entrantKindByDivision already
      // decided which entries feed nonTeamEntryIds (the consent axis) above,
      // but this per-entry map still called resolvePersonDisplayName
      // unconditionally — a team on a youth division was still masked via
      // the youth axis living INSIDE that function, not in nonTeamEntryIds'
      // filter around it.
      // Post-merge review fix (2026-08-30, free-agent gap): same `!e.free_agent`
      // exclusion as nonTeamEntryIds above — a free agent must not take the
      // team bypass on THIS axis either, or its youth-division real name
      // renders unmasked even though the consent axis above now (correctly)
      // catches it.
      const isTeam = (entrantKindByDivision.get(e.division_id) ?? "individual") === "team" && !e.free_agent;
      return {
        id: e.id,
        status: e.status,
        display_name: isTeam
          ? e.display_name
          : resolvePersonDisplayName(
              e.display_name,
              optedOut.has(e.id) ? { public_name: false } : null,
              e.player_name_display,
              e.youth,
            ),
        division_name: e.division_name,
        // Per-entry, not inherited from the cart's (oldest-entry-derived) reg
        // row — see PublicCartEntryView.can_withdraw's doc comment for why.
        can_withdraw: tokenValid && e.status !== "withdrawn",
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Group read model — /r/[ref] status page, multi-entry (RS002 W5, RS007)
// ---------------------------------------------------------------------------

export interface GroupEntryPlayerView {
  id: string;
  full_name: string;
  consent_status: "pending" | "granted" | "guardian";
  /** RS008: this roster row's linked person's own consent — `null` when the
   *  row has no `person_id` yet (a captain-entered row nobody has claimed,
   *  and this entry has never been materialised — `materialise`/
   *  `joinExistingEntrant` are the only writers of `person_id`). The status
   *  page (`entry-card.tsx`) masks by youth alone in that case, via
   *  `resolvePersonDisplayName`'s own null-is-not-opted-out contract — never
   *  blocked on a person existing yet. */
  consent: { public_name?: boolean } | null;
}

export interface GroupEntryView {
  id: string;
  division_id: string;
  division_name: string;
  display_name: string;
  status: RegistrationRow["status"];
  amount_cents: number;
  free_agent: boolean;
  join_code: string | null;
  /** RS007: whether the GENERIC (no player_id) claim link is valid for this
   *  entry — false for a `pair` (its fixed two-person roster leaves no room
   *  for a new joiner; only its per-slot partner link is real), true
   *  otherwise. Irrelevant when `join_code` itself is null. */
  allows_new_joiner: boolean;
  /** REVIEW FIX (#10, "a lapse timer with no way to pay"): this entry's OWN
   *  division's payment method (registration_settings.payment_method) —
   *  never `GroupStatusView.payment_method` (the cart's shared envelope
   *  column). `promoteWaitlistedRow` only overwrites that shared column
   *  when no OTHER entry in the cart is still 'pending' (see its own doc
   *  comment), so it can stay null/stale forever past a promotion whose own
   *  division genuinely charges — resolveMoneyState (register/status/
   *  view-model.ts) reads THIS field now, per entry, so it can never be
   *  fooled by a sibling's stale write. */
  payment_method: "offline" | "stripe";
  /** V378/RS007: this entry's OWN pay-by deadline when it was promoted out
   *  of the waitlist — null for a never-promoted entry, whose deadline is
   *  the CART's own `GroupStatusView.expires_at` instead (see
   *  `promoteWaitlistedRow`'s doc comment for why one shared column cannot
   *  serve both). The status page resolves `promotion_expires_at ??` the
   *  cart's `expires_at`, mirroring the sweep's identical fallback. */
  promotion_expires_at: string | null;
  /** RS008: this entry's OWN division's youth/player_name_display policy —
   *  `entry-card.tsx` needs it per entry (never a cart-wide value) because a
   *  cart can span a youth division and a non-youth one at once, same reason
   *  `refund_policy`/`payment_method` are already resolved per entry rather
   *  than inherited from the cart. Threaded down (not pre-masked here)
   *  because a per-player consent opt-out must combine with it — see
   *  `GroupEntryPlayerView.consent`. */
  division_youth: boolean;
  division_player_name_display: string | null;
  /** RS008 review fix #1: the entry-card HEADING's own consent rule — a
   *  `team`'s declared name never takes the consent axis, but an
   *  `individual`/`pair`'s `display_name` IS a person's (or a pair's
   *  compound) name. Sourced from `entrantKindByDivision` below (the SAME
   *  map `allows_new_joiner` already reads), never a second lookup. */
  entrant_kind: "team" | "individual" | "pair";
  players: GroupEntryPlayerView[];
  /** V379/RS007: this entry's own resolved refund policy — so the status
   *  page can tell a registrant which side of the line they are on BEFORE
   *  they confirm a cancel. Same rule `withdrawCore`'s auto-refund uses
   *  (see `resolveRefundPolicy`) — the status page's cancel-confirm copy
   *  reads this directly rather than re-deriving it. */
  refund_policy: ResolvedRefundPolicy;
}

/** The whole cart, for the status page (design §4 step 6; RS007 builds the
 *  endpoint). Group-level sibling of `PublicStatusView` (one entry). Every
 *  field here is token-gated (see `groupByRef`), so — unlike the token-less
 *  `PublicRefView` — names are NOT masked: whoever holds the access token is
 *  the registrant (or someone they chose to share the link with), not the
 *  general public `/r/[ref]` serves. */
export interface GroupStatusView {
  /** Review fix (RS007): genuinely nullable — unlike `PublicRefView`/
   *  `PublicCartView` above (both resolved BY `ref_code`, so a match
   *  guarantees non-null), this view is also reachable via `groupById`,
   *  which is keyed on the group's always-present DB id specifically
   *  BECAUSE a submit whose ref-mint retries were exhausted still commits
   *  the cart with `ref_code: null` (see that function's own doc comment).
   *  The two current consumers (`fillPaymentInstructions`'s `reference`
   *  param, and a bare JSX `{view.ref_code}`) already tolerate null. */
  ref_code: string | null;
  contact_name: string;
  currency: string;
  amount_cents: number;
  payment_method: "offline" | "stripe" | null;
  expires_at: string | null;
  refunded_cents: number;
  competition_name: string;
  competition_slug: string;
  org_slug: string;
  org_name: string;
  created_at: string;
  /** RS007: whether the org's Connect account can currently take a payment —
   *  gates the status page's "pay now" CTA so it never renders a button that
   *  `resumeRegistrationCheckout` would just 503. Resolved off the first
   *  entry that still carries a fee (else the first entry), mirroring
   *  `buildCartMail`'s identical "one division is representative of the
   *  whole cart" simplification (a cart's paid divisions already agree on
   *  payment_method at submit — `assertUniformPaymentMethod`). */
  charges_enabled: boolean;
  /** RS007: the resolved offline instructions ({{reference}} left
   *  un-substituted — the page fills it in with THIS cart's own ref_code),
   *  division override falling back to the org's, or null for a
   *  stripe-method cart. Same resolution order `buildCartMail`'s email
   *  uses, so the page and the confirmation email never disagree about what
   *  a registrant is told to do. */
  payment_instructions: string | null;
  /** REVIEW FIX (#13a): the org's own scheduling timezone, resolved exactly
   *  once (`resolveVenueTz`, same call already used for `refund_policy`
   *  below — no second resolution to drift from it) and always a valid IANA
   *  zone (falls back to "UTC", never null) — entry-card.tsx renders every
   *  pay-by deadline in THIS zone, with a zone label, instead of the
   *  hardcoded UTC it used to. */
  org_timezone: string;
  entries: GroupEntryView[];
}

/** A fixed, deterministic hash to compare against when no group matches —
 *  keeps `groupByRef`'s work (one hash + one `timingSafeEqual` call) the same
 *  whether or not `ref` exists, so a nonexistent ref and a real ref with the
 *  wrong token take the same path at the same cost. */
const DUMMY_ACCESS_HASH = hashRegistrationToken("");

/** Constant-time token check — mirrors the repo's sole existing precedent
 *  (`api/internal/revalidate`'s `secretOk`): length-gate before
 *  `timingSafeEqual`, which THROWS on a length mismatch rather than
 *  returning false. Both inputs are always sha256 hex (64 chars), so the
 *  length gate never actually trips in practice — it exists so this can
 *  never throw regardless. */
function tokenMatchesHash(token: string, hash: string): boolean {
  const a = Buffer.from(hashRegistrationToken(token));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The whole cart by its human-quotable ref (design §4 step 6) — the
 * multi-entry status page RS007 builds on. Unlike `publicRegistrationStatusByRef`
 * (token OPTIONAL, gates only `can_withdraw`), the access token is REQUIRED
 * here: a cart can list every entry and every player in it, more than the
 * general public should ever see off a bare ref. A wrong token and a
 * nonexistent ref throw the identical generic 404 (never "ref not found" vs
 * "wrong token") and cost the same (`tokenMatchesHash` always runs, even with
 * no real hash to compare), so neither the error shape nor the response
 * timing discloses whether the ref exists.
 */
export async function groupByRef(ref: string, accessToken: string): Promise<GroupStatusView> {
  const notFound = () => new HttpError(404, "registration not found");
  const canonical = normalizeRefCode(ref);
  if (!isValidRefCode(canonical)) throw notFound();
  const [group] = await sql<RegistrationGroupRow[]>`
    select * from registration_groups where ref_code = ${canonical}`;
  return buildGroupStatusView(group, accessToken, notFound);
}

const GROUP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The whole cart by its DB id (RS006 §C) — the shape the post-submit status
 * page actually navigates to (`?rid=<group_id>&token=...`), matching the
 * SAME convention `buildCartMail`'s statusUrl and
 * `createRegistrationCheckout`'s Stripe success/cancel URLs already mint.
 * Keyed on `id` rather than `ref_code` deliberately: `ref_code` is nullable
 * on the schema (a submit whose ref-mint retries were exhausted still
 * commits the cart — see `submitRegistrationGroup`), so a status link built
 * right after submit needs the ALWAYS-present primary key, not the
 * sometimes-absent human-quotable one. Same token-gate contract as
 * `groupByRef` (see that function's own doc comment for the three security
 * claims): a wrong token and a nonexistent id are indistinguishable, and a
 * malformed id string 404s cleanly rather than reaching the DB as invalid
 * `uuid` input syntax.
 */
export async function groupById(id: string, accessToken: string): Promise<GroupStatusView> {
  const notFound = () => new HttpError(404, "registration not found");
  if (!GROUP_ID_RE.test(id)) throw notFound();
  const [group] = await sql<RegistrationGroupRow[]>`
    select * from registration_groups where id = ${id}`;
  return buildGroupStatusView(group, accessToken, notFound);
}

/** Shared by `groupByRef`/`groupById` once each has resolved its own
 *  candidate row (or none) by its own key — token-checks it and, on success,
 *  assembles the full `GroupStatusView` (competition/org context, entries,
 *  players). Kept as ONE function so the token-gate's timing/shape
 *  guarantees (see `groupByRef`'s doc comment) and the entries/players
 *  assembly can never drift between the two lookup paths. */
async function buildGroupStatusView(
  group: RegistrationGroupRow | undefined,
  accessToken: string,
  notFound: () => HttpError,
): Promise<GroupStatusView> {
  const tokenOk = tokenMatchesHash(accessToken, group?.access_token_hash ?? DUMMY_ACCESS_HASH);
  if (!group || !tokenOk) throw notFound();

  const [comp] = await sql<
    {
      comp_name: string; comp_slug: string; org_slug: string; org_name: string;
      starts_on: string | null; charges_enabled: boolean; org_payment_instructions: string | null;
      org_timezone: string | null;
    }[]
  >`
    select c.name as comp_name, c.slug as comp_slug, o.slug as org_slug, o.name as org_name,
           c.starts_on, o.stripe_charges_enabled as charges_enabled,
           o.payment_instructions as org_payment_instructions, o.timezone as org_timezone
    from competitions c join organizations o on o.id = c.org_id
    where c.id = ${group.competition_id}`;
  // RS007: same org-only governing clock resolveRefundPolicy's own doc
  // comment requires — resolved ONCE for the whole group (never per
  // division), since `starts_on` is this ONE competition's field.
  const refundTz = resolveVenueTz(null, comp?.org_timezone ?? null);

  const entries = await sql<
    (Omit<
      GroupEntryView,
      "players" | "refund_policy" | "promotion_expires_at" | "allows_new_joiner" | "payment_method"
    > & {
      refunded_cents: number;
      promotion_expires_at: Date | null;
      /** V387/H1 — read to resolve THIS entry's refund policy, then
       *  destructured OUT below so it never reaches the public view: a
       *  Stripe intent id is not something a status page hands to whoever
       *  holds the link. */
      entry_payment_intent_id: string | null;
    })[]
  >`
    select r.id, r.division_id, d.name as division_name, r.display_name, r.status,
           r.amount_cents, r.refunded_cents, r.free_agent, r.join_code, r.promotion_expires_at,
           r.payment_intent_id as entry_payment_intent_id,
           d.youth as division_youth, d.player_name_display as division_player_name_display
    from registrations r join divisions d on d.id = r.division_id
    where r.group_id = ${group.id}
    order by r.created_at, r.id`;

  // refund_lock_at, entrant_kind and payment_method are all DIVISION
  // settings (registration_settings), so a cart spanning more than one
  // division can genuinely have one entry refundable and another not
  // (V379/RS007), one entry a team and another a pair, or (REVIEW FIX #10)
  // one entry billed via Stripe and another offline. Batched by distinct
  // division_id, the same way `players` batches by entries.map(id) below —
  // one query, not one per entry. Moved ABOVE the payment-instructions block
  // below (it used to run after) so that block can resolve off the SAME
  // division-sourced map instead of the cart's own (sometimes stale/null)
  // `payment_method` column — see paymentMethodByDivision's own comment.
  const divisionIds = [...new Set(entries.map((e) => e.division_id))];
  const settingsRows =
    divisionIds.length > 0
      ? await sql<
          {
            division_id: string;
            refund_lock_at: Date | null;
            entrant_kind: RegistrationSettingsRow["entrant_kind"];
            payment_method: RegistrationSettingsRow["payment_method"];
          }[]
        >`
          select division_id, refund_lock_at, entrant_kind, payment_method from registration_settings
          where division_id in ${sql(divisionIds)}`
      : [];
  const refundLockByDivision = new Map(settingsRows.map((s) => [s.division_id, s.refund_lock_at]));
  // A pair's roster is fixed at exactly two (registration-submit.ts's own
  // structural check + rosterIssues at submit) — its join_code only ever
  // lets the PARTNER claim their already-typed-in slot; `joinTeamEntry`
  // 422s a pair's insert-a-new-person path outright. Unknown (a division
  // whose settings row is somehow missing) fails toward showing the link
  // rather than hiding a legitimate one — a UX dead end the join route's own
  // "defense in depth" 422 already catches safely, never a money/auth risk.
  const entrantKindByDivision = new Map(settingsRows.map((s) => [s.division_id, s.entrant_kind]));
  // REVIEW FIX (#10): the DIVISION's own payment method — never
  // GroupStatusView.payment_method (group.payment_method, the cart's shared
  // envelope column). promoteWaitlistedRow only writes that shared column
  // when no OTHER entry in the cart is still 'pending' (see its own doc
  // comment), so it can stay null/stale forever past a promotion whose own
  // division genuinely charges. resolveMoneyState (view-model.ts) reads
  // this per entry now. Falls back to 'offline' only when the settings row
  // itself is missing — same convention promoteWaitlistedRow's own `method`
  // already uses.
  const paymentMethodByDivision = new Map(settingsRows.map((s) => [s.division_id, s.payment_method]));

  // RS007: the resolved offline payment instructions — mirrors
  // buildCartMail's own "first entry that still carries a fee is
  // representative of the whole cart" rule exactly, so the status page and
  // the confirmation email never disagree. Division override, else the
  // org's own (already fetched above, no extra query for that half).
  //
  // REVIEW FIX (#10): gated on the representative entry's own DIVISION
  // method (paymentMethodByDivision) rather than group.payment_method —
  // same fix, same reason, as resolveMoneyState's own: the cart's shared
  // column can be null/stale past exactly the promotion this resolves
  // instructions for.
  let paymentInstructions: string | null = null;
  if (entries.length > 0) {
    const firstPaid = entries.find((e) => e.amount_cents > 0) ?? entries[0]!;
    if ((paymentMethodByDivision.get(firstPaid.division_id) ?? "offline") === "offline") {
      const repSettings = await loadSettings(sql, firstPaid.division_id);
      paymentInstructions = repSettings?.payment_instructions ?? comp?.org_payment_instructions ?? null;
    }
  }

  // RS008: LEFT JOIN persons (never inner) — a captain-entered row nobody
  // has claimed, on an entry that has never been materialised, has no
  // `person_id` yet at all (materialise()/joinExistingEntrant are the only
  // writers of it). That row still belongs on the roster list; it just has
  // nothing to mask by consent — `person_consent` reads null, and
  // `resolvePersonDisplayName` already treats null as "not opted out",
  // masking by division youth policy alone.
  const players =
    entries.length > 0
      ? await sql<
          (Omit<GroupEntryPlayerView, "consent"> & {
            registration_id: string;
            person_consent: { public_name?: boolean } | null;
          })[]
        >`
          select rp.id, rp.registration_id, rp.full_name, rp.consent_status,
                 p.consent as person_consent
          from registration_players rp
          left join persons p on p.id = rp.person_id
          where rp.registration_id in ${sql(entries.map((e) => e.id))}
          order by rp.created_at`
      : [];
  const playersByEntry = new Map<string, GroupEntryPlayerView[]>();
  for (const p of players) {
    const list = playersByEntry.get(p.registration_id) ?? [];
    list.push({
      id: p.id,
      full_name: p.full_name,
      consent_status: p.consent_status,
      consent: p.person_consent,
    });
    playersByEntry.set(p.registration_id, list);
  }

  return {
    // Review fix (RS007): was `group.ref_code!` — see GroupStatusView's own
    // doc comment for why that was a lie (groupById reaches rows where this
    // is genuinely null).
    ref_code: group.ref_code,
    contact_name: group.contact_name,
    currency: group.currency,
    amount_cents: group.amount_cents,
    payment_method: group.payment_method,
    expires_at: group.expires_at ? new Date(group.expires_at).toISOString() : null,
    refunded_cents: group.refunded_cents,
    competition_name: comp?.comp_name ?? "",
    competition_slug: comp?.comp_slug ?? "",
    org_slug: comp?.org_slug ?? "",
    org_name: comp?.org_name ?? "",
    created_at: new Date(group.created_at).toISOString(),
    charges_enabled: comp?.charges_enabled ?? false,
    payment_instructions: paymentInstructions,
    org_timezone: refundTz,
    entries: entries.map(({ refunded_cents, promotion_expires_at, entry_payment_intent_id, ...e }) => ({
      ...e,
      promotion_expires_at: promotion_expires_at ? new Date(promotion_expires_at).toISOString() : null,
      allows_new_joiner: entrantKindByDivision.get(e.division_id) !== "pair",
      // Unknown (a division whose settings row is somehow missing) fails
      // toward "individual" — the masked side of the bypass — matching this
      // review's own "a privacy control fails CLOSED, not open" rule (#8),
      // not the "fails toward showing a legitimate link" bias
      // allows_new_joiner uses just above (a UX dead end vs. a privacy leak
      // are not the same risk, and do not share a default).
      //
      // Post-visual-check fix (free-agent gap, RS008.1): a free agent's
      // division-level entrant_kind is "team" (allow_free_agents requires
      // it), but they are one real person, not a team — entryDisplayName
      // (view-model.ts) treats "team" as the unmasked-name bypass, so
      // without this guard a free agent on a youth division rides that
      // bypass and prints their raw name right above their own masked
      // roster row.
      entrant_kind: e.free_agent ? "individual" : (entrantKindByDivision.get(e.division_id) ?? "individual"),
      payment_method: paymentMethodByDivision.get(e.division_id) ?? "offline",
      players: playersByEntry.get(e.id) ?? [],
      refund_policy: resolveRefundPolicy(
        refundLockByDivision.get(e.division_id) ?? null,
        comp?.starts_on ?? null,
        refundTz,
        // REVIEW FIX (money-path defect #1): group.payment_intent_id is the
        // CART's charge — every entry in a multi-entry cart shares one, but
        // only the entries actually named in the checkout session that
        // produced it were ever charged. A promoted-but-unpaid sibling
        // ('pending', never itself billed) must never inherit a PAID
        // sibling's payment_intent_id here — that reads as "refundable" and
        // withdrawCore below would run a REAL Stripe refund against money
        // this entry's registrant never paid. 'paid'/'confirmed' are the
        // only statuses a Stripe checkout webhook (confirmPaidRegistration)
        // ever leaves an entry in — see the block comment there.
        // V387/H1: the ENTRY's own intent (read side twin of withdrawCore's
        // fix). The cart's is last-writer-wins and, on a cart paid in two
        // sessions, belongs to a sibling — so using it here would show a
        // registrant "you will be refunded automatically" for a charge that
        // is not theirs. Null reads as not-automatically-refundable, which
        // is the honest answer when we cannot name this entry's charge.
        e.status === "paid" || e.status === "confirmed" ? entry_payment_intent_id : null,
        e.amount_cents,
        refunded_cents,
      ),
    })),
  };
}

/** Resume/complete payment from the status page (pending paid regs — fresh
 *  submissions whose checkout was abandoned, and waitlist promotions). */
export async function resumeRegistrationCheckout(
  regId: string,
  token: string,
  origin: string,
): Promise<{ checkout_url: string }> {
  const reg = await regByToken(regId, token);
  if (reg.status !== "pending") {
    throw new HttpError(422, `Nothing to pay — registration is ${reg.status}`);
  }
  // PR #677 finding M1: #10 fixed the READ side (buildGroupStatusView /
  // resolveMoneyState resolve payment_method per DIVISION) and left this,
  // the write side, still reading the CART column. `promoteWaitlistedRow`
  // only overwrites that column when no other entry in the cart is still
  // 'pending', so a promoted stripe entry sharing a cart with a pending
  // sibling kept a live "Pay now" button whose POST 422'd with the message
  // below — the same dead end #10 was raised for, moved from the button to
  // the click. Resolve it the way the read side does: the DIVISION's
  // setting, falling back to the cart's only when a division has no
  // settings row at all.
  const divSettings = await loadSettings(sql, reg.division_id);
  const effectiveMethod = divSettings?.payment_method ?? reg.payment_method;
  if (effectiveMethod !== "stripe") {
    throw new HttpError(422, "This entry fee is paid directly to the organiser");
  }
  if (reg.amount_cents <= 0) {
    throw new HttpError(422, "This registration has no entry fee");
  }
  // REVIEW FIX (#8, "pay-then-refund on a stale deadline"): the sweep that
  // expires an overdue pending entry (and auto-refunds a paid Stripe one) is
  // hourly (cron "37 * * * *"), so a cart whose deadline passed at 14:00 is
  // still 'pending' at 14:36 — without this check a stale tab or a direct
  // POST in that window would mint a REAL Stripe session, the registrant
  // would pay, and the next sweep expires the row and auto-refunds it
  // straight back out. Same precedence as the client's own
  // effectivePayDeadline (register/status/view-model.ts): this entry's own
  // promotion window if it was promoted out of the waitlist, else the
  // cart's shared window — this is the LOAD-BEARING half; the client-side
  // window_closed state is cosmetic without this.
  const deadline = reg.promotion_expires_at ?? reg.expires_at;
  if (deadline && deadline.getTime() <= Date.now()) {
    throw new HttpError(422, "This payment window has closed");
  }
  const ctx = await divisionCtx(sql, reg.division_id);
  if (!ctx.charges_enabled) {
    throw new HttpError(503, "Payments are not set up for this organiser yet");
  }
  const url = await createRegistrationCheckout(reg.group_id, [reg.id], ctx, origin, token);
  return { checkout_url: url };
}

// ---------------------------------------------------------------------------
// Withdraw core + refunds (shared by public + organiser paths)
// ---------------------------------------------------------------------------

/** Refund a payment taken as a destination charge: money comes back off the
 *  connected account, the platform returns its application fee. Exported for
 *  `registration-approval.ts` (RS002 W5 whole-branch review) —
 *  `rejectRegistration` reuses this verbatim to refund a paid-awaiting-
 *  approval entry it declines, same as withdrawCore/refundRegistration. */
export async function stripeRefund(
  paymentIntentId: string,
  amountCents: number | undefined,
): Promise<Stripe.Refund> {
  return getStripe().refunds.create({
    payment_intent: paymentIntentId,
    ...(amountCents !== undefined ? { amount: amountCents } : {}),
    reverse_transfer: true,
    refund_application_fee: true,
  });
}

/** Fire-and-forget refund receipt to the registrant (spec T9). Exported for
 *  `registration-approval.ts` (RS002 W5 whole-branch review). */
export function notifyRefund(reg: RegistrationWithGroupRow, ctx: DivisionCtx, amountCents: number): void {
  void sendRefundIssuedEmail({
    to: reg.contact_email,
    locale: toLocale(reg.locale),
    orgName: ctx.org_name,
    competitionName: ctx.comp_name,
    displayName: reg.display_name,
    amountCents,
    currency: reg.currency,
    refCode: reg.ref_code,
  }).catch(() => {});
}

/** Plain string for a caught refund error — never rendered to a customer,
 *  only into the staff alert body/log below. */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Best-effort staff alert (this task's gap): a registration refund FAILED,
 * so the organiser now owes a registrant money that never moved.
 * `registration.refund_failed` (the audit call every caller keeps making
 * right alongside this) is written and never read outside tests — without
 * this, the failure is invisible until the registrant complains.
 *
 * NEVER THROWS, and gated on STAFF_ALERT_EMAIL before anything else — the
 * same discipline as maybeAlertOrgRepriceFailed (billing-events.ts) /
 * maybeAlertOrgAllowance (extra-orgs.ts), which this deliberately mirrors.
 * Every call site sits on a refund's OWN failure path, so an alert that
 * threw would turn "a refund failed" into "the webhook/request fails and
 * retries forever" — telemetry strictly worse than the fault it reports.
 * Awaited rather than fire-and-forget: this path is rare, nothing here is
 * user-facing latency a registrant/organiser is waiting on, and a floating
 * promise cannot be tested honestly.
 *
 * Goes to the PLATFORM OPERATOR only (owner ruling) — never the organiser or
 * the registrant. The usual causes (a restricted connected account, a
 * reversed transfer with no headroom, a disconnected destination) are
 * Connect/platform-level and not something an organiser can act on;
 * alerting them would produce alarm with no remedy. An organiser-facing
 * console surface is out of scope here.
 *
 * Exported so the never-throws contract can be tested DIRECTLY rather than
 * through a caller's own catch, which would hide a missing wrapper.
 */
export async function maybeAlertRegistrationRefundFailed(opts: {
  registrationId: string;
  orgId: string;
  competitionId: string;
  amountCents: number;
  currency: string;
  paymentIntentId: string | null;
  reason: string;
}): Promise<void> {
  try {
    const alertTo = process.env.STAFF_ALERT_EMAIL;
    if (!alertTo) return;
    await sendRegistrationRefundFailedAlertEmail({ to: alertTo, ...opts });
  } catch (err) {
    log.error(
      { registrationId: opts.registrationId, orgId: opts.orgId, err },
      "registrations: refund-failed alert failed",
    );
  }
}

export interface ResolvedRefundPolicy {
  refundable: boolean;
  /** ISO instant, or null only when NEITHER an explicit lock NOR the
   *  competition's own `starts_on` exists to fall back to — see `reason`. */
  deadline: string | null;
  /** This entry's own remaining unrefunded balance — what would come back if
   *  it were withdrawn right now, regardless of `refundable` (a registrant
   *  past the deadline can still be shown what is at stake). */
  amount_cents: number;
  /** Set only when `refundable` is false because NO deadline could be
   *  derived at all — no explicit `refund_lock_at` AND no competition
   *  `starts_on` (owner ruling, RS007 follow-up to V379): an org that never
   *  configured either is fail-CLOSED, not auto-refundable forever. Lets a
   *  surface distinguish "we cannot know when this event begins, ask the
   *  organiser" from an ordinary past-deadline decline. Null in every other
   *  case, refundable or not (including a KNOWN deadline that has simply
   *  passed). */
  reason: "no_deadline" | null;
}

/**
 * V379/RS007 — the refund policy an entry sits under RIGHT NOW. Shared by
 * `withdrawCore`'s auto-refund decision and the read path
 * (`buildGroupStatusView`) so a registrant can never be shown a policy on
 * the status page that the write path would not actually honour.
 *
 * NULL `refundLockAt` no longer means "refundable forever" (owner ruling).
 * The lock-DATE policy stays — the org still controls refunds by setting one
 * date, not by actioning each refund individually — but an org that never
 * configured a lock now falls back to the competition's own `starts_on`,
 * rather than staying auto-refundable right up until (and past) kickoff,
 * after the money is already committed to a venue. An EXPLICIT
 * `refund_lock_at` always wins over this fallback — never averaged,
 * never the earlier/later of the two, just a plain `??`.
 *
 * RS007 follow-up (this wave, closing a gap the V379 comment above did not):
 * a NULL `refundLockAt` with a NULL `startsOn` used to leave the derived
 * deadline null too, which the boolean below read as "no deadline, so still
 * open" — refundable forever, the exact behaviour V379 claims it removed.
 * Owner ruling: no derivable deadline at all is fail-CLOSED (`refundable:
 * false`, `reason: "no_deadline"`), never fail-open — an organiser bleeding
 * refunds through a window that never closes is a worse failure than a
 * registrant having to ask a human.
 *
 * `startsOn` is a DATE column (`competitions.starts_on`, no time-of-day) and
 * carries no zone of its own — `tz` resolves the fallback in the
 * COMPETITION's governing clock (`resolveVenueTz(null, organizations.timezone)`,
 * the same "orgTz, never a division's own schedule_settings.tz" rule
 * `loadSettings`/`zoned-datetime.ts` document for every other value derived
 * from a competition- rather than division-scoped field): `starts_on`
 * belongs to the competition, not any one division, so every division of one
 * competition must derive the identical instant from it — a per-division
 * override here would silently disagree with a sibling entry in the same
 * cart the exact way #397 already fixed for fixture scheduling. Real spread
 * is UTC-12…UTC+14: parsing as bare UTC midnight (the old behaviour) could
 * leave an Asia/Kolkata org auto-refunding until 05:30 local on the morning
 * of play.
 */
export function resolveRefundPolicy(
  refundLockAt: Date | null,
  startsOn: string | null,
  tz: string,
  paymentIntentId: string | null,
  amountCents: number,
  refundedCents: number,
): ResolvedRefundPolicy {
  const startsOnDeadline = startsOn ? isoFromZonedParts(startsOn, "00:00", tz) : null;
  const lockAt = refundLockAt ?? (startsOnDeadline ? new Date(startsOnDeadline) : null);
  const remaining = amountCents - refundedCents;
  return {
    refundable: !!paymentIntentId && remaining > 0 && !!lockAt && new Date() < lockAt,
    deadline: lockAt ? lockAt.toISOString() : null,
    amount_cents: remaining,
    reason: lockAt ? null : "no_deadline",
  };
}


/**
 * Release a solo sign-up's placement on someone else's team, if they have
 * one. Returns the team registration they were removed from, or null when
 * they were never placed (the ordinary case, and a cheap no-op).
 *
 * RS009. This exists because a placement survives every TERMINAL TRANSITION
 * unless something removes it: withdraw, reject and expire are all status
 * changes, and V388's `on delete cascade` only fires on a DELETE. Without
 * this, a placed solo sign-up who cancels from their status page is refunded
 * and still fielded — their roster row and their `entrant_members` row both
 * survive, the team still reads full, and nobody is told.
 *
 * ONE helper with three callers rather than three copies of the same two
 * deletes: `withdrawCore`, `rejectRegistration` and the expiry sweep. A
 * fourth terminal path added later needs to call this, and the shared name is
 * the only thing that will make that obvious.
 *
 * Order matters: the membership first, then the roster row. The reverse
 * leaves a person on the entrant with nothing left pointing at why they are
 * there — an orphan no cascade can reach, because the FK cascades from the
 * registration, not from this row.
 */
export async function releaseSoloSignUpPlacement(
  tx: Tx,
  registrationId: string,
): Promise<string | null> {
  const [placement] = await tx<
    { id: string; registration_id: string; person_id: string | null }[]
  >`
    select id, registration_id, person_id from registration_players
    where assigned_from_registration_id = ${registrationId}`;
  if (!placement) return null;
  const [target] = await tx<{ entrant_id: string | null }[]>`
    select entrant_id from registrations where id = ${placement.registration_id} for update`;
  if (target?.entrant_id && placement.person_id) {
    await tx`
      delete from entrant_members
      where entrant_id = ${target.entrant_id} and person_id = ${placement.person_id}`;
  }
  await tx`delete from registration_players where id = ${placement.id}`;
  return placement.registration_id;
}

async function withdrawCore(reg: RegistrationWithGroupRow, actorId: string | null): Promise<void> {
  if (reg.status === "withdrawn") return; // idempotent
  // RULING A (RS002 W5 review, MAJOR): rejected is terminal from every
  // writer — reachable here from BOTH withdrawRegistrationOrganiser and the
  // public token-only withdrawRegistrationByRef. Without this, a rejected
  // row silently flipped to 'withdrawn' (the only special case this
  // function checked), which could also wrongly auto-promote a waitlisted
  // sibling for a spot the organiser had already closed. Fast-path check
  // (the pre-lock snapshot) mirrors the withdrawn idempotent check above;
  // the authoritative one is inside the tx, against the LOCKED row, below.
  if (reg.status === "rejected") {
    throw new HttpError(422, "This registration was rejected and cannot be withdrawn");
  }
  const settings = await loadSettings(sql, reg.division_id);
  const ctx = await divisionCtx(sql, reg.division_id);

  const outcome = (await sql.begin(async (tx) => {
    // `for update` on the join locks both the entry AND its cart row — right
    // here, since the refund block below reads the cart's payment_intent_id.
    const [locked] = await tx<RegistrationWithGroupRow[]>`
      select ${regGroupCols(tx)}
      from registrations r join registration_groups g on g.id = r.group_id
      where r.id = ${reg.id} for update`;
    if (!locked || locked.status === "withdrawn") return null;
    if (locked.status === "rejected") {
      throw new HttpError(422, "This registration was rejected and cannot be withdrawn");
    }
    const freedSpot = (SPOT_HOLDERS as readonly string[]).includes(locked.status);
    await tx`
      update registrations
      set status = 'withdrawn', withdrawn_at = now(), updated_at = now()
      where id = ${reg.id}`;
    // A withdrawn entrant that was already materialised marks withdrawn too —
    // fixtures/standings handle entrant withdrawal by the existing rules.
    if (locked.entrant_id) {
      await tx`update entrants set status = 'withdrawn' where id = ${locked.entrant_id}`;
    }
    // RS009: if this entry is a solo sign-up placed on someone else's team,
    // withdrawing must take them OFF that roster. Marking their own entrant
    // withdrawn (above) does not touch it — that is a different entrant.
    const releasedFrom = await releaseSoloSignUpPlacement(tx, reg.id);
    // RS002 W5 whole-branch review MAJOR: withdrawing the cart's LAST
    // `pending` entry used to leave `registration_groups.expires_at` stale
    // forever — only `materialise`'s confirm path ever cleared it. Safe to
    // run unconditionally: this row is excluded from its own `not exists`
    // check regardless of what status it just left, and a cart with another
    // still-pending entry is correctly left untouched.
    await clearExpiresIfNoLongerNeeded(tx, locked.group_id, locked.id);
    const promoted = freedSpot
      ? await promoteOldestWaitlisted(tx, reg.division_id, settings)
      : null;
    await audit(tx, ctx.competition_id, ctx.org_id, "registration.withdrawn", {
      registration_id: reg.id,
      by: actorId ? "organiser" : "registrant",
      promoted_registration_id: promoted?.id ?? null,
      released_from_registration_id: releasedFrom,
    }, actorId);
    if (promoted) {
      await audit(tx, ctx.competition_id, ctx.org_id, "registration.promoted", {
        registration_id: promoted.id,
        from: "waitlist",
      }, actorId);
    }
    return { locked, promoted };
  })) as unknown as
    | { locked: RegistrationWithGroupRow; promoted: RegistrationWithGroupRow | null }
    | null;
  if (!outcome) return;
  log.info(
    { registrationId: reg.id, orgId: ctx.org_id, by: actorId ? "organiser" : "registrant" },
    "registration: withdrawn",
  );

  fireDivisionRevalidate(reg.division_id, ctx.competition_id);
  if (outcome.promoted) {
    void notifyPromoted(outcome.promoted, ctx, settings, fallbackOrigin());
  }

  // Auto-refund policy (doc 16 §1.1): full refund when withdrawal lands
  // before refund_lock_at (V379: or its starts_on fallback when unset — see
  // resolveRefundPolicy). After the lock it's organiser discretion via the
  // manual refund endpoint. Stripe call OUTSIDE the tx.
  const { locked } = outcome;
  const policy = resolveRefundPolicy(
    settings?.refund_lock_at ?? null,
    ctx.starts_on,
    resolveVenueTz(null, ctx.org_timezone),
    // REVIEW FIX (money-path defect #1, write-side twin of buildGroupStatusView's
    // fix above): `locked` is the pre-update row (read before the `status =
    // 'withdrawn'` write above), so `locked.status` is this entry's OWN status
    // right up to this withdrawal — 'pending'/'waitlisted' means it was never
    // itself charged, even when the CART's payment_intent_id is live from a
    // sibling's real payment. Passing the group PI unconditionally here used to
    // let cancelling a never-charged promoted sibling run a REAL stripeRefund
    // against the sibling's own money.
    // V387/H1: THIS ENTRY's own intent, and no fallback to the cart's. The
    // status gate above closes the never-charged sibling; it does NOT close
    // the case where both entries were genuinely charged in two different
    // sessions, because then the gate passes and the cart column holds the
    // OTHER entry's intent. Fail CLOSED when the entry has none recorded: a
    // null here makes `refundable` false, the registrant is told the refund
    // is at the organiser's discretion, and #16's manual refund control
    // handles it. Falling back to the cart's intent is precisely the
    // behaviour being removed — an automatic refund against a charge that
    // may not be this entry's.
    locked.status === "paid" || locked.status === "confirmed"
      ? locked.entry_payment_intent_id
      : null,
    locked.amount_cents,
    locked.refunded_cents,
  );
  if (policy.refundable) {
    // RS002 (V368): THIS entry's own remaining balance — never the cart's
    // whole intent (hazard 1) — so a sibling that already carries a partial
    // refund (organiser discretion, then a late withdrawal) is never
    // double-counted here either.
    const remaining = policy.amount_cents;
    try {
      // Same value the policy above was resolved from — never the cart's.
      const refund = await stripeRefund(locked.entry_payment_intent_id as string, remaining);
      // Additive on BOTH tables (hazard 2 fixed), in ONE transaction (review
      // fixup — matches refundRegistration's withTenant-wrapped pattern
      // below: two separate autocommit statements could leave the entry and
      // cart totals silently diverged if the second failed after the first
      // committed, reachable today on a single-entry cart, no multi-entry
      // cart needed).
      await sql.begin(async (tx) => {
        await tx`
          update registrations
          set refunded_cents = refunded_cents + ${remaining}, updated_at = now()
          where id = ${locked.id}`;
        await tx`
          update registration_groups
          set refunded_cents = refunded_cents + ${remaining}, refunded_at = now(), updated_at = now()
          where id = ${locked.group_id}`;
      });
      await audit(sql, ctx.competition_id, ctx.org_id, "registration.refunded", {
        registration_id: reg.id,
        amount_cents: remaining,
        mode: "auto",
        stripe_refund_id: refund.id,
      }, actorId);
      notifyRefund(locked, ctx, remaining);
    } catch (err) {
      // Refund failure must not undo the withdrawal — surfaces on the
      // organiser console (withdrawn + refunded_cents < amount_cents).
      await audit(sql, ctx.competition_id, ctx.org_id, "registration.refund_failed", {
        registration_id: reg.id,
        mode: "auto",
      }, actorId);
      await maybeAlertRegistrationRefundFailed({
        registrationId: reg.id,
        orgId: ctx.org_id,
        competitionId: ctx.competition_id,
        amountCents: remaining,
        currency: locked.currency,
        paymentIntentId: locked.payment_intent_id,
        reason: errText(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Pay-window sweep (spec §6) — cron-shaped: /api/cron/registrations, hourly
// ---------------------------------------------------------------------------

/**
 * Four passes over card pendings: (1a) T-24h payment reminders for
 * never-promoted entries, keyed on the CART's shared deadline, carrying a
 * fresh token-free checkout link, exactly once per registration
 * (registration_groups.reminded_at); (1b) the same T-24h reminder for
 * PROMOTED entries, keyed on THEIR OWN deadline instead
 * (registrations.promotion_reminded_at — V379/RS007: a group-level mark
 * would silence a still-pending sibling's own, unrelated reminder the
 * moment either one fired); (2) expire never-paid submits past the CART's
 * deadline and promote the oldest waitlisted with a new window; (3) lapse
 * PROMOTED entries past their OWN deadline back to the waitlist tail and
 * re-offer the freed slot (V378/RS007). `r.promoted_at is null` vs
 * `is not null` scopes (1a) from (1b) and (2) from (3) identically, so a row
 * can only ever match one reminder pass and one expiry/lapse pass. Each
 * expiry/lapse runs in its own row-locked tx, so a racing webhook
 * serialises: webhook first → paid wins; sweep first → the late payment
 * auto-refunds (confirmPaidRegistration).
 */

// The reminder passes' claim window (V381) — long enough that a genuinely
// in-flight mint+send is never double-claimed, short enough that a crashed
// claim recovers well inside the sweep's own hourly cadence (registrations-
// sweep.yml). The Stripe client this call chain uses has a hard 10s timeout
// and zero retries (lib/stripe.ts's `timeout`/`maxNetworkRetries`), and the
// reminder email is a single, unretried fetch (lib/email.ts) — so one row's
// realistic worst-case mint+send is on the order of seconds, at most a
// couple dozen. 5 minutes leaves roughly an order of magnitude of headroom
// over that, while still being a twelfth of the hourly cadence, so an
// ungraceful death recovers on the very next scheduled sweep rather than
// sitting stale for hours.
const REMINDER_LEASE_MINUTES = 5;

export async function sweepRegistrations(
  origin: string,
): Promise<{ reminded: number; expired: number; promoted: number; lapsed: number }> {
  let reminded = 0;
  let expired = 0;
  let promotedCount = 0;
  let lapsedCount = 0;

  // payment_method/expires_at live on the cart now (V364).
  // `r.promoted_at is null` (V379/RS007 — found while wiring the promoted-
  // reminder pass below): a promotion into a stripe window EXTENDS the
  // cart's shared expires_at too (promoteWaitlistedRow's `greatest(...)`
  // write, so a still-pending sibling's own deadline is never shortened),
  // which means a promoted entry's OWN clock and the cart's shared one can
  // land in the SAME 24h window at the SAME time — without this filter, a
  // promoted row would be reminded HERE (against the group's — possibly
  // sibling-driven, not this entry's own — deadline) AND by the dedicated
  // promoted pass below (against its real deadline), twice, from two marks.
  // Promoted rows are this query's business no longer; see (1b) below.
  //
  // REVIEW FIX (money-path defect #7, V383) — `submit_reminded_at` replaces
  // the old `g.reminded_at is null` filter. This pass iterates PER ENTRY but
  // used to claim/mark the GROUP row: a cart with two still-pending,
  // never-promoted entries produces two rows here sharing one group_id, and
  // whichever entry's iteration ran first won the group's shared claim —
  // permanently silencing the OTHER entry's own attempt from every future
  // sweep (same group-level filter, now non-null), even though its fee was
  // never presented to anyone (each reminder mints a checkout for the ONE
  // named entry, never the whole cart). V381's lease fix did not touch this
  // — the lease it added was on the SAME group columns. Fixed the same way
  // pass (1b) already scopes a promoted entry's own reminder: this entry's
  // OWN mark, so a still-pending sibling's own, unrelated reminder can never
  // be silenced by this one firing. See the V383 migration's own doc comment
  // for why this is named `submit_*`, not a bare `reminded_at`.
  const due = await sql<RegistrationWithGroupRow[]>`
    select ${regGroupCols(sql)}
    from registrations r join registration_groups g on g.id = r.group_id
    where r.status = 'pending' and r.promoted_at is null and g.payment_method = 'stripe'
      and g.expires_at is not null
      and g.expires_at < now() + interval '24 hours'
      and g.expires_at > now()
      and r.submit_reminded_at is null
    order by g.expires_at
    limit 200`;
  for (const reg of due) {
    let claimed = false;
    try {
      const ctx = await divisionCtx(sql, reg.division_id);
      if (!ctx.charges_enabled) continue; // Connect broke — nothing to link to
      // RS007 follow-up (V381) — the CAS-before-send claim (648c56503) only
      // reverted on a THROWN failure. An ungraceful death (deploy, OOM,
      // SIGKILL, container eviction) between this UPDATE committing and the
      // send below completing runs no `catch`, so a permanent claim would
      // stick forever and `where submit_reminded_at is null` would never
      // match this row again — a silently lost reminder, worse than the
      // double-send the claim exists to prevent (routine here:
      // registrations-sweep.yml's own curl --max-time 60 --retry lands while
      // a 200-row serial sweep is still running server-side).
      // submit_reminder_claimed_at is a LEASE instead of a permanent mark: it
      // blocks a concurrent claim for REMINDER_LEASE_MINUTES, then goes
      // stale and the row is claimable again, so a crash costs a delay,
      // never the reminder. submit_reminded_at — set only after a real send
      // below — stays the permanent record; the "due" SELECT above filters
      // on THAT column alone, never the lease.
      //
      // REVIEW FIX (money-path defect #9) — the mint used to run BEFORE this
      // claim, unconditionally: a losing invocation (a concurrent sweep that
      // loses THIS claim below) still ran createRegistrationCheckout and
      // stamped registration_groups.checkout_session_id with a session
      // nobody would ever hold — the loser never reaches the send below, so
      // nobody is ever given that URL, yet the group's shared session
      // pointer now names it. A registrant who already has the WINNER's
      // session URL (from a real, sent email) then pays via a session the
      // group row no longer names, and the reconcile-on-return path
      // (`sessionId !== reg.checkout_session_id`) refuses to confirm it —
      // the webhook remains the eventual fulfilment path, but the fast
      // return-and-confirm UX breaks for a payment that genuinely succeeded.
      // Minting now happens ONLY after a successful claim, so a losing
      // invocation never reaches Stripe at all.
      const [row] = await sql<{ id: string }[]>`
        update registrations
        set submit_reminder_claimed_at = now(), updated_at = now()
        where id = ${reg.id} and submit_reminded_at is null
          and (submit_reminder_claimed_at is null
               or submit_reminder_claimed_at < now() - make_interval(mins => ${REMINDER_LEASE_MINUTES}))
        returning id`;
      if (!row) continue; // lease held by a concurrent sweep, or already sent
      claimed = true;
      const url = await createRegistrationCheckout(reg.group_id, [reg.id], ctx, origin, null);
      // RS007 review fix — sendPaymentReminderEmail (lib/email.ts) NEVER
      // throws on a provider-level failure: its own send() catches every
      // failure mode (missing key, suppressed, non-2xx, fetch throw) and
      // RETURNS false instead. This call used to discard that return value,
      // so an ordinary Resend 4xx/5xx — far commoner than the process death
      // the lease above exists for — fell through to the unconditional
      // "sent" write below and permanently marked an email that never left
      // this process. Branch on the result: only a genuinely delivered send
      // may promote the lease; a `false` return is handled exactly like a
      // thrown failure (see the `catch` below) — release the lease, leave
      // the permanent mark null, and let the next sweep retry.
      const delivered = await sendPaymentReminderEmail({
        to: reg.contact_email,
        locale: toLocale(reg.locale),
        orgName: ctx.org_name,
        competitionName: ctx.comp_name,
        displayName: reg.display_name,
        feeCents: reg.amount_cents,
        currency: reg.currency,
        paymentInstructions: null,
        checkoutUrl: url,
        payDeadline: reg.expires_at,
      });
      if (!delivered) {
        await sql`update registrations set submit_reminder_claimed_at = null, updated_at = now()
                  where id = ${reg.id}`;
        continue; // submit_reminded_at (sent) stays null — a later sweep retries
      }
      // Send succeeded — promote the lease to the permanent SENT record.
      await sql`update registrations set submit_reminded_at = now(), updated_at = now()
                where id = ${reg.id}`;
    } catch {
      if (claimed) {
        // Thrown failure: clear the LEASE, not the (still-null) sent mark,
        // so the next sweep retries promptly instead of waiting out the
        // window.
        await sql`update registrations set submit_reminder_claimed_at = null, updated_at = now()
                  where id = ${reg.id}`;
      }
      continue; // submit_reminded_at (sent) stays null either way — a later sweep retries
    }
    reminded++;
  }

  // (1b) V379/RS007 — the promoted counterpart to the pass immediately
  // above: same T-24h window, same mailer, but keyed on THIS entry's own
  // `promotion_expires_at` and marked on THIS entry's own
  // `promotion_reminded_at` — never the group's `reminded_at`, which a cart
  // can share with a still-pending sibling (see (1a)'s comment and the
  // column's own doc comment on `registrations`, V379). `promotion_expires_at
  // is not null` alone is enough to scope this to promoted, stripe-fee rows:
  // `promoteWaitlistedRow` only ever sets it when the promotion itself
  // needed a stripe window (`amount_cents` > 0 at that moment), and nothing
  // else in the codebase writes it.
  const duePromoted = await sql<RegistrationWithGroupRow[]>`
    select ${regGroupCols(sql)}
    from registrations r join registration_groups g on g.id = r.group_id
    where r.status = 'pending' and r.promoted_at is not null
      and r.promotion_expires_at is not null
      and r.promotion_expires_at < now() + interval '24 hours'
      and r.promotion_expires_at > now()
      and r.promotion_reminded_at is null
    order by r.promotion_expires_at
    limit 200`;
  for (const reg of duePromoted) {
    let claimed = false;
    try {
      const ctx = await divisionCtx(sql, reg.division_id);
      if (!ctx.charges_enabled) continue; // Connect broke — nothing to link to
      // RS007 follow-up (V381) — same lease fix as pass (1a) above, on this
      // entry's OWN mark (never the group's, per this pass's own doc
      // comment on why).
      //
      // REVIEW FIX (money-path defect #9) — same reorder as pass (1a) above:
      // this pass had the identical mint-before-claim shape (its own entry-
      // scoped columns already avoided the CART-sibling repro #7 fixes, but
      // a losing invocation under genuine concurrent sweep execution still
      // wasted a mint and clobbered the group's shared checkout_session_id
      // with a session nobody would ever hold). Claim first; a losing
      // invocation now never reaches createRegistrationCheckout at all.
      const [row] = await sql<{ id: string }[]>`
        update registrations
        set promotion_reminder_claimed_at = now(), updated_at = now()
        where id = ${reg.id} and promotion_reminded_at is null
          and (promotion_reminder_claimed_at is null
               or promotion_reminder_claimed_at < now() - make_interval(mins => ${REMINDER_LEASE_MINUTES}))
        returning id`;
      if (!row) continue; // lease held by a concurrent sweep, or already sent
      claimed = true;
      const url = await createRegistrationCheckout(reg.group_id, [reg.id], ctx, origin, null);
      // RS007 review fix — same false-vs-throw gap as pass (1a) above, on
      // this pass's own lease/mark columns (never the group's — see this
      // pass's own doc comment on why).
      const delivered = await sendPaymentReminderEmail({
        to: reg.contact_email,
        locale: toLocale(reg.locale),
        orgName: ctx.org_name,
        competitionName: ctx.comp_name,
        displayName: reg.display_name,
        feeCents: reg.amount_cents,
        currency: reg.currency,
        paymentInstructions: null,
        checkoutUrl: url,
        payDeadline: reg.promotion_expires_at,
      });
      if (!delivered) {
        await sql`update registrations set promotion_reminder_claimed_at = null, updated_at = now()
                  where id = ${reg.id}`;
        continue; // promotion_reminded_at (sent) stays null — a later sweep retries
      }
      // Send succeeded — promote the lease to the permanent SENT record.
      await sql`update registrations set promotion_reminded_at = now(), updated_at = now()
                where id = ${reg.id}`;
    } catch {
      if (claimed) {
        // Thrown failure: clear the LEASE, not the (still-null) sent mark —
        // see pass (1a)'s comment above.
        await sql`update registrations set promotion_reminder_claimed_at = null, updated_at = now()
                  where id = ${reg.id}`;
      }
      continue; // promotion_reminded_at (sent) stays null either way — a later sweep retries
    }
    reminded++;
  }

  // expires_at lives on the cart now (V364). RS002 W5 whole-branch review
  // BLOCKER: this used to filter only status + the CART-shared expires_at,
  // with no per-entry fee or payment-method check — while the reminder pass
  // immediately above DOES filter payment_method = 'stripe'. A cart can hold
  // a free, manual-approval entry alongside a paid stripe one (design allows
  // it; W4's assertUniformPaymentMethod only constrains PAID divisions); the
  // free sibling was never subject to any payment deadline of its own, but
  // shared the cart's expires_at and got silently swept to 'expired' the
  // moment the stripe entry's deadline passed. Same relevance filter the
  // reminder pass uses, PLUS the entry's own fee (a `pending` row can be
  // `amount_cents = 0` even when its cart's method is 'stripe', if a sibling
  // established that method).
  //
  // `r.promoted_at is null` (V378/RS007): a PROMOTED entry now has its own
  // clock (`promotion_expires_at`, checked by the lapse pass below) and must
  // not also fall off the cart's shared one — the STRUCTURAL finding in
  // `_INDEX.md`'s RS007 section is exactly this: promoting one entry in a
  // multi-entry cart used to extend (and later expire) every sibling's
  // deadline right along with it.
  const overdue = await sql<{ id: string; division_id: string; group_id: string }[]>`
    select r.id, r.division_id, r.group_id
    from registrations r join registration_groups g on g.id = r.group_id
    where r.status = 'pending' and r.promoted_at is null and r.amount_cents > 0
      and g.payment_method = 'stripe'
      and g.expires_at is not null and g.expires_at < now()
    order by g.expires_at
    limit 200`;
  for (const { id, division_id } of overdue) {
    const outcome = (await sql.begin(async (tx) => {
      const [locked] = await tx<RegistrationWithGroupRow[]>`
        select ${regGroupCols(tx)}
        from registrations r join registration_groups g on g.id = r.group_id
        where r.id = ${id} for update`;
      if (
        !locked ||
        locked.status !== "pending" ||
        !locked.expires_at ||
        new Date(locked.expires_at) > new Date()
      ) {
        return null; // a webhook won the race, or the deadline moved
      }
      await tx`update registrations set status = 'expired', updated_at = now()
               where id = ${id}`;
      // RS009 — same reason withdrawCore does it: expiry is a status change,
      // so V388's cascade never fires and the placement would outlive the
      // entry that created it.
      await releaseSoloSignUpPlacement(tx, id);
      // RS002 W5 whole-branch review MAJOR: expiring the cart's LAST
      // `pending` entry used to leave `expires_at` stale forever — same gap
      // as withdrawCore, same fix.
      await clearExpiresIfNoLongerNeeded(tx, locked.group_id, locked.id);
      const settings = await loadSettings(tx, division_id);
      const [div] = await tx<{ competition_id: string; org_id: string }[]>`
        select competition_id, org_id from divisions where id = ${division_id}`;
      const promoted = await promoteOldestWaitlisted(tx, division_id, settings);
      await audit(tx, div.competition_id, div.org_id, "registration.expired", {
        registration_id: id,
        promoted_registration_id: promoted?.id ?? null,
      }, null);
      if (promoted) {
        await audit(tx, div.competition_id, div.org_id, "registration.promoted", {
          registration_id: promoted.id,
          from: "waitlist",
        }, null);
      }
      return { promoted, settings, competitionId: div.competition_id };
    })) as unknown as {
      promoted: RegistrationWithGroupRow | null;
      settings: RegistrationSettingsRow | null;
      competitionId: string;
    } | null;
    if (!outcome) continue;
    expired++;
    fireDivisionRevalidate(division_id, outcome.competitionId);
    if (outcome.promoted) {
      promotedCount++;
      const ctx = await divisionCtx(sql, division_id);
      await notifyPromoted(outcome.promoted, ctx, outcome.settings, origin);
    }
  }

  // Promotion lapse (V378/RS007) — the counterpart pass to the expiry loop
  // above, over the OTHER half of `pending`: rows `promoted_at is null`
  // never reaches. Falling off `promotion_expires_at` does not expire the
  // entry — owner ruling (see `_INDEX.md`'s RS007 section, "FALSE PREMISE —
  // verify RS002 shipped the lapse") is that it re-joins the waitlist TAIL
  // (`waitlisted_at = now()`, so `promoteOldestWaitlisted`'s
  // `coalesce(waitlisted_at, created_at)` sorts it behind anyone who has
  // been waiting since before this moment) and the freed slot is
  // immediately re-offered to the next candidate via the SAME
  // `promoteOldestWaitlisted` the expiry pass above uses — never a forked
  // copy. No join to `registration_groups` needed: every filter/order
  // column here is the entry's own.
  const lapsing = await sql<{ id: string; division_id: string }[]>`
    select r.id, r.division_id
    from registrations r
    where r.status = 'pending' and r.promoted_at is not null
      and r.promotion_expires_at is not null and r.promotion_expires_at < now()
    order by r.promotion_expires_at
    limit 200`;
  for (const { id, division_id } of lapsing) {
    const outcome = (await sql.begin(async (tx) => {
      const [locked] = await tx<RegistrationWithGroupRow[]>`
        select ${regGroupCols(tx)}
        from registrations r join registration_groups g on g.id = r.group_id
        where r.id = ${id} for update`;
      if (
        !locked ||
        locked.status !== "pending" ||
        !locked.promoted_at ||
        !locked.promotion_expires_at ||
        new Date(locked.promotion_expires_at) > new Date()
      ) {
        return null; // an organiser action won the race, or the deadline moved
      }
      // PR #677 finding L3, REJECTED after testing — `amount_cents` is
      // deliberately RETAINED here, and clearing it is a money defect.
      //
      // The finding reads the retained fee as breaking a "waitlisted rows
      // are 0 by construction" invariant. Two things are wrong with that.
      // First, the consumer it cites does not rely on the invariant:
      // `entryCountsTowardTotal`'s own comment says waitlisted is "excluded
      // here defensively rather than relied upon to always be zero".
      // Second, and decisively, this row's fee is still LOAD-BEARING after
      // the lapse: a checkout session minted before the deadline can still
      // complete afterwards, and `confirmPaidRegistration`'s `late` branch
      // refunds that payment using this very column. Zeroing it here makes
      // that refund £0.00 — the registrant pays, the entry stays
      // waitlisted, and the money is silently kept. Caught by
      // `registrations.test.ts`'s "a late payment against a promotion that
      // already LAPSED to waitlisted" (expected 500, got 0) while trying
      // the change; left here so the next reader does not retry it.
      await tx`
        update registrations
        set status = 'waitlisted', waitlisted_at = now(),
            promoted_at = null, promotion_expires_at = null, updated_at = now()
        where id = ${id}`;
      // Same stale-deadline gap as the expiry branch: if this was the cart's
      // LAST pending entry, nothing else needs the group's shared clock.
      await clearExpiresIfNoLongerNeeded(tx, locked.group_id, locked.id);
      const settings = await loadSettings(tx, division_id);
      const [div] = await tx<{ competition_id: string; org_id: string }[]>`
        select competition_id, org_id from divisions where id = ${division_id}`;
      // REVIEW FIX (money-path defect #5): exclude the row THIS pass just
      // lapsed — see promoteOldestWaitlisted's own doc comment for why
      // `for update skip locked` alone cannot stop this call from
      // re-selecting it.
      const promoted = await promoteOldestWaitlisted(tx, division_id, settings, id);
      await audit(tx, div.competition_id, div.org_id, "registration.promotion_lapsed", {
        registration_id: id,
        promoted_registration_id: promoted?.id ?? null,
      }, null);
      if (promoted) {
        await audit(tx, div.competition_id, div.org_id, "registration.promoted", {
          registration_id: promoted.id,
          from: "waitlist",
        }, null);
      }
      return { promoted, settings, competitionId: div.competition_id };
    })) as unknown as {
      promoted: RegistrationWithGroupRow | null;
      settings: RegistrationSettingsRow | null;
      competitionId: string;
    } | null;
    if (!outcome) continue;
    lapsedCount++;
    fireDivisionRevalidate(division_id, outcome.competitionId);
    if (outcome.promoted) {
      promotedCount++;
      const ctx = await divisionCtx(sql, division_id);
      await notifyPromoted(outcome.promoted, ctx, outcome.settings, origin);
    }
  }

  return { reminded, expired, promoted: promotedCount, lapsed: lapsedCount };
}

// ---------------------------------------------------------------------------
// Organiser: list / confirm / waitlist / withdraw / refund / export
// ---------------------------------------------------------------------------

export interface ListRegistrationsFilters {
  /** Required when `divisionId` is null (cross-division hub mode). When BOTH
   *  are given they must AGREE — a division belonging to another competition
   *  is a 404, not a silently-honoured override. This used to read "ignored
   *  otherwise", and the code matched: it was the cross-competition read that
   *  the RS005 W1b review caught (see the guard in `listRegistrations`). */
  competition_id?: string;
  kind?: RegistrationSettingsRow["entrant_kind"];
  free_agent?: boolean;
  /** At least one player on the entry still has `consent_status = 'pending'`. */
  consent_pending?: boolean;
  /** Matches the entry's display name or the cart's contact name/email. */
  text?: string;
  /** RS005 W1a. Default `"oldest"` is `order by r.created_at, r.id` —
   *  UNCHANGED from pre-W1a, so the live `/api/v1/divisions/[id]/registrations`
   *  route (which never sets this) keeps its existing response order.
   *  `"newest"` reverses both keys. */
  sort?: "newest" | "oldest";
}

/** The sport's roster-cap expression: `sports.position_catalog.lineup.size +
 *  .benchMax`, NULL when the sport declares no `lineup` key at all
 *  (unlimited) — the same rule `registration-submit.ts`'s `joinTeamEntry`
 *  (registration-submit.ts:742-748) already enforces at join time. Assumes
 *  the surrounding query joins the sports row as `sp` (a hardcoded alias,
 *  same convention as `regGroupCols`'s `r`/`g`).
 *
 *  This is the ONLY copy: RS005 W1b repointed `joinTeamEntry` at this export
 *  (`008b3da27`), so the join-time cap and the displayed roster fill can no
 *  longer drift. Do not re-inline it. */
export function rosterCapExpr(db: AnySql) {
  return db`(
    (sp.position_catalog -> 'lineup' ->> 'size')::int +
    coalesce((sp.position_catalog -> 'lineup' ->> 'benchMax')::int, 0)
  )`;
}

/** `listRegistrations`' row (RS005 W1a), widened for the Registrants tab:
 *  the division's own name/slug, its resolved `entrant_kind`, and three
 *  values no consumer should recompute itself — `roster_count`/`roster_cap`/
 *  `consent_pending_count` (per-entry correlated subqueries in the one query
 *  below, same no-N+1 convention `card-stats.ts`'s `listDivisionCardStats`
 *  already uses) and `waitlist_position` (tuple-comparison note on the query
 *  below). Deliberately DROPS `access_token_hash` — the list/export surface
 *  must never ship the cart's access-token hash to an organiser session; see
 *  the strip at the bottom of `listRegistrations`. */
export interface RegistrationListRow extends Omit<RegistrationWithGroupRow, "access_token_hash"> {
  division_name: string;
  division_slug: string;
  entrant_kind: RegistrationSettingsRow["entrant_kind"];
  roster_count: number;
  /** null = unlimited (the sport declares no lineup config). */
  roster_cap: number | null;
  consent_pending_count: number;
  /** 1-based rank within this row's DIVISION, `waitlisted` rows only; null
   *  for every other status. */
  waitlist_position: number | null;
  /** The DIVISION's approval mode (`registration_settings.approval`), not the
   *  entry's. RS005 W3 renders approve/reject only for a `manual` division —
   *  on an `auto` division `approveRegistration` refuses with a 422, so
   *  showing the control would offer an organiser a button that cannot work.
   *  `coalesce`d to 'auto' because a division with no settings row at all
   *  behaves exactly as auto (registration-approval.ts's own
   *  `loadApprovalSettings` reads it the same way). */
  approval: RegistrationSettingsRow["approval"];
  /** The DIVISION's LIVE entry fee, not this entry's frozen `amount_cents`.
   *
   *  Both server gates read the live value — `approveRegistration` refuses
   *  while a fee is outstanding, `markRegistrationPaidOffline` refuses when
   *  the division has no fee — while the row only carried the amount quoted
   *  at SUBMIT. `putRegistrationSettings` never re-quotes existing entries
   *  (it contains no `update registrations` at all), so the two diverge the
   *  moment an organiser edits a fee, and the UI then offers whichever
   *  control the server refuses: raise 0 -> 20.00 and Approve renders but
   *  422s "mark it paid first" while Mark paid is hidden; drop 20.00 -> 0 and
   *  the mirror image. Either way the organiser is stuck with no working
   *  control.
   *
   *  Carried on the row so the client gates on exactly what the server gates
   *  on, correct on FIRST render. Costs nothing: `registration_settings` is
   *  already LEFT JOINed for `entrant_kind`/`approval`. */
  division_fee_cents: number;
  /**
   * RS009 — where a SOLO SIGN-UP currently sits, or null while they are
   * still in the pool. Null on every non-solo-sign-up row.
   *
   * Derived from the roster row pointing back at this entry
   * (`registration_players.assigned_from_registration_id`, unique where
   * non-null), never from a mirrored column on `registrations` — the pool
   * and the roster must not be able to disagree.
   */
  assigned_team_id: string | null;
  assigned_team_name: string | null;
  /**
   * RS009 — the solo sign-up's OWN gender, when the division collected one.
   * The assign sheet needs it to predict a mixed division's refusal BEFORE
   * the organiser spends a click. Null means unknown, and the sheet must
   * then predict nothing rather than guess.
   */
  player_gender: string | null;
  /**
   * RS009 — has this row's division started, in the sense that its rosters
   * are no longer the organiser's to shuffle? True once the division has any
   * fixture, or once the competition's own `starts_on` has passed. Mirrors
   * `unassignSoloSignUp`'s refusal exactly, so the hub never renders a
   * Remove button the server will refuse — the same rule
   * `division_fee_cents` was added for (a control that cannot work is worse
   * than no control).
   */
  division_started: boolean;
}

/** Raw wire shape — `RegistrationListRow` plus the hash the query still
 *  selects (via the shared `regGroupCols`) but the function strips before
 *  returning. */
type RawListRow = RegistrationListRow & { access_token_hash: string };

/**
 * Organiser registration list. `divisionId` scopes to ONE division exactly as
 * before — the LIVE `/api/v1/divisions/[id]/registrations` route calls this
 * with 3 positional args and must keep compiling and behaving identically
 * (RS002 W5 owns no route-handler changes). Pass `null` for the
 * competition-wide hub view (design: "competition-level Registration hub",
 * owner ruling 2) and set `filters.competition_id` instead.
 *
 * `filters.kind` needs the join to `registration_settings`: `entrant_kind` is
 * a DIVISION-level setting, not stored per-entry, so it is only a meaningful
 * filter once a call can span more than one division — scoped to a single
 * division every row already shares one kind. LEFT JOIN, not INNER: some
 * rows in this table predate any `registration_settings` row for their
 * division existing at all (direct-SQL test fixtures — see
 * `seedRegistration` in the test file), and an INNER JOIN would silently
 * drop those rows for the EXISTING single-division callers — a regression
 * this extension must not cause.
 *
 * RS005 W1a: widened the row (`RegistrationListRow`) and added `filters.sort`.
 * `sports` is joined INNER, not LEFT, unlike `registration_settings` above —
 * `divisions.sport_key` is `not null references sports(key)` (V209), so
 * every division has exactly one sport row and this join can never drop one.
 * `waitlist_position`'s subquery counts waitlisted SIBLINGS (same division)
 * whose `(created_at, id)` tuple sorts strictly before this row's own, +1 —
 * exactly `promoteOldestWaitlisted`'s (this file) own `order by created_at,
 * id limit 1`, so position 1 is that function's pick on a quiescent table.
 *
 * It is a SNAPSHOT of that order, not a lock on it, and the difference is
 * reachable: `promoteOldestWaitlisted` picks `for update skip locked`, so
 * while another transaction holds the rank-1 row (a concurrent promotion, a
 * withdraw's auto-promote, a refund) it promotes rank 2 instead, while this
 * plain count still reports the locked row as #1. The organiser sees a
 * position that was true when the page was rendered. Do NOT "fix" this by
 * adding `skip locked` to the read — a display query that silently omits
 * locked rows renumbers the whole queue under load, which is worse than a
 * stale number. The ordering rule is what must not fork; the instant it is
 * sampled may differ.
 */
export async function listRegistrations(
  auth: AuthCtx,
  divisionId: string | null,
  status: string | null,
  filters: ListRegistrationsFilters = {},
): Promise<RegistrationListRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    let competitionId: string;
    if (divisionId) {
      const [division] = await tx<{ competition_id: string }[]>`
        select competition_id from divisions where id = ${divisionId}`;
      if (!division) throw new HttpError(404, "division not found");
      // SECURITY (RS005 W1b review, BLOCKER): when the caller named BOTH, the
      // two must agree. This branch used to derive the competition from the
      // division and silently DISCARD `filters.competition_id`, so a request
      // addressed to competition A carrying a `division_id` from competition B
      // returned B's rows under a 200 from A's URL.
      //
      // Same-org only (`withTenant` still scopes the read), so for a session
      // user it leaks nothing they could not reach through B's own URL. The
      // real breach is the API-key competition pin: `apiKeyAuth` resolves the
      // pin from the URL PATH resource (`api-v1/auth.ts:162-172`,
      // `resolvePinCompetition`) and never looks at query parameters, so a key
      // pinned to A satisfied the pin on A's path and then read — and CSV
      // exported — B's contact names, emails, answers and payment state. The
      // pin is the entire boundary that endpoint sells.
      //
      // 404, not 403: the repo's existing convention for a pin miss is that it
      // adds no existence oracle (same comment at `resolvePinCompetition`), and
      // a caller who may not scope to this division must not learn it exists.
      if (filters.competition_id && division.competition_id !== filters.competition_id) {
        throw new HttpError(404, "division not found");
      }
      competitionId = division.competition_id;
    } else {
      if (!filters.competition_id) {
        throw new HttpError(400, "competition_id is required when no division is given");
      }
      const [competition] = await tx`select 1 from competitions where id = ${filters.competition_id}`;
      if (!competition) throw new HttpError(404, "competition not found");
      competitionId = filters.competition_id;
    }
    const text = filters.text?.trim();
    // LIKE metacharacters (`%`/`_`) in the search text must match LITERALLY,
    // not as wildcards (RS005 F1 finding 4) — a registrant's own contact
    // details routinely contain them ("100% Effort", "john_smith@…"), and
    // left unescaped they turned an ordinary-looking search into an
    // accidental wildcard that over-matched unrelated rows. `\` is escaped
    // too: it is Postgres's OWN default LIKE escape character even with no
    // explicit ESCAPE clause, so a literal `\` in the search text would
    // otherwise start escaping whatever follows it instead of matching
    // itself.
    const likePattern = (s: string) => "%" + s.replace(/[\\%_]/g, "\\$&") + "%";
    const rows = await tx<RawListRow[]>`
      select ${regGroupCols(tx)},
        d.name as division_name,
        d.slug as division_slug,
        coalesce(rs.entrant_kind, 'individual') as entrant_kind,
        coalesce(rs.approval, 'auto') as approval,
        coalesce(rs.fee_cents, 0) as division_fee_cents,
        (select count(*)::int from registration_players rp
          where rp.registration_id = r.id) as roster_count,
        ${rosterCapExpr(tx)} as roster_cap,
        (select count(*)::int from registration_players rp
          where rp.registration_id = r.id and rp.consent_status = 'pending') as consent_pending_count,
        (select tgt.id from registration_players rp
          join registrations tgt on tgt.id = rp.registration_id
          where rp.assigned_from_registration_id = r.id) as assigned_team_id,
        (select tgt.display_name from registration_players rp
          join registrations tgt on tgt.id = rp.registration_id
          where rp.assigned_from_registration_id = r.id) as assigned_team_name,
        (select rp.gender from registration_players rp
          where rp.registration_id = r.id
          order by rp.created_at, rp.id limit 1) as player_gender,
        (exists (select 1 from fixtures f where f.division_id = r.division_id)
          or (c.starts_on is not null and c.starts_on <= current_date)) as division_started,
        case when r.status = 'waitlisted' then (
          (select count(*)::int from registrations w
            where w.division_id = r.division_id and w.status = 'waitlisted'
              and (w.created_at, w.id) < (r.created_at, r.id)) + 1
        ) else null end as waitlist_position
      from registrations r
      join registration_groups g on g.id = r.group_id
      join divisions d on d.id = r.division_id
      join competitions c on c.id = d.competition_id
      join sports sp on sp.key = d.sport_key
      left join registration_settings rs on rs.division_id = r.division_id
      where d.competition_id = ${competitionId}
        ${divisionId ? tx`and r.division_id = ${divisionId}` : tx``}
        ${status ? tx`and r.status = ${status}` : tx``}
        ${
          // coalesce, matching the SELECT above. A division with no
          // registration_settings row DISPLAYS as 'individual' (that is what
          // the LEFT JOIN is for — those rows are real), but a bare
          // `rs.entrant_kind = 'individual'` is NULL-false for exactly them:
          // the row an organiser can see in the table vanished the moment they
          // filtered for the kind it was showing. Filter and column must read
          // the same expression or the list contradicts itself.
          filters.kind ? tx`and coalesce(rs.entrant_kind, 'individual') = ${filters.kind}` : tx``
        }
        ${filters.free_agent !== undefined ? tx`and r.free_agent = ${filters.free_agent}` : tx``}
        ${
          // `!== undefined`, like free_agent above — not truthiness. Both are
          // documented as 1|0 and the query parser maps "0" to false, so
          // truthiness made `consent_pending=0` mean "no filter" while
          // `free_agent=0` filtered: the same documented input behaving two
          // different ways one line apart. `0` now means what it says —
          // entries with nothing outstanding.
          filters.consent_pending !== undefined
            ? filters.consent_pending
              ? tx`and exists (
                  select 1 from registration_players rp
                  where rp.registration_id = r.id and rp.consent_status = 'pending'
                )`
              : tx`and not exists (
                  select 1 from registration_players rp
                  where rp.registration_id = r.id and rp.consent_status = 'pending'
                )`
            : tx``
        }
        ${
          text
            ? tx`and (r.display_name ilike ${likePattern(text)} escape '\\'
                  or g.contact_name ilike ${likePattern(text)} escape '\\'
                  or g.contact_email ilike ${likePattern(text)} escape '\\')`
            : tx``
        }
      ${filters.sort === "newest" ? tx`order by r.created_at desc, r.id desc` : tx`order by r.created_at, r.id`}`;
    // Never ship the cart's access-token hash to the organiser list/export
    // surface (RS005 W1a). regGroupCols stays the ONE shared column list —
    // other callers legitimately need the hash for token verification — so
    // it is stripped here in JS rather than forked into a second hand-copied
    // SELECT list.
    //
    // `join_code` is stripped for anyone who cannot already write (RS005
    // whole-branch review, BLOCKER). It is a BEARER CREDENTIAL, not a display
    // field: `POST /public/.../register/join` accepts it from anyone and mints
    // a roster row, and RS001 made it globally unique so it needs no other
    // context to resolve. `read` scope is `READ_ROLES` — owner, admin AND
    // viewer — so both list routes were handing a write-capable secret to a
    // read-only role in one GET. The UI had it right (the detail body gates the
    // copy control on canEdit and never puts the code in the RSC payload); the
    // JSON API, which the same viewer session can simply request, did not.
    //
    // Gated on EDITOR_ROLES rather than "not viewer": an API key resolves
    // `role: null` regardless of its scopes, and a key that cannot be shown to
    // be write-capable should not receive a write-capable credential either.
    // If an integration ever needs join codes, that is a deliberate decision
    // with its own scope check — not a default.
    const mayHoldJoinCode = mayHoldBearerCredential(auth.role);
    return rows.map(({ access_token_hash: _accessTokenHash, ...rest }) =>
      mayHoldJoinCode ? rest : { ...rest, join_code: null },
    );
  });
}

/** Exported for `registration-approval.ts` (RS002 W5) — approve/reject/
 *  promote all load-and-lock a registration under `withTenant` the same way
 *  `confirmRegistration` et al. already do. */
export async function orgReg(tx: Tx, regId: string): Promise<RegistrationWithGroupRow> {
  const [reg] = await tx<RegistrationWithGroupRow[]>`
    select ${regGroupCols(tx)}
    from registrations r join registration_groups g on g.id = r.group_id
    where r.id = ${regId} for update`;
  if (!reg) throw new HttpError(404, "registration not found");
  return reg;
}

/** Organiser approve (free regs and waitlist overrides). Paid-division regs
 *  must be paid first — confirming an unpaid one would gift the spot. */
export async function confirmRegistration(auth: AuthCtx, regId: string): Promise<RegistrationWithGroupRow> {
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  const row = await withTenant(auth.orgId, async (tx) => {
    const reg = await orgReg(tx, regId);
    if (reg.status === "confirmed") return reg;
    // RULING A (RS002 W5 review, BLOCKER): rejected is terminal from EVERY
    // writer — an organiser explicitly confirming stays allowed on a manual
    // division (ruling B), but never on a REJECTED row regardless of mode.
    // Checked before the withdrawn check for the same reason: both are dead
    // ends, but rejected needs its own message.
    if (reg.status === "rejected") {
      throw new HttpError(422, "This registration was rejected and cannot be confirmed");
    }
    if (reg.status === "withdrawn") throw new HttpError(422, "registration is withdrawn");
    const settings = await loadSettings(tx, reg.division_id);
    if ((settings?.fee_cents ?? 0) > 0 && reg.status !== "paid" && reg.payment_intent_id === null) {
      throw new HttpError(
        422,
        "Awaiting payment — use Mark paid once the fee arrives, or Confirm without payment to waive it",
      );
    }
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    assertNotFrozen(frozen, div.competition_id);
    await materialise(tx, reg, settings?.entrant_kind ?? "individual");
    await audit(tx, div.competition_id, auth.orgId, "registration.confirmed", {
      registration_id: regId,
      paid: reg.status === "paid",
    }, auth.userId);
    return orgRegAfter(tx, regId);
  });
  fireDivisionRevalidate(row.division_id);
  // RS008: fire-and-forget, strictly AFTER the transaction above has
  // committed. `row.entrant_id` is null on an early-return before
  // materialise() ever ran (never happens for this function today, but
  // harmless either way); the open-claim guard inside makes a repeat sweep
  // of an already-confirmed row a cheap no-op.
  if (row.entrant_id) void inviteUnclaimedMembers(row.org_id, row.entrant_id);
  return row;
}

/** Organiser: record an offline (cash/bank) payment — confirms in the same tx
 *  (payment = approval, spec §2). Card-paid rows are refused: their money
 *  trail lives on Stripe and must stay refundable there. */
export async function markRegistrationPaidOffline(
  auth: AuthCtx,
  regId: string,
): Promise<RegistrationWithGroupRow> {
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  const row = await withTenant(auth.orgId, async (tx) => {
    const reg = await orgReg(tx, regId);
    // RULING A (RS002 W5 review, BLOCKER): rejected is terminal from every
    // writer. Already implied by the `!== "pending"` check below (rejected
    // is never pending), but explicit and first — self-documenting, and
    // matches the SAME guard on confirmRegistration/confirmRegistrationWaived
    // rather than relying on an allowlist to accidentally encode it.
    if (reg.status === "rejected") {
      throw new HttpError(422, "This registration was rejected and cannot be marked paid");
    }
    if (reg.status !== "pending") {
      throw new HttpError(422, `Only pending registrations can be marked paid (this one is ${reg.status})`);
    }
    if (reg.payment_intent_id) {
      throw new HttpError(422, "This registration was paid by card — refund it on the payments trail instead");
    }
    const settings = await loadSettings(tx, reg.division_id);
    if ((settings?.fee_cents ?? 0) <= 0) {
      throw new HttpError(422, "This division has no entry fee");
    }
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    assertNotFrozen(frozen, div.competition_id);
    await tx`
      update registrations set status = 'paid', updated_at = now()
      where id = ${regId}`;
    // offline_marked_paid_at/by live on the cart now (V364).
    await tx`
      update registration_groups
      set offline_marked_paid_at = now(), offline_marked_paid_by = ${auth.userId}, updated_at = now()
      where id = ${reg.group_id}`;
    await materialise(tx, { ...reg, status: "paid" }, settings?.entrant_kind ?? "individual");
    await audit(tx, div.competition_id, auth.orgId, "registration.offline_paid", {
      registration_id: regId,
      amount_cents: reg.amount_cents,
    }, auth.userId);
    return orgRegAfter(tx, regId);
  });
  fireDivisionRevalidate(row.division_id);
  // RS008: fire-and-forget, strictly AFTER the transaction above has
  // committed — see confirmRegistration's identical wiring for why.
  if (row.entrant_id) void inviteUnclaimedMembers(row.org_id, row.entrant_id);
  return row;
}

/** Organiser: confirm while waiving the fee (comped entry) — audited. */
export async function confirmRegistrationWaived(
  auth: AuthCtx,
  regId: string,
): Promise<RegistrationWithGroupRow> {
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  const row = await withTenant(auth.orgId, async (tx) => {
    const reg = await orgReg(tx, regId);
    if (reg.status === "confirmed") return orgRegAfter(tx, regId);
    // RULING A (RS002 W5 review, BLOCKER): rejected is terminal from every
    // writer. Already implied by the allowlist below (rejected is neither
    // pending nor waitlisted), but explicit and first for the same reason as
    // markRegistrationPaidOffline's twin guard.
    if (reg.status === "rejected") {
      throw new HttpError(422, "This registration was rejected and cannot be confirmed");
    }
    if (!["pending", "waitlisted"].includes(reg.status)) {
      throw new HttpError(422, `Cannot confirm a ${reg.status} registration`);
    }
    const settings = await loadSettings(tx, reg.division_id);
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    assertNotFrozen(frozen, div.competition_id);
    await materialise(tx, reg, settings?.entrant_kind ?? "individual");
    await audit(tx, div.competition_id, auth.orgId, "registration.fee_waived", {
      registration_id: regId,
      fee_cents: settings?.fee_cents ?? 0,
    }, auth.userId);
    return orgRegAfter(tx, regId);
  });
  fireDivisionRevalidate(row.division_id);
  // RS008: fire-and-forget, strictly AFTER the transaction above has
  // committed — see confirmRegistration's identical wiring for why.
  if (row.entrant_id) void inviteUnclaimedMembers(row.org_id, row.entrant_id);
  return row;
}

/** Organiser: email an unpaid (offline) registrant a payment reminder. */
export async function sendPaymentReminder(
  auth: AuthCtx,
  regId: string,
): Promise<{ sent: boolean }> {
  const reg = await withTenant(auth.orgId, (tx) => orgReg(tx, regId));
  const settings = await loadSettings(sql, reg.division_id);
  const fee = settings?.fee_cents ?? 0;
  if (fee <= 0) throw new HttpError(422, "This division has no entry fee.");
  if (reg.status !== "pending") {
    throw new HttpError(422, "Payment reminders only apply to pending registrations.");
  }
  const ctx = await divisionCtx(sql, reg.division_id);
  const sent = await sendPaymentReminderEmail({
    to: reg.contact_email,
    locale: toLocale(reg.locale),
    orgName: ctx.org_name,
    competitionName: ctx.comp_name,
    displayName: reg.display_name,
    feeCents: fee,
    currency: reg.currency,
    // Division override first, org-wide fallback — same resolution as the
    // confirmation email; refCode personalises {{reference}}.
    paymentInstructions: settings?.payment_instructions ?? ctx.payment_instructions,
    refCode: reg.ref_code,
  });
  await withTenant(auth.orgId, (tx) =>
    audit(tx, ctx.competition_id, auth.orgId, "registration.payment_reminded", { registration_id: regId }, auth.userId),
  );
  return { sent };
}

/** Exported for `registration-approval.ts` (RS002 W5) — same
 *  reload-without-lock read `confirmRegistration` et al. return after their
 *  own mutation. */
export async function orgRegAfter(tx: Tx, regId: string): Promise<RegistrationWithGroupRow> {
  const [reg] = await tx<RegistrationWithGroupRow[]>`
    select ${regGroupCols(tx)}
    from registrations r join registration_groups g on g.id = r.group_id
    where r.id = ${regId}`;
  return reg;
}

/** Organiser: push a pending registration to the waitlist. */
export async function waitlistRegistration(auth: AuthCtx, regId: string): Promise<RegistrationWithGroupRow> {
  return withTenant(auth.orgId, async (tx) => {
    const reg = await orgReg(tx, regId);
    if (reg.status !== "pending") {
      throw new HttpError(422, `Only pending registrations can be waitlisted (this one is ${reg.status})`);
    }
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    await tx`
      update registrations set status = 'waitlisted', updated_at = now()
      where id = ${regId}`;
    await audit(tx, div.competition_id, auth.orgId, "registration.waitlisted", {
      registration_id: regId,
    }, auth.userId);
    return orgRegAfter(tx, regId);
  });
}

/** Organiser withdraw — same core as the registrant path (audited actor). */
export async function withdrawRegistrationOrganiser(
  auth: AuthCtx,
  regId: string,
): Promise<RegistrationWithGroupRow> {
  const reg = await withTenant(auth.orgId, async (tx) => orgReg(tx, regId));
  await withdrawCore(reg, auth.userId);
  return withTenant(auth.orgId, async (tx) => orgRegAfter(tx, regId));
}

/** Manual refund (post-lock organiser discretion; partial allowed). */
export async function refundRegistration(
  auth: AuthCtx,
  regId: string,
  amountCents: number | undefined,
): Promise<RegistrationWithGroupRow> {
  const reg = await withTenant(auth.orgId, async (tx) => orgReg(tx, regId));
  if (!reg.payment_intent_id) throw new HttpError(422, "No payment to refund");
  // RS002 (V368): reg.refunded_cents is THIS entry's own column now (hazard 3
  // fixed) — a sibling's earlier refund can no longer drive this negative and
  // falsely report an untouched entry as "already fully refunded".
  const remaining = reg.amount_cents - reg.refunded_cents;
  if (remaining <= 0) throw new HttpError(422, "Already fully refunded");
  const amount = amountCents ?? remaining;
  if (amount > remaining) {
    throw new HttpError(422, `Refund exceeds the remaining ${remaining} cents`);
  }
  const refund = await stripeRefund(reg.payment_intent_id, amount);
  const row = await withTenant(auth.orgId, async (tx) => {
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    // Additive on BOTH tables: this entry's own total (V368) and the cart's
    // accumulated total (V364) — never overwrite either.
    await tx`
      update registrations
      set refunded_cents = refunded_cents + ${amount}, updated_at = now()
      where id = ${regId}`;
    await tx`
      update registration_groups
      set refunded_cents = refunded_cents + ${amount}, refunded_at = now(), updated_at = now()
      where id = ${reg.group_id}`;
    await audit(tx, div.competition_id, auth.orgId, "registration.refunded", {
      registration_id: regId,
      amount_cents: amount,
      mode: "manual",
      stripe_refund_id: refund.id,
    }, auth.userId);
    return orgRegAfter(tx, regId);
  });
  notifyRefund(reg, await divisionCtx(sql, reg.division_id), amount);
  return row;
}

/** CSV export (organiser console; gated on the `exports` entitlement, doc 10
 *  §1). Plain `exports` reaches community in **V285** ("Free plain exports",
 *  v12); pro/business have held it since V101/V112 and event_pass since V270.
 *  The Pro-only half is `exports.branded` — and not Pro-ONLY either: V306
 *  grants it to event_pass as well (`lib/pass-features.ts:34`). So a denial
 *  here means an explicit org override, never a plan tier.
 *
 * RS005 W1a replaces the old division-only, entry-flat exporter. Rows come
 * from `listRegistrations` — the SAME read model the Registrants tab uses,
 * no second query builds the entry set — scoped by `opts.divisionId` (one
 * division) or `opts.competitionId`/`opts.filters.competition_id`
 * (competition-wide; `listRegistrations` itself 400s if neither is given).
 *
 * RULING (RS005 W1a): one CSV row per PLAYER. An entry with N players emits
 * N rows with its entry columns repeated; an entry with ZERO players (a free
 * agent, or a team registered with an empty roster) emits ONE row with the
 * player columns blank — dropping it would silently hide that entry from
 * the export entirely.
 */
export async function exportRegistrationsCsv(
  auth: AuthCtx,
  opts: {
    divisionId?: string | null;
    competitionId?: string | null;
    status?: string | null;
    filters?: ListRegistrationsFilters;
  },
): Promise<string> {
  await requireFeature(auth.orgId, "exports");
  const divisionId = opts.divisionId ?? null;
  const filters: ListRegistrationsFilters = opts.competitionId
    ? { ...(opts.filters ?? {}), competition_id: opts.competitionId }
    : (opts.filters ?? {});
  const rows = await listRegistrations(auth, divisionId, opts.status ?? null, filters);

  // The field-key scope is the DIVISIONS THE EXPORT COVERS, not the divisions
  // that happen to appear in `rows`. Deriving it from the rows makes the header
  // depend on the filter: `?status=rejected` with no matches emitted a header
  // with no question columns at all, and a competition-wide export's column set
  // shifted as the filter changed — so two exports of the same competition
  // could not be fed to the same importer. The old division-only exporter read
  // the division's own form_fields and could not express this bug.
  const scopeDivisionIds = divisionId
    ? [divisionId]
    : await withTenant(auth.orgId, (tx) =>
        tx<{ id: string }[]>`
          select d.id from divisions d
          where d.competition_id = ${filters.competition_id ?? null}
        `.then((ds) => ds.map((d) => d.id)),
      );
  const divisionIds = scopeDivisionIds.length > 0
    ? scopeDivisionIds
    : [...new Set(rows.map((r) => r.division_id))];
  const regIds = rows.map((r) => r.id);
  type PlayerCsvRow = {
    registration_id: string;
    full_name: string;
    dob: string | null;
    gender: string | null;
    consent_status: string;
    squad_number: number | null;
    is_captain: boolean;
  };
  const { fieldKeys, playersByReg } = await withTenant(auth.orgId, async (tx) => {
    // Form field keys: the union of every IN-SCOPE division's settings, so a
    // competition-wide export is not shaped like any single division's form.
    const fieldKeySet = new Set<string>();
    if (divisionIds.length > 0) {
      const settingsRows = await tx<{ form_fields: RegistrationFormField[] }[]>`
        select form_fields from registration_settings where division_id in ${tx(divisionIds)}`;
      for (const s of settingsRows) for (const f of s.form_fields ?? []) fieldKeySet.add(f.key);
    }
    const players =
      regIds.length > 0
        ? await tx<PlayerCsvRow[]>`
            select registration_id, full_name, dob, gender, consent_status, squad_number, is_captain
            from registration_players
            where registration_id in ${tx(regIds)}
            order by is_captain desc, created_at`
        : [];
    const playersByReg = new Map<string, PlayerCsvRow[]>();
    for (const p of players) {
      const list = playersByReg.get(p.registration_id) ?? [];
      list.push(p);
      playersByReg.set(p.registration_id, list);
    }
    return { fieldKeys: [...fieldKeySet].sort(), playersByReg };
  });

  const esc = (v: unknown): string => {
    let s = v === null || v === undefined ? "" : String(v);
    // CSV/formula injection (RS005 F1 finding 3, OWASP's standard
    // mitigation): Excel/LibreOffice evaluate a cell as a formula when it
    // starts with =, +, -, @, or (some parsers, after stripping leading
    // whitespace) TAB/CR — and this exporter's sink is registrant-controlled
    // (contact_name, per-player full_name), so a name like
    // `=cmd|'/c calc'!A1` or `@SUM(1+1)` was written raw and evaluated on
    // open. Prepending a bare apostrophe forces every spreadsheet reader to
    // treat the cell as literal text.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    // `\r` joins the quoting trigger, not just `,`/`"`/`\n`: unquoted, a
    // lone CR inside a value reads as a row break to a universal-newline CSV
    // reader and silently splits one row into two.
    return /["\n\r,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  // Per-player DOB and GENDER are editor-only (RS005 whole-branch review).
  // The owner's ruling deliberately allows a VIEWER to export — that is the
  // point of a read-only seat that can still do the federation paperwork — but
  // it weighed the join code, not this: dob/gender appear on NO UI surface for
  // ANY role, so the export is the only path to them, and much of it is
  // minor-attendee personal data leaving the platform as a file.
  //
  // The columns are OMITTED, not blanked. A blank column in a file headed
  // `player_dob` reads as "we hold no date of birth", which is a different and
  // false statement — and a spreadsheet built against that header would
  // silently gain two empty columns depending on who exported it.
  const maySeePlayerPersonalData = mayHoldBearerCredential(auth.role);
  const playerHeader = maySeePlayerPersonalData
    ? ["player_name", "player_dob", "player_gender", "player_consent_status", "squad_number", "is_captain"]
    : ["player_name", "player_consent_status", "squad_number", "is_captain"];

  // `id` + `registration_id` (RS005 F1 finding 5): main's exporter emitted
  // one row per REGISTRATION under the column name `id`. RS005 W1a widened
  // this to one row per PLAYER — a deliberate ruling (see this function's
  // own doc comment above) kept as-is here, not reverted — but renamed the
  // identifier column to `registration_id` and dropped `id` outright, with
  // no response schema in openapi.ts for any drift gate to catch it. `id`
  // is restored here, first column, byte-identical to `registration_id` on
  // every row: an integration reading the OLD column name still finds the
  // registration's id (now simply repeated once per player row) rather
  // than losing it. See openapi.ts's summary for both export routes for the
  // documented shape.
  const header = [
    "id", "registration_id", "ref_code", "division", "status", "kind", "display_name",
    "contact_name", "contact_email", "amount_cents", "currency", "refunded_cents",
    "payment_method", "waitlist_position", "created_at",
    ...playerHeader,
    ...fieldKeys,
  ];
  const lines: string[] = [];
  for (const r of rows) {
    const entryCols = [
      r.id, r.id, r.ref_code, r.division_name, r.status, r.entrant_kind, r.display_name,
      r.contact_name, r.contact_email, r.amount_cents, r.currency, r.refunded_cents,
      r.payment_method, r.waitlist_position, new Date(r.created_at).toISOString(),
    ];
    const answerCols = fieldKeys.map((k) => (r.answers as Record<string, unknown>)[k] ?? "");
    const players = playersByReg.get(r.id) ?? [];
    if (players.length === 0) {
      // One blank cell per player column, whichever set is in force — derived
      // from playerHeader so the two can never fall out of step.
      lines.push([...entryCols, ...playerHeader.map(() => ""), ...answerCols].map(esc).join(","));
    } else {
      for (const p of players) {
        const playerCols = maySeePlayerPersonalData
          ? [p.full_name, p.dob, p.gender, p.consent_status, p.squad_number, p.is_captain]
          : [p.full_name, p.consent_status, p.squad_number, p.is_captain];
        lines.push([...entryCols, ...playerCols, ...answerCols].map(esc).join(","));
      }
    }
  }
  return [header.join(","), ...lines].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// .ics confirmation attachment (doc 16 §1.1 / PROMPT-20a item 3)
// ---------------------------------------------------------------------------

/** `reg.status` → the (currently unwired elsewhere) `reg.status.*` label
 *  vocabulary, reused here for the ICS DESCRIPTION (B2). "rejected" has no
 *  key yet, so it falls through to the raw status word below — the same
 *  fallback the pre-B2 code effectively had for every status. */
const REG_ICS_STATUS_KEY: Partial<Record<RegistrationRow["status"], Parameters<typeof msgFor>[1]>> = {
  pending: "reg.status.pending",
  paid: "reg.status.paid",
  confirmed: "reg.status.confirmed",
  waitlisted: "reg.status.waitlisted",
  withdrawn: "reg.status.withdrawn",
  expired: "reg.status.expired",
};

/**
 * Confirmation .ics for the competition dates (doc 16 §1.1 / PROMPT-20a item
 * 3). A LOCAL builder, not buildIcs (public-site.ts) — buildIcs's IcsEvent
 * shape can't carry this event's multi-day span, its lack of a STATUS line,
 * or its registration-specific PRODID without either collapsing the span to
 * one day or double-suffixing the UID (review finding; each PRESERVED
 * behaviour is pinned by its own test in registrations.test.ts). Reuses
 * buildIcs's own foldLine + icsText so the two VCALENDAR emitters don't
 * drift on RFC 5545 mechanics (line folding, TEXT escaping).
 */
export async function registrationIcs(regId: string, token: string): Promise<string> {
  const reg = await regByToken(regId, token);
  const ctx = await divisionCtx(sql, reg.division_id);
  const [div] = await sql<{ name: string }[]>`
    select name from divisions where id = ${reg.division_id}`;
  // This attachment is addressed to ONE specific person, unlike
  // calendar.ics's division-wide feed (which has no single "whose locale"
  // and resolves org.default_locale instead) — so it resolves the
  // registrant's OWN locale, the same signal notifyRefund and every other
  // post-signup email in this file already reads via toLocale(reg.locale).
  const locale = toLocale(reg.locale);
  const lookup = (
    k: Parameters<typeof msgFor>[1],
    v?: Record<string, string | number>,
  ) => msgFor(locale, k, v);

  const start = (ctx.starts_on ?? new Date().toISOString().slice(0, 10)).replace(/-/g, "");
  // DTEND is exclusive for all-day events.
  const endDate = ctx.ends_on ?? ctx.starts_on ?? new Date().toISOString().slice(0, 10);
  const end = new Date(new Date(`${endDate}T00:00:00Z`).getTime() + 86_400_000)
    .toISOString().slice(0, 10).replace(/-/g, "");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

  const statusKey = REG_ICS_STATUS_KEY[reg.status];
  const description = lookup("calendar.registrationDescription", {
    name: reg.display_name,
    status: statusKey ? lookup(statusKey) : reg.status,
  });

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//seazn.club//registration//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:registration-${reg.id}@seazn.club`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${start}`,
    `DTEND;VALUE=DATE:${end}`,
    `SUMMARY:${icsText(`${ctx.comp_name} — ${div?.name ?? ""}`)}`,
    `DESCRIPTION:${icsText(description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Dispute evidence pack
// ---------------------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function evidenceRow(label: string, value: string): string {
  return `<tr><td style="padding:6px 14px 6px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${esc(label)}</td><td style="padding:6px 0;font-weight:600">${esc(value)}</td></tr>`;
}

/**
 * Everything the platform holds that shows a disputed entry was genuine, as
 * one printable HTML document mapped to Stripe's evidence fields: the
 * registration record, the reconstructed confirmation email (receipt +
 * customer communication), the audit trail (activity log) and the entrant's
 * fixtures (service provided). Organisers download it from the flagged row
 * and paste/upload into the dispute response.
 */
export async function buildDisputeEvidence(
  auth: AuthCtx,
  regId: string,
  origin: string,
): Promise<{ ref: string; html: string }> {
  const reg = await withTenant(auth.orgId, (tx) => orgReg(tx, regId));
  const ctx = await divisionCtx(sql, reg.division_id);
  const [division] = await sql<{ name: string }[]>`
    select name from divisions where id = ${reg.division_id}`;

  const events = await sql<{ type: string; payload: unknown; created_at: Date }[]>`
    select type, payload, created_at from competition_events
    where competition_id = ${ctx.competition_id}
      and payload->>'registration_id' = ${regId}
    order by created_at`;

  // P9 cutover: venue is DERIVED from venues.name via fixtures.venue_id —
  // fixtures.venue (frozen since pass 3a) would silently blank the "service
  // provided" venue line on this Stripe dispute evidence document for any
  // fixture played after the cutover.
  const fixtures = reg.entrant_id
    ? await sql<
        { round_no: number | null; status: string; outcome: unknown; scheduled_at: Date | null; venue: string | null }[]
      >`
      select f.round_no, f.status, f.outcome, f.scheduled_at, ven.name as venue
      from fixtures f
      left join venues ven on ven.id = f.venue_id
      where f.home_entrant_id = ${reg.entrant_id} or f.away_entrant_id = ${reg.entrant_id}
      order by f.round_no nulls last, f.scheduled_at nulls last`
    : [];

  // The transactional receipt, reconstructed with the exact sender inputs.
  // RS005 W4: the sent mail is now CART-shaped (owner ruling 2026-08-25), so
  // this reconstructs the WHOLE cart via the same `buildCartMail` the
  // submit-time send and the resend action use — not just `reg`'s own
  // entry, which would again attest to a message shape that was never
  // actually sent whenever this entry has cart-mates. `paymentInstructions`/
  // `payDeadline` are forced null exactly as before this wave: instructions
  // can change after the original send, and a reconstruction is not the
  // place to guess whether they did (division settings are otherwise no
  // longer among the inputs here — currency is the CART's snapshot,
  // RS001b — which is also the more honest source for dispute evidence,
  // since it is what the registrant was actually charged in rather than
  // what the division is configured for today).
  const { registrationTemplate } = await import("@/lib/email-templates");
  const { getDictionary } = await import("@/lib/i18n");
  const cartMail = await buildCartMail(reg.group_id, origin, null, null);
  // Reconstruct the receipt exactly as sent — in the registrant's captured
  // locale (cycle 47), so replayed dispute evidence matches the original mail.
  const emailDict = await getDictionary(toLocale(cartMail?.locale ?? reg.locale), "emails");
  const emailText = cartMail
    ? registrationTemplate(
        { ...cartMail.args, paymentInstructions: null, payDeadline: null },
        emailDict,
      ).text
    // NEVER silently blank. This document is submitted to Stripe as evidence
    // that a real person really registered; an empty receipt section reads as
    // "no receipt was sent", which is a claim about the merchant, not about a
    // missing row. Before RS005 W4 the receipt was rebuilt from `reg` itself
    // and could not come out empty, so this failure mode is new — it needs a
    // marker a human reviewer can act on rather than an absence they will
    // read as an admission.
    : `[Receipt could not be reconstructed: the registration group ${reg.group_id} `
      + `could not be loaded at ${new Date().toISOString()}. The entry itself is `
      + `evidenced by the registration record and activity log below.]`;

  const when = (d: Date | string | null) => (d ? new Date(d).toISOString() : "—");
  const ref = reg.ref_code ?? reg.id;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Dispute evidence — ${esc(ref)}</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,sans-serif;color:#18181b">
<div style="background:#150b36;color:#f5f0e8;padding:18px 32px 8px">
  <div style="font-size:18px;font-weight:800;letter-spacing:2px">SEAZN <span style="color:#a3e635">CLUB</span></div>
  <div style="text-align:right;color:#ef4444;font-size:14px;line-height:8px">&#9679;</div>
</div>
<div style="height:4px;background:#a3e635"></div>
<div style="max-width:760px;margin:0 auto;padding:28px 32px">
  <h1 style="font-size:22px;margin:0 0 2px">Dispute evidence pack — ${esc(ref)}</h1>
  <p style="margin:0 0 20px;color:#6b7280;font-size:13px">
    Generated ${new Date().toISOString()} · ${esc(ctx.org_name)} · for the Stripe dispute response${reg.dispute_id ? ` (${esc(reg.dispute_id)})` : ""}.
  </p>

  <h2 style="font-size:15px;margin:20px 0 6px">Registration (product/service + customer)</h2>
  <table style="font-size:14px;border-collapse:collapse">
    ${evidenceRow("Reference", ref)}
    ${evidenceRow("Entrant", reg.display_name)}
    ${evidenceRow("Customer email", reg.contact_email)}
    ${evidenceRow("Competition", `${ctx.comp_name} — ${division?.name ?? ""}`)}
    ${evidenceRow("Service dates", `${ctx.starts_on ?? "—"} – ${ctx.ends_on ?? "—"}`)}
    ${evidenceRow("Amount", `${((reg.amount_cents ?? 0) / 100).toFixed(2)} ${reg.currency.toUpperCase()}`)}
    ${evidenceRow("Payment intent", reg.payment_intent_id ?? "—")}
    ${evidenceRow("Registered at", when(reg.created_at))}
    ${evidenceRow("Status", reg.status)}
    ${evidenceRow("Disputed at", when(reg.disputed_at))}
    ${evidenceRow("Status page", reg.ref_code ? `${origin}/r/${reg.ref_code}` : "—")}
  </table>

  <h2 style="font-size:15px;margin:24px 0 6px">Confirmation email (receipt / customer communication)</h2>
  <p style="margin:0 0 6px;color:#6b7280;font-size:12px">Reconstruction of the transactional email sent to ${esc(reg.contact_email)} at registration.</p>
  <pre style="background:#f6f5f8;border-radius:8px;padding:14px;font-size:12px;white-space:pre-wrap">${esc(emailText)}</pre>

  <h2 style="font-size:15px;margin:24px 0 6px">Activity log (${events.length})</h2>
  <table style="font-size:13px;border-collapse:collapse">
    ${events
      .map((e) =>
        evidenceRow(new Date(e.created_at).toISOString(), `${e.type} ${JSON.stringify(e.payload)}`),
      )
      .join("")}
  </table>

  <h2 style="font-size:15px;margin:24px 0 6px">Fixtures for this entrant (service provided) — ${fixtures.length}</h2>
  ${
    fixtures.length === 0
      ? `<p style="color:#6b7280;font-size:13px;margin:0">No fixtures yet (or the entry has no entrant).</p>`
      : `<table style="font-size:13px;border-collapse:collapse">${fixtures
          .map((f) =>
            evidenceRow(
              `Round ${f.round_no ?? "—"} · ${f.scheduled_at ? new Date(f.scheduled_at).toISOString() : "unscheduled"}`,
              `${f.status}${f.venue ? ` · ${f.venue}` : ""}${f.outcome ? ` · ${JSON.stringify(f.outcome)}` : ""}`,
            ),
          )
          .join("")}</table>`
  }

  <h2 style="font-size:15px;margin:24px 0 6px">How to use</h2>
  <ol style="font-size:13px;color:#374151;padding-left:18px;margin:0">
    <li>Open the dispute in your Stripe Dashboard (platform account).</li>
    <li>Product/service: paste the Registration section; service date = the competition dates.</li>
    <li>Customer communication / receipt: paste the confirmation email reconstruction.</li>
    <li>Activity log + fixtures: upload this document as supporting evidence.</li>
  </ol>
</div>
</body></html>`;

  await withTenant(auth.orgId, (tx) =>
    audit(tx, ctx.competition_id, auth.orgId, "registration.evidence_exported", { registration_id: regId }, auth.userId),
  );
  return { ref, html };
}
