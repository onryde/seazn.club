// RS006 chassis — WHO-step field requirements + validation, ENTRIES-step
// validation, DETAILS-step (step 3) validation (pure, no DOM). Client
// pre-checks are UX; the server verdict (registration-submit.ts,
// PublicRegisterGroupRequest's superRefine) is truth — this file exists so
// "Next" doesn't let a cart through that the server will 400/422 on submit,
// not to replace that check.
import { isMinor } from "@/lib/registration-rules";
import { registeringSelfAnywhere } from "./cart";
import { effectiveSelfDob, effectiveSelfPlayers } from "./roster";
import { rosterEligibilityForDivision, selfEligibilityForDivision } from "./eligibility-presentation";
import type { CartEntry, CartState, ConsentState, ContactState, DivisionLike } from "./types";

export interface WhoFieldRequirements {
  dobRequired: boolean;
  genderRequired: boolean;
}

/**
 * Design §4 step 1: "dob/gender collected once, only if the registrant
 * plays themselves." Both fields exist ONLY as the self-row "collected
 * once" fallback (roster.ts's effectiveSelfPlayers/effectiveSelfDob) — a
 * division's OWN requires_dob/requires_gender is satisfied per-ROSTER-ROW
 * at step 3 (every roster row gets its own dob/gender input once its
 * division requires one, roster-table.tsx), never by the WHO-step
 * contact's fields UNLESS that contact is themselves one of the players.
 * So neither field is ever read for a division the contact isn't
 * self-linking, and requiring them anyway collects personal data the
 * system never uses.
 *
 * Review finding 3 (2026-08-27): the PREVIOUS version also forced
 * dobRequired/genderRequired from ANY open division's own requires_dob/
 * requires_gender, independent of `imPlaying` — so a club secretary
 * registering a team with "I'm playing" OFF was forced to supply their
 * own dob/gender before "Next", for a value the server never asks for and
 * this client never reads. Both fields now require `imPlaying` as a
 * precondition, mirroring `PublicRegisterGroupRequest`'s superRefine
 * (schemas.ts) exactly:
 *
 *  - dobRequired: UNCONDITIONALLY true once imPlaying — the schema
 *    requires `contact.dob` whenever ANY entry is `registering_self`,
 *    independent of whether the division they end up picking itself
 *    requires a dob.
 *  - genderRequired: true only when imPlaying AND some OPEN division the
 *    contact might self-link to requires_gender — the schema itself NEVER
 *    requires `contact.gender` (no self-play-implies-gender rule the way
 *    there is for dob), so this is UX-only sugar for the self-row
 *    fallback, not a hard submit-time requirement. A CLOSED division's
 *    requires_gender is excluded: nothing can be added for it yet, so
 *    forcing the field here would be friction for a division the
 *    registrant cannot act on.
 */
