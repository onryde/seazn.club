// W2c Task 12 fix round 2 (review M-6). A route's own 400 is a validation refusal, so the spec labels it as the
// generator labels every other 400 ("Validation error"), never the catch-all "Error". The POST /stages summary states
// the create's empty-rules semantics, the opposite of the stage PUT: absent, null or `{}` rules KEEP the preset. And it
// names no engine value: the engine's `stageDefaults` owns which deciders a preset turns on, and their lengths.
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS, DRAW_KINDS } from "@seazn/engine/core";
import { deciderKeysFor } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { TIEBREAK_REASON_KEYS } from "@/lib/rule-errors";
import { buildOpenApiDocument } from "../openapi";

type Prop = { type?: unknown; description?: string; items?: { properties?: Record<string, { enum?: string[] }> } };
type Op = {
  summary?: string;
  responses: Record<string, { description: string; content?: { "application/json": { schema: { properties: { error: { properties: Record<string, Prop> } } } } } }>;
};
const opOf = (path: string, method: string): Op =>
  (buildOpenApiDocument().paths as Record<string, Record<string, Op>>)[`/api/v1${path}`]![method]!;

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

  // The refusal claim is the OBSERVABLE one (R-T13-3 made Apply one transaction, so "before the delete" no longer names the
  // mechanism; Task 13b carry): whatever refuses, the stages the division had are still there.
  it("PUT /divisions/{id}/stages documents R-T13-1's points carry and that a refused save leaves the existing stages untouched (Task 13 fix round 1, R-T13-3)", () => {
    const op = (buildOpenApiDocument().paths as Record<string, Record<string, Op>>)["/api/v1/divisions/{id}/stages"]!.put!;
    for (const claim of [
      "A matched slot also keeps its own `points`",
      "or sends `points: null`, which drops it",
      "402 PAYMENT_REQUIRED",
      "409 for a `seq` the body names twice",
      // W2d Task 10: the retired "inexpressible" code gives way to the validator's and coverage's.
      "TIEBREAK_KEY_INVALID",
      "POINTS_OUTCOME_UNCOVERED",
      "a refused save leaves the existing stages untouched",
    ])
      expect(op.summary, claim).toContain(claim);
    expect(op.summary, "the retired mechanism is not claimed").not.toContain("BEFORE the existing graph is deleted");
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(["400", "402", "409", "422"]));
  });

  it("PUT /stages/{id}/rules documents the points arm (W2c Task 13): its body, null, and every refusal by code", () => {
    const op = (buildOpenApiDocument().paths as Record<string, Record<string, Op>>)["/api/v1/stages/{id}/rules"]!.put!;
    for (const claim of [
      "`points`",
      "`points: null` removes",
      "RULE_NOT_SETTABLE (`field` `points`)",
      "`points.forfeit.awardScore`",
      "422 POINTS_OUTCOME_UNCOVERED (`uncovered`)",
      "402 PAYMENT_REQUIRED",
      "`competitions.max_active`",
      "bonuses and a forfeit row are free on every plan",
    ])
      expect(op.summary, claim).toContain(claim);
    expect(op.summary, "W2d T10: the retired code is not claimed").not.toMatch(/INEXPRESSIBLE|POINTS_MAP_INCOMPLETE/);
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(["400", "402", "409", "422"]));
  });

  // Batch 4 review M1. The summary said a decider on a table stage is RULE_NOT_SETTABLE; that is false for every sport whose
  // decider key is not narrowed to knockouts (football's extra time, the period sports' overtime and shoot-out, cricket's
  // super over, carrom's tie board). The truth is read from the engine's own key declarations, never typed here.
  it("PUT /stages/{id}/rules: only a KNOCKOUT-ONLY decider is refused on a table stage (batch 4 M1), read from the engine's declarations", () => {
    const sports = (m: (typeof builtinModules)[number]) => m as unknown as Parameters<typeof deciderKeysFor>[0];
    const onTable: string[] = [];
    const knockoutOnly: string[] = [];
    for (const m of builtinModules) {
      const settableOnATable = [...DRAW_KINDS].some((k) => Object.keys(m.variants).some((v) => deciderKeysFor(sports(m), k, v).length > 0));
      if (settableOnATable) onTable.push(m.key);
      const kos = Object.values(m.ruleKeys ?? {}).some((f) => f.decider === true && f.appliesTo?.stageKinds !== undefined && f.appliesTo.stageKinds.every((k) => BRACKET_KINDS.has(k)));
      if (kos) knockoutOnly.push(m.key);
    }
    // Both halves of the sentence are true of some sport: a bare "a decider on a table stage" would be false for the first.
    expect(onTable.length, "anti-vacuity: sports whose decider a table stage may set").toBeGreaterThan(0);
    expect(knockoutOnly.length, "anti-vacuity: sports with a knockout-only decider").toBeGreaterThan(0);
    const { summary } = opOf("/stages/{id}/rules", "put");
    expect(summary).toContain("a knockout-only decider on a table stage");
    expect(summary, "a decider on a table stage is not refused as such").not.toMatch(/(?<!knockout-only )decider on a table stage/);
  });

  // Batch 4 review M2. A stage's own `config.points` rides the create, so the create answers the points questions (and the
  // 402s) the stage PUT answers.
  it("POST /divisions/{id}/stages documents the points refusals and the 402 it can raise (batch 4 M2)", () => {
    const op = opOf("/divisions/{id}/stages", "post");
    for (const claim of [
      "`config.points`",
      "`config.points: null` means no points for this slot",
      "RULE_NOT_SETTABLE (`field` `points`)",
      "`points.forfeit.awardScore`",
      "422 POINTS_OUTCOME_UNCOVERED (`uncovered`, `stage_name`)",
      "422 TIEBREAK_KEY_INVALID (`refusals`, `stage_id`, `stage_name`) for the INHERITED tie-break order",
      "`config.tiebreakers` is an unknown key of the strict stage config: 400 VALIDATION",
      "402 PAYMENT_REQUIRED",
      "A stage's own points ask no plan feature",
    ])
      expect(op.summary, claim).toContain(claim);
    expect(op.summary, "W2d T10: the retired codes are not claimed").not.toMatch(/INEXPRESSIBLE|POINTS_MAP_INCOMPLETE/);
    expect(Object.keys(op.responses), "402 is a response the create can raise").toEqual(expect.arrayContaining(["400", "402", "409", "422"]));
  });

  // Batch 4 review M3, W2d Task 10. The division save re-asks the stages that stand: an order the validator refuses is 422
  // TIEBREAK_KEY_INVALID (`refusals`), a save leaving a stage's points short of an outcome 422 POINTS_OUTCOME_UNCOVERED
  // (`uncovered`); a pinned stage keeps its rules and is named in `stagesKeptPinned`. W2c's `keys` is retired with its code.
  it("PATCH /divisions/{id} documents the validator's and coverage's 422s with their envelope fields, and stagesKeptPinned (W2d T10)", () => {
    const op = opOf("/divisions/{id}", "patch");
    for (const claim of ["422 TIEBREAK_KEY_INVALID", "422 POINTS_OUTCOME_UNCOVERED", "`refusals`", "`uncovered`", "`stagesKeptPinned`"])
      expect(op.summary, claim).toContain(claim);
    expect(op.summary, "the retired codes are not claimed").not.toMatch(/INEXPRESSIBLE|POINTS_MAP_INCOMPLETE/);
    const error = op.responses["422"]!.content!["application/json"].schema.properties.error.properties;
    expect(error.keys, "W2c's `keys` is gone with its code").toBeUndefined();
    expect(error.refusals?.type, "the 422 envelope names `refusals`").toBe("array");
    expect(error.uncovered?.type, "and `uncovered`").toBe("array");
    // The reasons the envelope documents are the ones the app says (rule-errors-copy pins those to the engine's own).
    const reasons = error.refusals?.items?.properties?.reason?.enum ?? [];
    expect([...reasons].sort(), "the documented reasons are the app's (counted)").toEqual(Object.keys(TIEBREAK_REASON_KEYS).sort());
    expect(reasons.length).toBeGreaterThan(0);
    // The other statuses do not claim them.
    expect(op.responses["409"]!.content!["application/json"].schema.properties.error.properties.refusals).toBeUndefined();
  });
});
