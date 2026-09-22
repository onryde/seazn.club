// apps/web/src/server/api-v1/__tests__/generate-stage-input.test.ts
import { describe, expect, it } from "vitest";
import { GenerateStageInput } from "@/server/api-v1/schemas";

describe("GenerateStageInput", () => {
  it("empty object is valid (the desk sends {})", () => expect(GenerateStageInput.parse({})).toEqual({}));
  it.each(["fold", "rank_adjacent"])("accepts %s", (p) =>
    expect(GenerateStageInput.parse({ pairing: p })).toEqual({ pairing: p }));
  it("rejects an unknown mode", () => expect(() => GenerateStageInput.parse({ pairing: "dutch" })).toThrow());
  it("rejects unknown keys (typo guard)", () => expect(() => GenerateStageInput.parse({ paring: "fold" })).toThrow());
});
