// RS006 chassis — step order + generic skip mechanism (pure, no DOM).
//
// steps.ts is written so the SKIP MECHANISM is generic over any step-list
// length (RS006 prompt: "single-open-division competitions collapse step 2
// ... the chassis must support skipping a step"). "details" (step 3) was
// appended below with NO change to nextStepIndex/prevStepIndex — see
// steps.test.ts's "hypothetical" case, which predicted exactly this. A
// later session appending "consent"/"review" needs no change here either.
import type { StepId } from "./types";

/** Design §4: "step 2 collapses when the competition has one open division."
 *
 *  Narrowed (RS007, found by walking the shipped flow): collapse only when
 *  that one division ALSO needs nothing typed or chosen on step 2. For a
 *  team or pair division it does — step 2 is the only place the team/partner
 *  name can be entered, and the only place "sign up solo" can be picked.
 *  Collapsing it on a one-division TEAM competition auto-seeded a nameless
 *  entry (cart.ts's autoSeedSingleDivision hardcodes `team_name: null,
 *  free_agent: false`), walked the captain to Review showing "Unnamed team"
 *  with a live Enter button, and then 422'd on submit with "A team name is
 *  required" — a dead end, since no field to answer it renders anywhere in
 *  the collapsed flow. A single-division competition is the commonest shape
 *  a small club has, so that is the whole public funnel for those orgs.
 *
 *  An unknown kind never collapses: the extra step costs one click, the
 *  wrong collapse costs the entry. */
export function shouldCollapseEntries(
  openDivisionCount: number,
  entrantKind: "team" | "individual" | "pair" | undefined,
): boolean {
  return openDivisionCount === 1 && entrantKind === "individual";
}

/** The step list rendered today. `entries` drops out entirely (not merely
 *  disabled) when collapsed — same "absent, not disabled" convention
 *  RS005's canEdit gating used for a control nobody should see at all.
 *  "details" (step 3 — DETAILS), "consent" (step 4) and "review" (step 5)
 *  always follow, uncollapsed: unlike step 2, the design never skips them
 *  (every cart, however it was built, still needs a roster/form-fields/
 *  consent step and a final review before payment). */
export function buildStepOrder(
  openDivisionCount: number,
  entrantKind: "team" | "individual" | "pair" | undefined,
): StepId[] {
  return shouldCollapseEntries(openDivisionCount, entrantKind)
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

/**
 * Review finding #2 (MEDIUM) — pure decision for the step-change
 * focus-management effect in register-stepper.tsx. goNext/goBack used to
 * only update stepIndex; nothing moved focus, so a screen-reader/keyboard
 * user got no announcement when Back/Next replaced the whole step's
 * content. The fix moves focus to the new step's own heading — but never
 * on the initial mount (RS006 dispatch: "do NOT steal focus on the initial
 * mount — only on an actual transition"), which includes a restored
 * sessionStorage snapshot that lands straight on a later step.
 *
 * No DOM reads or writes here — the effect that owns the ref/`.focus()`
 * call is pinned at the SOURCE level only in
 * register-stepper-interaction.test.tsx (this workspace has no jsdom; same
 * split modal.tsx/modal.test.ts already established for its own focus
 * trap: `nextTrapFocus` there, this function here).
 *
 * `armed` is the effect's OWN ref value from its previous run (starts
 * `false`). The FIRST run where `hydrated` is true — whether that's a
 * fresh visit (stepIndex stays 0) or a restored snapshot that jumps
 * straight to a later step — must not steal focus; it only arms. Every run
 * after that reflects a REAL stepIndex change: once `hydrated` is true it
 * never flips again, so stepIndex is the only remaining thing that can
 * rerun the effect, and nothing but goNext/goBack ever calls setStepIndex
 * post-hydration.
 */
export function stepFocusTransition(hydrated: boolean, armed: boolean): { focus: boolean; armed: boolean } {
  if (!hydrated) return { focus: false, armed };
  if (!armed) return { focus: false, armed: true };
  return { focus: true, armed: true };
}
