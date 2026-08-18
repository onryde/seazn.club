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
import { expandTake } from "@seazn/engine/competition";

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

  it("groups_ko emits topNPerGroup, snake, setup — the cross-pool draw (F3)", () => {
    const stages = buildTemplateStages("groups_ko", { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
      placement: "snake",
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
// topNPerGroup (+ a bestNth remainder) and snake placement — euro24's take
// shape, t20-super8's placement (server/templates/catalog/*.json) — so the
// draw is correct for whatever poolCount the organiser picks.
describe("groups_ko — cross-pool draw (F3 owner ruling R5)", () => {
  it("qualified:8, poolCount:4 -> topNPerGroup(2) only (evenly divisible), snake", () => {
    const stages = buildTemplateStages("groups_ko", { qualified: 8, swissRounds: 5, poolCount: 4, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
      placement: "snake",
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
      placement: "snake",
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
      placement: "snake",
      timing: "setup",
    });
  });

  it("qualified:2, poolCount:8 (n===0, fewer qualifiers than pools) -> bestNth(nth:1, count:2) only", () => {
    // Reachable: the Settings tab's qualified input is a free 2-32 integer
    // with no ratio constraint against poolCount (division-settings.tsx).
    // n = floor(2/8) = 0, so topNPerGroup would be a no-op (the engine's
    // expandOne loops `wave <= rule.n`, zero iterations at n=0) and is
    // omitted entirely; the whole take collapses to bestNth(nth:1, count:2)
    // — the best 2 pool-winners by cross-pool rank, i.e. "every pool's
    // winner" (topNPerGroup 1) truncated to the qualified count.
    const stages = buildTemplateStages("groups_ko", { qualified: 2, swissRounds: 5, poolCount: 8, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "bestNth", nth: 1, count: 2 }] }],
      placement: "snake",
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
