// T15-R8 m-2: the per-case drawn-fixture counts behind TRIAGE's P1 rule. The
// DB read itself is driven live (truth-runs/w1drv-l3-fr1/draw-counts.json);
// this pins the arithmetic and every refusal. Sport-independent: a count of
// stored outcomes, keyed by case id.
import { describe, expect, it } from "vitest";
import { DrawCountRefused, bracketKinds, casesOf, competitionName, drawCounts, type StageRow } from "../draw-counts.ts";
import { INVARIANTS } from "../lib/invariants.ts";

const row = (caseId: string, seq: number, kind: string, fixtures: number, drawn: number, competitionId = `c-${caseId}`): StageRow =>
  ({ competition: competitionName(caseId), competitionId, seq, kind, fixtures, drawn });

describe("draw-counts (T15-R8 m-2)", () => {
  // The bracket kinds are I2's declaration; the expected sets below are read from it, never typed.
  const i2 = INVARIANTS.find((i) => i.id.startsWith("I2-"))!.stageKinds as readonly string[];
  const bracket = i2[0]!;
  const table = INVARIANTS.find((i) => i.id.startsWith("I1-"))!.stageKinds as readonly string[];
  const nonBracket = table.find((k) => !i2.includes(k))!;

  it("the bracket kinds are I2's own stageKinds, and a table kind is not one", () => {
    expect(bracketKinds()).toEqual(i2);
    expect(i2.length).toBeGreaterThan(0);
    expect(nonBracket).toBeDefined();
  });

  it("sums every stage's draws, and counts a bracket draw only on an I2 kind — the second case's stage order is restored", () => {
    const cases = new Map([["a|boardgame|blitz|F1", "run-1"], ["b|generic|score|M1", "run-2"]]);
    const rows = [
      row("a|boardgame|blitz|F1", 2, bracket, 7, 1),
      row("a|boardgame|blitz|F1", 1, nonBracket, 9, 2),
      row("b|generic|score|M1", 1, bracket, 0, 0),
      row("someone-else", 1, bracket, 3, 3),
    ];
    const out = drawCounts(cases, rows);
    expect(out.checked).toBe(2);
    expect(out.bracketKinds).toEqual(i2);
    expect(out.cases["a|boardgame|blitz|F1"]).toEqual({
      run: "run-1", drawn: 3, bracketDrawn: 1,
      stages: [{ seq: 1, kind: nonBracket, fixtures: 9, drawn: 2 }, { seq: 2, kind: bracket, fixtures: 7, drawn: 1 }],
    });
    // A stage with no fixture at all (the LEFT JOIN's zero) counts 0, not absent.
    expect(out.cases["b|generic|score|M1"]).toEqual({ run: "run-2", drawn: 0, bracketDrawn: 0, stages: [{ seq: 1, kind: bracket, fixtures: 0, drawn: 0 }] });
    expect(Object.keys(out.cases)).toHaveLength(2);
  });

  it("refuses a case with no competition, a case whose name two competitions share, and zero cases", () => {
    const one = new Map([["x|boardgame|blitz|R4", "run"]]);
    expect(() => drawCounts(one, [])).toThrow(DrawCountRefused);
    expect(() => drawCounts(one, [])).toThrow(/x\|boardgame\|blitz\|R4: 0 competitions named "Matrix x\|boardgame\|blitz\|R4"/);
    expect(() => drawCounts(one, [row("x|boardgame|blitz|R4", 1, bracket, 3, 0, "c1"), row("x|boardgame|blitz|R4", 1, bracket, 3, 1, "c2")])).toThrow(/: 2 competitions named/);
    expect(() => drawCounts(new Map(), [row("x|boardgame|blitz|R4", 1, bracket, 3, 0)])).toThrow(/zero cases to count/);
  });

  it("collects each run's cases, and refuses a case two runs both drove", () => {
    const m = casesOf([{ dir: "r1", caseIds: ["a", "b"] }, { dir: "r2", caseIds: ["c"] }]);
    expect([...m]).toEqual([["a", "r1"], ["b", "r1"], ["c", "r2"]]);
    expect(() => casesOf([{ dir: "r1", caseIds: ["a"] }, { dir: "r2", caseIds: ["a"] }])).toThrow(/a is in r1 and r2/);
  });
});
