// Pure unit tests for the StageSeeding resolution engine (D4a / P5): no DB, no
// tenant — every function here takes plain StandingsRow[] and returns plain
// data. Acceptance criteria (P05-progression-engine.md): every `take` kind,
// the cross-group cascade reproduced for `bestNth`, snake + seeded_map
// placement, and a tie FLAGGED rather than silently ordered.
import { describe, expect, it } from "vitest";
import type { StandingsRow } from "@seazn/engine/competition";
import {
  descriptorKey,
  descriptorLabel,
  expandTake,
  placeDescriptors,
  resolveQualifiers,
  seedingSlotCount,
  type PoolTableRows,
  type SlotDescriptor,
  type TakeRule,
} from "../stage-seeding";

function row(entrantId: string, rank: number, extra: Partial<StandingsRow> = {}): StandingsRow {
  return {
    entrantId,
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    points: 0,
    metrics: {},
    rank,
    ...extra,
  };
}

describe("expandTake — every take kind (P05 acceptance)", () => {
  it("rankRange: one pot, ranks from..to in order, no pools needed", () => {
    const take: TakeRule[] = [{ kind: "rankRange", from: 5, to: 8 }];
    const pots = expandTake(take, { poolKeys: [] });
    expect(pots).toEqual([
      [
        { kind: "rank_range", rank: 5 },
        { kind: "rank_range", rank: 6 },
        { kind: "rank_range", rank: 7 },
        { kind: "rank_range", rank: 8 },
      ],
    ]);
    expect(seedingSlotCount(take, { poolKeys: [] })).toBe(4);
  });

  it("topNPerGroup: one pot PER WAVE (rank), pools in key order within a wave", () => {
    const take: TakeRule[] = [{ kind: "topNPerGroup", n: 2 }];
    const shape = { poolKeys: ["A", "B", "C", "D"] };
    const pots = expandTake(take, shape);
    expect(pots).toHaveLength(2); // wave 1 (winners), wave 2 (runners-up)
    expect(pots[0]).toEqual([
      { kind: "group_rank", pool: "A", rank: 1 },
      { kind: "group_rank", pool: "B", rank: 1 },
      { kind: "group_rank", pool: "C", rank: 1 },
      { kind: "group_rank", pool: "D", rank: 1 },
    ]);
    expect(pots[1]).toEqual([
      { kind: "group_rank", pool: "A", rank: 2 },
      { kind: "group_rank", pool: "B", rank: 2 },
      { kind: "group_rank", pool: "C", rank: 2 },
      { kind: "group_rank", pool: "D", rank: 2 },
    ]);
    expect(seedingSlotCount(take, shape)).toBe(8);
  });

  it("bestNth: one pot, positions 1..count (cross-group order resolved later)", () => {
    const take: TakeRule[] = [{ kind: "bestNth", nth: 3, count: 4 }];
    const pots = expandTake(take, { poolKeys: ["A", "B", "C", "D", "E", "F"] });
    expect(pots).toEqual([
      [
        { kind: "best_nth", nth: 3, position: 1 },
        { kind: "best_nth", nth: 3, position: 2 },
        { kind: "best_nth", nth: 3, position: 3 },
        { kind: "best_nth", nth: 3, position: 4 },
      ],
    ]);
  });

  it("combines multiple take rules as separate pots, in declaration order", () => {
    const take: TakeRule[] = [
      { kind: "topNPerGroup", n: 1 },
      { kind: "bestNth", nth: 2, count: 2 },
    ];
    const shape = { poolKeys: ["A", "B"] };
    const pots = expandTake(take, shape);
    expect(pots).toHaveLength(2);
    expect(pots[0]).toHaveLength(2); // 1 winner per pool x2 pools
    expect(pots[1]).toHaveLength(2); // best 2 of the runners-up
    expect(seedingSlotCount(take, shape)).toBe(4);
  });
});

