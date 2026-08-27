// RS006 ENTRIES/DETAILS steps — eligibility presentation mapping (pure, no
// DOM, no server import). Design §4 step 2: "Divisions the registrant
// cannot enter *as a player* are greyed with the reason but stay pickable
// for team entries." Step 3 (DETAILS): "live per-player eligibility
// including the mixed-composition meter."
//
// Calls the SAME predicates the server evaluates with
// (@/lib/registration-rules — the RS006 W1 leaf extracted from
// server/usecases/registration-eligibility.ts's first-class-column block,
// widened at RS006 W3 with the roster-composition check) rather than
// re-deriving the rule client-side, which is the exact "two eligibility
// evaluators" drift that module's header warns against. Only the
// first-class category/age-band/composition predicates are usable here at
// all: the jsonb `eligibility` rules never ship to the client (the public
// read model exposes only the derived `requires_dob`/`requires_gender`
// booleans), so this can never be a full substitute for the server's
// verdict — it is UX only, exactly as the RS006 prompt requires ("Client
// pre-checks are UX; the server verdict is truth").
import {
  ageBandEligibilityIssues,
  categoryEligibilityIssues,
  rosterCompositionIssues,
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
 *  for GENDER_NOT_ALLOWED: RS007/V380 dropped the jsonb `eligibility` rules
 *  that were its only producer — no evaluator, client or server, emits this
 *  code any more (registration-rules.ts's `categoryEligibilityIssues` emits
 *  CATEGORY_MISMATCH instead), so a key here would still be untestable dead
 *  code, just for a different, current reason. MIXED_NEEDS_BOTH_GENDERS DOES
 *  have an entry (RS006 W3): `rosterEligibilityForDivision` below produces
 *  it via `rosterCompositionIssues`, which is client-safe. */
export const INELIGIBLE_MESSAGE_KEY: Partial<Record<EligibilityCode, string>> = {
  CATEGORY_MISMATCH: "register.entries.ineligible.category",
  AGE_TOO_OLD: "register.entries.ineligible.age",
  AGE_TOO_YOUNG: "register.entries.ineligible.age",
  MISSING_DOB: "register.entries.ineligible.missingDob",
  MISSING_GENDER: "register.entries.ineligible.missingGender",
  MIXED_NEEDS_BOTH_GENDERS: "register.details.mixedMeter.unmet",
};

/**
 * Step 3's roster-ROW override for MISSING_DOB/MISSING_GENDER: the base
 * `INELIGIBLE_MESSAGE_KEY` sentences for those two codes are framed for the
 * CONTACT's own step-1 fields ("Add your date of birth in step 1 ...") —
 * correct for DivisionCard/EntryCart's self-verdict, wrong for an arbitrary
 * roster row that may not be the contact at all. Every OTHER code keeps
 * `INELIGIBLE_MESSAGE_KEY`'s sentence unchanged — this is an override of
 * two entries, not a second parallel mapping (the RULE evaluation stays
 * 100% shared; only these two DISPLAY strings vary by context).
 */
const ROSTER_ROW_MESSAGE_OVERRIDE: Partial<Record<EligibilityCode, string>> = {
  MISSING_DOB: "register.details.issue.missingDob",
  MISSING_GENDER: "register.details.issue.missingGender",
};

export function rosterIssueMessageKey(code: EligibilityCode): string | undefined {
  return ROSTER_ROW_MESSAGE_OVERRIDE[code] ?? INELIGIBLE_MESSAGE_KEY[code];
}

/**
 * Whether the CONTACT (if they end up self-linking this entry) individually
 * qualifies for `division`. Deliberately does not evaluate
 * `MIXED_NEEDS_BOTH_GENDERS` — that is a roster-wide property
 * (`rosterEligibilityForDivision` below, step 3), not something one
 * person's own dob/gender can answer on its own.
 *
 * `age_cutoff_month`/`age_cutoff_day` are OPTIONAL on `division` — RS007/
 * V380 threaded the real cutoff onto `DivisionLike`, but this function's own
 * parameter type stays narrow ("a hand-built test fixture needs no cast",
 * types.ts's own DivisionLike comment) and forwards whatever the caller
 * passed straight into `ageBandEligibilityIssues`, which defaults to 1
 * January itself when either side is absent.
 */
export function selfEligibilityForDivision(
  division: {
    category: string | null;
    age_min: number | null;
    age_max: number | null;
    age_cutoff_month?: number | null;
    age_cutoff_day?: number | null;
  },
  person: EligibilityPerson,
  seasonStartYear: number,
): SelfEligibility {
  const issues = [
    ...categoryEligibilityIssues(division, person),
    ...ageBandEligibilityIssues(division, person, seasonStartYear),
  ];
  return { eligible: issues.length === 0, issues };
}

export interface RosterEligibility {
  eligible: boolean;
  /** Per-player issues carry `playerIndex`(1-based)/`playerName`; the
   *  roster-wide `MIXED_NEEDS_BOTH_GENDERS` (when present) carries neither
   *  — same convention as the server's `rosterIssues`. */
  issues: EligibilityIssue[];
}

/**
 * Step 3's live roster verdict: every player's own category/age-band
 * issues (attributed to their row, `playerIndex 1-based`/`playerName`) PLUS
 * the roster-wide mixed-composition check — the client-safe mirror of
 * `server/usecases/registration-eligibility.ts`'s `rosterIssues`, minus the
 * jsonb-rules loop that module alone can evaluate (never shipped to the
 * client — same limitation `selfEligibilityForDivision` above documents).
 * "Client pre-checks are UX; the server verdict is truth": a roster that
 * passes here can still 422 at submit on a jsonb-only rule; a roster this
 * flags is CERTAIN to be rejected, so blocking "Next" on it is always safe.
 */
export function rosterEligibilityForDivision(
  division: {
    category: string | null;
    age_min: number | null;
    age_max: number | null;
    age_cutoff_month?: number | null;
    age_cutoff_day?: number | null;
  },
  players: readonly (EligibilityPerson & { full_name?: string | null })[],
  seasonStartYear: number,
): RosterEligibility {
  const issues: EligibilityIssue[] = [];
  players.forEach((player, i) => {
    const playerIssues = [
      ...categoryEligibilityIssues(division, player),
      ...ageBandEligibilityIssues(division, player, seasonStartYear),
    ];
    for (const issue of playerIssues) {
      issues.push({ ...issue, playerIndex: i + 1, playerName: player.full_name ?? null });
    }
  });
  issues.push(...rosterCompositionIssues(division, players));
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
