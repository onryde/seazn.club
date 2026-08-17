import { describe, expect, it } from "vitest";
import { roundRole } from "./round-role.ts";

const base = {
  stageKind: "knockout",
  lane: null,
  roundInLane: 0,
  lastRoundInLane: 0,
  isFinal: false,
  thirdPlace: false,
  conditional: false,
  extKey: null,
};

describe("roundRole", () => {
  it("names single-elim rounds by distance from the final", () => {
    expect(roundRole({ ...base, roundInLane: 2, lastRoundInLane: 2 })).toEqual({ kind: "final" });
    expect(roundRole({ ...base, roundInLane: 1, lastRoundInLane: 2 })).toEqual({ kind: "semi_final" });
    expect(roundRole({ ...base, roundInLane: 0, lastRoundInLane: 2 })).toEqual({ kind: "quarter_final" });
    expect(roundRole({ ...base, roundInLane: 0, lastRoundInLane: 3 })).toEqual({
      kind: "round_of",
      entrants: 16,
    });
  });

  it("never calls a losers-bracket round a semi-final (the count-based bug)", () => {
    // A DE losers bracket has repeated 2-match and 1-match rounds, so naming
    // by size produced four "Final"s and three "Semi-finals" in one bracket.
    expect(roundRole({ ...base, lane: "LB", roundInLane: 0, lastRoundInLane: 3 })).toEqual({
      kind: "losers_round",
      n: 1,
    });
    expect(roundRole({ ...base, lane: "LB", roundInLane: 3, lastRoundInLane: 3 })).toEqual({
      kind: "losers_final",
    });
  });

  it("distinguishes the winners' final from the grand final", () => {
    expect(roundRole({ ...base, lane: "WB", roundInLane: 2, lastRoundInLane: 2 })).toEqual({
      kind: "winners_final",
    });
    expect(roundRole({ ...base, lane: "GF", roundInLane: 0, lastRoundInLane: 1, isFinal: true })).toEqual({
      kind: "grand_final",
    });
    expect(
      roundRole({ ...base, lane: "GF", roundInLane: 1, lastRoundInLane: 1, isFinal: true, conditional: true }),
    ).toEqual({ kind: "grand_final_reset" });
  });

  it("reads page-playoff roles from ext_key, never from round size", () => {
    const pp = { ...base, stageKind: "page_playoff" };
    expect(roundRole({ ...pp, extKey: "pp-q1" })).toEqual({ kind: "qualifier1" });
    expect(roundRole({ ...pp, extKey: "pp-elim" })).toEqual({ kind: "eliminator" });
    expect(roundRole({ ...pp, extKey: "pp-q2" })).toEqual({ kind: "qualifier2" });
    expect(roundRole({ ...pp, extKey: "pp-final" })).toEqual({ kind: "final" });
  });

  it("names the stepladder summit the final, rungs below it", () => {
    const sl = { ...base, stageKind: "stepladder", lastRoundInLane: 2 };
    expect(roundRole({ ...sl, roundInLane: 0 })).toEqual({ kind: "rung", n: 1 });
    expect(roundRole({ ...sl, roundInLane: 2 })).toEqual({ kind: "final" });
  });

  it("names a third-place playoff regardless of where it sits", () => {
    expect(roundRole({ ...base, roundInLane: 2, lastRoundInLane: 2, thirdPlace: true })).toEqual({
      kind: "third_place",
    });
  });
});