describe("descriptorKey / descriptorLabel — the wire vocabulary", () => {
  it("group_rank keys as poolKey+rank; labels winner/runner-up/nth", () => {
    const winner: SlotDescriptor = { kind: "group_rank", pool: "A", rank: 1 };
    const runnerUp: SlotDescriptor = { kind: "group_rank", pool: "A", rank: 2 };
    const third: SlotDescriptor = { kind: "group_rank", pool: "A", rank: 3 };
    expect(descriptorKey(winner)).toBe("A1");
    expect(descriptorLabel(winner)).toEqual({ key: "slot.winner_group", params: { g: "A" } });
    expect(descriptorLabel(runnerUp)).toEqual({ key: "slot.runner_up_group", params: { g: "A" } });
    expect(descriptorLabel(third)).toEqual({ key: "slot.nth_group", params: { n: 3, g: "A" } });
  });

  it("rank_range keys/labels off the plain rank", () => {
    const d: SlotDescriptor = { kind: "rank_range", rank: 5 };
    expect(descriptorKey(d)).toBe("rank:5");
    expect(descriptorLabel(d)).toEqual({ key: "slot.rank_range", params: { rank: 5 } });
  });

  it("best_nth keys/labels off its resolved position", () => {
    const d: SlotDescriptor = { kind: "best_nth", nth: 3, position: 2 };
    expect(descriptorKey(d)).toBe("best:2");
    expect(descriptorLabel(d)).toEqual({ key: "slot.best_nth", params: { rank: 2, nth: 3 } });
  });
});

describe("placeDescriptors — rank_order / snake / seeded_map (P05 acceptance)", () => {
  const shape = { poolKeys: ["A", "B", "C", "D"] };
  const take: TakeRule[] = [{ kind: "topNPerGroup", n: 2 }];
  const pots = expandTake(take, shape);

  it("rank_order: pots concatenated verbatim (wave-major)", () => {
    const placed = placeDescriptors(pots, "rank_order", undefined);
    expect(placed.map(descriptorKey)).toEqual(["A1", "B1", "C1", "D1", "A2", "B2", "C2", "D2"]);
  });

  it("snake: alternating pots reverse — the SAME convention snakeDistribute already uses for pools", () => {
    const placed = placeDescriptors(pots, "snake", undefined);
    // wave 1 forward, wave 2 reversed — classic seeding snake so group winners
    // and runners-up interleave instead of stacking group-major.
    expect(placed.map(descriptorKey)).toEqual(["A1", "B1", "C1", "D1", "D2", "C2", "B2", "A2"]);
  });

  it("seeded_map: explicit slot overrides, remainder falls back to rank_order", () => {
    // Send the D-group runner-up to seed 1 (upset protection scenario); every
    // other descriptor keeps its natural rank_order position in the gaps.
    const placed = placeDescriptors(pots, "seeded_map", [{ slot: "1", source: "D2" }]);
    expect(placed[0]).toEqual({ kind: "group_rank", pool: "D", rank: 2 });
    // The displaced A1 (and everyone else) fills the remaining seats in
    // their original rank_order relative order.
    expect(placed.slice(1).map(descriptorKey)).toEqual(["A1", "B1", "C1", "D1", "A2", "B2", "C2"]);
  });

  it("seeded_map: a source that matches no computed descriptor 422s (rule-save-time shape)", () => {
    expect(() => placeDescriptors(pots, "seeded_map", [{ slot: "1", source: "Z9" }])).toThrow(/does not match/);
  });

  it("seeded_map: a slot outside 1..N 422s", () => {
    expect(() => placeDescriptors(pots, "seeded_map", [{ slot: "99", source: "A1" }])).toThrow(/outside the 1\.\.8/);
  });

  it("seeded_map: two entries claiming the same slot 422s", () => {
    expect(() =>
      placeDescriptors(pots, "seeded_map", [
        { slot: "1", source: "A1" },
        { slot: "1", source: "B1" },
      ]),
    ).toThrow(/more than once/);
  });
});

