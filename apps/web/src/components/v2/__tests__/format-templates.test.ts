// L3/#414 pass 3: two new one-click stage-graph templates — KO+Plate
// (losersOfRound) and Qualifying+Main (topN over placements) — and their
// detectTemplate round-trip. Pure, no DB.
//
// F2 (unified progression field): every `qualification:` literal below was
// rewritten onto `progression:` in lockstep with format-templates.ts's own
// StageDraft/STAGE_TEMPLATES conversion — losersOfRound -> roundLosers,
// topN:n -> rankRange{from:1,to:n}, both wrapped in {sources,placement,
// timing}. `timing` is always "on_complete" here: every one of these
// templates reproduces today's auto-seed-on-complete behaviour exactly
// (F2 plan Decision 1), never the propose/confirm "setup" flow.
import { describe, expect, it } from "vitest";
import { STAGE_TEMPLATES, buildTemplateStages, detectTemplate } from "../format-templates";

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
        timing: "on_complete",
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
        timing: "on_complete",
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
            timing: "on_complete",
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
  it("league_ko emits rankRange, on_complete — the topN replacement, unchanged behaviour", () => {
    const stages = buildTemplateStages("league_ko", { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
    const finals = stages[1]!;
    expect(finals.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "on_complete",
    });
  });

  it("ko_plate still emits roundLosers, on_complete — unchanged, F3 owns flipping timing to setup", () => {
    const stages = buildTemplateStages("ko_plate", { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 4 }] }],
      placement: "rank_order",
      timing: "on_complete",
    });
  });

  it("detectTemplate reads rankRange, not topN — round-trips through the new field", () => {
    const stages = buildTemplateStages("qualifying_main", { qualified: 8, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(detectTemplate(stages)).toBe("qualifying_main");
  });

  it("groups_ko emits picks, on_complete — the pool/rank picker, unchanged", () => {
    const stages = buildTemplateStages("groups_ko", { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [
        {
          stage: "previous",
          take: [
            {
              kind: "picks",
              picks: [
                { pool: "A", rank: 1 },
                { pool: "B", rank: 1 },
                { pool: "A", rank: 2 },
                { pool: "B", rank: 2 },
              ],
            },
          ],
        },
      ],
      placement: "rank_order",
      timing: "on_complete",
    });
  });

  it("group_playoffs emits a FIXED rankRange(1,4) — not driven by the qualified knob", () => {
    const stages = buildTemplateStages("group_playoffs", { qualified: 8, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "on_complete",
    });
  });

  it("every qualification: null site becomes progression: null (mechanical rename)", () => {
    for (const t of STAGE_TEMPLATES) {
      const stages = t.build(4);
      for (const stage of stages) {
        expect(stage).not.toHaveProperty("qualification");
        expect("progression" in stage).toBe(true);
      }
    }
  });
});
