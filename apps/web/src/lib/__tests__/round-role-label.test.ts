import { describe, expect, it } from "vitest";
import type { RoundRole } from "@seazn/engine/competition";
import { laneRoundRank, roundRoleBoardLabel, roundRoleFor, roundRoleLabel, roundRoleShort } from "../round-role-label.ts";
import { msgFor } from "@/lib/messages-i18n";
import { LOCALES } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";

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

// Schedule-board knockout round codes (2026-09-23, owner-approved design): the
// board's card chip used to read `R{round_no}` for every stage, so a
// quarter-final and a semi-final were indistinguishable on the board.
describe("roundRoleShort", () => {
  const en = (key: MessageKey, vars?: Record<string, string | number>) => msgFor("en", key, vars);

  /** One role per kind. `satisfies` over the whole union means a new RoundRole
   *  kind fails TYPECHECK here as well as in the switch — this table is the
   *  enumeration the locale sweep below walks, so it cannot silently skip one. */
  const ONE_OF_EACH = {
    round_of: { kind: "round_of", entrants: 16 },
    quarter_final: { kind: "quarter_final" },
    semi_final: { kind: "semi_final" },
    final: { kind: "final" },
    winners_final: { kind: "winners_final" },
    losers_round: { kind: "losers_round", n: 2 },
    losers_final: { kind: "losers_final" },
    grand_final: { kind: "grand_final" },
    grand_final_reset: { kind: "grand_final_reset" },
    third_place: { kind: "third_place" },
    qualifier1: { kind: "qualifier1" },
    eliminator: { kind: "eliminator" },
    qualifier2: { kind: "qualifier2" },
    rung: { kind: "rung", n: 1 },
    plain_round: { kind: "plain_round", n: 2 },
  } satisfies { [K in RoundRole["kind"]]: Extract<RoundRole, { kind: K }> };

  /** The code for fixture `round_no` of a bracket, via the REAL position
   *  pipeline (laneRoundRank -> roundRole) rather than a role typed in here. */
  const codeAt = (
    rows: readonly { round_no: number; lane: "WB" | "LB" | "GF" | null }[],
    round_no: number,
    lane: "WB" | "LB" | "GF" | null,
    kind: string,
    flags: { third_place?: boolean; conditional?: boolean } = {},
  ) => {
    const role = roundRoleFor(
      rows,
      { round_no, lane, is_final: false, third_place: flags.third_place ?? false, conditional: flags.conditional ?? false },
      kind,
    );
    return roundRoleShort(en, role, { lane, roundInLane: laneRoundRank(rows, lane, round_no).roundInLane });
  };

  it("single elimination, 16 entrants: R16, QF, SF, F — the round of N carries N, not the round number", () => {
    const ko16 = [1, 2, 3, 4].map((round_no) => ({ round_no, lane: null }));
    expect([1, 2, 3, 4].map((r) => codeAt(ko16, r, null, "knockout"))).toEqual(["R16", "QF", "SF", "F"]);
  });

  it("single elimination, 8 entrants: QF, SF, F — the SAME round_no 1 reads QF here and R16 above", () => {
    // Ordering differential: a namer keyed on round_no instead of distance from
    // the final would give round 1 the same code in both brackets.
    const ko8 = [1, 2, 3].map((round_no) => ({ round_no, lane: null }));
    expect([1, 2, 3].map((r) => codeAt(ko8, r, null, "knockout"))).toEqual(["QF", "SF", "F"]);
  });

  it("a third-place match reads 3rd, not F — it shares the final's round, so only the flag tells them apart", () => {
    const ko8 = [1, 2, 3].map((round_no) => ({ round_no, lane: null }));
    expect(codeAt(ko8, 3, null, "knockout", { third_place: true })).toBe("3rd");
    // Its positive pair: the same position WITHOUT the flag is the final.
    expect(codeAt(ko8, 3, null, "knockout")).toBe("F");
  });

  it("double elimination numbers each lane: WB1..WB3, LB1..LB4, GF, and GF2 for the bracket reset", () => {
    const de = [
      ...[1, 2, 3].map((round_no) => ({ round_no, lane: "WB" as const })),
      ...[7, 8, 9, 10].map((round_no) => ({ round_no, lane: "LB" as const })),
      { round_no: 14, lane: "GF" as const },
      { round_no: 15, lane: "GF" as const },
    ];
    // WB3 is the engine's `winners_final` and WB2 its `semi_final` — the
    // winners' semi is not the tournament's semi, so the lane number is used.
    expect([1, 2, 3].map((r) => codeAt(de, r, "WB", "double_elim"))).toEqual(["WB1", "WB2", "WB3"]);
    // LB4 is the engine's `losers_final`: numbered in the same sequence, not "LF".
    expect([7, 8, 9, 10].map((r) => codeAt(de, r, "LB", "double_elim"))).toEqual(["LB1", "LB2", "LB3", "LB4"]);
    expect(codeAt(de, 14, "GF", "double_elim")).toBe("GF");
    expect(codeAt(de, 15, "GF", "double_elim", { conditional: true })).toBe("GF2");
  });

  it("a round-robin round stays uncoded (null) so the board keeps its plain R{n}", () => {
    const league = [1, 2, 3].map((round_no) => ({ round_no, lane: null }));
    expect(codeAt(league, 2, null, "league")).toBeNull();
    expect(codeAt(league, 3, null, "league")).toBeNull(); // NOT "F" — a league's last round is no final
  });

  // Board playoff codes (2026-09-23, owner-approved): the page playoff reads
  // Q1 / E / Q2 (its final is the shared F), a stepladder's rung n reads E{n}.
  it("page-playoff roles read Q1, E, Q2 — each from its own dictionary key", () => {
    expect(roundRoleShort(en, ONE_OF_EACH.qualifier1, { lane: null, roundInLane: 0 })).toBe(
      en("bracket.roundShort.qualifier1"),
    );
    expect(roundRoleShort(en, ONE_OF_EACH.eliminator, { lane: null, roundInLane: 0 })).toBe(
      en("bracket.roundShort.eliminator"),
    );
    expect(roundRoleShort(en, ONE_OF_EACH.qualifier2, { lane: null, roundInLane: 1 })).toBe(
      en("bracket.roundShort.qualifier2"),
    );
    expect(["Q1", "E", "Q2"]).toEqual([
      en("bracket.roundShort.qualifier1"),
      en("bracket.roundShort.eliminator"),
      en("bracket.roundShort.qualifier2"),
    ]);
  });

  it("a stepladder rung reads E{n} off the ROLE's own n — never its roundInLane", () => {
    // The placement's roundInLane is deliberately a different number: the code
    // must carry the rung the engine named, not a rank the caller passed.
    expect(roundRoleShort(en, { kind: "rung", n: 3 }, { lane: null, roundInLane: 7 })).toBe("E3");
    expect(roundRoleShort(en, { kind: "rung", n: 1 }, { lane: null, roundInLane: 0 })).toBe("E1");
  });

  it("a round-robin ordinal stays uncoded: null", () => {
    expect(roundRoleShort(en, ONE_OF_EACH.plain_round, { lane: null, roundInLane: 0 })).toBeNull();
  });

  for (const locale of LOCALES) {
    it(`${locale}: every coded role resolves to a real dictionary string, placeholders filled`, () => {
      const lookup = (key: MessageKey, vars?: Record<string, string | number>) => msgFor(locale, key, vars);
      for (const role of Object.values(ONE_OF_EACH) as RoundRole[]) {
        for (const lane of [null, "WB", "LB", "GF"] as const) {
          const code = roundRoleShort(lookup, role, { lane, roundInLane: 1 });
          if (code === null) continue;
          expect(code, `${role.kind}/${lane}`).not.toMatch(/\{[a-zA-Z]+\}/);
          expect(code, `${role.kind}/${lane}`).not.toMatch(/^bracket\./);
          expect(code.length, `${role.kind}/${lane}`).toBeGreaterThan(0);
        }
      }
    });
  }
});

