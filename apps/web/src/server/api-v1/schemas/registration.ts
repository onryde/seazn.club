// /api/v1 contracts — registration and entry fees: staff side, the public register/join/status flow, Stripe Connect onboarding.
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
import { EntrantKind, Uuid } from "./common.ts";
import { CameraPolicyS } from "./divisions.ts";

// ---------------------------------------------------------------------------
// Registration & entry fees (doc 16 §1.1, PROMPT-20a)
// ---------------------------------------------------------------------------

/** RS005 W1b: the ONE exported source for this status set — the DB CHECK
 *  (`db/migration/deltas/V364__registrations_regroup.sql`) allows all seven;
 *  the route allowlists and the OpenAPI query enum both derive from
 *  `RegistrationStatus.options` rather than hand-copying the list, so a
 *  fourth copy can't silently drift out of sync (RS005 W1a's `rejected`
 *  status was previously missing here and from the division list route). */
export const RegistrationStatus = z.enum([
  "pending", "paid", "confirmed", "waitlisted", "withdrawn", "expired", "rejected",
]);

/** RS005 W1a `ListRegistrationsFilters.sort` — single source for the same
 *  reason as `RegistrationStatus` above. */
export const RegistrationSort = z.enum(["oldest", "newest"]);

/** How a division collects its entry fee (spec 2026-07-12 §3). */
export const RegistrationPaymentMethod = z.enum(["offline", "stripe"]);

/** V364/RS004: 'auto' reproduces pre-RS004 behaviour untouched — every
 *  entry auto-confirms. 'manual' routes entries through approve/reject
 *  (registration-approval.ts) before they materialise. */
export const RegistrationApproval = z.enum(["auto", "manual"]);

/** Bounded form-field builder (doc 16 §1.1): text/select/checkbox only. */
export const RegistrationFormField = z
  .object({
    key: z.string().min(1).max(40).regex(/^[a-z0-9_]+$/, "lowercase snake_case"),
    label: z.string().min(1).max(120),
    kind: z.enum(["text", "select", "checkbox"]),
    options: z.array(z.string().min(1).max(80)).min(1).max(20).optional(),
    required: z.boolean().default(false),
  })
  .strict()
  .refine((f) => f.kind !== "select" || (f.options?.length ?? 0) > 0, {
    message: "select fields need options",
  });
export type RegistrationFormField = z.infer<typeof RegistrationFormField>;

export const PutRegistrationSettings = z
  .object({
    enabled: z.boolean(),
    /** Omitted = the division's own default kind (FU1: its effective entrant model), never a fixed 'individual' the division
     *  may not take. A kind outside the division's Entrant kinds is 422 ENTRANT_KIND_NOT_ALLOWED. */
    entrant_kind: EntrantKind.optional(),
    opens_at: z.iso.datetime({ offset: true }).nullish(),
    closes_at: z.iso.datetime({ offset: true }).nullish(),
    capacity: z.number().int().min(1).max(10000).nullish(),
    fee_cents: z.number().int().min(0).max(100_000_00).default(0),
    // No `currency` (RS001b): it is org-level now (`organizations.currency`,
    // allowlisted by DB CHECK), because one cart can span divisions and a
    // Stripe checkout session has exactly one currency. The org settings page
    // owns the select; this panel shows a read-only chip.
    refund_lock_at: z.iso.datetime({ offset: true }).nullish(),
    /** V389/RS012. `null` (the default) means "use the division's own
     *  `closes_at`" (ruling 2) — the pool-deadline sweep's own fallback,
     *  usecases/registrations/. Nullable, not optional-with-a-sentinel, for the
     *  same reason `refund_lock_at` above is: clearing it back to the
     *  default is a real, meaningful edit, not "field omitted". */
    place_by_at: z.iso.datetime({ offset: true }).nullish(),
    form_fields: z.array(RegistrationFormField).max(12).default([]),
    payment_method: RegistrationPaymentMethod.default("offline"),
    /** Per-division override of the org's offline payment instructions. */
    payment_instructions: z.string().max(5000).nullish(),
    /** V364/RS004. Default reproduces pre-RS004 behaviour untouched. */
    approval: RegistrationApproval.default("auto"),
    /** V364/RS004: meaningful only when entrant_kind is 'team' — the usecase
     *  rejects `true` on a non-team division (putRegistrationSettings). */
    allow_free_agents: z.boolean().default(false),
    /** V388/RS009: what ONE person pays to enter this team division alone.
     *  `null` (the default) means "no separate price — charge fee_cents",
     *  which is what every division did before this existed. 0 is a real
     *  price meaning free, so this is nullish rather than optional-with-0:
     *  the two must not collapse. The usecase rejects a value here when
     *  allow_free_agents is off, and rejects a negative one. */
    free_agent_fee_cents: z.number().int().min(0).nullish(),
  })
  .superRefine((s, ctx) => {
    const keys = s.form_fields.map((f) => f.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", message: "duplicate form field keys" });
    }
  });
