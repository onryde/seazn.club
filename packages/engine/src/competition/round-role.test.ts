import { describe, expect, it } from "vitest";
import { isRoundRoleKey, parseRoundRoleKey, roundRole, roundRoleKey } from "./round-role.ts";

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

// --- #622: non-bracket kinds, and roles as a storage key --------------------

describe("roundRole on a non-bracket stage kind (#622)", () => {
  it("names a round-robin round by its ordinal, not by bracket distance", () => {
    // Before #622 `roundRole` was only ever called behind a BRACKET_STAGE_KINDS
    // guard, so a league fixture reaching it read its column defaults as
    // bracket facts: lane null + roundInLane === lastRoundInLane is
    // `fromEnd === 0`, i.e. round 1 of a one-round league came back "Final".
    for (const kind of ["league", "group", "swiss", "americano", "ladder"]) {
      expect(roundRole({ ...base, stageKind: kind, roundInLane: 0, lastRoundInLane: 0 })).toEqual({
        kind: "plain_round",
        n: 1,
      });
      expect(roundRole({ ...base, stageKind: kind, roundInLane: 2, lastRoundInLane: 4 })).toEqual({
        kind: "plain_round",
        n: 3,
      });
    }
  });

  it("ignores the bracket-only flags a non-bracket fixture cannot carry", () => {
    // `third_place` on a league row would be a data error, but it must not be
    // able to rename a league round: the ordinal answer is decided first.
    expect(
      roundRole({ ...base, stageKind: "league", thirdPlace: true, roundInLane: 1, lastRoundInLane: 3 }),
    ).toEqual({ kind: "plain_round", n: 2 });
  });

  it("leaves every bracket kind exactly as it was", () => {
    for (const kind of ["knockout", "double_elim", "page_playoff"]) {
      expect(roundRole({ ...base, stageKind: kind, roundInLane: 1, lastRoundInLane: 2 })).toEqual({
        kind: "semi_final",
      });
    }
    expect(roundRole({ ...base, stageKind: "stepladder", roundInLane: 0, lastRoundInLane: 2 })).toEqual({
      kind: "rung",
      n: 1,
    });
  });
});

describe("roundRoleKey / parseRoundRoleKey (#622)", () => {
  const roles = [
    { kind: "final" },
    { kind: "semi_final" },
    { kind: "quarter_final" },
    { kind: "winners_final" },
    { kind: "losers_final" },
    { kind: "grand_final" },
    { kind: "grand_final_reset" },
    { kind: "third_place" },
    { kind: "qualifier1" },
    { kind: "eliminator" },
    { kind: "qualifier2" },
    { kind: "round_of", entrants: 16 },
    { kind: "losers_round", n: 2 },
    { kind: "rung", n: 3 },
    { kind: "plain_round", n: 4 },
  ] as const;

  it("round-trips every role in the union", () => {
    // The key is a PRIMARY KEY column (stage_round_court_tags.round_role), so
    // a role that serialises to something the parser cannot read back is a
    // stored rule that silently matches nothing, forever.
    for (const role of roles) {
      expect(parseRoundRoleKey(roundRoleKey(role))).toEqual(role);
    }
  });

  it("gives every role a DISTINCT key", () => {
    const keys = roles.map(roundRoleKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keys the two lanes' finals apart", () => {
    // The failure raw round_no cannot express at all: WB, LB and GF share one
    // numbering space, so "the grand final" is not addressable by number.
    expect(roundRoleKey({ kind: "winners_final" })).not.toBe(roundRoleKey({ kind: "grand_final" }));
    expect(roundRoleKey({ kind: "losers_final" })).not.toBe(roundRoleKey({ kind: "final" }));
  });

  it("refuses a key that names no role", () => {
    for (const bad of ["", "Final", "final ", "round_of", "round_of_0", "round_of_-4", "plain_round_x", "made_up", "round_of_99999"]) {
      expect(parseRoundRoleKey(bad)).toBeNull();
      expect(isRoundRoleKey(bad)).toBe(false);
    }
  });
});
