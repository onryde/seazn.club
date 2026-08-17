import { describe, expect, it } from "vitest";
import { laneRoundRank, roundRoleFor, roundRoleLabel } from "../round-role-label.ts";

const msg = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key) as never;

describe("roundRoleLabel", () => {
  it("maps every role kind to a dictionary key", () => {
    expect(roundRoleLabel(msg, { kind: "final" })).toBe("bracket.round.final");
    expect(roundRoleLabel(msg, { kind: "quarter_final" })).toBe("bracket.round.quarter");
    expect(roundRoleLabel(msg, { kind: "semi_final" })).toBe("bracket.round.semi");
    expect(roundRoleLabel(msg, { kind: "winners_final" })).toBe("bracket.round.winnersFinal");
    expect(roundRoleLabel(msg, { kind: "losers_final" })).toBe("bracket.round.losersFinal");
    expect(roundRoleLabel(msg, { kind: "grand_final" })).toBe("bracket.round.grandFinal");
    expect(roundRoleLabel(msg, { kind: "grand_final_reset" })).toBe("bracket.round.grandFinalReset");
    expect(roundRoleLabel(msg, { kind: "qualifier1" })).toBe("bracket.round.qualifier1");
    expect(roundRoleLabel(msg, { kind: "eliminator" })).toBe("bracket.round.eliminator");
    expect(roundRoleLabel(msg, { kind: "qualifier2" })).toBe("bracket.round.qualifier2");
    expect(roundRoleLabel(msg, { kind: "third_place" })).toBe("bracket.round.thirdPlace");
    expect(roundRoleLabel(msg, { kind: "losers_round", n: 2 })).toBe('bracket.round.losersRound:{"n":2}');
    expect(roundRoleLabel(msg, { kind: "round_of", entrants: 16 })).toBe('bracket.round.roundOf:{"n":16}');
    expect(roundRoleLabel(msg, { kind: "rung", n: 3 })).toBe('bracket.round.rung:{"n":3}');
    expect(roundRoleLabel(msg, { kind: "plain_round", n: 4 })).toBe('bracket.round.plain:{"n":4}');
  });
});

describe("laneRoundRank", () => {
  // The exact shape this whole session exists to kill: a DE's losers bracket
  // has MORE rounds than its winners bracket, so ranking round_no across the
  // whole stage instead of per lane misnames every WB round past round 1.
  const fixtures = [
    { round_no: 1, lane: "WB" as const },
    { round_no: 2, lane: "WB" as const },
    { round_no: 3, lane: "WB" as const },
    { round_no: 7, lane: "LB" as const },
    { round_no: 8, lane: "LB" as const },
    { round_no: 9, lane: "LB" as const },
    { round_no: 10, lane: "LB" as const },
    { round_no: 14, lane: "GF" as const },
  ];

  it("ranks a round within its own lane, ignoring other lanes' round_no values", () => {
    expect(laneRoundRank(fixtures, "WB", 3)).toEqual({ roundInLane: 2, lastRoundInLane: 2 });
    expect(laneRoundRank(fixtures, "LB", 10)).toEqual({ roundInLane: 3, lastRoundInLane: 3 });
    expect(laneRoundRank(fixtures, "LB", 7)).toEqual({ roundInLane: 0, lastRoundInLane: 3 });
    expect(laneRoundRank(fixtures, "GF", 14)).toEqual({ roundInLane: 0, lastRoundInLane: 0 });
  });

  it("scopes strictly to null when a stage has no lane (single-elim/stepladder)", () => {
    const single = [
      { round_no: 1, lane: null },
      { round_no: 2, lane: null },
    ];
    expect(laneRoundRank(single, null, 2)).toEqual({ roundInLane: 1, lastRoundInLane: 1 });
  });
});

describe("roundRoleFor", () => {
  const fixtures = [
    { round_no: 1, lane: "WB" as const },
    { round_no: 2, lane: "WB" as const },
    { round_no: 3, lane: "WB" as const },
    { round_no: 7, lane: "LB" as const },
    { round_no: 8, lane: "LB" as const },
    { round_no: 9, lane: "LB" as const },
    { round_no: 10, lane: "LB" as const },
    { round_no: 14, lane: "GF" as const },
  ];

  it("names the WB semi-final and final correctly off a lane rank, not the stage-wide round_no", () => {
    const semi = roundRoleFor(
      fixtures,
      { round_no: 2, lane: "WB", is_final: false, third_place: false, conditional: false },
      "double_elim",
    );
    expect(semi).toEqual({ kind: "semi_final" });
    const final = roundRoleFor(
      fixtures,
      { round_no: 3, lane: "WB", is_final: false, third_place: false, conditional: false },
      "double_elim",
    );
    expect(final).toEqual({ kind: "winners_final" });
  });

  it("names the LB final and the grand final off the same lane-scoped rank", () => {
    const lbFinal = roundRoleFor(
      fixtures,
      { round_no: 10, lane: "LB", is_final: false, third_place: false, conditional: false },
      "double_elim",
    );
    expect(lbFinal).toEqual({ kind: "losers_final" });
    const gf = roundRoleFor(
      fixtures,
      { round_no: 14, lane: "GF", is_final: true, third_place: false, conditional: false },
      "double_elim",
    );
    expect(gf).toEqual({ kind: "grand_final" });
  });

  it("a thirdPlace fixture wins regardless of its position", () => {
    const tp = roundRoleFor(
      fixtures,
      { round_no: 3, lane: null, is_final: false, third_place: true, conditional: false },
      "knockout",
    );
    expect(tp).toEqual({ kind: "third_place" });
  });
});
