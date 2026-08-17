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
//
// RETURN SHAPE (RS002 entry-condition item 5, `_INDEX.md`, 2026-08-17):
// structured `EligibilityIssue[]` with a machine `code`, not `string[]`.
// RS011's organiser-side gates depend on RS002 and consume this SAME
// evaluator to fill a 422's `extra.violations[]` and drive an override
// dialog listing offenders — it needs codes, not sentences to re-parse.
// "Two eligibility evaluators is the exact failure the RS011 re-homing
// exists to prevent," so this module derives display strings at the edge
// (`formatEligibilityIssues`) instead of forking a second evaluator later.
// The legacy `eligibilityIssues` keeps its original `string[]` signature as
// a thin wrapper, so no existing importer's call site changes.

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

/**
 * One roster row: a person plus the display name issues are addressed to.
 * `full_name` is OPTIONAL and plain-structural on purpose — RS011's
 * organiser-side gates call `rosterIssues` against `persons` rows, not
 * `registration_players` rows, and a `persons` row is not guaranteed a name
 * in every caller's hands.
 */
export interface EligibilityRosterPlayer extends EligibilityPerson {
  full_name?: string | null;
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
 * as `eligibilityIssues` always has. Baking one policy into the issue shape
 * would force the other caller to fight it. Each caller classifies by
 * `code` — that is the whole point of shipping a code instead of a sentence.
 */
export interface EligibilityIssue {
  code: EligibilityCode;
  /** English, the display fallback — the same sentences the pre-rework
   *  string[] functions returned. No i18n owed (server-side errors stay
   *  English repo-wide); a locale-aware surface renders off `code` instead. */
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
 * Full structured eligibility check for one player against one division:
 * the jsonb `eligibility` rules (doc 06 §2 — only 'age' and 'gender' are
 * checkable here; roster/grade/custom rules are organiser-side) PLUS the
 * first-class `category`/`age_min`/`age_max` columns (V364). The two
 * sources are independent and additive — a division configured with both
 * yields issues from both. `seasonStartYear` anchors both the jsonb rules'
 * `cutoff.yearOf: "season_start"` branch and the first-class age band below.
 *
 * Category (individual level only — `mixed` is roster-wide, see
 * `rosterIssues`): `mens` requires gender `m`, `womens` requires `f`. `open`,
 * a null category, and `mixed` constrain NOTHING here. `x` never blocks: a
 * person whose gender is `x` is eligible for every category (owner ruling,
 * RS002). A null gender is only an issue where the division actually needs
 * one — `mens`/`womens` here, or a jsonb gender rule.
 *
 * Precedence when a division carries BOTH a jsonb `GenderRule` and a
 * `mens`/`womens` category (owner ruling, 2026-08-17 review, recorded in
 * `_INDEX.md`'s RS002 session rulings): within one person's evaluation the
 * same code never fires twice, and if the jsonb loop above already emitted a
 * gender-family code (`MISSING_GENDER` or `GENDER_NOT_ALLOWED`) for this
 * person, the category block below emits NOTHING further for gender — the
 * organiser-authored jsonb rule is the more specific statement and wins.
 * Roster-level `MIXED_NEEDS_BOTH_GENDERS` is unaffected by this: it is a
 * property of the roster, not of a person, and always fires independently.
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
): EligibilityIssue[] {
  const issues: EligibilityIssue[] = [];

  for (const raw of division.eligibility) {
    const rule = raw as { kind?: string };
    if (rule.kind === "age") {
      const r = raw as AgeRule;
      if (!person.dob) {
        issues.push({
          code: "MISSING_DOB",
          message: "Date of birth is required for this age-restricted division.",
        });
        continue;
      }
      const cutoff = r.cutoff ?? { month: 1, day: 1, yearOf: "calendar" as const };
      const year =
        cutoff.yearOf === "season_start" ? seasonStartYear : new Date().getUTCFullYear();
      const cutoffDate = new Date(Date.UTC(year, (cutoff.month ?? 1) - 1, cutoff.day ?? 1));
      const age = ageAt(person.dob, cutoffDate);
      if (r.maxAgeAt !== undefined && age > r.maxAgeAt) {
        issues.push({
          code: "AGE_TOO_OLD",
          message: `Too old for this division (must be ${r.maxAgeAt} or younger on the cutoff date).`,
          meta: { limit: r.maxAgeAt },
        });
      }
      if (r.minAgeAt !== undefined && age < r.minAgeAt) {
        issues.push({
          code: "AGE_TOO_YOUNG",
          message: `Too young for this division (must be ${r.minAgeAt} or older on the cutoff date).`,
          meta: { limit: r.minAgeAt },
        });
      }
    } else if (rule.kind === "gender") {
      const r = raw as GenderRule;
      if (!person.gender) {
        issues.push({ code: "MISSING_GENDER", message: "Gender is required for this division." });
      } else if (!r.allowed.includes(person.gender)) {
        issues.push({
          code: "GENDER_NOT_ALLOWED",
          message: "This division is not open to your gender category.",
          meta: { allowed: r.allowed },
        });
      }
    }
  }

  const jsonbAlreadyFlaggedGender = issues.some(
    (i) => i.code === "MISSING_GENDER" || i.code === "GENDER_NOT_ALLOWED",
  );
  if (
    !jsonbAlreadyFlaggedGender &&
    (division.category === "mens" || division.category === "womens")
  ) {
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

  if (division.age_min != null || division.age_max != null) {
    if (!person.dob) {
      issues.push({
        code: "MISSING_DOB",
        message: "Date of birth is required for this age-restricted division.",
      });
    } else {
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
    }
  }

  return issues;
}

/**
 * Roster-level eligibility (V364 first-class columns + jsonb rules,
 * together): every player's own issues from `divisionEligibilityIssues`,
 * each carrying `playerIndex` (1-based) and `playerName` so the offending
 * row is identifiable on a multi-player entry — PLUS the mixed-composition
 * issue (`MIXED_NEEDS_BOTH_GENDERS`) when the division's category is
 * `mixed`: satisfied when the roster has at least one `m` AND at least one
 * `f` among its gendered rows. `x`/null rows count toward NEITHER side and
 * are never themselves a failure — an all-`x` roster fails for want of both
 * sides, not because of the `x` rows. This issue is roster-wide, so it
 * carries no `playerIndex`/`playerName`.
 *
 * `players` is deliberately a plain `{full_name?, dob?, gender?}` shape, not
 * a `registration_players` row — RS011's organiser-side gates call this
 * against `persons` rows.
 */
export function rosterIssues(
  division: EligibilityDivision,
  players: EligibilityRosterPlayer[],
  seasonStartYear: number,
): EligibilityIssue[] {
  const issues: EligibilityIssue[] = [];
  let hasM = false;
  let hasF = false;
  players.forEach((player, i) => {
    for (const issue of divisionEligibilityIssues(division, player, seasonStartYear)) {
      issues.push({ ...issue, playerIndex: i + 1, playerName: player.full_name ?? null });
    }
    if (player.gender === "m") hasM = true;
    if (player.gender === "f") hasF = true;
  });
  if (division.category === "mixed" && !(hasM && hasF)) {
    issues.push({
      code: "MIXED_NEEDS_BOTH_GENDERS",
      message: "This division requires a mixed roster (at least one male and one female player).",
    });
  }
  return issues;
}

/**
 * Display strings for a caller that just wants sentences — the pre-rework
 * `string[]` shape. The `Player <n> (<name>): ` prefix lives HERE, in the
 * formatter, not baked into `message`: RS011's override dialog renders
 * offenders from `playerIndex`/`playerName` as separate fields and must not
 * have to re-parse a formatted sentence to get them back out. A row with no
 * name formats as `Player <n>: <issue>` (no parens).
 */
export function formatEligibilityIssues(issues: EligibilityIssue[]): string[] {
  return issues.map((issue) => {
    if (issue.playerIndex == null) return issue.message;
    const name = issue.playerName ? ` (${issue.playerName})` : "";
    return `Player ${issue.playerIndex}${name}: ${issue.message}`;
  });
}

/**
 * Validate a registrant against the division's JSONB eligibility rules ONLY
 * (doc 06 §2), returning ENGLISH SENTENCES — the pre-V364, pre-RS011 shape.
 * Kept at this exact signature so no existing importer's call site changes
 * (RS002 entry-condition item 5). A thin wrapper: formats the same
 * structured path `divisionEligibilityIssues` uses, with `category`/
 * `age_min`/`age_max` all null so only the jsonb rules can fire.
 */
export function eligibilityIssues(
  rules: unknown[],
  input: EligibilityPerson,
  seasonStartYear: number,
): string[] {
  return formatEligibilityIssues(
    divisionEligibilityIssues(
      { eligibility: rules, category: null, age_min: null, age_max: null },
      input,
      seasonStartYear,
    ),
  );
}