/** Input shape (pre-parse): defaulted fields stay optional so direct callers
 *  (tests, scripts) can omit them; the usecase normalises like the route. */
export type PutRegistrationSettings = z.input<typeof PutRegistrationSettings>;

export const RegistrationSettings = z.object({
  division_id: Uuid,
  enabled: z.boolean(),
  entrant_kind: EntrantKind,
  opens_at: z.string().nullable(),
  closes_at: z.string().nullable(),
  capacity: z.number().int().nullable(),
  fee_cents: z.number().int(),
  /** The ORG's currency (RS001b), echoed here so the division settings panel
   *  can render its read-only chip without a second fetch. Not writable — the
   *  request schema has no `currency`. */
  currency: z.string(),
  refund_lock_at: z.string().nullable(),
  /** V389/RS012 — null means "use closes_at" (ruling 2); see PutRegistrationSettings above. */
  place_by_at: z.string().nullable(),
  form_fields: z.array(RegistrationFormField),
  payment_method: RegistrationPaymentMethod,
  payment_instructions: z.string().nullable(),
  approval: RegistrationApproval,
  allow_free_agents: z.boolean(),
  /** V388/RS009. `null` = no separate price; the panel renders the team fee
   *  as the effective price in that case. */
  free_agent_fee_cents: z.number().int().nullable(),
  /** Org fallbacks for the settings UI (spec §3). */
  org_payment_instructions: z.string().nullable(),
  org_default_payment_method: z.string(),
  /** Paid registration readiness (org-level): Stripe Connect charges enabled. */
  charges_enabled: z.boolean(),
  updated_at: z.string().nullable(),
});

/** Organiser view of one registration — a DOCUMENTED SUBSET of
 *  `RegistrationWithGroupRow`, not a stripped mirror of it. `v1()` neither
 *  validates nor strips against this schema (`api-v1/http.ts:124-149`
 *  serialises whatever the handler returns), so every row field the handler
 *  does not delete still rides the wire: `org_id`, `user_id`,
 *  `checkout_session_id`, `dispute_id`, `fee_percent`, `privacy_consent_at`,
 *  `group_refunded_cents`, `updated_at` and more. Only `access_token_hash` is
 *  removed by construction, because it is credential-derived. Adding a field
 *  here documents it; it does not start shipping it, and omitting a field does
 *  not stop it.
 *  RS005 W1b: `dob`/`gender`/`guardian_name`/`guardian_consent` dropped —
 *  RS001 moved them off `registrations` onto `registration_players`
 *  (per-player, not per-entry) before this route surface ever shipped, so
 *  they were never real columns here. `contact_name`/`group_id`/`join_code`/
 *  `free_agent` added — the row has always carried them. */
export const Registration = z.object({
  id: Uuid,
  division_id: Uuid,
  status: RegistrationStatus,
  ref_code: z.string().nullable(),
  display_name: z.string(),
  contact_name: z.string(),
  contact_email: z.string(),
  answers: z.record(z.string(), z.unknown()),
  amount_cents: z.number().int(),
  currency: z.string().nullable(),
  payment_method: z.string().nullable(),
  payment_intent_id: z.string().nullable(),
  refunded_cents: z.number().int(),
  refunded_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  offline_marked_paid_at: z.string().nullable(),
  /** When the organiser approved this entry on a manual-approval division while its fee was still owed (V513): the entry stays
   *  `pending` until it is paid, and its payment then confirms it. Null when never approved that way (an entry approved after paying
   *  is confirmed at once and carries no stamp). */
  approved_at: z.string().nullable(),
  disputed_at: z.string().nullable(),
  entrant_id: Uuid.nullable(),
  promoted_at: z.string().nullable(),
  withdrawn_at: z.string().nullable(),
  /** The cart this entry belongs to (V364) — every entry has exactly one. */
  group_id: Uuid,
  /** Set when this (team) entry can hand out a self-join link. */
  join_code: z.string().nullable(),
  free_agent: z.boolean(),
  created_at: z.string(),
});

