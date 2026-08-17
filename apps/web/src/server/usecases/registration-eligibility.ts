import "server-only";
// Registration eligibility (doc 06 §2; V364 "eligibility becomes first-class").
//
// Split out of `registrations.ts` (RS002 wave 2 — that file was 2431 lines,
// past the ~600-line split trigger the RS002 prompt sets). This module is
// deliberately a LEAF: it imports nothing from `registrations.ts` or any
// other usecase, so `registrations.ts` — and the submit/approval modules
// RS002 adds next — can import THIS module without a cycle.
//
// Two eligibility sources exist side by side, and are read TOGETHER, never
// one replacing the other:
//  - `divisions.eligibility` (jsonb): free-form age/gender rules authored in
//    the division builder. `AgeRule`/`GenderRule` below are the only kinds
//    this file understands; roster/grade/custom rules stay organiser-side
//    (doc 06 §2).
//  - `divisions.category`/`age_min`/`age_max` (V364, first-class columns):
//    added so the public page can show a category/age badge and close a
//    division at READ time, not only at validation time. The jsonb rules
//    stay live for custom extra restrictions a plain category/age band
//    can't express.

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

/**
 * A division carrying only the fields eligibility checks need — narrow on
 * purpose so a caller can pass a full division row (or a hand-built object
 * in a test) without a cast.
 */
export interface EligibilityDivision {
  eligibility: unknown[];
  category: string | null;
  age_min: number | null;
  age_max: number | null;
}

/** The person-shaped input every eligibility check reads. */
export interface EligibilityPerson {
  dob?: string | null;
  gender?: string | null;
}

/** One roster row: a person plus the display name issues are addressed to. */
export interface EligibilityRosterPlayer extends EligibilityPerson {
  full_name: string;
}

/**
 * Division has an age rule ⇒ the form must collect DOB.
 *
 * Overloaded: the legacy jsonb-only shape (a bare rules array), and a
 * division-shaped object so a division using ONLY `age_min`/`age_max` (no
 * jsonb age rule at all) still collects a DOB. Before V364 this inspected
 * only the jsonb rules, so a first-class-only age band silently collected no
 * DOB and then failed every player at eligibility time.
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
 * Validate a registrant against the division's JSONB eligibility rules ONLY
 * (doc 06 §2). Only 'age' and 'gender' are checkable at registration;
 * roster/grade/custom rules are organiser-side. Returns human issues; empty
 * = eligible. `seasonStartYear` anchors cutoff.yearOf='season_start' (doc 06
 * §2.1).
 *
 * Kept at this exact signature (unchanged since before V364) for callers
 * that only have the jsonb rules in hand, no division row.
 * `divisionEligibilityIssues` below is the superset that also reads the
 * first-class columns.
 */
export function eligibilityIssues(
  rules: unknown[],
  input: EligibilityPerson,
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

/**
 * Full eligibility check for one player against one division: the jsonb
 * rules above PLUS the first-class `category`/`age_min`/`age_max` columns
 * (V364). The two sources are independent and additive — a division
 * configured with both yields issues from both.
 *
 * Category (individual level only — `mixed` is roster-wide, see
 * `rosterIssues`): `mens` requires gender `m`, `womens` requires `f`. `open`,
 * a null category, and `mixed` constrain NOTHING here. `x` never blocks: a
 * person whose gender is `x` is eligible for every category (owner ruling,
 * RS002). A null gender is only an issue where the division actually needs
 * one — `mens`/`womens` here, or a jsonb gender rule above.
 *
 * Age band: evaluated at 1 January of `seasonStartYear` — never "today" —
 * matching the jsonb rules' `cutoff.yearOf: "season_start"` branch exactly,
 * deliberately: a season-long division must not change who is eligible
 * partway through the season.
 */
export function divisionEligibilityIssues(
  division: EligibilityDivision,
  person: EligibilityPerson,
  seasonStartYear: number,
): string[] {
  const issues = eligibilityIssues(division.eligibility, person, seasonStartYear);

  if (division.category === "mens" || division.category === "womens") {
    const needed = division.category === "mens" ? "m" : "f";
    if (!person.gender) {
      issues.push("Gender is required for this division.");
    } else if (person.gender !== "x" && person.gender !== needed) {
      issues.push("This division is not open to your gender category.");
    }
  }

  if (division.age_min != null || division.age_max != null) {
    if (!person.dob) {
      issues.push("Date of birth is required for this age-restricted division.");
    } else {
      const cutoffDate = new Date(Date.UTC(seasonStartYear, 0, 1));
      const age = ageAt(person.dob, cutoffDate);
      if (division.age_max != null && age > division.age_max) {
        issues.push(
          `Too old for this division (must be ${division.age_max} or younger on the cutoff date).`,
        );
      }
      if (division.age_min != null && age < division.age_min) {
        issues.push(
          `Too young for this division (must be ${division.age_min} or older on the cutoff date).`,
        );
      }
    }
  }

  return issues;
}

/**
 * Roster-level eligibility (V364 first-class columns + jsonb rules,
 * together): every player's own issues from `divisionEligibilityIssues`,
 * each prefixed with their 1-based row position and name so the offending
 * row is identifiable on a multi-player entry — format is
 * `Player <n> (<name>): <issue>`. Stable; a caller may match on it.
 *
 * PLUS the mixed-composition issue when the division's category is `mixed`:
 * satisfied when the roster has at least one `m` AND at least one `f` among
 * its gendered rows. `x`/null rows count toward NEITHER side and are never
 * themselves a failure — an all-`x` roster fails for want of both sides, not
 * because of the `x` rows. This issue is roster-wide, so it carries no
 * player prefix.
 */
export function rosterIssues(
  division: EligibilityDivision,
  players: EligibilityRosterPlayer[],
  seasonStartYear: number,
): string[] {
  const issues: string[] = [];
  let hasM = false;
  let hasF = false;
  players.forEach((player, i) => {
    for (const issue of divisionEligibilityIssues(division, player, seasonStartYear)) {
      issues.push(`Player ${i + 1} (${player.full_name}): ${issue}`);
    }
    if (player.gender === "m") hasM = true;
    if (player.gender === "f") hasF = true;
  });
  if (division.category === "mixed" && !(hasM && hasF)) {
    issues.push("This division requires a mixed roster (at least one male and one female player).");
  }
  return issues;
}
