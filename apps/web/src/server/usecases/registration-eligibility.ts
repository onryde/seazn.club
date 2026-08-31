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
//
// RS011 (the organiser-side gates this module's own comments above kept
// promising): `gateRosterEligibility`, below, is the ONE thing genuinely new
// in this file — the DB-writing wrapper (throw 422 `ELIGIBILITY_VIOLATION` /
// audit-and-proceed) around `rosterIssues`. This is now the LEAF's one
// deliberate exception: the file's original header called it a leaf because
// it "imports nothing from registrations.ts or any other usecase" — it now
// imports `./audit`, ALSO a leaf (imports nothing from any other usecase),
// specifically so `registrations.ts` importing `ageAt`/`isMinor`/
// `requiresDob`/`requiresGender` FROM here never becomes a real cycle (a
// second import the other way, eligibility → registrations, would be).
// `createEntrants`/`insertMembers`/`patchEntrant`/`syncEntrantRosterFromSquad`
// (`entrants.ts`) and `putLineup` (`fixtures.ts`) call this directly.
// `setTeamSquad` (`teams.ts`, division-agnostic, never blocks) and
// `commitImport` (`imports.ts`, one audit row for a whole multi-division
// import) call `rosterIssues`/`splitEligibilityIssues` directly instead —
// same evaluator, different throw/audit shape their callers need.
import type postgres from "postgres";
import { HttpError } from "@/lib/errors";
import { audit } from "./audit";
import {
  ageAt,
  ageBandEligibilityIssues,
  categoryEligibilityIssues,
  isMinor,
  mixedCompositionTally,
  requiresDob,
  requiresGender,
  rosterCompositionIssues,
  type EligibilityCode,
  type EligibilityIssue,
  type EligibilityPerson,
} from "@/lib/registration-rules";

type Tx = postgres.TransactionSql;

