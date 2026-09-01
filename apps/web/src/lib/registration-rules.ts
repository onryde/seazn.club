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

/**
 * RS011 review round 3, finding 4: an organiser's override reason
 * (`EligibilityOverrideDialog`, `api-v1/schemas.ts`'s `EligibilityOverride`)
 * must be long enough to be worth auditing but short enough to fit the
 * ledger — defined ONCE here, client-safe, so the client-side dialog's
 * `armed`/`maxLength` check and the server-side Zod schema's
 * `z.string().min(REASON_MIN).max(REASON_MAX)` can never silently drift
 * apart the way two hardcoded `3`/`500` literals could.
 */
export const REASON_MIN = 3;
export const REASON_MAX = 500;

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
 * Division has a gender rule ⇒ the form must collect gender (RS006 WHO step,
 * design §4 step 1: "dob/gender collected once, only if any division needs
 * them"). Sibling of `requiresDob` above, same shape. Moved here from
 * `server/usecases/registration-eligibility.ts` (RS011): that module's own
 * comment on this function used to say "nothing client-side calls this
 * directly" — RS011's `entrants-panel.tsx` (a client component) needs the
 * SAME predicate the server-side gate evaluates against to decide when a
 * roster row's missing gender is worth an amber chip, and a client
 * component importing anything under `@/server/**` is a `next build`
 * failure `tsc` never catches (repo standing trap) — the exact reason
 * `ageAt`/`isMinor`/`requiresDob` moved here at RS006 W1 (see this file's
 * header). Re-exported verbatim by `registration-eligibility.ts` so it
 * stays the ONE evaluator, split across a server-only half and a
 * client-safe half, same as every other predicate in this file.
 *
 * RULING (RS007 review fix M2, 2026-08-29): a free-text `eligibility_note`
 * must NEVER make a field mandatory. A 2026-08-27 revision fired this on any
 * non-empty `eligibility_note` too — on the theory that V380 dropped the
 * jsonb `eligibility` rules without a first-class replacement for every
 * gender-rule shape a note might now be the only remaining record of (an
 * allow-list excluding non-binary, or any rule on a division that already
 * had a `category`, could not be converted — see V380's migration header,
 * "Sex" section). In practice that made an UNRELATED organiser note
 * ("bring your own kit", "club members only") force the public WHO step to
 * demand gender on a division `divisionEligibilityIssues` never gates on
 * gender for — the browser blocked a registrant the API would happily
 * accept. `category` is `mens`/`womens` (individual-level: needs the
 * specific gender) or `mixed` (roster-level: needs every player's gender to
 * prove the roster balances) is now the ONLY trigger — agrees EXACTLY with
 * `divisionEligibilityIssues`'s own gender source
 * (`categoryEligibilityIssues`/`rosterCompositionIssues`, this file).
 * `eligibility_note` stays in the parameter type only because existing call
 * sites already pass the division's full context (`registration-submit.ts`,
 * `registrations.ts`) — accepted, never read.
 */
