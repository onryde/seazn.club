import { describe, it, expect } from "vitest";
import { assertScorebugSpec } from "../types";

const half = (over: Partial<import("../types").ScorebugHalf> = {}) => ({
  who: [{ name: "A" }], big: "0", ...over,
});

describe("assertScorebugSpec", () => {
  it("accepts a passive spec", () => {
    expect(assertScorebugSpec({ context: "c", phase: "live", halves: [half(), half()], strip: [] })).toEqual([]);
  });
  it("rejects tappable without hint or tapEvent", () => {
    const v = assertScorebugSpec({ context: "c", phase: "live", halves: [half({ tappable: true }), half()], strip: [] });
    expect(v).toContain("halves[0]: tappable requires hint");
    expect(v).toContain("halves[0]: tappable requires tapEvent");
  });
  it("rejects an empty who array", () => {
    // Task 5 follow-up: this branch (types.ts:74, `who must be non-empty`)
    // shipped in Task 1 with no test — a mutant deleting the check
    // survived. Deliberately non-tappable here so the other two checks
    // stay unfired and this assertion is isolated to the one message.
    const v = assertScorebugSpec({
      context: "c",
      phase: "live",
      halves: [{ who: [], big: "0" }, half()],
      strip: [],
    });
    expect(v).toEqual(["halves[0]: who must be non-empty"]);
  });
});