export const RefundRegistration = z.object({
  /** Omitted = refund the full remaining amount. */
  amount_cents: z.number().int().min(1).optional(),
});
export type RefundRegistration = z.infer<typeof RefundRegistration>;

/** `listRegistrations`' wire shape (RS005 W1a/W1b) — `Registration` widened
 *  with the seven columns the Registrants-tab list/export routes add:
 *  the division's own name/slug, its resolved `entrant_kind`, roster
 *  fill/cap, pending-consent count and (waitlisted rows only) queue
 *  position. Kept SEPARATE from `Registration` rather than folding these
 *  fields into it — the single-registration action routes (approve/reject/
 *  promote/confirm/…) return the narrow shape and never carry
 *  `waitlist_position` or the rest; collapsing the two would advertise those
 *  fields on a response that can never carry them. */
export const RegistrationListEntry = Registration.extend({
  division_name: z.string(),
  division_slug: z.string(),
  entrant_kind: EntrantKind,
  roster_count: z.number().int(),
  /** null = unlimited (the sport declares no lineup config). */
  roster_cap: z.number().int().nullable(),
  consent_pending_count: z.number().int(),
  /** 1-based rank within the division's waitlist; null for every other
   *  status. */
  waitlist_position: z.number().int().nullable(),
  /** B5 (V519) — the two stored halves of this entry's OWN reference, which the row has always carried (`regGroupCols`) and the
   *  organiser's registrant detail, the CSV's `entry_reference` column and the search now read. `cart_position` is the entry's 1-based
   *  place in the cart it was sent in, never changed or reused after submit; `cart_size` is how many entries that cart was sent
   *  with, never decremented. The reference to quote is `ref_code` for a cart sent with one entry, and `ref_code` + `-` + `cart_position`
   *  for a cart sent with two or more (`entryReferenceOf`, `lib/ref-code.ts`) — so a withdrawn or deleted sibling never moves another entry's
   *  reference, and an integration building the string itself must read `cart_size`, never count the rows it was sent. */
  cart_position: z.number().int().min(1),
  cart_size: z.number().int().min(1),
  /** RS009 — where a SOLO SIGN-UP currently sits, or null while still in the
   *  pool. Null on every non-solo-sign-up row. Derived from the roster row
   *  pointing back at this entry, never mirrored onto `registrations`, so the
   *  pool and the roster cannot disagree. */
  assigned_team_id: Uuid.nullable(),
  assigned_team_name: z.string().nullable(),
  /** RS009 — the solo sign-up's own gender when the division collected one.
   *  The assign sheet predicts a mixed division's refusal from it BEFORE the
   *  organiser spends a click; null means unknown, and it then predicts
   *  nothing rather than guessing. */
  player_gender: z.string().nullable(),
  /** RS009 — has this row's division started, in the sense that its rosters
   *  are no longer the organiser's to shuffle? True once the division has any
   *  fixture, or once its competition's `starts_on` has passed. Mirrors
   *  `unassignSoloSignUp`'s own refusal so the hub never renders a Remove
   *  button the server will refuse. */
  division_started: z.boolean(),
  /** When the organiser last pressed "Send payment reminder" for this entry (the newest `registration.payment_reminded` audit row);
   *  null if never. */
  last_reminded_at: z.string().nullable(),
  /** The organiser's presses for this entry inside the reminder cap's 24 h window (the cap's own count); at the cap the hub disables
   *  Send payment reminder, since the press would be refused with PAYMENT_REMINDER_LIMIT. */
  reminders_in_window: z.number().int().nonnegative(),
  /** When an automatic waitlist promotion last passed this waiting entry over because its Lichess account is not linked to play, in
   *  its current wait; null otherwise (and on every entry that is not waitlisted). The hub shows "Skipped on <date>: Lichess wasn't
   *  linked". */
  promotion_skipped_at: z.string().nullable(),
});

/** `POST /registrations/{id}/promote` body. `id` in the URL resolves which
 *  division to promote within (every registration belongs to exactly one);
 *  `registration_id`, when given, overrides which waitlisted entry gets
 *  promoted instead of the oldest (`PromoteFromWaitlistOpts.registrationId`,
 *  registration-approval.ts) — it need not equal the URL `id`. Omitted →
 *  oldest-first, `promoteFromWaitlist`'s default. */
export const PromoteRegistration = z.object({
  registration_id: Uuid.optional(),
});
export type PromoteRegistration = z.infer<typeof PromoteRegistration>;

