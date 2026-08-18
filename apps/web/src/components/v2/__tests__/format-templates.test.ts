// L3/#414 pass 3: two new one-click stage-graph templates — KO+Plate
// (losersOfRound) and Qualifying+Main (topN over placements) — and their
// detectTemplate round-trip. Pure, no DB.
//
// F2 (unified progression field): every `qualification:` literal below was
// rewritten onto `progression:` in lockstep with format-templates.ts's own
// StageDraft/STAGE_TEMPLATES conversion — losersOfRound -> roundLosers,
// topN:n -> rankRange{from:1,to:n}, both wrapped in {sources,placement,
// timing}.
//
// F3 (day-one fixtures, owner ruling R1): `timing` is now "setup" on every
// progression-bearing template below, including ko_plate and
// qualifying_main — the propose/confirm flow this file's F2 comment said
// it never used. `buildTemplateStages` now passes the whole `TemplateKnobs`
// object into `build()` (owner ruling R5: groups_ko needs `poolCount`
// alongside `qualified` to draw from every pool, not just A/B), not the
// bare qualified count.
import { describe, expect, it } from "vitest";
import { STAGE_TEMPLATES, buildTemplateStages, detectTemplate } from "../format-templates";
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import { descriptorKey, expandSources, expandTake, placeDescriptors } from "@seazn/engine/competition";
import { generateSingleElim } from "@seazn/engine/scheduling";

describe("ko_plate template", () => {
  it("builds a main knockout + a plate seeded by roundLosers, count = the qualified knob", () => {
    const stages = buildTemplateStages("ko_plate", {
      qualified: 4,
      swissRounds: 5,
      poolCount: 2,
      legs: 1,
    });
    expect(stages).toHaveLength(2);
    expect(stages[0]).toMatchObject({ kind: "knockout", progression: null });
    expect(stages[1]).toMatchObject({
      kind: "knockout",
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 4 }] }],
        placement: "rank_order",
        timing: "setup",
      },
    });
  });

  it("is listed with a label and help text", () => {
    const t = STAGE_TEMPLATES.find((s) => s.key === "ko_plate");
    expect(t).toBeDefined();
    expect(t!.label.length).toBeGreaterThan(0);
    expect(t!.help.length).toBeGreaterThan(0);
  });

  it("round-trips through detectTemplate", () => {
    const stages = buildTemplateStages("ko_plate", {
      qualified: 4,
      swissRounds: 5,
      poolCount: 2,
      legs: 1,
    });
    expect(detectTemplate(stages)).toBe("ko_plate");
  });
});

describe("qualifying_main template", () => {
  it("builds a qualifying knockout + a main draw seeded by rankRange, count = the qualified knob", () => {
    const stages = buildTemplateStages("qualifying_main", {
      qualified: 8,
      swissRounds: 5,
      poolCount: 2,
      legs: 1,
    });
    expect(stages).toHaveLength(2);
    expect(stages[0]).toMatchObject({ kind: "knockout", progression: null });
    expect(stages[1]).toMatchObject({
      kind: "knockout",
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 8 }] }],
        placement: "rank_order",
        timing: "setup",
      },
    });
  });

  it("round-trips through detectTemplate", () => {
    const stages = buildTemplateStages("qualifying_main", {
      qualified: 8,
      swissRounds: 5,
      poolCount: 2,
      legs: 1,
    });
    expect(detectTemplate(stages)).toBe("qualifying_main");
  });

  it("is distinguishable from ko_plate — same kind sequence, different progression take-rule kind", () => {
    const plate = buildTemplateStages("ko_plate", { qualified: 3, swissRounds: 5, poolCount: 2, legs: 1 });
    const main = buildTemplateStages("qualifying_main", {
      qualified: 3,
      swissRounds: 5,
      poolCount: 2,
      legs: 1,
    });
    expect(plate.map((s) => s.kind)).toEqual(main.map((s) => s.kind)); // both knockout+knockout
    expect(detectTemplate(plate)).toBe("ko_plate");
    expect(detectTemplate(main)).toBe("qualifying_main");
  });
});