// Review M1 (2026-09-23): the board's LONG name must be lane-aware exactly where
// its short code is. `roundRole()` hands a winners'-bracket round the
// single-elimination names — an 8-entrant double elimination's WB1/WB2 come back
// as `quarter_final`/`semi_final` — so `roundRoleLabel` alone put "Semi-finals"
// beside a "WB2" chip, and a screen reader announced a winners' round as THE
// semi-final.
describe("roundRoleBoardLabel", () => {
  const en = (key: MessageKey, vars?: Record<string, string | number>) => msgFor("en", key, vars);
  type Lane = "WB" | "LB" | "GF" | null;
  const labelAt = (
    rows: readonly { round_no: number; lane: Lane }[],
    round_no: number,
    lane: Lane,
    kind: string,
    flags: { third_place?: boolean; conditional?: boolean } = {},
  ) => {
    const role = roundRoleFor(
      rows,
      { round_no, lane, is_final: false, third_place: flags.third_place ?? false, conditional: flags.conditional ?? false },
      kind,
    );
    return {
      role,
      label: roundRoleBoardLabel(en, role, { lane, roundInLane: laneRoundRank(rows, lane, round_no).roundInLane }),
    };
  };
  const de = (wbRounds: number, lbRounds: number) => [
    ...Array.from({ length: wbRounds }, (_, i) => ({ round_no: i + 1, lane: "WB" as const })),
    ...Array.from({ length: lbRounds }, (_, i) => ({ round_no: 20 + i, lane: "LB" as const })),
    { round_no: 40, lane: "GF" as const },
    { round_no: 41, lane: "GF" as const },
  ];

  it("8-entrant double elimination: WB rounds are the WINNERS' rounds, never the tournament's quarter/semi", () => {
    const rows = de(3, 4);
    const wb = [1, 2, 3].map((r) => labelAt(rows, r, "WB", "double_elim"));
    expect(wb.map((x) => x.label)).toEqual([
      en("bracket.round.winnersRound", { n: 1 }),
      en("bracket.round.winnersRound", { n: 2 }),
      en("bracket.round.winnersFinal"),
    ]);
    // The wrong answer this replaces: what the lane-blind name says for WB1/WB2.
    expect(wb.map((x) => roundRoleLabel(en, x.role)).slice(0, 2)).toEqual([
      en("bracket.round.quarter"),
      en("bracket.round.semi"),
    ]);
  });

  it("16-entrant double elimination: WB2 carries the SAME name as in an 8-entrant one (it is round 2 of the lane in both)", () => {
    const rows = de(4, 6);
    expect([1, 2, 3, 4].map((r) => labelAt(rows, r, "WB", "double_elim").label)).toEqual([
      en("bracket.round.winnersRound", { n: 1 }),
      en("bracket.round.winnersRound", { n: 2 }),
      en("bracket.round.winnersRound", { n: 3 }),
      en("bracket.round.winnersFinal"),
    ]);
  });

  it("losers' lane and grand final keep the double-elim names the engine already gives them", () => {
    const rows = de(3, 4);
    for (const [r, lane, flags] of [
      [20, "LB", {}],
      [23, "LB", {}],
      [40, "GF", {}],
      [41, "GF", { conditional: true }],
    ] as const) {
      const { role, label } = labelAt(rows, r, lane, "double_elim", flags);
      expect(label, `${lane}${r}`).toBe(roundRoleLabel(en, role));
    }
    expect(labelAt(rows, 23, "LB", "double_elim").label).toBe(en("bracket.round.losersFinal"));
    expect(labelAt(rows, 41, "GF", "double_elim", { conditional: true }).label).toBe(
      en("bracket.round.grandFinalReset"),
    );
  });

  it("single elimination is unchanged: QF/SF/F/3rd read exactly roundRoleLabel's names", () => {
    const ko8 = [1, 2, 3].map((round_no) => ({ round_no, lane: null }));
    expect([1, 2, 3].map((r) => labelAt(ko8, r, null, "knockout").label)).toEqual([
      en("bracket.round.quarter"),
      en("bracket.round.semi"),
      en("bracket.round.final"),
    ]);
    expect(labelAt(ko8, 3, null, "knockout", { third_place: true }).label).toBe(en("bracket.round.thirdPlace"));
  });

  // Board playoff codes (2026-09-23): a stepladder rung's chip reads E{n}, so the
  // name beside it on the BOARD is "Eliminator {n}" — while every other bracket
  // surface keeps roundRoleLabel's "Rung {n}" (bracket.round.rung is untouched).
  it("stepladder: a rung is 'Eliminator {n}' on the board, and still 'Rung {n}' everywhere else", () => {
    const ladder = [1, 2, 3].map((round_no) => ({ round_no, lane: null }));
    const rung2 = labelAt(ladder, 2, null, "stepladder");
    expect(rung2.role).toEqual({ kind: "rung", n: 2 });
    expect(rung2.label).toBe(en("bracket.round.eliminatorN", { n: 2 }));
    expect(rung2.label).toBe("Eliminator 2");
    // The wrong answer this replaces, and the other surfaces' unchanged name.
    expect(roundRoleLabel(en, rung2.role)).toBe("Rung 2");
    expect(labelAt(ladder, 3, null, "stepladder").label).toBe(en("bracket.round.final"));
  });

  it("page playoff: the long names are roundRoleLabel's — Qualifier 1, Eliminator, Qualifier 2", () => {
    for (const kind of ["qualifier1", "eliminator", "qualifier2"] as const) {
      expect(roundRoleBoardLabel(en, { kind }, { lane: null, roundInLane: 0 })).toBe(roundRoleLabel(en, { kind }));
    }
  });

  for (const locale of LOCALES) {
    it(`${locale}: every role in every lane resolves to a real dictionary string`, () => {
      const lookup = (key: MessageKey, vars?: Record<string, string | number>) => msgFor(locale, key, vars);
      const roles: RoundRole[] = [
        { kind: "round_of", entrants: 16 },
        { kind: "quarter_final" },
        { kind: "semi_final" },
        { kind: "final" },
        { kind: "winners_final" },
        { kind: "losers_round", n: 2 },
        { kind: "losers_final" },
        { kind: "grand_final" },
        { kind: "grand_final_reset" },
        { kind: "third_place" },
        { kind: "qualifier1" },
        { kind: "eliminator" },
        { kind: "qualifier2" },
        { kind: "rung", n: 2 },
      ];
      for (const role of roles) {
        for (const lane of [null, "WB", "LB", "GF"] as const) {
          const label = roundRoleBoardLabel(lookup, role, { lane, roundInLane: 1 });
          expect(label, `${role.kind}/${lane}`).not.toMatch(/\{[a-zA-Z]+\}/);
          expect(label, `${role.kind}/${lane}`).not.toMatch(/^bracket\./);
          expect(label.length, `${role.kind}/${lane}`).toBeGreaterThan(0);
        }
      }
    });
  }
});
