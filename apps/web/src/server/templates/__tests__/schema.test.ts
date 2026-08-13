// CompetitionTemplate zod schema (D1a design doc, P4). No `seeding` field yet
// — that lands in P7 with D4's StageSeeding.
import { describe, expect, it } from "vitest";
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

  it("has no `seeding` field on a stage — that lands in P7 with D4", () => {
    // A stage carrying `seeding` should still parse (zod objects don't strip
    // unknown keys by default... but the FIELD must not be part of the typed
    // shape). Assert the inferred TS shape has no seeding key by checking the
    // schema's shape keys directly (structural, not runtime-guessable).
    const stageShape = CompetitionTemplate.shape.divisions.element.shape.stages.element.shape;
    expect(Object.keys(stageShape)).not.toContain("seeding");
  });
});
