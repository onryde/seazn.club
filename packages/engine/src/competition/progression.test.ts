// The unified progression field (F2). Supersedes qualification.test.ts and
// stage-seeding.ts's expandTake/placeDescriptors tests — see this repo's F2
// plan (docs/superpowers/plans/2026-08-17-f2-unified-progression-field.md)
// for the union table and the Decisions this module encodes.
import { describe, expect, it } from "vitest";
import type { StandingsDelta } from "../core/types.ts";
import { EngineError } from "../core/errors.ts";
import {
  descriptorKey,
  descriptorLabel,
  expandSources,
  expandTake,
  placeDescriptors,
  placementTable,
  progressionSize,
  resolveProgression,
  type ProgressionSource,
  type ProgressionSpec,
  type SourceShape,
  type SourceTables,
  type TakeRule,
} from "./progression.ts";
import { foldResults, type FixtureResult, type StandingsRow } from "./standings.ts";
import { rankStandings } from "./tiebreakers.ts";

const GROUPED: SourceShape = { poolKeys: ["A", "B"] };
const UNGROUPED: SourceShape = { poolKeys: [] };

describe("expandTake", () => {
  it("rankRange expands to one pot, one descriptor per rank — the topN replacement", () => {
    const take: TakeRule[] = [{ kind: "rankRange", from: 1, to: 3 }];
    expect(expandTake(take, UNGROUPED)).toEqual([
      [
        { kind: "rank_range", rank: 1 },
        { kind: "rank_range", rank: 2 },
        { kind: "rank_range", rank: 3 },
      ],
    ]);
  });

  it("topNPerGroup expands wave-major across the source's real pool count", () => {
    const take: TakeRule[] = [{ kind: "topNPerGroup", n: 2 }];
    expect(expandTake(take, GROUPED)).toEqual([
      [
        { kind: "group_rank", pool: "A", rank: 1 },
        { kind: "group_rank", pool: "B", rank: 1 },
      ],
      [
        { kind: "group_rank", pool: "A", rank: 2 },
        { kind: "group_rank", pool: "B", rank: 2 },
      ],
    ]);
  });

  it("bestNth carries normaliseUnequalPools onto every emitted descriptor", () => {
    const take: TakeRule[] = [{ kind: "bestNth", nth: 3, count: 2, normaliseUnequalPools: true }];
    expect(expandTake(take, GROUPED)).toEqual([
      [
        { kind: "best_nth", nth: 3, position: 1, normaliseUnequalPools: true },
        { kind: "best_nth", nth: 3, position: 2, normaliseUnequalPools: true },
      ],
    ]);
  });

  it("picks expands to one singleton pot PER pick, in declaration order — never reordered", () => {
    // Declaration order is data (gotcha carried forward verbatim): each pick
    // is its own pot so placement:"snake" (a 1-element pot reversed is
    // itself) can never silently reorder a literal enumeration.
    const take: TakeRule[] = [{ kind: "picks", picks: [{ pool: "B", rank: 1 }, { pool: "A", rank: 1 }] }];
    expect(expandTake(take, GROUPED)).toEqual([
      [{ kind: "group_rank", pool: "B", rank: 1 }],
      [{ kind: "group_rank", pool: "A", rank: 1 }],
    ]);
  });

  it("roundLosers expands to one pot of round_loser descriptors, sized by count (design's closing note — L3/#414's bracket->plate can pre-generate like any other take rule)", () => {
    const take: TakeRule[] = [{ kind: "roundLosers", round: 1, count: 4 }];
    expect(expandTake(take, UNGROUPED)).toEqual([
      [
        { kind: "round_loser", round: 1, position: 1 },
        { kind: "round_loser", round: 1, position: 2 },
        { kind: "round_loser", round: 1, position: 3 },
        { kind: "round_loser", round: 1, position: 4 },
      ],
    ]);
  });
});

describe("expandSources", () => {
  it("tags every descriptor with its source index, in source declaration order", () => {
    const sources: ProgressionSource[] = [
      { stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] },
      { stage: { stageId: "s1" }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
    ];
    const shapeOf = () => UNGROUPED;
    const pots = expandSources(sources, shapeOf);
    expect(pots).toEqual([
      [
        { sourceIndex: 0, descriptor: { kind: "rank_range", rank: 1 } },
        { sourceIndex: 0, descriptor: { kind: "rank_range", rank: 2 } },
      ],
      [{ sourceIndex: 1, descriptor: { kind: "rank_range", rank: 1 } }],
    ]);
  });
});