// Re-exported verbatim so every existing importer of THIS file keeps
// compiling unchanged — see the header comment above.
export {
  ageAt,
  isMinor,
  requiresDob,
  requiresGender,
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

// ---------------------------------------------------------------------------
// RS011 — organiser-side gate. Everything below is new.
// ---------------------------------------------------------------------------

/** MISSING_DOB/MISSING_GENDER are the ONLY codes an organiser-side path
 *  treats as advisory — every other code blocks (unless overridden). The
 *  public registration submit path (RS002/RS003) keeps treating the exact
 *  same two codes as BLOCKING; that policy fork is deliberate (see
 *  `EligibilityIssue`'s own doc comment, `@/lib/registration-rules`, for why
 *  the issue shape carries no `severity` field to bake one policy in). */
const WARNING_ONLY_CODES: ReadonlySet<EligibilityCode> = new Set(["MISSING_DOB", "MISSING_GENDER"]);

/** Splits a `rosterIssues`/`divisionEligibilityIssues` result into blocking
 *  violations vs advisory warnings, by the one rule every organiser-side
 *  caller shares (`WARNING_ONLY_CODES` above). Exported so `commitImport`
 *  (`imports.ts`) and `setTeamSquad` (`teams.ts`) — which call `rosterIssues`
 *  directly rather than through `gateRosterEligibility` below, for their own
 *  multi-division / never-blocks reasons — classify issues the SAME way
 *  `gateRosterEligibility` does, instead of re-deriving the split. */
export function splitEligibilityIssues(issues: EligibilityIssue[]): {
  violations: EligibilityIssue[];
  warnings: EligibilityIssue[];
} {
  const warnings = issues.filter((i) => WARNING_ONLY_CODES.has(i.code));
  const violations = issues.filter((i) => !WARNING_ONLY_CODES.has(i.code));
  return { violations, warnings };
}

/** Season anchor for the age band's cutoff — the competition's start date,
 *  or this year if unset. Same derivation `registration-submit.ts`'s
 *  (module-private) `seasonStartYear` uses; duplicated here as one line
 *  rather than exported from a submit-path module an organiser-side gate
 *  has no business importing. Exported so `teams.ts`/`imports.ts` (which
 *  evaluate divisions without going through `gateRosterEligibility`) anchor
 *  the SAME cutoff this file's own gate does. */
export function seasonStartYearFrom(startsOnIso: string | null): number {
  return startsOnIso ? new Date(`${startsOnIso}T00:00:00Z`).getUTCFullYear() : new Date().getUTCFullYear();
}

/** A `divisions` row joined to its competition's `starts_on`, as
 *  `gateRosterEligibility` and its `teams.ts`/`imports.ts` siblings load it —
 *  `EligibilityDivision` plus the audit ledger's foreign keys and the season
 *  anchor. */
export interface EligibilityDivisionRow extends EligibilityDivision {
  id: string;
  competition_id: string;
  org_id: string;
  starts_on: string | null;
}

/** Loads one division's eligibility columns + audit-ledger FKs + season
 *  anchor, in the shape every organiser-side gate needs. Exported so
 *  `teams.ts`/`imports.ts` (which evaluate MULTIPLE divisions at once, or
 *  never call `gateRosterEligibility` at all) can load the same row shape
 *  this file's own gate uses, rather than each hand-rolling the join. */
export async function loadEligibilityDivisions(
  tx: Tx,
  divisionIds: readonly string[],
): Promise<EligibilityDivisionRow[]> {
  if (divisionIds.length === 0) return [];
  return tx<EligibilityDivisionRow[]>`
    select d.id, d.category, d.age_min, d.age_max, d.age_cutoff_month, d.age_cutoff_day,
           d.competition_id, d.org_id, c.starts_on
    from divisions d
    join competitions c on c.id = d.competition_id
    where d.id in ${tx([...new Set(divisionIds)])}`;
}

/** A `persons` row in the `EligibilityRosterPlayer` shape, plus its id —
 *  what `gateRosterEligibility` and its `teams.ts`/`imports.ts` siblings
 *  load roster candidates as. */
export interface EligibilityPersonRow extends EligibilityRosterPlayer {
  id: string;
}

/** Loads the named persons' name/dob/gender — the one query every
 *  organiser-side gate issues against `persons`. Exported for the same
 *  reason `loadEligibilityDivisions` is. */
export async function loadEligibilityPersons(
  tx: Tx,
  personIds: readonly string[],
): Promise<EligibilityPersonRow[]> {
  if (personIds.length === 0) return [];
  return tx<EligibilityPersonRow[]>`
    select id, full_name, dob::text as dob, gender from persons
    where id in ${tx([...new Set(personIds)])}`;
}

export interface GateRosterEligibilityArgs {
  /** The one division the roster is being written against. */
  divisionId: string;
  /** person ids on the roster being written — organiser paths hold
   *  `persons` rows, never `registration_players`. Empty is a no-op. */
  personIds: readonly string[];
  /** Free-text label for the audit payload (e.g. `"roster_add"`,
   *  `"patch_entrant"`, `"roster_sync"`, `"put_lineup"`) — never read back
   *  programmatically, purely for a human reading the ledger. */
  context: string;
  /** Present only when the organiser is knowingly overriding a violation. */
  override?: { reason: string } | null;
  /** `auth.userId` — null for an API-key caller (the audit row still
   *  records it, same as every other `audit()` call site). */
  actorId: string | null;
}

/**
 * THE organiser-side gate (RS011). Loads the division's first-class
 * eligibility columns and the named persons, runs them through
 * `rosterIssues` — the EXACT function the public registration path
 * evaluates, never a second copy (see this file's header) — and:
 *
 *  - no `override` and at least one BLOCKING issue (anything outside
 *    `WARNING_ONLY_CODES`) → throws `HttpError(422, …,
 *    "ELIGIBILITY_VIOLATION", { violations, warnings })`.
 *  - `override.reason` present and at least one blocking issue → writes
 *    exactly ONE `eligibility.overridden` `competition_events` row (via
 *    `audit()`, moved to `./audit` — see this file's header) naming the
 *    actor and reason, then proceeds. `override` present with NOTHING to
 *    override (a clean roster) writes no audit row — there is nothing to
 *    record as overridden.
 *  - either way, returns the `MISSING_DOB`/`MISSING_GENDER` warnings so the
 *    caller can surface them even on a pass that needed no override.
 *
 * Callers with a SINGLE division in scope
 * (`createEntrants`/`insertMembers`/`patchEntrant`/
 * `syncEntrantRosterFromSquad`, `entrants.ts`; `putLineup`, `fixtures.ts`)
 * call this directly. `setTeamSquad` (multiple enrolled divisions, never
 * blocks) and `commitImport` (possibly multiple divisions, exactly ONE audit
 * row for the whole import) call `loadEligibilityDivisions` /
 * `loadEligibilityPersons` / `rosterIssues` / `splitEligibilityIssues`
 * directly instead — same evaluator, a throw/audit shape this single-division
 * wrapper does not fit.
 */
export async function gateRosterEligibility(
  tx: Tx,
  { divisionId, personIds, context, override, actorId }: GateRosterEligibilityArgs,
): Promise<EligibilityIssue[]> {
  const ids = [...new Set(personIds)];
  if (ids.length === 0) return [];
  const [division] = await loadEligibilityDivisions(tx, [divisionId]);
  if (!division) throw new HttpError(404, "division not found");
  const persons = await loadEligibilityPersons(tx, ids);
  const issues = rosterIssues(division, persons, seasonStartYearFrom(division.starts_on));
  const { violations, warnings } = splitEligibilityIssues(issues);
  if (violations.length > 0) {
    if (!override?.reason) {
      throw new HttpError(
        422,
        formatEligibilityIssues(violations).join(" "),
        "ELIGIBILITY_VIOLATION",
        { violations, warnings },
      );
    }
    await audit(
      tx,
      division.competition_id,
      division.org_id,
      "eligibility.overridden",
      {
        context,
        division_id: divisionId,
        person_ids: ids,
        reason: override.reason,
        violations,
      },
      actorId,
    );
  }
  return warnings;
}
