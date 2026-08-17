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
import { createHash } from "node:crypto";
import type postgres from "postgres";
import type Stripe from "stripe";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { getLimit, hasFeature, requireFeature } from "@/lib/entitlements";
import { platformFeeDefault } from "@/lib/platform-settings";
import { getStripe } from "@/lib/stripe";
import {
  sendPaymentReminderEmail,
  sendRegistrationPromotedEmail,
  sendRefundIssuedEmail,
  sendDisputeAlertEmail,
  sendDisputeLostEmail,
} from "@/lib/email";
import { routes } from "@/lib/routes";
import { toLocale } from "@/lib/i18n-constants";
import { isValidRefCode, normalizeRefCode } from "@/lib/ref-code";
import { maskDisplayName, resolveNameDisplay } from "@/lib/name-display";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { PutRegistrationSettings, RegistrationFormField } from "@/server/api-v1/schemas";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { resolveLogoUrl } from "@/server/public-site/data";
import { assertNotFrozen, frozenCompetitionIds } from "./entitlement-freeze";
import { recoverDisputedTransfer as recoverDisputedTransferCore } from "./dispute-recovery";
import {
  FIRST_PAID_EARN,
  recordEarnGrant,
  REFERRAL_EARN,
  tryEarnGrant,
  walletIdFor,
} from "@/lib/credits";

type Tx = postgres.TransactionSql;

// ---------------------------------------------------------------------------
// Pure helpers — fee math & eligibility (unit-tested directly)
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

