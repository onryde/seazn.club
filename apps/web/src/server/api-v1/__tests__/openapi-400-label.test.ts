// W2c Task 12 fix round 2 (review M-6). A route's own 400 is a validation refusal, so the spec labels it as the
// generator labels every other 400 ("Validation error"), never the catch-all "Error". The POST /stages summary states
// the create's empty-rules semantics, the opposite of the stage PUT: absent, null or `{}` rules KEEP the preset. And it
// names no engine value: the engine's `stageDefaults` owns which deciders a preset turns on, and their lengths.
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../openapi";

type Op = { summary?: string; responses: Record<string, { description: string }> };

describe("OpenAPI — 400s are validation errors; POST /stages documents the create's empty-rules semantics", () => {
  for (const [label, doc] of [
    ["full", buildOpenApiDocument()],
    ["published", buildOpenApiDocument({ published: true })],
  ] as const) {
    it(`${label}: every operation's 400 reads "Validation error" (counted)`, () => {
      let checked = 0;
      for (const [path, methods] of Object.entries(doc.paths as Record<string, Record<string, Op>>)) {
        for (const [method, op] of Object.entries(methods)) {
          const r400 = op.responses?.["400"];
          if (r400 === undefined) continue;
          expect(r400.description, `${method.toUpperCase()} ${path}`).toBe("Validation error");
          checked++;
        }
      }
      expect(checked, "anti-vacuity").toBeGreaterThan(0);
    });
  }

  it("POST /divisions/{id}/stages: absent, null or {} rules keep the preset, and no engine value is typed into the summary", () => {
    const op = (buildOpenApiDocument().paths as Record<string, Record<string, Op>>)["/api/v1/divisions/{id}/stages"]!.post!;
    expect(op.summary).toContain("absent, null or `{}` at create KEEPS the whole preset");
    for (const value of ["2x15", "5-kick", "(3 in the youth"]) expect(op.summary, value).not.toContain(value);
  });

  it("PUT /divisions/{id}/stages documents R-T12-4's carry: a matched slot keeps its stored rules in place of its preset (Task 12 re-review N-2)", () => {
    const op = (buildOpenApiDocument().paths as Record<string, Record<string, Op>>)["/api/v1/divisions/{id}/stages"]!.put!;
    expect(op.summary).toContain("keeps the rules it already stored IN PLACE OF its preset");
    expect(op.summary).toContain("a preset key the organiser removed stays removed");
    expect(op.summary).toContain("a new slot, or one whose kind changed, starts from its own kind's preset");
  });

  it("PUT /stages/{id}/rules documents the points arm (W2c Task 13): its body, null, and every refusal by code", () => {
    const op = (buildOpenApiDocument().paths as Record<string, Record<string, Op>>)["/api/v1/stages/{id}/rules"]!.put!;
    for (const claim of [
      "`points`",
      "`points: null` removes",
      "RULE_NOT_SETTABLE (`field` `points`)",
      "`points.forfeit.awardScore`",
      "422 POINTS_RULE_INEXPRESSIBLE (`keys` names the split keys)",
      "402 PAYMENT_REQUIRED",
      "`standings.custom_points`",
    ])
      expect(op.summary, claim).toContain(claim);
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(["400", "402", "409", "422"]));
  });
});
