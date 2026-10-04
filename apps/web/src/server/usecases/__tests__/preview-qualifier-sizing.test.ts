// L3/#414 pass 3 / F2: previewDivisionFixtures must size a later stage by the
// progression's REAL count (engine progressionSize), not the old hand-rolled
// qualifierCount that only understood topN/take and silently zeroed
// bestOfRank/combine — masked by a `|| 4` default at the call site, so the
// preview drew a fake 4-entrant bracket regardless of the real spec. Pure,
// no DB.
import { describe, expect, it } from "vitest";
import { previewDivisionFixtures } from "../stages";
import { buildTemplateStages } from "@/lib/format-templates";

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

// F3 Task 2b (regression, commit 6351fd2ce): groups_ko switched its take
// from a hand-rolled `picks` interleave to `topNPerGroup` (+ a `bestNth`
// remainder). `progressionSize` deliberately contributes 0 for
// `topNPerGroup` (its own comment: "group-count-dependent; callers with a
// real shape use expandTake instead") — qualifierCount used to read only
// `progressionSize`, so every group+knockout preview fell through the `|| 4`
// guard to a 4-team bracket regardless of the real qualifier count.
describe("previewDivisionFixtures — topNPerGroup sizing is shape-aware (F3 Task 2b)", () => {
  it("sizes a topNPerGroup take by the REAL previous-stage pool count, not progressionSize's deliberate 0", () => {
    const phases = previewDivisionFixtures(
      [
        { kind: "group", name: "Group stage", config: { legs: 1, pools: { count: 4 } }, progression: null },
        {
          kind: "knockout",
          name: "Knockout",
          config: {},
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 4 }] }],
            placement: "snake",
            timing: "setup",
          },
        },
      ],
      16,
    );
    const koPhase = phases[1]!;
    expect(koPhase.sections[0]!.title).toBe("Round of 16");
    expect(koPhase.sections[0]!.matches).toHaveLength(8); // 4 pools x 4 qualifiers/pool = 16 entrants -> 8 first-round matches
  });

  it("sizes a topNPerGroup + bestNth remainder take (6 pools, euro24's shape) to 16, not progressionSize's 4", () => {
    const phases = previewDivisionFixtures(
      [
        { kind: "group", name: "Group stage", config: { legs: 1, pools: { count: 6 } }, progression: null },
        {
          kind: "knockout",
          name: "Knockout",
          config: {},
          progression: {
            sources: [
              {
                stage: "previous",
                take: [
                  { kind: "topNPerGroup", n: 2 },
                  { kind: "bestNth", nth: 3, count: 4 },
                ],
              },
            ],
            placement: "snake",
            timing: "setup",
          },
        },
      ],
      24,
    );
    const koPhase = phases[1]!;
    expect(koPhase.sections[0]!.title).toBe("Round of 16");
    expect(koPhase.sections[0]!.matches).toHaveLength(8); // 12 (topNPerGroup: 2 x 6 pools) + 4 (bestNth) = 16 -> 8 matches
  });

  it("regression: 16 qualifiers across 4 pools must not preview as a 4-team bracket", () => {
    const phases = previewDivisionFixtures(
      [
        { kind: "group", name: "Group stage", config: { legs: 1, pools: { count: 4 } }, progression: null },
        {
          kind: "knockout",
          name: "Knockout",
          config: {},
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 4 }] }],
            placement: "snake",
            timing: "setup",
          },
        },
      ],
      16,
    );
    const koPhase = phases[1]!;
    expect(koPhase.sections[0]!.title).not.toBe("Semi-finals");
    expect(koPhase.sections[0]!.matches).not.toHaveLength(2); // the old, wrong 4-entrant bracket
    expect(koPhase.sections[0]!.matches).toHaveLength(8);
  });
});

