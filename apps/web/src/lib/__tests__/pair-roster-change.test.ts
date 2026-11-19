// W5 app PR A, Task 10 (X-RP-2, X-RP-3; RB5-R2, RB5-R3, rulings 282, 290): how a pair's roster edit after play has started is
// judged. The rulebook's two cases are the whole table: a partner LEAVING with nobody joining dissolves the pair (the pair
// withdraws as the entrant, R12b); anyone JOINING is a substitute (R12a, refused). Everything else — the same two people again,
// in any order, with their captain flag or squad number changed — is no change of partners at all.
import { describe, expect, it } from "vitest";
import { classifyPairRosterChange, type PairRosterChange } from "../pair-roster-change";

const cases: { name: string; current: string[]; next: string[]; expected: PairRosterChange }[] = [
  { name: "the same two people", current: ["a", "b"], next: ["a", "b"], expected: "same" },
  { name: "the same two people, other order", current: ["a", "b"], next: ["b", "a"], expected: "same" },
  { name: "an empty roster re-saved empty (the empty case)", current: [], next: [], expected: "same" },
  { name: "one partner dropped", current: ["a", "b"], next: ["a"], expected: "drops" },
  { name: "the other partner dropped", current: ["a", "b"], next: ["b"], expected: "drops" },
  { name: "both dropped", current: ["a", "b"], next: [], expected: "drops" },
  { name: "a partner swapped for a newcomer", current: ["a", "b"], next: ["a", "c"], expected: "substitutes" },
  { name: "both swapped", current: ["a", "b"], next: ["c", "d"], expected: "substitutes" },
  { name: "one partner dropped and another person added in the same edit", current: ["a", "b"], next: ["b", "c"], expected: "substitutes" },
  { name: "a newcomer added to a one-person pair", current: ["a"], next: ["a", "b"], expected: "substitutes" },
  { name: "a first person added to an empty pair", current: [], next: ["a"], expected: "substitutes" },
];

describe("classifyPairRosterChange (R12)", () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(classifyPairRosterChange(c.current, c.next)).toBe(c.expected);
    });
  }
  it("anti-vacuity: every verdict is witnessed by at least one case", () => {
    const seen = new Set(cases.map((c) => c.expected));
    expect([...seen].sort()).toEqual(["drops", "same", "substitutes"]);
  });
});
