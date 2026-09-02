/** The per-sport time budget for `gallery.capture.ts`, DERIVED from the pad's
 *  own hold rather than typed in as a literal.
 *
 *  Kept in its own module for one reason: a `test.setTimeout(...)` call inside
 *  a Playwright spec cannot be asserted by the node-environment vitest suite
 *  that guards the rest of this repo, so the arithmetic that matters lives
 *  here where a unit test can reach it, and the spec is left holding only the
 *  call. Same posture as `v3-width-matrix-coverage.ts` beside it — declare the
 *  fact in a module, assert the module, rather than regex the spec's source.
 *
 *  WHY IT IS DERIVED AT ALL (AGENTS.md class 20). Every soft-committed tap
 *  waits out `HOLD_MS` before the next assertion can run. A flat budget beside
 *  that cost is a latent red: it survives only while the constant it ignores
 *  stays small, and it fails as a DATA defect (whatever `expect.poll` happened
 *  to be in flight) rather than as the clock running out.
 *
 *  WHY THE TAP COUNT IS EMPIRICAL, and labelled so rather than dressed up as
 *  a derivation: the harness's per-sport tap count is not statically knowable
 *  (`captureExtra` decides at runtime how many states a sport reaches). This
 *  is therefore sized on the worst sport actually MEASURED — tennis exceeded a
 *  384_000ms budget at HOLD_MS=12_000 on 2026-09-02, so the 24 taps that
 *  budget implied is a known-too-low floor, not a ceiling. Re-measure rather
 *  than nudge if a sport outgrows it.
 */
export const HOLD_BOUND_TAPS = 44;

/** Seconds of slack per tap beyond the hold itself — navigation, the ledger
 *  poll, and the screenshot at three widths. */
export const PER_TAP_SLACK_MS = 1_500;

/** The floor. Never drops below the budget the harness shipped with, so a
 *  short-hold environment (`NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000`, which
 *  `e2e.yml` pins for the seven-width matrix) keeps at least what it had. */
export const BUDGET_FLOOR_MS = 180_000;

/** Fixed overhead: login, org plan flip, fixture seed, teardown. */
export const BUDGET_BASE_MS = 60_000;

/**
 * The budget one `gallery: <sport>` test gets, for a given pad hold.
 *
 * Note this is a CEILING, not a duration — raising it does not slow a sport
 * that finishes early. `ci.yml`'s gallery gate captures football only and
 * sets no `NEXT_PUBLIC_SCOREPAD_HOLD_MS`, so it has always run at the
 * product's 12_000 default; that gate's wall clock is unchanged by this.
 */
export function gallerySportBudgetMs(holdMs: number): number {
  return Math.max(BUDGET_FLOOR_MS, BUDGET_BASE_MS + HOLD_BOUND_TAPS * (holdMs + PER_TAP_SLACK_MS));
}
