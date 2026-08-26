// RS006 chassis — WHO-step field requirements + validation, ENTRIES-step
// validation (pure, no DOM). Client pre-checks are UX; the server verdict
// (registration-submit.ts, PublicRegisterGroupRequest's superRefine) is
// truth — this file exists so "Next" doesn't let a cart through that the
// server will 400/422 on submit, not to replace that check.
import type { CartState, ContactState, DivisionLike } from "./types";

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
  errors: Partial<Record<"name" | "email" | "dob" | "gender", string>>;
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
  error: "cartEmpty" | null;
}

/** `PublicRegisterGroupRequest.entries` is `.min(1).max(10)`
 *  (schemas.ts:2421) — the max is already enforced at the point of adding
 *  (cart.ts's canAddEntry gates the "Add" control, so a cart can never grow
 *  past it), so the only thing left to gate "Next" on here is non-empty.
 *  Per-entry naming (team_name/partner_name) is encouraged in the UI but
 *  not required — the schema itself leaves both nullish. */
export function validateEntries(cart: CartState): EntriesValidation {
  if (cart.entries.length === 0) return { valid: false, error: "cartEmpty" };
  return { valid: true, error: null };
}
