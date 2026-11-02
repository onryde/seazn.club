import { describe, expect, it } from "vitest";
import { swissCutDrift } from "@/lib/swiss-cut-drift";

// W3 Task 17 (RB3-19, X-SW-25) — the pure judgement behind the desk warning: who the cut moved. The server reads the
// three inputs (`getSwissCutDrift`, proven on Postgres in swiss-signed-rules-pin.test.ts); this proves what is done with
// them, EMPTY CASE FIRST.

describe("swissCutDrift", () => {
  it("an empty frozen cut has nothing to drift from — null, even when the knockout began and today's top q is not empty", () => {
    expect(swissCutDrift([], [], true)).toBeNull();
    expect(swissCutDrift([], ["a", "b"], true)).toBeNull();
    expect(swissCutDrift([], ["a"], false)).toBeNull();
  });

  it("before the knockout began there is no warning, however far the table moved", () => {
    expect(swissCutDrift(["a", "b", "c"], ["a", "b", "d"], false)).toBeNull();
  });

  it("the same people is no drift — in any order (a re-order inside the cut moves no one across the line)", () => {
    expect(swissCutDrift(["a", "b", "c"], ["a", "b", "c"], true)).toBeNull();
    expect(swissCutDrift(["a", "b", "c"], ["c", "a", "b"], true)).toBeNull();
  });

  it("names who is out and who is in", () => {
    expect(swissCutDrift(["a", "b", "c"], ["a", "b", "d"], true)).toEqual({ out: ["c"], in: ["d"] });
  });

  it("several moving at once: both lists, each in the order handed in", () => {
    expect(swissCutDrift(["a", "b", "c", "d"], ["a", "f", "e", "d"], true)).toEqual({ out: ["b", "c"], in: ["f", "e"] });
  });

  it("nobody coming in is no drift: a table shorter than the cut has no one to name as taking the place", () => {
    expect(swissCutDrift(["a", "b", "c"], ["a", "b"], true)).toBeNull();
    expect(swissCutDrift(["a", "b"], [], true)).toBeNull();
  });

  it("a repeated id is one person", () => {
    expect(swissCutDrift(["a", "a", "b"], ["a", "c", "c"], true)).toEqual({ out: ["b"], in: ["c"] });
  });
});
