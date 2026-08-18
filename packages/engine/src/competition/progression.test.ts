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
  type SlotDescriptor,
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

  // F2 Task 6 review, finding 3: the third seeded_map error case
  // (stage-seeding.test.ts's "two entries claiming the same slot 422s",
  // deleted with that file and never migrated — the test above only
  // restored the out-of-range-slot and unknown-source cases) with a
  // duplicate slot claim across TWO entries, never a single malformed one.
  it("seeded_map still 422s when two entries claim the same slot", () => {
    const pots = expandSources(
      [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
      () => UNGROUPED,
    );
    const map = [
      { slot: "1", source: "rank:1" },
      { slot: "1", source: "rank:2" },
    ];
    expect(() => placeDescriptors(pots, "seeded_map", map)).toThrow(/more than once/);
    try {
      placeDescriptors(pots, "seeded_map", map);
      expect.fail("expected placeDescriptors to throw");
    } catch (err) {
      expect(EngineError.is(err, "SEEDING_MAP_SLOT_INVALID")).toBe(true);
    }
  });

  // B (round-4 review, "smaller, still real" — pre-existing, but this block
  // was rewritten on this branch). Two DIFFERENT map entries naming the SAME
  // source both resolve candidates[0] to the IDENTICAL SourcedSlot object —
  // `claimed` (below) dedupes by object identity, so the second entry's seat
  // silently receives a COPY of the first entry's descriptor instead of
  // being refused, and the real candidate for that seat's rank never gets
  // auto-filled anywhere — one qualifier is left unplaced. Before this test,
  // that surfaced only much later as a confusing QUALIFICATION_INVALID
  // ("qualifies through more than one source or take rule") at RESOLVE time,
  // far from the actual malformed-map cause. Refuse here instead, at
  // validate time, next to the duplicate-SLOT check above.
  it("seeded_map still 422s when two DIFFERENT entries name the SAME source (not just the same slot)", () => {
    const pots = expandSources(
      [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
      () => UNGROUPED,
    );
    const map = [
      { slot: "1", source: "rank:1" },
      { slot: "2", source: "rank:1" },
    ];
    expect(() => placeDescriptors(pots, "seeded_map", map)).toThrow(/already assigned to another seed/);
    try {
      placeDescriptors(pots, "seeded_map", map);
      expect.fail("expected placeDescriptors to throw");
    } catch (err) {
      expect(EngineError.is(err, "SEEDING_MAP_SLOT_INVALID")).toBe(true);
    }
  });

  // P6 (F3 Task 3): two SOURCES that each expose a pool "A" produce the same
  // descriptorKey "A1" for their winners. A seeded_map entry naming "A1" used
  // to resolve silently to whichever source's copy the old single-slot
  // `byKey` Map construction visited last — the wrong team's placeholder in
  // the wrong bracket seat, every test green. It must now refuse instead.
  it("seeded_map source ambiguous across two sources sharing a pool key now 422s SEEDING_MAP_SOURCE_AMBIGUOUS", () => {
    const sources: ProgressionSource[] = [
      { stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }] },
      { stage: { stageId: "s2" }, take: [{ kind: "topNPerGroup", n: 1 }] },
    ];
    const pots = expandSources(sources, () => ({ poolKeys: ["A"] }));
    const map = [{ slot: "1", source: "A1" }];
    expect(() => placeDescriptors(pots, "seeded_map", map)).toThrow(/matches qualifiers from more than one/);
    try {
      placeDescriptors(pots, "seeded_map", map);
      expect.fail("expected placeDescriptors to throw");
    } catch (err) {
      expect(EngineError.is(err, "SEEDING_MAP_SOURCE_AMBIGUOUS")).toBe(true);
      // Names the key and both source indexes (the dispatch's own wording).
      expect((err as EngineError).message).toContain("A1");
      expect((err as EngineError).data).toMatchObject({ source: "A1", sourceIndexes: [0, 1] });
    }
  });

  // Same two-source, same-pool-key shape, but WITHOUT a seeded_map entry
  // naming the ambiguous key: rank_order/snake never go through a
  // descriptorKey-keyed Map (they're plain array concatenation/reversal), so
  // both "A1"s always survived here — this pins that down explicitly and
  // demonstrates the keying pattern a caller MUST use if it ever needs to
  // look one back up by key (apps/web's stages.ts has no such caller today —
  // see the F3 Task 3 index note).
  it("two same-keyed descriptors from different sources both survive rank_order/snake, distinguishable by sourceIndex", () => {
    const sources: ProgressionSource[] = [
      { stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }] },
      { stage: { stageId: "s2" }, take: [{ kind: "topNPerGroup", n: 1 }] },
    ];
    const pots = expandSources(sources, () => ({ poolKeys: ["A"] }));
    const placed = placeDescriptors(pots, "rank_order");
    expect(placed).toHaveLength(2);
    expect(placed.every((s) => descriptorKey(s.descriptor) === "A1")).toBe(true);
    expect(placed.map((s) => s.sourceIndex)).toEqual([0, 1]);

    // The disambiguating key pattern: bare descriptorKey collapses to ONE
    // entry (the bug); sourceIndex-qualified holds both.
    const collapsed = new Map(placed.map((s) => [descriptorKey(s.descriptor), s]));
    expect(collapsed.size).toBe(1);
    const disambiguated = new Map(placed.map((s) => [`${s.sourceIndex}:${descriptorKey(s.descriptor)}`, s]));
    expect(disambiguated.size).toBe(2);
  });

  it("seeded_map still works when an ambiguous key exists but is NOT the one referenced (only the referenced key must be unambiguous)", () => {
    // Source 0 has pools A and B; source 1 has only pool A — "A1" is
    // ambiguous between them, "B1" is not (only source 0 produces it).
    const sources: ProgressionSource[] = [
      { stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }] },
      { stage: { stageId: "s2" }, take: [{ kind: "topNPerGroup", n: 1 }] },
    ];
    const pots = expandSources(sources, (i) => (i === 0 ? { poolKeys: ["A", "B"] } : { poolKeys: ["A"] }));
    const placed = placeDescriptors(pots, "seeded_map", [{ slot: "1", source: "B1" }]);
    expect(placed).toHaveLength(3);
    expect(placed[0]).toEqual({ sourceIndex: 0, descriptor: { kind: "group_rank", pool: "B", rank: 1 } });
    // Both ambiguous-but-unreferenced "A1"s survive, one per source, neither
    // silently dropped by the remaining-seat fill.
    const rest = placed.slice(1);
    expect(rest.every((s) => descriptorKey(s.descriptor) === "A1")).toBe(true);
    expect(rest.map((s) => s.sourceIndex).sort()).toEqual([0, 1]);
  });

  // F3 review item 2 — the ambiguity gate used to fire on `candidates.length
  // > 1` alone, so a SINGLE source with two overlapping rankRanges (both
  // producing a "rank:2" descriptor) also 422d SEEDING_MAP_SOURCE_AMBIGUOUS,
  // with a message claiming ">1 progression source" even though
  // sourceIndexes was [0, 0]. A same-source overlap like this is harmless —
  // both candidates are the literal same descriptor — so it must resolve.
  it("seeded_map source matching TWO overlapping take rules within the SAME source resolves — not ambiguous, just a same-source duplicate", () => {
    const sources: ProgressionSource[] = [
      { stage: "previous", take: [{ kind: "rankRange", from: 1, to: 3 }, { kind: "rankRange", from: 2, to: 4 }] },
    ];
    const pots = expandSources(sources, () => ({ poolKeys: [] }));
    const placed = placeDescriptors(pots, "seeded_map", [{ slot: "1", source: "rank:2" }]);
    expect(placed[0]).toEqual({ sourceIndex: 0, descriptor: { kind: "rank_range", rank: 2 } });
  });

  // The residual danger the broadened same-source case must still catch:
  // best_nth's descriptorKey is `best:${position}` alone (no `nth`), so two
  // bestNth rules at the same position but a DIFFERENT nth collide on key
  // while resolving to DIFFERENT entrants — not interchangeable. Silently
  // picking `candidates[0]` here would mis-seed the wrong nth-tier entrant
  // with no error at all; refuse instead, same code, an accurate message.
  it("seeded_map source matching two DIFFERENT-nth bestNth descriptors within the SAME source still refuses — not interchangeable", () => {
    const sources: ProgressionSource[] = [
      {
        stage: "previous",
        take: [
          { kind: "bestNth", nth: 1, count: 2 },
          { kind: "bestNth", nth: 2, count: 2 },
        ],
      },
    ];
    const pots = expandSources(sources, () => ({ poolKeys: [] }));
    const map = [{ slot: "1", source: "best:1" }];
    expect(() => placeDescriptors(pots, "seeded_map", map)).toThrow(/more than one qualifier within the same progression source/);
    try {
      placeDescriptors(pots, "seeded_map", map);
      expect.fail("expected placeDescriptors to throw");
    } catch (err) {
      expect(EngineError.is(err, "SEEDING_MAP_SOURCE_AMBIGUOUS")).toBe(true);
      expect((err as EngineError).data).toMatchObject({ source: "best:1", sourceIndexes: [0, 0] });
    }
  });

  // Corollary caught in the same review as F3's ruling 13 (F3 programme
  // index): snakeMerge reverses a bestNth pot's ARRAY ORDER but never
  // touches each descriptor's own `position` (its cross-group strength
  // rank), so a reversed wildcard pot would seed the WEAKEST wildcard into
  // the STRONGEST bracket slot. No shipped writer combines snake with
  // bestNth today (groups_ko takes rank_order — see format-templates.ts),
  // but the hazard is live for anyone who writes one; refuse it outright
  // rather than silently mis-seed.
  it("snake placement combined with a bestNth-sourced pot throws CONFIG_INVALID", () => {
    const pots = expandSources(
      [
        {
          stage: "previous",
          take: [
            { kind: "topNPerGroup", n: 1 },
            { kind: "bestNth", nth: 2, count: 2 },
          ],
        },
      ],
      () => GROUPED,
    );
    expect(() => placeDescriptors(pots, "snake")).toThrow(/bestNth/);
    try {
      placeDescriptors(pots, "snake");
      expect.fail("expected placeDescriptors to throw");
    } catch (err) {
      expect(EngineError.is(err, "CONFIG_INVALID")).toBe(true);
    }
  });

  it("the same bestNth-sourced pot under rank_order does not throw — the guard is snake-specific", () => {
    const pots = expandSources(
      [
        {
          stage: "previous",
          take: [
            { kind: "topNPerGroup", n: 1 },
            { kind: "bestNth", nth: 2, count: 2 },
          ],
        },
      ],
      () => GROUPED,
    );
    expect(() => placeDescriptors(pots, "rank_order")).not.toThrow();
  });

  it("snake without any bestNth pot does not throw — ordinary group-target snake (t20-super8's shape) keeps working", () => {
    const pots = expandSources([{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }], () => GROUPED);
    expect(() => placeDescriptors(pots, "snake")).not.toThrow();
  });

  // F3 round-3 review, Task 1 (BLOCKER) — the bestNth corollary above is not
  // THE rule, it's one instance of it. Rule of record (ruling 13): snake for
  // a group/pool TARGET, rank_order for a bracket target — regardless of
  // what's in the pot. `topNPerGroup`'s wave-major pot (>1 descriptor, every
  // one `group_rank`) is the shape that actually breaks: snakeMerge reverses
  // alternate waves, and generateSingleElim's seed fold (seed i vs seed
  // N+1-i, scheduling/bracket.ts:52-63,156-163) then pairs each pool's OWN
  // wave-1 qualifier against its OWN wave-2 qualifier in round 1 — every
  // group replaying its own final (this exact 4-pool/topNPerGroup(2) example
  // is the worked case in ruling 13). `targetKind` is a new, OPTIONAL 4th
  // arg — apps/web's two writers (stages.ts, stage-seeding.ts) pass their
  // stage row's raw `kind` string; an absent/unrecognised value means
  // "unknown, don't refuse" (see the two skip-cases below), not "always
  // refuse".
  it("snake placement over a wave-major (topNPerGroup) pot INTO A BRACKET-KIND TARGET throws CONFIG_INVALID", () => {
    const pots = expandSources([{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }], () => GROUPED);
    expect(() => placeDescriptors(pots, "snake", undefined, "knockout")).toThrow(/bracket/);
    try {
      placeDescriptors(pots, "snake", undefined, "knockout");
      expect.fail("expected placeDescriptors to throw");
    } catch (err) {
      expect(EngineError.is(err, "CONFIG_INVALID")).toBe(true);
    }
  });

  it("the same wave-major pot under snake into every other bracket kind (double_elim, stepladder, page_playoff) also throws", () => {
    const pots = expandSources([{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }], () => GROUPED);
    for (const targetKind of ["double_elim", "stepladder", "page_playoff"]) {
      expect(() => placeDescriptors(pots, "snake", undefined, targetKind)).toThrow(/bracket/);
    }
  });

  it("snake into a GROUP-kind target does not throw — t20-super8's actual shape (ruling 13's legitimate case)", () => {
    const pots = expandSources([{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }], () => GROUPED);
    expect(() => placeDescriptors(pots, "snake", undefined, "group")).not.toThrow();
  });

  it("snake with an UNRECOGNISED targetKind does not throw — degrades to 'unknown, don't refuse' rather than always-throwing", () => {
    const pots = expandSources([{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }], () => GROUPED);
    expect(() => placeDescriptors(pots, "snake", undefined, "not_a_real_kind")).not.toThrow();
  });

  it("rank_order over the same wave-major pot into a bracket target does not throw — the new guard is snake-specific too", () => {
    const pots = expandSources([{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }], () => GROUPED);
    expect(() => placeDescriptors(pots, "rank_order", undefined, "knockout")).not.toThrow();
  });

  it("a single-element group_rank pot (picks' shape) into a bracket target does not throw — reversing a 1-element pot is a no-op, never wave-major", () => {
    const pots = expandSources(
      [{ stage: "previous", take: [{ kind: "picks", picks: [{ pool: "B", rank: 1 }, { pool: "A", rank: 1 }] }] }],
      () => GROUPED,
    );
    expect(() => placeDescriptors(pots, "snake", undefined, "knockout")).not.toThrow();
  });
});

