// Registration eligibility — CLIENT-SAFE pure predicates (RS006 W1).
//
// `server/usecases/registration-eligibility.ts` is `import "server-only"` —
// a client component importing anything under `@/server/**` is a `next
// build` failure `tsc` never catches (repo standing trap). But the public
// stepper's ENTRIES step (design §4 step 2) needs to grey a
// self-ineligible division with the SAME rule the server enforces at
// submit, and re-implementing that rule client-side is the exact
// "two eligibility evaluators" failure RS011's own re-homing exists to
// prevent (see that file's header).
//
// Resolution: the PURE, DB-free predicates live here, with no
// `server-only` and no db/server imports, so both sides can import the
// literal same function — `registration-eligibility.ts` imports and
// re-exports from here (it stays the one evaluator, just split across a
// server-only half and a client-safe half); the stepper
// (components/public-site/register/**) imports straight from here.
//
// What stays OUT of this file, on purpose: `divisionEligibilityIssues`'s
// jsonb-rules loop and `rosterIssues`'s roster-composition check. Both
// read `divisions.eligibility` (jsonb), which the public read model never
// ships to the client (`PublicRegistrationDivision` carries only the
// booleans `requires_dob`/`requires_gender` derived FROM it) — so the
// client structurally cannot evaluate those rules, correctly. Only the
// first-class `category`/`age_min`/`age_max` columns (V364) are public
// (badges need the raw values), so only their predicates belong here.

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

/** The person-shaped input every eligibility check reads. */
export interface EligibilityPerson {
  dob?: string | null;
  gender?: string | null;
}

export type EligibilityCode =
  | "AGE_TOO_OLD"
  | "AGE_TOO_YOUNG"
  | "GENDER_NOT_ALLOWED"
  | "CATEGORY_MISMATCH"
  | "MISSING_DOB"
  | "MISSING_GENDER"
  | "MIXED_NEEDS_BOTH_GENDERS";

/**
 * A single structured eligibility issue.
 *
 * Deliberately NO `severity` field — do not add one. RS011's organiser-side
 * gates treat `MISSING_DOB`/`MISSING_GENDER` as WARNINGS (a person record
 * with gaps is still useful to an organiser); the registration submit path
 * (RS002/RS003) must keep treating the exact same codes as BLOCKING, exactly
 * as the pre-rework evaluator always did. Baking one policy into the issue
 * shape would force the other caller to fight it. Each caller classifies by
 * `code` — that is the whole point of shipping a code instead of a sentence.
 */
export interface EligibilityIssue {
  code: EligibilityCode;
  /** English, the display fallback — the same sentences the pre-rework
   *  string[] functions returned. No i18n owed (server-side errors stay
   *  English repo-wide); a locale-aware surface renders off `code` instead.
   *  The stepper's OWN presentation layer does the same — see
   *  components/public-site/register/eligibility-presentation.ts. */
  message: string;
  /** 1-based; present only in roster context (set by `rosterIssues`). */
  playerIndex?: number;
  playerName?: string | null;
  /** Structured detail a consumer would otherwise have to re-parse out of
   *  `message` — the age limit for AGE_TOO_OLD/AGE_TOO_YOUNG, the allowed
   *  genders for GENDER_NOT_ALLOWED, the category for CATEGORY_MISMATCH. */
  meta?: Record<string, string | number | string[]>;
}

/**
 * Division has an age rule ⇒ the form must collect DOB.
 *
 * Overloaded: the legacy jsonb-only shape (a bare rules array), and a
 * division-shaped object so a division using ONLY `age_min`/`age_max` (no
 * jsonb age rule at all) still collects a DOB. Before V364 this inspected
 * only the jsonb rules, so a first-class-only age band silently collected no
 * DOB and then failed every player at eligibility time. Untouched by the
 * structured-issue rework — this returns a boolean, not an issue.
 */
export function requiresDob(rules: unknown[]): boolean;
export function requiresDob(division: {
  eligibility: unknown[];
  age_min: number | null;
  age_max: number | null;
}): boolean;
export function requiresDob(
  input: unknown[] | { eligibility: unknown[]; age_min: number | null; age_max: number | null },
): boolean {
  if (Array.isArray(input)) {
    return input.some((r) => (r as { kind?: string })?.kind === "age");
  }
  return input.age_min != null || input.age_max != null || requiresDob(input.eligibility);
}

/**
 * First-class CATEGORY check only (individual level — `mixed` is
 * roster-wide, evaluated by `rosterIssues` server-side, never here): `mens`
 * requires gender `m`, `womens` requires `f`. `open`, a null category, and
 * `mixed` constrain NOTHING here. `x` never blocks: a person whose gender is
 * `x` is eligible for every category (owner ruling, RS002). A null gender is
 * only an issue where the division actually needs one.
 *
 * Extracted from `divisionEligibilityIssues`'s first-class block
 * (server/usecases/registration-eligibility.ts) so the stepper's ENTRIES
 * step can grey a self-ineligible division with the literal same rule.
 * Deliberately does NOT know about the jsonb-vs-category gender precedence
 * rule (a jsonb GenderRule suppresses this block server-side) — the public
 * read model never ships jsonb rules to the client, so from the client's
 * vantage point this predicate IS the whole gender-eligibility story for a
 * division whose `requires_gender` is category-driven.
 */
export function categoryEligibilityIssues(
  division: { category: string | null },
  person: EligibilityPerson,
): EligibilityIssue[] {
  const issues: EligibilityIssue[] = [];
  if (division.category === "mens" || division.category === "womens") {
    const needed = division.category === "mens" ? "m" : "f";
    if (!person.gender) {
      issues.push({ code: "MISSING_GENDER", message: "Gender is required for this division." });
    } else if (person.gender !== "x" && person.gender !== needed) {
      issues.push({
        code: "CATEGORY_MISMATCH",
        message: "This division is not open to your gender category.",
        meta: { category: division.category },
      });
    }
  }
  return issues;
}

/**
 * First-class AGE BAND check only (`age_min`/`age_max`, V364). Evaluated at
 * 1 January of `seasonStartYear` — never "today" — matching the jsonb
 * rules' `cutoff.yearOf: "season_start"` branch exactly, deliberately: a
 * season-long division must not change who is eligible partway through the
 * season.
 *
 * Extracted from `divisionEligibilityIssues`'s first-class block for the
 * same reason as `categoryEligibilityIssues` above.
 */
export function ageBandEligibilityIssues(
  division: { age_min: number | null; age_max: number | null },
  person: EligibilityPerson,
  seasonStartYear: number,
): EligibilityIssue[] {
  const issues: EligibilityIssue[] = [];
  if (division.age_min == null && division.age_max == null) return issues;
  if (!person.dob) {
    issues.push({
      code: "MISSING_DOB",
      message: "Date of birth is required for this age-restricted division.",
    });
    return issues;
  }
  const cutoffDate = new Date(Date.UTC(seasonStartYear, 0, 1));
  const age = ageAt(person.dob, cutoffDate);
  if (division.age_max != null && age > division.age_max) {
    issues.push({
      code: "AGE_TOO_OLD",
      message: `Too old for this division (must be ${division.age_max} or younger on the cutoff date).`,
      meta: { limit: division.age_max },
    });
  }
  if (division.age_min != null && age < division.age_min) {
    issues.push({
      code: "AGE_TOO_YOUNG",
      message: `Too young for this division (must be ${division.age_min} or older on the cutoff date).`,
      meta: { limit: division.age_min },
    });
  }
  return issues;
}
