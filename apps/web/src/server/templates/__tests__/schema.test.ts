// CompetitionTemplate zod schema (D1a design doc, P4; `seeding` added P7
// with D4's StageSeeding).
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { CompetitionTemplate } from "../schema";

const MINIMAL_VALID = {
  key: "slam128",
  version: 1,
  i18n: { nameKey: "templates.slam128.name", descriptionKey: "templates.slam128.desc" },
  divisions: [
    {
      i18nNameKey: "templates.slam128.div.main",
      sportKey: "tennis",
      variantKey: "grand-slam",
      entrantKind: "individual",
      entrantCount: 128,
      stages: [{ i18nNameKey: "templates.stage.mainDraw", kind: "knockout", size: 128 }],
    },
  ],
};

describe("CompetitionTemplate schema", () => {
  it("parses a minimal valid template", () => {
    const parsed = CompetitionTemplate.parse(MINIMAL_VALID);
    expect(parsed.key).toBe("slam128");
    expect(parsed.divisions[0]!.stages[0]!.kind).toBe("knockout");
  });

  it("rejects a stage kind the API StageKind enum does not admit", () => {
    const bad = {
      ...MINIMAL_VALID,
      divisions: [
        {
          ...MINIMAL_VALID.divisions[0],
          stages: [{ i18nNameKey: "templates.stage.x", kind: "round_robin_extreme" }],
        },
      ],
    };
    expect(() => CompetitionTemplate.parse(bad)).toThrow();
  });

  it("rejects a template missing i18n keys (no hardcoded English allowed)", () => {
    const bad = { ...MINIMAL_VALID, i18n: undefined };
    expect(() => CompetitionTemplate.parse(bad)).toThrow();
  });

  it("a stage with no `seeding` still parses (the field is optional — existing single-stage templates are unaffected)", () => {
    const parsed = CompetitionTemplate.parse(MINIMAL_VALID);
    expect(parsed.divisions[0]!.stages[0]!.seeding).toBeUndefined();
  });

  it("accepts a stage's seeding.source: \"previous\" (P7, D4's StageSeeding — imported from api-v1/schemas.ts, never redeclared)", () => {
    const withSeeding = {
      ...MINIMAL_VALID,
      divisions: [
        {
          ...MINIMAL_VALID.divisions[0],
          stages: [
            {
              i18nNameKey: "templates.stage.x",
              kind: "knockout",
              seeding: {
                source: "previous",
                take: [{ kind: "rankRange", from: 1, to: 4 }],
                placement: "rank_order",
              },
            },
          ],
        },
      ],
    };
    const parsed = CompetitionTemplate.parse(withSeeding);
    const seeding = parsed.divisions[0]!.stages[0]!.seeding;
    expect(seeding?.source).toBe("previous");
    expect(seeding?.take).toEqual([{ kind: "rankRange", from: 1, to: 4 }]);
    expect(seeding?.placement).toBe("rank_order");
  });

  it("rejects seeding.source: {stageId} — a catalog template has no live stage id to reference yet (P7 caveat)", () => {
    const withLiveStageId = {
      ...MINIMAL_VALID,
      divisions: [
        {
          ...MINIMAL_VALID.divisions[0],
          stages: [
            {
              i18nNameKey: "templates.stage.x",
              kind: "knockout",
              seeding: {
                source: { stageId: randomUUID() },
                take: [{ kind: "rankRange", from: 1, to: 4 }],
                placement: "rank_order",
              },
            },
          ],
        },
      ],
    };
    expect(() => CompetitionTemplate.parse(withLiveStageId)).toThrow();
  });
});
