// THE ONE resolution of an entrant's rest floor, shared by the solver, the
// verifier and the two organiser-facing panels that set it.
//
// `effectiveRestMinutes` in `calendar.ts` is now a thin wrapper over this, and
// deliberately so: the placer/verifier fork is the recurring defect in this
// subsystem (see the header of `build-encode.ts`), and it always arrives as a
// second implementation that looked harmless. A UI that re-derived the MAX
// itself would be exactly that. Whoever wants the number asks here.
//
// This module is a LEAF: it imports nothing, so the browser can pull it through
// `@seazn/engine/scheduling/rest-floor` without dragging the build/repair
// solvers and their zod schemas into the schedule page's client bundle — the
// same reason `grid-step.ts` is a leaf. Anything added here that needs an
// import belongs somewhere else.
//
// It returns the WINNING SOURCE alongside the number. That is the whole point
// of splitting it out. Four separate controls, on two different tabs, can each
// set this floor, and the strictest silently wins; an organiser who lowers the
// one they are looking at and sees nothing change has no way to discover which
// of the other three outranked it. The panels render `source` so the losing
// field can say so out loud.

/** Which input set the floor. `perEntrantMinRest` is also the answer when
 *  nothing is configured at all — the floor is then whatever that field says,
 *  commonly 0. */
export type RestFloorSource =
  | "perEntrantMinRest" // Settings tab — "the shape of the day"
  | "restMin" // Constraints tab — "a rule about entrants"
  | "restByGroup" // a per-pool / per-division override
  | "noBackToBack"; // "at least one whole fixture in between"

/** Structural, not `Pick<SlotConfig, …>`, to keep this module import-free.
 *  `SlotConfig` and `VerifyConfig` are both assignable to it. */
export interface RestFloorInputs {
  perEntrantMinRest: number;
  gapMinutes: number;
  /** Optional because `validateAssignments` is called with configs that carry
   *  no match length. `noBackToBack` is the only source that needs one, and it
   *  is skipped rather than guessed when it is absent. */
  matchMinutes?: number;
  constraints?: {
    restMin?: number;
    restByGroup?: Record<string, number>;
    noBackToBack?: boolean;
  };
}

export interface RestFloor {
  /** Minutes an entrant must rest between two matches. */
  minutes: number;
  /** The input that produced `minutes`. On a tie the EARLIER source in
   *  `RestFloorSource` order wins, because each source only displaces the
   *  running maximum when it is strictly greater — so a `restMin` of 30 that
   *  merely equals a `perEntrantMinRest` of 30 does not claim the credit. */
  source: RestFloorSource;
  /** The `restByGroup` key that won, when `source` is `restByGroup`. */
  groupId?: string;
}

/** The rest an entrant owes between two matches, and which of the four
 *  configurable sources demanded it. MAX across all of them, never precedence
 *  (#459, owner ruling 2026-08-04).
 *
 *  Why MAX: a row can match both a division-keyed and a pool-keyed entry; a
 *  pool entry RAISES the floor and never lowers it, exactly like `restMin` and
 *  `noBackToBack`. Resolving with `??` instead made the pool entry shadow the
 *  division one — and, because `0 ?? x` is `0`, an explicit pool entry of zero
 *  ERASED a division rule rather than adding nothing. Nothing in the UI
 *  presents a pool rest as an override of its division, so "most specific wins"
 *  would have been a semantics no surface teaches. */
export function restFloor(
  config: RestFloorInputs,
  group?: { poolId?: string; divisionId?: string },
): RestFloor {
  const c = config.constraints;
  const out: RestFloor = { minutes: config.perEntrantMinRest, source: "perEntrantMinRest" };

  const raise = (value: number, source: RestFloorSource, groupId?: string): void => {
    if (value <= out.minutes) return;
    out.minutes = value;
    out.source = source;
    if (groupId === undefined) delete out.groupId;
    else out.groupId = groupId;
  };

  if (c?.restMin !== undefined) raise(c.restMin, "restMin");

  for (const key of [group?.poolId, group?.divisionId]) {
    const v = key !== undefined ? c?.restByGroup?.[key] : undefined;
    if (v !== undefined) raise(v, "restByGroup", key);
  }

  // "One fixture between" is only meaningful once we know how long a fixture
  // is; callers that validate without a match length simply don't get it.
  if (c?.noBackToBack === true && config.matchMinutes !== undefined) {
    raise(config.matchMinutes + config.gapMinutes, "noBackToBack");
  }

  return out;
}
