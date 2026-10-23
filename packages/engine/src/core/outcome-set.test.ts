// W2b (spec §5.1) — THE FIRST W2B TEST, and it pins the outcome set (none did before W2b). Every expected value here
// is the spec's own list (D1, D2), never read back from the code under test.
import { describe, expect, it } from "vitest";
import { AWARD_REASONS, FORFEIT_REASONS, MatchOutcome, OUTCOME_KINDS, advancesNobody, isLevelOutcome } from "./types.ts";

describe("W2b outcome set (spec §5.1)", () => {
  it("X-DW-1: the outcome kinds are exactly win, draw, tie, no_result, award, double_walkover — and MatchOutcome is built from them", () => {
    expect([...OUTCOME_KINDS]).toEqual(["win", "draw", "tie", "no_result", "award", "double_walkover"]);
    expect(MatchOutcome.options.map((o) => o.shape.kind.value)).toEqual([...OUTCOME_KINDS]);
  });
  it("X-RS-1: a forfeit reason is one of four; bye is award-only (system)", () => {
    expect([...FORFEIT_REASONS]).toEqual(["walkover", "retired", "disqualified", "withdrew"]);
    expect([...AWARD_REASONS]).toEqual([...FORFEIT_REASONS, "bye"]);
  });
  it("X-DW-1: advancesNobody — empty case first, then true for double_walkover and for nothing else", () => {
    expect(advancesNobody(null)).toBe(false);
    expect(advancesNobody(undefined)).toBe(false);
    const samples: Record<(typeof OUTCOME_KINDS)[number], unknown> = {
      win: { kind: "win", winner: "H", loser: "A" },
      draw: { kind: "draw" },
      tie: { kind: "tie" },
      no_result: { kind: "no_result" },
      award: { kind: "award", winner: "H", loser: "A", reason: "walkover" },
      double_walkover: { kind: "double_walkover" },
    };
    let checked = 0;
    for (const k of OUTCOME_KINDS) {
      expect(advancesNobody(MatchOutcome.parse(samples[k])), k).toBe(k === "double_walkover");
      checked++;
    }
    expect(checked).toBe(6);
  });
  it("X-WO-1: `method` is declared by the win outcome ALONE (the premise competition/points.ts leans on when it reads `outcome.method`)", () => {
    // `isWalkover` and `forfeitShaped` read `outcome.method` after a `kind === "win"` test, and TypeScript only narrows to the
    // win arm; Task 9 judged the `kind === "win"` tests redundant (points.ts:67 and :73, equivalent mutants; :73 is recorded in
    // stryker-equivalent.json, :67's key also names a killed mutant, so MD-1 left it in the denominator) because no other kind
    // carries a method. This pins that premise from the schema's own shapes: a kind that gains a `method` makes both stale.
    const withMethod = MatchOutcome.options.filter((o) => "method" in o.shape).map((o) => o.shape.kind.value);
    expect(MatchOutcome.options.length, "kinds inspected").toBe(OUTCOME_KINDS.length);
    expect(withMethod).toEqual(["win"]);
  });
  it("X-BR-1: a double walkover is not level — never held, never settleable (f-w2 must #1)", () => {
    expect(isLevelOutcome({ kind: "double_walkover" } as never)).toBe(false);
  });
  it("X-WO-1: award carries winner, loser (null only for a bye) and reason; method and score are gone", () => {
    expect(MatchOutcome.parse({ kind: "award", winner: "H", loser: "A", reason: "retired", method: "x", score: 1 })).toEqual({ kind: "award", winner: "H", loser: "A", reason: "retired" });
    expect(MatchOutcome.parse({ kind: "award", winner: "H", loser: null, reason: "bye" })).toEqual({ kind: "award", winner: "H", loser: null, reason: "bye" });
    expect(MatchOutcome.safeParse({ kind: "award", winner: "H", loser: "A", reason: "no-show" }).success).toBe(false);
  });
  it("X-WO-1: an award's loser is null exactly when it is a bye, and is never the winner (assumptions are guards)", () => {
    // The negative pairs of the positive parses above: a bye that names a loser, a forfeit that names none, and an
    // award against the winner itself are each refused at the schema, so no reader has to guess which side lost.
    expect(MatchOutcome.safeParse({ kind: "award", winner: "H", loser: "A", reason: "bye" }).success).toBe(false);
    expect(MatchOutcome.safeParse({ kind: "award", winner: "H", loser: null, reason: "walkover" }).success).toBe(false);
    expect(MatchOutcome.safeParse({ kind: "award", winner: "H", loser: "H", reason: "retired" }).success).toBe(false);
    let checked = 0;
    for (const reason of FORFEIT_REASONS) {
      expect(MatchOutcome.safeParse({ kind: "award", winner: "H", loser: "A", reason }).success, reason).toBe(true);
      expect(MatchOutcome.safeParse({ kind: "award", winner: "H", loser: null, reason }).success, reason).toBe(false);
      checked++;
    }
    expect(checked).toBe(4);
  });
});