/** `POST /registrations/{id}/assign` body (RS009) — places the solo sign-up
 *  `id` onto `target_registration_id`, a team entry in the same division.
 *  `assignSoloSignUp` (registration-assign.ts) owns every rule this can
 *  fail: same-division, roster cap, mixed-division composition, idempotent
 *  re-assign, 409 when the player is already on a different team. */
export const AssignSoloSignUp = z.object({
  target_registration_id: Uuid,
});
export type AssignSoloSignUp = z.infer<typeof AssignSoloSignUp>;

/** `GET /registrations/{id}/assign-targets` response (RS009) — every
 *  assignable team entry in `id`'s division: non-free-agent, non-terminal
 *  registrations, with enough roster state for the UI to explain, BEFORE
 *  the click, why a mixed division will refuse a placement (the same rule
 *  `assignSoloSignUp` enforces server-side). */
export const AssignTargets = z.object({
  division_id: Uuid,
  division_category: z.string().nullable(),
  targets: z.array(
    z.object({
      registration_id: Uuid,
      display_name: z.string(),
      roster_count: z.number().int(),
      /** null = unlimited (the sport declares no lineup config) — same
       *  convention as `RegistrationListEntry.roster_cap`. */
      roster_cap: z.number().int().nullable(),
      is_full: z.boolean(),
      genders: z.array(z.enum(["m", "f", "x"]).nullable()),
    }),
  ),
});
export type AssignTargets = z.infer<typeof AssignTargets>;

/** `POST /registrations/{id}/assign` response (RS009). Carries the roster
 *  state AFTER the placement so a caller need not re-fetch to render the new
 *  fill — the same reason `RegistrationListEntry` carries roster_count and
 *  roster_cap rather than letting each consumer recompute them. */
export const AssignSoloSignUpResult = z.object({
  registration_id: Uuid,
  target_registration_id: Uuid,
  /** The roster row created — or the one already there, since assign is
   *  idempotent and a repeat returns the existing placement. */
  player_id: Uuid,
  target_display_name: z.string(),
  roster_count: z.number().int(),
  /** null = unlimited, never zero. */
  roster_cap: z.number().int().nullable(),
});
export type AssignSoloSignUpResult = z.infer<typeof AssignSoloSignUpResult>;

/** `POST /registrations/{id}/unassign` response (RS009). */
export const UnassignSoloSignUpResult = z.object({
  registration_id: Uuid,
  /** The team they were removed from, or null when they were already in the
   *  pool — unassign is idempotent, and "already where you asked for" is a
   *  success, not an error. */
  target_registration_id: Uuid.nullable(),
});
export type UnassignSoloSignUpResult = z.infer<typeof UnassignSoloSignUpResult>;

// Public register flow -------------------------------------------------------

/** One division on the public register panel. */
export const PublicRegistrationDivision = z.object({
  division_id: Uuid,
  name: z.string(),
  slug: z.string(),
  sport_key: z.string(),
  entrant_kind: EntrantKind,
  fee_cents: z.number().int(),
  /** RS009 — what ONE person pays to enter this team division alone. null =
   *  no separate price; the stepper then quotes `fee_cents`. Present so the
   *  public quote and the server's charge cannot disagree. */
  free_agent_fee_cents: z.number().int().nullable(),
  currency: z.string(),
  payment_method: RegistrationPaymentMethod,
  opens_at: z.string().nullable(),
  closes_at: z.string().nullable(),
  capacity: z.number().int().nullable(),
  /** Spots left before new submissions waitlist, counted against the cap submit enforces: min(capacity, the plan's
   *  per-division entrant limit). null = neither caps the division. */
  remaining: z.number().int().nullable(),
  /** Spots taken — the masthead capacity meter (v3/05 §2). */
  taken: z.number().int(),
  /** Entries on the waiting list behind this division (PROMPT-52); 0 when nobody waits. */
  waitlisted: z.number().int().nonnegative(),
  open: z.boolean(),
  /** 'window' | 'full' (waitlist only) | 'payments_unavailable' | 'entry_kind_unavailable' (the settings' entrant kind is
   *  one the division's own entrant kinds do not include) | null */
  closed_reason: z.string().nullable(),
  /** V364 first-class columns (RS006 W1): the ENTRIES step badges these and
   *  greys a self-ineligible division using the same category/age-band
   *  predicates the server evaluates with (@/lib/registration-rules). */
  category: z.string().nullable(),
  age_min: z.number().int().nullable(),
  age_max: z.number().int().nullable(),
  /** RS007/V380 — the age-band cutoff override (default 1 January when
   *  null), threaded onto the wire so the ENTRIES step's client-side self-
   *  check evaluates the SAME cutoff the server enforces at submit. */
  age_cutoff_month: z.number().int().nullable(),
  age_cutoff_day: z.number().int().nullable(),
  /** Team-only; drives the ENTRIES step's free-agent option. */
  allow_free_agents: z.boolean(),
  requires_dob: z.boolean(),
  requires_gender: z.boolean(),
  /** Youth division (v3/11 gap 8): the form always adds guardian consent. */
  youth: z.boolean(),
  form_fields: z.array(RegistrationFormField),
  /** RS007/V380 — the retired jsonb "custom rule" note, now a first-class
   *  column the ENTRIES step renders as an organiser notice. Organiser-
   *  authored free text: render as TEXT, never as HTML/markdown. */
  eligibility_note: z.string().nullable(),
  /** T16 (spec §5.4) — the division plays online on Lichess (and the club is offered online chess): stated on the
   *  ENTRIES step, before signup. */
  online_play: z.boolean(),
  /** T16 — the camera requirement a player signs up to (the division's own setting, else the competition's); `off`
   *  whenever `online_play` is false. */
  camera_policy: CameraPolicyS,
});