describe("placeDescriptors", () => {
  it("rank_order flattens pots in declaration order (single-source, unchanged from stage-seeding.ts)", () => {
    const pots = expandSources(
      [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
      () => GROUPED,
    );
    const placed = placeDescriptors(pots, "rank_order");
    expect(placed.map((s) => s.descriptor)).toEqual([
      { kind: "group_rank", pool: "A", rank: 1 },
      { kind: "group_rank", pool: "B", rank: 1 },
      { kind: "group_rank", pool: "A", rank: 2 },
      { kind: "group_rank", pool: "B", rank: 2 },
    ]);
  });

  it("snake reverses every other pot (World Cup convention, unchanged)", () => {
    const pots = expandSources(
      [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
      () => GROUPED,
    );
    const placed = placeDescriptors(pots, "snake");
    expect(placed.map((s) => s.descriptor)).toEqual([
      { kind: "group_rank", pool: "A", rank: 1 },
      { kind: "group_rank", pool: "B", rank: 1 },
      { kind: "group_rank", pool: "B", rank: 2 },
      { kind: "group_rank", pool: "A", rank: 2 },
    ]);
  });

  it("seeded_map overrides named seats, fills the rest in relative order — the euro24 shape", () => {
    const pots = expandSources(
      [
        {
          stage: "previous",
          take: [
            { kind: "topNPerGroup", n: 1 },
            { kind: "bestNth", nth: 3, count: 2 },
          ],
        },
      ],
      () => ({ poolKeys: ["A", "B", "C", "D"] }),
    );
    const placed = placeDescriptors(pots, "seeded_map", [
      { slot: "5", source: "best:2" },
      { slot: "6", source: "best:1" },
    ]);
    expect(placed[4]!.descriptor).toEqual({ kind: "best_nth", nth: 3, position: 2 });
    expect(placed[5]!.descriptor).toEqual({ kind: "best_nth", nth: 3, position: 1 });
    // unclaimed seats (the four group winners) fill 1..4 in their own order
    expect(placed[0]!.descriptor).toEqual({ kind: "group_rank", pool: "A", rank: 1 });
  });

  it("seeded_map still 422s on an out-of-range slot or an unknown source (carried verbatim)", () => {
    const pots = expandSources(
      [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
      () => UNGROUPED,
    );
    expect(() => placeDescriptors(pots, "seeded_map", [{ slot: "9", source: "rank:1" }])).toThrow(
      /outside the 1\.\.2 seed range/,
    );
    expect(() => placeDescriptors(pots, "seeded_map", [{ slot: "1", source: "nope" }])).toThrow(
      /does not match any qualifier/,
    );
  });
});

describe("descriptorKey / descriptorLabel", () => {
  it("round_loser gets its own key and i18n pattern ref", () => {
    const d: import("./progression.ts").SlotDescriptor = { kind: "round_loser", round: 1, position: 3 };
    expect(descriptorKey(d)).toBe("loser:1:3");
    expect(descriptorLabel(d)).toEqual({ key: "slot.round_loser", params: { round: 1, n: 3 } });
  });
});

describe("resolveProgression", () => {
  const leagueTable = (ranked: string[]): SourceTables => ({
    pools: [{ pool: "", rows: ranked.map((entrantId, i) => ({ entrantId, rank: i + 1 }) as StandingsRow) }],
  });

  it("resolves rankRange against a single source — the topN replacement, same answer", () => {
    const spec: ProgressionSpec = {
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
      placement: "rank_order",
    };
    const { qualifiers } = resolveProgression(spec, [{ poolKeys: [] }], [leagueTable(["e1", "e2", "e3"])]);
    expect(qualifiers.map((q) => q.entrantId)).toEqual(["e1", "e2"]);
  });

  it("resolves multi-source, in source declaration order, and dedupes across them", () => {
    // The capability the design calls the axis seeding lacks, and Finding 1
    // establishes never actually worked server-side before this module.
    const spec: ProgressionSpec = {
      sources: [
        { stage: "previous", take: [{ kind: "rankRange", from: 1, to: 1 }] },
        { stage: { stageId: "s0" }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
      ],
      placement: "rank_order",
    };
    const { qualifiers } = resolveProgression(
      spec,
      [{ poolKeys: [] }, { poolKeys: [] }],
      [leagueTable(["e1", "e2"]), leagueTable(["e3", "e4"])],
    );
    expect(qualifiers.map((q) => q.entrantId)).toEqual(["e1", "e3"]);
  });

  it("rejects an entrant qualifying through two sources, with a code", () => {
    const spec: ProgressionSpec = {
      sources: [
        { stage: "previous", take: [{ kind: "rankRange", from: 1, to: 1 }] },
        { stage: { stageId: "s0" }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
      ],
      placement: "rank_order",
    };
    expect(() =>
      resolveProgression(
        spec,
        [{ poolKeys: [] }, { poolKeys: [] }],
        [leagueTable(["e1"]), leagueTable(["e1"])],
      ),
    ).toThrow(/qualifies through more than one/);
    try {
      resolveProgression(spec, [{ poolKeys: [] }, { poolKeys: [] }], [leagueTable(["e1"]), leagueTable(["e1"])]);
    } catch (err) {
      expect(EngineError.is(err, "QUALIFICATION_INVALID")).toBe(true);
    }
  });

  it("bestNth refuses unequal pool sizes by default (carried from stage-seeding.ts, never silently ranks raw stats)", () => {
    const tables: SourceTables = {
      pools: [
        { pool: "A", rows: [{ entrantId: "a1", rank: 1 }, { entrantId: "a2", rank: 2 }] as StandingsRow[] },
        { pool: "B", rows: [{ entrantId: "b1", rank: 1 }, { entrantId: "b2", rank: 2 }, { entrantId: "b3", rank: 3 }] as StandingsRow[] },
      ],
    };
    const spec: ProgressionSpec = {
      sources: [{ stage: "previous", take: [{ kind: "bestNth", nth: 2, count: 2 }] }],
      placement: "rank_order",
    };
    expect(() => resolveProgression(spec, [{ poolKeys: ["A", "B"] }], [tables])).toThrow(
      /cannot compare rank-2 finishers across pools of different sizes/,
    );
  });

  it("bestNth with normaliseUnequalPools:true silences the refusal — Decision 2b, absorbed not newly wired", () => {
    const tables: SourceTables = {
      pools: [
        { pool: "A", rows: [{ entrantId: "a1", rank: 1 }, { entrantId: "a2", rank: 2 }] as StandingsRow[] },
        { pool: "B", rows: [{ entrantId: "b1", rank: 1 }, { entrantId: "b2", rank: 2 }, { entrantId: "b3", rank: 3 }] as StandingsRow[] },
      ],
    };
    const spec: ProgressionSpec = {
      sources: [
        { stage: "previous", take: [{ kind: "bestNth", nth: 2, count: 2, normaliseUnequalPools: true }] },
      ],
      placement: "rank_order",
    };
    const { qualifiers } = resolveProgression(spec, [{ poolKeys: ["A", "B"] }], [tables]);
    expect(qualifiers).toHaveLength(2);
  });

  it("roundLosers reads the source's bracket, equality-filters by round, never sorts by it (sparse round numbering)", () => {
    const tables: SourceTables = {
      pools: [],
      bracket: [
        { round: 1, loser: "l1" },
        { round: 1, loser: "l2" },
        { round: 2, loser: "l3" },
      ],
    };
    const spec: ProgressionSpec = {
      sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 2 }] }],
      placement: "rank_order",
    };
    const { qualifiers } = resolveProgression(spec, [{ poolKeys: [] }], [tables]);
    expect(qualifiers.map((q) => q.entrantId)).toEqual(["l1", "l2"]);
  });

  it("flags a tie instead of silently ordering it — never trusts the deterministic seed/id fallback", () => {
    const tied = [
      { entrantId: "a", rank: 1 },
      { entrantId: "b", rank: 1, tieUnbroken: true, tieBreak: { key: "seed", with: ["c"] } },
      { entrantId: "c", rank: 1, tieUnbroken: true, tieBreak: { key: "seed", with: ["b"] } },
    ] as StandingsRow[];
    const spec: ProgressionSpec = {
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 1 }] }],
      placement: "rank_order",
    };
    const { ties } = resolveProgression(spec, [{ poolKeys: [] }], [{ pools: [{ pool: "", rows: tied }] }]);
    expect(ties).toHaveLength(0); // the resolver never even reaches b/c: rank 1's row (a) already answers rankRange{1,1}
  });

  // F2 Task 6 review (defect 2): the test above proves only that `ties`
  // stays EMPTY — the tied rows are never actually reached, so it cannot
  // tell a working tie-flag branch from a broken one. This test takes
  // rankRange{1,2} so the resolver visits BOTH rank 1 (untied) and rank 2
  // (a real, populated tie), and asserts the actual flagged shape.
  it("flags a tie for real when the resolver actually reaches a tied row — not just proves ties stays empty", () => {
    const tied = [
      { entrantId: "a", rank: 1 },
      { entrantId: "b", rank: 2, tieUnbroken: true, tieBreak: { key: "seed", with: ["c"] } },
      { entrantId: "c", rank: 3, tieUnbroken: true, tieBreak: { key: "seed", with: ["b"] } },
    ] as StandingsRow[];
    const spec: ProgressionSpec = {
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
      placement: "rank_order",
    };
    const { qualifiers, ties } = resolveProgression(spec, [{ poolKeys: [] }], [
      { pools: [{ pool: "", rows: tied }] },
    ]);
    expect(qualifiers.map((q) => q.entrantId)).toEqual(["a", "b"]);
    expect(ties).toHaveLength(1);
    expect(ties[0]).toEqual({
      descriptors: [{ kind: "rank_range", rank: 2 }],
      entrantIds: ["b", "c"],
      reason: "seed",
    });
  });

  // F2 Task 6 review (defect 3): euro24's real shape — topNPerGroup +
  // bestNth TOGETHER in ONE source's take[] (the old CombinedQualification
  // within a single spec). Every existing test above exercises either a
  // single take rule, or ordering multiple rules via placeDescriptors on
  // bare descriptors (progression.ts's own test file) — nothing resolves
  // (dedupes, reads real entrant ids for) 2+ take rules through
  // resolveProgression itself. Two pools, both rules pull from BOTH pools,
  // so a dedupe bug (an entrant counted twice) would surface as a thrown
  // QUALIFICATION_INVALID or a wrong qualifier count, not silently pass.
  it("resolves 2+ take rules in ONE source — euro24's real shape (topNPerGroup + bestNth together)", () => {
    const tables: SourceTables = {
      pools: [
        {
          pool: "A",
          rows: [
            { entrantId: "A1", rank: 1 },
            { entrantId: "A2", rank: 2 },
            { entrantId: "A3", rank: 3, points: 0 },
          ] as StandingsRow[],
        },
        {
          pool: "B",
          rows: [
            { entrantId: "B1", rank: 1 },
            { entrantId: "B2", rank: 2 },
            { entrantId: "B3", rank: 3, points: 3 },
          ] as StandingsRow[],
        },
      ],
    };
    const spec: ProgressionSpec = {
      sources: [
        {
          stage: "previous",
          take: [
            { kind: "topNPerGroup", n: 1 },
            { kind: "bestNth", nth: 3, count: 2 },
          ],
        },
      ],
      placement: "rank_order",
    };
    const { qualifiers } = resolveProgression(spec, [{ poolKeys: ["A", "B"] }], [tables]);
    // topNPerGroup's pot (both pools' winners) comes first, in pool-key
    // order; bestNth's pot (both pools' 3rd place, cross-group ranked by
    // points — B3 has more) comes second. All 4 distinct — no dedupe
    // collision, and every entrant resolved for real (not just ordered).
    expect(qualifiers.map((q) => q.entrantId)).toEqual(["A1", "B1", "B3", "A3"]);
  });

  // F2 Task 6 review (defect 4): `rankRange` replaced `topN`, whose old
  // message told an organiser what to DO. Pins the restored message and its
  // data payload so a future regression here is a red test, not a
  // rediscovery.
  it("a rankRange shortfall names the available count and tells the organiser what to do (topN's regressed UX, restored)", () => {
    const spec: ProgressionSpec = {
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 3 }] }],
      placement: "rank_order",
    };
    const tables: SourceTables = { pools: [{ pool: "", rows: [{ entrantId: "e1", rank: 1 }] as StandingsRow[] }] };
    expect(() => resolveProgression(spec, [{ poolKeys: [] }], [tables])).toThrow(
      /the previous stage takes rank 2, but only 1 entrant is available — lower the qualifier count or add entrants/,
    );
    try {
      resolveProgression(spec, [{ poolKeys: [] }], [tables]);
    } catch (err) {
      expect(EngineError.is(err, "STAGE_NOT_READY")).toBe(true);
      expect((err as EngineError).data).toEqual({ pool: "", rank: 2, available: 1 });
    }
  });

  it("picks resolve positionally, never resorted — declaration order IS seed order", () => {
    const tables: SourceTables = {
      pools: [
        { pool: "A", rows: [{ entrantId: "a1", rank: 1 }] as StandingsRow[] },
        { pool: "B", rows: [{ entrantId: "b1", rank: 1 }] as StandingsRow[] },
      ],
    };
    const spec: ProgressionSpec = {
      sources: [
        {
          stage: "previous",
          take: [{ kind: "picks", picks: [{ pool: "B", rank: 1 }, { pool: "A", rank: 1 }] }],
        },
      ],
      placement: "rank_order",
    };
    const { qualifiers } = resolveProgression(spec, [{ poolKeys: ["A", "B"] }], [tables]);
    expect(qualifiers.map((q) => q.entrantId)).toEqual(["b1", "a1"]);
  });

  // --- Beyond the plan's given tests: two gaps found while re-verifying the
  // plan against this repo's ACTUAL testkit/simulation.ts and stage.ts,
  // neither covered by the tests above. ---

  it("resolves rankRange against a single pool regardless of its key name, not only \"\" — the group_knockout poolCount===1 shape (poolId \"P1\", built by testkit/simulation.ts's playRoundRobinStage, and completeTableStage's real output for any single-pool table stage)", () => {
    // The old qualification.ts's isTopN fell back to `pools[0].rows` whenever
    // `pools.length === 1`, REGARDLESS of that pool's key — `.overall` (set
    // by completeTableStage exactly when single===true) only ever short-
    // circuited that same fallback, never added a case it didn't cover
    // (grep confirms .overall is written only at stage.ts:239, matching
    // single===true 1:1). A rank_range lookup keyed strictly on "" would
    // regress every single-pool source whose pool carries a real id — which
    // is the actual, live shape testkit/simulation.ts's group_knockout format
    // produces for entrantCount < 8 (poolCount = max(1, floor(n/4)) = 1) and
    // simulation.test.ts's unseeded property sweep (SIM_RUNS seeds, entrant
    // count skewed toward the low end by drawEntrantCount) hits routinely.
    const spec: ProgressionSpec = {
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
      placement: "rank_order",
    };
    const tables: SourceTables = {
      pools: [
        {
          pool: "P1",
          rows: [
            { entrantId: "e1", rank: 1 },
            { entrantId: "e2", rank: 2 },
            { entrantId: "e3", rank: 3 },
          ] as StandingsRow[],
        },
      ],
    };
    const { qualifiers } = resolveProgression(spec, [{ poolKeys: [] }], [tables]);
    expect(qualifiers.map((q) => q.entrantId)).toEqual(["e1", "e2"]);
  });

  // Mirrors qualification.test.ts's "UEFA normalisation flips the pick" —
  // the given normaliseUnequalPools:true test above only proves the refusal
  // is silenced (its tables carry no `.results`, so normalisedRow's real
  // branch never runs — its first branch, `results.length === 0`, always
  // wins, matching Decision 2b's own "same practical effect as comparing raw
  // rows" description of production today). THIS test populates `.results`
  // so the refold branch actually executes, proving normalisedRow is wired
  // for real, not merely present — a future session that breaks the refold
  // logic itself (as opposed to the not-yet-written caller Decision 2b
  // describes) gets a red test here, not just a passing "length is 2".
  describe("bestNth normaliseUnequalPools actually normalises when results are populated", () => {
    function fb(home: string, away: string, hg: number, ag: number): FixtureResult {
      const draw = hg === ag;
      const homeWon = hg > ag;
      const side = (
        id: string,
        gf: number,
        ga: number,
        w: number,
        d: number,
        l: number,
        pts: number,
      ): StandingsDelta => ({
        entrantId: id,
        played: 1,
        won: w,
        drawn: d,
        lost: l,
        points: pts,
        metrics: { gf, ga, gd: gf - ga },
      });
      return [
        side(home, hg, ag, homeWon ? 1 : 0, draw ? 1 : 0, !draw && !homeWon ? 1 : 0, draw ? 1 : homeWon ? 3 : 0),
        side(away, ag, hg, !draw && !homeWon ? 1 : 0, draw ? 1 : 0, homeWon ? 1 : 0, draw ? 1 : homeWon ? 0 : 3),
      ];
    }
    function rankedPool(pool: string, entrants: string[], results: FixtureResult[]) {
      const rows = rankStandings(foldResults(entrants, results), {
        cascade: ["points", "diff", "for", "lots"],
        results,
        rngSeed: 1,
      }).rows;
      return { pool, rows, results };
    }
    // Both third-placed teams take 3 pts off their pool's bottom side, with
    // equal overall GD (−1) but A3 has the flashier goals-for (beat A4 5-0).
    // RAW comparison → A3. Normalised (drop the bottom side, UEFA) → A3
    // collapses to GD −6 while B3 only falls to −2, so B3 wins. Pool sizes
    // are EQUAL (4 and 4) so the unequal-pools refusal never engages either
    // way — this isolates "does normalisation change the pick" from "is the
    // refusal silenced".
    const poolA = rankedPool("A", ["A1", "A2", "A3", "A4"], [
      fb("A1", "A2", 1, 0),
      fb("A1", "A3", 3, 0),
      fb("A1", "A4", 1, 0),
      fb("A2", "A3", 3, 0),
      fb("A2", "A4", 1, 0),
      fb("A3", "A4", 5, 0),
    ]);
    const poolB = rankedPool("B", ["B1", "B2", "B3", "B4"], [
      fb("B1", "B2", 1, 0),
      fb("B1", "B3", 1, 0),
      fb("B1", "B4", 1, 0),
      fb("B2", "B3", 1, 0),
      fb("B2", "B4", 1, 0),
      fb("B3", "B4", 1, 0),
    ]);
    const tables: SourceTables = { pools: [poolA, poolB] };

    it("plain metric comparison (flag absent) picks the flashier raw third-placed side", () => {
      const spec: ProgressionSpec = {
        sources: [{ stage: "previous", take: [{ kind: "bestNth", nth: 3, count: 1 }] }],
        placement: "rank_order",
      };
      const { qualifiers } = resolveProgression(spec, [{ poolKeys: ["A", "B"] }], [tables]);
      expect(qualifiers.map((q) => q.entrantId)).toEqual(["A3"]);
    });

    it("normaliseUnequalPools:true (drop the bottom side, refold) flips the pick", () => {
      const spec: ProgressionSpec = {
        sources: [
          { stage: "previous", take: [{ kind: "bestNth", nth: 3, count: 1, normaliseUnequalPools: true }] },
        ],
        placement: "rank_order",
      };
      const { qualifiers } = resolveProgression(spec, [{ poolKeys: ["A", "B"] }], [tables]);
      expect(qualifiers.map((q) => q.entrantId)).toEqual(["B3"]);
    });
  });
});

