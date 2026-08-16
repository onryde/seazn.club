// CompetitionTemplate zod schema (D1a design doc, P4; `seeding` added P7
// with D4's StageSeeding).
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { CompetitionTemplate, type TemplateStageSeeding } from "../schema";

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

  // Review finding: the runtime `.toThrow()` above only proves the parse-time
  // check. It says nothing about the INFERRED type — a refactor that drops
  // the `.refine()` type-predicate overload in schema.ts (keeping only a
  // plain boolean-returning refine) would leave every runtime test green
  // while the compile-time guarantee silently vanished. This closure is
  // never called (mirrors credits-admin-adjust.test.ts's "confined to the
  // allowlist" pattern) — the directive below becomes an UNUSED
  // `@ts-expect-error` and fails `tsc` with TS2578 the moment the narrowing
  // is lost, which is the actual enforcement; the `expect` calls only
  // confirm both closures still compile as functions today.
  it("type-level: TemplateStageSeeding['source'] is narrowed to the \"previous\" literal, not the wider union (tsc-enforced, not vitest-enforced)", () => {
    const valid = (): TemplateStageSeeding["source"] => "previous";
    const bogus = (): TemplateStageSeeding["source"] => {
      // @ts-expect-error — a {stageId} live-stage-id reference is not
      // assignable to the narrowed "previous" literal (see schema.ts's
      // TemplateStageSeeding `.refine()` type-predicate).
      return { stageId: randomUUID() };
    };
    expect(typeof valid).toBe("function");
    expect(typeof bogus).toBe("function");
  });
});
