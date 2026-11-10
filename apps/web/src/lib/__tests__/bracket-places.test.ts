// X-TP-3 (rulebook-W4-knockout.md, RB4-T2/T3/T6, X-FR-1): a bracket's places can be SHARED - two semi-final losers both
// 3rd, a joint 1st, a vacant title's 2nd - and the label says so from the RANK the engine stored, never from the row's
// position (C8: a "4th" slot may hold an entrant ranked 3rd). The engine-oracle half (the ranks a real completed
// bracket stores) lives in server/__tests__/shared-place-surfaces.test.ts.
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS } from "@/server/public-site/champion";
import { bracketPlaceLabels, isBracketPlacement } from "../bracket-places";

const rowsOf = (ranks: readonly number[]) => ranks.map((rank, i) => ({ entrantId: `e${i + 1}`, rank }));

describe("bracketPlaceLabels (X-TP-3)", () => {
  it("the empty case first: no rows, no labels", () => {
    expect(bracketPlaceLabels([]).size).toBe(0);
  });

  it("strict ranks: no row is shared", () => {
    const labels = bracketPlaceLabels(rowsOf([1, 2, 3, 4]));
    expect(labels.size).toBe(4);
    for (const [, l] of labels) expect(l.shared).toBe(false);
    expect(labels.get("e3")!.rank).toBe(3);
  });

  it("a shared 3rd (1, 2, 3, 3, 5): both 3rds are shared and carry rank 3, the next row is 5 - differential: today's index numbering said 4 and 5", () => {
    const labels = bracketPlaceLabels(rowsOf([1, 2, 3, 3, 5]));
    expect(labels.size).toBe(5);
    expect([...labels.values()].map((l) => l.rank)).toEqual([1, 2, 3, 3, 5]);
    expect([...labels.values()].map((l) => l.shared)).toEqual([false, false, true, true, false]);
  });

  it("the label reads the stored RANK, not the position in the list (C8: the 4th row holds rank 3)", () => {
    const labels = bracketPlaceLabels([
      { entrantId: "a", rank: 1 },
      { entrantId: "b", rank: 2 },
      { entrantId: "c", rank: 3 },
      { entrantId: "d", rank: 3 },
    ]);
    expect(labels.get("d")).toEqual({ rank: 3, shared: true });
  });

  it("a joint 1st and a vacant title's 2nd are shared places too", () => {
    expect([...bracketPlaceLabels(rowsOf([1, 1, 3, 3, 5])).values()].map((l) => l.shared)).toEqual([true, true, true, true, false]);
    expect([...bracketPlaceLabels(rowsOf([2, 2, 3, 3])).values()].map((l) => l.rank)).toEqual([2, 2, 3, 3]);
  });

  it("an assumption made a guard: a row without a rank throws by name", () => {
    expect(() => bracketPlaceLabels([{ entrantId: "a" }])).toThrow(/without a rank/);
  });

  it("an assumption made a guard: three rows on one rank throw by name (the engine never produces it)", () => {
    expect(() => bracketPlaceLabels(rowsOf([1, 2, 3, 3, 3]))).toThrow(/rank 3 is held by 3/);
  });
});

describe("isBracketPlacement", () => {
  it("is exactly champion.ts's BRACKET_KINDS (counted, > 0)", () => {
    expect(BRACKET_KINDS.size).toBeGreaterThan(0);
    for (const k of BRACKET_KINDS) expect(isBracketPlacement(k), k).toBe(true);
    for (const k of ["league", "groups", "swiss", "americano", "", "unknown"]) expect(isBracketPlacement(k), k).toBe(false);
  });
});
