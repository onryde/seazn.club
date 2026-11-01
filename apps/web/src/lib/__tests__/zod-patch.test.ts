// patchOf — the PATCH twin of a create schema (fix/patch-schema-partial-defaults, 2026-11-01). The sweep over every
// real PATCH body is server/api-v1/__tests__/patch-omitted-fields.test.ts; this file pins the helper's own contract on
// the shapes that sweep does not reach (a prefault, a strict object, a refined one).
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { patchOf } from "../zod-patch";

const Create = z.object({
  name: z.string().min(1),
  sort: z.number().int().default(0),
  tags: z.array(z.string()).min(1).default(["any"]),
  mode: z.enum(["a", "b"]).prefault("a"),
  note: z.string().nullish(),
});

describe("patchOf", () => {
  it("an empty body stays empty, where .partial() fills every default (the bug, as the positive pair)", () => {
    expect(Create.partial().parse({})).toEqual({ sort: 0, tags: ["any"], mode: "a" });
    expect(patchOf(Create).parse({})).toEqual({});
  });

  it("a body naming one field parses to exactly that field, still validated", () => {
    const Patch = patchOf(Create);
    expect(Patch.parse({ name: "x" })).toEqual({ name: "x" });
    expect(Patch.parse({ sort: 0 })).toEqual({ sort: 0 }); // an explicit default value is still written
    expect(Patch.parse({ note: null })).toEqual({ note: null });
    expect(Patch.safeParse({ tags: [] }).success).toBe(false); // the field's own rules survive the unwrap
    expect(Patch.safeParse({ name: "" }).success).toBe(false);
  });

  it("types every field optional, with the default's inner type (checked by tsc, not at run time)", () => {
    expectTypeOf(patchOf(Create).parse({})).toEqualTypeOf<{
      name?: string;
      sort?: number;
      tags?: string[];
      mode?: "a" | "b";
      note?: string | null;
    }>();
  });

  it("leaves the create schema's defaults alone", () => {
    patchOf(Create);
    expect(Create.parse({ name: "x" })).toEqual({ name: "x", sort: 0, tags: ["any"], mode: "a" });
  });

  it("keeps a strict object strict, and refuses an object with refinements as .partial() does", () => {
    const Strict = z.strictObject({ a: z.number().default(1) });
    expect(patchOf(Strict).parse({})).toEqual({});
    expect(patchOf(Strict).safeParse({ b: 1 }).success).toBe(false);
    const Refined = z.object({ a: z.number().default(1) }).refine(() => true);
    expect(() => patchOf(Refined)).toThrow(/refinements/);
  });
});