export const PublicRegistrationInfo = z.object({
  competition: z.object({
    id: Uuid,
    name: z.string(),
    slug: z.string(),
    starts_on: z.string().nullable(),
    ends_on: z.string().nullable(),
  }),
  org: z.object({ name: z.string(), slug: z.string(), logo_url: z.string().nullable() }),
  divisions: z.array(PublicRegistrationDivision),
});

// The old single-entry `PublicRegisterRequest`/`PublicRegisterResponse` pair
// (and the POST route that used them) was deleted in the RS001 registration
// demolition — V363/V364 replaced the one-row-per-entry shape with
// `registration_groups` (cart) + `registration_players` (per-player rows),
// which this schema had no way to express. RS003 defines the new group-shaped
// request/response (design `2026-08-16-registration-redesign-design.md` §4).

/** Contact captured once, cart-wide — every entry's self-declaration and the
 *  guardian-consent gate both read from this one shape (`SubmitGroupContact`
 *  mirror, registration-submit.ts:47-58). */
export const PublicRegisterGroupContact = z.object({
  name: z.string().min(1).max(120),
  email: z.email().max(200),
  dob: z.iso.date().nullish(),
  gender: z.enum(["m", "f", "x"]).nullish(),
  guardian_name: z.string().max(120).nullish(),
  guardian_consent: z.boolean().optional(),
});

/** One player row on an entry (`SubmitGroupPlayerInput` mirror, registration-
 *  submit.ts:60-67). Reused unchanged by the join request below — a joiner
 *  IS a player row, just for an entry that already exists. */
export const PublicRegisterGroupPlayer = z.object({
  full_name: z.string().min(1).max(120),
  dob: z.iso.date().nullish(),
  gender: z.enum(["m", "f", "x"]).nullish(),
  email: z.email().max(200).nullish(),
  squad_number: z.number().int().min(0).max(999).nullish(),
  is_captain: z.boolean().optional(),
});

/** One cart line (`SubmitGroupEntryInput` mirror, registration-submit.ts:69-89). */
export const PublicRegisterGroupEntry = z.object({
  division_id: Uuid,
  entrant_kind: EntrantKind,
  team_name: z.string().max(120).nullish(),
  partner_name: z.string().max(120).nullish(),
  free_agent: z.boolean().optional(),
  players: z.array(PublicRegisterGroupPlayer).max(50).optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
  /** True when the CONTACT themselves is one of this entry's players. */
  registering_self: z.boolean().optional(),
  /** 0-based index into `players` identifying which row IS the contact. */
  self_player_index: z.number().int().min(0).optional(),
});

/**
 * Full cart submit (`SubmitGroupInput` mirror, registration-submit.ts:91-98).
 * No `currency` field on purpose — it is server-resolved from
 * `organizations.currency` and snapshotted by the usecase (registration-
 * submit.ts:497); a client-supplied one is simply never declared here, so
 * Zod's default (non-`.strict()`) object mode strips it rather than
 * rejecting the whole request — same as every other public request schema
 * in this file.
 *
 * #402 lineage: the pre-redesign single-entry `PublicRegisterRequest` had
 * a self-declaration coherence rule, expressed per-player-row (a top-level
 * `registering_self` PLUS a `players[].self` flag — see this file's history
 * at `850cc6308^` and `public-register-request.test.ts` at that revision).
 * The group shape collapses the two flags into one per-entry pair
 * (`registering_self` + `self_player_index`); the superRefine below is that
 * rule's per-entry replacement: a contact dob whenever ANY entry claims
 * `registering_self`, and each claim's index must land on a real player row
 * (registration-submit.ts:384-390 silently DROPS an unresolvable self
 * declaration rather than erroring, so this is the only place that tells
 * the registrant their link didn't take). A registrant MAY claim
 * `registering_self` on more than one entry cart-wide (RS006: singles +
 * doubles at the same tournament) — nothing here caps it, and
 * `self_player_index` being a single int per entry already makes "one self
 * row per ENTRY" true by construction, so no additional uniqueness check is
 * needed.
 */
