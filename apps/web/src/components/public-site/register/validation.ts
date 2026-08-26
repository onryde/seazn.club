// RS006 chassis — WHO-step field requirements + validation, ENTRIES-step
// validation, DETAILS-step (step 3) validation (pure, no DOM). Client
// pre-checks are UX; the server verdict (registration-submit.ts,
// PublicRegisterGroupRequest's superRefine) is truth — this file exists so
// "Next" doesn't let a cart through that the server will 400/422 on submit,
// not to replace that check.
import { effectiveSelfPlayers } from "./roster";
import { rosterEligibilityForDivision, selfEligibilityForDivision } from "./eligibility-presentation";
import type { CartEntry, CartState, ContactState, DivisionLike } from "./types";

export interface WhoFieldRequirements {
  dobRequired: boolean;
  genderRequired: boolean;
}

/**
 * Design §4 step 1: "dob/gender collected once, only if any division needs
 * them or the registrant plays."
 *
 * dobRequired has TWO independent sources, matched to
 * `PublicRegisterGroupRequest`'s superRefine (schemas.ts:2425-2435):
 *  - `imPlaying`: the contact intends to self-link ONE entry (cart.ts's
 *    single-select selfEntryId), and the schema requires `contact.dob`
 *    whenever ANY entry is `registering_self` — independent of whether the
 *    division they end up picking itself requires a dob.
 *  - any OPEN division's own `requires_dob` (V364 first-class columns +
 *    jsonb rules, computed server-side — registration-eligibility.ts).
 * A CLOSED division's requires_dob is excluded: nothing can be added for it
 * yet, so forcing the field here would be friction for a division the
 * registrant cannot act on.
 *
 * genderRequired has only the division source — the schema has no
 * self-play-implies-gender rule the way it does for dob.
 */
export function whoFieldRequirements(
  divisions: readonly Pick<DivisionLike, "open" | "requires_dob" | "requires_gender">[],
  imPlaying: boolean,
): WhoFieldRequirements {
  const open = divisions.filter((d) => d.open);
  return {
    dobRequired: imPlaying || open.some((d) => d.requires_dob),
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
 *  may proceed. Only the SELF-LINKED entry is checked — an ineligible
 *  division sitting unlinked in the cart is fine (design: "stays pickable
 *  for team entries"). A self-linked entry whose division isn't in `divisions`
 *  (a data gap) is treated as unblocked rather than thrown on — the eligibility
 *  presentation layer's own contract elsewhere already degrades the same way. */
export function validateEntries(
  cart: CartState,
  divisions: readonly Pick<DivisionLike, "division_id" | "category" | "age_min" | "age_max">[],
  contact: Pick<ContactState, "dob" | "gender">,
  seasonStartYear: number,
): EntriesValidation {
  if (cart.entries.length === 0) return { valid: false, error: "cartEmpty" };

  if (cart.selfEntryId) {
    const selfEntry = cart.entries.find((e) => e.id === cart.selfEntryId);
    const division = selfEntry && divisions.find((d) => d.division_id === selfEntry.division_id);
    if (division) {
      const verdict = selfEligibilityForDivision(division, contact, seasonStartYear);
      if (!verdict.eligible) return { valid: false, error: "selfIneligible" };
    }
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
 * blocking here is always safe, never a false negative. The self-linked
 * entry's roster is evaluated through `effectiveSelfPlayers` first (the
 * contact's WHO-step dob/gender covers a blank self row — design: "collected
 * once" — so this does NOT false-positive block on it).
 *
 * Also mirrors `PublicRegisterGroupRequest`'s superRefine
 * (schemas.ts:2453-2474): a self-linked TEAM/PAIR entry needs an EXPLICIT
 * `self_player_index` resolved (`cart.selfPlayerIndex`) or the self-link
 * silently drops server-side with no submit-time error at all
 * (registration-submit.ts's own comment on why 0 is not a safe default
 * there) — blocking here is the only place that can tell the registrant
 * before they submit. INDIVIDUAL entries are exempt (the schema implies
 * index 0). FREE-AGENT entries are exempt too, but for a different reason:
 * this session's roster builder renders NOTHING for a free-agent entry
 * (design: "nothing extra"), so there is no control that could ever set
 * `selfPlayerIndex` for one — blocking would be a dead end the registrant
 * cannot resolve. A self-linked free agent's link therefore CAN still
 * silently drop at submit exactly as schemas.ts's comment describes; that
 * gap is left for whichever session wires the actual submit call (step 5)
 * to close, not papered over here with a check nobody could satisfy.
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

    const isSelf = cart.selfEntryId === entry.id;
    const effective = isSelf ? effectiveSelfPlayers(entry.players, cart.selfPlayerIndex, contact) : entry.players;
    const verdict = rosterEligibilityForDivision(division, effective, seasonStartYear);
    if (!verdict.eligible) return { valid: false, error: "incomplete" };
  }

  if (cart.selfEntryId) {
    const selfEntry = cart.entries.find((e) => e.id === cart.selfEntryId);
    if (
      selfEntry &&
      selfEntry.entrant_kind !== "individual" &&
      !selfEntry.free_agent &&
      cart.selfPlayerIndex === null
    ) {
      return { valid: false, error: "incomplete" };
    }
  }

  return { valid: true, error: null };
}
