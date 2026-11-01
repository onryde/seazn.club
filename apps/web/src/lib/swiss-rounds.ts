// Swiss Playoff — how many qualifying rounds a field of N plays.
//
// Owner's brief was "scale with field size"; this table is the product
// decision that implements it. It is DATA, not a chain of ifs, so the
// catalogue, the generator and the test all read one declaration (a band
// moved here moves every reader with it).
//
// Client-safe on purpose: the format catalogue (config/format-gallery.tsx,
// lib/format-templates.ts) and the server generator
// (server/usecases/stages.ts's swissGen) must agree on the number, and a
// `server-only` module could not be imported by the first two.

export interface SwissRoundsBand {
  /** Largest field this band covers (inclusive). */
  upTo: number;
  rounds: number;
}

/** Ascending by `upTo`; the last band is the open-ended tail. */
export const SWISS_ROUNDS_BANDS: readonly SwissRoundsBand[] = [
  { upTo: 8, rounds: 3 },
  { upTo: 16, rounds: 4 },
  { upTo: 32, rounds: 5 },
  { upTo: 64, rounds: 6 },
];

/** Rounds for any field beyond the last band. */
export const SWISS_ROUNDS_BEYOND = 7;

/**
 * Qualifying rounds for a Swiss Playoff field of `entrants`.
 *
 * Total, by construction: a field too small to pair (0/1) and a garbage read
 * (`Number("")` is 0, `NaN` from a cleared input) both floor at the smallest
 * band rather than returning 0 — a 0-round swiss stage would generate nothing
 * and look like a broken format rather than a bad input. A non-integer field
 * size truncates (8.9 entrants is still an 8-entrant field), never rounds up
 * into the next band.
 */
export function swissRoundsForFieldSize(entrants: number): number {
  const n = Number.isFinite(entrants) ? Math.trunc(entrants) : 0;
  for (const band of SWISS_ROUNDS_BANDS) {
    if (n <= band.upTo) return band.rounds;
  }
  return SWISS_ROUNDS_BEYOND;
}

// ---------------------------------------------------------------------------------------------------------------------
// W3 Task 11 (SW-H2, RB3-3; rule X-SW-16) — the round count against the FIELD, the first production reader of the band
// table above. Rulebook-W3-swiss.md §3.1 ("Bounds (n = active field at the time of pairing)") and §3.2:
//   safe maximum  ⌊n/2⌋ — a rematch-free round is guaranteed whatever was paired before (Dirac);
//   hard maximum  n − 1 for an even field, n for an odd one — a legal Swiss cannot exist beyond it;
//   recommended   min(band(n), safe maximum).
// Between the safe and the hard maximum the round count is allowed with a warning; above the hard maximum it is refused
// (`SWISS_ROUNDS_ABOVE_MAX`), at every Generate and at Start (`usecases/stages.ts` `swissGen`,
// `refuseSwissRoundsAboveMaxAtStart`). `n` is always the field paired NOW (`swissFieldForRound`): a latecomer whose
// first round is still ahead is not in it.
// ---------------------------------------------------------------------------------------------------------------------

export interface SwissRoundsGuidance {
  recommended: number;
  safeMax: number;
  hardMax: number;
}

export type SwissRoundsVerdict = "ok" | "warn" | "refuse";

export interface SwissRoundsJudgement extends SwissRoundsGuidance {
  verdict: SwissRoundsVerdict;
}

/**
 * Rulebook §3.1/§3.2 for a field of `field`. A field under 2 has nothing to pair, so it has no guidance: every caller
 * asks only of a pairable field (the server refuses a field under 2 first, `refuseSwissFieldUnderTwo`; the desk hides
 * the line), and a call that slips past that is refused here by name rather than answered with a 0-round "maximum".
 */
export function swissRoundsGuidance(field: number): SwissRoundsGuidance {
  if (!Number.isInteger(field) || field < 2) {
    throw new RangeError(`swiss round guidance needs a field of 2 or more entrants (got ${String(field)})`);
  }
  const safeMax = Math.floor(field / 2);
  const hardMax = field % 2 === 0 ? field - 1 : field;
  return { recommended: Math.min(swissRoundsForFieldSize(field), safeMax), safeMax, hardMax };
}

/** What a new Swiss's Rounds box opens at: the field's recommendation, or — with no pairable field yet (the builder before
 *  a roster, an empty division) — the owner's first band (a field of up to 8). */
