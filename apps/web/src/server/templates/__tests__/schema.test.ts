// CompetitionTemplate zod schema (D1a design doc, P4; `seeding` added P7
// with D4's StageSeeding; unified onto `progression` by F2).
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { CompetitionTemplate, type TemplateStageProgression } from "../schema";

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

  it("a stage with no `progression` still parses (the field is optional — existing single-stage templates are unaffected)", () => {
    const parsed = CompetitionTemplate.parse(MINIMAL_VALID);
    expect(parsed.divisions[0]!.stages[0]!.progression).toBeUndefined();
  });

  it("accepts a stage's progression.sources[].stage: \"previous\" (F2 unified field — imported from api-v1/schemas.ts, never redeclared)", () => {
    const withProgression = {
      ...MINIMAL_VALID,
      divisions: [
        {
          ...MINIMAL_VALID.divisions[0],
          stages: [
            {
              i18nNameKey: "templates.stage.x",
              kind: "knockout",
              progression: {
                sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
                placement: "rank_order",
                timing: "on_complete",
              },
            },
          ],
        },
      ],
    };
    const parsed = CompetitionTemplate.parse(withProgression);
    const progression = parsed.divisions[0]!.stages[0]!.progression;
    expect(progression?.sources).toEqual([{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }]);
    expect(progression?.placement).toBe("rank_order");
    expect(progression?.timing).toBe("on_complete");
  });

  it("rejects progression missing `timing` — no default, strict from day one (ruling 5)", () => {
    const withoutTiming = {
      ...MINIMAL_VALID,
      divisions: [
        {
          ...MINIMAL_VALID.divisions[0],
          stages: [
            {
              i18nNameKey: "templates.stage.x",
              kind: "knockout",
              progression: {
                sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
                placement: "rank_order",
              },
            },
          ],
        },
      ],
    };
    expect(() => CompetitionTemplate.parse(withoutTiming)).toThrow();
  });

  it("rejects a progression source naming a live {stageId} — a catalog template has no live stage id to reference yet (P7 caveat, carried forward)", () => {
    const withLiveStageId = {
      ...MINIMAL_VALID,
      divisions: [
        {
          ...MINIMAL_VALID.divisions[0],
          stages: [
            {
              i18nNameKey: "templates.stage.x",
              kind: "knockout",
              progression: {
                sources: [{ stage: { stageId: randomUUID() }, take: [{ kind: "rankRange", from: 1, to: 4 }] }],
                placement: "rank_order",
                timing: "on_complete",
              },
            },
          ],
        },
      ],
    };
    expect(() => CompetitionTemplate.parse(withLiveStageId)).toThrow();
  });

  it("rejects a MULTI-source progression where only one source names a live {stageId} — every source must be \"previous\"", () => {
    const mixed = {
      ...MINIMAL_VALID,
      divisions: [
        {
          ...MINIMAL_VALID.divisions[0],
          stages: [
            {
              i18nNameKey: "templates.stage.x",
              kind: "knockout",
              progression: {
                sources: [
                  { stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] },
                  { stage: { stageId: randomUUID() }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
                ],
                placement: "rank_order",
                timing: "on_complete",
              },
            },
          ],
        },
      ],
    };
    expect(() => CompetitionTemplate.parse(mixed)).toThrow();
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
  it("type-level: TemplateStageProgression['sources'][number]['stage'] is narrowed to the \"previous\" literal, not the wider union (tsc-enforced, not vitest-enforced)", () => {
    type NarrowedSource = TemplateStageProgression["sources"][number];
    const valid = (): NarrowedSource["stage"] => "previous";
    const bogus = (): NarrowedSource["stage"] => {
      // @ts-expect-error — a {stageId} live-stage-id reference is not
      // assignable to the narrowed "previous" literal (see schema.ts's
      // TemplateStageProgression `.refine()` type-predicate).
      return { stageId: randomUUID() };
    };
    expect(typeof valid).toBe("function");
    expect(typeof bogus).toBe("function");
  });
});
