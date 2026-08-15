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
});
