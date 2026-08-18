// L3/#414 pass 3 / F2: previewDivisionFixtures must size a later stage by the
// progression's REAL count (engine progressionSize), not the old hand-rolled
// qualifierCount that only understood topN/take and silently zeroed
// bestOfRank/combine — masked by a `|| 4` default at the call site, so the
// preview drew a fake 4-entrant bracket regardless of the real spec. Pure,
// no DB.
import { describe, expect, it } from "vitest";
import { previewDivisionFixtures } from "../stages";

describe("previewDivisionFixtures — qualifier sizing (bestNth / multi-rule / roundLosers)", () => {
  it("sizes a bestNth spec by its own count, not the old 4-entrant default", () => {
    const phases = previewDivisionFixtures(
      [
        { kind: "league", name: "League", config: {}, progression: null },
        {
          kind: "knockout",
          name: "KO",
          config: {},
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "bestNth", nth: 3, count: 8 }] }],
            placement: "rank_order",
            timing: "on_complete",
          },
        },
      ],
      16,
    );
    const koPhase = phases[1]!;
    // 8 entrants -> round 1 is Quarter-finals (4 matches); the old (masked)
    // 4-entrant default drew Semi-finals (2 matches) instead.
    expect(koPhase.sections[0]!.title).toBe("Quarter-finals");
    expect(koPhase.sections[0]!.matches).toHaveLength(4);
  });

  it("sizes a multi-rule take[] (2+ TakeRules, ONE source) by the sum of its rules, not the old 4-entrant default", () => {
    const phases = previewDivisionFixtures(
      [
        { kind: "league", name: "League", config: {}, progression: null },
        {
          kind: "knockout",
          name: "KO",
          config: {},
          // Old `combine: [{topN:3}, {bestOfRank:{rank:2,count:5}}]` — now
          // just two TakeRules in one source's take[] (Decision: `combine`
          // doesn't survive as its own wrapper, see progression.ts).
          progression: {
            sources: [
              {
                stage: "previous",
                take: [
                  { kind: "rankRange", from: 1, to: 3 },
                  { kind: "bestNth", nth: 2, count: 5 },
                ],
              },
            ],
            placement: "rank_order",
            timing: "on_complete",
          },
        },
      ],
      16,
    );
    const koPhase = phases[1]!;
    expect(koPhase.sections[0]!.title).toBe("Quarter-finals"); // 3 + 5 = 8 entrants
    expect(koPhase.sections[0]!.matches).toHaveLength(4);
  });

  it("sizes a roundLosers spec by its own count, not the old 4-entrant default", () => {
    const phases = previewDivisionFixtures(
      [
        { kind: "knockout", name: "Main", config: {}, progression: null },
        {
          kind: "knockout",
          name: "Plate",
          config: {},
          // 8, not 4 — the old qualifierCount didn't recognise losersOfRound
          // either (fell through the same `|| 4` default), so a count that
          // happens to equal 4 would pass either way and prove nothing.
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 8 }] }],
            placement: "rank_order",
            timing: "on_complete",
          },
        },
      ],
      16,
    );
    const plate = phases[1]!;
    expect(plate.sections[0]!.title).toBe("Quarter-finals"); // 8 entrants
    expect(plate.sections[0]!.matches).toHaveLength(4);
  });

  it("still sizes a plain rankRange (topN's replacement) spec correctly (regression)", () => {
    const phases = previewDivisionFixtures(
      [
        { kind: "league", name: "League", config: {}, progression: null },
        {
          kind: "knockout",
          name: "KO",
          config: {},
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
            placement: "rank_order",
            timing: "on_complete",
          },
        },
      ],
      16,
    );
    expect(phases[1]!.sections[0]!.matches).toHaveLength(2); // 4 entrants -> Semi-finals
  });
});
