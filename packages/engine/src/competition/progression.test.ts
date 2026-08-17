// The unified progression field (F2). Supersedes qualification.test.ts and
// stage-seeding.ts's expandTake/placeDescriptors tests — see this repo's F2
// plan (docs/superpowers/plans/2026-08-17-f2-unified-progression-field.md)
// for the union table and the Decisions this module encodes.
import { describe, expect, it } from "vitest";
import {
  descriptorKey,
  descriptorLabel,
  expandSources,
  expandTake,
  placeDescriptors,
  type ProgressionSource,
  type SourceShape,
  type TakeRule,
} from "./progression.ts";

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
