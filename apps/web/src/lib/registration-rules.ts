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
// RS007/V380 dropped the `divisions.eligibility` jsonb column entirely (owner
// ruling, `_INDEX.md` "Eligibility consolidation") — `category`/`age_min`/
// `age_max`/`age_cutoff_month`/`age_cutoff_day` are now the ONLY eligibility
// representation, server and client alike, so this file's predicates are no
// longer a deliberately-narrower subset of a wider server-side evaluator —
// `divisionEligibilityIssues` (registration-eligibility.ts) is now a thin
// wrapper over exactly these two functions plus nothing else. The public
// read model (`PublicRegistrationDivision`) now ships `age_cutoff_month`/
// `age_cutoff_day` alongside the derived `requires_dob`/`requires_gender`
// booleans, so a client-side caller of `ageBandEligibilityIssues` (via
// `DivisionLike`, components/public-site/register/types.ts) evaluates the
// SAME cutoff the server enforces at submit — the 1-January default below
// now only ever fires for a division that genuinely has no cutoff set.
//
// `rosterIssues`'s roster-composition check (`mixedCompositionTally`/
// `rosterCompositionIssues` below) moved IN at RS006 W3 (step 3 — DETAILS):
// unlike the jsonb loop, it reads only `category` (public) and each
// player's `gender` (collected client-side, in the roster the stepper is
// building) — nothing it needs is server-only, and the public stepper's
// mixed-composition METER needs the SAME rule the server enforces at
// submit. `server/usecases/registration-eligibility.ts`'s `rosterIssues`
// now calls `rosterCompositionIssues` from here instead of tallying inline
// — see that file's header for the other half of this split.

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
 * Division has an age band ⇒ the form must collect DOB.
 *
 * RS007/V380: the jsonb `eligibility` rules (and this function's old
 * bare-array overload, which read them) are gone — `age_min`/`age_max` are
 * the only source left, so this is now a plain boolean-in boolean-out
 * predicate. Untouched by the structured-issue rework — this returns a
 * boolean, not an issue.
 */
export function requiresDob(division: {
  age_min: number | null;
  age_max: number | null;
}): boolean {
  return division.age_min != null || division.age_max != null;
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
 * step can grey a self-ineligible division with the literal same rule. RS007/
 * V380 retired the jsonb `eligibility` rules (and the gender-precedence rule
 * that used to arbitrate between them and this block) — `category` is now
 * the whole gender-eligibility story, server and client alike.
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
 * `age_cutoff_month`/`age_cutoff_day` of `seasonStartYear` when the division
 * sets them, else 1 January — never "today": a season-long division must not
 * change who is eligible partway through the season. RS007/V380 moved the
 * cutoff here from the retired jsonb rules' `cutoff.yearOf: "season_start"`
 * branch, which this replaces exactly (same anchor, same reason).
 *
 * The two cutoff fields are OPTIONAL on this narrow parameter type (unlike
 * `EligibilityDivision`, server-side, which always carries them) — RS007/
 * V380 threads the real cutoff onto the wire (`PublicRegistrationDivision`)
 * and the public stepper's `DivisionLike` now carries it too, but a caller
 * that only has `category`/`age_min`/`age_max` in hand (a hand-built test
 * fixture, or a narrower division shape elsewhere) still keeps compiling
 * unchanged and gets the same 1-January default it always has.
 *
 * Extracted from `divisionEligibilityIssues`'s first-class block for the
 * same reason as `categoryEligibilityIssues` above.
 */
export function ageBandEligibilityIssues(
  division: {
    age_min: number | null;
    age_max: number | null;
    age_cutoff_month?: number | null;
    age_cutoff_day?: number | null;
  },
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
  const cutoffMonth = division.age_cutoff_month ?? 1;
  const cutoffDay = division.age_cutoff_day ?? 1;
  const cutoffDate = new Date(Date.UTC(seasonStartYear, cutoffMonth - 1, cutoffDay));
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

/**
 * Roster-wide gender tally — at least one player recorded as `m`, at least
 * one recorded as `f`. `x` and null/undefined count toward NEITHER side
 * (owner ruling, RS002 — mirrored from `categoryEligibilityIssues`'s "x
 * never blocks" comment): an all-`x` roster fails a mixed division for want
 * of both sides, not because `x` itself is disqualifying.
 *
 * Split out from `rosterCompositionIssues` so the stepper's METER (RS006
 * step 3) can render the live count/status without re-deriving the tally
 * from the pass/fail issue list.
 */
export function mixedCompositionTally(players: readonly EligibilityPerson[]): {
  hasM: boolean;
  hasF: boolean;
} {
  let hasM = false;
  let hasF = false;
  for (const player of players) {
    if (player.gender === "m") hasM = true;
    if (player.gender === "f") hasF = true;
  }
  return { hasM, hasF };
}

/**
 * Roster-level mixed-composition check (V364 `category === "mixed"`):
 * satisfied when the roster has at least one `m` AND at least one `f`
 * player (`mixedCompositionTally` above). Roster-wide, so the returned
 * issue (when present) carries no `playerIndex`/`playerName` — a caller
 * attributing per-player issues to a row (`rosterIssues` server-side,
 * `rosterEligibilityForDivision` client-side) adds those to every OTHER
 * issue it collects, never to this one.
 *
 * Extracted from `server/usecases/registration-eligibility.ts`'s
 * `rosterIssues` (RS006 W3) — see this file's header for why it belongs
 * here now. An empty roster is NOT vacuously satisfied: zero players means
 * zero of each gender, so `!(hasM && hasF)` is true and the division still
 * reports the issue — a mixed division isn't "mixed-compliant by having no
 * one enrolled yet."
 */
export function rosterCompositionIssues(
  division: { category: string | null },
  players: readonly EligibilityPerson[],
): EligibilityIssue[] {
  if (division.category !== "mixed") return [];
  const { hasM, hasF } = mixedCompositionTally(players);
  if (hasM && hasF) return [];
  return [
    {
      code: "MIXED_NEEDS_BOTH_GENDERS",
      message: "This division requires a mixed roster (at least one male and one female player).",
    },
  ];
}