// F3 review item 1 (owner-authorised widening) makes multi-source `setup`
// progressions genuinely reachable — progression-multi-source.test.ts builds
// one end to end. Before this fix, qualifierCount read `sources[0]` only
// (comment removed from stages.ts: "previewDivisionFixtures never sees a
// multi-source progression... reading only sources[0] is complete"), so a
// multi-source preview undersized the downstream stage exactly the way
// commit 0ec159e52 fixed for `topNPerGroup` — the "preview that lies" class.
describe("previewDivisionFixtures — multi-source progression sizing (F3 review item 3)", () => {
  it("sums qualifiers across 2+ SOURCES, not sources[0] alone", () => {
    const phases = previewDivisionFixtures(
      [
        { kind: "league", name: "League A", config: {}, progression: null },
        {
          kind: "knockout",
          name: "KO",
          config: {},
          progression: {
            sources: [
              { stage: "previous", take: [{ kind: "rankRange", from: 1, to: 3 }] },
              { stage: { stageId: "other" }, take: [{ kind: "rankRange", from: 1, to: 5 }] },
            ],
            placement: "rank_order",
            timing: "on_complete",
          },
        },
      ],
      16,
    );
    const koPhase = phases[1]!;
    // 3 + 5 = 8 entrants -> Quarter-finals (4 matches). Sources[0] alone
    // would give 3 -> a 4-slot bracket with 1 bye, "Semi-finals", 2 matches.
    expect(koPhase.sections[0]!.title).toBe("Quarter-finals");
    expect(koPhase.sections[0]!.matches).toHaveLength(4);
  });

  it("sums a shape-aware topNPerGroup source together with a plain rankRange source, each sized by its OWN branch", () => {
    const phases = previewDivisionFixtures(
      [
        { kind: "group", name: "Group stage", config: { legs: 1, pools: { count: 4 } }, progression: null },
        {
          kind: "knockout",
          name: "Knockout",
          config: {},
          progression: {
            sources: [
              { stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }, // 2 x 4 pools = 8
              { stage: { stageId: "other" }, take: [{ kind: "rankRange", from: 1, to: 4 }] }, // 4
            ],
            placement: "rank_order",
            timing: "setup",
          },
        },
      ],
      16,
    );
    const koPhase = phases[1]!;
    // 8 + 4 = 12 -> pads to a 16-slot bracket (4 byes), "Round of 16", 8
    // first-round fixtures. The old sources[0]-only read already had a
    // shape-aware branch for THIS source (8), so this pins the SUM is taken
    // across sources, not just that one branch's own correctness.
    expect(koPhase.sections[0]!.title).toBe("Round of 16");
    expect(koPhase.sections[0]!.matches).toHaveLength(8);
  });
});

describe("previewDivisionFixtures — rankRange templates unaffected by the topNPerGroup shape fix", () => {
  it("league_ko, group_stepladder and qualifying_main size exactly as before (unchanged code path: no topNPerGroup in the take)", () => {
    const knobs = { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 };

    const leagueKo = buildTemplateStages("league_ko", knobs);
    const leaguePhases = previewDivisionFixtures(leagueKo, 16);
    expect(leaguePhases[1]!.sections[0]!.title).toBe("Semi-finals");
    expect(leaguePhases[1]!.sections[0]!.matches).toHaveLength(2);

    const qualMain = buildTemplateStages("qualifying_main", knobs);
    const qualPhases = previewDivisionFixtures(qualMain, 16);
    expect(qualPhases[1]!.sections[0]!.title).toBe("Semi-finals");
    expect(qualPhases[1]!.sections[0]!.matches).toHaveLength(2);

    const stepladder = buildTemplateStages("group_stepladder", knobs);
    const stepPhases = previewDivisionFixtures(stepladder, 16);
    const stepMatches = stepPhases[1]!.sections.reduce((n, s) => n + s.matches.length, 0);
    expect(stepMatches).toBe(3); // 4 qualifiers -> k-1 = 3 stepladder games
    expect(stepPhases[1]!.sections.at(-1)!.title).toBe("Final");
  });
});
