// THE ONE definition of the schedule grid's step, shared by the solver and the
// board (#datetime-ux prompt 05).
//
// This module is deliberately a LEAF: it imports nothing, so the browser can
// pull it through `@seazn/engine/scheduling/grid-step` without dragging the
// build/repair solvers and their zod schemas into the schedule page's client
// bundle. Anything added here that needs an import belongs somewhere else.
//
// It lives apart from `build-grid.ts` because the frontend has to import the
// SAME function, not a copy of it. It used to import nothing and reimplement
// the rule as `matchMinutes + gapMinutes`, which on a 30/10 board is a
// 40-minute row over a 10-minute lattice: the solver places a match at 09:10,
// the board files it under 09:00, and two starts ten minutes apart draw on top
// of each other. Placer-versus-display drift is this repo's recurring
// scheduling defect; one exported function is the structural fix.

/**
 * The finest step either solver will search, and the coarsest guarantee the
 * board can rely on.
 *
 * It exists twice over. For the solvers it is what makes "on-grid" mean the
 * same thing to both of them. For the board it is what bounds the row count:
 * an unfloored gcd can come out at 1 minute on a coprime board, which is 840
 * rows across an ordinary 08:00-22:00 day; at 5 the worst case is 168.
 *
 * `repair.ts` re-exports this as `REPAIR_GRID_MINUTES`, its historical name.
 */
export const GRID_FLOOR_MINUTES = 5;

/**
 * The grid step, in whole minutes, for a board of `matchMinutes` matches
 * separated by at least `gapMinutes`.
 *
 * The gcd of match and gap length is the coarsest step that can still express
 * every back-to-back placement: on one court a match starts at a multiple of
 * `matchMinutes + gapMinutes`, but around a blackout or an existing booking it
 * starts at that edge, which is a multiple of neither alone. `gapMinutes: 0`
 * is legal and makes the gcd the match length, which is exactly right for a
 * back-to-back court rather than a degenerate case.
 *
 * IT DOES NOT READ ANY REST, AND THAT IS DELIBERATE. Greedy's rest chaining
 * (`lastEnd + rest`) does land off this lattice — `match 30 / gap 10 / rest 35`
 * seeds at +0/+65/+130 against a ten-minute step — but folding the rests into
 * the gcd to fix it collapses the step to `GRID_FLOOR_MINUTES` on every config
 * whose rest is incommensurate with its pitch, which is an ~8x lattice for
 * every board in the system. Measured at the 8 s wall: last improving size
 * 80 -> 20, `canSolveWithin` admitting n<=80 -> n<=20, and three runs of
 * eighteen killed by an uncatchable emscripten OOM inside the WASM. The
 * incumbent is made representable by PINNING it instead (`buildGrid`'s
 * `seedPins`), which costs O(n) slots and only on the boards that need them.
 *
 * The floor, and an ABSOLUTE anchor no duration divides (a `notBefore` at
 * 09:07, a blackout edge on a court greedy did not use), can still leave a seed
 * row the lattice cannot hold. That residue is not silently coarsened away:
 * `build.ts` tests the seed against the finished lattice and reports
 * `not_searched` rather than claiming a proof over a lattice the board is not
 * on.
 *
 * ## Malformed input
 *
 * Both arguments reach this function from a stored JSONB config that predates
 * any schema narrowing, and since prompt 05 they reach it in the BROWSER too.
 * The return is therefore always a finite, positive, whole number of minutes —
 * a board drawn on a coarse axis beats a board that will not draw:
 *
 * - fractional     -> rounded to whole minutes (the lattice is minute-indexed,
 *                     so a sub-minute start is not expressible either side);
 * - `gapMinutes` negative  -> read as 0, i.e. back-to-back, never as a step
 *                     FINER than the board needs;
 * - `matchMinutes` <= 0    -> clamped to 1, so it lands on the floor. `gcd(0, g)`
 *                     is `g`, which would hand back the GAP as a match pitch;
 * - non-finite (`NaN`, `Infinity`) -> the floor. The pre-extraction body
 *                     recursed `gcd(NaN, NaN % NaN)` forever and threw
 *                     `RangeError: Maximum call stack size exceeded`; latent
 *                     while this was engine-only, a downed schedule page once
 *                     the board island started calling it. The floor rather
 *                     than a guess at the pitch, because a config this broken
 *                     gives no basis for claiming a coarser step is safe, and
 *                     the floor is the one step always on the solver's lattice.
 */
export function gridStepMinutes(matchMinutes: number, gapMinutes: number): number {
  if (!Number.isFinite(matchMinutes) || !Number.isFinite(gapMinutes)) return GRID_FLOOR_MINUTES;
  const g = gcd(Math.max(1, Math.round(matchMinutes)), Math.max(0, Math.round(gapMinutes)));
  return Math.max(GRID_FLOOR_MINUTES, g);
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
