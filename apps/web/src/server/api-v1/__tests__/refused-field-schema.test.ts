// W2c Task 12 — `RefusedFieldS` (schemas.ts, the OpenAPI wire shape of PATCH /divisions/{id}'s `refused`) pinned to
// `RefusedField` (lib/rule-errors.ts, what the usecase returns and `http.ts` forwards). schemas.ts may not import
// rule-errors.ts (openapi-gen runs it under bare strip-types, no `@/`), so the two are written twice and tied here:
// the type both ways (tsc), both codes (a `satisfies` table tsc holds exhaustive), every key, and the value level
// through the one reader the wire has (`refusedFieldsOf`).
import { randomUUID } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { refusedFieldsOf, type RefusedField } from "@/lib/rule-errors";
import { PatchedDivision, RefusedFieldS } from "@/server/api-v1/schemas";

/** Every code a refused field can carry — tsc refuses a missing one and an extra one (`satisfies` over the union). */
const CODES = { DIVISION_FORMAT_LOCKED: true, DIVISION_TABLE_RULES_LOCKED: true } satisfies Record<RefusedField["code"], true>;

const entry = (code: RefusedField["code"]): RefusedField => ({ field: "points", code, stageId: randomUUID(), stageName: "Groups" });

describe("RefusedFieldS is RefusedField on the wire", () => {
  it("the types agree both ways", () => {
    expectTypeOf<z.infer<typeof RefusedFieldS>>().toEqualTypeOf<RefusedField>();
  });

  it("the schema's codes are exactly the type's codes", () => {
    const declared = Object.keys(CODES).sort();
    expect(declared.length, "anti-vacuity: codes checked").toBe(2);
    expect([...RefusedFieldS.shape.code.options].sort()).toEqual(declared);
  });

  it("every code round-trips: the reader keeps it and the schema parses what the reader keeps, unchanged", () => {
    let checked = 0;
    for (const code of Object.keys(CODES) as RefusedField["code"][]) {
      const sent = entry(code);
      const read = refusedFieldsOf({ refused: [{ ...sent, extra: "dropped" }] });
      expect(read, code).toEqual([sent]);
      expect(RefusedFieldS.parse(read![0])).toEqual(sent);
      // Every key, both sides: the reader's output keys are the schema's keys.
      expect(Object.keys(read![0]!).sort()).toEqual(Object.keys(RefusedFieldS.shape).sort());
      checked++;
    }
    expect(checked, "anti-vacuity: codes round-tripped").toBe(2);
  });

  it("empty case: no refused list, an empty one, or only malformed entries read as null; the schema refuses a stray code", () => {
    expect(refusedFieldsOf(undefined)).toBeNull();
    expect(refusedFieldsOf({ refused: [] })).toBeNull();
    expect(refusedFieldsOf({ refused: [{ ...entry("DIVISION_FORMAT_LOCKED"), code: "CONFIG_INVALID" }] })).toBeNull();
    expect(RefusedFieldS.safeParse({ ...entry("DIVISION_FORMAT_LOCKED"), code: "CONFIG_INVALID" }).success).toBe(false);
  });

  it("PatchedDivision's refused is a list of them (and [] when nothing was refused)", () => {
    const shape = PatchedDivision.shape.refused;
    expect(shape.safeParse([]).success).toBe(true);
    expect(shape.parse([entry("DIVISION_TABLE_RULES_LOCKED")])).toHaveLength(1);
    expect(shape.safeParse(undefined).success, "refused is always sent").toBe(false);
  });
});