describe("resolveProgression — pool key/name hardening (carried from qualification.test.ts)", () => {
  const tables: SourceTables = {
    pools: [
      { pool: "A", rows: [{ entrantId: "A1", rank: 1 }] as StandingsRow[] },
      { pool: "B", rows: [{ entrantId: "B1", rank: 1 }] as StandingsRow[] },
    ],
  };

  it('resolves "Pool A" and "pool a" to the pool keyed "A"', () => {
    for (const name of ["Pool A", "pool a", "A", "a"]) {
      const spec: ProgressionSpec = {
        sources: [{ stage: "previous", take: [{ kind: "picks", picks: [{ pool: name, rank: 1 }] }] }],
        placement: "rank_order",
      };
      const { qualifiers } = resolveProgression(spec, [{ poolKeys: ["A", "B"] }], [tables]);
      expect(qualifiers.map((q) => q.entrantId)).toEqual(["A1"]);
    }
  });

  it("names the available pools when a pick resolves nothing", () => {
    const spec: ProgressionSpec = {
      sources: [{ stage: "previous", take: [{ kind: "picks", picks: [{ pool: "Z", rank: 1 }] }] }],
      placement: "rank_order",
    };
    expect(() => resolveProgression(spec, [{ poolKeys: ["A", "B"] }], [tables])).toThrow(
      /available pools: A, B/,
    );
  });
});

