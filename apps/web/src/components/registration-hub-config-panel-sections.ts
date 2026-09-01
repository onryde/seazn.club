// Registration hub config panel — section/field grouping (RS004 W3c/W4).
// The accordion panel (registration-hub-config-panel.tsx) groups the SAME
// EligibilitySection/OpenCloseSection/CapacitySection/MoneySection (plus an
// inline sign-up-form block) into named zones, and needs to know which zone
// a given field lives in so a 422 on a field inside a collapsed accordion
// section can reveal itself — otherwise the error renders into the DOM
// (mapSaveError still returns it) but is invisible to the organiser, which
// would read as data loss even though nothing was actually lost.
//
// Pure and dependency-light (one type-only import), so it's unit-testable
// with no harness.
import type { ConfigFieldKey } from "@/components/registration-hub-save-error";

export const SECTION_IDS = ["eligibility", "schedule", "capacity", "money", "form"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

/** Mirrors the section boundaries variant A's own JSX already draws
 *  (EligibilitySection/OpenCloseSection/CapacitySection/MoneySection, plus
 *  the inline form-fields <section> at the bottom) — not a new taxonomy,
 *  just naming the grouping that already exists. */
export const SECTION_FIELDS: Record<SectionId, readonly ConfigFieldKey[]> = {
  eligibility: [
    "category",
    "age_min",
    "age_max",
    "age_cutoff_month",
    "age_cutoff_day",
    "eligibility_note",
    "approval",
    "allow_free_agents",
    // RS012/V389 — placeByApplies gates on allow_free_agents, same as the
    // toggle above, so this belongs in the same section as that toggle
    // rather than "money" (refund_lock_at's own section, gated on
    // payment_method instead).
    "place_by_at",
  ],
  schedule: ["enabled", "entrant_kind", "opens_at", "closes_at"],
  capacity: ["capacity"],
  money: ["fee_cents", "payment_method", "payment_instructions", "refund_lock_at"],
  form: ["form_fields"],
};

/** Which section a field belongs to. Every ConfigFieldKey is covered by
 *  SECTION_FIELDS above (proven by this file's own test), so null is
 *  defensive only — it should never actually happen. */
export function sectionForField(field: ConfigFieldKey): SectionId | null {
  for (const id of SECTION_IDS) {
    if (SECTION_FIELDS[id].includes(field)) return id;
  }
  return null;
}

/** The section holding the FIRST error, in SECTION_IDS (declaration) order
 *  — deterministic regardless of the errors object's own key insertion
 *  order. Used to auto-reveal the right accordion section / switch to the
 *  right tab after a failed save, so a collapsed section or an inactive
 *  tab never hides a validation error the organiser has to act on. */
export function firstErrorSection(errors: Partial<Record<ConfigFieldKey, string>>): SectionId | null {
  for (const id of SECTION_IDS) {
    if (SECTION_FIELDS[id].some((f) => errors[f])) return id;
  }
  return null;
}