export function swissRoundsDefault(field: number | undefined): number {
  if (field === undefined || !Number.isInteger(field) || field < 2) return SWISS_ROUNDS_BANDS[0]!.rounds;
  return swissRoundsGuidance(field).recommended;
}

/** `rounds` against the field's bounds: refused above the hard maximum, a warning above the safe one, else ok. */
export function judgeSwissRounds(rounds: number, field: number): SwissRoundsJudgement {
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new RangeError(`swiss rounds must be a whole number of at least 1 (got ${String(rounds)})`);
  }
  const guidance = swissRoundsGuidance(field);
  const verdict: SwissRoundsVerdict =
    rounds > guidance.hardMax ? "refuse" : rounds > guidance.safeMax ? "warn" : "ok";
  return { verdict, ...guidance };
}

/** The plural bases (`.one` / `.other` in all four locales) this module says. */
export const SWISS_ROUNDS_PLURAL_KEYS = ["swiss.rounds.guidance", "swiss.rounds.warn", "swiss.rounds.shrunk", "swiss.rounds.shrunkWarn"] as const;
export type SwissRoundsPluralKey = (typeof SWISS_ROUNDS_PLURAL_KEYS)[number];

type Vars = Record<string, string | number>;
/** `useMsgPlural()` satisfies it. Each line is chosen by its count, so a field whose recommendation is 1 says "1 round". */
export type SwissRoundsPlural = (key: SwissRoundsPluralKey, count: number, vars?: Vars) => string;

/**
 * The guidance line under a Rounds box: "For 8 entrants: 3 rounds recommended, at most 7." Null for a field too small
 * to pair — an empty division, or one entrant — where there is nothing honest to recommend. The noun is the desk's
 * "entrants" (a doubles pair or a team is one).
 */
export function swissRoundsGuidanceLine(field: number, plural: SwissRoundsPlural): string | null {
  if (!Number.isInteger(field) || field < 2) return null;
  const g = swissRoundsGuidance(field);
  return plural("swiss.rounds.guidance", g.recommended, { n: field, hardMax: g.hardMax });
}

/**
 * W3 T11 fix round 1 (controller ruling on review m2, "never block a pairable round"): a RUNNING Swiss whose field shrank
 * under its round count. The round being paired is still within the shrunk field's hard maximum, so it is paired; the
 * Swiss can reach at most `hardMax` rounds, and the organiser can finish it after that round or now (`canFinish`, T13).
 * A round beyond `hardMax` is refused (SWISS_ROUNDS_ABOVE_MAX, 409).
 */
export interface SwissRoundsShrunk extends SwissRoundsGuidance {
  verdict: "shrunk";
  rounds: number;
  field: number;
  canFinish: true;
}

/** What a Generate's answer carries (`GenerateOutcome.swiss_rounds`): the safe-max warning, or the shrunk-field warning. */
export type SwissRoundsNotice = (SwissRoundsJudgement & { verdict: "warn" }) | SwissRoundsShrunk;

/** The notice a Generate's answer carries for a pass's judgement: the warn, the shrunk-field warning, or nothing (ok). */
export function swissRoundsNoticeOf(j: SwissRoundsJudgement | SwissRoundsShrunk | null | undefined): SwissRoundsNotice | undefined {
  if (j?.verdict === "shrunk") return j;
  if (j?.verdict === "warn") return { ...j, verdict: "warn" };
  return undefined;
}

/**
 * What the desk says after a Generate that carries `swiss_rounds`, in its amber channel:
 * - `warn` — the round count is above the field's safe maximum: a later round may have no legal pairing, and what
 *   happens then (rulebook §3.2 "allowed, with a plain warning that a round may become unpairable and what happens then
 *   (§3.3)");
 * - `shrunk` — the field of a running Swiss shrank: how many rounds it can still reach, and to finish after that one or
 *   now.
 * Null for every other answer.
 */
export function swissRoundsWarnNotice(
  j: SwissRoundsJudgement | SwissRoundsShrunk | undefined,
  plural: SwissRoundsPlural,
): string | null {
  if (j?.verdict === "shrunk") return plural("swiss.rounds.shrunkWarn", j.hardMax, { field: j.field });
  if (j?.verdict !== "warn") return null;
  return plural("swiss.rounds.warn", j.safeMax, { safeMax: j.safeMax, recommended: j.recommended, hardMax: j.hardMax });
}