describe("resolveProgression — roundLosers edge cases (carried from qualification.test.ts)", () => {
  it("throws STAGE_NOT_READY when the source has no bracket at all", () => {
    const spec: ProgressionSpec = {
      sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 1 }] }],
      placement: "rank_order",
    };
    expect(() => resolveProgression(spec, [{ poolKeys: [] }], [{ pools: [] }])).toThrow(/bracket/);
  });

  it("throws QUALIFICATION_INVALID when count exceeds the round's available losers", () => {
    const tables: SourceTables = { pools: [], bracket: [{ round: 0, loser: "L1" }] };
    const spec: ProgressionSpec = {
      sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 0, count: 2 }] }],
      placement: "rank_order",
    };
    expect(() => resolveProgression(spec, [{ poolKeys: [] }], [tables])).toThrow(/no loser at position 2/);
    try {
      resolveProgression(spec, [{ poolKeys: [] }], [tables]);
    } catch (err) {
      expect(EngineError.is(err, "QUALIFICATION_INVALID")).toBe(true);
    }
  });

  it("equality-filters sparse round numbers (1, 7, 14) — never arithmetic on round, array order IS bracket position", () => {
    const tables: SourceTables = {
      pools: [],
      bracket: [
        { round: 1, loser: "R1L" },
        { round: 7, loser: "R7-second" },
        { round: 7, loser: "R7-first" },
        { round: 14, loser: "R14L" },
      ],
    };
    const spec: ProgressionSpec = {
      sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 7, count: 2 }] }],
      placement: "rank_order",
    };
    const { qualifiers } = resolveProgression(spec, [{ poolKeys: [] }], [tables]);
    // "R7-second" is listed BEFORE "R7-first" in `bracket` — position order
    // is array order, so it must come out first too.
    expect(qualifiers.map((q) => q.entrantId)).toEqual(["R7-second", "R7-first"]);
  });
});

