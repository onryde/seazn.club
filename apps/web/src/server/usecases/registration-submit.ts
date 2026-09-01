import "server-only";
// RS002 W4 — the entire server-side submit path: submitRegistrationGroup (the
// cart) and joinTeamEntry (the join-a-team link). Design of record:
// docs/superpowers/specs/2026-08-16-registration-redesign-design.md §3 (data
// model), §4 (submit semantics), §6 (materialization, unchanged, reused
// verbatim via `materialise`).
//
// Module topology (RS002 `_INDEX.md`, kept on purpose): `registration-
// eligibility.ts` imports nothing from `registrations.ts`. This file imports
// from BOTH. Never add an edge back from `registrations.ts` to this file —
// that is the cycle the split exists to avoid.
//
// `submitRegistration` (single-entry, pre-redesign) was deleted by RS001. Its
// capacity row-lock, ref-code retry-on-collision and #402 link policy are
// reused/ported here VERBATIM where the design is unchanged; every place this
// file's behaviour differs from it is commented at the point of difference.
import { randomBytes } from "node:crypto";
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { getLimit, requireFeature } from "@/lib/entitlements";
import { generateRefCode } from "@/lib/ref-code";
import { LEGAL_VERSION } from "@/lib/legal";
import { log } from "@/server/logger";
import {
  SPOT_HOLDERS,
  REGISTRATION_TOKEN_PREFIX,
  hashRegistrationToken,
  deriveLinkUserId,
  isMinor,
  validateAnswers,
  windowOpen,
  materialise,
  rosterCapExpr,
  soloPoolIsFull,
  reconcileClaimedPerson,
  backfillPersonEmail,
  joinExistingEntrant,
  inviteUnclaimedMembers,
  playerPersonConsentsByEmail,
  anyOptedOutByRegistration,
  type RegistrationRow,
  type RegistrationSettingsRow,
} from "./registrations";
import { anyOptedOut, resolvePersonDisplayName } from "@/lib/name-display";
import {
  divisionEligibilityIssues,
  requiresDob,
  requiresGender,
  rosterIssues,
  formatEligibilityIssues,
  seasonStartYearFrom,
  type EligibilityIssue,
} from "./registration-eligibility";

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

export interface SubmitGroupContact {
  name: string;
  email: string;
  /** Collected once, cart-wide (design §4 step 1) — only when some division
   *  needs it or the contact plays themselves on at least one entry. Feeds
   *  BOTH the guardian-consent gate below and, per entry, the self player
   *  row's own dob (a player row need not retype it). */
  dob?: string | null;
  gender?: string | null;
  guardian_name?: string | null;
  guardian_consent?: boolean;
}

export interface SubmitGroupPlayerInput {
  full_name: string;
  dob?: string | null;
  gender?: string | null;
  email?: string | null;
  squad_number?: number | null;
  is_captain?: boolean;
}

export interface SubmitGroupEntryInput {
  division_id: string;
  /** Must match the division's configured `registration_settings.entrant_kind`
   *  — a confirmation the caller already knows this, not a free choice. */
  entrant_kind: "team" | "individual" | "pair";
  team_name?: string | null;
  /** Cosmetic only for a pair's display name — see `pairDisplayName` below
   *  for why it does not mint a second player row on its own. */
  partner_name?: string | null;
  /** Only ever accepted when the division's `allow_free_agents` is on AND
   *  `entrant_kind` is `team` — an entry with no team of its own yet
   *  (design §5; materializes nothing until RS009's assign flow). */
  free_agent?: boolean;
  players?: SubmitGroupPlayerInput[];
  answers?: Record<string, unknown>;
  /** True when the CONTACT themselves is one of this entry's players. */
  registering_self?: boolean;
  /** 0-based index into `players` identifying which row IS the contact.
   *  Defaults to 0 for a solo `individual` entry with exactly one player. */
  self_player_index?: number;
}

export interface SubmitGroupInput {
  contact: SubmitGroupContact;
  locale?: string | null;
  /** GDPR — required, versioned (LEGAL_VERSION). Reinstated: this rule went
   *  out with `submitRegistration` and nothing in the tree fails without it
   *  (RS002 entry condition 2). */
  privacy_consent: boolean;
  /** Optional, versioned the same way (RS006 §A) — never blocks submit.
   *  Undefined/false both mean "not given"; the group row's
   *  media_consent_at/media_consent_version stay null either way. */
  media_consent?: boolean;
  entries: SubmitGroupEntryInput[];
}

export interface SubmitGroupCtx {
  orgSlug: string;
  compSlug: string;
  /** Server-resolved session identity — NEVER client input. Distinct from
   *  `SubmitGroupContact` on purpose: the trust boundary between "what the
   *  registrant typed" and "who the server knows is signed in" must stay
   *  explicit, the same way old `submitRegistration`'s `opts.sessionUserId`
   *  (a separate parameter, never part of the request body) kept it. */
  sessionUserId?: string | null;
}

export interface SubmitGroupEntryResult {
  registration_id: string;
  division_id: string;
  status: RegistrationRow["status"];
  amount_cents: number;
  join_code: string | null;
  free_agent: boolean;
}

export interface SubmitGroupResult {
  group_id: string;
  ref_code: string | null;
  access_token: string;
  currency: string;
  /** The payable subtotal — sum of NON-waitlisted entries' fees only (owner
   *  ruling 7: a waitlisted entry is never charged at submit). */
  amount_cents: number;
  entries: SubmitGroupEntryResult[];
}

export interface JoinTeamEntryCtx {
  sessionUserId?: string | null;
}

export interface JoinTeamEntryInput {
  join_code: string;
  /** Identifies ONE existing `captain_entered`/`pending` `registration_players`
   *  row to CLAIM — a captain's per-slot share link naming one specific
   *  roster spot (design §2 ruling 4: "join/claim link is the consent
   *  moment for players someone else entered"). Omitted (or the id doesn't
   *  resolve to a claimable row on THIS entry) falls back to the legacy
   *  insert-a-new-player path below, which now refuses a `pair` outright
   *  (its roster is fixed at two — see `joinTeamEntry`'s own doc comment)
   *  and is otherwise unchanged. */
  player_id?: string | null;
  player: SubmitGroupPlayerInput;
  guardian_name?: string | null;
  guardian_consent?: boolean;
  /** RS007 review defect #4 — per-player GDPR consent, persisted on THIS
   *  player's own registration_players row (privacy_consent_at/.version,
   *  V384), never on registration_groups: that column pair belongs to the
   *  CAPTAIN's cart-wide submit, and reusing it here would silently apply
   *  the captain's own choice to every later joiner. Contractually REQUIRED
   *  — `joinTeamEntry` throws 422 on a falsy value unconditionally (mirrors
   *  `submitRegistrationGroup`'s own gate, `:547`) before either the claim
   *  or insert branch ever writes. Typed optional anyway (like
   *  `guardian_consent` below, whose own enforcement is conditional on
   *  minority rather than unconditional): `PublicJoinRequest.privacy_consent`
   *  IS required at the wire (schemas.ts) and is this field's only
   *  real-traffic source, so the type gap here can never be reached through
   *  the route — it exists only so hand-built call sites (this module's own
   *  test suites) keep compiling while each is updated to pass the field
   *  explicitly, rather than a required-field edit here forcing every one
   *  of them into the same commit, including ones this task does not own. */
  privacy_consent?: boolean;
  /** Per-player media consent — optional, never blocks (mirrors
   *  SubmitGroupInput.media_consent's own "optional, never blocks"
   *  contract). THE point of this field: a deliberate `false` must persist
   *  as a recorded refusal (media_consent_at stays null) and must never
   *  silently inherit the group's own media_consent_at from the captain's
   *  earlier submit. */
  media_consent?: boolean;
}

export interface JoinTeamEntryResult {
  registration_id: string;
  player_id: string;
  consent_status: "granted" | "guardian";
}

export interface JoinPreviewSlot {
  player_id: string;
  full_name: string;
}

/** The join page's first read (design §4 "Join flow"), before it asks
 *  anyone to type anything: who/where the link joins, which captain-entered
 *  slots are still unclaimed, and whether the page may offer an "add
 *  someone new" option at all. */