describe("descriptorKey / descriptorLabel", () => {
  it("round_loser gets its own key and i18n pattern ref", () => {
    const d: import("./progression.ts").SlotDescriptor = { kind: "round_loser", round: 1, position: 3 };
    expect(descriptorKey(d)).toBe("loser:1:3");
    expect(descriptorLabel(d)).toEqual({ key: "slot.round_loser", params: { round: 1, n: 3 } });
  });

  // F2 Task 6 review, finding 3: these three cases (group_rank, rank_range,
  // best_nth — every OTHER SlotDescriptor kind besides round_loser above)
  // lived in apps/web's stage-seeding.test.ts before F2 moved
  // descriptorKey/descriptorLabel into this module; Task 6 deleted that file
  // and added progression-multi-source.test.ts in its place, but that file
  // covers the DB-integration half only (per its own header) — the exact-
  // value coverage for these three wire-vocabulary cases never migrated.
  // Restored verbatim (same assertions, same fixture values) against the
  // current module.
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

  // A2 (round-4 review, MAJOR): resolveProgression used to call
  // placeDescriptors with NO targetKind at all, so ruling 13's bracket-target
  // snake guard (already proven under the `placeDescriptors` describe block
  // above) could never fire on the actual seed-RESOLUTION path — only at
  // save-time validation (validateProgressionAgainstShapes/createStages).
  // Both apps/web writers (computeSeedProposal, seedNextStage) already have a
  // real kind in scope and now pass it through. Defence in depth: every
  // current writer validates at save time too, so this was not a live bug —
  // but an optional param a caller can forget is the same failure mode
  // ruling 13 exists to close.
  it("resolveProgression forwards targetKind to placeDescriptors — a persisted snake+topNPerGroup progression against a knockout target is refused, not silently resolved", () => {
    const tables: SourceTables = {
      pools: [
        { pool: "A", rows: [{ entrantId: "a1", rank: 1 }, { entrantId: "a2", rank: 2 }] as StandingsRow[] },
        { pool: "B", rows: [{ entrantId: "b1", rank: 1 }, { entrantId: "b2", rank: 2 }] as StandingsRow[] },
      ],
    };
    const spec: ProgressionSpec = {
      sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
      placement: "snake",
    };
    const shape: SourceShape = { poolKeys: ["A", "B"] };
    expect(() => resolveProgression(spec, [shape], [tables], "knockout")).toThrow(/bracket-kind stage \("knockout"\)/);
    try {
      resolveProgression(spec, [shape], [tables], "knockout");
      expect.fail("expected resolveProgression to throw");
    } catch (err) {
      expect(EngineError.is(err, "CONFIG_INVALID")).toBe(true);
    }
    // No targetKind (every caller that hasn't been taught to pass one) still
    // degrades to "unknown, don't refuse" — placeDescriptors' own documented
    // default — proving the new 4th arg is genuinely optional, not a silent
    // behaviour change for existing callers.
    expect(() => resolveProgression(spec, [shape], [tables])).not.toThrow();
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
    // A1 (round-4 review): the message used to claim "UEFA normalisation for
    // unequal pools isn't implemented" — false, normalisedRow implements it a
    // few lines above (Decision 2b) and the test right above this one proves
    // it works. Only the message was wrong; guard against it drifting back.
    try {
      resolveProgression(spec, [{ poolKeys: ["A", "B"] }], [tables]);
      expect.fail("expected resolveProgression to throw");
    } catch (err) {
      expect((err as Error).message).not.toMatch(/isn't implemented/);
      expect((err as Error).message).toMatch(/normaliseUnequalPools/);
    }
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

  // A1 (round-4 review, MAJOR): groups_ko (format-templates.ts) emits a
  // bestNth remainder with no normaliseUnequalPools, and pools are built by
  // snakeDistribute (stages.ts), which produces unequal-sized pools
  // whenever entrants don't divide evenly by poolCount — the common case,
  // not an edge case. Day-one fixture generation runs on SHAPES and never
  // hits bestNth's cross-pool compare, so the format looks healthy right up
  // until real seeding, where it throws SEEDING_BESTNTH_UNEQUAL_POOLS. These
  // two tests separate the two hazards the round-4 review raised.
  it("groups_ko's real bestNth remainder resolves against unequal pools once normaliseUnequalPools is set", () => {
    // Mirrors qualified:7, poolCount:4 against pool sizes [3,3,2,2] — exactly
    // what snakeDistribute produces for e.g. 10 entrants in 4 pools. Every
    // pool DOES have a rank-2 row (min size is 2), so this isolates the
    // cross-pool SIZE-comparison refusal from the separate "rank exceeds a
    // short pool's row count" hazard covered by the next test.
    const pool = (key: string, size: number) => ({
      pool: key,
      rows: Array.from({ length: size }, (_, i) => ({ entrantId: `${key}${i + 1}`, rank: i + 1 }) as StandingsRow),
    });
    const tables: SourceTables = { pools: [pool("A", 3), pool("B", 3), pool("C", 2), pool("D", 2)] };
    const spec: ProgressionSpec = {
      sources: [
        {
          stage: "previous",
          take: [
            { kind: "topNPerGroup", n: 1 },
            { kind: "bestNth", nth: 2, count: 3, normaliseUnequalPools: true },
          ],
        },
      ],
      placement: "rank_order",
    };
    const shape: SourceShape = { poolKeys: ["A", "B", "C", "D"] };
    expect(() => resolveProgression(spec, [shape], [tables])).not.toThrow();
    const { qualifiers } = resolveProgression(spec, [shape], [tables]);
    expect(qualifiers).toHaveLength(7);
    // Wave 1 (topNPerGroup) took every pool's own winner — always present
    // regardless of which 3 of the 4 rank-2 finishers the cross-pool
    // bestNth remainder's tie order happens to pick (crossGroupOrder has no
    // seeds context — don't assert which one wins a tie, see this repo's
    // implementer memory on bestNth's tiebreak).
    expect(qualifiers.map((q) => q.entrantId)).toEqual(expect.arrayContaining(["A1", "B1", "C1", "D1"]));
  });

  it("the sibling hazard: nth exceeding a SHORT pool's row count still throws even with normaliseUnequalPools:true — normalisation compares already-existing rows, it does not invent a missing one", () => {
    // The round-4 review explicitly asked whether normaliseUnequalPools
    // covers this. It does not: rowAtRank (progression.ts) looks up rank
    // `nth` on EVERY pool, including the short one, BEFORE normalisedRow
    // ever runs — so a pool with fewer than `nth` rows throws
    // STAGE_NOT_READY unconditionally, regardless of the flag. Concretely:
    // qualified:9, poolCount:4 against pool sizes [3,3,2,2] ->
    // topNPerGroup(2) + bestNth(nth:3,...) — the two 2-row pools have no
    // rank-3 finisher at all. Deliberately NOT fixed this session (a real
    // fix means teaching bestNth to treat a pool with no row at `nth` as
    // simply not contributing a candidate, rather than refusing outright —
    // an engine semantics change wider than this session's brief).
    // Documented here so a future reader doesn't re-derive it as a fresh
    // bug, per this repo's own "say so rather than paper over it" norm.
    const pool = (key: string, size: number) => ({
      pool: key,
      rows: Array.from({ length: size }, (_, i) => ({ entrantId: `${key}${i + 1}`, rank: i + 1 }) as StandingsRow),
    });
    const tables: SourceTables = { pools: [pool("A", 3), pool("B", 3), pool("C", 2), pool("D", 2)] };
    const spec: ProgressionSpec = {
      sources: [{ stage: "previous", take: [{ kind: "bestNth", nth: 3, count: 1, normaliseUnequalPools: true }] }],
      placement: "rank_order",
    };
    const shape: SourceShape = { poolKeys: ["A", "B", "C", "D"] };
    expect(() => resolveProgression(spec, [shape], [tables])).toThrow(/takes rank 3, but only 2 entrant/);
    try {
      resolveProgression(spec, [shape], [tables]);
    } catch (err) {
      expect(EngineError.is(err, "STAGE_NOT_READY")).toBe(true);
    }
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
    // F3 review item 1: descriptors widened from SlotDescriptor[] to
    // SourcedSlot[] (carries sourceIndex) — this spec has one source, so
    // sourceIndex is 0 throughout.
    expect(ties[0]).toEqual({
      descriptors: [{ sourceIndex: 0, descriptor: { kind: "rank_range", rank: 2 } }],
      entrantIds: ["b", "c"],
      reason: "seed",
    });
  });

  // F3 review item 1 — the collision this widening exists to fix: two
  // DIFFERENT sources each carry their OWN 2-way tie at rank 1, so
  // descriptorKey ("rank:1") is IDENTICAL for both, but the two tie groups
  // have different entrant sets and must stay distinguishable. Before this
  // session, apps/web's computeSeedProposal had nothing to key on but the
  // bare descriptorKey (stages.ts's seedOfKey Map), so the second source's
  // seed silently overwrote the first's in that Map — a tie flagged on
  // source 0 resolved against source 1's (already-unambiguous) slot instead.
  it("keeps two same-keyed ties from different sources distinguishable by sourceIndex (colliding descriptorKey)", () => {
    const sourceATied = [
      { entrantId: "a1", rank: 1, tieUnbroken: true, tieBreak: { key: "seed", with: ["a2"] } },
      { entrantId: "a2", rank: 2, tieUnbroken: true, tieBreak: { key: "seed", with: ["a1"] } },
    ] as StandingsRow[];
    const sourceBTied = [
      { entrantId: "b1", rank: 1, tieUnbroken: true, tieBreak: { key: "seed", with: ["b2"] } },
      { entrantId: "b2", rank: 2, tieUnbroken: true, tieBreak: { key: "seed", with: ["b1"] } },
    ] as StandingsRow[];
    const spec: ProgressionSpec = {
      sources: [
        { stage: "previous", take: [{ kind: "rankRange", from: 1, to: 1 }] },
        { stage: { stageId: "s2" }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
      ],
      placement: "rank_order",
    };
    const { ties } = resolveProgression(
      spec,
      [{ poolKeys: [] }, { poolKeys: [] }],
      [{ pools: [{ pool: "", rows: sourceATied }] }, { pools: [{ pool: "", rows: sourceBTied }] }],
    );
    expect(ties).toHaveLength(2);
    const bySourceIndex = new Map(ties.map((t) => [t.descriptors[0]!.sourceIndex, t]));
    expect(bySourceIndex.get(0)?.entrantIds).toEqual(["a1", "a2"]);
    expect(bySourceIndex.get(1)?.entrantIds).toEqual(["b1", "b2"]);
    // Both descriptors are the SAME rank_range/rank:1 shape — the collision
    // itself — but tagged with a different sourceIndex, which is what lets a
    // consumer key by `${sourceIndex}:${descriptorKey}` instead of the bare
    // key that used to collide (stages.ts's computeSeedProposal).
    expect(bySourceIndex.get(0)?.descriptors[0]?.descriptor).toEqual({ kind: "rank_range", rank: 1 });
    expect(bySourceIndex.get(1)?.descriptors[0]?.descriptor).toEqual({ kind: "rank_range", rank: 1 });
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
