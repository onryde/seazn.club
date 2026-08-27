// RS006 chassis — step order / single-open-division collapse (pure, no DOM).
// steps.ts proves the SKIP MECHANISM is generic (RS006 prompt: "the chassis
// must support skipping a step") — "details" (step 3) was appended to
// buildStepOrder with NO change to nextStepIndex/prevStepIndex, exactly as
// the older "hypothetical" case below predicted.
import { describe, expect, it } from "vitest";
import { buildStepOrder, nextStepIndex, prevStepIndex, shouldCollapseEntries, stepFocusTransition } from "../steps";

describe("shouldCollapseEntries", () => {
  it("collapses only when exactly one OPEN division exists", () => {
    expect(shouldCollapseEntries(0)).toBe(false); // nothing open — closed page handles this upstream
    expect(shouldCollapseEntries(1)).toBe(true);
    expect(shouldCollapseEntries(2)).toBe(false);
  });
});

describe("buildStepOrder", () => {
  it("includes entries when 0 or 2+ open divisions exist, followed by consent and review", () => {
    expect(buildStepOrder(0)).toEqual(["who", "entries", "details", "consent", "review"]);
    expect(buildStepOrder(3)).toEqual(["who", "entries", "details", "consent", "review"]);
  });

  it("drops entries (but NOT details/consent/review) when exactly one open division exists", () => {
    expect(buildStepOrder(1)).toEqual(["who", "details", "consent", "review"]);
  });
});

describe("nextStepIndex / prevStepIndex — generic over ANY step list length", () => {
  it("advances within bounds and returns list.length (one past the end) on the last step", () => {
    const order = buildStepOrder(2); // ["who", "entries", "details"]
    expect(nextStepIndex(0, order)).toBe(1);
    expect(nextStepIndex(1, order)).toBe(2);
    expect(nextStepIndex(2, order)).toBe(3); // past the end — chassis renders the "more soon" end-cap
  });

  it("proves the skip mechanism generically with a longer, hypothetical step list (future sessions append steps 4-5 here)", () => {
    const hypothetical = ["who", "entries", "details", "consent", "review"] as const;
    expect(nextStepIndex(1, hypothetical)).toBe(2);
    expect(nextStepIndex(4, hypothetical)).toBe(5);
  });

  it("prevStepIndex never goes below 0 (no order/length dependence — see its own doc comment)", () => {
    expect(prevStepIndex(1)).toBe(0);
    expect(prevStepIndex(0)).toBe(0);
  });

  it("the collapsed step order still round-trips through next/prev without an out-of-range index", () => {
    const order = buildStepOrder(1); // ["who", "details"]
    expect(nextStepIndex(0, order)).toBe(1);
    expect(nextStepIndex(1, order)).toBe(2); // one past the end, same seam as the multi-step case
    expect(prevStepIndex(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Review finding #2 (MEDIUM) — focus management across step transitions.
// register-stepper.tsx's goNext/goBack only updated stepIndex; nothing
// moved focus, so a screen-reader/keyboard user got no announcement when
// Back/Next replaced the whole step's content. The fix moves focus to the
// new step's own heading (tabIndex={-1}) on a real transition only — never
// on the initial mount, including a restored snapshot that lands straight
// on a later step.
//
// This workspace has no jsdom (_hook-harness.tsx's own header), so the
// actual `.focus()` DOM call is not unit-testable — split the same way
// modal.tsx/modal.test.ts already did for the modal focus trap: the
// DECISION (should THIS effect run move focus) is pure, no DOM, real
// behavioural tests here; the ref/effect wiring that calls it is pinned at
// the source level in register-stepper-interaction.test.tsx.
// ---------------------------------------------------------------------------

describe("stepFocusTransition — pure step-change focus decision, no DOM", () => {
  it("never focuses before hydration has settled, regardless of the armed flag", () => {
    expect(stepFocusTransition(false, false)).toEqual({ focus: false, armed: false });
    expect(stepFocusTransition(false, true)).toEqual({ focus: false, armed: true });
  });

  it("the FIRST hydrated run arms but does not focus — covers both a fresh mount (stepIndex stays 0) and a restored snapshot that lands straight on a later step: neither is a real transition", () => {
    expect(stepFocusTransition(true, false)).toEqual({ focus: false, armed: true });
  });

  it("every run after arming focuses — once hydrated, stepIndex is the only thing left that can rerun this effect, and only goNext/goBack change it", () => {
    expect(stepFocusTransition(true, true)).toEqual({ focus: true, armed: true });
  });

  it("armed never regresses to false once hydrated — repeated transitions keep focusing", () => {
    let state = stepFocusTransition(true, false); // mount/restore settles
    expect(state).toEqual({ focus: false, armed: true });
    state = stepFocusTransition(true, state.armed); // goNext
    expect(state).toEqual({ focus: true, armed: true });
    state = stepFocusTransition(true, state.armed); // goBack
    expect(state).toEqual({ focus: true, armed: true });
  });
});
