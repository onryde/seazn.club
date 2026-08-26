// RS006 ENTRIES step — self-ineligibility presentation mapping (pure, no
// DOM, no server import). Design §4 step 2: "Divisions the registrant
// cannot enter *as a player* are greyed with the reason but stay pickable
// for team entries."
//
// Calls the SAME predicates the server evaluates with
// (@/lib/registration-rules — the RS006 W1 leaf extracted from
// server/usecases/registration-eligibility.ts's first-class-column block)
// rather than re-deriving the rule client-side, which is the exact "two
// eligibility evaluators" drift that module's header warns against. Only
// the first-class category/age-band predicates are usable here at all: the
// jsonb `eligibility` rules never ship to the client (the public read model
// exposes only the derived `requires_dob`/`requires_gender` booleans), so
// this can never be a full substitute for the server's verdict — it is
// UX only, exactly as the RS006 prompt requires ("Client pre-checks are
// UX; the server verdict is truth").
import {
  ageBandEligibilityIssues,
  categoryEligibilityIssues,
  type EligibilityCode,
  type EligibilityIssue,
  type EligibilityPerson,
} from "@/lib/registration-rules";

export interface SelfEligibility {
  eligible: boolean;
  issues: EligibilityIssue[];
}

/** The ONE presentation mapping from a structured issue code to its i18n
 *  key — shared by DivisionCard's grey-with-reason notice AND EntryCart's
 *  per-line self-link verdict (fix wave finding #3), so a cart line never
 *  re-derives or re-words the rule DivisionCard already evaluated. No entry
 *  for GENDER_NOT_ALLOWED/MIXED_NEEDS_BOTH_GENDERS: neither code is ever
 *  produced by categoryEligibilityIssues/ageBandEligibilityIssues, the only
 *  two functions `selfEligibilityForDivision` above composes, so a key here
 *  would be untestable dead code. */
export const INELIGIBLE_MESSAGE_KEY: Partial<Record<EligibilityCode, string>> = {
  CATEGORY_MISMATCH: "register.entries.ineligible.category",
  AGE_TOO_OLD: "register.entries.ineligible.age",
  AGE_TOO_YOUNG: "register.entries.ineligible.age",
  MISSING_DOB: "register.entries.ineligible.missingDob",
  MISSING_GENDER: "register.entries.ineligible.missingGender",
};

/**
 * Whether the CONTACT (if they end up self-linking this entry) individually
 * qualifies for `division`. Deliberately does not evaluate
 * `MIXED_NEEDS_BOTH_GENDERS` — that is a roster-wide property
 * (`rosterIssues`, server-side, step 3's roster isn't built yet), not
 * something one person's own dob/gender can answer.
 */
export function selfEligibilityForDivision(
  division: { category: string | null; age_min: number | null; age_max: number | null },
  person: EligibilityPerson,
  seasonStartYear: number,
): SelfEligibility {
  const issues = [
    ...categoryEligibilityIssues(division, person),
    ...ageBandEligibilityIssues(division, person, seasonStartYear),
  ];
  return { eligible: issues.length === 0, issues };
}

/** `divisionEligibilityIssues`/`rosterIssues` anchor age-band checks at 1
 *  January of the season-start year, never "today" (registration-
 *  eligibility.ts's own doc comment: a season-long division must not change
 *  who is eligible partway through). Mirrors that anchor from the
 *  competition's `starts_on` (public read model), falling back to `now`'s
 *  year for a competition that hasn't set one or set an unparsable one. */
export function seasonStartYearFrom(startsOn: string | null, now: Date = new Date()): number {
  if (!startsOn) return now.getUTCFullYear();
  const d = new Date(startsOn);
  return Number.isNaN(d.getTime()) ? now.getUTCFullYear() : d.getUTCFullYear();
}