export interface JoinPreviewResult {
  registration_id: string;
  display_name: string;
  division_name: string;
  competition_name: string;
  competition_slug: string;
  org_slug: string;
  org_name: string;
  unclaimed_slots: JoinPreviewSlot[];
  /** True only when this entry can still grow by adding someone NEW — never
   *  for a `pair` (fixed at two, claim-only) and never once the sport's
   *  roster cap is already met. */
  allow_new_player: boolean;
  /** Whether the JOIN page's WHO-equivalent fields need to collect a
   *  dob/gender before joinTeamEntry's own eligibility gate can evaluate
   *  this joiner — same derivation publicRegistrationInfo's
   *  PublicDivisionInfo.requires_dob/requires_gender uses
   *  (@/lib/registration-rules via this module's re-export), so the join
   *  page asks for exactly what the division needs, never more (RS007). */
  requires_dob: boolean;
  requires_gender: boolean;
  /** This entry's WHOLE roster size (every consent_status, not just the
   *  unclaimed ones above) — lets the join page render a fill meter after a
   *  successful join ("2 of 4 confirmed") purely from arithmetic on this
   *  preview, with no second round-trip: claimed_before = total_players -
   *  unclaimed_slots.length (RS007). */
  total_players: number;
  /** RS007/V380 — the retired jsonb "custom rule" note, now a first-class
   *  column the join page renders as an organiser notice, same treatment as
   *  the main register page's DivisionCard. Organiser-authored free text:
   *  render as TEXT, never as HTML/markdown. */
  eligibility_note: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mintRegistrationToken(): string {
  return REGISTRATION_TOKEN_PREFIX + randomBytes(24).toString("base64url");
}

/** Bare `extends`, no redeclared fields — `approval`/`allow_free_agents`
 *  now live on the base `RegistrationSettingsRow` itself (registrations.ts,
 *  RS004 wave 1's SETTINGS_COLS extension), so retyping them here would
 *  only add a hazard: a redeclared literal union does NOT inherit a future
 *  widening of the base, so this file could silently drift out of sync
 *  with a base type change (RS004 review finding 3). Still kept as its own
 *  name, rather than using `RegistrationSettingsRow` directly, because
 *  `loadSubmitSettings` below hand-writes its own SELECT instead of
 *  calling the shared `loadSettings` — this wave's file ownership still
 *  keeps `registrations.ts` to export-only edits. An alias of
 *  `RegistrationSettingsRow`, so it satisfies `windowOpen`'s
 *  parameter type unchanged. */
type SubmitSettingsRow = RegistrationSettingsRow;

async function loadSubmitSettings(divisionId: string): Promise<SubmitSettingsRow | null> {
  const [row] = await sql<SubmitSettingsRow[]>`
    select division_id, enabled, entrant_kind, opens_at, closes_at, capacity,
           fee_cents, refund_lock_at, form_fields, payment_method,
           payment_instructions, updated_at, approval, allow_free_agents,
           free_agent_fee_cents
    from registration_settings where division_id = ${divisionId}`;
  return row ?? null;
}

/** Division + competition + org context for ONE entry. A local shape rather
 *  than extending `registrations.ts`'s `DivisionCtx` (not exported, and that
 *  file's own comment earmarks the org-currency reader for RS002/RS003 to
 *  add — but this wave's ownership keeps `registrations.ts` to export-only
 *  edits, so it is read here instead). */
interface EntryDivisionCtx {
  id: string;
  competition_id: string;
  org_id: string;
  category: string | null;
  age_min: number | null;
  age_max: number | null;
  age_cutoff_month: number | null;
  age_cutoff_day: number | null;
  /** RS007/V380 — the retired jsonb "custom rule" note, now a first-class
   *  column `previewJoinEntry` surfaces to the join page (design: "manual,
   *  shown as a warning"). Organiser-authored free text: render as TEXT,
   *  never as HTML/markdown. */
  eligibility_note: string | null;
  /** division_name/comp_name/org_name added for `previewJoinEntry`'s
   *  "division and competition/org context" read — the same bundle
   *  `publicRegistrationStatus`/`publicRegistrationStatusByRef`
   *  (registrations.ts) already return for every other public context
   *  view, reused here for consistency rather than inventing a second
   *  shape. Purely additive; every existing caller ignores them. */
  division_name: string;
  comp_slug: string;
  comp_name: string;
  comp_visibility: string;
  starts_on: string | null;
  org_slug: string;
  org_name: string;
  org_currency: string;
  charges_enabled: boolean;
}

async function loadEntryDivisionCtx(divisionId: string): Promise<EntryDivisionCtx> {
  const [row] = await sql<EntryDivisionCtx[]>`
    select d.id, d.competition_id, d.org_id, d.category, d.age_min, d.age_max,
           d.age_cutoff_month, d.age_cutoff_day, d.eligibility_note,
           d.name as division_name,
           c.slug as comp_slug, c.name as comp_name, c.visibility as comp_visibility, c.starts_on,
           o.slug as org_slug, o.name as org_name, o.currency as org_currency,
           o.stripe_charges_enabled as charges_enabled
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    where d.id = ${divisionId}`;
  if (!row) throw new HttpError(404, "division not found");
  return row;
}

function eligibilityError(issues: EligibilityIssue[]): HttpError {
  return new HttpError(422, formatEligibilityIssues(issues).join(" "), "ELIGIBILITY", { violations: issues });
}

/**
 * One Stripe checkout pays the whole cart's subtotal (design §4 step 5) — a
 * cart mixing a `stripe` division with an `offline` one (or two `stripe`
 * divisions that could somehow disagree) cannot be collected in one session,
 * so it must never be created (review MAJOR 1). A free division (fee_cents=0)
 * imposes no constraint — it is never actually collected either way.
 */
function assertUniformPaymentMethod(settings: Iterable<{ fee_cents: number; payment_method: string }>): void {
  const paidMethods = new Set([...settings].filter((s) => s.fee_cents > 0).map((s) => s.payment_method));
  if (paidMethods.size > 1) {
    throw new HttpError(
      422,
      "This cart mixes payment methods across divisions — submit these registrations separately",
    );
  }
}

/** `team` needs a name; `pair` falls back to "player & partner" (the partner
 *  is cosmetic-only text, NOT a second player row — see the module doc);
 *  `individual`/free-agent uses the sole player's name, or the contact's. */
function entryDisplayName(
  entry: SubmitGroupEntryInput,
  players: SubmitGroupPlayerInput[],
  contact: SubmitGroupContact,
): string {
  // A free agent is `entrant_kind: "team"` at the division level (design §5:
  // "an entry with no team of its own yet") but represents ONE unassigned
  // person, not a named team — same fallback as `individual` below.
  if (entry.entrant_kind === "team" && !entry.free_agent) {
    const name = entry.team_name?.trim();
    if (!name) throw new HttpError(422, "A team name is required");
    return name;
  }
  if (entry.entrant_kind === "pair") {
    const named = entry.team_name?.trim();
    if (named) return named;
    // RS007 finding #17: the ROSTER wins over the cosmetic partner field.
    // This used to compose row 0's real name with `entry.partner_name`, a
    // value typed on a DIFFERENT step and never compared with the roster —
    // so an entry could carry "Alice & Bob" for a roster that actually read
    // Alice and Robert, permanently. The join page shows the display name as
    // its heading and the roster as its "Which one are you?" list, so the
    // partner following their own invite link saw a heading naming someone
    // who was not among the options.
    //
    // `partner_name` stays only as DEFENCE, and is unreachable as things
    // stand — do not read this line as live behaviour. A pair is fixed at
    // exactly two players (the `rawPlayers.length !== 2` check above) and
    // `full_name` is `z.string().min(1)` (schemas.ts), so players[1] is
    // always present and non-empty here. Kept so that loosening either rule
    // degrades to the old name instead of to `contact.name`; its own test
    // pins the 422 that makes it unreachable.
    const partnerFromRoster = players[1]?.full_name?.trim();
    const composed = [players[0]?.full_name, partnerFromRoster || entry.partner_name]
      .filter(Boolean)
      .join(" & ");
    return composed || contact.name;
  }
  return players[0]?.full_name?.trim() || contact.name;
}

// ---------------------------------------------------------------------------
// submitRegistrationGroup
// ---------------------------------------------------------------------------

interface PreparedEntry {
  input: SubmitGroupEntryInput;
  settings: SubmitSettingsRow;
  players: SubmitGroupPlayerInput[];
  selfIndex: number | null;
  displayName: string;
  answers: Record<string, unknown>;
}

/**
 * Public group submit (design §4 step 5). One transaction:
 *  - per entry: window open, settings enabled, kind matches the division,
 *    `free_agent` only when `allow_free_agents`
 *  - eligibility for every player row (`rosterIssues`, including the self
 *    row — it is just one more row in `players`)
 *  - guardian consent when the CONTACT is a minor registering themselves;
 *    privacy consent required, versioned
 *  - capacity: row-lock per division (`FOR UPDATE` on `registration_settings`,
 *    same row and same reason old `submitRegistration` locked it — it always
 *    exists once registration is open, unlike the possibly-empty counted
 *    set) + plan cap via `getLimit`; over-capacity -> `waitlisted`, else
 *    `pending`, then `confirmed` inline when `approval='auto'` and the entry
 *    is free (a NEW shortcut `approval` makes possible — RS002 introduces
 *    `approval` itself, so there is no "old" behaviour to mirror here beyond
 *    the shape of the ladder)
 *  - payable subtotal = sum of non-waitlisted entries' fees only, stored on
 *    the group; per-entry `amount_cents` stays (owner ruling 7)
 *  - the submitter's own player row carries `user_id` via `deriveLinkUserId`,
 *    unchanged semantics
 *
 * Free agents (design §5) never auto-materialise here regardless of approval
 * mode or fee — there is no team yet to attach an entrant to; RS009 owns
 * assignment. Checkout-session minting, the confirmation email and analytics
 * stay OUT of this function (design §4 step 5 frames session-minting as the
 * ENDPOINT's job) — this usecase stays payment- and notification-agnostic,
 * returning a plain `SubmitGroupResult` for the caller to act on. RS003
 * built the checkout minting on top (`mintGroupCheckout`, called by the
 * public register route); RS005 W4 wires the confirmation email the same
 * way, from that same route, via `registrations.ts`'s `notifySubmitted` —
 * it is no longer unimplemented, just still not this function's concern.
 */
export async function submitRegistrationGroup(
  ctx: SubmitGroupCtx,
  input: SubmitGroupInput,
): Promise<SubmitGroupResult> {
  if (input.entries.length === 0) throw new HttpError(422, "At least one entry is required");

  const now = new Date();

  // Resolve every distinct division touched by the cart, sorted — the SAME
  // order is used below for both settings validation and lock acquisition,
  // so two concurrent carts touching an overlapping division set can never
  // deadlock against each other.
  const distinctDivisionIds = [...new Set(input.entries.map((e) => e.division_id))].sort();
  const divisionCtxById = new Map<string, EntryDivisionCtx>();
  for (const id of distinctDivisionIds) divisionCtxById.set(id, await loadEntryDivisionCtx(id));

  const first = divisionCtxById.get(distinctDivisionIds[0]!)!;
  for (const dc of divisionCtxById.values()) {
    // A cart is scoped to ONE competition (route: /shared/[org]/[comp]/register)
    // — cross-competition/cross-org division ids are rejected the same way
    // old submitRegistration 404'd an org/comp slug mismatch.
    if (
      dc.org_id !== first.org_id ||
      dc.competition_id !== first.competition_id ||
      dc.org_slug !== ctx.orgSlug ||
      dc.comp_slug !== ctx.compSlug ||
      !["public", "unlisted"].includes(dc.comp_visibility)
    ) {
      throw new HttpError(404, "division not found");
    }
  }
  const orgId = first.org_id;
  const competitionId = first.competition_id;
  const seasonYear = seasonStartYearFrom(first.starts_on);

  const settingsById = new Map<string, SubmitSettingsRow>();
  for (const id of distinctDivisionIds) {
    const s = await loadSubmitSettings(id);
    if (!s || !windowOpen(s, now)) throw new HttpError(422, "Registration is not open for this division");
    settingsById.set(id, s);
  }

  // One Stripe checkout per cart is the design (§4 step 5) — a cart whose
  // PAID divisions disagree on how to collect payment cannot be paid in one
  // session, so it must not be creatable at all (review MAJOR 1). Checked
  // structurally here, before any waitlist outcome is known: a cart that can
  // never be charged coherently 422s regardless of which entries end up
  // waitlisted. Re-checked again under the lock below (paymentMethodsSeen)
  // against LIVE settings — a concurrent edit could change which method a
  // division charges between this read and the lock.
  assertUniformPaymentMethod(settingsById.values());

  // Per-entry structural + eligibility validation — pure, no writes, so a bad
  // cart 422s before any transaction opens.
  const prepared: PreparedEntry[] = [];
  let registeringSelfAnywhere = false;
  for (const entry of input.entries) {
    const settings = settingsById.get(entry.division_id)!;
    const divCtx = divisionCtxById.get(entry.division_id)!;
    if (entry.entrant_kind !== settings.entrant_kind) {
      throw new HttpError(422, `This division only accepts ${settings.entrant_kind} entries`);
    }
    if (entry.free_agent && (entry.entrant_kind !== "team" || !settings.allow_free_agents)) {
      // "Solo sign-ups" is the organiser-facing name for this since
      // 2026-08-25; `allow_free_agents` stays the column and the API field.
      throw new HttpError(422, "Solo sign-ups are not accepted for this division");
    }

    const rawPlayers = entry.players ?? [];
    if (!entry.free_agent) {
      if (entry.entrant_kind === "individual" && rawPlayers.length !== 1) {
        throw new HttpError(422, "An individual entry needs exactly one player");
      }
      if (entry.entrant_kind === "pair" && rawPlayers.length !== 2) {
        throw new HttpError(422, "A pair entry needs exactly two players");
      }
    } else if (rawPlayers.length > 1) {
      throw new HttpError(422, "A free-agent entry takes at most one player");
    }

    let selfIndex: number | null = null;
    if (entry.registering_self) {
      const idx =
        entry.self_player_index ??
        (entry.entrant_kind === "individual" && rawPlayers.length === 1 ? 0 : undefined);
      if (idx !== undefined && rawPlayers[idx]) {
        selfIndex = idx;
        registeringSelfAnywhere = true;
      }
    }

    // The self row's dob/gender/email fall back to the contact's cart-level
    // values (design §4 step 1: "collected once") when the row itself didn't
    // repeat them; any other row is untouched. `email` added for #22 — the
    // captain's OWN email (`contact.email`, always present) is exactly the
    // identity signal that lets a LATER registration for the same captain
    // dedupe instead of minting a fresh person every time they self-link.
    const players = rawPlayers.map((p, i) =>
      i === selfIndex
        ? {
            ...p,
            dob: p.dob ?? input.contact.dob ?? null,
            gender: p.gender ?? input.contact.gender ?? null,
            email: p.email ?? input.contact.email ?? null,
          }
        : p,
    );

    const issues = rosterIssues(
      {
        category: divCtx.category,
        age_min: divCtx.age_min,
        age_max: divCtx.age_max,
        age_cutoff_month: divCtx.age_cutoff_month,
        age_cutoff_day: divCtx.age_cutoff_day,
      },
      players.map((p) => ({ full_name: p.full_name, dob: p.dob, gender: p.gender })),
      seasonYear,
    );
    if (issues.length > 0) throw eligibilityError(issues);

    const answers = validateAnswers(settings.form_fields ?? [], entry.answers ?? {});
    const displayName = entryDisplayName(entry, players, input.contact);
    prepared.push({ input: entry, settings, players, selfIndex, displayName, answers });
  }

  // Guardian consent — the EFFECTIVE self dob decides minority, not
  // `input.contact.dob` alone (guardian-consent-bypass fix, HIGH,
  // 2026-08-26): `prepared[i].players[selfIndex].dob` already carries the
  // SAME `p.dob ?? contact.dob` fallback applied above (~line 412-416), so
  // a self-linked roster row's own dob — client-editable with no
  // readOnly/disabled once a division requires_dob (roster-table.tsx:
  // 116-118) — can no longer be masked by an adult `contact.dob` from step
  // 1. A captain-entered OTHER player's own consent is still deferred to
  // their claim/join moment (design §4 step 4) — this only widens the
  // check to the CONTACT'S OWN row on every self-linked entry, which never
  // gets a later claim moment.
  const selfDobs = prepared
    .map((p) => (p.selfIndex !== null ? p.players[p.selfIndex]?.dob : null))
    .filter((dob): dob is string => Boolean(dob));
  if (registeringSelfAnywhere && selfDobs.some((dob) => isMinor(dob, now))) {
    if (!input.contact.guardian_consent || !input.contact.guardian_name?.trim()) {
      throw new HttpError(422, "A guardian's name and consent are required for players under 18");
    }
  }

  // GDPR privacy consent (RS002 entry condition 2 — reinstated; nothing in
  // the tree fails without this check today).
  if (!input.privacy_consent) throw new HttpError(422, "Please agree to the privacy policy to register");

  // Card-payment entitlement gate, mirrors old submitRegistration exactly.
  for (const s of settingsById.values()) {
    if (s.fee_cents > 0 && s.payment_method === "stripe") {
      if (!first.charges_enabled) {
        throw new HttpError(
          503,
          "Card payments are temporarily unavailable for this event — try again shortly or contact the organiser",
        );
      }
      await requireFeature(orgId, "registration.paid", competitionId);
    }
  }

  // Plan cap resolved OUTSIDE the transaction on purpose (lib/entitlements.ts
  // `assertWithinLimit` doc, entrants.ts:231 precedent): `getLimit` queries
  // the pooled `sql` proxy, and issuing that from inside an open transaction
  // that already pins a connection is the self-deadlock class that hung
  // production twice (lib/db.ts's nesting-guard comment). Only the LOOKUP
  // moves out — the count and every insert stay inside one transaction.
  const planLimit = await getLimit(orgId, "entrants.per_division.max", competitionId);

  const secret = mintRegistrationToken();
  const linkUserId = ctx.sessionUserId ?? null;

  const txResult = await sql.begin(async (tx) => {
    // Deterministic lock order (sorted division ids, acquired sequentially)
    // — the ONLY safe way two transactions that both need several of the
    // same locks can never deadlock against each other.
    //
    // RE-SELECTS the locked row's live columns rather than a throwaway
    // `select 1` (review MAJOR 3): `capacity`/`fee_cents`/`payment_method`/
    // `approval` and the window were all read ABOVE, before this lock — a
    // concurrent settings edit (capacity lowered, price changed,
    // registration closed) between that read and this lock would otherwise
    // be silently ignored, the exact class of bug the lock exists to
    // prevent, one level up. The hardCap/fee/window/approval decisions below
    // all read from `liveSettingsById`, never from the pre-lock `settingsById`
    // snapshot (which stays in scope only for the pre-tx structural checks
    // above, which do not need transactional freshness).
    const liveSettingsById = new Map<string, SubmitSettingsRow>();
    for (const id of distinctDivisionIds) {
      const [live] = await tx<SubmitSettingsRow[]>`
        select division_id, enabled, entrant_kind, opens_at, closes_at, capacity,
               fee_cents, refund_lock_at, form_fields, payment_method,
               payment_instructions, updated_at, approval, allow_free_agents,
               free_agent_fee_cents
        from registration_settings where division_id = ${id} for update`;
      if (!live || !windowOpen(live, now)) {
        throw new HttpError(422, "Registration is not open for this division");
      }
      liveSettingsById.set(id, live);
    }

    // The group row first (registrations FK to it) — amount_cents/payment
    // fields are placeholders here, corrected once every entry's waitlist
    // outcome is known below (still inside this one transaction).
    let refCode: string | null = null;
    let groupId: string | undefined;
    for (let attempt = 0; attempt < 5 && !groupId; attempt++) {
      const candidate = generateRefCode();
      try {
        groupId = await tx.savepoint(async (sp) => {
          const [g] = await sp<{ id: string }[]>`
            insert into registration_groups
              (competition_id, contact_name, contact_email, user_id, locale,
               ref_code, access_token_hash, amount_cents, currency,
               privacy_consent_at, privacy_consent_version,
               media_consent_at, media_consent_version)
            values (
              ${competitionId}, ${input.contact.name}, ${input.contact.email},
              ${linkUserId}, ${input.locale ?? null}, ${candidate},
              ${hashRegistrationToken(secret)}, 0, ${first.org_currency},
              now(), ${LEGAL_VERSION},
              ${input.media_consent ? sp`now()` : null}, ${input.media_consent ? LEGAL_VERSION : null}
            )
            returning id`;
          refCode = candidate;
          return g!.id;
        });
      } catch (err) {
        const pg = err as { code?: string; constraint_name?: string };
        if (pg.code !== "23505" || !String(pg.constraint_name ?? "").includes("ref_code")) throw err;
      }
    }
    if (!groupId) throw new HttpError(503, "could not allocate a reference — please retry");

    let subtotal = 0;
    const paymentMethodsSeen = new Set<string>();
    const entryResults: SubmitGroupEntryResult[] = [];
    // RS008 gap (code-review fix, 2026-08-30): this cart-level auto-confirm
    // is the one materialise() convergence point that never fired the
    // post-commit claim-invite sweep — every OTHER confirm path
    // (confirmRegistration/confirmPaidRegistration/markRegistrationPaidOffline/
    // confirmRegistrationWaived, joinTeamEntry's own two branches) already
    // does. Collected here (inside the tx, alongside entryResults) rather
    // than swept per-entry immediately after materialise(), so the sweep
    // itself only ever runs once the whole transaction has actually
    // committed — see the `void inviteUnclaimedMembers(...)` call below.
    const autoConfirmedEntrantIds: string[] = [];

    for (const p of prepared) {
      // LIVE settings (fetched under the lock above), never the pre-lock
      // `p.settings` snapshot — review MAJOR 3.
      const live = liveSettingsById.get(p.input.division_id)!;
      // Counting happens INSIDE the lock, after every earlier entry in THIS
      // SAME cart is already inserted (same transaction sees its own
      // uncommitted writes) — two entries in one cart for the same division
      // correctly contend for the same slots.
      //
      // RS012 ruling 1: `capacity` counts TEAM entries — `free_agent = false`
      // excludes every solo sign-up from this count, regardless of its
      // status, so one never eats a team slot at submit time and never keeps
      // eating one after RS009 assigns it onto a team (that assignment
      // deliberately leaves this row confirmed/free_agent=true forever).
      const [{ n: taken }] = await tx<{ n: number }[]>`
        select count(*)::int as n from registrations
        where division_id = ${p.input.division_id} and status in ${tx([...SPOT_HOLDERS])}
          and free_agent = false`;
      const hardCap = Math.min(
        live.capacity ?? Number.POSITIVE_INFINITY,
        planLimit ?? Number.POSITIVE_INFINITY,
      );
      // A free-agent entry never competes for a TEAM slot at all (meaningless
      // for a solo sign-up once `taken` excludes it above) — it draws against
      // its own derived pool bound instead, and is REFUSED outright rather
      // than queued: "you cannot sign up solo when there is no possible place
      // for you" (ruling 1). Never waitlisted, ever.
      let waitlisted: boolean;
      if (p.input.free_agent) {
        if (await soloPoolIsFull(tx, p.input.division_id, hardCap)) {
          throw new HttpError(422, "This division's solo sign-up pool is full");
        }
        waitlisted = false;
      } else {
        waitlisted = taken >= hardCap;
      }
      // On a TEAM division `fee_cents` is the price of a team. Someone
      // entering that division alone is buying one place, not a team, so they
      // pay `free_agent_fee_cents` when the organiser has set one (RS009).
      //
      // `?? live.fee_cents`, never `||`: NULL means "no separate price, use
      // the team price" and is the default on every division, while 0 is a
      // real price meaning free. `||` would collapse the two and charge the
      // full team fee to a registrant the public page told was free.
      const entryFeeCents =
        p.input.free_agent && live.free_agent_fee_cents !== null
          ? live.free_agent_fee_cents
          : live.fee_cents;
      const feeCents = waitlisted ? 0 : entryFeeCents;
      if (!waitlisted && feeCents > 0) paymentMethodsSeen.add(live.payment_method);
      const status: RegistrationRow["status"] = waitlisted ? "waitlisted" : "pending";

      let regRow: RegistrationRow;
      if ((p.input.entrant_kind === "team" || p.input.entrant_kind === "pair") && !p.input.free_agent) {
        // join_code is minted for every NON-free-agent team OR pair entry
        // regardless of waitlist outcome — a waitlisted team can still grow
        // its roster (or a pair's partner still claim their spot) while it
        // waits (only money/status are gated by waitlisting, not the link).
        // Widened to `pair` (RS007 "found while using the shipped RS006
        // flow", 2026-08-27): a pair's roster is fixed at exactly two
        // (structural check above, and rosterIssues at submit), so its
        // join_code only ever lets the partner CLAIM their already-typed-in
        // row — `joinTeamEntry` 422s a pair's insert-a-new-person path (see
        // its own `entrant_kind === "pair"` guard). `free_agent` cannot be
        // true for a `pair` (the structural check above only allows it for
        // `team`), so the `!p.input.free_agent` guard is a no-op for pairs
        // today — kept for symmetry with the team branch rather than special-
        // cased away. A free agent is `entrant_kind: "team"` at the division
        // level but represents ONE unassigned person (design §5) — minting a
        // join_code for it would let other players "join" and grow it into
        // an ad hoc roster, bypassing RS009's assignment flow entirely
        // (review MAJOR 4). `joinTeamEntry` also refuses a free-agent row
        // directly, as defense in depth.
        let row: RegistrationRow | undefined;
        for (let attempt = 0; attempt < 5 && !row; attempt++) {
          const candidate = generateRefCode();
          try {
            row = await tx.savepoint(async (sp) => {
              const [r] = await sp<RegistrationRow[]>`
                insert into registrations
                  (group_id, division_id, display_name, status, answers,
                   amount_cents, join_code, free_agent)
                values (
                  ${groupId}, ${p.input.division_id}, ${p.displayName}, ${status},
                  ${sp.json(p.answers as never)}, ${feeCents}, ${candidate},
                  ${p.input.free_agent ?? false}
                )
                returning *`;
              return r;
            });
          } catch (err) {
            const pg = err as { code?: string; constraint_name?: string };
            if (pg.code !== "23505" || !String(pg.constraint_name ?? "").includes("join_code")) throw err;
          }
        }
        if (!row) throw new HttpError(503, "could not allocate a join code — please retry");
        regRow = row;
      } else {
        const [r] = await tx<RegistrationRow[]>`
          insert into registrations
            (group_id, division_id, display_name, status, answers, amount_cents, free_agent)
          values (
            ${groupId}, ${p.input.division_id}, ${p.displayName}, ${status},
            ${tx.json(p.answers as never)}, ${feeCents}, ${p.input.free_agent ?? false}
          )
          returning *`;
        regRow = r!;
      }

      for (let i = 0; i < p.players.length; i++) {
        const player = p.players[i]!;
        const isSelf = i === p.selfIndex;
        // The RESOLVED self row's own dob (review MINOR 6) — not
        // `input.contact.dob` directly. They usually agree (the self row
        // falls back to the contact's cart-level dob when it carries none of
        // its own, above), but a self row that DOES carry an explicit dob
        // while `contact.dob` is null must still link: reading
        // `input.contact.dob` here silently failed to link an eligible adult
        // in that case, the #402/#404 dedupe producer going dormant.
        const playerUserId = isSelf
          ? deriveLinkUserId(
              ctx.sessionUserId ?? null,
              {
                registering_self: true,
                guardian_name: input.contact.guardian_name,
                guardian_consent: input.contact.guardian_consent,
                dob: player.dob,
              },
              now,
            )
          : null;
        await tx`
          insert into registration_players
            (registration_id, full_name, dob, gender, email, source, consent_status,
             consent_at, guardian_name, user_id, squad_number, is_captain)
          values (
            ${regRow.id}, ${player.full_name}, ${player.dob ?? null}, ${player.gender ?? null},
            ${player.email ?? null},
            'captain_entered', ${isSelf ? "granted" : "pending"},
            ${isSelf ? tx`now()` : null}, ${isSelf ? (input.contact.guardian_name ?? null) : null},
            ${playerUserId}, ${player.squad_number ?? null}, ${player.is_captain ?? false}
          )`;
      }

      // Free entries under auto-approval confirm INLINE — a shortcut RS002's
      // new `approval` column makes possible (old code never auto-confirmed
      // at submit; `approval` did not exist before this redesign). Never for
      // a waitlisted entry.
      //
      // RS009 REMOVED the free-agent exclusion that used to sit here. Its
      // reason — "there is no team yet to materialise into (design §5)" — was
      // correct while `materialise` would have minted a phantom one-person
      // entrant for a solo sign-up. It no longer does: it seats no entrant
      // for a free agent and confirms them anyway. The exclusion outlived its
      // justification and became harmful, because a solo sign-up on a FREE
      // division then sat at `pending` forever, and RS009's own
      // confirmed-or-paid guard hid the Assign control from it — making the
      // whole assignment feature unreachable on exactly the divisions most
      // likely to want it. Two individually-correct changes; the defect lived
      // in the gap. Found by e2e, not by any unit test.
      let finalStatus = regRow.status;
      if (!waitlisted && live.approval === "auto" && feeCents === 0) {
        const entrantId = await materialise(tx, regRow, p.input.entrant_kind);
        finalStatus = "confirmed";
        // The filter is LIVE, not forward-compatible spare capacity. RS008.1
        // added it ahead of RS009 with a note that it was a no-op "because
        // this branch already excludes free agents above" — true then, and
        // no longer: RS009 removed that exclusion (see the block comment on
        // the condition above), so a solo sign-up now reaches here and
        // `materialise` hands back null for it.
        //
        // Skipping is correct, not defensive: a solo sign-up seats no
        // entrant, so there is no roster to invite anyone onto. A `!` here
        // would compile and feed null into inviteUnclaimedMembers, whose
        // parameter is `string` — the same shape RS009 had to fix in
        // confirmPaidRegistration, where an `as unknown as` cast was
        // suppressing exactly that.
        if (entrantId) autoConfirmedEntrantIds.push(entrantId);
      }

      subtotal += waitlisted ? 0 : feeCents;
      entryResults.push({
        registration_id: regRow.id,
        division_id: p.input.division_id,
        status: finalStatus,
        amount_cents: feeCents,
        join_code: regRow.join_code,
        free_agent: p.input.free_agent ?? false,
      });
    }

    // Backstop re-check against LIVE data (review MAJOR 1 + MAJOR 3
    // together): the pre-tx `assertUniformPaymentMethod` call already
    // rejected a structurally-mixed cart, but a concurrent settings edit
    // between that read and the lock above could in principle create a
    // mismatch the pre-check never saw. `paymentMethodsSeen` was built from
    // `liveSettingsById` and already excludes waitlisted/free entries, so
    // >1 distinct method here is the same guarantee, made off fresh data —
    // and this throw rolls back cleanly like any other in-tx failure.
    if (paymentMethodsSeen.size > 1) {
      throw new HttpError(
        422,
        "This cart mixes payment methods across divisions — submit these registrations separately",
      );
    }
    const groupPaymentMethod = [...paymentMethodsSeen][0] ?? null;
    const anyPendingStripe =
      groupPaymentMethod === "stripe" && entryResults.some((e) => e.status === "pending" && e.amount_cents > 0);

    await tx`
      update registration_groups
      set amount_cents = ${subtotal}, payment_method = ${groupPaymentMethod},
          expires_at = ${anyPendingStripe ? tx`now() + interval '48 hours'` : null},
          updated_at = now()
      where id = ${groupId}`;

    return { groupId: groupId!, refCode, subtotal, entryResults, autoConfirmedEntrantIds };
  });

  // RS008 gap (code-review fix, 2026-08-30): fire-and-forget, strictly AFTER
  // the transaction above has committed — see confirmRegistration's
  // identical wiring (registrations.ts) for why. One call per auto-confirmed
  // entry: a cart can hold more than one free/auto-approval division at
  // once, each materialising its own entrant.
  for (const entrantId of txResult.autoConfirmedEntrantIds) {
    void inviteUnclaimedMembers(orgId, entrantId);
  }

  // Logged AFTER `sql.begin` resolves (review MINOR 7) — inside the callback
  // this fired before commit was guaranteed; a rollback after the log line
  // (the ref/join-code retry loops both throw past it on exhaustion) would
  // have logged a submission that was never actually persisted.
  log.info(
    {
      event: "registration.group_submitted",
      group_id: txResult.groupId,
      org_id: orgId,
      competition_id: competitionId,
      entries: txResult.entryResults.length,
      waitlisted: txResult.entryResults.filter((e) => e.status === "waitlisted").length,
      confirmed: txResult.entryResults.filter((e) => e.status === "confirmed").length,
      amount_cents: txResult.subtotal,
    },
    "registration group submitted",
  );

  return {
    group_id: txResult.groupId,
    ref_code: txResult.refCode,
    access_token: secret,
    currency: first.org_currency,
    amount_cents: txResult.subtotal,
    entries: txResult.entryResults,
  };
}

// ---------------------------------------------------------------------------
// joinTeamEntry
// ---------------------------------------------------------------------------

/** Roster headcount vs the sport's configured cap (design "squad-size config
 *  where defined, else unlimited") — `sports.position_catalog.lineup.size +
 *  .benchMax` via the shared `rosterCapExpr` (registrations.ts; RS005 W1b
 *  re-pointed the squad-cap check at it — one source instead of two hand-
 *  copies). `null` cap reads as unlimited. Shared by `previewJoinEntry`'s
 *  `allow_new_player` and `joinTeamEntry`'s insert path so the two can never
 *  drift apart (this repo's parallel-vocab-lookup trap).
 *
 *  Parameterised on the connection (matching `divisionCtx`/`rosterCapExpr`
 *  themselves, registrations.ts) — RS007: `joinTeamEntry`'s insert path
 *  calls this a SECOND time from inside its own `sql.begin`, on `tx`, as the
 *  authoritative re-check right before the INSERT it guards. */
async function rosterAtCap(db: Tx | typeof sql, divisionId: string, registrationId: string): Promise<boolean> {
  const [cap] = await db<{ max: number | null }[]>`
    select ${rosterCapExpr(db)} as max
    from divisions d join sports sp on sp.key = d.sport_key
    where d.id = ${divisionId}`;
  if (cap?.max == null) return false;
  const [{ n }] = await db<{ n: number }[]>`
    select count(*)::int as n from registration_players where registration_id = ${registrationId}`;
  return n >= cap.max;
}

// ---------------------------------------------------------------------------
// previewJoinEntry
// ---------------------------------------------------------------------------

/**
 * Join-link preview — the join page's first read, before it asks anyone to
 * type anything (design §4 "Join flow"). Resolves the SAME way
 * `joinTeamEntry` does (global `join_code` lookup, no org/competition
 * scoping needed) and applies the SAME dead-entry gates (free agent,
 * withdrawn/rejected/expired) so a link `joinTeamEntry` would refuse never
 * previews as live either — and, like that lookup, an unknown OR dead code
 * returns the identical 404-shape: never leak whether a code once existed.
 */
export async function previewJoinEntry(joinCode: string): Promise<JoinPreviewResult> {
  const [reg] = await sql<
    {
      id: string;
      division_id: string;
      display_name: string;
      status: string;
      free_agent: boolean;
      entrant_kind: "team" | "individual" | "pair";
    }[]
  >`
    select r.id, r.division_id, r.display_name, r.status, r.free_agent, rs.entrant_kind
    from registrations r
    join registration_settings rs on rs.division_id = r.division_id
    where r.join_code = ${joinCode}`;
  if (!reg || reg.free_agent || ["withdrawn", "rejected", "expired"].includes(reg.status)) {
    throw new HttpError(404, "This join link is not valid");
  }

  const divCtx = await loadEntryDivisionCtx(reg.division_id);
  // RS008 review fix #1: this join-page HEADING's own consent rule — see
  // `entryDisplayName`'s doc comment (register/status/view-model.ts) for why
  // a team's own name is exempt but this can be a person's (individual) or
  // a pair's compound name.
  const [divPolicy] = await sql<{ youth: boolean; player_name_display: string | null }[]>`
    select youth, player_name_display from divisions where id = ${reg.division_id}`;

  const slots = await sql<{ id: string; full_name: string; email: string | null }[]>`
    select id, full_name, email from registration_players
    where registration_id = ${reg.id} and source = 'captain_entered' and consent_status = 'pending'
    order by squad_number nulls last, created_at`;

  // #24 — a `pending` slot's own consent is genuinely undecided, so ordinarily
  // it previews raw. But #22's email dedupe means a captain-typed row CAN
  // already match an EXISTING person elsewhere in the org's directory who has
  // separately opted out — that person's own choice, already on record, must
  // not be overridden just because THIS particular row hasn't been claimed
  // yet. Read-only lookup: unlike materialise time (which needs the
  // EXACT-ONE identity guarantee findOrCreatePlayerPerson relies on), this is
  // a masking decision — RS008 review fix #8 — so an AMBIGUOUS match (2+
  // persons sharing one email; duplicates exist per the merge feature) must
  // not fail OPEN into "preview raw." playerPersonConsentsByEmail returns
  // every match's consent; anyOptedOut masks if ANY of them opted out, same
  // "stricter wins" rule applied everywhere else in this session. Zero
  // matches (or no email at all) means no CONSENT-based opt-out was found —
  // that alone no longer decides the outcome: `resolvePersonDisplayName`
  // below also applies the DIVISION's youth/safeguarding policy (code review
  // fix, 2026-08-30), the same second axis the join page's own HEADING
  // already applies via `divPolicy.youth` a few lines further down. A youth
  // division masks every slot regardless of consent; the consent check here
  // only ever ADDS masking on top, never removes youth's.
  const unclaimedSlots = await Promise.all(
    slots.map(async (s) => {
      const trimmedEmail = s.email?.trim() || null;
      const consents = trimmedEmail
        ? await playerPersonConsentsByEmail(sql, divCtx.org_id, trimmedEmail)
        : [];
      const optedOut = anyOptedOut(consents);
      return {
        player_id: s.id,
        full_name: resolvePersonDisplayName(
          s.full_name,
          optedOut ? { public_name: false } : null,
          divPolicy?.player_name_display ?? null,
          divPolicy?.youth ?? false,
        ),
      };
    }),
  );

  // Never for a `pair` (fixed at two — claim only), and never once the
  // sport's cap is already met. Short-circuited so a pair never even issues
  // the cap query.
  const allowNewPlayer = reg.entrant_kind !== "pair" && !(await rosterAtCap(sql, reg.division_id, reg.id));

  // Deliberately a SEPARATE count query from rosterAtCap's own (registered_
  // players where registration_id = ...) rather than threading its result
  // out — rosterAtCap is called conditionally (short-circuited for a pair)
  // and returns a boolean, and this preview needs the WHOLE roster's size
  // unconditionally, including for a pair. Cheap: covered by the same
  // registration_players_registration_idx either query already uses.
  const [{ n: totalPlayers }] = await sql<{ n: number }[]>`
    select count(*)::int as n from registration_players where registration_id = ${reg.id}`;

  // RS008 review fix #6 (Minor) — this heading was reg.display_name raw; for
  // a `pair` (a `team`'s never takes the consent axis) this is a compound
  // person name. Masked the same way /r/[ref] (publicRegistrationStatusByRef)
  // already does for the identical field: anyOptedOutByRegistration reuses
  // the SAME aggregate this session's other compound-string sites use.
  const isTeam = reg.entrant_kind === "team";
  const optedOutRegs = isTeam ? new Set<string>() : await anyOptedOutByRegistration(sql, [reg.id]);
  const displayName = resolvePersonDisplayName(
    reg.display_name,
    optedOutRegs.has(reg.id) ? { public_name: false } : null,
    divPolicy?.player_name_display ?? null,
    divPolicy?.youth ?? false,
  );

  return {
    registration_id: reg.id,
    display_name: displayName,
    division_name: divCtx.division_name,
    competition_name: divCtx.comp_name,
    competition_slug: divCtx.comp_slug,
    org_slug: divCtx.org_slug,
    org_name: divCtx.org_name,
    unclaimed_slots: unclaimedSlots,
    allow_new_player: allowNewPlayer,
    requires_dob: requiresDob({
      age_min: divCtx.age_min,
      age_max: divCtx.age_max,
    }),
    // eligibility_note passed through for compatibility only — requiresGender
    // (RS007 review fix M2) never reads it: a free-text note must never make
    // a field mandatory (registration-eligibility.ts's own doc comment on
    // requiresGender has the full account).
    requires_gender: requiresGender({ category: divCtx.category, eligibility_note: divCtx.eligibility_note }),
    total_players: totalPlayers,
    eligibility_note: divCtx.eligibility_note,
  };
}

// ---------------------------------------------------------------------------
// joinTeamEntry
// ---------------------------------------------------------------------------

/**
 * Player joining an existing team OR pair entry via its link (design §4
 * "Join flow"). `join_code` is GLOBALLY unique (V364 partial unique index),
 * so a `?join=<CODE>` link carries nothing else — no org/competition
 * scoping needed for the lookup, matching how `ref_code` lookups already
 * work.
 *
 * Two paths, chosen by whether `input.player_id` names an existing row:
 *  - CLAIM (player_id given): the captain already typed this person in at
 *    submit — `source='captain_entered'`, `consent_status='pending'`. This
 *    is the consent moment design §2 ruling 4 promises ("join/claim link is
 *    the consent moment for players someone else entered") — the row is
 *    UPDATED in place (dob/gender/guardian_name/consent_status/user_id),
 *    NEVER duplicated. A row that is not `pending` (already claimed) 409s —
 *    the dedupe a captain-entered row had no guard against before this
 *    existed. A `player_id` that does not resolve to a pending, captain-
 *    entered row on THIS entry reads exactly like an invalid link (404) —
 *    which case it was is never leaked back to the caller.
 *  - INSERT (player_id omitted): a genuinely new person adds themselves,
 *    same as before — cap-checked against the sport's roster cap, and now
 *    refused outright (422) for a `pair`, whose roster is fixed at exactly
 *    two by the structural check at submit: the second seat can only ever
 *    be CLAIMED, never grown. `#23`: if the entry was ALREADY materialised
 *    (an entrant_id is already set) before this joiner arrived,
 *    `materialise()` will never revisit this registration to roster them —
 *    so this path also calls `joinExistingEntrant` to write the
 *    `entrant_members` row itself.
 *
 * A joiner is, by construction, registering themselves — `deriveLinkUserId`
 * is reused verbatim with `registering_self: true` hardcoded, so the SAME
 * adult+no-guardian-fields rule that protects submit's self row protects a
 * join too (a guardian filling the form for a minor must not accidentally
 * link the CHILD's row to the guardian's own account). Eligibility, the
 * minor/guardian gate, AND the privacy-consent gate below all apply
 * identically on both paths — a CLAIMED row was typed in by the CAPTAIN,
 * who never consented on this player's behalf, so the claim moment is
 * exactly as much this player's OWN first consent as a fresh insert's is
 * (design §2 ruling 4 above; consent-asymmetry follow-up, 2026-08-28).
 */
export async function joinTeamEntry(
  ctx: JoinTeamEntryCtx,
  input: JoinTeamEntryInput,
): Promise<JoinTeamEntryResult> {
  const now = new Date();
  const [reg] = await sql<
    {
      id: string;
      division_id: string;
      status: string;
      org_id: string;
      free_agent: boolean;
      entrant_kind: "team" | "individual" | "pair";
    }[]
  >`
    select r.id, r.division_id, r.status, r.org_id, r.free_agent, rs.entrant_kind
    from registrations r
    join registration_settings rs on rs.division_id = r.division_id
    where r.join_code = ${input.join_code}`;
  if (!reg) throw new HttpError(404, "This join link is not valid");
  // Defense in depth (review MAJOR 4): submitRegistrationGroup never mints a
  // join_code for a free agent (design §5 — it is one unassigned person, not
  // a roster to grow), so this should be unreachable through normal submit —
  // but a code path that DID acquire one must still be refused here, before
  // the roster-cap check, rather than let a free agent be "joined" into an
  // ad hoc team that bypasses RS009's assignment flow.
  if (reg.free_agent) throw new HttpError(422, "This entry has no roster to join yet");
  if (["withdrawn", "rejected", "expired"].includes(reg.status)) {
    throw new HttpError(422, "This entry is no longer accepting players");
  }

  if (!input.player_id) {
    // A pair's roster is fixed at exactly two (structural check, submit) —
    // its join_code exists only so the partner can CLAIM their already-
    // typed-in row (widened mint, review "found while using the shipped
    // RS006 flow" 2026-08-27). Growing it past two has no claim to enforce
    // against, so it is refused outright rather than falling through to a
    // cap check that would (mis)report "roster is already full".
    if (reg.entrant_kind === "pair") {
      throw new HttpError(
        422,
        "This pair's roster is fixed — the second player claims their spot, it can't be added as new",
      );
    }
    if (await rosterAtCap(sql, reg.division_id, reg.id)) {
      throw new HttpError(422, "This roster is already full");
    }
  }

  const divCtx = await loadEntryDivisionCtx(reg.division_id);

  const issues = divisionEligibilityIssues(
    {
      category: divCtx.category,
      age_min: divCtx.age_min,
      age_max: divCtx.age_max,
      age_cutoff_month: divCtx.age_cutoff_month,
      age_cutoff_day: divCtx.age_cutoff_day,
    },
    { dob: input.player.dob, gender: input.player.gender },
    seasonStartYearFrom(divCtx.starts_on),
  );
  if (issues.length > 0) throw eligibilityError(issues);

  const minor = !!input.player.dob && isMinor(input.player.dob, now);
  if (minor && !(input.guardian_consent && input.guardian_name?.trim())) {
    throw new HttpError(422, "A guardian's name and consent are required for players under 18");
  }

  // GDPR privacy consent (mirrors submitRegistrationGroup:547) — required on
  // BOTH branches below, not just the insert path (consent-asymmetry
  // follow-up, 2026-08-28: this was previously enforced only by the join
  // form's own client-side gate, so a direct API call could join with no
  // consent recorded at all). registration_groups.privacy_consent_at is the
  // CAPTAIN's own choice, stamped at THEIR submit, and is never read here
  // (PublicJoinRequest.privacy_consent's own doc comment) — a claimed row
  // was typed in by the captain, who never consented on this player's
  // behalf, so the claim moment is where THIS player's own consent is
  // captured for the first time, exactly like a freshly-inserted joiner's.
  if (!input.privacy_consent) throw new HttpError(422, "Please agree to the privacy policy to join");

  const consentStatus: "granted" | "guardian" = minor ? "guardian" : "granted";
  const linkUserId = deriveLinkUserId(
    ctx.sessionUserId ?? null,
    {
      registering_self: true,
      guardian_name: input.guardian_name,
      guardian_consent: input.guardian_consent,
      dob: input.player.dob,
    },
    now,
  );

  // Everything above is a cheap pre-check (fast-fail before the eligibility
  // work runs at all) — never authoritative on its own. Two windows lived
  // between it and the write below: a concurrent withdraw (withdrawCore,
  // registrations.ts) landing after this read but before the claim UPDATE,
  // and rosterAtCap's own pre-check above being a plain SELECT-count ahead
  // of an unguarded INSERT. Both close the same way withdrawCore closes its
  // own: lock the row, re-read it LIVE, then write — inside one short
  // transaction holding nothing but this claim/insert (RS007).
  const claimedEmail = input.player.email?.trim() || null;
  // RS008: captured from `locked` (below) for the post-commit claim-invite
  // sweep — set on BOTH the claim (player_id given) and insert branches,
  // since either can land on an entry ALREADY materialised (claimed.person_id
  // non-null on the claim branch; #23's own gap on the insert branch), which
  // is exactly the "already materialised" condition RS008's invite convergence
  // point requires. null when the entry has never been materialised (nothing
  // to sweep yet — materialise() itself will trigger the sweep whenever it
  // eventually runs).
  let materialisedEntrantId: string | null = null;

  const playerId = await sql.begin(async (tx) => {
    const [locked] = await tx<{ status: string; free_agent: boolean; entrant_id: string | null }[]>`
      select status, free_agent, entrant_id from registrations where id = ${reg.id} for update`;
    if (!locked) throw new HttpError(404, "This join link is not valid");
    materialisedEntrantId = locked.entrant_id;
    if (locked.free_agent) throw new HttpError(422, "This entry has no roster to join yet");
    if (["withdrawn", "rejected", "expired"].includes(locked.status)) {
      throw new HttpError(422, "This entry is no longer accepting players");
    }

    if (input.player_id) {
      // Atomic compare-and-swap: the WHERE clause IS the verification
      // (belongs to this entry, still a pending captain-entered row) — a
      // concurrent double-claim of the same slot can make at most one
      // caller win, no separate SELECT-then-UPDATE race window. full_name
      // is deliberately NOT overwritten — only the fields the insert path
      // itself fills. `email` added for #22 — the claimer's own email wins
      // over whatever (if anything) the captain guessed at submit, same as
      // dob/gender/guardian_name here already do.
      //
      // dob/gender use coalesce (RS007 review fix L2), not a bare overwrite:
      // the join form renders those inputs only when requires_dob/
      // requires_gender, so if an organiser removes the division's age band
      // or gender rule between the captain's submit and this claim,
      // input.player.dob/.gender arrive undefined even though the captain
      // already typed a real value in. A claim may fill a blank or correct
      // a value, never ERASE one — findOrCreatePlayerPerson's own dob rule
      // (and any later youth handling) depends on it surviving.
      const [claimed] = await tx<{ id: string; person_id: string | null }[]>`
        update registration_players
        set dob = coalesce(${input.player.dob ?? null}, dob),
            gender = coalesce(${input.player.gender ?? null}, gender),
            email = ${claimedEmail},
            consent_status = ${consentStatus},
            consent_at = now(),
            guardian_name = ${minor ? (input.guardian_name ?? null) : null},
            user_id = ${linkUserId},
            privacy_consent_at = ${input.privacy_consent ? tx`now()` : null},
            privacy_consent_version = ${input.privacy_consent ? LEGAL_VERSION : null},
            media_consent_at = ${input.media_consent ? tx`now()` : null},
            media_consent_version = ${input.media_consent ? LEGAL_VERSION : null},
            updated_at = now()
        where id = ${input.player_id}
          and registration_id = ${reg.id}
          and source = 'captain_entered'
          and consent_status = 'pending'
        returning id, person_id`;
      if (!claimed) {
        // Distinguish "already claimed" (409, a real conflict) from every
        // other reason the compare-and-swap could miss — wrong code, wrong
        // entry, a self_joined row, or an id that doesn't exist — which all
        // read as the same invalid-link 404 a dead join_code gives, so a
        // caller can never learn WHICH case it was.
        const [existing] = await tx<{ id: string }[]>`
          select id from registration_players
          where id = ${input.player_id} and registration_id = ${reg.id} and source = 'captain_entered'`;
        if (existing) throw new HttpError(409, "This player has already joined");
        throw new HttpError(404, "This join link is not valid");
      }

      // #22 — reconcile against the directory. `claimed.person_id` is only
      // ever non-null when this entry was ALREADY materialised BEFORE the
      // claim (materialise() sets it once, at confirm time, and never
      // revisits a row): that dummy, anonymous person was minted from
      // whatever the captain typed with no consent behind it — exactly the
      // "captain-typed duplicate" #22 exists to close. A row claimed BEFORE
      // its entry is materialised needs no extra write here: `email` (just
      // persisted above) and `user_id` now sit on the row, so
      // materialise()'s own findOrCreatePlayerPerson/resolvePlayerPerson
      // call — whenever it eventually fires — dedupes correctly on its own.
      if (claimed.person_id) {
        const resolved = await reconcileClaimedPerson(
          tx,
          reg.org_id,
          input.player.full_name,
          input.player.dob ?? null,
          input.player.gender ?? null,
          linkUserId,
          claimedEmail,
        );
        if (resolved && resolved !== claimed.person_id) {
          // Repoint the ONE entrant_members row this claim owns from the
          // dummy person to the resolved one. Guarded: entrant_members'
          // primary key is (entrant_id, person_id) — if `resolved` is
          // somehow ALREADY a member of this same entrant (a second row on
          // this roster independently resolving to the same human — not
          // expected in practice, but not impossible), the UPDATE below
          // would violate it. A raw try/catch cannot recover from that on
          // its own: Postgres marks the WHOLE transaction aborted the
          // instant one statement errors, so every later statement
          // (including this claim's own outer COMMIT) fails too, even
          // though the JS exception was caught — same reason the join_code
          // collision retry above this function uses `tx.savepoint`, not a
          // bare try/catch on `tx`. Caught here rather than failing the
          // claim: the dummy stays in place, same as any other duplicate
          // #22 leaves for the existing #404 merge flow rather than
          // auto-merging.
          try {
            await tx.savepoint(async (sp) => {
              await sp`
                update entrant_members set person_id = ${resolved}
                where entrant_id = ${locked.entrant_id} and person_id = ${claimed.person_id}`;
              await sp`
                update registration_players set person_id = ${resolved}, updated_at = now()
                where id = ${claimed.id}`;
            });
          } catch (err) {
            const pg = err as { code?: string };
            if (pg.code !== "23505") throw err;
          }
        } else if (!resolved && claimedEmail) {
          // No existing person to repoint to — this claimer's email is new
          // to the directory. The dummy IS the right person going forward;
          // give it the email it was minted without, so the NEXT
          // registration for this same human can match on it.
          await backfillPersonEmail(tx, claimed.person_id, claimedEmail);
        }
      }
      return claimed.id;
    }

    // Re-run under the lock just taken (review MAJOR, RS007) — the pre-check
    // above is only a fast fail; two joiners racing the last open spot must
    // never both pass this one.
    if (await rosterAtCap(tx, reg.division_id, reg.id)) {
      throw new HttpError(422, "This roster is already full");
    }
    const [player] = await tx<{ id: string }[]>`
      insert into registration_players
        (registration_id, full_name, dob, gender, email, source, consent_status,
         consent_at, guardian_name, user_id,
         privacy_consent_at, privacy_consent_version,
         media_consent_at, media_consent_version)
      values (
        ${reg.id}, ${input.player.full_name}, ${input.player.dob ?? null}, ${input.player.gender ?? null},
        ${claimedEmail},
        'self_joined', ${consentStatus}, now(), ${minor ? (input.guardian_name ?? null) : null}, ${linkUserId},
        ${input.privacy_consent ? tx`now()` : null}, ${input.privacy_consent ? LEGAL_VERSION : null},
        ${input.media_consent ? tx`now()` : null}, ${input.media_consent ? LEGAL_VERSION : null}
      )
      returning id`;
    // #23 — a join landing on an entry ALREADY materialised (entrant_id set
    // before this joiner ever showed up) gets no entrant_members row from
    // materialise() itself: its `if (reg.entrant_id) return` guard means it
    // never runs again for this registration. Without this, the row above
    // exists but the person is never actually rostered.
    if (locked.entrant_id) {
      await joinExistingEntrant(tx, reg.org_id, locked.entrant_id, {
        id: player!.id,
        full_name: input.player.full_name,
        dob: input.player.dob ?? null,
        gender: input.player.gender ?? null,
        email: claimedEmail,
        user_id: linkUserId,
      });
    }
    return player!.id;
  });

  // RS008: fire-and-forget, strictly AFTER the transaction above has
  // committed (never inside it — see inviteUnclaimedMembers's own doc
  // comment). Covers BOTH branches at once: a claim (player_id given) whose
  // `claimed.person_id` was non-null landed here with `locked.entrant_id`
  // set, and an insert (#23) landing on an already-materialised entry sets
  // the same field via `joinExistingEntrant`'s write above — either way,
  // this joiner (and any other already-granted, unclaimed member of the
  // SAME entrant) is swept in one call.
  if (materialisedEntrantId) void inviteUnclaimedMembers(reg.org_id, materialisedEntrantId);

  log.info(
    {
      event: "registration.player_joined",
      registration_id: reg.id,
      org_id: reg.org_id,
      via: input.player_id ? "claim" : "insert",
    },
    "player joined team entry via link",
  );

  return { registration_id: reg.id, player_id: playerId, consent_status: consentStatus };
}
