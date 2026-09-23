// apps/web/src/server/api-v1/__tests__/generate-stage-input.test.ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GenerateStageInput } from "@/server/api-v1/schemas";

describe("GenerateStageInput", () => {
  it("empty object is valid (the desk sends {})", () => expect(GenerateStageInput.parse({})).toEqual({}));
  it.each(["fold", "rank_adjacent"])("accepts %s", (p) =>
    expect(GenerateStageInput.parse({ pairing: p })).toEqual({ pairing: p }));
  // `.toThrow(z.ZodError)`, never bare `.toThrow()`: a bare one is satisfied by
  // the TypeError from `undefined.parse`, so it passed with no schema at all.
  it("rejects an unknown mode", () =>
    expect(() => GenerateStageInput.parse({ pairing: "dutch" })).toThrow(z.ZodError));
  it("rejects unknown keys (typo guard)", () =>
    expect(() => GenerateStageInput.parse({ paring: "fold" })).toThrow(z.ZodError));
});
