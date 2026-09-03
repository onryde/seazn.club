// The registration driver interface (B03r task 4, design §3). Two
// implementations exist: `http.ts` (this task — cookie-jar HTTP, one
// `Session` per person) and a later `browser.ts` (plain playwright, drives
// hosted Stripe Checkout). `register.ts` (a later task) owns resolving pack
// ext-keys/refs into the concrete, wire-ready shapes declared below — this
// file and `http.ts` never see a `PackRegistrationEntry` or a `PackRef`, only
// already-resolved ids/emails/names. That keeps the driver testable in
// isolation (this task's whole point) and keeps `pack-schema.ts` (frozen pre-
// B06) untouched.
//
// A `Scorer` interface is named alongside these in design §3 but belongs to
// B16. It is deliberately NOT declared here: B16 hasn't designed its shape
// yet, and a stub interface would advertise a contract nobody has approved —
// worse than the seam simply not existing. Nothing here costs a later
// addition; `Scorer` slots in beside `Organiser`/`Captain`/`Player` whenever
// B16 defines it.

// ---------------------------------------------------------------------------
// Shared wire-adjacent shapes
// ---------------------------------------------------------------------------

/** `m`/`f`/`x` — the exact enum `PublicRegisterGroupContact.gender` and
 *  `PublicRegisterGroupPlayer.gender` both use (api-v1/schemas.ts). */
export type PersonGender = "m" | "f" | "x";

/** `divisions.category` (V364) / `PublicRegistrationDivision.category`'s
 *  non-null values — `DivisionCategory` in api-v1/schemas.ts. */
export type DivisionCategoryValue = "open" | "mens" | "womens" | "mixed";

/** `registration_settings.entrant_kind` — `EntrantKind` in
 *  api-v1/schemas.ts, identical to `pack-schema.ts`'s `PackEntrantKind`. */
export type EntrantKindValue = "individual" | "team" | "pair";

/** `registration_settings.approval` — `RegistrationApproval` in
 *  api-v1/schemas.ts. */
export type ApprovalMode = "auto" | "manual";

/** One player row — `PublicRegisterGroupPlayer` (submit) and the identical
 *  shape `PublicJoinRequest.player` (join) both reuse. camelCase here;
 *  `http.ts` maps to the wire's snake_case keys. */
export interface RegistrationPlayer {
  fullName: string;
  dob?: string | null;
  gender?: PersonGender | null;
  email?: string | null;
  squadNumber?: number | null;
  isCaptain?: boolean;
}

/** `PublicRegisterGroupContact` (submit) — the contact captured once,
 *  cart-wide. */
export interface RegistrationContact {
  name: string;
  email: string;
  dob?: string | null;
  gender?: PersonGender | null;
  guardianName?: string | null;
  guardianConsent?: boolean;
}

// ---------------------------------------------------------------------------
// Organiser
// ---------------------------------------------------------------------------

/** The subset of `PackRegistrationBlock` (pack-schema.ts:1246-1259) needed to
 *  configure a division's registration — everything else in that block
 *  (entries/joins/organiser/expect) is the funnel content `register.ts`
 *  drives separately, not division config. */
export interface RegistrationBlockConfig {
  category: DivisionCategoryValue;
  ageMin?: number;
  ageMax?: number;
  entrantKind: EntrantKindValue;
  feeCents: number;
  approval: ApprovalMode;
  capacity?: number;
}

export type OrganiserActionKind = "approve" | "reject" | "promote" | "assign_free_agent";

/** Mirrors `PackRegistrationOrganiserAction` (pack-schema.ts:1230) once
 *  `target` has been resolved from an ext-key to a real registration id. */
export interface OrganiserAction {
  action: OrganiserActionKind;
  /** The registration this action targets — the URL's `{id}` for every one
   *  of the four actions (for "assign_free_agent" this is the FREE AGENT's
   *  own registration, never the team it's being placed onto). */
  registrationId: string;
  /** "assign_free_agent" only — the team entry's registration id
   *  (`target_registration_id` in `AssignSoloSignUp`'s body). Required for
   *  that action; unused by the other three. */
  targetRegistrationId?: string;
}

