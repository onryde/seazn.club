// L3/#414 pass 2 — pure, DB-free coverage for the boundary parsing
// `completeStageIfReady`'s bracket branch depends on: `ext_key` is the only
// place bracket lane (WB/LB/GF) and thirdPlace survive persistence (spec 05
// §2.3/§2.4 — bracket.ts's fixture ids, never a DB column), so this must be
// PARSED, never re-derived from round/position; and `stage.kind` arrives from
// the DB as a raw string that must be validated into the engine's StageKind
// before anything trusts it. No DATABASE_URL needed — runs in every CI leg,
// unlike the DB-gated integration suite.
import { describe, expect, it } from "vitest";
import { EngineError } from "@seazn/engine/core";
import { bracketWinnerLoser, parseExtKey, parseStageKind } from "../competition";

describe("parseExtKey", () => {
  it("names no lane for a null ext_key", () => {
    expect(parseExtKey(null)).toEqual({ thirdPlace: false });
  });

  it("names no lane for a standalone single-elim round/index key", () => {
    expect(parseExtKey("se-r0-i0")).toEqual({ thirdPlace: false });
    expect(parseExtKey("se-r1-i0")).toEqual({ thirdPlace: false });
  });

  it("reads thirdPlace off the se-3p suffix, never off round arithmetic", () => {
    expect(parseExtKey("se-3p")).toEqual({ thirdPlace: true });
  });

  it("reads the WB lane off a wb- prefix", () => {
    expect(parseExtKey("wb-r0-i0")).toEqual({ bracket: "WB", thirdPlace: false });
  });

  it("reads the LB lane off an lb- prefix", () => {
    expect(parseExtKey("lb-r1-i2")).toEqual({ bracket: "LB", thirdPlace: false });
  });

  it("reads the GF lane off the grand final and its bracket-reset game", () => {
    expect(parseExtKey("gf")).toEqual({ bracket: "GF", thirdPlace: false });
    expect(parseExtKey("gf-reset")).toEqual({ bracket: "GF", thirdPlace: false });
  });

  it("names no lane for stepladder or page-playoff keys", () => {
    expect(parseExtKey("sl-g0")).toEqual({ thirdPlace: false });
    expect(parseExtKey("pp-q1")).toEqual({ thirdPlace: false });
    expect(parseExtKey("pp-final")).toEqual({ thirdPlace: false });
  });
});

describe("bracketWinnerLoser", () => {
  it("is empty for a null/undecided outcome", () => {
    expect(bracketWinnerLoser(null, "A", "B")).toEqual({});
  });

  it("names both sides straight off a win outcome", () => {
    expect(bracketWinnerLoser({ kind: "win", winner: "A", loser: "B" }, "A", "B")).toEqual({
      winner: "A",
      loser: "B",
    });
  });

  it("derives the loser as the OTHER home/away side for an award (walkover) outcome", () => {
    expect(bracketWinnerLoser({ kind: "award", winner: "A" }, "A", "B")).toEqual({
      winner: "A",
      loser: "B",
    });
    expect(bracketWinnerLoser({ kind: "award", winner: "B" }, "A", "B")).toEqual({
      winner: "B",
      loser: "A",
    });
  });

  it("names neither side for a draw/tie/no_result outcome", () => {
    expect(bracketWinnerLoser({ kind: "draw" }, "A", "B")).toEqual({});
    expect(bracketWinnerLoser({ kind: "tie" }, "A", "B")).toEqual({});
    expect(bracketWinnerLoser({ kind: "no_result" }, "A", "B")).toEqual({});
  });
});

describe("parseStageKind", () => {
  it("passes through every valid StageKind value unchanged", () => {
    for (const kind of [
      "league",
      "group",
      "swiss",
      "knockout",
      "double_elim",
      "stepladder",
      "americano",
      "ladder",
      "page_playoff",
    ]) {
      expect(parseStageKind(kind, "stage-1")).toBe(kind);
    }
  });

  it("throws CONFIG_INVALID instead of silently casting an unknown kind", () => {
    expect(() => parseStageKind("bogus", "stage-1")).toThrow(EngineError);
    try {
      parseStageKind("bogus", "stage-1");
      expect.unreachable("parseStageKind should have thrown");
    } catch (err) {
      expect(EngineError.is(err, "CONFIG_INVALID")).toBe(true);
    }
  });
});