describe("progressionSize", () => {
  it("sizes every TakeRule kind — the read path previewDivisionFixtures depends on", () => {
    expect(progressionSize([{ kind: "rankRange", from: 1, to: 4 }])).toBe(4);
    // group-count-dependent: cannot size without a real SourceShape, so this
    // branch deliberately returns the running total unchanged (callers with a
    // real shape use expandTake instead) — mirrors qualificationSize's old
    // behaviour, which never saw topNPerGroup at all (seeding-only before F2).
    expect(progressionSize([{ kind: "topNPerGroup", n: 2 }])).toBe(0);
    expect(progressionSize([{ kind: "bestNth", nth: 3, count: 2 }])).toBe(2);
    expect(
      progressionSize([{ kind: "picks", picks: [{ pool: "A", rank: 1 }, { pool: "B", rank: 1 }] }]),
    ).toBe(2);
    expect(progressionSize([{ kind: "roundLosers", round: 1, count: 3 }])).toBe(3);
  });

  it("sums across multiple rules in one take[] list", () => {
    expect(
      progressionSize([
        { kind: "rankRange", from: 1, to: 2 },
        { kind: "roundLosers", round: 1, count: 1 },
      ]),
    ).toBe(3);
  });
});

describe("placementTable", () => {
  it("ranks entrants positionally, 1-based, in the given order — unchanged from qualification.ts", () => {
    const pt = placementTable(["S1", "S2", "S3", "S4"]);
    expect(pt.rows.map((r) => [r.entrantId, r.rank])).toEqual([
      ["S1", 1],
      ["S2", 2],
      ["S3", 3],
      ["S4", 4],
    ]);
  });

  it("a placement table's rank_range resolves over it with no special-casing (bracket/ladder finish orders)", () => {
    const pt = placementTable(["S1", "S2", "S3", "S4"]);
    const spec: ProgressionSpec = {
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
      placement: "rank_order",
    };
    const { qualifiers } = resolveProgression(spec, [{ poolKeys: [] }], [{ pools: [pt] }]);
    expect(qualifiers.map((q) => q.entrantId)).toEqual(["S1", "S2"]);
  });
});
