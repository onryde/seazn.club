import { describe, expect, it } from "vitest";
import { BRACKET_STAGE_KINDS } from "../competition/progression.ts";
import { BRACKET_KINDS, DRAW_KINDS, StageKind, forbidsLevelResult, isLevelOutcome } from "./types.ts";

describe("X-DR-1: stage-kind sets (spec §5.4.1, ruling 78)", () => {
  it("empty case first: no kind, null and undefined are not bracket kinds; null is not a level outcome", () => {
    expect(forbidsLevelResult("")).toBe(false);
    expect(forbidsLevelResult(null)).toBe(false);
    expect(forbidsLevelResult(undefined)).toBe(false);
    expect(isLevelOutcome(null)).toBe(false);
    expect(isLevelOutcome(undefined)).toBe(false);
  });
  it("BRACKET_KINDS and DRAW_KINDS are disjoint and together are every StageKind the engine declares", () => {
    const all = StageKind.options;
    expect(all.length).toBeGreaterThan(0);
    for (const k of all) expect(BRACKET_KINDS.has(k) !== DRAW_KINDS.has(k), k).toBe(true);
    expect(BRACKET_KINDS.size + DRAW_KINDS.size).toBe(all.length);
  });
  it("BRACKET_KINDS is the bracket-shape set plus ladder (finding 5)", () => {
    expect(new Set(BRACKET_KINDS)).toEqual(new Set([...BRACKET_STAGE_KINDS, "ladder"]));
  });
  it("forbidsLevelResult agrees with the set for every declared kind and refuses an unknown string", () => {
    let checked = 0;
    for (const k of StageKind.options) {
      expect(forbidsLevelResult(k), k).toBe(BRACKET_KINDS.has(k));
      checked++;
    }
    expect(forbidsLevelResult("knock_out")).toBe(false);
    expect(checked).toBe(StageKind.options.length);
  });
  it("isLevelOutcome is true exactly for draw, tie and no_result", () => {
    expect(isLevelOutcome({ kind: "draw" })).toBe(true);
    expect(isLevelOutcome({ kind: "tie" })).toBe(true);
    expect(isLevelOutcome({ kind: "no_result" })).toBe(true);
    expect(isLevelOutcome({ kind: "win", winner: "H", loser: "A" })).toBe(false);
    expect(isLevelOutcome({ kind: "award", winner: "H" })).toBe(false);
  });
});
