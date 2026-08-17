// L3/#414 pass 3: previewDivisionFixtures must size a later stage by the
// qualification spec's REAL count (engine qualificationSize), not the old
// hand-rolled qualifierCount that only understood topN/take and silently
// zeroed bestOfRank/combine — masked by a `|| 4` default at the call site,
// so the preview drew a fake 4-entrant bracket regardless of the real spec.
// Pure, no DB.
import { describe, expect, it } from "vitest";
import { previewDivisionFixtures } from "../stages";

describe("previewDivisionFixtures — qualifier sizing (bestOfRank / combine / losersOfRound)", () => {
  it("sizes a bestOfRank spec by its own count, not the old 4-entrant default", () => {
    const phases = previewDivisionFixtures(
      [
        { kind: "league", name: "League", config: {}, qualification: null },
        { kind: "knockout", name: "KO", config: {}, qualification: { bestOfRank: { rank: 3, count: 8 } } },
      ],
      16,
    );
    const koPhase = phases[1]!;
    // 8 entrants -> round 1 is Quarter-finals (4 matches); the old (masked)
    // 4-entrant default drew Semi-finals (2 matches) instead.
    expect(koPhase.sections[0]!.title).toBe("Quarter-finals");
    expect(koPhase.sections[0]!.matches).toHaveLength(4);
  });

  it("sizes a combine spec by the sum of its children, not the old 4-entrant default", () => {
    const phases = previewDivisionFixtures(
      [
        { kind: "league", name: "League", config: {}, qualification: null },
        {
          kind: "knockout",
          name: "KO",
          config: {},
          qualification: { combine: [{ topN: 3 }, { bestOfRank: { rank: 2, count: 5 } }] },
        },
      ],
      16,
    );
    const koPhase = phases[1]!;
    expect(koPhase.sections[0]!.title).toBe("Quarter-finals"); // 3 + 5 = 8 entrants
    expect(koPhase.sections[0]!.matches).toHaveLength(4);
  });

  it("sizes a losersOfRound spec by its own count, not the old 4-entrant default", () => {
    const phases = previewDivisionFixtures(
      [
        { kind: "knockout", name: "Main", config: {}, qualification: null },
        {
          kind: "knockout",
          name: "Plate",
          config: {},
          // 8, not 4 — the old qualifierCount didn't recognise losersOfRound
          // either (fell through the same `|| 4` default), so a count that
          // happens to equal 4 would pass either way and prove nothing.
          qualification: { losersOfRound: { round: 1, count: 8 } },
        },
      ],
      16,
    );
    const plate = phases[1]!;
    expect(plate.sections[0]!.title).toBe("Quarter-finals"); // 8 entrants
    expect(plate.sections[0]!.matches).toHaveLength(4);
  });

  it("still sizes a plain topN/take spec correctly (regression)", () => {
    const phases = previewDivisionFixtures(
      [
        { kind: "league", name: "League", config: {}, qualification: null },
        { kind: "knockout", name: "KO", config: {}, qualification: { topN: 4 } },
      ],
      16,
    );
    expect(phases[1]!.sections[0]!.matches).toHaveLength(2); // 4 entrants -> Semi-finals
  });
});