describe("detectTemplate — existing templates still round-trip (regression)", () => {
  it("league, league_ko, groups_ko, knockout, americano, ladder", () => {
    expect(detectTemplate([{ kind: "league", config: { legs: 1 } }])).toBe("league");
    expect(
      detectTemplate([
        { kind: "league", config: { legs: 1 } },
        { kind: "knockout", config: {} },
      ]),
    ).toBe("league_ko");
    expect(
      detectTemplate([
        { kind: "group", config: { pools: { count: 2 } } },
        { kind: "knockout", config: {} },
      ]),
    ).toBe("groups_ko");
    expect(detectTemplate([{ kind: "knockout", config: {} }])).toBe("knockout");
    expect(detectTemplate([{ kind: "americano", config: { mode: "americano" } }])).toBe("americano");
    expect(detectTemplate([{ kind: "ladder", config: {} }])).toBe("ladder");
  });

  it("an unrecognised graph returns null (custom) — same kinds, neither roundLosers nor rankRange", () => {
    expect(
      detectTemplate([
        { kind: "knockout", config: {} },
        {
          kind: "knockout",
          config: {},
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "picks", picks: [{ pool: "A", rank: 1 }] }] }],
            placement: "rank_order",
            timing: "setup",
          },
        },
      ]),
    ).toBeNull();
  });
});

