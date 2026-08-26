// RS006 chassis — step order + generic skip mechanism (pure, no DOM).
//
// steps.ts is written so the SKIP MECHANISM is generic over any step-list
// length (RS006 prompt: "single-open-division competitions collapse step 2
// ... the chassis must support skipping a step"). "details" (step 3) was
// appended below with NO change to nextStepIndex/prevStepIndex — see
// steps.test.ts's "hypothetical" case, which predicted exactly this. A
// later session appending "consent"/"review" needs no change here either.
import type { StepId } from "./types";

/** Design §4: "step 2 collapses when the competition has one open division." */
export function shouldCollapseEntries(openDivisionCount: number): boolean {
  return openDivisionCount === 1;
}

/** The step list rendered today. `entries` drops out entirely (not merely
 *  disabled) when collapsed — same "absent, not disabled" convention
 *  RS005's canEdit gating used for a control nobody should see at all.
 *  "details" (step 3 — DETAILS), "consent" (step 4) and "review" (step 5)
 *  always follow, uncollapsed: unlike step 2, the design never skips them
 *  (every cart, however it was built, still needs a roster/form-fields/
 *  consent step and a final review before payment). */
export function buildStepOrder(openDivisionCount: number): StepId[] {
  return shouldCollapseEntries(openDivisionCount)
    ? ["who", "details", "consent", "review"]
    : ["who", "entries", "details", "consent", "review"];
}

/**
 * One past the end on the last step, deliberately — the chassis renders a
 * "more steps coming soon" end-cap there rather than pretending steps 3-5
 * exist. A future session that appends real steps to the order list makes
 * that index a real step with NO change here.
 *
 * Generic over the step list's element type ON PURPOSE: this is pure
 * index/length arithmetic that never inspects a step's identity, so it
 * types (and tests — see steps.test.ts's "hypothetical" longer list) over
 * any step-list shape, not just today's 2-element `StepId[]`.
 */
export function nextStepIndex(current: number, order: readonly unknown[]): number {
  return Math.min(current + 1, order.length);
}

/** No `order` parameter, deliberately — going back never depends on the
 *  step list's length, only the floor at 0. Kept as a separate named
 *  function (not just inlined `Math.max(i - 1, 0)` at each call site) so
 *  every "go back" call site reads the same, and a future change to the
 *  back-navigation rule (e.g. skipping a step that becomes invalid) has
 *  one place to land. */
export function prevStepIndex(current: number): number {
  return Math.max(current - 1, 0);
}
