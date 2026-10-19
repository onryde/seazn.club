// Owner ruling (1), 2026-10-19, relayed by the coordinator (PR #982 review round 1, item 2's residual): the Result
// card's headline is a MEASURED ladder — the full result sentence, then the same sentence with the winner's short code,
// then that short sentence at the compact headline size, then the highlights give way. Each rung is taken only when the
// one before it does not fit on ONE line.
//
// This file holds the arithmetic (`pickResultRung`) and the rung texts (`resultLadderTexts`). The measurement itself —
// a probe's natural width against the card's content width — needs a browser; gallery check 4c drives it through the
// real result producer in every locale.
import { describe, expect, it } from "vitest";
import { pickResultRung, RESULT_RUNG_NAMES, resultLadderTexts } from "../result-ladder";

describe("pickResultRung — the first rung whose one line fits, else the highlights give way", () => {
  // [full, short, compact] natural widths against 1004 px of content width (the 1100 px card less its 48 px pads).
  const AVAILABLE = 1004;
  const cases: { name: string; widths: [number, number, number]; want: 0 | 1 | 2 | 3 }[] = [
    { name: "the full sentence fits", widths: [900, 400, 300], want: 0 },
    { name: "exactly the width fits (a line of 1004 px in 1004 px does not wrap)", widths: [1004, 400, 300], want: 0 },
    { name: "full one px over: the short sentence", widths: [1005, 400, 300], want: 1 },
    { name: "short at exactly the width", widths: [2000, 1004, 753], want: 1 },
    { name: "short over, compact fits", widths: [2000, 1190, 893], want: 2 },
    { name: "compact at exactly the width", widths: [2000, 1339, 1004], want: 2 },
    { name: "nothing fits on one line: the highlights give way", widths: [2600, 1500, 1125], want: 3 },
    // The ladder reads the rungs in order: a later rung that would fit never jumps the queue past one that does.
    { name: "full fits even though short would too", widths: [1000, 10, 10], want: 0 },
  ];
  it.each(cases)("$name", ({ widths, want }) => {
    expect(pickResultRung(widths, AVAILABLE)).toBe(want);
  });

  it("anti-vacuity: every rung is reached by some case (4 rungs, each at least once)", () => {
    const reached = new Set(cases.map((c) => pickResultRung(c.widths, AVAILABLE)));
    expect([...reached].sort()).toEqual([0, 1, 2, 3]);
    expect(RESULT_RUNG_NAMES).toEqual(["full", "short", "compact", "yield"]);
  });

  it("refuses an unmeasured card or probe by name — a 0 or NaN would otherwise read as 'nothing fits'", () => {
    expect(() => pickResultRung([100, 100, 100], 0)).toThrow(/available/);
    expect(() => pickResultRung([100, 100, 100], Number.NaN)).toThrow(/available/);
    expect(() => pickResultRung([Number.NaN, 100, 100], 1004)).toThrow(/width/);
    expect(() => pickResultRung([100, Number.POSITIVE_INFINITY, 100], 1004)).toThrow(/width/);
  });
});

describe("resultLadderTexts — the full sentence, then the short one twice (the compact rung is a SIZE, not new words)", () => {
  it("a decided result: [result, short, short]", () => {
    expect(resultLadderTexts("Milton Keynes Rovers won by 44 runs", "MIL won by 44 runs")).toEqual([
      "Milton Keynes Rovers won by 44 runs",
      "MIL won by 44 runs",
      "MIL won by 44 runs",
    ]);
  });

  it("no short form (a void with no verdict, the ended fallback): the full text on every rung", () => {
    expect(resultLadderTexts("Match ended", undefined)).toEqual(["Match ended", "Match ended", "Match ended"]);
  });
});