// F2 plan Task 5 Step 1 — every template now emits `progression`, never
// `qualification`; `rankRange` is the collapsed survivor for what used to be
// `topN` (owner ruling 4 / Decision 2).
describe("format-templates emit progression, not qualification", () => {
  it("league_ko emits rankRange, setup — the topN replacement, unchanged take shape", () => {
    const stages = buildTemplateStages("league_ko", { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
    const finals = stages[1]!;
    expect(finals.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("ko_plate still emits roundLosers, now setup — take shape unchanged, only timing flipped (F3)", () => {
    const stages = buildTemplateStages("ko_plate", { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 4 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("detectTemplate reads rankRange, not topN — round-trips through the new field", () => {
    const stages = buildTemplateStages("qualifying_main", { qualified: 8, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(detectTemplate(stages)).toBe("qualifying_main");
  });

  it("groups_ko emits topNPerGroup, rank_order, setup — the cross-pool draw (F3, owner ruling 11)", () => {
    const stages = buildTemplateStages("groups_ko", { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("group_playoffs emits a FIXED rankRange(1,4) — not driven by the qualified knob", () => {
    const stages = buildTemplateStages("group_playoffs", { qualified: 8, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("every qualification: null site becomes progression: null (mechanical rename)", () => {
    for (const t of STAGE_TEMPLATES) {
      const stages = t.build({ qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
      for (const stage of stages) {
        expect(stage).not.toHaveProperty("qualification");
        expect("progression" in stage).toBe(true);
      }
    }
  });
});

// F3 (day-one fixtures, owner ruling R5): groups_ko's knockout stage used to
// draw from a hand-rolled `picks` interleave hardcoded to pools "A"/"B" —
// with poolCount > 2 (the builder's own pools knob goes up to 8), groups C
// onward produced zero qualifiers. Replaced with the engine's own
// topNPerGroup (+ a bestNth remainder) take. Placement is `rank_order`, NOT
// `snake` (owner ruling 11, found by review before it shipped): `snake` is
// chosen by the TARGET stage's kind, not the source's — t20-super8's `snake`
// is legitimate because its target is a GROUP stage, where reversing
// alternate wave-major pots distributes strength across pools, but a
// KNOCKOUT target must not reverse. generateSingleElim's seedPositions fold
// (scheduling/bracket.ts:52-63, used at :156-163) pairs seed i against seed
// N+1-i, so a reversed pot puts every pool's winner back against its own
// runner-up in round 1 — see the "round 1 never pairs a group against
// itself" describe block below for the draw this used to produce.
describe("groups_ko — cross-pool draw (F3 owner ruling R5, placement per ruling 11)", () => {
  it("qualified:8, poolCount:4 -> topNPerGroup(2) only (evenly divisible), rank_order", () => {
    const stages = buildTemplateStages("groups_ko", { qualified: 8, swissRounds: 5, poolCount: 4, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("qualified:16, poolCount:6 -> topNPerGroup(2) + bestNth(nth:3, count:4) remainder", () => {
    const stages = buildTemplateStages("groups_ko", { qualified: 16, swissRounds: 5, poolCount: 6, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [
        {
          stage: "previous",
          take: [
            { kind: "topNPerGroup", n: 2 },
            { kind: "bestNth", nth: 3, count: 4 },
          ],
        },
      ],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("qualified:3, poolCount:2 -> topNPerGroup(1) + bestNth(nth:2, count:1) remainder", () => {
    const stages = buildTemplateStages("groups_ko", { qualified: 3, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [
        {
          stage: "previous",
          take: [
            { kind: "topNPerGroup", n: 1 },
            { kind: "bestNth", nth: 2, count: 1 },
          ],
        },
      ],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("qualified:2, poolCount:8 (n===0, fewer qualifiers than pools) -> bestNth(nth:1, count:2) only", () => {
    // Reachable from EITHER the Settings tab's free 2-32 qualified input
    // (division-settings.tsx) OR the builder's own dropdown (qualified 2,
    // pools >= 3, division-builder.tsx) — n = floor(2/8) = 0, so
    // topNPerGroup would be a no-op (the engine's expandOne loops
    // `wave <= rule.n`, zero iterations at n=0) and is omitted entirely; the
    // whole take collapses to bestNth(nth:1, count:2) — the best 2
    // pool-winners by cross-pool rank, i.e. "every pool's winner"
    // (topNPerGroup 1) truncated to the qualified count.
    const stages = buildTemplateStages("groups_ko", { qualified: 2, swissRounds: 5, poolCount: 8, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "bestNth", nth: 1, count: 2 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("regression: with poolCount 4, the knockout draws qualifiers from every pool, not just A and B", () => {
    const stages = buildTemplateStages("groups_ko", { qualified: 8, swissRounds: 5, poolCount: 4, legs: 1 });
    const take = stages[1]!.progression!.sources[0]!.take;
    // Before this fix, `take` was `{kind:"picks", picks:[...]}` hardcoded to
    // alternate pools "A"/"B" regardless of poolCount, so with poolCount:4
    // pools C and D never appeared and produced zero qualifiers. Expand the
    // REAL take rule the template now emits against a real 4-pool shape,
    // through the engine's own expandTake, and prove all four pools appear.
    const pots = expandTake(take, { poolKeys: ["A", "B", "C", "D"] });
    const pools = new Set(pots.flat().flatMap((d) => (d.kind === "group_rank" ? [d.pool] : [])));
    expect(pools).toEqual(new Set(["A", "B", "C", "D"]));
  });
});

// Owner ruling 11 (F3 programme index, found by review before it shipped):
// the tests above only check pool MEMBERSHIP of the expanded pots as a Set,
// which is exactly what a draw that pairs every pool against itself in round
// 1 would still pass — snake placement over a knockout target does exactly
// that (snakeMerge reverses alternate wave-major pots, and
// generateSingleElim's seedPositions fold pairs seed i against seed N+1-i,
// bracket.ts:52-63,156-163, so the reversal lands every group against
// itself). Resolve the take through the real placement AND the real
// single-elimination generator instead of re-checking membership.
describe("round 1 never pairs a group against itself", () => {
  // groups_ko's real template output, run through the real engine pipeline:
  // expandSources (take -> pots), placeDescriptors (pots -> seed order,
  // using the template's OWN placement), generateSingleElim (seed order ->
  // round-0 fixtures) — never a hand-rolled reimplementation of the fold.
  function resolveRound1Pools(qualified: number, poolCount: number): [string, string][] {
    const poolKeys = Array.from({ length: poolCount }, (_, i) => String.fromCharCode(65 + i));
    const stages = buildTemplateStages("groups_ko", { qualified, swissRounds: 5, poolCount, legs: 1 });
    const progression = stages[1]!.progression!;
    const pots = expandSources(progression.sources, () => ({ poolKeys }));
    const placed = placeDescriptors(pots, progression.placement, progression.map);
    const poolOf = new Map(
      placed.map((s) => [descriptorKey(s.descriptor), s.descriptor.kind === "group_rank" ? s.descriptor.pool : "?"]),
    );
    const entrants = placed.map((s) => descriptorKey(s.descriptor));
    const { fixtures } = generateSingleElim({ entrants });
    return fixtures
      .filter((f) => f.round === 0)
      .map((f): [string, string] => {
        expect(f.home, "round-1 fixture has no home entrant — pick a qualified count that is a power of two").toBeDefined();
        expect(f.away, "round-1 fixture has no away entrant — pick a qualified count that is a power of two").toBeDefined();
        return [poolOf.get(f.home as string)!, poolOf.get(f.away as string)!];
      });
  }

  it("qualified:8, poolCount:4 — round 1 draws across pools, never within one", () => {
    const pairs = resolveRound1Pools(8, 4);
    expect(pairs).toHaveLength(4);
    for (const [homePool, awayPool] of pairs) expect(homePool).not.toBe(awayPool);
  });

  it("qualified:4, poolCount:2 (the picker's own default) — round 1 draws across pools, never within one", () => {
    const pairs = resolveRound1Pools(4, 2);
    expect(pairs).toHaveLength(2);
    for (const [homePool, awayPool] of pairs) expect(homePool).not.toBe(awayPool);
  });

  it("qualified:16, poolCount:4 — round 1 draws across pools, never within one", () => {
    const pairs = resolveRound1Pools(16, 4);
    expect(pairs).toHaveLength(8);
    for (const [homePool, awayPool] of pairs) expect(homePool).not.toBe(awayPool);
  });

  // Not hypothetical: forcing the same pots through "snake" (what this
  // template emitted before the fix) DOES pair a group against itself —
  // proof the assertions above actually discriminate the bug rather than
  // passing vacuously. A1..D1 stay put, A2..D2 get reversed to D2..A2 by
  // snakeMerge; generateSingleElim then folds seed i against seed N+1-i
  // (bracket.ts:52-63): seed1..4 = A1,B1,C1,D1, seed5..8 = D2,C2,B2,A2, so
  // pair(1,8) = (A1,A2) — a group replaying its own final.
  it("proves the harness actually catches the bug: placement snake DOES pair a group against itself", () => {
    const poolKeys = ["A", "B", "C", "D"];
    const pots = expandSources([{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }], () => ({ poolKeys }));
    const placed = placeDescriptors(pots, "snake");
    const poolOf = new Map(
      placed.map((s) => [descriptorKey(s.descriptor), s.descriptor.kind === "group_rank" ? s.descriptor.pool : "?"]),
    );
    const entrants = placed.map((s) => descriptorKey(s.descriptor));
    const { fixtures } = generateSingleElim({ entrants });
    const round1 = fixtures.filter((f) => f.round === 0);
    const samePoolPairing = round1.some((f) => poolOf.get(f.home as string) === poolOf.get(f.away as string));
    expect(samePoolPairing).toBe(true);
  });
});

// F3 (day-one fixtures, owner ruling R1): every progression-bearing writer
// — the picker's STAGE_TEMPLATES AND the marketing gallery's cannedStages —
// now generates its whole draw (final included) at division setup, never
// waiting on its source stage to complete. A stray "on_complete" here would
// silently reintroduce the "final only appears once group play ends" gap
// this task exists to close.
describe("F3 — every progression-bearing template/family emits timing: setup", () => {
  it("every STAGE_TEMPLATES entry's non-null progression.timing is setup", () => {
    const failures: string[] = [];
    for (const t of STAGE_TEMPLATES) {
      for (const stage of t.build({ qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 })) {
        if (stage.progression && stage.progression.timing !== "setup") {
          failures.push(`${t.key}/${stage.kind}: timing=${stage.progression.timing}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("every gallery family's non-null cannedStages progression.timing is setup", () => {
    const failures: string[] = [];
    for (const f of FORMAT_FAMILIES) {
      for (const stage of f.cannedStages) {
        const progression = stage.progression as { timing?: string } | null;
        if (progression && progression.timing !== "setup") {
          failures.push(`${f.slug}/${stage.kind}: timing=${progression.timing}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