export const PublicRegisterGroupRequest = z
  .object({
    contact: PublicRegisterGroupContact,
    locale: z.string().max(10).nullish(),
    privacy_consent: z.boolean(),
    /** Optional — mirrors `privacy_consent` structurally but never blocks
     *  submit (RS006 §A). Stamped the same way (timestamp + LEGAL_VERSION,
     *  registration-submit.ts) when true; left null otherwise. */
    media_consent: z.boolean().optional(),
    entries: z.array(PublicRegisterGroupEntry).min(1).max(10),
    /** Honeypot (v3/05 §4): hidden on the real form; the ROUTE decides what
     *  to do with a filled one, not this schema. */
    website: z.string().max(200).optional(),
  })
  .superRefine((v, ctx) => {
    const selfEntries = v.entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.registering_self);
    // A registrant may be `registering_self` on more than one entry (singles
    // + doubles at the same tournament is the common case in racket sports).
    // Nothing above this comment enforces a cart-wide cap any more — see
    // `self_player_index`'s own field comment above: a single int per entry
    // already makes "one self row PER ENTRY" true by construction, which is
    // all uniqueness this shape ever needed. Do not reintroduce a cart-wide
    // counter here "for safety" — that was the defect, not a guard.
    if (selfEntries.length > 0 && !v.contact.dob) {
      ctx.addIssue({
        code: "custom",
        path: ["contact", "dob"],
        message: "A date of birth is required when you're registering yourself",
      });
    }
    // Per-DIVISION, and deliberately not the cart-wide counter the comment
    // above forbids: linking yourself on entries in two DIFFERENT divisions
    // is the legitimate singles + doubles case. Twice in ONE division is the
    // same person entered twice into one draw — `persons` get-or-create keys
    // on name+dob, so both entries resolve to a single person who then holds
    // two capacity slots and is charged for both. There is no unique index on
    // (division_id, entrant) to catch it, so this is the only guard.
    const selfDivisionFirstSeen = new Map<string, number>();
    for (const { e, i } of selfEntries) {
      const firstIndex = selfDivisionFirstSeen.get(e.division_id);
      if (firstIndex === undefined) {
        selfDivisionFirstSeen.set(e.division_id, i);
      } else {
        ctx.addIssue({
          code: "custom",
          path: ["entries", i, "registering_self"],
          message: `You're already entered as yourself on another entry in this division (entry ${firstIndex + 1}) — a division can only have you once`,
        });
      }
    }
    for (const { e, i } of selfEntries) {
      // This MUST mirror the usecase's own resolution verbatim
      // (registration-submit.ts:383-393): an explicit index, or the implied 0
      // that a one-player INDIVIDUAL entry gets — and nothing else. A team,
      // pair or free-agent entry that claims `registering_self` without
      // naming the row resolves to `undefined` there and has its self
      // declaration DROPPED SILENTLY: the entry submits, the registrant is
      // never linked to their own player row, and nothing anywhere errors.
      // Defaulting to 0 here instead of `undefined` would validate exactly
      // that request and hand it to the drop. This layer is the only one that
      // can tell the registrant their self-link did not take.
      const players = e.players ?? [];
      const idx =
        e.self_player_index ??
        (e.entrant_kind === "individual" && players.length === 1 ? 0 : undefined);
      if (idx === undefined || !players[idx]) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", i, "self_player_index"],
          message: "self_player_index must identify which player on this entry is you",
        });
      }
    }
  });
export type PublicRegisterGroupRequest = z.infer<typeof PublicRegisterGroupRequest>;

/** One entry's outcome (`SubmitGroupEntryResult` mirror, registration-
 *  submit.ts:112-119). */
export const PublicRegisterGroupEntryResult = z.object({
  registration_id: Uuid,
  division_id: Uuid,
  status: RegistrationStatus,
  amount_cents: z.number().int(),
  join_code: z.string().nullable(),
  free_agent: z.boolean(),
});


