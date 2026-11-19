// W5 Task 12 (X-BD-1, RB5-E4, PO-1): "each pool needs at least 2 entrants", said once.
//
// C38 (generate-tx.ts) refuses a first group draw that leaves an entrant alone in a pool; the division builder's Next and the
// format dialog's Save refuse the same field before anything is sent. Both read THIS function, so the builder and the server
// say the same numbers (`size`) and offer the same count (`suggested`). Pure and client-safe: `apps/web` vitest is node-only.
//
// The pools a seeded snake deals `entrants` into hold floor(entrants / pools) or one more, so the smallest pool is
// floor(entrants / pools). PR B maps the engine's `validatePoolSizes().suggestedPools` onto this.

import { FORMAT_BOUNDS } from "@/lib/format-bounds";

/** The smallest pool a group stage may hold: a pool of one has no match, so its entrant stands in no table (ST-G5). */
export const MIN_POOL_SIZE = 2;

export interface PoolSizeIssue {
  /** The smallest pool the split leaves: floor(entrants / pools). */
  size: number;
  /** The largest pool count <= `pools` that leaves every pool at least `min` strong, or null when no count does. A count under the
   *  pools knob's own minimum (one pool is a League, not a pool count) is no count: null, and every screen says "add entrants". */
  suggested: number | null;
}

/** Whether `entrants` snaked into `pools` leaves a pool under `min`, and the pool count that works instead. Null when the split is fine. */
export function poolSizeIssue(entrants: number, pools: number, min: number = MIN_POOL_SIZE): PoolSizeIssue | null {
  // Assumptions are guards: a count that is not a whole number of pools, a negative field or a minimum under 1 is the caller's bug.
  if (!Number.isInteger(entrants) || entrants < 0) throw new RangeError(`poolSizeIssue: entrants must be a whole number >= 0, got ${entrants}`);
  if (!Number.isInteger(pools) || pools < 1) throw new RangeError(`poolSizeIssue: pools must be a whole number >= 1, got ${pools}`);
  if (!Number.isInteger(min) || min < 1) throw new RangeError(`poolSizeIssue: min must be a whole number >= 1, got ${min}`);
  const size = Math.floor(entrants / pools);
  if (size >= min) return null;
  for (let count = pools - 1; count >= FORMAT_BOUNDS.pools.min; count--) {
    if (Math.floor(entrants / count) >= min) return { size, suggested: count };
  }
  return { size, suggested: null };
}

/** The server's English remedy clause for a refusal (C38's message; the screens say it in the reader's language from `suggested`). */
export function poolRemedy(suggested: number | null): string {
  return suggested === null ? "add entrants" : `use ${suggested} groups or add entrants`;
}
