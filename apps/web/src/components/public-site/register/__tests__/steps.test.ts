// RS006 chassis — step order / single-open-division collapse (pure, no DOM).
// steps.ts proves the SKIP MECHANISM is generic (RS006 prompt: "the chassis
// must support skipping a step") — "details" (step 3) was appended to
// buildStepOrder with NO change to nextStepIndex/prevStepIndex, exactly as
// the older "hypothetical" case below predicted.
import { describe, expect, it } from "vitest";
import { buildStepOrder, nextStepIndex, offersJoinCode, prevStepIndex, sharedClosesAt, shouldCollapseEntries, stepFocusTransition } from "../steps";

describe("shouldCollapseEntries", () => {
  it("collapses only when exactly one OPEN division exists AND it needs nothing typed", () => {
    expect(shouldCollapseEntries(0, "individual")).toBe(false); // nothing open — closed page handles this upstream
    expect(shouldCollapseEntries(1, "individual")).toBe(true);
    expect(shouldCollapseEntries(2, "individual")).toBe(false);
  });

  // These two used to read `shouldCollapseEntries(1) === true` for EVERY
  // entrant kind, which froze a defect rather than describing a rule: step 2
  // is the only place a team name can be typed and the only place "sign up
  // solo" can be chosen, so collapsing it on a one-division TEAM competition
  // left the captain at Review with an entry the UI itself labels "Unnamed
  // team", a live Enter button, and a 422 "A team name is required" on submit
  // — with no field anywhere in the flow to answer it. Inverted, not deleted.
  it("never collapses a team division — step 2 owns the team name and the solo choice", () => {
    expect(shouldCollapseEntries(1, "team")).toBe(false);
  });

  it("never collapses a pair division — step 2 owns the partner name", () => {
    expect(shouldCollapseEntries(1, "pair")).toBe(false);
  });

  it("does not collapse when the entrant kind is unknown", () => {
    expect(shouldCollapseEntries(1, undefined)).toBe(false);
  });
});

describe("buildStepOrder", () => {
  it("includes entries when 0 or 2+ open divisions exist, followed by consent and review", () => {
    expect(buildStepOrder(0, "individual")).toEqual(["who", "entries", "details", "consent", "review"]);
    expect(buildStepOrder(3, "individual")).toEqual(["who", "entries", "details", "consent", "review"]);
  });

  it("drops entries (but NOT details/consent/review) for one open INDIVIDUAL division", () => {
    expect(buildStepOrder(1, "individual")).toEqual(["who", "details", "consent", "review"]);
  });

  it("keeps entries for one open team or pair division", () => {
    expect(buildStepOrder(1, "team")).toEqual(["who", "entries", "details", "consent", "review"]);
    expect(buildStepOrder(1, "pair")).toEqual(["who", "entries", "details", "consent", "review"]);
  });
});

describe("nextStepIndex / prevStepIndex — generic over ANY step list length", () => {
  it("advances within bounds and returns list.length (one past the end) on the last step", () => {
    const order = buildStepOrder(2, "individual"); // ["who", "entries", "details"]
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
    const order = buildStepOrder(1, "individual"); // ["who", "details"]
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

describe("offersJoinCode (polish wave H)", () => {
  it("the empty case: no divisions offer no door", () => {
    expect(offersJoinCode([])).toBe(false);
  });

  it("one open team or pair division among individual ones is enough; closed ones never count", () => {
    const ind = { open: true, entrant_kind: "individual" as const };
    expect(offersJoinCode([ind, { open: true, entrant_kind: "pair" }])).toBe(true);
    expect(offersJoinCode([{ open: true, entrant_kind: "team" }, ind])).toBe(true);
    expect(offersJoinCode([ind, { open: false, entrant_kind: "team" }, { open: false, entrant_kind: "pair" }])).toBe(false);
  });
});

// Registration redesign B2 T7 (spec FP10) — the page heading's closing line. Closing time is per DIVISION
// (`registration_settings.closes_at`); the competition has none, so the heading may say "Registration closes X" only when every
// OPEN division closes at the same instant. Empty case first: no open division answers "none", the same as a disagreement.
describe("sharedClosesAt", () => {
  const IN_NOV = "2026-11-30T23:59:00.000Z";
  const IN_DEC = "2026-12-14T23:59:00.000Z";
  const open = (closes_at: string | null) => ({ open: true, closes_at });
  const closed = (closes_at: string | null) => ({ open: false, closes_at });

  it("the empty case: no divisions, and no OPEN division, have no shared closing time", () => {
    expect(sharedClosesAt([])).toBeNull();
    expect(sharedClosesAt([closed(IN_NOV), closed(IN_NOV)])).toBeNull();
  });

  it("one open division with a closing time: that time", () => {
    expect(sharedClosesAt([open(IN_NOV)])).toBe(IN_NOV);
  });

  it("open divisions that agree: the common time", () => {
    expect(sharedClosesAt([open(IN_NOV), open(IN_NOV), open(IN_NOV)])).toBe(IN_NOV);
  });

  it("the same instant written two ways still agrees (a string compare would hide the line for no reason)", () => {
    expect(sharedClosesAt([open("2026-11-30T23:59:00.000Z"), open("2026-12-01T00:59:00.000+01:00")])).toBe("2026-11-30T23:59:00.000Z");
  });

  it("open divisions that differ: null, whichever order they come in", () => {
    expect(sharedClosesAt([open(IN_NOV), open(IN_DEC)])).toBeNull();
    expect(sharedClosesAt([open(IN_DEC), open(IN_NOV)])).toBeNull();
    expect(sharedClosesAt([open(IN_NOV), open(IN_NOV), open(IN_DEC)])).toBeNull();
  });

  it("a division with no closing time never closes, so a line naming a time would be false for it: null", () => {
    expect(sharedClosesAt([open(null)])).toBeNull();
    expect(sharedClosesAt([open(null), open(null)])).toBeNull();
    expect(sharedClosesAt([open(IN_NOV), open(null)])).toBeNull();
    expect(sharedClosesAt([open(null), open(IN_NOV)])).toBeNull();
  });

  it("closed divisions do not vote — only the ones a person can still enter count", () => {
    expect(sharedClosesAt([open(IN_NOV), closed(IN_DEC)])).toBe(IN_NOV);
    expect(sharedClosesAt([closed(null), open(IN_NOV), closed(IN_DEC), open(IN_NOV)])).toBe(IN_NOV);
  });

  it("an unreadable closing time is never shared (not even with itself)", () => {
    expect(sharedClosesAt([open("not a date")])).toBeNull();
    expect(sharedClosesAt([open("not a date"), open("not a date")])).toBeNull();
  });
});