/** Cart-level outcome (`SubmitGroupResult` mirror, registration-
 *  submit.ts:121-130). `checkout_url` is required-but-nullable: wave 3 wires
 *  Stripe and starts returning a real URL when a payment is due now, but the
 *  field exists from this wave on so the wire contract never has to widen. */
export const PublicRegisterGroupResponse = z.object({
  group_id: Uuid,
  ref_code: z.string().nullable(),
  access_token: z.string(),
  currency: z.string(),
  amount_cents: z.number().int(),
  checkout_url: z.string().nullable(),
  entries: z.array(PublicRegisterGroupEntryResult),
});

/** Join an existing team OR pair entry via its `join_code` link
 *  (`JoinTeamEntryInput` mirror, registration-submit.ts). A joiner is one
 *  player row, so this reuses the same player shape submit uses.
 *  `player_id` (optional) is a per-slot claim link naming ONE existing
 *  captain-entered row to CLAIM in place — omitted, it falls back to
 *  inserting a genuinely new player (refused for a `pair`, whose roster is
 *  fixed at two). */
export const PublicJoinRequest = z.object({
  join_code: z.string().min(1).max(80),
  player: PublicRegisterGroupPlayer,
  player_id: Uuid.nullish(),
  guardian_name: z.string().max(120).nullish(),
  guardian_consent: z.boolean().optional(),
  /** RS007 review defect #4 fix — collected by the join page's own CONSENT
   *  step (StepConsent, reused verbatim) and persisted PER-PLAYER by
   *  joinTeamEntry (registration_players.privacy_consent_at/.version,
   *  V384), never on registration_groups — that would silently apply the
   *  CAPTAIN's own choice to every later joiner, which is the bug that fix
   *  closed. REQUIRED here, same as PublicRegisterGroupRequest.privacy_consent
   *  (consent-asymmetry follow-up, 2026-08-28): this field was previously
   *  optional, enforced only by the join form's own client-side gate
   *  (validateConsent) — a direct API call could join with no consent
   *  recorded at all, and an omitted value was indistinguishable from a
   *  refusal. joinTeamEntry now throws 422 on a falsy value, mirroring
   *  submitRegistrationGroup's own gate (registration-submit.ts:547),
   *  identically on BOTH the claim and insert branches — a captain-typed
   *  row's own consent was never collected either, so the claim moment is
   *  exactly as much this player's first consent as a fresh insert's is. */
  privacy_consent: z.boolean(),
  /** Optional, never blocks — mirrors PublicRegisterGroupRequest.media_consent
   *  structurally (RS006 §A: "media consent is OPTIONAL and never blocks
   *  submit"). Stamped when true, left null otherwise (a deliberate `false`
   *  persists as a refusal, same as that field). */
  media_consent: z.boolean().optional(),
});
export type PublicJoinRequest = z.infer<typeof PublicJoinRequest>;

/** (`JoinTeamEntryResult` mirror, registration-submit.ts). `consent_status`
 *  is deliberately the 2-value subset this path actually returns —
 *  'pending' is `registration_players`' 3rd DB-level value, and neither the
 *  claim nor the insert branch of `joinTeamEntry` ever produces it (both
 *  only ever pick granted or guardian). */
export const PublicJoinResponse = z.object({
  registration_id: Uuid,
  player_id: Uuid,
  consent_status: z.enum(["granted", "guardian"]),
  /** Where the entry the joiner just joined stands (polish wave P3, W4/W13; `JoinTeamEntryResult.entry_state`, registration-submit.ts):
   *  confirmed, on the waitlist, or still waiting on payment and/or the organiser's approval. Only `confirmed` may be worded as "you're
   *  in". null = nothing nameable (a pending entry with no fee under auto-approval), never to be read as confirmed. */
  entry_state: z.enum(["confirmed", "waitlisted", "payment", "approval", "payment_and_approval"]).nullable(),
});

/** One CAPTAIN-ENTERED, still-`pending` slot on an entry — claimable by
 *  sending its `player_id` back as `PublicJoinRequest.player_id`
 *  (`JoinPreviewSlot` mirror, registration-submit.ts). */
export const PublicJoinPreviewSlot = z.object({
  player_id: Uuid,
  full_name: z.string(),
});

/** Join-link preview (`JoinPreviewResult` mirror, registration-submit.ts) —
 *  the join page's first read, before it asks anyone to type anything: who/
 *  where the link joins, which slots are still unclaimed, and whether the
 *  page may offer an "add someone new" option (never for a `pair`; never
 *  once the sport's roster cap is met). */