export function requiresGender(division: {
  category: string | null;
  eligibility_note?: string | null;
}): boolean {
  return division.category === "mens" || division.category === "womens" || division.category === "mixed";
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

// Static days-per-month table for age_cutoff_day validity (RS007 review fix
// L1). February is capped at 28, deliberately NOT 29: a cutoff is not a
// one-off date — the SAME age_cutoff_month/age_cutoff_day pair is
// re-evaluated every season against a DIFFERENT seasonStartYear
// (ageBandEligibilityIssues below), so a leap-only day would still silently
// roll over into 1 March in the three years out of four that are not leap
// years. Rejecting it here guarantees every (month, day) pair that survives
// this check is valid for EVERY year, not just some.
const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Whether `day` is a real day-of-month for `month` (1-12), by the
 * every-year-safe table above. Exported so the write path
 * (`api-v1/schemas.ts`'s `checkAgeCutoff`) can reject an impossible
 * age_cutoff_month/age_cutoff_day combination BEFORE it is ever stored —
 * same "validate once, reuse everywhere" shape as every other predicate in
 * this file. `ageBandEligibilityIssues` below uses it too, as a read-side
 * backstop for a row that reached storage before this check existed (or
 * bypassed it directly).
 */
export function isValidCutoffDay(month: number, day: number): boolean {
  const max = DAYS_IN_MONTH[month - 1];
  return max != null && day >= 1 && day <= max;
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
  // RS007 review fix L1 ORIGINALLY threw here — the write path
  // (checkAgeCutoff, api-v1/schemas.ts) rejects a day that does not exist in
  // its month for every NEW write, so a throw was meant to be unreachable,
  // catching a stored row that reached the column some other way rather than
  // let `Date.UTC` silently roll it into the next month (31 September
  // becoming 1 October, 30 February becoming 1/2 March — the original
  // silent-shift defect that fix closed).
  //
  // RS011 review fix 2: "unreachable" was never actually guaranteed. The DB
  // CHECK constraint only range-checks 1-31, not day-per-month, and
  // V380__division_eligibility_consolidation.sql's backfill predates
  // checkAgeCutoff entirely — a legacy row can still carry an impossible
  // combination. This function is called from `setTeamSquad`'s
  // eligibility-warnings pass AFTER the squad write already ran in the same
  // transaction (a throw there rolls back a save that endpoint's own
  // contract promises will never hard-block), and from `gateRosterEligibility`
  // at 4 other organiser-side gate points, none of which catch a bare
  // `Error` — an uncaught throw there surfaces as an unhandled 500, not the
  // coded 422 `ELIGIBILITY_VIOLATION` the client dialog recognizes.
  //
  // So: never throw. Treat an unenforceable cutoff as "no age rule to
  // evaluate" and skip straight to returning whatever issues have already
  // been collected (none, at this point) — NOT the 1-January default (that
  // would silently invent a cutoff the division never configured), and NOT
  // rolling into the next month (the original bug). A division stuck with a
  // bad legacy cutoff simply stops enforcing its age band until an organiser
  // fixes it, which is strictly safer than either alternative.
  if (!isValidCutoffDay(cutoffMonth, cutoffDay)) {
    console.error(
      `Invalid age cutoff: day ${cutoffDay} does not exist in month ${cutoffMonth} — ` +
        "skipping the age-band check for this division rather than blocking the request " +
        "or rolling into the wrong month. This division's stored age_cutoff_month/" +
        "age_cutoff_day predates write-time validation and should be corrected.",
    );
    return issues;
  }
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
 * Season anchor for the age band's cutoff — the competition's start date,
 * or this year if unset (`ageBandEligibilityIssues` above anchors at 1
 * January of this year when the division sets no cutoff month/day).
 *
 * RS011 review round 3, finding 6: promoted here from being byte-for-byte
 * duplicated in TWO server usecase files — `registration-eligibility.ts`'s
 * own (exported) `seasonStartYearFrom` and `registration-submit.ts`'s
 * private `seasonStartYear` computed the literal same expression. Defined
 * ONCE, client-safe, alongside every other predicate this file already
 * shares between the server-only eligibility evaluator and the public
 * stepper. `registration-eligibility.ts` re-exports this verbatim (same "one
 * evaluator, two halves" shape every other predicate here uses) so
 * `imports.ts`/`teams.ts`, which import `seasonStartYearFrom` from there,
 * keep compiling unchanged.
 *
 * NOT the same function as `components/public-site/register/eligibility-
 * presentation.ts`'s OWN `seasonStartYearFrom` — that one additionally
 * accepts an injectable `now` (for its own tests) and falls back on an
 * unparsable `starts_on` string rather than only a null one. Two genuinely
 * different behaviours were never the duplicate this fix closes; only the
 * server-usecase pair was.
 */
export function seasonStartYearFrom(startsOnIso: string | null): number {
  return startsOnIso
    ? new Date(`${startsOnIso}T00:00:00Z`).getUTCFullYear()
    : new Date().getUTCFullYear();
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
