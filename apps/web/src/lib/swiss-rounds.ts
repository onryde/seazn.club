// Swiss Playoff — how many qualifying rounds a field of N plays.
//
// Owner's brief was "scale with field size"; this table is the product
// decision that implements it. It is DATA, not a chain of ifs, so the
// catalogue, the generator and the test all read one declaration (a band
// moved here moves every reader with it).
//
// Client-safe on purpose: the format catalogue (config/format-gallery.tsx,
// components/v2/format-templates.ts) and the server generator
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
