// RS006 chassis — step order / single-open-division collapse (pure, no DOM).
// This session builds only "who"/"entries" — steps.ts still needs to prove
// the SKIP MECHANISM is generic (RS006 prompt: "the chassis must support
// skipping a step"), independent of whether steps 3-5 exist yet.
import { describe, expect, it } from "vitest";
import { buildStepOrder, nextStepIndex, prevStepIndex, shouldCollapseEntries } from "../steps";

describe("shouldCollapseEntries", () => {
  it("collapses only when exactly one OPEN division exists", () => {
    expect(shouldCollapseEntries(0)).toBe(false); // nothing open — closed page handles this upstream
    expect(shouldCollapseEntries(1)).toBe(true);
    expect(shouldCollapseEntries(2)).toBe(false);
  });
});

describe("buildStepOrder", () => {
  it("includes entries when 0 or 2+ open divisions exist", () => {
    expect(buildStepOrder(0)).toEqual(["who", "entries"]);
    expect(buildStepOrder(3)).toEqual(["who", "entries"]);
  });

  it("drops entries when exactly one open division exists", () => {
    expect(buildStepOrder(1)).toEqual(["who"]);
  });
});

describe("nextStepIndex / prevStepIndex — generic over ANY step list length", () => {
  it("advances within bounds and returns list.length (one past the end) on the last step", () => {
    const order = buildStepOrder(2); // ["who", "entries"]
    expect(nextStepIndex(0, order)).toBe(1);
    expect(nextStepIndex(1, order)).toBe(2); // past the end — chassis renders the "more soon" end-cap
  });

  it("proves the skip mechanism generically with a longer, hypothetical step list (future sessions append steps 3-5 here)", () => {
    const hypothetical = ["who", "entries", "details", "consent", "review"] as const;
    expect(nextStepIndex(1, hypothetical)).toBe(2);
    expect(nextStepIndex(4, hypothetical)).toBe(5);
  });

  it("prevStepIndex never goes below 0 (no order/length dependence — see its own doc comment)", () => {
    expect(prevStepIndex(1)).toBe(0);
    expect(prevStepIndex(0)).toBe(0);
  });

  it("the collapsed single-step order still round-trips through next/prev without an out-of-range index", () => {
    const order = buildStepOrder(1); // ["who"]
    expect(nextStepIndex(0, order)).toBe(1); // one past the end, same seam as the multi-step case
    expect(prevStepIndex(0)).toBe(0);
  });
});