/** Whole years between dob and `at` (doc 06 §2.1: never approximate). */
export function ageAt(dobIso: string, at: Date): number {
  const dob = new Date(`${dobIso}T00:00:00Z`);
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    at.getUTCMonth() < dob.getUTCMonth() ||
    (at.getUTCMonth() === dob.getUTCMonth() && at.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/** Guardian consent threshold (doc 06 §4.7 / doc 16 §1.1): under 18 today. */
export function isMinor(dobIso: string, now: Date): boolean {
  return ageAt(dobIso, now) < 18;
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

interface AgeRule {
  kind: "age";
  maxAgeAt?: number;
  minAgeAt?: number;
  cutoff?: { month: number; day: number; yearOf?: "season_start" | "calendar" };
}
interface GenderRule {
  kind: "gender";
  allowed: string[];
}

/** Division has an age rule ⇒ the form must collect DOB. */
export function requiresDob(rules: unknown[]): boolean {
  return rules.some((r) => (r as { kind?: string })?.kind === "age");
}

/**
 * Validate a registrant against the division's eligibility rules (doc 06 §2).
 * Only 'age' and 'gender' are checkable at registration; roster/grade/custom
 * rules are organiser-side. Returns human issues; empty = eligible.
 * `seasonStartYear` anchors cutoff.yearOf='season_start' (doc 06 §2.1).
 */
export function eligibilityIssues(
  rules: unknown[],
  input: { dob?: string | null; gender?: string | null },
  seasonStartYear: number,
): string[] {
  const issues: string[] = [];
  for (const raw of rules) {
    const rule = raw as { kind?: string };
    if (rule.kind === "age") {
      const r = raw as AgeRule;
      if (!input.dob) {
        issues.push("Date of birth is required for this age-restricted division.");
        continue;
      }
      const cutoff = r.cutoff ?? { month: 1, day: 1, yearOf: "calendar" as const };
      const year =
        cutoff.yearOf === "season_start" ? seasonStartYear : new Date().getUTCFullYear();
      const cutoffDate = new Date(Date.UTC(year, (cutoff.month ?? 1) - 1, cutoff.day ?? 1));
      const age = ageAt(input.dob, cutoffDate);
      if (r.maxAgeAt !== undefined && age > r.maxAgeAt) {
        issues.push(`Too old for this division (must be ${r.maxAgeAt} or younger on the cutoff date).`);
      }
      if (r.minAgeAt !== undefined && age < r.minAgeAt) {
        issues.push(`Too young for this division (must be ${r.minAgeAt} or older on the cutoff date).`);
      }
    } else if (rule.kind === "gender") {
      const r = raw as GenderRule;
      if (!input.gender) {
        issues.push("Gender is required for this division.");
      } else if (!r.allowed.includes(input.gender)) {
        issues.push("This division is not open to your gender category.");
      }
    }
  }
  return issues;
}

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
  currency: string;
  refund_lock_at: Date | null;
  form_fields: RegistrationFormField[];
  payment_method: "offline" | "stripe";
  /** Per-division override; null → org.payment_instructions. */
  payment_instructions: string | null;
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
  entrant_id: string | null;
  promoted_at: Date | null;
  withdrawn_at: Date | null;
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
  currency: string | null;
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
  source: "captain_entered" | "self_joined";
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
 *  ── CART-LEVEL MONEY ON AN ENTRY-LEVEL ROW — READ BEFORE RS002 ─────────────
 *  This type FLATTENS a cart's money onto one entry, which reads naturally and
 *  is exactly right while carts are 1:1 with entries — which is all that can
 *  exist today, since `submitRegistration` is gone and nothing creates a
 *  multi-entry cart until RS002/RS003 ship group submit.
 *
 *  The moment a cart holds two entries, three shapes in this file are wrong,
 *  and none of them fails a typecheck:
 *
 *   1. `stripeRefund(intent, undefined)` refunds the FULL remaining balance of
 *      the cart's payment intent. Refunding or withdrawing ONE entry would
 *      hand back its siblings' money too. Pass the entry's own `amount_cents`,
 *      as `refundRegistration` already does.
 *   2. `set refunded_cents = <this entry's fee>` OVERWRITES the cart's total
 *      instead of accumulating into it. The correct pattern is already in this
 *      file — `greatest(refunded_cents, …)` on the dispute path — and every
 *      such write needs to become additive/monotonic the same way.
 *   3. `remaining = reg.amount_cents - reg.refunded_cents` subtracts a CART
 *      total from an ENTRY fee. A sibling's earlier refund drives it negative
 *      and the organiser sees "Already fully refunded" for an untouched entry.
 *
 *  Fixing these properly needs a decision RS001 deliberately did not take:
 *  whether per-entry refunds are tracked by a `registrations.refunded_cents`
 *  of their own or derived. That belongs with RS002's group-submit design, and
 *  is recorded in the prompts `_INDEX.md` as an RS002 entry condition. Until
 *  then every site above carries a pointer back to this block.
 *  ───────────────────────────────────────────────────────────────────────── */
export type RegistrationWithGroupRow = RegistrationRow &
  Pick<
    RegistrationGroupRow,
    | "contact_name" | "contact_email" | "user_id" | "locale" | "ref_code"
    | "access_token_hash" | "currency" | "payment_method" | "checkout_session_id"
    | "payment_intent_id" | "expires_at" | "reminded_at" | "refunded_cents"
    | "refunded_at" | "disputed_at" | "dispute_id" | "offline_marked_paid_at"
    | "offline_marked_paid_by" | "fee_percent" | "privacy_consent_at"
    | "privacy_consent_version"
  >;

/** r.* ∪ g.* for `RegistrationWithGroupRow` — every SELECT that needs the
 *  joined shape interpolates `${regGroupCols(db)}` (same convention as
 *  org-posts.ts's `COLS`/discipline.ts's `SELECT_SUSPENSION`), built from the
 *  SAME `sql`/`tx` instance as the surrounding query so the two tables'
 *  column list can only drift in one place. */
function regGroupCols(db: AnySql) {
  return db`
    r.id, r.division_id, r.org_id, r.status, r.display_name, r.answers,
    r.amount_cents, r.entrant_id, r.promoted_at, r.withdrawn_at,
    r.group_id, r.join_code, r.free_agent, r.created_at, r.updated_at,
    g.contact_name, g.contact_email, g.user_id, g.locale, g.ref_code,
    g.access_token_hash, g.currency, g.payment_method, g.checkout_session_id,
    g.payment_intent_id, g.expires_at, g.reminded_at, g.refunded_cents,
    g.refunded_at, g.disputed_at, g.dispute_id, g.offline_marked_paid_at,
    g.offline_marked_paid_by, g.fee_percent, g.privacy_consent_at,
    g.privacy_consent_version`;
}

const SETTINGS_COLS = [
  "division_id", "enabled", "entrant_kind", "opens_at", "closes_at",
  "capacity", "fee_cents", "currency", "refund_lock_at", "form_fields",
  "payment_method", "payment_instructions", "updated_at",
] as const;

/** Statuses that hold a capacity spot. */
const SPOT_HOLDERS = ["pending", "paid", "confirmed"] as const;

// Both the superuser client and a withTenant tx serve the shared helpers
// (TransactionSql omits connection controls, so it isn't a plain Sql).
type AnySql = Tx | postgres.Sql;

async function loadSettings(db: AnySql, divisionId: string): Promise<RegistrationSettingsRow | null> {
  const [row] = await db<RegistrationSettingsRow[]>`
    select ${sql(SETTINGS_COLS as unknown as string[])} from registration_settings
    where division_id = ${divisionId}`;
  return row ?? null;
}

/** Append to the competition_events audit ledger (016 pattern). */
async function audit(
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

interface DivisionCtx {
  id: string;
  competition_id: string;
  org_id: string;
  eligibility: unknown[];
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
}

async function divisionCtx(db: AnySql, divisionId: string): Promise<DivisionCtx> {
  const [row] = await db<DivisionCtx[]>`
    select d.id, d.competition_id, d.org_id, d.eligibility, d.slug as div_slug,
           c.name as comp_name, c.slug as comp_slug, c.visibility as comp_visibility,
           c.starts_on, c.ends_on,
           o.slug as org_slug, o.name as org_name, o.default_locale, o.payment_instructions,
           o.stripe_charges_enabled as charges_enabled
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    where d.id = ${divisionId}`;
  if (!row) throw new HttpError(404, "division not found");
  return row;
}


/** Origin for emails fired from request-less paths (withdraw promotions):
 *  same override order as lib/base-url, localhost as the dev fallback. */
function fallbackOrigin(): string {
  return (
    process.env.OAUTH_BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

function windowOpen(s: RegistrationSettingsRow, now: Date): boolean {
  if (!s.enabled) return false;
  if (s.opens_at && now < new Date(s.opens_at)) return false;
  if (s.closes_at && now > new Date(s.closes_at)) return false;
  return true;
}

/**
 * Materialise a confirmed registration into an entrant (doc 16 §1.1:
 * "Registration → entrant on confirm"). Idempotent: entrant_id is set exactly
 * once under a row lock; a second call is a no-op. Individuals also get a
 * person (dob/gender feed eligibility; consent defaults empty = initials on
 * public surfaces, doc 06 §4.7).
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
  const [person] = await tx<{ id: string }[]>`
    insert into persons (org_id, full_name, dob, gender, user_id, lane)
    values (${orgId}, ${fullName}, ${dob}, ${gender}, ${userId}, 'player')
    on conflict (org_id, user_id, lane)
      where user_id is not null and lane = 'player' and merged_into is null
    do update set full_name = persons.full_name
    returning id`;
  return person.id;
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
async function loadPlayers(tx: Tx, registrationId: string): Promise<
  Pick<RegistrationPlayerRow, "id" | "full_name" | "dob" | "gender" | "squad_number" | "user_id">[]
> {
  return tx`
    select id, full_name, dob, gender, squad_number, user_id from registration_players
    where registration_id = ${registrationId}
    order by is_captain desc, created_at`;
}

async function materialise(tx: Tx, reg: RegistrationRow, entrantKind: string): Promise<string> {
  if (reg.entrant_id) return reg.entrant_id;
  const [entrant] = await tx<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, status)
    values (${reg.division_id}, ${entrantKind}, ${reg.display_name}, 'confirmed')
    returning id`;
  const players = await loadPlayers(tx, reg.id);
  if (entrantKind === "individual") {
    // No player row yet (nothing populates registration_players until
    // RS002/RS003 ship the new submit flow) falls back to the entry's own
    // display_name with no dob/gender — byte-for-byte the old anonymous path.
    const p = players[0];
    const fullName = p?.full_name ?? reg.display_name;
    const dob = p?.dob ?? null;
    const gender = p?.gender ?? null;
    // A player row carrying a user_id (#402) resolves into that account's
    // linked person instead of minting a fresh one — see resolvePlayerPerson.
    const personId = p?.user_id
      ? await resolvePlayerPerson(tx, reg.org_id, p.user_id, fullName, dob, gender)
      : (
          await tx<{ id: string }[]>`
            insert into persons (org_id, full_name, dob, gender)
            values (${reg.org_id}, ${fullName}, ${dob}, ${gender})
            returning id`
        )[0].id;
    // A RESOLVED person can already sit on this entrant (re-confirm), which the
    // fresh-insert path could never hit — so the membership write is idempotent.
    await tx`
      insert into entrant_members (entrant_id, person_id)
      values (${entrant.id}, ${personId})
      on conflict (entrant_id, person_id) do nothing`;
  } else if (entrantKind === "team" && players.length > 0) {
    // Team roster → a person + squad member per player row. Same #402 link
    // check as the individual branch above, per player.
    for (const p of players) {
      const name = p.full_name.trim();
      if (!name) continue;
      const personId = p.user_id
        ? await resolvePlayerPerson(tx, reg.org_id, p.user_id, name, p.dob, p.gender)
        : (
            await tx<{ id: string }[]>`
              insert into persons (org_id, full_name, dob, gender)
              values (${reg.org_id}, ${name}, ${p.dob}, ${p.gender})
              returning id`
          )[0].id;
      await tx`
        insert into entrant_members (entrant_id, person_id, squad_number)
        values (${entrant.id}, ${personId}, ${p.squad_number})
        on conflict (entrant_id, person_id) do nothing`;
    }
  }
  await tx`
    update registrations
    set entrant_id = ${entrant.id}, status = 'confirmed', updated_at = now()
    where id = ${reg.id}`;
  // expires_at (the pay-by deadline) now lives on the cart, not the entry —
  // clearing it here matches today's single-entry-per-cart behaviour exactly;
  // once a cart can hold several entries this needs to stop clearing the
  // whole cart's deadline on one entry's confirmation (RS002 territory).
  await tx`
    update registration_groups set expires_at = null, updated_at = now()
    where id = ${reg.group_id}`;
  return entrant.id;
}

/**
 * Oldest waitlisted → pending (doc 16 §1.1 auto-promotion). Waitlisted rows
 * hold amount 0, so promotion SNAPSHOTS the current fee + method (spec §2);
 * card divisions get a fresh 48h pay window. Returns the promoted row.
 *
 * currency/payment_method/expires_at now live on the entry's CART
 * (`registration_groups`), not the entry — writing them here overwrites the
 * whole group's snapshot, which is exactly right while every group holds one
 * entry (true until RS002/RS003 ship multi-entry carts) and wrong the moment
 * a promoted entry shares a cart with something else already paid for at a
 * different rate/currency. RS002 territory; flagged, not fixed here.
 */
async function promoteOldestWaitlisted(
  tx: Tx,
  divisionId: string,
  settings: RegistrationSettingsRow | null,
): Promise<RegistrationWithGroupRow | null> {
  const feeCents = settings?.fee_cents ?? 0;
  const method = settings?.payment_method ?? "offline";
  const stripeWindow = method === "stripe" && feeCents > 0;
  const [picked] = await tx<{ id: string; group_id: string }[]>`
    select id, group_id from registrations
    where division_id = ${divisionId} and status = 'waitlisted'
    order by created_at, id limit 1
    for update skip locked`;
  if (!picked) return null;
  await tx`
    update registrations
    set status = 'pending', promoted_at = now(), updated_at = now(),
        amount_cents = ${feeCents}
    where id = ${picked.id}`;
  await tx`
    update registration_groups
    set currency = ${settings?.currency ?? "gbp"},
        payment_method = ${method},
        expires_at = ${stripeWindow ? tx`now() + interval '48 hours'` : null},
        updated_at = now()
    where id = ${picked.group_id}`;
  const [row] = await tx<RegistrationWithGroupRow[]>`
    select ${regGroupCols(tx)}
    from registrations r join registration_groups g on g.id = r.group_id
    where r.id = ${picked.id}`;
  return row ?? null;
}

/** Post-tx promoted email (fire-and-forget): card entries get a fresh
 *  token-free checkout link, offline entries the resolved instructions. */
async function notifyPromoted(
  promoted: RegistrationWithGroupRow,
  ctx: DivisionCtx,
  settings: RegistrationSettingsRow | null,
  origin: string,
): Promise<void> {
  try {
    let payUrl: string | null = null;
    if (promoted.payment_method === "stripe" && promoted.amount_cents > 0 && ctx.charges_enabled) {
      try {
        payUrl = await createRegistrationCheckout(promoted, ctx, origin, null);
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
      currency: promoted.currency ?? settings?.currency ?? "gbp",
      payUrl,
      payDeadline: promoted.expires_at,
      paymentInstructions:
        promoted.payment_method === "offline" && promoted.amount_cents > 0
          ? (settings?.payment_instructions ?? ctx.payment_instructions)
          : null,
      refCode: promoted.ref_code,
      refStatusUrl: promoted.ref_code ? `${origin}/r/${promoted.ref_code}` : null,
    });
  } catch {
    /* fire-and-forget */
  }
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
  currency: "gbp",
  refund_lock_at: null,
  form_fields: [],
  payment_method: "offline",
  payment_instructions: null,
  updated_at: null,
};

export interface OrgPaymentDefaults {
  charges_enabled: boolean;
  org_payment_instructions: string | null;
  org_default_payment_method: string;
}

async function orgPaymentDefaults(orgId: string): Promise<OrgPaymentDefaults> {
  const [row] = await sql<OrgPaymentDefaults[]>`
    select stripe_charges_enabled as charges_enabled,
           payment_instructions as org_payment_instructions,
           default_payment_method as org_default_payment_method
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
  const currency = input.currency ?? "gbp";
  const entrantKind = input.entrant_kind ?? "individual";
  const formFields = input.form_fields ?? [];
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
         fee_cents, currency, refund_lock_at, form_fields,
         payment_method, payment_instructions, updated_at)
      values
        (${divisionId}, ${input.enabled}, ${entrantKind},
         ${input.opens_at ?? null}, ${input.closes_at ?? null},
         ${input.capacity ?? null}, ${feeCents}, ${currency},
         ${input.refund_lock_at ?? null}, ${tx.json(formFields as never)},
         ${method}, ${input.payment_instructions?.trim() || null}, now())
      on conflict (division_id) do update set
        enabled              = excluded.enabled,
        entrant_kind         = excluded.entrant_kind,
        opens_at             = excluded.opens_at,
        closes_at            = excluded.closes_at,
        capacity             = excluded.capacity,
        fee_cents            = excluded.fee_cents,
        currency             = excluded.currency,
        refund_lock_at       = excluded.refund_lock_at,
        form_fields          = excluded.form_fields,
        payment_method       = excluded.payment_method,
        payment_instructions = excluded.payment_instructions,
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
  entrant_kind: string;
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
  requires_dob: boolean;
  /** Youth division (v3/11 gap 8): the form always adds guardian consent. */
  youth: boolean;
  /** Queue length behind a full division (PROMPT-52) — public. */
  waitlisted: number;
  form_fields: RegistrationFormField[];
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
    }[]
  >`
    select c.id, c.name, c.slug, c.org_id, o.stripe_charges_enabled as charges_enabled,
           c.starts_on, c.ends_on,
           o.name as org_name, o.logo_storage_path, o.logo_url
    from competitions c join organizations o on o.id = c.org_id
    where o.slug = ${orgSlug} and c.slug = ${compSlug}
      and c.visibility in ('public','unlisted') and o.status = 'active'`;
  if (!comp) throw new HttpError(404, "competition not found");

  const rows = await sql<
    (RegistrationSettingsRow & {
      name: string;
      slug: string;
      sport_key: string;
      eligibility: unknown[];
      youth: boolean;
      active: number;
      waitlisted: number;
    })[]
  >`
    select rs.*, d.name, d.slug, d.sport_key, d.eligibility, d.youth,
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
      currency: r.currency,
      payment_method: r.payment_method,
      opens_at: r.opens_at ? new Date(r.opens_at).toISOString() : null,
      closes_at: r.closes_at ? new Date(r.closes_at).toISOString() : null,
      capacity: r.capacity,
      remaining,
      taken: r.active,
      open,
      closed_reason: reason,
      requires_dob: requiresDob(r.eligibility ?? []),
      youth: r.youth,
      waitlisted: r.waitlisted,
      form_fields: r.form_fields ?? [],
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
// `eligibilityIssues`, `validateAnswers`, `deriveLinkUserId`, `isMinor`,
// `ageAt`, `hashRegistrationToken`. `mintRegistrationToken` (private, token-
// minting only) and `generateRefCode`'s only call site here went with it.

/** Destination charge on the org's Connect account; the platform keeps
 *  application_fee_amount (doc 16 §1.1). Always charges the SNAPSHOTTED
 *  reg.amount_cents (spec issue #8), never live settings. `token` builds the
 *  status-page return URLs; null falls back to the token-free /r/[ref] pair
 *  (email-minted sessions — the reminder can't recover the hashed token). */
async function createRegistrationCheckout(
  reg: RegistrationWithGroupRow,
  ctx: DivisionCtx,
  origin: string,
  token: string | null,
): Promise<string> {
  if (reg.amount_cents <= 0) throw new HttpError(422, "This registration has no entry fee");
  const [org] = await sql<{ stripe_account_id: string | null }[]>`
    select stripe_account_id from organizations where id = ${ctx.org_id}`;
  if (!org?.stripe_account_id) {
    throw new HttpError(503, "Payments are not set up for this organiser yet");
  }
  const returnBase = token
    ? `${origin}/shared/${ctx.org_slug}/${ctx.comp_slug}/register/status` +
      `?rid=${reg.id}&token=${encodeURIComponent(token)}`
    : `${origin}/r/${reg.ref_code}?src=email`;
  // The rate this charge uses: the competition's locked rate if it has one,
  // otherwise the live plan rate. Resolved ONCE and both charged and frozen onto
  // the registration, so the paid transition can stamp the competition with the
  // exact percent this payer was billed — never a re-resolved one that a
  // mid-competition plan change could have moved.
  const feePercent = await effectiveFeePercentFor(ctx.competition_id, ctx.org_id);
  const session = await getStripe().checkout.sessions.create({
    mode: "payment",
    customer_email: reg.contact_email,
    // fee_percent rides the session so the paid transition can stamp the
    // competition with the rate THIS session was billed at — not reg.fee_percent,
    // which a later re-mint (resume, reminder) overwrites. Without it, paying a
    // stale still-open session after a plan change would lock the competition at
    // a rate no entrant was ever charged.
    metadata: {
      kind: "registration",
      registration_id: reg.id,
      org_id: ctx.org_id,
      fee_percent: String(feePercent),
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: reg.currency ?? "gbp",
          unit_amount: reg.amount_cents,
          product_data: { name: `${ctx.comp_name} — entry fee (${reg.display_name})` },
        },
      },
    ],
    payment_intent_data: {
      application_fee_amount: applicationFeeCents(reg.amount_cents, feePercent),
      transfer_data: { destination: org.stripe_account_id },
      metadata: { registration_id: reg.id, org_id: ctx.org_id },
    },
    success_url: `${returnBase}&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${returnBase}&checkout=cancelled`,
  });
  if (!session.url) throw new HttpError(502, "Stripe did not return a checkout URL");
  // checkout_session_id/fee_percent live on the cart now (V364), not the entry.
  await sql`
    update registration_groups
    set checkout_session_id = ${session.id}, fee_percent = ${feePercent}, updated_at = now()
    where id = ${reg.group_id}`;
  return session.url;
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
export async function handleRegistrationCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const regId = session.metadata?.registration_id;
  if (!regId) return;
  const paymentIntent =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);
  // The rate THIS session was billed at (see createRegistrationCheckout). Absent
  // on sessions minted before V312 — the stamp falls back to reg.fee_percent.
  const raw = session.metadata?.fee_percent;
  const chargedFeePercent =
    raw != null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
  await confirmPaidRegistration(
    regId,
    paymentIntent,
    session.amount_total ?? null,
    chargedFeePercent,
  );
}

type PayOutcome =
  | { kind: "confirmed"; divisionId: string; competitionId: string; orgId: string }
  | { kind: "late" | "duplicate"; reg: RegistrationWithGroupRow; competitionId: string; intent: string }
  | null;

async function confirmPaidRegistration(
  regId: string,
  paymentIntentId: string | null,
  amountTotal: number | null,
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
      if (paymentIntentId && reg.payment_intent_id && paymentIntentId !== reg.payment_intent_id) {
        return { kind: "duplicate", reg, competitionId: div.competition_id, intent: paymentIntentId };
      }
      return null;
    }
    // Money landing on a dead registration (withdrawn/expired, spec issue #1):
    // record the intent for the audit trail and send it straight back.
    // payment_intent_id lives on the cart now (V364).
    if (reg.status === "withdrawn" || reg.status === "expired") {
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
    await tx`
      update registrations
      set status = 'paid',
          amount_cents = coalesce(${amountTotal}, amount_cents),
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
    const entrantId = await materialise(
      tx,
      { ...reg, status: "paid" },
      settings?.entrant_kind ?? "individual",
    );
    await audit(tx, div.competition_id, reg.org_id, "registration.confirmed", {
      registration_id: regId,
      entrant_id: entrantId,
      paid: true,
      amount_cents: amountTotal ?? reg.amount_cents,
    }, null);
    return {
      kind: "confirmed",
      divisionId: reg.division_id,
      competitionId: div.competition_id,
      orgId: reg.org_id,
    };
  })) as unknown as PayOutcome;

  if (!outcome) return;
  if (outcome.kind === "confirmed") {
    fireDivisionRevalidate(outcome.divisionId, outcome.competitionId);
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
      console.error(`[credits] referral grant failed for referrer of org ${outcome.orgId}`, err);
    }
    return;
  }
  // Refunds happen OUTSIDE the tx (network). A failure surfaces on the
  // organiser console via the audit trail, never blocks the webhook ACK.
  try {
    // Hazards 1 and 2 of RegistrationWithGroupRow's cart-level-money block:
    // full-balance refund of the CART's intent, then an overwriting write.
    // Exact at one entry per cart; RS002 owns the multi-entry fix.
    const refund = await stripeRefund(outcome.intent, undefined);
    if (outcome.kind === "late") {
      // refunded_cents/refunded_at live on the cart now (V364).
      await sql`
        update registration_groups
        set refunded_cents = ${amountTotal ?? outcome.reg.amount_cents},
            refunded_at = now(), updated_at = now()
        where id = ${outcome.reg.group_id}`;
    }
    await audit(sql, outcome.competitionId, outcome.reg.org_id, "registration.refunded", {
      registration_id: regId,
      amount_cents: amountTotal ?? outcome.reg.amount_cents,
      mode: outcome.kind === "late" ? "late_payment" : "duplicate",
      stripe_refund_id: refund.id,
    }, null);
    const ctxLate = await divisionCtx(sql, outcome.reg.division_id);
    notifyRefund(outcome.reg, ctxLate, amountTotal ?? outcome.reg.amount_cents);
  } catch {
    await audit(sql, outcome.competitionId, outcome.reg.org_id, "registration.refund_failed", {
      registration_id: regId,
      mode: outcome.kind,
    }, null);
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
        currency: reg.currency ?? "gbp",
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
    // live on the cart now (V364); `amount_cents` here is THIS entry's own
    // fee (still on `registrations`), not the cart's subtotal, so it has to
    // ride as a JS value rather than a same-row column reference.
    await sql`update registration_groups
              set refunded_cents = ${reg.amount_cents},
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
          currency: reg.currency ?? "gbp",
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
    if (session.metadata?.registration_id !== regId) return false;
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
 */
export async function reconcileRegistrationBySession(
  ref: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const reg = await regByRef(ref);
    if (reg.status !== "pending") return false;
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") return false;
    if (session.metadata?.registration_id !== reg.id) return false;
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
  const [div] = await sql<{ name: string }[]>`
    select name from divisions where id = ${reg.division_id}`;
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
    display_name: reg.display_name,
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
  // cart with more than one entry (not reachable yet: nothing creates one
  // until RS002/RS003) would have several rows match here; this picks the
  // oldest deterministically rather than an arbitrary one. RS007 owns
  // deciding whether /r/[ref] should show the whole cart instead of one entry.
  const [reg] = await sql<RegistrationWithGroupRow[]>`
    select ${regGroupCols(sql)}
    from registrations r join registration_groups g on g.id = r.group_id
    where g.ref_code = ${canonical}
    order by r.created_at, r.id limit 1`;
  if (!reg) throw new HttpError(404, "registration not found");
  return reg;
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
  const mode = resolveNameDisplay(div?.player_name_display ?? null, div?.youth ?? false);
  // access_token_hash already rode the join in regByRef — no separate fetch
  // needed (it lives on the cart now, V364).
  const canWithdraw =
    !!token && reg.status !== "withdrawn" && hashRegistrationToken(token) === reg.access_token_hash;
  return {
    ref_code: reg.ref_code!,
    status: reg.status,
    display_name: maskDisplayName(reg.display_name, mode),
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

/** Self-withdraw from /r/[ref] — the ref is a lookup, NOT auth: the email
 *  token is still required (v3/05 §4). */
export async function withdrawRegistrationByRef(
  ref: string,
  token: string,
): Promise<PublicRefView> {
  const reg = await regByRef(ref);
  const byToken = await regByToken(reg.id, token); // 404s on a bad token
  await withdrawCore(byToken, null);
  return publicRegistrationStatusByRef(ref, token);
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
  if (reg.payment_method !== "stripe") {
    throw new HttpError(422, "This entry fee is paid directly to the organiser");
  }
  if (reg.amount_cents <= 0) {
    throw new HttpError(422, "This registration has no entry fee");
  }
  const ctx = await divisionCtx(sql, reg.division_id);
  if (!ctx.charges_enabled) {
    throw new HttpError(503, "Payments are not set up for this organiser yet");
  }
  const url = await createRegistrationCheckout(reg, ctx, origin, token);
  return { checkout_url: url };
}

// ---------------------------------------------------------------------------
// Withdraw core + refunds (shared by public + organiser paths)
// ---------------------------------------------------------------------------

/** Refund a payment taken as a destination charge: money comes back off the
 *  connected account, the platform returns its application fee. */
async function stripeRefund(
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

/** Fire-and-forget refund receipt to the registrant (spec T9). */
function notifyRefund(reg: RegistrationWithGroupRow, ctx: DivisionCtx, amountCents: number): void {
  void sendRefundIssuedEmail({
    to: reg.contact_email,
    locale: toLocale(reg.locale),
    orgName: ctx.org_name,
    competitionName: ctx.comp_name,
    displayName: reg.display_name,
    amountCents,
    currency: reg.currency ?? "gbp",
    refCode: reg.ref_code,
  }).catch(() => {});
}

async function withdrawCore(reg: RegistrationWithGroupRow, actorId: string | null): Promise<void> {
  if (reg.status === "withdrawn") return; // idempotent
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
    const promoted = freedSpot
      ? await promoteOldestWaitlisted(tx, reg.division_id, settings)
      : null;
    await audit(tx, ctx.competition_id, ctx.org_id, "registration.withdrawn", {
      registration_id: reg.id,
      by: actorId ? "organiser" : "registrant",
      promoted_registration_id: promoted?.id ?? null,
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

  fireDivisionRevalidate(reg.division_id, ctx.competition_id);
  if (outcome.promoted) {
    void notifyPromoted(outcome.promoted, ctx, settings, fallbackOrigin());
  }

  // Auto-refund policy (doc 16 §1.1): full refund when withdrawal lands
  // before refund_lock_at (or no lock set). After the lock it's organiser
  // discretion via the manual refund endpoint. Stripe call OUTSIDE the tx.
  const { locked } = outcome;
  const refundable = locked.payment_intent_id && locked.refunded_cents < locked.amount_cents;
  const beforeLock =
    !settings?.refund_lock_at || new Date() < new Date(settings.refund_lock_at);
  if (refundable && beforeLock) {
    try {
      // Hazards 1 and 2 of RegistrationWithGroupRow's cart-level-money block:
      // `undefined` refunds the cart's whole remaining balance, and the write
      // below overwrites the cart total rather than accumulating. Both are
      // exact while a cart holds one entry; RS002 owns the multi-entry fix.
      const refund = await stripeRefund(locked.payment_intent_id as string, undefined);
      // refunded_cents/refunded_at live on the cart now (V364); `amount_cents`
      // here is THIS entry's own fee, not the cart's subtotal column, so it
      // rides as the already-fetched JS value.
      await sql`
        update registration_groups
        set refunded_cents = ${locked.amount_cents}, refunded_at = now(), updated_at = now()
        where id = ${locked.group_id}`;
      await audit(sql, ctx.competition_id, ctx.org_id, "registration.refunded", {
        registration_id: reg.id,
        amount_cents: locked.amount_cents,
        mode: "auto",
        stripe_refund_id: refund.id,
      }, actorId);
      notifyRefund(locked, ctx, locked.amount_cents);
    } catch {
      // Refund failure must not undo the withdrawal — surfaces on the
      // organiser console (withdrawn + refunded_cents < amount_cents).
      await audit(sql, ctx.competition_id, ctx.org_id, "registration.refund_failed", {
        registration_id: reg.id,
        mode: "auto",
      }, actorId);
    }
  }
}

// ---------------------------------------------------------------------------
// Pay-window sweep (spec §6) — cron-shaped: /api/cron/registrations, hourly
// ---------------------------------------------------------------------------

/**
 * Two passes over card pendings: (1) T-24h payment reminders carrying a fresh
 * token-free checkout link, exactly once per registration (reminded_at);
 * (2) expire rows past their deadline and promote the oldest waitlisted with
 * a new window. Each expiry runs in its own row-locked tx, so a racing
 * webhook serialises: webhook first → paid wins; sweep first → the late
 * payment auto-refunds (confirmPaidRegistration).
 */
export async function sweepRegistrations(
  origin: string,
): Promise<{ reminded: number; expired: number; promoted: number }> {
  let reminded = 0;
  let expired = 0;
  let promotedCount = 0;

  // payment_method/expires_at/reminded_at live on the cart now (V364).
  const due = await sql<RegistrationWithGroupRow[]>`
    select ${regGroupCols(sql)}
    from registrations r join registration_groups g on g.id = r.group_id
    where r.status = 'pending' and g.payment_method = 'stripe'
      and g.expires_at is not null
      and g.expires_at < now() + interval '24 hours'
      and g.expires_at > now()
      and g.reminded_at is null
    order by g.expires_at
    limit 200`;
  for (const reg of due) {
    try {
      const ctx = await divisionCtx(sql, reg.division_id);
      if (!ctx.charges_enabled) continue; // Connect broke — nothing to link to
      const url = await createRegistrationCheckout(reg, ctx, origin, null);
      await sendPaymentReminderEmail({
        to: reg.contact_email,
        locale: toLocale(reg.locale),
        orgName: ctx.org_name,
        competitionName: ctx.comp_name,
        displayName: reg.display_name,
        feeCents: reg.amount_cents,
        currency: reg.currency ?? "gbp",
        paymentInstructions: null,
        checkoutUrl: url,
        payDeadline: reg.expires_at,
      });
    } catch {
      continue; // reminded_at stays null — the next sweep retries
    }
    await sql`update registration_groups set reminded_at = now(), updated_at = now()
              where id = ${reg.group_id}`;
    reminded++;
  }

  // expires_at lives on the cart now (V364).
  const overdue = await sql<{ id: string; division_id: string; group_id: string }[]>`
    select r.id, r.division_id, r.group_id
    from registrations r join registration_groups g on g.id = r.group_id
    where r.status = 'pending' and g.expires_at is not null and g.expires_at < now()
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

  return { reminded, expired, promoted: promotedCount };
}

// ---------------------------------------------------------------------------
// Organiser: list / confirm / waitlist / withdraw / refund / export
// ---------------------------------------------------------------------------

export async function listRegistrations(
  auth: AuthCtx,
  divisionId: string,
  status: string | null,
): Promise<RegistrationWithGroupRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    return tx<RegistrationWithGroupRow[]>`
      select ${regGroupCols(tx)}
      from registrations r join registration_groups g on g.id = r.group_id
      where r.division_id = ${divisionId}
        ${status ? tx`and r.status = ${status}` : tx``}
      order by r.created_at, r.id`;
  });
}

async function orgReg(tx: Tx, regId: string): Promise<RegistrationWithGroupRow> {
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
    currency: settings?.currency ?? reg.currency ?? "gbp",
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

async function orgRegAfter(tx: Tx, regId: string): Promise<RegistrationWithGroupRow> {
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
  // Hazard 3 of RegistrationWithGroupRow's cart-level-money block: entry fee
  // minus CART refunds. Correct at one entry per cart, wrong the moment RS002
  // ships multi-entry carts.
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
    // refunded_cents/refunded_at live on the cart now (V364).
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

/** CSV export (organiser console; `exports` is the Pro gate, doc 10 §1). */
export async function exportRegistrationsCsv(auth: AuthCtx, divisionId: string): Promise<string> {
  await requireFeature(auth.orgId, "exports");
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const settings = await loadSettings(tx, divisionId);
    const fieldKeys = (settings?.form_fields ?? []).map((f) => f.key);
    const rows = await tx<RegistrationWithGroupRow[]>`
      select ${regGroupCols(tx)}
      from registrations r join registration_groups g on g.id = r.group_id
      where r.division_id = ${divisionId}
      order by r.created_at, r.id`;
    const esc = (v: unknown): string => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // dob/gender/guardian_name/guardian_consent dropped from this export
    // (RS001 registration demolition): they moved off the entry onto
    // `registration_players` — one-to-many per entry, so there is no single
    // flat value left to print here without inventing a flattening rule.
    // RS005's Registrants tab CSV export owns the per-player-aware version.
    const header = [
      "id", "status", "display_name", "contact_email", "amount_cents",
      "currency", "refunded_cents", "created_at", ...fieldKeys,
    ];
    const lines = rows.map((r) =>
      [
        r.id, r.status, r.display_name, r.contact_email,
        r.amount_cents, r.currency ?? "", r.refunded_cents,
        new Date(r.created_at).toISOString(),
        ...fieldKeys.map((k) => (r.answers as Record<string, unknown>)[k] ?? ""),
      ].map(esc).join(","),
    );
    return [header.join(","), ...lines].join("\n") + "\n";
  });
}

// ---------------------------------------------------------------------------
// .ics confirmation attachment (doc 16 §1.1 / PROMPT-20a item 3)
// ---------------------------------------------------------------------------

/** Minimal all-day VEVENT for the competition dates. */
export async function registrationIcs(regId: string, token: string): Promise<string> {
  const view = await publicRegistrationStatus(regId, token);
  const start = (view.starts_on ?? new Date().toISOString().slice(0, 10)).replace(/-/g, "");
  // DTEND is exclusive for all-day events.
  const endDate = view.ends_on ?? view.starts_on ?? new Date().toISOString().slice(0, 10);
  const end = new Date(new Date(`${endDate}T00:00:00Z`).getTime() + 86_400_000)
    .toISOString().slice(0, 10).replace(/-/g, "");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//seazn.club//registration//EN",
    "BEGIN:VEVENT",
    `UID:registration-${view.id}@seazn.club`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${start}`,
    `DTEND;VALUE=DATE:${end}`,
    `SUMMARY:${view.competition_name} — ${view.division_name}`,
    `DESCRIPTION:Registration for ${view.display_name} (${view.status})`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
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

  const fixtures = reg.entrant_id
    ? await sql<
        { round_no: number | null; status: string; outcome: unknown; scheduled_at: Date | null; venue: string | null }[]
      >`
      select round_no, status, outcome, scheduled_at, venue from fixtures
      where home_entrant_id = ${reg.entrant_id} or away_entrant_id = ${reg.entrant_id}
      order by round_no nulls last, scheduled_at nulls last`
    : [];

  // The transactional receipt, reconstructed with the exact sender inputs.
  const settings = await loadSettings(sql, reg.division_id);
  const { registrationTemplate } = await import("@/lib/email-templates");
  const { getDictionary } = await import("@/lib/i18n");
  // Reconstruct the receipt exactly as sent — in the registrant's captured
  // locale (cycle 47), so replayed dispute evidence matches the original mail.
  const emailDict = await getDictionary(toLocale(reg.locale), "emails");
  const emailText = registrationTemplate(
    {
      orgName: ctx.org_name,
      competitionName: ctx.comp_name,
      displayName: reg.display_name,
      status: reg.status,
      feeCents: reg.amount_cents,
      currency: reg.currency ?? settings?.currency ?? "gbp",
      paymentInstructions: null,
      statusUrl: `${origin}/shared/${ctx.org_slug}/${ctx.comp_slug}/register/status`,
      refCode: reg.ref_code,
      refStatusUrl: reg.ref_code ? `${origin}/r/${reg.ref_code}` : null,
    },
    emailDict,
  ).text;

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
    ${evidenceRow("Amount", `${((reg.amount_cents ?? 0) / 100).toFixed(2)} ${(reg.currency ?? "gbp").toUpperCase()}`)}
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