export interface Organiser {
  /** Issues BOTH `PATCH /divisions/{id}` (restriction fields) AND
   *  `PUT /divisions/{id}/registration-settings` (funnel settings) — see
   *  `http.ts`'s doc comment on why both are mandatory. */
  configureRegistration(divisionId: string, block: RegistrationBlockConfig): Promise<void>;
  act(action: OrganiserAction): Promise<void>;
}

// ---------------------------------------------------------------------------
// Captain
// ---------------------------------------------------------------------------

/** Routing context for the public submit endpoint — org/competition slugs
 *  are in the URL; the division itself is named inside the entry body
 *  (`PublicRegisterGroupEntry.division_id`), because one cart can span
 *  several divisions in the same competition. */
export interface RegistrationDivisionTarget {
  orgSlug: string;
  competitionSlug: string;
  divisionId: string;
}

/** One cart line (`PublicRegisterGroupEntry` + the cart-wide contact/consent
 *  fields `PublicRegisterGroupRequest` carries alongside it) — everything
 *  `Captain.enter()` needs for ONE entry. `selfPlayerIndex` left unset lets
 *  the server's own default apply (0 for a single-player individual entry —
 *  `PublicRegisterGroupRequest`'s superRefine, schemas.ts:2740-2748); set it
 *  explicitly for anything else `registeringSelf` needs to identify. */
export interface RegistrationEntry {
  contact: RegistrationContact;
  privacyConsent: boolean;
  mediaConsent?: boolean;
  entrantKind: EntrantKindValue;
  teamName?: string | null;
  partnerName?: string | null;
  freeAgent?: boolean;
  players?: RegistrationPlayer[];
  answers?: Record<string, string | boolean>;
  registeringSelf?: boolean;
  selfPlayerIndex?: number;
  /** Honeypot passthrough (`PublicRegisterGroupRequest.website`) — a bench
   *  driver never fills it; defaults to "" in `http.ts` when omitted. */
  website?: string;
}

export type EntryOutcomeStatus = "pending" | "approved" | "waitlisted" | "rejected_eligibility";

/** `ref` is the registration id (`PublicRegisterGroupEntryResult.
 *  registration_id`) once one exists. An eligibility rejection happens
 *  BEFORE any row is inserted (registration-submit.ts throws pre-insert), so
 *  there is nothing to reference — `ref` is `""` for `rejected_eligibility`,
 *  documented here rather than left to be discovered as a surprise empty
 *  string downstream. */
export interface EntryOutcome {
  status: EntryOutcomeStatus;
  ref: string;
}

/** What `Captain.pay()` needs to identify an entry. The HTTP driver never
 *  reads this (it unconditionally throws `PaidEntryNeedsBrowser`) — kept
 *  minimal on purpose; a later browser-driver task may widen it once it
 *  knows what its own Checkout flow needs beyond the id. */
export interface PayableEntry {
  registrationId: string;
}

export interface Captain {
  enter(entry: RegistrationEntry, division: RegistrationDivisionTarget): Promise<EntryOutcome>;
  pay(entry: PayableEntry): Promise<void>;
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

/** Routing + payload for `Player.join()`. Bundles the org/competition slugs
 *  (the join POST route has no division segment — `join_code` alone
 *  resolves which entry) alongside the joining player's own data, mirroring
 *  how `RegistrationDivisionTarget` bundles routing for `enter()`. */
export interface JoinEntry {
  orgSlug: string;
  competitionSlug: string;
  player: RegistrationPlayer;
  /** Claims an existing captain-entered slot (`PublicJoinRequest.player_id`)
   *  instead of inserting a new player row. Omit to insert new. */
  playerId?: string | null;
}

/** `PublicJoinRequest`'s consent fields — required guardian_name/consent
 *  only when the joining player is a minor (StepConsent's own
 *  `guardianRequired`, out of this driver's scope to evaluate; the caller
 *  decides). */
export interface ConsentInput {
  privacyConsent: boolean;
  mediaConsent?: boolean;
  guardianName?: string | null;
  guardianConsent?: boolean;
}

export interface Player {
  join(entry: JoinEntry, joinCode: string, consent: ConsentInput): Promise<void>;
}
