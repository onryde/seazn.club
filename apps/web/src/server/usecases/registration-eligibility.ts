import "server-only";
// Registration eligibility (doc 06 §2; V364 "eligibility becomes first-class").
//
// Split out of `registrations.ts` (RS002 wave 2 — that file was 2431 lines,
// past the ~600-line split trigger the RS002 prompt sets). This module is
// deliberately a LEAF: it imports nothing from `registrations.ts` or any
// other usecase, so `registrations.ts` — and the submit/approval modules
// RS002 adds next — can import THIS module without a cycle.
//
// RS006 W1 split this AGAIN, narrower: the pure, DB-free predicates
// (`ageAt`, `isMinor`, `requiresDob`, and the first-class category/age-band
// checks) moved to `@/lib/registration-rules`, which carries no
// `server-only` — the public stepper's ENTRIES step needs to grey a
// self-ineligible division with the SAME rule this module enforces at
// submit, and a client component importing anything under `@/server/**` is
// a `next build` failure `tsc` never catches. This file re-exports them
// verbatim (see the `@/lib/registration-rules` import below) so it stays
// the ONE evaluator — "two eligibility evaluators is the exact failure the
// RS011 re-homing exists to prevent" (this file's own prior header) applies
// just as much to a server/client fork as to two server-side copies.
//
// RS006 W3 (step 3 — DETAILS) moved the roster-composition check
// (`rosterIssues`'s hasM/hasF tally) out to `@/lib/registration-rules` too
// (`rosterCompositionIssues`), for the same reason: the public stepper's
// mixed-composition METER needs the identical rule, and it reads only
// `category` (public) and each player's `gender` — nothing server-only.
// `rosterIssues` below now calls it instead of tallying inline.
//
// RS007/V380 (owner ruling, `_INDEX.md` "Eligibility consolidation") DROPPED
// `divisions.eligibility` (jsonb) — until then, a division carried its age/
// gender rules TWICE (the jsonb rules here, AND `category`/`age_min`/
// `age_max`, V364), enforced ADDITIVELY, with a precedence rule arbitrating
// when both fired for gender. That was the source of three live defects (two
// cutoff dates disagreeing, `youth` only ever derived from the jsonb half,
// and the jsonb "custom" rule rendered nowhere) — see the migration's own
// header (`db/migration/deltas/V380__division_eligibility_consolidation.sql`)
// for the full account. This file now has exactly ONE eligibility
// representation: `category`/`age_min`/`age_max`/`age_cutoff_month`/
// `age_cutoff_day` — nothing left to arbitrate, so the precedence rule (and
// the dual-source "additive" framing) is gone with the jsonb loop it existed
// to reconcile.
//
// RETURN SHAPE (RS002 entry-condition item 5, `_INDEX.md`, 2026-08-17):
// structured `EligibilityIssue[]` with a machine `code`, not `string[]`.
// RS011's organiser-side gates depend on RS002 and consume this SAME
// evaluator to fill a 422's `extra.violations[]` and drive an override
// dialog listing offenders — it needs codes, not sentences to re-parse.
// "Two eligibility evaluators is the exact failure the RS011 re-homing
// exists to prevent," so this module derives display strings at the edge
// (`formatEligibilityIssues`) instead of forking a second evaluator later.
// A legacy `eligibilityIssues(rules, input, seasonStartYear): string[]`
// wrapper shipped here at W2, kept "so no existing importer's call site
// changes" — but the whole-branch review (RS002 W5) found ZERO importers,
// repo-wide, of that exact shape: it was already dead when W2 shipped it.
// Removed (W5 review) rather than left as a seam nothing uses — RS003/RS011
// are the next consumers of this module and should find ONE evaluator with
// ONE return shape, not a string-returning shortcut that reads as a
// supported API. `formatEligibilityIssues`, below, is the only display-string
// path now; its five hardcoded-English assertions moved from the deleted
// wrapper's own test to call it directly (registration-eligibility.test.ts).
import {
  ageAt,
  ageBandEligibilityIssues,
  categoryEligibilityIssues,
  isMinor,
  mixedCompositionTally,
  requiresDob,
  rosterCompositionIssues,
  type EligibilityCode,
  type EligibilityIssue,
  type EligibilityPerson,
} from "@/lib/registration-rules";