export function whoFieldRequirements(
  divisions: readonly Pick<DivisionLike, "open" | "requires_dob" | "requires_gender">[],
  imPlaying: boolean,
): WhoFieldRequirements {
  if (!imPlaying) return { dobRequired: false, genderRequired: false };
  const open = divisions.filter((d) => d.open);
  return {
    dobRequired: true,
    genderRequired: open.some((d) => d.requires_gender),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  // Reject a rolled-over date (e.g. "2024-02-30" → March 1) rather than
  // silently accepting it under a different meaning.
  return d.toISOString().slice(0, 10) === value;
}

export interface ContactValidation {
  valid: boolean;
  errors: {
    name?: "nameRequired" | "nameTooLong";
    email?: "emailRequired" | "emailInvalid";
    dob?: "dobRequired" | "dobInvalid";
    gender?: "genderRequired";
  };
}

/** Mirrors `PublicRegisterGroupContact` (schemas.ts:2359) field-shape rules
 *  (name 1-120 chars, valid email) plus this session's requirement gating. */
export function validateContact(
  contact: ContactState,
  requirements: WhoFieldRequirements,
): ContactValidation {
  const errors: ContactValidation["errors"] = {};

  if (!contact.name.trim()) {
    errors.name = "nameRequired";
  } else if (contact.name.length > 120) {
    errors.name = "nameTooLong";
  }

  if (!contact.email.trim()) {
    errors.email = "emailRequired";
  } else if (!EMAIL_RE.test(contact.email)) {
    errors.email = "emailInvalid";
  }

  if (requirements.dobRequired) {
    if (!contact.dob) {
      errors.dob = "dobRequired";
    } else if (!isValidIsoDate(contact.dob)) {
      errors.dob = "dobInvalid";
    }
  }

  if (requirements.genderRequired && !contact.gender) {
    errors.gender = "genderRequired";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

export interface EntriesValidation {
  valid: boolean;
  error: "cartEmpty" | "selfIneligible" | null;
}

/** `PublicRegisterGroupRequest.entries` is `.min(1).max(10)`
 *  (schemas.ts:2421) — the max is already enforced at the point of adding
 *  (cart.ts's canAddEntry gates the "Add" control, so a cart can never grow
 *  past it), so the first thing gated here is non-empty. Per-entry naming
 *  (team_name/partner_name) is encouraged in the UI but not required — the
 *  schema itself leaves both nullish.
 *
 *  Second gate (fix wave finding #3): a self-linked entry whose division the
 *  CONTACT personally does not qualify for (category/age-band) is a cart the
 *  server will certainly reject at submit — the same
 *  `selfEligibilityForDivision` predicate DivisionCard already greys the
 *  division with (@/lib/registration-rules, the one evaluator; see that
 *  file's header) is reused here, not re-derived, to decide whether "Next"
 *  may proceed. Checked for EVERY self-linked entry (RS006: a registrant may
 *  link more than one) — an ineligible division sitting UNLINKED in the cart
 *  is fine (design: "stays pickable for team entries"). A self-linked entry
 *  whose division isn't in `divisions` (a data gap) is treated as unblocked
 *  rather than thrown on — the eligibility presentation layer's own contract
 *  elsewhere already degrades the same way. */
export function validateEntries(
  cart: CartState,
  divisions: readonly Pick<DivisionLike, "division_id" | "category" | "age_min" | "age_max">[],
  contact: Pick<ContactState, "dob" | "gender">,
  seasonStartYear: number,
): EntriesValidation {
  if (cart.entries.length === 0) return { valid: false, error: "cartEmpty" };

  for (const entry of cart.entries) {
    if (!entry.registering_self) continue;
    const division = divisions.find((d) => d.division_id === entry.division_id);
    if (!division) continue;
    const verdict = selfEligibilityForDivision(division, contact, seasonStartYear);
    if (!verdict.eligible) return { valid: false, error: "selfIneligible" };
  }

  return { valid: true, error: null };
}

// ---------------------------------------------------------------------------
// DETAILS (step 3)
// ---------------------------------------------------------------------------

/** Individual: exactly 1 (the schema's own min AND max —
 *  `registration-submit.ts` rejects anything else). Pair: exactly 2 (the
 *  second is the partner field). Team: unconstrained — the schema places NO
 *  minimum on a team roster, matching `cart.ts`'s `blankPlayers` seeding. */
function requiredPlayerCount(kind: CartEntry["entrant_kind"]): number | null {
  if (kind === "individual") return 1;
  if (kind === "pair") return 2;
  return null;
}

/**
 * Structural completeness for ONE entry — independent of eligibility
 * (`rosterEligibilityForDivision`, checked separately by `validateDetails`
 * below, since it also needs the CART's self-link state to apply the
 * contact fallback). A free-agent entry is always complete (design §4 step
 * 3: "Free-agent entries need nothing extra").
 *
 * A blank-named row is NEVER silently tolerated here, but the reason
 * differs by kind: individual/pair are fixed-size (1/2), so `players.length
 * !== required` alone already catches "not enough rows"; team has no count
 * requirement (an empty roster is fine — "leave it blank, the organiser can
 * add players later", the recovered form's own policy), but an EXISTING row
 * left blank is different from never adding one — the captain typed a row
 * and it must be filled in or removed, not silently dropped (that dropping,
 * if it ever happens, is `roster.ts`'s `toGroupPlayers`' job at submit time,
 * not this validator's).
 */
export function entryDetailsComplete(
  entry: CartEntry,
  division: Pick<DivisionLike, "form_fields">,
): boolean {
  if (entry.free_agent) return true;

  const required = requiredPlayerCount(entry.entrant_kind);
  if (required !== null && entry.players.length !== required) return false;
  if (entry.players.some((p) => !p.full_name.trim())) return false;

  for (const field of division.form_fields) {
    if (!field.required) continue;
    const answer = entry.answers[field.key];
    const answered = field.kind === "checkbox" ? answer === true : typeof answer === "string" && answer.trim().length > 0;
    if (!answered) return false;
  }

  return true;
}

export interface DetailsValidation {
  valid: boolean;
  /** Per-entry detail lives in the entry's OWN card (roster rows, the
   *  mixed meter, required-field markers all render their own inline
   *  state) — this is just the gate. */
  error: "incomplete" | null;
}

/**
 * Step 3's "Next" gate: every non-free-agent entry must be structurally
 * complete (`entryDetailsComplete`) AND its roster must clear
 * `rosterEligibilityForDivision` — a roster that fails there is CERTAIN to
 * 422 at submit (registration-submit.ts's own `rosterIssues` call), so
 * blocking here is always safe, never a false negative. A self-linked
 * entry's roster is evaluated through `effectiveSelfPlayers` first (the
 * contact's WHO-step dob/gender covers a blank self row — design: "collected
 * once" — so this does NOT false-positive block on it).
 *
 * Also mirrors `PublicRegisterGroupRequest`'s superRefine
 * (schemas.ts): a self-linked TEAM/PAIR entry needs an EXPLICIT
 * `self_player_index` resolved (`entry.self_player_index`) or the self-link
 * silently drops server-side with no submit-time error at all
 * (registration-submit.ts's own comment on why 0 is not a safe default
 * there) — blocking here is the only place that can tell the registrant
 * before they submit. INDIVIDUAL entries are exempt (the schema implies
 * index 0). FREE-AGENT entries are exempt too, but for a different reason:
 * this session's roster builder renders NOTHING for a free-agent entry
 * (design: "nothing extra"), so there is no control that could ever set
 * `self_player_index` for one — blocking would be a dead end the registrant
 * cannot resolve. A self-linked free agent's link therefore CAN still
 * silently drop at submit exactly as schemas.ts's comment describes; that
 * gap is left for whichever session wires the actual submit call (step 5)
 * to close, not papered over here with a check nobody could satisfy.
 *
 * Checked for EVERY entry independently (RS006: a registrant may self-link
 * more than one) — each entry carries its own `registering_self`/
 * `self_player_index` now, so this is a single per-entry loop rather than a
 * per-entry loop PLUS a separate cart-wide follow-up check.
 *
 * A stale/unknown division_id degrades to "skip, don't block" — same
 * precedent as `validateEntries` above.
 */
export function validateDetails(
  cart: CartState,
  divisions: readonly DivisionLike[],
  contact: Pick<ContactState, "dob" | "gender">,
  seasonStartYear: number,
): DetailsValidation {
  const byId = new Map(divisions.map((d) => [d.division_id, d]));

  for (const entry of cart.entries) {
    if (entry.free_agent) continue;
    const division = byId.get(entry.division_id);
    if (!division) continue;

    if (!entryDetailsComplete(entry, division)) return { valid: false, error: "incomplete" };

    const effective = entry.registering_self ? effectiveSelfPlayers(entry, contact) : entry.players;
    const verdict = rosterEligibilityForDivision(division, effective, seasonStartYear);
    if (!verdict.eligible) return { valid: false, error: "incomplete" };

    if (entry.registering_self && entry.entrant_kind !== "individual" && entry.self_player_index === null) {
      return { valid: false, error: "incomplete" };
    }
  }

  return { valid: true, error: null };
}

// ---------------------------------------------------------------------------
// CONSENT (step 4)
// ---------------------------------------------------------------------------

/**
 * Mirrors `registration-submit.ts`'s own guardian gate (~line 430-444): true
 * when ANY self-linked entry's EFFECTIVE self dob (`effectiveSelfDob`,
 * roster.ts — the roster row's own dob, falling back to `contact.dob`) is
 * under 18. Guardian-consent-bypass fix (HIGH, 2026-08-26): this used to key
 * on `contact.dob` alone, which a self-linked roster row's own (editable)
 * dob input can silently override in the opposite direction once a division
 * requires_dob (roster-table.tsx renders a plain editable date input for
 * EVERY row, including the self row — no `readOnly`/`disabled`).
 *
 * Keyed off the CART's actual self-link (`registeringSelfAnywhere`, cart.ts
 * — checked first, as a fast exit for the common "nobody self-linking"
 * case), not the WHO step's `imPlaying` toggle — `imPlaying` can be true
 * with ZERO entries actually linked (2+ entries is ambiguous, the rep must
 * explicitly choose), and the server's own gate never fires in that case
 * either, so keying off `imPlaying` here would over-trigger the block
 * relative to what submit actually requires.
 */
export function guardianRequired(cart: CartState, contact: Pick<ContactState, "dob">, now: Date): boolean {
  if (!registeringSelfAnywhere(cart)) return false;
  return cart.entries.some((entry) => {
    const dob = effectiveSelfDob(entry, contact);
    return dob !== null && isMinor(dob, now);
  });
}

export interface ConsentValidation {
  valid: boolean;
  /** Per-field, matching validateContact's convention (WHO step) rather
   *  than validateEntries/validateDetails' single banner code — privacy and
   *  the guardian pair are each a distinct form control that can carry its
   *  own inline error. */
  errors: {
    privacy?: "required";
    guardianName?: "required";
    guardianConsent?: "required";
  };
}

/**
 * Step 4's "Next" gate. Privacy consent is UNCONDITIONALLY required (design
 * §4: "required, versioned"; mirrors registration-submit.ts's own
 * `if (!input.privacy_consent) throw ...`, entry condition 2). Media consent
 * is NEVER checked here — RS006 §A: "media consent is OPTIONAL and must
 * never block submit". The guardian pair is required only when
 * `guardianRequired` above says so, and — per registration-submit.ts:429-430
 * — BOTH fields independently (a name with no consent, or consent with no
 * name, are each their own missing requirement).
 */
export function validateConsent(
  cart: CartState,
  contact: ContactState,
  consent: ConsentState,
  now: Date,
): ConsentValidation {
  const errors: ConsentValidation["errors"] = {};

  if (!consent.privacy_consent) errors.privacy = "required";

  if (guardianRequired(cart, contact, now)) {
    if (!contact.guardian_name?.trim()) errors.guardianName = "required";
    if (!contact.guardian_consent) errors.guardianConsent = "required";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}
