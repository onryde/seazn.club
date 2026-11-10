// The row shapes, the division context and the SQL handle types the siblings share; types only (see ./index.ts).
import type postgres from "postgres";
import type { RegistrationFormField } from "@/server/api-v1/schemas";

export type Tx = postgres.TransactionSql;

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
  /** V389/RS012 ruling 2 — after this passes, an unplaced solo sign-up is
   *  auto-refunded and withdrawn by `sweepRegistrations`'s pool-deadline
   *  pass. NULL defaults to `closes_at` at READ time (never backfilled into
   *  this column), so an organiser who never sets one still gets the
   *  ruling's default: the division's own registration close. */
  place_by_at: Date | null;
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

// Both the superuser client and a withTenant tx serve the shared helpers
// (TransactionSql omits connection controls, so it isn't a plain Sql).
export type AnySql = Tx | postgres.Sql;

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