describe("resolveQualifiers — bestNth cross-group cascade (UEFA third-place table)", () => {
  // Six equal-sized groups (A..F); pick the best 4 third-placed teams. Points
  // strictly decreasing so the cascade's PRIMARY key (points) settles every
  // seat with no tie — the classic World Cup / Euro "best thirds" table.
  it("orders third-placed candidates by points -> diff -> for -> wins, best first, no tie", () => {
    const tables: PoolTableRows[] = ["A", "B", "C", "D", "E", "F"].map((pool, i) => ({
      pool,
      rows: [
        row(`${pool}-1st`, 1, { points: 9 }),
        row(`${pool}-2nd`, 2, { points: 6 }),
        // Descending points across groups: F's third is worst, A's is best.
        row(`${pool}-3rd`, 3, { points: 5 - i, metrics: { diff: 5 - i } }),
        row(`${pool}-4th`, 4, { points: 0 }),
      ],
    }));
    const seedOrder: SlotDescriptor[] = [1, 2, 3, 4].map((position) => ({
      kind: "best_nth",
      nth: 3,
      position,
    }));
    const { qualifiers, ties } = resolveQualifiers(seedOrder, tables);
    expect(qualifiers.map((q) => q.entrantId)).toEqual(["A-3rd", "B-3rd", "C-3rd", "D-3rd"]);
    expect(ties).toEqual([]);
  });

  it("group_rank reads the exact (pool, rank) row — no cross-group comparison needed", () => {
    const tables: PoolTableRows[] = [
      { pool: "A", rows: [row("a1", 1), row("a2", 2)] },
      { pool: "B", rows: [row("b1", 1), row("b2", 2)] },
    ];
    const seedOrder: SlotDescriptor[] = [
      { kind: "group_rank", pool: "A", rank: 1 },
      { kind: "group_rank", pool: "B", rank: 1 },
    ];
    const { qualifiers } = resolveQualifiers(seedOrder, tables);
    expect(qualifiers.map((q) => q.entrantId)).toEqual(["a1", "b1"]);
  });

  it("rank_range reads the overall (pool '') table by rank", () => {
    const tables: PoolTableRows[] = [{ pool: "", rows: [row("e1", 1), row("e2", 2), row("e3", 3)] }];
    const seedOrder: SlotDescriptor[] = [
      { kind: "rank_range", rank: 2 },
      { kind: "rank_range", rank: 3 },
    ];
    const { qualifiers } = resolveQualifiers(seedOrder, tables);
    expect(qualifiers.map((q) => q.entrantId)).toEqual(["e2", "e3"]);
  });

  it("a tie is FLAGGED, never silently ordered — group_rank row carries tieUnbroken", () => {
    // The source stage's OWN standings computation already ran the cascade and
    // could not separate two entrants at rank 2 — it broke the tie by seed/id
    // (deterministic) and marked the row tieUnbroken, per rankStandings'
    // documented fallback. Seeding must not silently trust that fallback.
    const tables: PoolTableRows[] = [
      {
        pool: "A",
        rows: [
          row("a1", 1),
          row("a2", 2, { tieUnbroken: true, tieBreak: { key: "seed", with: ["a3"] } }),
          row("a3", 3, { tieUnbroken: true, tieBreak: { key: "seed", with: ["a2"] } }),
        ],
      },
    ];
    const seedOrder: SlotDescriptor[] = [{ kind: "group_rank", pool: "A", rank: 2 }];
    const { qualifiers, ties } = resolveQualifiers(seedOrder, tables);
    // Still resolves SOMETHING (the engine's own deterministic fallback) so a
    // proposal always has a full slate to show/edit...
    expect(qualifiers[0]!.entrantId).toBe("a2");
    expect(qualifiers[0]!.tieUnbroken).toBe(true);
    // ...but the tie is flagged for the organiser, naming both candidates.
    expect(ties).toHaveLength(1);
    expect(ties[0]!.entrantIds.sort()).toEqual(["a2", "a3"]);
  });

  it("bestNth cross-group tie is flagged when two candidates land level on every cascade key", () => {
    const tables: PoolTableRows[] = [
      { pool: "A", rows: [row("a1", 1), row("a2", 2), row("a3", 3, { points: 4, metrics: {} })] },
      { pool: "B", rows: [row("b1", 1), row("b2", 2), row("b3", 3, { points: 4, metrics: {} })] },
    ];
    const seedOrder: SlotDescriptor[] = [
      { kind: "best_nth", nth: 3, position: 1 },
      { kind: "best_nth", nth: 3, position: 2 },
    ];
    const { ties } = resolveQualifiers(seedOrder, tables);
    expect(ties.length).toBeGreaterThan(0);
    expect(ties[0]!.entrantIds.sort()).toEqual(["a3", "b3"]);
  });

  it("a rank the source stage hasn't produced yet (incomplete) throws SEEDING_SOURCE_INCOMPLETE", () => {
    const tables: PoolTableRows[] = [{ pool: "A", rows: [row("a1", 1)] }];
    const seedOrder: SlotDescriptor[] = [{ kind: "group_rank", pool: "A", rank: 2 }];
    expect(() => resolveQualifiers(seedOrder, tables)).toThrow(/no entrant ranked 2/);
  });
});