export const PublicJoinPreviewResponse = z.object({
  registration_id: Uuid,
  display_name: z.string(),
  division_name: z.string(),
  competition_name: z.string(),
  competition_slug: z.string(),
  org_slug: z.string(),
  org_name: z.string(),
  /** What kind of entry the link joins (polish wave P3, W3; `JoinPreviewResult.entrant_kind`, registration-submit.ts): the join page
   *  says "this pair is full" only for a pair. */
  entrant_kind: EntrantKind,
  /** Whether the entry is confirmed (`JoinPreviewResult.entry_confirmed`): only then does a full entry's page use check-in words. */
  entry_confirmed: z.boolean(),
  unclaimed_slots: z.array(PublicJoinPreviewSlot),
  allow_new_player: z.boolean(),
  /** RS007 join page — whether the WHO-equivalent step must collect a
   *  dob/gender before this division's eligibility can be evaluated
   *  (`JoinPreviewResult` mirror, registration-submit.ts). */
  requires_dob: z.boolean(),
  requires_gender: z.boolean(),
  /** This entry's WHOLE roster size — lets the join page compute a fill
   *  meter after a successful join with no second round-trip. */
  total_players: z.number().int().nonnegative(),
  /** RS007/V380 — the retired jsonb "custom rule" note, now a first-class
   *  column the join page renders as an organiser notice. Organiser-
   *  authored free text: render as TEXT, never as HTML/markdown. */
  eligibility_note: z.string().nullable(),
});
export type PublicJoinPreviewResponse = z.infer<typeof PublicJoinPreviewResponse>;

/** Registrant-facing status view (token-gated; no dob, no payment ids). */
export const PublicRegistrationStatus = z.object({
  id: Uuid,
  status: RegistrationStatus,
  /** Quotable reference (v3/05 §3); null on pre-v2 rows. */
  ref_code: z.string().nullable(),
  display_name: z.string(),
  division_name: z.string(),
  competition_name: z.string(),
  competition_slug: z.string(),
  org_slug: z.string(),
  org_name: z.string(),
  starts_on: z.string().nullable(),
  ends_on: z.string().nullable(),
  fee_cents: z.number().int(),
  amount_cents: z.number().int(),
  currency: z.string().nullable(),
  refunded_cents: z.number().int(),
  /** True when a payment is due and the registrant can (re)open checkout. */
  payment_due: z.boolean(),
  created_at: z.string(),
});

export const PublicRegistrationToken = z.object({ token: z.string().min(10).max(200) });
export type PublicRegistrationToken = z.infer<typeof PublicRegistrationToken>;

// Stripe Connect (org onboarding) --------------------------------------------

export const ConnectStatus = z.object({
  connected: z.boolean(),
  charges_enabled: z.boolean(),
  details_submitted: z.boolean().nullable(),
  payouts_enabled: z.boolean(),
  disabled_reason: z.string().nullable(),
  requirements_due: z.number(),
  /** Card-unsupported state (RS001b): the connected account's settlement
   *  currency when it is outside `REGISTRATION_CURRENCIES`, else null. The
   *  same-currency rule means we cannot charge in it and will not charge
   *  across it, so card registration is unavailable until the account settles
   *  in an allowlisted currency. Surfaced at connect time; RS004 renders it. */
  unsupported_currency: z.string().nullable(),
  /** V411 — payout health: why the club's money is not reaching its bank when
   *  `payouts_enabled` still reads true. Set by `payout.failed` and the two
   *  `account.external_account.*` events, cleared by `payout.paid`. The value
   *  SELECTS the banner's copy, so the wire carries no English; the operator
   *  detail behind it (Stripe's failure code, the account identifier) stays
   *  server-side and is deliberately not exposed here. */
  payout_alert: z.enum(["payout_failed", "bank_removed", "bank_changed"]).nullable(),
});

export const CreateConnectOnboarding = z.object({
  /** App-relative path to return to after Stripe onboarding. */
  return_path: z.string().max(300).regex(/^\//, "app-relative path").default("/settings/billing"),
  /** Acceptance of the entry-fee chargeback terms (ToS §5). Required for the
   *  first connect — the connected account is only created once accepted;
   *  resuming onboarding does not re-ask (PROMPT-55). */
  tos_agreed: z.boolean().default(false),
});
export type CreateConnectOnboarding = z.infer<typeof CreateConnectOnboarding>;

export const ConnectOnboardingLink = z.object({ url: z.string() });