// Re-exported verbatim so every existing importer of THIS file keeps
// compiling unchanged — see the header comment above.
export {
  ageAt,
  isMinor,
  requiresDob,
  categoryEligibilityIssues,
  ageBandEligibilityIssues,
  mixedCompositionTally,
  rosterCompositionIssues,
};
export type { EligibilityCode, EligibilityIssue, EligibilityPerson };

/**
 * A division carrying only the fields eligibility checks need — narrow on
 * purpose so a caller can pass a full division row (or a hand-built object
 * in a test) without a cast. RS007/V380: `age_cutoff_month`/`age_cutoff_day`
 * are required-but-nullable here (unlike `ageBandEligibilityIssues`'s own,
 * looser parameter type in `@/lib/registration-rules`, where they are
 * optional) — every server-side caller has a real division row in hand, so
 * this stays as explicit as `age_min`/`age_max` rather than silently
 * defaulting to 1 January when a caller forgets to pass them.
 */
export interface EligibilityDivision {
  category: string | null;
  age_min: number | null;
  age_max: number | null;
  age_cutoff_month: number | null;
  age_cutoff_day: number | null;
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

/**
 * Division has a gender rule ⇒ the form must collect gender (RS006 WHO step,
 * design §4 step 1: "dob/gender collected once, only if any division needs
 * them"). Sibling of `requiresDob` above, same shape: a boolean the PUBLIC
 * read model can hand a client so the client never has to re-derive WHICH
 * divisions care about gender itself. Stays server-side (unlike
 * `categoryEligibilityIssues`) — nothing client-side calls this directly,
 * the client only ever reads the boolean this produces off the wire.
 *
 * Must agree with `divisionEligibilityIssues`'s gender source exactly: the
 * first-class `category` being `mens`/`womens` (individual-level: needs the
 * specific gender) or `mixed` (roster-level: needs every player's gender to
 * prove the roster balances). `open`/`null` need nothing.
 */
export function requiresGender(division: { category: string | null }): boolean {
  return (
    division.category === "mens" || division.category === "womens" || division.category === "mixed"
  );
}

/**
 * Full structured eligibility check for one player against one division: the
 * first-class `category`/`age_min`/`age_max`/`age_cutoff_month`/
 * `age_cutoff_day` columns (V364/V380, evaluated by
 * `categoryEligibilityIssues`/`ageBandEligibilityIssues`,
 * `@/lib/registration-rules`) — the ONE eligibility representation since
 * RS007/V380 dropped the jsonb `eligibility` rules this function used to
 * evaluate first (and the precedence rule that arbitrated between the two
 * when both fired for gender; see this file's header). `seasonStartYear`
 * anchors the age band's cutoff.
 */
export function divisionEligibilityIssues(
  division: EligibilityDivision,
  person: EligibilityPerson,
  seasonStartYear: number,
): EligibilityIssue[] {
  return [
    ...categoryEligibilityIssues(division, person),
    ...ageBandEligibilityIssues(division, person, seasonStartYear),
  ];
}

/**
 * Roster-level eligibility (V364/V380 first-class columns): every player's
 * own issues from `divisionEligibilityIssues`,
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
  players.forEach((player, i) => {
    for (const issue of divisionEligibilityIssues(division, player, seasonStartYear)) {
      issues.push({ ...issue, playerIndex: i + 1, playerName: player.full_name ?? null });
    }
  });
  // Roster-wide (not per-player) — @/lib/registration-rules, RS006 W3. Same
  // ordering as before the extraction: per-player issues first, this last.
  issues.push(...rosterCompositionIssues(division, players));
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

// The legacy `eligibilityIssues(rules, input, seasonStartYear): string[]`
// wrapper that used to live here was deleted (RS002 W5 whole-branch review —
// zero production callers repo-wide; see the module header comment above).
