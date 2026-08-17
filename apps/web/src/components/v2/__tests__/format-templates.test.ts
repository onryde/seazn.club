// L3/#414 pass 3: two new one-click stage-graph templates — KO+Plate
// (losersOfRound) and Qualifying+Main (topN over placements) — and their
// detectTemplate round-trip. Pure, no DB.
import { describe, expect, it } from "vitest";
import { STAGE_TEMPLATES, buildTemplateStages, detectTemplate } from "../format-templates";

describe("ko_plate template", () => {
  it("builds a main knockout + a plate seeded by losersOfRound, count = the qualified knob", () => {
    const stages = buildTemplateStages("ko_plate", {
      qualified: 4,
      swissRounds: 5,
      poolCount: 2,
      legs: 1,
    });
    expect(stages).toHaveLength(2);
    expect(stages[0]).toMatchObject({ kind: "knockout", qualification: null });
    expect(stages[1]).toMatchObject({
      kind: "knockout",
      qualification: { losersOfRound: { round: 1, count: 4 } },
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
  it("builds a qualifying knockout + a main draw seeded by topN, count = the qualified knob", () => {
    const stages = buildTemplateStages("qualifying_main", {
      qualified: 8,
      swissRounds: 5,
      poolCount: 2,
      legs: 1,
    });
    expect(stages).toHaveLength(2);
    expect(stages[0]).toMatchObject({ kind: "knockout", qualification: null });
    expect(stages[1]).toMatchObject({ kind: "knockout", qualification: { topN: 8 } });
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

  it("is distinguishable from ko_plate — same kind sequence, different qualification shape", () => {
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

  it("an unrecognised graph returns null (custom) — same kinds, neither losersOfRound nor topN", () => {
    expect(
      detectTemplate([
        { kind: "knockout", config: {} },
        { kind: "knockout", config: {}, qualification: { take: [{ pool: "A", rank: 1 }] } },
      ]),
    ).toBeNull();
  });
});
